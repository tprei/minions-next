import { generateKeyPairSync } from "node:crypto";

import {
  createGitHubAppAuth,
  createLandingCoordinator,
  createPullRequestManager,
  createRemoteCiManager,
  createStackParentageManager,
  type CredentialVault,
  type CredentialVaultProbeResult,
  type GitHubClient,
  type GitHubFetch,
  type LandingCoordinator,
  type LandingReceiptStore,
} from "@minions/adapters";
import {
  actorSessionId,
  contentHash,
  determineBranchName,
  gitSha,
  humanApproval,
  STACK_TRUNK_BRANCH,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  validateVcsChangeBinding,
  type ContentHash,
  type GateReceipt,
  type GateReceiptExpectation,
  type GateReceiptRecord,
  type GateReceiptStore,
  type GitSha,
  type HumanApproval,
  type LandingIntent,
  type LandingReceipt,
  type RequiredCheckSet,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";
import { describe, expect, it } from "vitest";

/**
 * Integration test for PR 36: explicit landing reconciliation. Every scenario
 * drives the real {@link createLandingCoordinator} (composing the real
 * pull-request, remote-CI, and stack-parentage managers) against a MOCK GitHub
 * REST API (no real network): a stateful in-memory GitHub whose `fetch` the test
 * configures per suite. The binding / gate-receipt / landing-receipt stores are
 * in-memory seams; the ruleset gate is a stub (its real enforcement is covered
 * by github-ruleset.test.ts).
 *
 * Coverage (from the brief):
 * - Happy path: all preflight pass → squash merge → receipt → children retargeted.
 * - Bot review → rejected (not eligible).
 * - Stale review → rejected (before latest push).
 * - Stale head → rejected (ambiguous_remote).
 * - Missing check → rejected.
 * - Unlanded parent → rejected (parent_not_landed).
 * - Already landed → idempotent (already_landed).
 * - Crash recovery → restart reconstructs the receipt from GitHub state.
 * - Duplicate command → second call idempotent (duplicate_command).
 *
 * Acceptance (GIT-03/04/08/12): only a human initiates; no auto-merge; one
 * command lands one PR; crash reconciles.
 */

const APP_ID = 123456;
const APP_SLUG = "minions-engine";
const BOT_LOGIN = "minions-engine[bot]";
const BOT_USER_ID = 9876543;
const BOT_IDENTITY = Object.freeze({
  appId: APP_ID,
  appSlug: APP_SLUG,
  name: "Minions Engine",
  botLogin: BOT_LOGIN,
  botUserId: BOT_USER_ID,
});
const INSTALLATION_ID = 555;
const REPO = "acme/landing-app";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const HEAD_SHA: GitSha = gitSha("a".repeat(40));
const DRIFTED_SHA: GitSha = gitSha("b".repeat(40));
const STALE_REVIEW_SHA: GitSha = gitSha("9".repeat(40));
const BASE_SHA: GitSha = gitSha("0".repeat(40));
const MERGED_SHA = "m".repeat(40);
const PARENT_CHANGE: ContentHash = contentHash("1".repeat(64));
const CHILD_CHANGE: ContentHash = contentHash("2".repeat(64));
const CHILD_HEAD_SHA: GitSha = gitSha("c".repeat(40));

const TREE_ID: TaskTreeId = taskTreeId("01900000-0000-7000-8000-000000000002");
const PARENT_NODE_ID: TaskNodeId = taskNodeId("01900000-0000-7000-8000-000000000001");
const CHILD_NODE_ID: TaskNodeId = taskNodeId("01900000-0000-7000-8000-000000000003");

const PARENT_BRANCH = determineBranchName(TREE_ID, PARENT_NODE_ID);
const CHILD_BRANCH = determineBranchName(TREE_ID, CHILD_NODE_ID);

const PARENT_PR = 10;
const CHILD_PR = 11;
// A transport-derived authenticated human principal — what the daemon would
// establish at the request boundary and wrap via humanApproval() before handing
// the intent to the coordinator. An automated caller cannot mint one.
const AUTHENTICATED_ACTOR = actorSessionId("01900000-0000-7000-8000-000000000010");

const REQUIRED: RequiredCheckSet = Object.freeze({ requiredChecks: Object.freeze(["ci", "lint"]) });
const NO_GATES: GateReceiptExpectation = Object.freeze({
  bindings: Object.freeze({
    headCommit: HEAD_SHA,
    profileHash: contentHash("f".repeat(64)),
    environmentDigest: contentHash("e".repeat(64)),
  }),
  requiredCategories: Object.freeze([]),
});

// -------------------------------------------------------------------------------------------------
// In-memory vault (so createGitHubAppAuth works against the mock).
// -------------------------------------------------------------------------------------------------

class MemoryVault implements CredentialVault {
  readonly backend = "systemd-creds" as const;
  private readonly store = new Map<string, Uint8Array>();

  probe(): CredentialVaultProbeResult {
    return { available: true, backend: this.backend, detail: "memory" };
  }
  put(name: string, secret: Uint8Array): Promise<void> {
    this.store.set(name, new Uint8Array(secret));
    return Promise.resolve();
  }
  get(name: string): Promise<Uint8Array> {
    const value = this.store.get(name);
    if (value === undefined) {
      throw new Error(`credential not found: ${name}`);
    }
    return Promise.resolve(new Uint8Array(value));
  }
  delete(name: string): Promise<void> {
    this.store.delete(name);
    return Promise.resolve();
  }
}

// -------------------------------------------------------------------------------------------------
// In-memory stores (test seams for the durable ports).
// -------------------------------------------------------------------------------------------------

class MemoryBindingStore implements VcsChangeBindingStore {
  private readonly bindings = new Map<string, VcsChangeBinding>();

  private key(treeId: TaskTreeId, nodeId: TaskNodeId): string {
    return `${treeId}\u0000${nodeId}`;
  }

  upsertBinding(binding: VcsChangeBinding): Promise<void> {
    validateVcsChangeBinding(binding);
    this.bindings.set(this.key(binding.treeId, binding.nodeId), binding);
    return Promise.resolve();
  }

  getBinding(treeId: TaskTreeId, nodeId: TaskNodeId): Promise<VcsChangeBinding | undefined> {
    return Promise.resolve(this.bindings.get(this.key(treeId, nodeId)));
  }

  getByChangeId(
    treeId: TaskTreeId,
    jjChangeId: ContentHash,
  ): Promise<VcsChangeBinding | undefined> {
    return Promise.resolve(
      [...this.bindings.values()].find(
        (binding) => binding.treeId === treeId && binding.jjChangeId === jjChangeId,
      ),
    );
  }

  listForTree(treeId: TaskTreeId): Promise<readonly VcsChangeBinding[]> {
    return Promise.resolve(
      [...this.bindings.values()].filter((binding) => binding.treeId === treeId),
    );
  }

  assertNoOrphans(treeId: TaskTreeId, knownNodeIds: readonly TaskNodeId[]): Promise<void> {
    const known = new Set(knownNodeIds);
    for (const binding of this.bindings.values()) {
      if (binding.treeId === treeId && !known.has(binding.nodeId)) {
        return Promise.reject(new Error(`orphan binding for node '${binding.nodeId}'`));
      }
    }
    return Promise.resolve();
  }

  assertNoDuplicates(treeId: TaskTreeId): Promise<void> {
    const seen = new Set<string>();
    for (const binding of this.bindings.values()) {
      if (binding.treeId === treeId) {
        const k = this.key(binding.treeId, binding.nodeId);
        if (seen.has(k)) {
          return Promise.reject(new Error(`duplicate binding for node '${binding.nodeId}'`));
        }
        seen.add(k);
      }
    }
    return Promise.resolve();
  }
}

class MemoryGateReceiptStore implements GateReceiptStore {
  private readonly byNode = new Map<TaskNodeId, GateReceipt[]>();

  record(record: GateReceiptRecord): Promise<void> {
    const list = this.byNode.get(record.nodeId) ?? [];
    list.push(record.receipt);
    this.byNode.set(record.nodeId, list);
    return Promise.resolve();
  }

  listForNode(nodeId: TaskNodeId): Promise<readonly GateReceipt[]> {
    return Promise.resolve([...(this.byNode.get(nodeId) ?? [])]);
  }

  listForGate(nodeId: TaskNodeId, gateName: string): Promise<readonly GateReceipt[]> {
    return Promise.resolve(
      (this.byNode.get(nodeId) ?? []).filter((receipt) => receipt.gateName === gateName),
    );
  }
}

class MemoryReceiptStore implements LandingReceiptStore {
  private readonly receipts = new Map<string, LandingReceipt>();
  records = 0;

  private key(repo: string, prNumber: number): string {
    return `${repo}\u0000${String(prNumber)}`;
  }

  recordReceipt(receipt: LandingReceipt): Promise<void> {
    this.records += 1;
    this.receipts.set(this.key(receipt.repositoryFullName, receipt.prNumber), receipt);
    return Promise.resolve();
  }

  getReceipt(repo: string, prNumber: number): Promise<LandingReceipt | undefined> {
    return Promise.resolve(this.receipts.get(this.key(repo, prNumber)));
  }
}

// -------------------------------------------------------------------------------------------------
// Mock GitHub — stateful, routes the subset of the REST API landing exercises.
// -------------------------------------------------------------------------------------------------

interface PrWire {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merge_commit_sha: string | null;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface ReviewWire {
  id: number;
  user: { id: number; login: string; type: "Bot" | "User" };
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submitted_at: string;
  commit_id: string;
  author_association: string;
}

interface CheckRunWire {
  id: number;
  name: string;
  head_sha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
}

class MockGitHub {
  readonly refs = new Map<string, string>();
  readonly pulls: PrWire[] = [];
  readonly reviewsByPr = new Map<number, ReviewWire[]>();
  readonly checkRunsByRef = new Map<string, CheckRunWire[]>();
  readonly combinedStatusByRef = new Map<string, { state: string; total_count: number }>();
  /** When set, the next merge returns this status instead of 200 (crash hook). */
  mergeStatus = 200;
  /** Recorded merge requests (title/method/sha). */
  readonly merges: { prNumber: number; method: string; sha: string | undefined }[] = [];
  /** Recorded PR base updates (retarget). */
  readonly baseUpdates: { prNumber: number; base: string }[] = [];
  private tokenCounter = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  seedPull(pr: PrWire): void {
    this.pulls.push(pr);
  }

  readonly fetch: GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(this.route(method, url, body));
  };

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private route(method: string, url: string, body: string): Response {
    // --- App / auth scaffolding (so auth.clientFor works against the mock). ---
    if (method === "GET" && url.endsWith("/app")) {
      return this.json({ id: APP_ID, slug: APP_SLUG, name: "Minions Engine" });
    }
    if (method === "GET" && url.includes(`/users/${encodeURIComponent(BOT_LOGIN)}`)) {
      return this.json({ id: BOT_USER_ID, login: BOT_LOGIN, type: "Bot" });
    }
    if (method === "GET" && url.includes(`/repos/${REPO}/installation`)) {
      return this.json({ id: INSTALLATION_ID, app_id: APP_ID, app_slug: APP_SLUG });
    }
    if (
      method === "POST" &&
      url.includes(`/app/installations/${String(INSTALLATION_ID)}/access_tokens`)
    ) {
      this.tokenCounter += 1;
      return this.json({
        token: `ghs_token_${String(this.tokenCounter)}`,
        expires_at: new Date(this.now() + 60 * 60 * 1000).toISOString(),
        permissions: { pull_requests: "write", contents: "write" },
        repositories: [{ id: 4242, full_name: REPO }],
      });
    }

    // --- Pull requests: list (with head + state filter). ---
    if (method === "GET" && /\/repos\/[^/]+\/[^/]+\/pulls(\?.*)?$/u.test(url)) {
      const query = new URL(url, "https://api.github.com").searchParams;
      const state = query.get("state") ?? "open";
      const head = query.get("head");
      const branch = head === null ? undefined : head.split(":")[1];
      const filtered = this.pulls.filter(
        (pr) =>
          (state === "all" || pr.state === state) &&
          (branch === undefined || pr.head.ref === branch),
      );
      return this.json(filtered.map((pr) => this.prWireOut(pr)));
    }

    // --- Pull requests: single. ---
    const singlePrMatch = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/u.exec(url);
    if (singlePrMatch !== null) {
      const number = Number.parseInt(singlePrMatch[1] ?? "", 10);
      const pr = this.pulls.find((candidate) => candidate.number === number);
      if (pr === undefined) {
        return new Response("not found", { status: 404 });
      }
      if (method === "GET") {
        return this.json(this.prWireOut(pr));
      }
      if (method === "PATCH") {
        const parsed = JSON.parse(body) as { base?: string; title?: string; state?: string };
        if (parsed.base !== undefined && parsed.base !== pr.base.ref) {
          pr.base = { ...pr.base, ref: parsed.base };
          this.baseUpdates.push({ prNumber: number, base: parsed.base });
        }
        return this.json(this.prWireOut(pr));
      }
    }

    // --- Pull request merge: PUT /pulls/{n}/merge. ---
    const mergeMatch = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/u.exec(url);
    if (method === "PUT" && mergeMatch !== null) {
      const number = Number.parseInt(mergeMatch[1] ?? "", 10);
      const pr = this.pulls.find((candidate) => candidate.number === number);
      if (pr === undefined) {
        return new Response("not found", { status: 404 });
      }
      const parsed = JSON.parse(body) as {
        merge_method?: string;
        sha?: string;
        commit_title?: string;
      };
      this.merges.push({
        prNumber: number,
        method: parsed.merge_method ?? "merge",
        sha: parsed.sha,
      });
      // Pin the expected head: reject if it moved (409).
      if (parsed.sha !== undefined && parsed.sha !== pr.head.sha) {
        return new Response(JSON.stringify({ message: "Head branch was modified" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      if (this.mergeStatus !== 200) {
        return new Response(JSON.stringify({ message: "merge unavailable" }), {
          status: this.mergeStatus,
          headers: { "content-type": "application/json" },
        });
      }
      if (pr.merged) {
        return this.json({ sha: pr.merge_commit_sha, merged: false, message: "already merged" });
      }
      pr.merged = true;
      pr.state = "closed";
      pr.merge_commit_sha = MERGED_SHA;
      pr.merged_at = new Date(this.now()).toISOString();
      return this.json({
        sha: MERGED_SHA,
        merged: true,
        message: "Pull Request successfully merged",
      });
    }

    // --- Reviews. ---
    const reviewsMatch = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/u.exec(url);
    if (method === "GET" && reviewsMatch !== null) {
      const number = Number.parseInt(reviewsMatch[1] ?? "", 10);
      return this.json(this.reviewsByPr.get(number) ?? []);
    }

    // --- Checks + combined status. ---
    const checkRunsMatch = /\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/u.exec(url);
    if (method === "GET" && checkRunsMatch !== null) {
      const ref = decodeURIComponent(checkRunsMatch[1] ?? "");
      return this.json({ check_runs: this.checkRunsByRef.get(ref) ?? [] });
    }
    const statusMatch = /\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/status$/u.exec(url);
    if (method === "GET" && statusMatch !== null) {
      const ref = decodeURIComponent(statusMatch[1] ?? "");
      return this.json(this.combinedStatusByRef.get(ref) ?? { state: "pending", total_count: 0 });
    }

    // --- Git refs. ---
    const refMatch = /\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/([^?]+)$/u.exec(url);
    if (refMatch !== null) {
      const branch = decodeURIComponent(refMatch[1] ?? "");
      if (method === "GET") {
        const sha = this.refs.get(branch);
        return sha === undefined
          ? new Response("not found", { status: 404 })
          : this.json({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
      }
      if (method === "PATCH") {
        const parsed = JSON.parse(body) as { sha: string };
        this.refs.set(branch, parsed.sha);
        return this.json({
          ref: `refs/heads/${branch}`,
          object: { sha: parsed.sha, type: "commit" },
        });
      }
    }

    return new Response(`mock: unhandled ${method} ${url}`, { status: 500 });
  }

  private prWireOut(pr: PrWire): Readonly<Record<string, unknown>> {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      draft: pr.draft,
      head: { ref: pr.head.ref, sha: pr.head.sha },
      base: { ref: pr.base.ref, sha: pr.base.sha },
      merge_commit_sha: pr.merge_commit_sha,
      merged_at: pr.merged_at,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      html_url: pr.html_url,
    };
  }
}

// -------------------------------------------------------------------------------------------------
// Harness builders.
// -------------------------------------------------------------------------------------------------

function fixedClock(): { now: () => number; advance(ms: number): void } {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function buildAuth(now: () => number, mock: MockGitHub) {
  const vault = new MemoryVault();
  void vault.put("github-app.private-key", new TextEncoder().encode(privateKeyPem));
  return createGitHubAppAuth({
    vault,
    privateKeyCredentialName: "github-app.private-key",
    appId: APP_ID,
    fetch: mock.fetch,
    now,
    refreshSkewMs: 5 * 60 * 1000,
  });
}

interface Harness {
  readonly mock: MockGitHub;
  readonly clock: { now: () => number; advance(ms: number): void };
  readonly bindingStore: MemoryBindingStore;
  readonly gateReceipts: MemoryGateReceiptStore;
  readonly receiptStore: MemoryReceiptStore;
  readonly coordinator: LandingCoordinator;
}

/**
 * Build a coordinator wired to a fresh mock + in-memory stores, seeded with a
 * default landing-enabled parent PR (#10) and a stacked child (#11). The
 * `overrides` callback mutates the mock/seed before the coordinator is built.
 */
async function harness(
  overrides?: (mock: MockGitHub, seed: SeedDefaults) => void,
): Promise<Harness> {
  const clock = fixedClock();
  const mock = new MockGitHub(clock.now);
  const seed: SeedDefaults = {
    parentHeadSha: HEAD_SHA,
    parentBase: STACK_TRUNK_BRANCH,
    parentMerged: false,
    parentMergeSha: null,
    parentMergedAt: null,
    reviews: "fresh-human",
    checks: "pass",
    childPresent: true,
    childBase: PARENT_BRANCH,
  };
  overrides?.(mock, seed);
  applySeed(mock, seed, clock.now);

  const bindingStore = new MemoryBindingStore();
  await seedBindings(bindingStore);
  const gateReceipts = new MemoryGateReceiptStore();
  const receiptStore = new MemoryReceiptStore();

  const auth = buildAuth(clock.now, mock);
  const client: GitHubClient = await auth.clientFor(REPO);
  const pullRequests = createPullRequestManager({ auth, botIdentity: BOT_IDENTITY });
  const remoteCi = createRemoteCiManager({ auth, now: clock.now });
  const stackParentage = createStackParentageManager({
    client,
    bindingStore,
    repositoryFullName: REPO,
  });
  const coordinator = createLandingCoordinator({
    auth,
    pullRequests,
    remoteCi,
    stackParentage,
    bindingStore,
    gateReceipts,
    receiptStore,
    policy: { requiredChecks: REQUIRED, gateExpectation: NO_GATES, mergeMethod: "squash" },
    treeId: TREE_ID,
    repositoryFullName: REPO,
    trunk: STACK_TRUNK_BRANCH,
    rulesetGate: { isEnforced: () => Promise.resolve(true) },
    now: clock.now,
  });

  return { mock, clock, bindingStore, gateReceipts, receiptStore, coordinator };
}

interface SeedDefaults {
  parentHeadSha: GitSha;
  parentBase: string;
  parentMerged: boolean;
  parentMergeSha: string | null;
  parentMergedAt: string | null;
  reviews: "fresh-human" | "stale-human" | "bot" | "none";
  checks: "pass" | "missing" | "fail";
  childPresent: boolean;
  childBase: string;
}

function applySeed(mock: MockGitHub, seed: SeedDefaults, now: () => number): void {
  mock.refs.set(PARENT_BRANCH, seed.parentHeadSha);
  mock.seedPull({
    number: PARENT_PR,
    title: "Parent feature",
    body: "body",
    state: seed.parentMerged ? "closed" : "open",
    merged: seed.parentMerged,
    draft: false,
    head: { ref: PARENT_BRANCH, sha: seed.parentHeadSha },
    base: { ref: seed.parentBase, sha: BASE_SHA },
    merge_commit_sha: seed.parentMergeSha,
    merged_at: seed.parentMergedAt,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${REPO}/pull/${String(PARENT_PR)}`,
  });

  // Reviews against the parent PR.
  const reviewCommit = seed.reviews === "stale-human" ? STALE_REVIEW_SHA : seed.parentHeadSha;
  const reviews: ReviewWire[] = [];
  if (seed.reviews === "fresh-human" || seed.reviews === "stale-human") {
    reviews.push({
      id: 1,
      user: { id: 501, login: "human-reviewer", type: "User" },
      state: "APPROVED",
      submitted_at: "2026-01-02T00:00:00Z",
      commit_id: reviewCommit,
      author_association: "MEMBER",
    });
  } else if (seed.reviews === "bot") {
    reviews.push({
      id: 2,
      user: { id: BOT_USER_ID, login: BOT_LOGIN, type: "Bot" },
      state: "APPROVED",
      submitted_at: "2026-01-02T00:00:00Z",
      commit_id: seed.parentHeadSha,
      author_association: "MEMBER",
    });
  }
  mock.reviewsByPr.set(PARENT_PR, reviews);

  // Checks for the parent head.
  if (seed.checks === "pass") {
    mock.checkRunsByRef.set(seed.parentHeadSha, [
      checkRun(10, "ci", seed.parentHeadSha, "success"),
      checkRun(11, "lint", seed.parentHeadSha, "success"),
    ]);
    mock.combinedStatusByRef.set(seed.parentHeadSha, { state: "success", total_count: 2 });
  } else if (seed.checks === "missing") {
    mock.checkRunsByRef.set(seed.parentHeadSha, [
      checkRun(10, "ci", seed.parentHeadSha, "success"),
    ]);
    mock.combinedStatusByRef.set(seed.parentHeadSha, { state: "success", total_count: 1 });
  } else {
    mock.checkRunsByRef.set(seed.parentHeadSha, [
      checkRun(10, "ci", seed.parentHeadSha, "success"),
      checkRun(11, "lint", seed.parentHeadSha, "failure"),
    ]);
    mock.combinedStatusByRef.set(seed.parentHeadSha, { state: "failure", total_count: 2 });
  }

  // Stacked child PR (retarget target).
  if (seed.childPresent) {
    mock.refs.set(CHILD_BRANCH, CHILD_HEAD_SHA);
    mock.seedPull({
      number: CHILD_PR,
      title: "Child feature",
      body: "body",
      state: "open",
      merged: false,
      draft: false,
      head: { ref: CHILD_BRANCH, sha: CHILD_HEAD_SHA },
      base: { ref: seed.childBase, sha: BASE_SHA },
      merge_commit_sha: null,
      merged_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      html_url: `https://github.com/${REPO}/pull/${String(CHILD_PR)}`,
    });
  }

  // Touch `now` so the linter keeps the param; the mock clock drives timestamps.
  void now;
}

function checkRun(id: number, name: string, headSha: string, conclusion: string): CheckRunWire {
  return { id, name, head_sha: headSha, status: "completed", conclusion };
}

async function seedBindings(store: MemoryBindingStore): Promise<void> {
  const recordedAt: Timestamp = timestampFromEpochMilliseconds(1_700_000_000_000);
  await store.upsertBinding({
    treeId: TREE_ID,
    nodeId: PARENT_NODE_ID,
    jjChangeId: PARENT_CHANGE,
    currentCommitId: HEAD_SHA,
    parentChangeId: undefined,
    bookmark: PARENT_BRANCH,
    rewriteGeneration: 0,
    lastJjOperationId: contentHash("a".repeat(64)),
    lastPushedCommitId: HEAD_SHA,
    lastReviewedCommitId: undefined,
    conflictState: "clean",
    recordedAt,
  });
  await store.upsertBinding({
    treeId: TREE_ID,
    nodeId: CHILD_NODE_ID,
    jjChangeId: CHILD_CHANGE,
    currentCommitId: CHILD_HEAD_SHA,
    parentChangeId: PARENT_CHANGE,
    bookmark: CHILD_BRANCH,
    rewriteGeneration: 0,
    lastJjOperationId: contentHash("b".repeat(64)),
    lastPushedCommitId: CHILD_HEAD_SHA,
    lastReviewedCommitId: undefined,
    conflictState: "clean",
    recordedAt,
  });
}

function parentIntent(headSha: GitSha = HEAD_SHA) {
  return {
    prNumber: PARENT_PR,
    repositoryFullName: REPO,
    requestedBy: "human" as const,
    // Capability derived from an authenticated actor session — the trust gate,
    // supplied at the test boundary exactly as the daemon would derive it from
    // the transport principal.
    humanApproval: humanApproval(AUTHENTICATED_ACTOR),
    expectedHeadSha: headSha,
    requestedAt: timestampFromEpochMilliseconds(1_700_000_001_000),
  };
}

// ================================================================================================
// Preflight + merge — happy path and rejection cases.
// ================================================================================================

describe("landing", () => {
  it("merges on a fully-passing preflight, records a receipt, and retargets children", async () => {
    const h = await harness();
    const receipt = await h.coordinator.land(parentIntent());

    expect(receipt.verdict).toBe("landed");
    expect(receipt.prNumber).toBe(PARENT_PR);
    expect(receipt.mergeMethod).toBe("squash");
    expect(receipt.mergedSha).toBe(MERGED_SHA);

    // The merge pinned the reviewed head and used squash.
    expect(h.mock.merges).toHaveLength(1);
    expect(h.mock.merges[0]?.method).toBe("squash");
    expect(h.mock.merges[0]?.sha).toBe(HEAD_SHA);

    // The durable receipt was recorded.
    expect(h.receiptStore.records).toBe(1);

    // Parent-before-child: the child PR was retargeted onto the trunk.
    expect(h.mock.baseUpdates).toEqual([{ prNumber: CHILD_PR, base: STACK_TRUNK_BRANCH }]);
    expect(receipt.parentRetargetPlan).toHaveLength(1);
    expect(receipt.parentRetargetPlan[0]?.childNodeId).toBe(CHILD_NODE_ID);
    expect(receipt.parentRetargetPlan[0]?.newBaseBranch).toBe(STACK_TRUNK_BRANCH);
  });

  it("rejects a bot review (not an eligible human approval)", async () => {
    const h = await harness((mock, seed) => {
      seed.reviews = "bot";
    });
    await expect(h.coordinator.land(parentIntent())).rejects.toMatchObject({
      name: "LandingError",
      code: "preflight_failed",
      verdict: "preflight_failed",
    });
    expect(h.mock.merges).toHaveLength(0);
  });

  it("rejects a stale review (approved before the latest push)", async () => {
    const h = await harness((mock, seed) => {
      seed.reviews = "stale-human";
    });
    await expect(h.coordinator.land(parentIntent())).rejects.toMatchObject({
      name: "LandingError",
      code: "preflight_failed",
      verdict: "preflight_failed",
    });
    expect(h.mock.merges).toHaveLength(0);
  });

  it("rejects a stale head (head moved since the command → ambiguous_remote)", async () => {
    // The human reviewed HEAD_SHA, but the live head has since moved to DRIFTED_SHA.
    const h = await harness((_mock, seed) => {
      seed.parentHeadSha = DRIFTED_SHA;
    });
    await expect(h.coordinator.land(parentIntent(HEAD_SHA))).rejects.toMatchObject({
      name: "LandingError",
      code: "ambiguous_remote",
      verdict: "ambiguous_remote",
    });
    expect(h.mock.merges).toHaveLength(0);
  });

  it("rejects when a required check is missing", async () => {
    const h = await harness((mock, seed) => {
      seed.checks = "missing";
    });
    await expect(h.coordinator.land(parentIntent())).rejects.toMatchObject({
      name: "LandingError",
      code: "preflight_failed",
      verdict: "preflight_failed",
    });
    expect(h.mock.merges).toHaveLength(0);
  });

  it("rejects an unlanded stacked parent (parent_not_landed)", async () => {
    // Parent PR targets a NON-trunk base (another stack branch) that is not merged.
    const h = await harness((mock, seed) => {
      seed.parentBase = CHILD_BRANCH;
    });
    await expect(h.coordinator.land(parentIntent())).rejects.toMatchObject({
      name: "LandingError",
      code: "parent_not_landed",
      verdict: "parent_not_landed",
    });
    expect(h.mock.merges).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // Idempotency + crash reconciliation.
  // -------------------------------------------------------------------------------------------

  it("is idempotent when the PR was already landed (already_landed)", async () => {
    const h = await harness((mock, seed) => {
      seed.parentMerged = true;
      seed.parentMergeSha = MERGED_SHA;
      seed.parentMergedAt = "2026-01-03T00:00:00Z";
    });
    const receipt = await h.coordinator.land(parentIntent());

    expect(receipt.verdict).toBe("already_landed");
    expect(receipt.mergedSha).toBe(MERGED_SHA);
    // No merge call was made — the PR was already merged on GitHub.
    expect(h.mock.merges).toHaveLength(0);
    // The reconstructed receipt was durably recorded.
    expect(h.receiptStore.records).toBe(1);
  });

  it("reconstructs the receipt from GitHub state after a crash (crash recovery)", async () => {
    // Phase 1: the merge succeeds but receipt persistence fails (simulated crash
    // between merge and receipt record). The PR is now merged on GitHub.
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    const seed: SeedDefaults = {
      parentHeadSha: HEAD_SHA,
      parentBase: STACK_TRUNK_BRANCH,
      parentMerged: false,
      parentMergeSha: null,
      parentMergedAt: null,
      reviews: "fresh-human",
      checks: "pass",
      childPresent: false,
      childBase: PARENT_BRANCH,
    };
    applySeed(mock, seed, clock.now);

    const bindingStore = new MemoryBindingStore();
    await seedBindings(bindingStore);
    const gateReceipts = new MemoryGateReceiptStore();
    // A receipt store that fails to persist (the crash).
    const crashingStore: LandingReceiptStore = {
      getReceipt: () => Promise.resolve(undefined),
      recordReceipt: () => Promise.reject(new Error("disk lost (crash)")),
    };

    const auth = buildAuth(clock.now, mock);
    const client = await auth.clientFor(REPO);
    const coordinator1 = createLandingCoordinator({
      auth,
      pullRequests: createPullRequestManager({ auth, botIdentity: BOT_IDENTITY }),
      remoteCi: createRemoteCiManager({ auth, now: clock.now }),
      stackParentage: createStackParentageManager({
        client,
        bindingStore,
        repositoryFullName: REPO,
      }),
      bindingStore,
      gateReceipts,
      receiptStore: crashingStore,
      policy: { requiredChecks: REQUIRED, gateExpectation: NO_GATES, mergeMethod: "squash" },
      treeId: TREE_ID,
      repositoryFullName: REPO,
      trunk: STACK_TRUNK_BRANCH,
      rulesetGate: { isEnforced: () => Promise.resolve(true) },
      now: clock.now,
    });

    // Phase 1: merge happens, then receipt persistence throws.
    await expect(coordinator1.land(parentIntent())).rejects.toMatchObject({
      name: "LandingError",
      code: "receipt_failed",
    });
    // The merge DID land on GitHub before the crash.
    expect(mock.merges).toHaveLength(1);

    // Phase 2: restart with a FRESH receipt store. The PR is merged on GitHub but
    // no receipt exists locally → reconcile by reconstructing.
    const freshStore = new MemoryReceiptStore();
    const coordinator2 = createLandingCoordinator({
      auth,
      pullRequests: createPullRequestManager({ auth, botIdentity: BOT_IDENTITY }),
      remoteCi: createRemoteCiManager({ auth, now: clock.now }),
      stackParentage: createStackParentageManager({
        client,
        bindingStore,
        repositoryFullName: REPO,
      }),
      bindingStore,
      gateReceipts,
      receiptStore: freshStore,
      policy: { requiredChecks: REQUIRED, gateExpectation: NO_GATES, mergeMethod: "squash" },
      treeId: TREE_ID,
      repositoryFullName: REPO,
      trunk: STACK_TRUNK_BRANCH,
      rulesetGate: { isEnforced: () => Promise.resolve(true) },
      now: clock.now,
    });

    const receipt = await coordinator2.land(parentIntent());
    expect(receipt.verdict).toBe("already_landed");
    expect(receipt.mergedSha).toBe(MERGED_SHA);
    // No second merge — reconciled from GitHub state.
    expect(mock.merges).toHaveLength(1);
    expect(freshStore.records).toBe(1);
  });

  it("is idempotent for a duplicate command (duplicate_command)", async () => {
    const h = await harness();
    const first = await h.coordinator.land(parentIntent());
    expect(first.verdict).toBe("landed");
    expect(h.mock.merges).toHaveLength(1);

    // Second identical command: the recorded receipt short-circuits (no re-merge).
    const second = await h.coordinator.land(parentIntent());
    expect(second.verdict).toBe("duplicate_command");
    expect(second.mergedSha).toBe(MERGED_SHA);
    expect(h.mock.merges).toHaveLength(1);
    expect(h.receiptStore.records).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // Acceptance invariants.
  // -------------------------------------------------------------------------------------------

  it("rejects a self-asserted human initiator with no verified principal (forge)", async () => {
    const h = await harness();
    // An automated webhook/timer/model can send requestedBy: "human" (forged
    // provenance) but CANNOT construct a genuine HumanApproval — the
    // module-private symbol tag is unforgeable from a request body. Omitting the
    // capability must fail closed even though requestedBy is "human".
    const forged = {
      prNumber: PARENT_PR,
      repositoryFullName: REPO,
      requestedBy: "human",
      expectedHeadSha: HEAD_SHA,
      requestedAt: timestampFromEpochMilliseconds(1_700_000_001_000),
    } as unknown as LandingIntent;
    await expect(h.coordinator.land(forged)).rejects.toThrow(/verified human principal/u);
    expect(h.mock.merges).toHaveLength(0);
  });

  it("rejects a capability that an unauthenticated caller casts from a plain object", async () => {
    const h = await harness();
    // A cast cannot manufacture the module-private symbol tag: this plain object
    // carries no genuine HumanApproval and must be rejected at the boundary.
    const forgedCapability = {
      prNumber: PARENT_PR,
      repositoryFullName: REPO,
      requestedBy: "human",
      humanApproval: { bogus: true } as unknown as HumanApproval,
      expectedHeadSha: HEAD_SHA,
      requestedAt: timestampFromEpochMilliseconds(1_700_000_001_000),
    } as unknown as LandingIntent;
    await expect(h.coordinator.land(forgedCapability)).rejects.toThrow(
      /verified human principal/u,
    );
    expect(h.mock.merges).toHaveLength(0);
  });

  it("lands when the capability is derived from an authenticated principal", async () => {
    const h = await harness();
    const intent: LandingIntent = {
      prNumber: PARENT_PR,
      repositoryFullName: REPO,
      humanApproval: humanApproval(AUTHENTICATED_ACTOR),
      requestedBy: "human",
      expectedHeadSha: HEAD_SHA,
      requestedAt: timestampFromEpochMilliseconds(1_700_000_001_000),
    };
    const receipt = await h.coordinator.land(intent);
    expect(receipt.verdict).toBe("landed");
    expect(h.mock.merges).toHaveLength(1);
  });
});
