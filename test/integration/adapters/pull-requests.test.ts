import { generateKeyPairSync } from "node:crypto";

import {
  createGitHubAppAuth,
  createPullRequestManager,
  createPushManager,
  PushError,
  type BotIdentity,
  type CredentialVault,
  type CredentialVaultProbeResult,
  type GitHubFetch,
  type PullRequestManager,
  type PushWorkingCopy,
} from "@minions/adapters";
import { contentHash, gitSha, type ContentHash, type GitSha } from "@minions/core";
import { describe, expect, it } from "vitest";

/**
 * Integration test for PR 32: push with leases + one-PR-per-node management +
 * review/check observation. Every scenario drives the real push/PR managers
 * against a MOCK GitHub REST API (no real network): a stateful in-memory GitHub
 * whose `fetch` the test configures per case.
 *
 * Coverage (from the brief):
 * - Push: expected-head match → OK; drift → reject; conflict-unresolved →
 *   reject; idempotent re-push; lease rejection (422) → lease_expired.
 * - createOrUpdatePR: none → create; open → update; closed → create new;
 *   multiple open → error (GIT-03 invariant).
 * - observeReviewState: fresh human → approved; stale human → stale; bot → not
 *   eligible; none → pending (GIT-11 stale-approval detection).
 * - observeChecks: pass/fail/pending/missing.
 * - Crash recovery: push OK, PR create fails → retry → created (idempotent).
 */

const APP_ID = 123456;
const APP_SLUG = "minions-engine";
const BOT_LOGIN = "minions-engine[bot]";
const BOT_USER_ID = 9876543;
const INSTALLATION_ID = 555;
const REPO = "acme/landing-app";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const HEAD_SHA_A = gitSha("a".repeat(40));
const HEAD_SHA_B = gitSha("b".repeat(40));
const OLD_SHA = gitSha("0".repeat(40));
const CHANGE_ID = contentHash("c".repeat(64));

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
// Wire-shape builders (snake_case, as GitHub emits).
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
  started_at: string | null;
  completed_at: string | null;
}

function prWire(input: {
  number: number;
  branch: string;
  headSha: string;
  base?: string;
  title?: string;
  state?: "open" | "closed";
  merged?: boolean;
}): PrWire {
  return {
    number: input.number,
    title: input.title ?? "Implement feature",
    body: "PR body",
    state: input.state ?? "open",
    merged: input.merged ?? false,
    draft: false,
    head: { ref: input.branch, sha: input.headSha },
    base: { ref: input.base ?? "main", sha: OLD_SHA },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${REPO}/pull/${String(input.number)}`,
  };
}

// -------------------------------------------------------------------------------------------------
// Mock GitHub — stateful, routes the subset of the REST API this PR exercises.
// -------------------------------------------------------------------------------------------------

interface FetchRecord {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

class MockGitHub {
  readonly refs = new Map<string, string>();
  readonly pulls: PrWire[] = [];
  readonly reviewsByPr = new Map<number, ReviewWire[]>();
  readonly checkRunsByRef = new Map<string, CheckRunWire[]>();
  readonly combinedStatusByRef = new Map<string, { state: string; total_count: number }>();
  private nextPrNumber = 100;
  /** Crash-recovery hook: make the next PR create return 500, then clear. */
  failNextCreate = false;
  /** Lease hook: make the next ref update return 422. */
  leaseRejectNextUpdate = false;
  readonly records: FetchRecord[] = [];
  private readonly now: () => number;
  private tokenCounter = 0;

  constructor(now: () => number) {
    this.now = now;
  }

  private mintPrNumber(): number {
    const n = this.nextPrNumber;
    this.nextPrNumber += 1;
    return n;
  }

  /** Register an open PR for a branch (test fixture). */
  seedPull(pr: PrWire): void {
    this.pulls.push(pr);
    if (pr.number >= this.nextPrNumber) {
      this.nextPrNumber = pr.number + 1;
    }
  }

  readonly fetch: GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    this.records.push({ method, url, body });
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
    if (method === "GET" && url.includes(`/users/${encodeURIComponent(BOT_LOGIN)}`)) {
      return this.jsonResponse({ id: BOT_USER_ID, login: BOT_LOGIN, type: "Bot" });
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

    // --- Git refs (the push lease surface). ---
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
        if (this.leaseRejectNextUpdate) {
          this.leaseRejectNextUpdate = false;
          return new Response(JSON.stringify({ message: "Update is not a fast forward" }), {
            status: 422,
            headers: { "content-type": "application/json" },
          });
        }
        const parsed = JSON.parse(body) as { sha: string };
        this.refs.set(branch, parsed.sha);
        return this.jsonResponse({
          ref: `refs/heads/${branch}`,
          object: { sha: parsed.sha, type: "commit" },
        });
      }
    }

    // --- Pull requests. ---
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
      return this.jsonResponse(filtered);
    }
    if (method === "POST" && /\/repos\/[^/]+\/[^/]+\/pulls$/u.test(url)) {
      if (this.failNextCreate) {
        this.failNextCreate = false;
        return new Response(JSON.stringify({ message: "server error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      const parsed = JSON.parse(body) as { title: string; head: string; base: string };
      const number = this.mintPrNumber();
      const sha = this.refs.get(parsed.head) ?? HEAD_SHA_A;
      const created = prWire({
        number,
        branch: parsed.head,
        headSha: sha,
        base: parsed.base,
        title: parsed.title,
        state: "open",
      });
      this.pulls.push(created);
      return this.jsonResponse(created);
    }
    const singlePrMatch = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/u.exec(url);
    if (singlePrMatch !== null) {
      const number = Number.parseInt(singlePrMatch[1] ?? "", 10);
      const index = this.pulls.findIndex((pr) => pr.number === number);
      const current = index === -1 ? undefined : this.pulls[index];
      if (current === undefined) {
        return new Response("not found", { status: 404 });
      }
      if (method === "GET") {
        return this.jsonResponse(current);
      }
      if (method === "PATCH") {
        const parsed = JSON.parse(body) as {
          title?: string;
          body?: string | null;
          base?: string;
          state?: "open" | "closed";
        };
        const updated: PrWire = {
          ...current,
          title: parsed.title ?? current.title,
          body: parsed.body ?? current.body,
          base: { ...current.base, ref: parsed.base ?? current.base.ref },
          state: parsed.state ?? current.state,
          updated_at: new Date(this.now()).toISOString(),
        };
        if (index !== -1) {
          this.pulls[index] = updated;
        }
        return this.jsonResponse(updated);
      }
    }
    const reviewsMatch = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/u.exec(url);
    if (method === "GET" && reviewsMatch !== null) {
      const number = Number.parseInt(reviewsMatch[1] ?? "", 10);
      return this.jsonResponse(this.reviewsByPr.get(number) ?? []);
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

const botIdentity: BotIdentity = {
  appId: APP_ID,
  appSlug: APP_SLUG,
  name: "Minions Engine",
  botLogin: BOT_LOGIN,
  botUserId: BOT_USER_ID,
};

/** Push working copy that maps a jj change id to a deterministic commit SHA. */
function workingCopyReturning(shaByChange: Map<ContentHash, GitSha>): PushWorkingCopy {
  return {
    exportCommit(jjChangeId) {
      const sha = shaByChange.get(jjChangeId);
      if (sha === undefined) {
        return Promise.reject(new Error(`no fixture commit for change ${jjChangeId}`));
      }
      return Promise.resolve({ commitSha: sha });
    },
  };
}

/** Push working copy that always aborts with an unresolved conflict. */
const conflictWorkingCopy: PushWorkingCopy = {
  exportCommit() {
    return Promise.reject(
      new PushError(
        "conflict_unresolved",
        "jj change has unresolved conflicts; aborting before push",
      ),
    );
  },
};

function fixedClock(): { now: () => number; advance(ms: number): void } {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// ================================================================================================
// Push with leases.
// ================================================================================================

describe("push with leases", () => {
  it("pushes when the expected remote head matches (action pushed)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_B);
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(new Map([[CHANGE_ID, HEAD_SHA_A]])),
      now: clock.now,
    });

    const receipt = await push.push({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      jjChangeId: CHANGE_ID,
      expectedRemoteHeadSha: HEAD_SHA_B,
    });

    expect(receipt.action).toBe("pushed");
    expect(receipt.commitSha).toBe(HEAD_SHA_A);
    expect(receipt.remoteHeadSha).toBe(HEAD_SHA_A);
    expect(mock.refs.get("minions/node-1")).toBe(HEAD_SHA_A);
  });

  it("rejects on remote drift (expected head mismatch)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_A);
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(new Map([[CHANGE_ID, HEAD_SHA_A]])),
      now: clock.now,
    });

    await expect(
      push.push({
        repositoryFullName: REPO,
        bookmark: "minions/node-1",
        jjChangeId: CHANGE_ID,
        expectedRemoteHeadSha: HEAD_SHA_B,
      }),
    ).rejects.toMatchObject({ name: "PushError", code: "remote_drift" });

    // The remote must NOT have been overwritten (lease prevented the push).
    expect(mock.refs.get("minions/node-1")).toBe(HEAD_SHA_A);
  });

  it("rejects on drift when an expected branch is unexpectedly missing", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(new Map([[CHANGE_ID, HEAD_SHA_A]])),
      now: clock.now,
    });

    await expect(
      push.push({
        repositoryFullName: REPO,
        bookmark: "minions/node-1",
        jjChangeId: CHANGE_ID,
        expectedRemoteHeadSha: HEAD_SHA_B,
      }),
    ).rejects.toMatchObject({ code: "remote_drift" });
  });

  it("rejects on an unresolved conflict before touching the remote", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_B);
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({ auth, workingCopy: conflictWorkingCopy, now: clock.now });

    await expect(
      push.push({
        repositoryFullName: REPO,
        bookmark: "minions/node-1",
        jjChangeId: CHANGE_ID,
        expectedRemoteHeadSha: HEAD_SHA_B,
      }),
    ).rejects.toMatchObject({ code: "conflict_unresolved" });

    // No push happened: the ref is unchanged and no git-ref PATCH was recorded.
    expect(mock.refs.get("minions/node-1")).toBe(HEAD_SHA_B);
    expect(mock.records.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("is idempotent: re-pushing the same commit is a no-op", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_A);
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(new Map([[CHANGE_ID, HEAD_SHA_A]])),
      now: clock.now,
    });

    const receipt = await push.push({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      jjChangeId: CHANGE_ID,
      expectedRemoteHeadSha: HEAD_SHA_A,
    });

    expect(receipt.action).toBe("noop");
    expect(receipt.remoteHeadSha).toBe(HEAD_SHA_A);
    // No PATCH ref call — nothing was pushed.
    expect(mock.records.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("creates a brand-new remote branch when the lease expects none", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(new Map([[CHANGE_ID, HEAD_SHA_A]])),
      now: clock.now,
    });

    const receipt = await push.push({
      repositoryFullName: REPO,
      bookmark: "minions/node-new",
      jjChangeId: CHANGE_ID,
      expectedRemoteHeadSha: undefined,
    });

    expect(receipt.action).toBe("pushed");
    expect(mock.refs.get("minions/node-new")).toBe(HEAD_SHA_A);
  });

  it("maps a server-side lease rejection (422) to lease_expired", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_B);
    mock.leaseRejectNextUpdate = true;
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(new Map([[CHANGE_ID, HEAD_SHA_A]])),
      now: clock.now,
    });

    await expect(
      push.push({
        repositoryFullName: REPO,
        bookmark: "minions/node-1",
        jjChangeId: CHANGE_ID,
        expectedRemoteHeadSha: HEAD_SHA_B,
      }),
    ).rejects.toMatchObject({ code: "lease_expired" });
  });
});

// ================================================================================================
// createOrUpdatePR — one active PR per node (GIT-03).
// ================================================================================================

describe("createOrUpdatePR", () => {
  it("creates a PR when none exists", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_A);
    const auth = buildAuth(clock.now, mock);
    const manager = createPullRequestManager({ auth, botIdentity, now: clock.now });

    const receipt = await manager.createOrUpdatePR({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      baseBranch: "main",
      title: "Implement node 1",
      body: "Body",
      draft: false,
    });

    expect(receipt.action).toBe("created");
    expect(receipt.bookmark).toBe("minions/node-1");
    expect(receipt.baseBranch).toBe("main");
    expect(receipt.headSha).toBe(HEAD_SHA_A);
    expect(receipt.htmlUrl).toContain("/pull/");
  });

  it("updates the existing open PR for the head branch", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_A);
    mock.seedPull(prWire({ number: 42, branch: "minions/node-1", headSha: HEAD_SHA_A }));
    const auth = buildAuth(clock.now, mock);
    const manager = createPullRequestManager({ auth, botIdentity, now: clock.now });

    const receipt = await manager.createOrUpdatePR({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      baseBranch: "main",
      title: "Updated title",
      body: "Updated body",
      draft: false,
    });

    expect(receipt.action).toBe("updated");
    expect(receipt.prNumber).toBe(42);
    expect(receipt.title).toBe("Updated title");
    // Exactly one PR remains — no second PR was created.
    expect(mock.pulls.filter((pr) => pr.head.ref === "minions/node-1")).toHaveLength(1);
  });

  it("creates a new PR when the previous one is closed", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_A);
    mock.seedPull(
      prWire({ number: 7, branch: "minions/node-1", headSha: OLD_SHA, state: "closed" }),
    );
    const auth = buildAuth(clock.now, mock);
    const manager = createPullRequestManager({ auth, botIdentity, now: clock.now });

    const receipt = await manager.createOrUpdatePR({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      baseBranch: "main",
      title: "New PR after close",
      body: null,
      draft: false,
    });

    expect(receipt.action).toBe("created");
    expect(receipt.prNumber).not.toBe(7);
    // The closed PR is untouched; exactly one OPEN PR exists now.
    const open = mock.pulls.filter((pr) => pr.head.ref === "minions/node-1" && pr.state === "open");
    expect(open).toHaveLength(1);
  });

  it("rejects when multiple open PRs exist for the head branch", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.seedPull(prWire({ number: 11, branch: "minions/node-1", headSha: HEAD_SHA_A }));
    mock.seedPull(prWire({ number: 12, branch: "minions/node-1", headSha: HEAD_SHA_A }));
    const auth = buildAuth(clock.now, mock);
    const manager = createPullRequestManager({ auth, botIdentity, now: clock.now });

    await expect(
      manager.createOrUpdatePR({
        repositoryFullName: REPO,
        bookmark: "minions/node-1",
        baseBranch: "main",
        title: "t",
        body: null,
        draft: false,
      }),
    ).rejects.toMatchObject({ name: "PullRequestError", code: "multiple_open_prs" });
  });
});

// ================================================================================================
// observeReviewState — stale-approval detection (GIT-11).
// ================================================================================================

describe("observeReviewState", () => {
  function managerFor(mock: MockGitHub, clock: { now: () => number }): PullRequestManager {
    return createPullRequestManager({
      auth: buildAuth(clock.now, mock),
      botIdentity,
      now: clock.now,
    });
  }

  it("classifies a fresh human approval (on the current head) as approved", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.seedPull(prWire({ number: 5, branch: "minions/node-1", headSha: HEAD_SHA_A }));
    mock.reviewsByPr.set(5, [
      {
        id: 1,
        user: { id: 101, login: "human-reviewer", type: "User" },
        state: "APPROVED",
        submitted_at: "2026-01-02T00:00:00Z",
        commit_id: HEAD_SHA_A,
        author_association: "MEMBER",
      },
    ]);
    const observation = await managerFor(mock, clock).observeReviewState(REPO, 5);

    expect(observation.state).toBe("approved");
    expect(observation.headSha).toBe(HEAD_SHA_A);
    expect(observation.freshApprovals).toHaveLength(1);
    expect(observation.freshApprovals[0]?.userLogin).toBe("human-reviewer");
  });

  it("classifies a stale human approval (on an older commit) as stale", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.seedPull(prWire({ number: 5, branch: "minions/node-1", headSha: HEAD_SHA_A }));
    mock.reviewsByPr.set(5, [
      {
        id: 1,
        user: { id: 101, login: "human-reviewer", type: "User" },
        state: "APPROVED",
        submitted_at: "2026-01-01T00:00:00Z",
        commit_id: OLD_SHA,
        author_association: "MEMBER",
      },
    ]);
    const observation = await managerFor(mock, clock).observeReviewState(REPO, 5);

    expect(observation.state).toBe("stale");
    expect(observation.staleApprovals).toHaveLength(1);
    expect(observation.freshApprovals).toHaveLength(0);
  });

  it("treats the engine bot's approval as not eligible (bot)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.seedPull(prWire({ number: 5, branch: "minions/node-1", headSha: HEAD_SHA_A }));
    mock.reviewsByPr.set(5, [
      {
        id: 1,
        user: { id: BOT_USER_ID, login: BOT_LOGIN, type: "Bot" },
        state: "APPROVED",
        submitted_at: "2026-01-02T00:00:00Z",
        commit_id: HEAD_SHA_A,
        author_association: "MEMBER",
      },
    ]);
    const observation = await managerFor(mock, clock).observeReviewState(REPO, 5);

    expect(observation.state).toBe("bot");
    expect(observation.botApprovals).toHaveLength(1);
    expect(observation.freshApprovals).toHaveLength(0);
  });

  it("reports pending when there is no approval at all", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.seedPull(prWire({ number: 5, branch: "minions/node-1", headSha: HEAD_SHA_A }));
    mock.reviewsByPr.set(5, [
      {
        id: 1,
        user: { id: 101, login: "human-reviewer", type: "User" },
        state: "COMMENTED",
        submitted_at: "2026-01-02T00:00:00Z",
        commit_id: HEAD_SHA_A,
        author_association: "MEMBER",
      },
    ]);
    const observation = await managerFor(mock, clock).observeReviewState(REPO, 5);

    expect(observation.state).toBe("pending");
    expect(observation.freshApprovals).toHaveLength(0);
  });

  it("prefers a fresh human approval over a stale one and a bot approval", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.seedPull(prWire({ number: 5, branch: "minions/node-1", headSha: HEAD_SHA_A }));
    mock.reviewsByPr.set(5, [
      {
        id: 1,
        user: { id: 101, login: "human-reviewer", type: "User" },
        state: "APPROVED",
        submitted_at: "2026-01-01T00:00:00Z",
        commit_id: OLD_SHA,
        author_association: "MEMBER",
      },
      {
        id: 2,
        user: { id: BOT_USER_ID, login: BOT_LOGIN, type: "Bot" },
        state: "APPROVED",
        submitted_at: "2026-01-02T00:00:00Z",
        commit_id: HEAD_SHA_A,
        author_association: "MEMBER",
      },
      {
        id: 3,
        user: { id: 102, login: "human-reviewer-2", type: "User" },
        state: "APPROVED",
        submitted_at: "2026-01-03T00:00:00Z",
        commit_id: HEAD_SHA_A,
        author_association: "MEMBER",
      },
    ]);
    const observation = await managerFor(mock, clock).observeReviewState(REPO, 5);

    expect(observation.state).toBe("approved");
    expect(observation.freshApprovals).toHaveLength(1);
    expect(observation.staleApprovals).toHaveLength(1);
    expect(observation.botApprovals).toHaveLength(1);
  });

  it("fails closed when the PR does not exist", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    await expect(managerFor(mock, clock).observeReviewState(REPO, 999)).rejects.toMatchObject({
      code: "pr_not_found",
    });
  });
});

// ================================================================================================
// observeChecks.
// ================================================================================================

describe("observeChecks", () => {
  function managerFor(mock: MockGitHub, clock: { now: () => number }): PullRequestManager {
    return createPullRequestManager({
      auth: buildAuth(clock.now, mock),
      botIdentity,
      now: clock.now,
    });
  }

  function seedPrAtHead(mock: MockGitHub, headSha: GitSha): void {
    mock.seedPull(prWire({ number: 5, branch: "minions/node-1", headSha }));
  }

  it("reports pass when every check completed successfully", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedPrAtHead(mock, HEAD_SHA_A);
    mock.checkRunsByRef.set(HEAD_SHA_A, [
      {
        id: 1,
        name: "ci",
        head_sha: HEAD_SHA_A,
        status: "completed",
        conclusion: "success",
        started_at: null,
        completed_at: null,
      },
      {
        id: 2,
        name: "lint",
        head_sha: HEAD_SHA_A,
        status: "completed",
        conclusion: "neutral",
        started_at: null,
        completed_at: null,
      },
    ]);
    mock.combinedStatusByRef.set(HEAD_SHA_A, { state: "success", total_count: 0 });
    const observation = await managerFor(mock, clock).observeChecks(REPO, 5);

    expect(observation.state).toBe("pass");
    expect(observation.totalCheckRuns).toBe(2);
  });

  it("reports fail when any check failed", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedPrAtHead(mock, HEAD_SHA_A);
    mock.checkRunsByRef.set(HEAD_SHA_A, [
      {
        id: 1,
        name: "ci",
        head_sha: HEAD_SHA_A,
        status: "completed",
        conclusion: "success",
        started_at: null,
        completed_at: null,
      },
      {
        id: 2,
        name: "tests",
        head_sha: HEAD_SHA_A,
        status: "completed",
        conclusion: "failure",
        started_at: null,
        completed_at: null,
      },
    ]);
    mock.combinedStatusByRef.set(HEAD_SHA_A, { state: "failure", total_count: 1 });
    const observation = await managerFor(mock, clock).observeChecks(REPO, 5);

    expect(observation.state).toBe("fail");
    expect(observation.failingNames).toContain("tests");
  });

  it("reports pending when a check is still running", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedPrAtHead(mock, HEAD_SHA_A);
    mock.checkRunsByRef.set(HEAD_SHA_A, [
      {
        id: 1,
        name: "ci",
        head_sha: HEAD_SHA_A,
        status: "in_progress",
        conclusion: null,
        started_at: null,
        completed_at: null,
      },
    ]);
    mock.combinedStatusByRef.set(HEAD_SHA_A, { state: "pending", total_count: 0 });
    const observation = await managerFor(mock, clock).observeChecks(REPO, 5);

    expect(observation.state).toBe("pending");
    expect(observation.pendingNames).toContain("ci");
  });

  it("reports missing when there are no check runs and no statuses", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    seedPrAtHead(mock, HEAD_SHA_A);
    mock.combinedStatusByRef.set(HEAD_SHA_A, { state: "pending", total_count: 0 });
    const observation = await managerFor(mock, clock).observeChecks(REPO, 5);

    expect(observation.state).toBe("missing");
    expect(observation.totalCheckRuns).toBe(0);
  });
});

// ================================================================================================
// Crash recovery: push OK, PR create fails → retry → created.
// ================================================================================================

describe("crash recovery", () => {
  it("retries PR creation after a transient failure (idempotent createOrUpdatePR)", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(new Map([[CHANGE_ID, HEAD_SHA_A]])),
      now: clock.now,
    });
    const manager = createPullRequestManager({ auth, botIdentity, now: clock.now });

    // 1. Push succeeds.
    const receipt = await push.push({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      jjChangeId: CHANGE_ID,
      expectedRemoteHeadSha: undefined,
    });
    expect(receipt.action).toBe("pushed");

    // 2. First PR create crashes (transient server error).
    mock.failNextCreate = true;
    await expect(
      manager.createOrUpdatePR({
        repositoryFullName: REPO,
        bookmark: "minions/node-1",
        baseBranch: "main",
        title: "Crash recovery",
        body: null,
        draft: false,
      }),
    ).rejects.toMatchObject({ code: "create_failed" });

    // 3. Retry: no open PR exists yet → create succeeds, exactly one PR results.
    const prReceipt = await manager.createOrUpdatePR({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      baseBranch: "main",
      title: "Crash recovery",
      body: null,
      draft: false,
    });

    expect(prReceipt.action).toBe("created");
    const open = mock.pulls.filter((pr) => pr.head.ref === "minions/node-1" && pr.state === "open");
    expect(open).toHaveLength(1);
  });

  it("push then observe: idempotent re-push keeps the PR head stable", async () => {
    const clock = fixedClock();
    const mock = new MockGitHub(clock.now);
    mock.refs.set("minions/node-1", HEAD_SHA_A);
    const auth = buildAuth(clock.now, mock);
    const push = createPushManager({
      auth,
      workingCopy: workingCopyReturning(new Map([[CHANGE_ID, HEAD_SHA_A]])),
      now: clock.now,
    });
    const manager = createPullRequestManager({ auth, botIdentity, now: clock.now });

    const pr = await manager.createOrUpdatePR({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      baseBranch: "main",
      title: "Stable head",
      body: null,
      draft: false,
    });

    // Re-pushing the same commit is a no-op; the PR head does not move.
    const rePush = await push.push({
      repositoryFullName: REPO,
      bookmark: "minions/node-1",
      jjChangeId: CHANGE_ID,
      expectedRemoteHeadSha: HEAD_SHA_A,
    });
    expect(rePush.action).toBe("noop");
    expect(pr.headSha).toBe(HEAD_SHA_A);
  });
});
