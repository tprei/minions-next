import { generateKeyPairSync } from "node:crypto";

import {
  createGitHubAppAuth,
  createPushManager,
  createRemoteCiManager,
  RemoteCiError,
  type CiRepairHarness,
  type CiNodeRepairInput,
  type CredentialVault,
  type CredentialVaultProbeResult,
  type GitHubFetch,
  type PushManager,
  type PushReceipt,
  type PushWorkingCopy,
  type RemoteCiManager,
} from "@minions/adapters";
import {
  attemptId,
  contentHash,
  createRetryBudget,
  gitSha,
  taskNodeId,
  taskTreeId,
  type AttemptId,
  type FailureClass,
  type GitSha,
  type NoProgressSignature,
  type RepairAttention,
  type RepairAttemptEvidence,
  type RepairDecision,
  type RepairOutcome,
  type RequiredCheckSet,
  type TaskNodeId,
  type TaskTreeId,
} from "@minions/core";
import { describe, expect, it } from "vitest";

/**
 * Integration test for PR 35: remote CI as exact-head deterministic evidence.
 * Every scenario drives the real {@link createRemoteCiManager} against a MOCK
 * GitHub REST API (no real network): a stateful in-memory GitHub whose `fetch`
 * the test configures per case. The repair harness and push manager are test
 * seams; the pure classification (isCheckPassing / classifyOverall) is
 * exercised end to end through observeCi.
 *
 * Coverage (from the brief):
 * - All required success → success.
 * - One required missing → incomplete (never success).
 * - skipped / cancelled / neutral / timed_out → NOT success.
 * - Stale check (different head SHA) → stale, NOT success.
 * - Base failure (check fails on both head and base) → base_failure.
 * - Repair: node failure → repair → re-push → pass → repaired.
 * - Repair exhausted (harness escalates) → human attention.
 * - No-progress (same failing signature) → escalate.
 * - waitForChecks timeout → timed_out.
 */

const APP_ID = 123456;
const APP_SLUG = "minions-engine";
const INSTALLATION_ID = 555;
const REPO = "acme/landing-app";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const HEAD_SHA_A = gitSha("a".repeat(40));
const HEAD_SHA_B = gitSha("b".repeat(40));
const HEAD_SHA_C = gitSha("c".repeat(40));
const BASE_SHA = gitSha("0".repeat(40));
const STALE_SHA = gitSha("9".repeat(40));
const CHANGE_ID = contentHash("c".repeat(64));

const NODE_ID: TaskNodeId = taskNodeId("01900000-0000-7000-8000-000000000001");
const TREE_ID: TaskTreeId = taskTreeId("01900000-0000-7000-8000-000000000002");
const ATTEMPT_ID: AttemptId = attemptId("01900000-0000-7000-8000-000000000003");

const REQUIRED: RequiredCheckSet = Object.freeze({ requiredChecks: Object.freeze(["ci", "lint"]) });

// -------------------------------------------------------------------------------------------------
// In-memory vault.
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
// Wire shapes (snake_case, as GitHub emits).
// -------------------------------------------------------------------------------------------------

interface CheckRunWire {
  id: number;
  name: string;
  head_sha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface PrRecord {
  number: number;
  headRef: string;
  baseRef: string;
  baseSha: GitSha;
  title: string;
  state: "open" | "closed";
}

function checkRun(input: {
  id: number;
  name: string;
  headSha: GitSha;
  status?: "queued" | "in_progress" | "completed";
  conclusion: string | null;
}): CheckRunWire {
  return {
    id: input.id,
    name: input.name,
    head_sha: input.headSha,
    status: input.status ?? "completed",
    conclusion: input.conclusion,
    started_at: null,
    completed_at: null,
  };
}

// -------------------------------------------------------------------------------------------------
// Mock GitHub — stateful, routes the subset of the REST API this PR exercises.
// -------------------------------------------------------------------------------------------------

class MockGitHub {
  readonly refs = new Map<string, string>();
  readonly pulls: PrRecord[] = [];
  readonly checkRunsByRef = new Map<string, CheckRunWire[]>();
  readonly combinedStatusByRef = new Map<string, { state: string; total_count: number }>();
  private tokenCounter = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Register an open PR whose head tracks `refs[headRef]`. */
  seedPr(pr: PrRecord): void {
    this.pulls.push(pr);
  }

  readonly fetch: GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(this.route(method, url, body));
  };

  private jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  private route(method: string, url: string, body: string): Response {
    // --- App / auth scaffolding (so auth.clientFor works against the mock). ---
    if (method === "GET" && url.endsWith("/app")) {
      return this.jsonResponse({ id: APP_ID, slug: APP_SLUG, name: "Minions Engine" });
    }
    if (method === "GET" && url.includes(`/repos/${REPO}/installation`)) {
      return this.jsonResponse({ id: INSTALLATION_ID, app_id: APP_ID, app_slug: APP_SLUG });
    }
    if (
      method === "POST" &&
      url.includes(`/app/installations/${String(INSTALLATION_ID)}/access_tokens`)
    ) {
      this.tokenCounter += 1;
      return this.jsonResponse({
        token: `ghs_token_${String(this.tokenCounter)}`,
        expires_at: new Date(this.now() + 60 * 60 * 1000).toISOString(),
        permissions: { pull_requests: "write", contents: "write" },
        repository_selection: "selected",
        repositories: [{ id: 4242, full_name: REPO }],
      });
    }

    // --- Pull requests (single). ---
    const singlePrMatch = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/u.exec(url);
    if (method === "GET" && singlePrMatch !== null) {
      const number = Number.parseInt(singlePrMatch[1] ?? "", 10);
      const pr = this.pulls.find((candidate) => candidate.number === number);
      if (pr === undefined) {
        return new Response("not found", { status: 404 });
      }
      // The head SHA tracks the current ref so a re-push is observable.
      const headSha = this.refs.get(pr.headRef) ?? HEAD_SHA_A;
      return this.jsonResponse({
        number: pr.number,
        title: pr.title,
        body: "PR body",
        state: pr.state,
        merged: false,
        draft: false,
        head: { ref: pr.headRef, sha: headSha },
        base: { ref: pr.baseRef, sha: pr.baseSha },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        html_url: `https://github.com/${REPO}/pull/${String(pr.number)}`,
      });
    }

    // --- Checks. ---
    const checkRunsMatch = /\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/u.exec(url);
    if (method === "GET" && checkRunsMatch !== null) {
      const ref = decodeURIComponent(checkRunsMatch[1] ?? "");
      return this.jsonResponse({ check_runs: this.checkRunsByRef.get(ref) ?? [] });
    }
    const statusMatch = /\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/status$/u.exec(url);
    if (method === "GET" && statusMatch !== null) {
      const ref = decodeURIComponent(statusMatch[1] ?? "");
      return this.jsonResponse(
        this.combinedStatusByRef.get(ref) ?? { state: "pending", total_count: 0 },
      );
    }

    // --- Git refs (push lease surface). ---
    const refMatch = /\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/([^?]+)$/u.exec(url);
    if (refMatch !== null) {
      const branch = decodeURIComponent(refMatch[1] ?? "");
      if (method === "GET") {
        const sha = this.refs.get(branch);
        return sha === undefined
          ? new Response("not found", { status: 404 })
          : this.jsonResponse({
              ref: `refs/heads/${branch}`,
              object: { sha, type: "commit" },
            });
      }
      if (method === "PATCH") {
        const parsed = JSON.parse(body) as { sha: string };
        this.refs.set(branch, parsed.sha);
        return this.jsonResponse({
          ref: `refs/heads/${branch}`,
          object: { sha: parsed.sha, type: "commit" },
        });
      }
    }

    return new Response(`mock: unhandled ${method} ${url}`, { status: 500 });
  }
}

// -------------------------------------------------------------------------------------------------
// Harness builders.
// -------------------------------------------------------------------------------------------------

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

function fixedClock(): { now: () => number; advance(ms: number): void } {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A clock that advances a fixed step on every read — drives waitForChecks deadlines. */
function steppingClock(stepMs: number): { now: () => number } {
  let t = 1_700_000_000_000;
  return {
    now: () => {
      t += stepMs;
      return t;
    },
  };
}

function managerFor(
  mock: MockGitHub,
  clock: { now: () => number },
  sleep?: (ms: number) => Promise<void>,
): RemoteCiManager {
  const base = { auth: buildAuth(clock.now, mock), now: clock.now } as const;
  return createRemoteCiManager(sleep === undefined ? base : { ...base, sleep });
}

function seedOpenPr(mock: MockGitHub, headSha: GitSha, baseSha = BASE_SHA): void {
  mock.seedPr({
    number: 5,
    headRef: "minions/node-1",
    baseRef: "main",
    baseSha,
    title: "Implement feature",
    state: "open",
  });
  mock.refs.set("minions/node-1", headSha);
}

function setRuns(mock: MockGitHub, sha: GitSha, runs: CheckRunWire[]): void {
  mock.checkRunsByRef.set(sha, runs);
}

function setStatus(mock: MockGitHub, sha: GitSha, state: string, totalCount = 0): void {
  mock.combinedStatusByRef.set(sha, { state, total_count: totalCount });
}

// -------------------------------------------------------------------------------------------------
// Repair-outcome factories (PR 26 shapes) for the mock harness.
// -------------------------------------------------------------------------------------------------

const EMPTY_SIGNATURE: NoProgressSignature = Object.freeze({
  failureClass: "gate_failure",
  changedPathsDigest: contentHash("0".repeat(64)),
  headCommit: HEAD_SHA_A,
  outputDigest: contentHash("1".repeat(64)),
});

function attemptEvidence(id: AttemptId): RepairAttemptEvidence {
  return Object.freeze({
    attemptId: id,
    failureClass: "gate_failure",
    outcome: undefined,
    gateReceipts: [],
    signature: EMPTY_SIGNATURE,
    errorMessage: "simulated failure",
  });
}

function repairedOutcome(attempts: number): RepairOutcome {
  const list: RepairAttemptEvidence[] = [];
  for (let index = 0; index < attempts; index += 1) {
    list.push(
      attemptEvidence(
        attemptId(`01900000-0000-7000-8000-${(10 + index).toString().padStart(12, "0")}`),
      ),
    );
  }
  return Object.freeze({
    nodeId: NODE_ID,
    treeId: TREE_ID,
    status: "repaired",
    attempts: Object.freeze(list),
    budget: createRetryBudget(3, attempts),
    decision: undefined,
    attention: undefined,
  });
}

function escalatedOutcome(
  attentionKind: RepairAttention["attentionKind"],
  reason: string,
  failureClass: FailureClass = "gate_failure",
): RepairOutcome {
  const attempts = [attemptEvidence(ATTEMPT_ID)];
  const decision: RepairDecision = Object.freeze({
    action: "escalate",
    reason,
    failureClass,
    budget: createRetryBudget(3, 1),
    noProgress: attentionKind === "no_progress",
  });
  const attention: RepairAttention = Object.freeze({
    nodeId: NODE_ID,
    treeId: TREE_ID,
    failureClass,
    attemptCount: attempts.length,
    evidenceRefs: Object.freeze([
      Object.freeze({
        attemptId: ATTEMPT_ID,
        outcomeText: "",
        gateReceiptSequences: [],
      }),
    ]),
    attentionKind,
    reason,
  });
  return Object.freeze({
    nodeId: NODE_ID,
    treeId: TREE_ID,
    status: "escalated",
    attempts: Object.freeze(attempts),
    budget: createRetryBudget(3, 1),
    decision,
    attention,
  });
}

/** A repair harness scripted to return a fixed sequence of outcomes. */
class ScriptedHarness implements CiRepairHarness {
  private readonly outcomes: RepairOutcome[];
  readonly calls: CiNodeRepairInput[] = [];
  private index = 0;

  constructor(outcomes: RepairOutcome[]) {
    this.outcomes = outcomes;
  }

  attemptNodeRepair(input: CiNodeRepairInput): Promise<RepairOutcome> {
    this.calls.push(input);
    const outcome = this.outcomes[this.index] ?? this.outcomes.at(-1);
    if (outcome === undefined) {
      throw new Error("ScriptedHarness: no outcomes scripted");
    }
    if (this.index < this.outcomes.length - 1) {
      this.index += 1;
    }
    return Promise.resolve(outcome);
  }
}

/** A push manager that advances the mock ref through a scripted SHA sequence. */
class SequencePush implements PushManager {
  private readonly shas: GitSha[];
  calls = 0;

  constructor(
    private readonly mock: MockGitHub,
    private readonly bookmark: string,
    shas: readonly GitSha[],
  ) {
    this.shas = [...shas];
  }

  push(input: { readonly repositoryFullName: string }): Promise<PushReceipt> {
    const next = this.shas.shift();
    if (next === undefined) {
      return Promise.reject(new Error("SequencePush: no more scripted SHAs"));
    }
    this.mock.refs.set(this.bookmark, next);
    this.calls += 1;
    return Promise.resolve(
      Object.freeze({
        repositoryFullName: input.repositoryFullName,
        bookmark: this.bookmark,
        commitSha: next,
        remoteHeadSha: next,
        expectedRemoteHeadSha: undefined,
        pushedAt: "2026-01-01T00:00:00Z",
        action: "pushed",
      }),
    );
  }
}

/** A push working copy mapping a jj change id to a fixed commit (for the real push manager). */
function workingCopyReturning(sha: GitSha): PushWorkingCopy {
  return {
    exportCommit() {
      return Promise.resolve({ commitSha: sha });
    },
  };
}

const REPAIR_CONTEXT = Object.freeze({
  nodeId: NODE_ID,
  treeId: TREE_ID,
  jjChangeId: CHANGE_ID,
  bookmark: "minions/node-1",
  expectedRemoteHeadSha: HEAD_SHA_A,
});

// ================================================================================================
// observeCi — fail-closed classification (QA-06..QA-10).
// ================================================================================================

describe("observeCi", () => {
  it("reports success when every required check is green", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");
    const evidence = await managerFor(mock, clock).observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });

    expect(evidence.overallVerdict).toBe("success");
    expect(evidence.allRequiredPresent).toBe(true);
    expect(evidence.checks.find((c) => c.name === "ci")?.verdict).toBe("success");
  });

  it("reports incomplete when a required check is missing (never success)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");
    const evidence = await managerFor(mock, clock).observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });

    expect(evidence.overallVerdict).toBe("incomplete");
    expect(evidence.allRequiredPresent).toBe(false);
    expect(evidence.checks.find((c) => c.name === "lint")?.verdict).toBe("missing");
  });

  it("treats a skipped check as NOT success (incomplete)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "skipped" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");
    const evidence = await managerFor(mock, clock).observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });

    expect(evidence.overallVerdict).toBe("incomplete");
    expect(evidence.checks.find((c) => c.name === "lint")?.verdict).toBe("skipped");
  });

  it("treats a neutral check as NOT success (incomplete)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "neutral" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");
    const evidence = await managerFor(mock, clock).observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });

    expect(evidence.overallVerdict).toBe("incomplete");
    expect(evidence.checks.find((c) => c.name === "lint")?.verdict).toBe("neutral");
  });

  it("treats a cancelled check as NOT success (failure)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "cancelled" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");
    const evidence = await managerFor(mock, clock).observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });

    expect(evidence.overallVerdict).toBe("failure");
    expect(evidence.checks.find((c) => c.name === "lint")?.verdict).toBe("cancelled");
  });

  it("treats a timed_out check as NOT success (failure)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "timed_out" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");
    const evidence = await managerFor(mock, clock).observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });

    expect(evidence.overallVerdict).toBe("failure");
    expect(evidence.checks.find((c) => c.name === "lint")?.verdict).toBe("timed_out");
  });

  it("treats a stale check (different head SHA) as NOT success", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    // The "ci" run recorded success but ran against a different head (STALE_SHA).
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: STALE_SHA, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");
    const evidence = await managerFor(mock, clock).observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });

    const ci = evidence.checks.find((c) => c.name === "ci");
    expect(ci?.verdict).toBe("stale");
    expect(evidence.overallVerdict).toBe("incomplete");
    expect(evidence.allRequiredPresent).toBe(false);
  });
});

// ================================================================================================
// waitForChecks — polling + timeout.
// ================================================================================================

describe("waitForChecks", () => {
  it("returns success evidence once every required check is terminal-green", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");
    const evidence = await managerFor(mock, clock).waitForChecks({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
      timeoutMs: 1000,
      pollIntervalMs: 0,
    });

    expect(evidence.overallVerdict).toBe("success");
  });

  it("times out with code 'timeout' when a required check never completes", async () => {
    const clock = steppingClock(100);
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    // "ci" is still running; "lint" is green. The running check never completes.
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, status: "in_progress", conclusion: null }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "pending");

    await expect(
      managerFor(mock, clock, () => Promise.resolve()).waitForChecks({
        repositoryFullName: REPO,
        prNumber: 5,
        requiredChecks: REQUIRED,
        timeoutMs: 50,
        pollIntervalMs: 0,
      }),
    ).rejects.toMatchObject({ name: "RemoteCiError", code: "timeout" });
  });
});

// ================================================================================================
// attemptCiRepair — base failure, repair, exhaustion, no-progress.
// ================================================================================================

describe("attemptCiRepair", () => {
  it("classifies a check failing on both head and base as a base failure", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A, BASE_SHA);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "failure" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "failure");
    // The same check fails on the base → infrastructure, not a node defect.
    setRuns(mock, BASE_SHA, [
      checkRun({ id: 1, name: "ci", headSha: BASE_SHA, conclusion: "failure" }),
    ]);
    setStatus(mock, BASE_SHA, "failure");

    const manager = managerFor(mock, clock);
    const evidence = await manager.observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });
    const outcome = await manager.attemptCiRepair(
      {
        repositoryFullName: REPO,
        prNumber: 5,
        evidence,
        requiredChecks: REQUIRED,
        repairContext: { ...REPAIR_CONTEXT, budget: createRetryBudget(3) },
      },
      {
        harness: new ScriptedHarness([repairedOutcome(1)]),
        push: new SequencePush(mock, "minions/node-1", [HEAD_SHA_B]),
      },
    );

    expect(outcome.status).toBe("base_failure");
    expect(outcome.failingChecks).toContain("ci");
    expect(outcome.attempts).toBe(0);
  });

  it("repairs a node failure, re-pushes, and reaches success", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A, BASE_SHA);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "failure" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "failure");
    // Base is green → this is a node failure, repairable.
    setRuns(mock, BASE_SHA, [
      checkRun({ id: 1, name: "ci", headSha: BASE_SHA, conclusion: "success" }),
    ]);
    setStatus(mock, BASE_SHA, "success");
    // After the repair + re-push to HEAD_SHA_B, CI is green.
    setRuns(mock, HEAD_SHA_B, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_B, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_B, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_B, "success");

    const manager = managerFor(mock, clock);
    const evidence = await manager.observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });
    const push = new SequencePush(mock, "minions/node-1", [HEAD_SHA_B]);
    const outcome = await manager.attemptCiRepair(
      {
        repositoryFullName: REPO,
        prNumber: 5,
        evidence,
        requiredChecks: REQUIRED,
        repairContext: { ...REPAIR_CONTEXT, budget: createRetryBudget(3) },
      },
      { harness: new ScriptedHarness([repairedOutcome(1)]), push },
    );

    expect(outcome.status).toBe("repaired");
    expect(outcome.evidence.overallVerdict).toBe("success");
    expect(outcome.evidence.headSha).toBe(HEAD_SHA_B);
    expect(push.calls).toBe(1);
  });

  it("escalates to human attention when the repair harness exhausts", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A, BASE_SHA);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "failure" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "failure");
    setRuns(mock, BASE_SHA, [
      checkRun({ id: 1, name: "ci", headSha: BASE_SHA, conclusion: "success" }),
    ]);
    setStatus(mock, BASE_SHA, "success");

    const manager = managerFor(mock, clock);
    const evidence = await manager.observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });
    const outcome = await manager.attemptCiRepair(
      {
        repositoryFullName: REPO,
        prNumber: 5,
        evidence,
        requiredChecks: REQUIRED,
        repairContext: { ...REPAIR_CONTEXT, budget: createRetryBudget(3) },
      },
      {
        harness: new ScriptedHarness([
          escalatedOutcome("budget_exhausted", "retry budget exhausted"),
        ]),
        push: new SequencePush(mock, "minions/node-1", []),
      },
    );

    expect(outcome.status).toBe("escalated");
    expect(outcome.attention?.attentionKind).toBe("budget_exhausted");
  });

  it("escalates as no-progress when the failing signature repeats after repair", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A, BASE_SHA);
    // "ci" fails on the head; base is green → node failure.
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "failure" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "failure");
    setRuns(mock, BASE_SHA, [
      checkRun({ id: 1, name: "ci", headSha: BASE_SHA, conclusion: "success" }),
    ]);
    setStatus(mock, BASE_SHA, "success");
    // Two repairs, but the check keeps failing with the SAME signature.
    setRuns(mock, HEAD_SHA_B, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_B, conclusion: "failure" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_B, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_B, "failure");
    setRuns(mock, HEAD_SHA_C, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_C, conclusion: "failure" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_C, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_C, "failure");

    const manager = managerFor(mock, clock);
    const evidence = await manager.observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });
    const outcome = await manager.attemptCiRepair(
      {
        repositoryFullName: REPO,
        prNumber: 5,
        evidence,
        requiredChecks: REQUIRED,
        repairContext: { ...REPAIR_CONTEXT, budget: createRetryBudget(3) },
      },
      {
        harness: new ScriptedHarness([repairedOutcome(1), repairedOutcome(1)]),
        push: new SequencePush(mock, "minions/node-1", [HEAD_SHA_B, HEAD_SHA_C]),
      },
    );

    expect(outcome.status).toBe("no_progress");
    expect(outcome.failingChecks).toEqual(["ci"]);
  });
});

// ================================================================================================
// invalidateStaleChecks — exact-head reconciliation.
// ================================================================================================

describe("invalidateStaleChecks", () => {
  it("flags a check that ran against a different head as stale", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: STALE_SHA, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "success");

    const evidence = await managerFor(mock, clock).invalidateStaleChecks({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
      currentHeadSha: HEAD_SHA_A,
    });

    expect(evidence.checks.find((c) => c.name === "ci")?.verdict).toBe("stale");
    expect(evidence.overallVerdict).toBe("incomplete");
  });

  it("errors when the observed head does not match the expected current head", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A);
    setStatus(mock, HEAD_SHA_A, "success");

    await expect(
      managerFor(mock, clock).invalidateStaleChecks({
        repositoryFullName: REPO,
        prNumber: 5,
        requiredChecks: REQUIRED,
        currentHeadSha: HEAD_SHA_B,
      }),
    ).rejects.toBeInstanceOf(RemoteCiError);
  });
});

// ================================================================================================
// Real push manager integration — re-push via the GitHub git-refs API.
// ================================================================================================

describe("attemptCiRepair with the real push manager", () => {
  it("re-pushes the repaired commit through the git-refs lease surface", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedOpenPr(mock, HEAD_SHA_A, BASE_SHA);
    setRuns(mock, HEAD_SHA_A, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_A, conclusion: "failure" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_A, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_A, "failure");
    setRuns(mock, BASE_SHA, [
      checkRun({ id: 1, name: "ci", headSha: BASE_SHA, conclusion: "success" }),
    ]);
    setStatus(mock, BASE_SHA, "success");
    setRuns(mock, HEAD_SHA_B, [
      checkRun({ id: 1, name: "ci", headSha: HEAD_SHA_B, conclusion: "success" }),
      checkRun({ id: 2, name: "lint", headSha: HEAD_SHA_B, conclusion: "success" }),
    ]);
    setStatus(mock, HEAD_SHA_B, "success");

    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(HEAD_SHA_B),
      now: clock.now,
    });
    const manager = createRemoteCiManager({ auth, now: clock.now });
    const evidence = await manager.observeCi({
      repositoryFullName: REPO,
      prNumber: 5,
      requiredChecks: REQUIRED,
    });
    const outcome = await manager.attemptCiRepair(
      {
        repositoryFullName: REPO,
        prNumber: 5,
        evidence,
        requiredChecks: REQUIRED,
        repairContext: { ...REPAIR_CONTEXT, budget: createRetryBudget(3) },
      },
      { harness: new ScriptedHarness([repairedOutcome(1)]), push },
    );

    expect(outcome.status).toBe("repaired");
    expect(outcome.evidence.headSha).toBe(HEAD_SHA_B);
    // The mock ref was advanced to the repaired commit.
    expect(mock.refs.get("minions/node-1")).toBe(HEAD_SHA_B);
  });
});
