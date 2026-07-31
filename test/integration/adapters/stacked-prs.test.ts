import {
  buildStackPath,
  contentHash,
  determineBaseBranch,
  determineBranchName,
  gitSha,
  retargetAfterLanding,
  shortIdentity,
  StackParentageError,
  type StackParentageErrorCode,
  type StackPosition,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  validateStackTopology,
  type ContentHash,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";
import {
  createGitHubClient,
  createStackParentageManager,
  type GitHubFetch,
  type StackParentageManager,
} from "@minions/adapters";
import { describe, expect, it } from "vitest";

/**
 * Integration test for PR 33: stacked-PR parentage. Drives the pure stack domain
 * directly and the stack-parentage manager against a MOCK GitHub REST API (no
 * real network): a stateful in-memory GitHub wired through the real
 * `createGitHubClient` + an in-memory vcs-change binding store.
 *
 * Coverage (from the brief):
 * - Deep chain (root → child → grandchild) + siblings: correct PR base targeting.
 * - Reject fan-in (a branch with two parents → error).
 * - Land/retarget in order: land parent → child retargets to grandparent/trunk.
 * - Sibling independence (landing one child does not affect the other).
 * - Deterministic branch naming (same tree+node → same branch).
 * - Native-Git/GitHub records recover the stack (branch/base names suffice).
 */

const REPO = "acme/landing-app";
const TRUNK = "main";
const HEAD_SHA = gitSha("a".repeat(40));
const BASE_SHA = gitSha("0".repeat(40));

// Distinct UUIDv7 identities — the random tails differ so the deterministic
// branch shorts never collide.
const TREE = taskTreeId("019f7fc4-cf05-7000-a005-6a342efae960");
const ALT_TREE = taskTreeId("019f7fc4-cf05-7000-a005-6a342efae970");
const ROOT = taskNodeId("019f7fc4-cf05-7001-a005-6a342efae961");
const CHILD_A = taskNodeId("019f7fc4-cf05-7002-a205-6a342efae962");
const CHILD_B = taskNodeId("019f7fc4-cf05-7003-a305-6a342efae963");
const GRANDCHILD_A = taskNodeId("019f7fc4-cf05-7004-a405-6a342efae964");
const SIBLING_ROOT = taskNodeId("019f7fc4-cf05-7005-a505-6a342efae965");

const CHANGE_ROOT = contentHash("11".repeat(32));
const CHANGE_CHILD_A = contentHash("22".repeat(32));
const CHANGE_CHILD_B = contentHash("33".repeat(32));
const CHANGE_GRANDCHILD_A = contentHash("44".repeat(32));

const rootBranch = determineBranchName(TREE, ROOT);
const childABranch = determineBranchName(TREE, CHILD_A);
const childBBranch = determineBranchName(TREE, CHILD_B);
const grandchildABranch = determineBranchName(TREE, GRANDCHILD_A);

// ================================================================================================
// Mock GitHub — routes the PR subset of the REST API this test exercises.
// ================================================================================================

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

function prWire(input: {
  number: number;
  branch: string;
  base: string;
  state?: "open" | "closed";
}): PrWire {
  return {
    number: input.number,
    title: `PR for ${input.branch}`,
    body: "stack body",
    state: input.state ?? "open",
    merged: false,
    draft: false,
    head: { ref: input.branch, sha: HEAD_SHA },
    base: { ref: input.base, sha: BASE_SHA },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${REPO}/pull/${String(input.number)}`,
  };
}

interface FetchRecord {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

class MockGitHub {
  readonly pulls: PrWire[] = [];
  readonly records: FetchRecord[] = [];

  seedPr(pr: PrWire): void {
    this.pulls.push(pr);
  }

  /** Current open PR for a branch, or undefined. */
  openPrFor(branch: string): PrWire | undefined {
    return this.pulls.find((pr) => pr.head.ref === branch && pr.state === "open");
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
    // GET /repos/{owner}/{repo}/pulls?state=...&head=owner:branch
    if (method === "GET" && /\/repos\/[^/]+\/[^/]+\/pulls(?:\?.*)?$/u.test(url)) {
      const query = new URL(url).searchParams;
      const state = query.get("state") ?? "open";
      const head = query.get("head");
      let branch: string | undefined;
      if (head !== null) {
        const colon = head.indexOf(":");
        branch = colon === -1 ? head : head.slice(colon + 1);
      }
      const filtered = this.pulls.filter(
        (pr) =>
          (state === "all" || pr.state === state) &&
          (branch === undefined || pr.head.ref === branch),
      );
      return this.jsonResponse(filtered);
    }

    // PATCH /repos/{owner}/{repo}/pulls/{number}
    const single = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/u.exec(url);
    if (method === "PATCH" && single !== null) {
      const number = Number.parseInt(single[1] ?? "", 10);
      const index = this.pulls.findIndex((pr) => pr.number === number);
      const current = index === -1 ? undefined : this.pulls[index];
      if (current === undefined) {
        return new Response("not found", { status: 404 });
      }
      const parsed = JSON.parse(body) as {
        base?: string;
        title?: string;
        state?: "open" | "closed";
      };
      const updated: PrWire = {
        ...current,
        title: parsed.title ?? current.title,
        base: { ...current.base, ref: parsed.base ?? current.base.ref },
        state: parsed.state ?? current.state,
        updated_at: "2026-01-02T00:00:00Z",
      };
      if (index !== -1) {
        this.pulls[index] = updated;
      }
      return this.jsonResponse(updated);
    }

    return new Response(`mock: unhandled ${method} ${url}`, { status: 500 });
  }
}

// ================================================================================================
// In-memory binding store (the VcsChangeBindingStore port, as a test double).
// ================================================================================================

class MemoryBindingStore implements VcsChangeBindingStore {
  private readonly rows = new Map<string, VcsChangeBinding>();

  upsertBinding(binding: VcsChangeBinding): Promise<void> {
    this.rows.set(`${binding.treeId}|${binding.nodeId}`, binding);
    return Promise.resolve();
  }

  getBinding(treeId: TaskTreeId, nodeId: TaskNodeId): Promise<VcsChangeBinding | undefined> {
    return Promise.resolve(this.rows.get(`${treeId}|${nodeId}`));
  }

  getByChangeId(
    treeId: TaskTreeId,
    jjChangeId: ContentHash,
  ): Promise<VcsChangeBinding | undefined> {
    return Promise.resolve(
      [...this.rows.values()].find((b) => b.treeId === treeId && b.jjChangeId === jjChangeId),
    );
  }

  listForTree(treeId: TaskTreeId): Promise<readonly VcsChangeBinding[]> {
    return Promise.resolve([...this.rows.values()].filter((b) => b.treeId === treeId));
  }

  async assertNoOrphans(treeId: TaskTreeId, knownNodeIds: readonly TaskNodeId[]): Promise<void> {
    const known = new Set(knownNodeIds);
    for (const binding of await this.listForTree(treeId)) {
      if (!known.has(binding.nodeId)) {
        throw new Error(`orphan binding for node '${binding.nodeId}'`);
      }
    }
  }

  async assertNoDuplicates(treeId: TaskTreeId): Promise<void> {
    const seen = new Set<string>();
    for (const binding of await this.listForTree(treeId)) {
      const key = `${binding.treeId}|${binding.nodeId}`;
      if (seen.has(key)) {
        throw new Error(`duplicate binding for '${key}'`);
      }
      seen.add(key);
    }
  }
}

function binding(input: {
  nodeId: TaskNodeId;
  changeId: ContentHash;
  parentChangeId?: ContentHash;
}): VcsChangeBinding {
  return Object.freeze({
    treeId: TREE,
    nodeId: input.nodeId,
    jjChangeId: input.changeId,
    currentCommitId: HEAD_SHA,
    parentChangeId: input.parentChangeId,
    bookmark: undefined,
    rewriteGeneration: 0,
    lastJjOperationId: contentHash("00".repeat(32)),
    lastPushedCommitId: undefined,
    lastReviewedCommitId: undefined,
    conflictState: "clean",
    recordedAt: timestampFromEpochMilliseconds(0),
  });
}

/** Full tree: root + two children (A, B) + grandchild under A. */
function fullTreeBindings(): readonly VcsChangeBinding[] {
  return [
    binding({ nodeId: ROOT, changeId: CHANGE_ROOT }),
    binding({ nodeId: CHILD_A, changeId: CHANGE_CHILD_A, parentChangeId: CHANGE_ROOT }),
    binding({ nodeId: CHILD_B, changeId: CHANGE_CHILD_B, parentChangeId: CHANGE_ROOT }),
    binding({
      nodeId: GRANDCHILD_A,
      changeId: CHANGE_GRANDCHILD_A,
      parentChangeId: CHANGE_CHILD_A,
    }),
  ];
}

/** Seed one open PR per branch with the given base map. */
function seedStackPrs(mock: MockGitHub, baseByBranch: ReadonlyMap<string, string>): void {
  let number = 100;
  for (const [branch, base] of baseByBranch) {
    mock.seedPr(prWire({ number, branch, base }));
    number += 1;
  }
}

function buildManager(mock: MockGitHub, store: VcsChangeBindingStore): StackParentageManager {
  const client = createGitHubClient({
    token: "ghs_test",
    fetch: mock.fetch,
    baseUrl: "https://api.github.com",
  });
  return createStackParentageManager({
    client,
    bindingStore: store,
    repositoryFullName: REPO,
    trunk: TRUNK,
  });
}

function expectStackError(fn: () => unknown, code: StackParentageErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StackParentageError);
    expect((error as StackParentageError).code).toBe(code);
    return;
  }
  throw new Error(`expected StackParentageError('${code}') to be thrown, but nothing threw`);
}

// ================================================================================================
// Pure domain.
// ================================================================================================

describe("stack-parentage domain", () => {
  it("names branches deterministically from the tree+node identity", () => {
    expect(determineBranchName(TREE, CHILD_A)).toBe(determineBranchName(TREE, CHILD_A));
    expect(determineBranchName(TREE, CHILD_A)).not.toBe(determineBranchName(TREE, CHILD_B));
    expect(determineBranchName(TREE, CHILD_A)).not.toBe(determineBranchName(ALT_TREE, CHILD_A));
    // Shape: minions/<treeShort>/<nodeShort>, slash-separated hex.
    expect(determineBranchName(TREE, ROOT)).toMatch(/^minions\/[0-9a-f]+\/[0-9a-f]+$/u);
  });

  it("derives the base from the parent (or the trunk for roots)", () => {
    expect(determineBaseBranch(TREE, ROOT, null, TRUNK)).toBe(TRUNK);
    expect(determineBaseBranch(TREE, CHILD_A, ROOT, TRUNK)).toBe(rootBranch);
    // Default trunk when none is supplied.
    expect(determineBaseBranch(TREE, ROOT, null)).toBe("main");
  });

  it("derives collision-resistant shorts even for same-millisecond identities", () => {
    // ROOT and SIBLING_ROOT share their timestamp prefix (first 12 hex) but differ
    // in the random tail — the tail-based short must still distinguish them.
    const compact = (id: string): string => id.replaceAll("-", "");
    const sharedPrefix = compact(ROOT).slice(0, 12);
    expect(compact(SIBLING_ROOT).slice(0, 12)).toBe(sharedPrefix);
    expect(shortIdentity(ROOT, 12)).not.toBe(shortIdentity(SIBLING_ROOT, 12));
  });

  it("builds a deep chain rooted on the trunk with correct base targeting", () => {
    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [ROOT] },
      { treeId: TREE, nodeId: GRANDCHILD_A, parentIds: [CHILD_A] },
    ];
    const positions = buildStackPath(nodes, TRUNK);

    expect(positions).toHaveLength(3);
    expect(positions[0]?.nodeId).toBe(ROOT); // root-first ordering
    expect(positions[2]?.nodeId).toBe(GRANDCHILD_A);

    const byNode = new Map(positions.map((p) => [p.nodeId, p] as const));
    expect(byNode.get(ROOT)?.depth).toBe(0);
    expect(byNode.get(ROOT)?.baseBranch).toBe(TRUNK);
    expect(byNode.get(ROOT)?.branch).toBe(rootBranch);
    expect(byNode.get(CHILD_A)?.depth).toBe(1);
    expect(byNode.get(CHILD_A)?.baseBranch).toBe(rootBranch);
    expect(byNode.get(GRANDCHILD_A)?.depth).toBe(2);
    expect(byNode.get(GRANDCHILD_A)?.baseBranch).toBe(childABranch);
  });

  it("keeps siblings independent: same parent, distinct branches, same depth", () => {
    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [ROOT] },
      { treeId: TREE, nodeId: CHILD_B, parentIds: [ROOT] },
    ];
    const positions = buildStackPath(nodes, TRUNK);
    const byNode = new Map(positions.map((p) => [p.nodeId, p] as const));

    expect(byNode.get(CHILD_A)?.branch).not.toBe(byNode.get(CHILD_B)?.branch);
    expect(byNode.get(CHILD_A)?.depth).toBe(1);
    expect(byNode.get(CHILD_B)?.depth).toBe(1);
    expect(byNode.get(CHILD_A)?.baseBranch).toBe(rootBranch);
    expect(byNode.get(CHILD_B)?.baseBranch).toBe(rootBranch);
  });

  it("rejects fan-in (a node with two parents)", () => {
    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: GRANDCHILD_A, parentIds: [ROOT, CHILD_A] },
    ];
    expectStackError(() => buildStackPath(nodes, TRUNK), "fan_in");
  });

  it("rejects a node whose parent is absent from the stack (orphan)", () => {
    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [GRANDCHILD_A] }, // GRANDCHILD_A not in set
    ];
    expectStackError(() => buildStackPath(nodes, TRUNK), "orphan");
  });

  it("rejects a duplicate branch name (the fan-in surface)", () => {
    const positions: readonly StackPosition[] = [
      { treeId: TREE, nodeId: ROOT, branch: rootBranch, baseBranch: TRUNK, depth: 0 },
      { treeId: TREE, nodeId: CHILD_A, branch: rootBranch, baseBranch: TRUNK, depth: 0 },
    ];
    expectStackError(() => {
      validateStackTopology(positions, TRUNK);
    }, "duplicate_branch");
  });

  it("rejects an orphan base that resolves to neither trunk nor a stack branch", () => {
    const positions: readonly StackPosition[] = [
      { treeId: TREE, nodeId: ROOT, branch: rootBranch, baseBranch: TRUNK, depth: 0 },
      {
        treeId: TREE,
        nodeId: CHILD_A,
        branch: childABranch,
        baseBranch: "minions/dead/beef",
        depth: 1,
      },
    ];
    expectStackError(() => {
      validateStackTopology(positions, TRUNK);
    }, "orphan");
  });

  it("rejects a cycle in the base chain", () => {
    const positions: readonly StackPosition[] = [
      { treeId: TREE, nodeId: ROOT, branch: rootBranch, baseBranch: childABranch, depth: 0 },
      { treeId: TREE, nodeId: CHILD_A, branch: childABranch, baseBranch: rootBranch, depth: 0 },
    ];
    expectStackError(() => {
      validateStackTopology(positions, TRUNK);
    }, "cycle");
  });

  it("retargets a child to its grandparent when the parent lands", () => {
    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [ROOT] },
      { treeId: TREE, nodeId: GRANDCHILD_A, parentIds: [CHILD_A] },
    ];
    // Land CHILD_A → GRANDCHILD_A repoints at ROOT's branch (the grandparent).
    const plan = retargetAfterLanding(CHILD_A, GRANDCHILD_A, nodes, TRUNK);
    expect(plan.childNodeId).toBe(GRANDCHILD_A);
    expect(plan.newBaseBranch).toBe(rootBranch);
    expect(plan.previousBaseBranch).toBe(childABranch);

    // Land ROOT → CHILD_A repoints at the trunk.
    const rootPlan = retargetAfterLanding(ROOT, CHILD_A, nodes, TRUNK);
    expect(rootPlan.newBaseBranch).toBe(TRUNK);
    expect(rootPlan.previousBaseBranch).toBe(rootBranch);
  });

  it("refuses a retarget when the child is not a child of the landed node", () => {
    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [ROOT] },
      { treeId: TREE, nodeId: CHILD_B, parentIds: [ROOT] },
    ];
    expectStackError(() => retargetAfterLanding(CHILD_A, CHILD_B, nodes, TRUNK), "invalid_input");
  });
});

// ================================================================================================
// Stack-parentage manager (adapter against the mock GitHub API).
// ================================================================================================

describe("stack-parentage manager", () => {
  it("ensureStackParentage retargets drifted PR bases onto the correct parent", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    // Seed every PR with the WRONG base (trunk) — the stack is flat on GitHub.
    seedStackPrs(
      mock,
      new Map([
        [rootBranch, TRUNK],
        [childABranch, TRUNK],
        [childBBranch, TRUNK],
        [grandchildABranch, TRUNK],
      ]),
    );
    const manager = buildManager(mock, store);

    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [ROOT] },
      { treeId: TREE, nodeId: CHILD_B, parentIds: [ROOT] },
      { treeId: TREE, nodeId: GRANDCHILD_A, parentIds: [CHILD_A] },
    ];
    const positions = await manager.ensureStackParentage(TREE, nodes);

    expect(positions).toHaveLength(4);
    // Root stays on the trunk; children stack on root; grandchild on child A.
    expect(mock.openPrFor(rootBranch)?.base.ref).toBe(TRUNK);
    expect(mock.openPrFor(childABranch)?.base.ref).toBe(rootBranch);
    expect(mock.openPrFor(childBBranch)?.base.ref).toBe(rootBranch);
    expect(mock.openPrFor(grandchildABranch)?.base.ref).toBe(childABranch);
  });

  it("ensureStackParentage leaves correctly-targeted PRs untouched", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    seedStackPrs(
      mock,
      new Map([
        [rootBranch, TRUNK],
        [childABranch, rootBranch],
        [grandchildABranch, childABranch],
      ]),
    );
    const manager = buildManager(mock, store);

    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [ROOT] },
      { treeId: TREE, nodeId: GRANDCHILD_A, parentIds: [CHILD_A] },
    ];
    await manager.ensureStackParentage(TREE, nodes);

    // No PATCH (retarget) calls issued — every base was already correct.
    const patches = mock.records.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(0);
  });

  it("verifyNoFanIn accepts a consistent stack", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    for (const b of fullTreeBindings()) {
      await store.upsertBinding(b);
    }
    seedStackPrs(
      mock,
      new Map([
        [rootBranch, TRUNK],
        [childABranch, rootBranch],
        [childBBranch, rootBranch],
        [grandchildABranch, childABranch],
      ]),
    );
    const manager = buildManager(mock, store);

    await expect(manager.verifyNoFanIn(TREE)).resolves.toBeUndefined();
  });

  it("verifyNoFanIn rejects a base retargeted onto another stack branch (fan-in)", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    for (const b of fullTreeBindings()) {
      await store.upsertBinding(b);
    }
    seedStackPrs(
      mock,
      new Map([
        [rootBranch, TRUNK],
        // Child A now targets the GRANDCHILD's branch — a second parent in-stack.
        [childABranch, grandchildABranch],
        [childBBranch, rootBranch],
        [grandchildABranch, childABranch],
      ]),
    );
    const manager = buildManager(mock, store);

    await expect(manager.verifyNoFanIn(TREE)).rejects.toMatchObject({
      name: "StackParentageError",
      code: "fan_in",
    });
  });

  it("verifyNoFanIn rejects a base drifted off the stack", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    for (const b of fullTreeBindings()) {
      await store.upsertBinding(b);
    }
    seedStackPrs(
      mock,
      new Map([
        [rootBranch, TRUNK],
        [childABranch, "feature/unrelated"],
        [childBBranch, rootBranch],
        [grandchildABranch, childABranch],
      ]),
    );
    const manager = buildManager(mock, store);

    await expect(manager.verifyNoFanIn(TREE)).rejects.toMatchObject({
      name: "StackParentageError",
      code: "drift",
    });
  });

  it("retargetAfterParentLanding moves children to the grandparent and leaves siblings alone", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    for (const b of fullTreeBindings()) {
      await store.upsertBinding(b);
    }
    seedStackPrs(
      mock,
      new Map([
        [rootBranch, TRUNK],
        [childABranch, rootBranch],
        [childBBranch, rootBranch],
        [grandchildABranch, childABranch],
      ]),
    );
    const manager = buildManager(mock, store);

    // Land CHILD_A → its only child (GRANDCHILD_A) repoints at ROOT's branch.
    const plans = await manager.retargetAfterParentLanding(TREE, CHILD_A);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.childNodeId).toBe(GRANDCHILD_A);
    expect(plans[0]?.newBaseBranch).toBe(rootBranch);
    // Sibling CHILD_B and the landed CHILD_A itself are untouched.
    expect(mock.openPrFor(childBBranch)?.base.ref).toBe(rootBranch);
    expect(mock.openPrFor(childABranch)?.base.ref).toBe(rootBranch);
    expect(mock.openPrFor(grandchildABranch)?.base.ref).toBe(rootBranch);
  });

  it("parent-before-child: landing the root retargets only direct children, not grandchildren", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    for (const b of fullTreeBindings()) {
      await store.upsertBinding(b);
    }
    seedStackPrs(
      mock,
      new Map([
        [rootBranch, TRUNK],
        [childABranch, rootBranch],
        [childBBranch, rootBranch],
        [grandchildABranch, childABranch],
      ]),
    );
    const manager = buildManager(mock, store);

    // Land ROOT → direct children (A, B) repoint at the trunk.
    const plans = await manager.retargetAfterParentLanding(TREE, ROOT);
    expect(plans.map((p) => p.childNodeId).sort()).toEqual([CHILD_A, CHILD_B].sort());
    expect(plans.every((p) => p.newBaseBranch === TRUNK)).toBe(true);
    // The grandchild is NOT a direct child of ROOT — it waits for CHILD_A to land.
    expect(mock.openPrFor(grandchildABranch)?.base.ref).toBe(childABranch);
    expect(mock.openPrFor(childABranch)?.base.ref).toBe(TRUNK);
    expect(mock.openPrFor(childBBranch)?.base.ref).toBe(TRUNK);
  });

  it("native Git/GitHub records recover the stack with no metadata", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    // Seed a flat, drifted stack and let ensureStackParentage repair the bases.
    seedStackPrs(
      mock,
      new Map([
        [rootBranch, TRUNK],
        [childABranch, TRUNK],
        [childBBranch, TRUNK],
        [grandchildABranch, TRUNK],
      ]),
    );
    const manager = buildManager(mock, store);

    const nodes = [
      { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      { treeId: TREE, nodeId: CHILD_A, parentIds: [ROOT] },
      { treeId: TREE, nodeId: CHILD_B, parentIds: [ROOT] },
      { treeId: TREE, nodeId: GRANDCHILD_A, parentIds: [CHILD_A] },
    ];
    await manager.ensureStackParentage(TREE, nodes);

    // Reconstruct parentage purely from branch/base names (what git/GitHub hold).
    const baseByBranch = new Map<string, string>();
    const headsByBase = new Map<string, Set<string>>();
    for (const pr of mock.pulls) {
      if (pr.state !== "open") {
        continue;
      }
      baseByBranch.set(pr.head.ref, pr.base.ref);
      const heads = headsByBase.get(pr.base.ref) ?? new Set<string>();
      heads.add(pr.head.ref);
      headsByBase.set(pr.base.ref, heads);
    }

    // Each branch's expected base (from the domain) matches the recovered record.
    expect(baseByBranch.get(rootBranch)).toBe(TRUNK);
    expect(baseByBranch.get(childABranch)).toBe(rootBranch);
    expect(baseByBranch.get(childBBranch)).toBe(rootBranch);
    expect(baseByBranch.get(grandchildABranch)).toBe(childABranch);
    // One parent per branch, recoverable: the root branch is the parent of both
    // children; the grandchild's parent is child A; the trunk roots the stack.
    expect(headsByBase.get(TRUNK)).toEqual(new Set([rootBranch]));
    expect(headsByBase.get(rootBranch)).toEqual(new Set([childABranch, childBBranch]));
    expect(headsByBase.get(childABranch)).toEqual(new Set([grandchildABranch]));
  });

  it("ensureStackParentage rejects nodes from a different tree", async () => {
    const mock = new MockGitHub();
    const store = new MemoryBindingStore();
    const manager = buildManager(mock, store);
    const otherTree = taskTreeId("019f7fc4-cf05-7000-a005-6a342efae970");

    await expect(
      manager.ensureStackParentage(otherTree, [
        { treeId: TREE, nodeId: ROOT, parentIds: [] as readonly TaskNodeId[] },
      ]),
    ).rejects.toMatchObject({ name: "StackParentageError", code: "invalid_input" });
  });
});
