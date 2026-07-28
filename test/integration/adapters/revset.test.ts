import {
  contentHash,
  gitSha,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  buildRevsetExpression,
  filterBindings,
  EMPTY_REVSET,
  type ContentHash,
  type GitSha,
  type TaskNodeId,
  type VcsChangeBinding,
} from "@minions/core";
import {
  createRevsetManager,
  createSqliteVcsChangeBindingStore,
  type NodeImpact,
  type NodeReadiness,
  type RevsetJjRunResult,
  type RevsetJjRunner,
} from "@minions/adapters";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * PR 38 — scoped revset queries.
 *
 * The binding store is the real SQLite implementation (PR 29); the jj binary is
 * a test double (`runJj`) that returns the change ids a revset "would" match.
 * The double never needs to parse jj semantics: the binding table is the
 * topology authority, so a double returning the tree's change ids makes
 * {@link filterBindings} do the real work, and {@link createRevsetManager}'s
 * cross-check confirms every result binding against the binding table
 * (results match bindings) and never escapes the registered tree.
 */

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TREE_A = taskTreeId("01900000-0000-7000-8000-000000000038");
const TREE_B = taskTreeId("01900000-0000-7000-8000-000000000039");

const ROOT_NODE = taskNodeId("01900000-0000-7000-8000-0000000000a0");
const CHILD_NODE = taskNodeId("01900000-0000-7000-8000-0000000000a1");
const GRANDCHILD_NODE = taskNodeId("01900000-0000-7000-8000-0000000000a2");
const LEAF_NODE = taskNodeId("01900000-0000-7000-8000-0000000000a3");
const SIBLING_NODE = taskNodeId("01900000-0000-7000-8000-0000000000a4");
const OTHER_TREE_NODE = taskNodeId("01900000-0000-7000-8000-0000000000b0");

/** Repeat a numeric seed's hex unit to exactly `length` lowercase-hex chars. */
function hexRun(seed: number, length: number): string {
  const unit = (seed % 256).toString(16).padStart(2, "0");
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

const change = (seed: number): ContentHash => contentHash(hexRun(seed, 64));
const op = (seed: number): ContentHash => contentHash(hexRun(seed + 64, 64));
const commit = (seed: number): GitSha => gitSha(hexRun(seed, 40));

// Distinct jj change ids per node (the binding's jjChangeId, a 64-hex digest).
const ROOT_CHANGE = change(1);
const CHILD_CHANGE = change(2);
const GRANDCHILD_CHANGE = change(3);
const LEAF_CHANGE = change(4);
const SIBLING_CHANGE = change(5);
const OTHER_TREE_CHANGE = change(6);

// All TREE_A change ids; the double returns these for a "fully confirming" jj.
const TREE_A_CHANGES: readonly string[] = [
  ROOT_CHANGE,
  CHILD_CHANGE,
  GRANDCHILD_CHANGE,
  LEAF_CHANGE,
  SIBLING_CHANGE,
];

/*
 * Topology under test:
 *
 *   ROOT ─┬─ CHILD ── GRANDCHILD ── LEAF        (head)
 *         └─ SIBLING                            (head, conflicted, not-pushed, bookmarked)
 *
 * GRANDCHILD carries a stale push so readyToLand ancestry propagation is
 * observable. A second tree (TREE_B) holds a distinct node to prove scoping.
 */

type BindingOverrides = Partial<Omit<VcsChangeBinding, "treeId" | "nodeId">>;

function bindingA(nodeId: TaskNodeId, overrides: BindingOverrides = {}): VcsChangeBinding {
  return Object.freeze({
    treeId: TREE_A,
    nodeId,
    jjChangeId: ROOT_CHANGE,
    currentCommitId: commit(1),
    parentChangeId: undefined,
    bookmark: undefined,
    rewriteGeneration: 0,
    lastJjOperationId: op(1),
    lastPushedCommitId: undefined,
    lastReviewedCommitId: undefined,
    conflictState: "clean",
    recordedAt: timestampFromEpochMilliseconds(BASE_TIME),
    ...overrides,
  });
}

const ROOT_BINDING: VcsChangeBinding = bindingA(ROOT_NODE, {
  jjChangeId: ROOT_CHANGE,
  currentCommitId: commit(1),
  parentChangeId: undefined,
  bookmark: "stack/root",
  lastPushedCommitId: commit(1),
  lastReviewedCommitId: commit(1),
});

const TREE_A_BINDINGS: readonly VcsChangeBinding[] = [
  ROOT_BINDING,
  bindingA(CHILD_NODE, {
    jjChangeId: CHILD_CHANGE,
    currentCommitId: commit(2),
    parentChangeId: ROOT_CHANGE,
    lastPushedCommitId: commit(2),
    lastReviewedCommitId: commit(2),
  }),
  bindingA(GRANDCHILD_NODE, {
    jjChangeId: GRANDCHILD_CHANGE,
    currentCommitId: commit(31),
    parentChangeId: CHILD_CHANGE,
    lastPushedCommitId: commit(3), // stale: pushed an older commit
    lastReviewedCommitId: commit(31),
  }),
  bindingA(LEAF_NODE, {
    jjChangeId: LEAF_CHANGE,
    currentCommitId: commit(4),
    parentChangeId: GRANDCHILD_CHANGE,
    lastPushedCommitId: commit(4),
    lastReviewedCommitId: commit(4),
  }),
  bindingA(SIBLING_NODE, {
    jjChangeId: SIBLING_CHANGE,
    currentCommitId: commit(5),
    parentChangeId: ROOT_CHANGE,
    bookmark: "stack/sibling",
    lastPushedCommitId: undefined, // not pushed
    lastReviewedCommitId: undefined, // not reviewed
    conflictState: "conflict",
  }),
];

const TREE_B_BINDING: VcsChangeBinding = Object.freeze({
  treeId: TREE_B,
  nodeId: OTHER_TREE_NODE,
  jjChangeId: OTHER_TREE_CHANGE,
  currentCommitId: commit(6),
  parentChangeId: undefined,
  bookmark: "stack/other",
  rewriteGeneration: 0,
  lastJjOperationId: op(6),
  lastPushedCommitId: commit(6),
  lastReviewedCommitId: commit(6),
  conflictState: "clean",
  recordedAt: timestampFromEpochMilliseconds(BASE_TIME),
});

// -------------------------------------------------------------------------------------------------
// Harness: fresh host database + real binding store per test.
// -------------------------------------------------------------------------------------------------

const clock = new FixedClock(timestampFromEpochMilliseconds(BASE_TIME));

let temporary: TemporarySqliteDatabase | undefined;

beforeEach(async () => {
  temporary = await TemporarySqliteDatabase.create("host", clock);
  const store = createSqliteVcsChangeBindingStore({ database: temporary.database });
  for (const b of TREE_A_BINDINGS) {
    await store.upsertBinding(b);
  }
  await store.upsertBinding(TREE_B_BINDING);
});

afterEach(async () => {
  await temporary?.dispose();
  temporary = undefined;
});

/** A double that returns the seeded change ids for any `jj log` revset. */
function fakeRunner(changeIds: readonly string[]): RevsetJjRunner {
  return () =>
    Promise.resolve<RevsetJjRunResult>({
      exitCode: 0,
      stdout: `${changeIds.join("\n")}\n`,
      stderr: "",
    });
}
function manager(changeIds: readonly string[] = TREE_A_CHANGES) {
  if (temporary === undefined) {
    throw new Error("test database not initialized");
  }
  return createRevsetManager({
    jjBinaryPath: "/nonexistent/jj",
    workingCopyPath: "/nonexistent/repo",
    bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
    runJj: fakeRunner(changeIds),
  });
}

/** Ids helper for compact assertions. */
function nodeIdsOf(bindings: readonly VcsChangeBinding[]): string[] {
  return bindings.map((b) => b.nodeId);
}

// -------------------------------------------------------------------------------------------------
// Tests.
// -------------------------------------------------------------------------------------------------

describe("revset manager: descendants query", () => {
  it("returns the scope node and every transitive descendant", async () => {
    const result = await manager().execute({
      treeId: TREE_A,
      kind: "descendants",
      scopeNodeId: ROOT_NODE,
    });
    expect(result.bindings.map((b) => b.nodeId).sort()).toEqual(
      [ROOT_NODE, CHILD_NODE, GRANDCHILD_NODE, LEAF_NODE, SIBLING_NODE].sort(),
    );
    // Every change id has a binding; every binding's change id is listed.
    expect([...result.changeIds].sort()).toEqual(result.bindings.map((b) => b.jjChangeId).sort());
  });

  it("scopes to the subtree under the given node", async () => {
    const result = await manager().execute({
      treeId: TREE_A,
      kind: "descendants",
      scopeNodeId: CHILD_NODE,
    });
    expect(nodeIdsOf(result.bindings).sort()).toEqual(
      [CHILD_NODE, GRANDCHILD_NODE, LEAF_NODE].sort(),
    );
  });
});

describe("revset manager: ancestors query", () => {
  it("walks parentChangeId up to the root", async () => {
    const result = await manager().execute({
      treeId: TREE_A,
      kind: "ancestors",
      scopeNodeId: LEAF_NODE,
    });
    expect(nodeIdsOf(result.bindings)).toEqual([LEAF_NODE, GRANDCHILD_NODE, CHILD_NODE, ROOT_NODE]);
  });
});

describe("revset manager: heads query", () => {
  it("returns only leaf bindings (no children)", async () => {
    const result = await manager().execute({ treeId: TREE_A, kind: "heads" });
    expect(nodeIdsOf(result.bindings).sort()).toEqual([LEAF_NODE, SIBLING_NODE].sort());
  });
});

describe("revset manager: conflicted query", () => {
  it("returns only conflicted bindings", async () => {
    const result = await manager().execute({ treeId: TREE_A, kind: "conflicted" });
    expect(nodeIdsOf(result.bindings)).toEqual([SIBLING_NODE]);
  });
});

describe("revset manager: not_pushed query", () => {
  it("returns only unpushed bindings", async () => {
    const result = await manager().execute({ treeId: TREE_A, kind: "not_pushed" });
    expect(nodeIdsOf(result.bindings)).toEqual([SIBLING_NODE]);
  });
});

describe("revset manager: bookmarked query", () => {
  it("returns only bindings carrying a bookmark", async () => {
    const result = await manager().execute({ treeId: TREE_A, kind: "bookmarked" });
    expect(nodeIdsOf(result.bindings).sort()).toEqual([ROOT_NODE, SIBLING_NODE].sort());
  });
});

describe("revset manager: scoping (queries cannot escape the registered tree)", () => {
  it("never returns another tree's bindings", async () => {
    // Even a double that "confirms" every change id (including the other tree)
    // cannot surface TREE_B: listForTree(TREE_A) excludes it.
    const result = await manager([...TREE_A_CHANGES, OTHER_TREE_CHANGE]).execute({
      treeId: TREE_A,
      kind: "descendants",
      scopeNodeId: ROOT_NODE,
    });
    expect(result.bindings.some((b) => b.treeId === TREE_B)).toBe(false);
    expect(result.bindings.some((b) => b.nodeId === OTHER_TREE_NODE)).toBe(false);
  });

  it("resolves a scope node bound to another tree as an empty result", async () => {
    const result = await manager().execute({
      treeId: TREE_A,
      kind: "descendants",
      scopeNodeId: OTHER_TREE_NODE,
    });
    expect(result.bindings).toEqual([]);
    expect(result.changeIds).toEqual([]);
  });

  it("a cross-tree query lists only that tree's bindings", async () => {
    const result = await manager([OTHER_TREE_CHANGE]).execute({
      treeId: TREE_B,
      kind: "heads",
    });
    expect(nodeIdsOf(result.bindings)).toEqual([OTHER_TREE_NODE]);
  });
});

describe("revset manager: results match the binding table", () => {
  it("drops jj change ids that have no binding in the tree (cross-check)", async () => {
    const foreign = change(99);
    const result = await manager([...TREE_A_CHANGES, foreign]).execute({
      treeId: TREE_A,
      kind: "heads",
    });
    expect(result.changeIds).not.toContain(foreign);
    expect(result.bindings.every((b) => b.treeId === TREE_A)).toBe(true);
  });

  it("drops bindings the live jj answer did not confirm", async () => {
    // Double confirms only ROOT + CHILD; the heads filter {LEAF, SIBLING} is
    // therefore empty after the cross-check.
    const result = await manager([ROOT_CHANGE, CHILD_CHANGE]).execute({
      treeId: TREE_A,
      kind: "heads",
    });
    expect(result.bindings).toEqual([]);
    expect(result.changeIds).toEqual([]);
  });
});

describe("revset manager: stackImpact", () => {
  it("reports per-node descendant impact from the binding topology", async () => {
    const impacts = await manager().stackImpact(TREE_A);
    const byNode = new Map<string, NodeImpact>(impacts.map((i) => [i.nodeId, i]));

    const root = byNode.get(ROOT_NODE);
    expect(root?.impactedCount).toBe(4);
    expect([...(root?.descendantNodeIds ?? [])].sort()).toEqual(
      [CHILD_NODE, GRANDCHILD_NODE, LEAF_NODE, SIBLING_NODE].sort(),
    );

    expect(byNode.get(CHILD_NODE)?.impactedCount).toBe(2);
    expect(byNode.get(GRANDCHILD_NODE)?.impactedCount).toBe(1);
    expect(byNode.get(LEAF_NODE)?.impactedCount).toBe(0);
    expect(byNode.get(SIBLING_NODE)?.impactedCount).toBe(0);
  });

  it("is scoped to the requested tree", async () => {
    const impacts = await manager().stackImpact(TREE_B);
    expect(impacts.map((i) => i.nodeId)).toEqual([OTHER_TREE_NODE]);
  });
});

describe("revset manager: readyToLand", () => {
  it("flags only clean, pushed, reviewed nodes with clean ancestry", async () => {
    const readiness = await manager().readyToLand(TREE_A);
    const byNode = new Map<string, NodeReadiness>(readiness.map((r) => [r.nodeId, r]));

    expect(byNode.get(ROOT_NODE)?.ready).toBe(true);
    expect(byNode.get(CHILD_NODE)?.ready).toBe(true);

    // GRANDCHILD has a stale push (pushed commit(3), current commit(31)).
    const grand = byNode.get(GRANDCHILD_NODE);
    expect(grand?.ready).toBe(false);
    expect(grand?.blockers).toContain("pushed_commit_stale");

    // LEAF itself is clean/pushed/reviewed, but its ancestor GRANDCHILD is not
    // current, so clean ancestry fails and it is not ready.
    const leaf = byNode.get(LEAF_NODE);
    expect(leaf?.ready).toBe(false);
    expect(leaf?.blockers).toContain(`ancestor_not_current:${GRANDCHILD_NODE}`);

    // SIBLING fails every gate.
    const sibling = byNode.get(SIBLING_NODE);
    expect(sibling?.ready).toBe(false);
    expect(sibling?.blockers).toContain("not_pushed");
    expect(sibling?.blockers).toContain("not_reviewed");
    expect(sibling?.blockers).toContain("conflict_state_conflict");
  });
});

// -------------------------------------------------------------------------------------------------
// Pure domain: expression builder + binding filter (no I/O).
// -------------------------------------------------------------------------------------------------

describe("revset domain: buildRevsetExpression is tree-scoped", () => {
  it("intersects descendants/ancestors with the tree change-id set", () => {
    const treeChangeIds = [ROOT_CHANGE, CHILD_CHANGE];
    expect(
      buildRevsetExpression(
        { treeId: TREE_A, kind: "descendants", scopeNodeId: ROOT_NODE },
        { treeChangeIds, scopeChangeId: ROOT_CHANGE },
      ),
    ).toBe(`descendants(${ROOT_CHANGE}) & (${ROOT_CHANGE}) | (${CHILD_CHANGE})`);
    expect(
      buildRevsetExpression(
        { treeId: TREE_A, kind: "ancestors", scopeNodeId: CHILD_NODE },
        { treeChangeIds, scopeChangeId: CHILD_CHANGE },
      ),
    ).toBe(`ancestors(${CHILD_CHANGE}) & (${ROOT_CHANGE}) | (${CHILD_CHANGE})`);
  });

  it("reduces an empty tree to the empty revset", () => {
    expect(buildRevsetExpression({ treeId: TREE_A, kind: "heads" }, { treeChangeIds: [] })).toBe(
      `heads(${EMPTY_REVSET})`,
    );
    expect(
      buildRevsetExpression({ treeId: TREE_A, kind: "not_pushed" }, { treeChangeIds: [] }),
    ).toBe(EMPTY_REVSET);
  });

  it("requires a scope change id for descendants/ancestors", () => {
    expect(() =>
      buildRevsetExpression(
        { treeId: TREE_A, kind: "descendants" },
        { treeChangeIds: [ROOT_CHANGE] },
      ),
    ).toThrow();
  });
});

describe("revset domain: filterBindings topology", () => {
  it("recovers descendants/ancestors/heads from parentChangeId", () => {
    expect(
      nodeIdsOf(
        filterBindings(TREE_A_BINDINGS, {
          treeId: TREE_A,
          kind: "descendants",
          scopeNodeId: CHILD_NODE,
        }),
      ).sort(),
    ).toEqual([CHILD_NODE, GRANDCHILD_NODE, LEAF_NODE].sort());
    expect(
      nodeIdsOf(
        filterBindings(TREE_A_BINDINGS, {
          treeId: TREE_A,
          kind: "ancestors",
          scopeNodeId: LEAF_NODE,
        }),
      ),
    ).toEqual([LEAF_NODE, GRANDCHILD_NODE, CHILD_NODE, ROOT_NODE]);
    expect(
      nodeIdsOf(filterBindings(TREE_A_BINDINGS, { treeId: TREE_A, kind: "heads" })).sort(),
    ).toEqual([LEAF_NODE, SIBLING_NODE].sort());
  });

  it("never returns bindings outside the list it is given", () => {
    // A list scoped to TREE_A only can never contain TREE_B.
    const onlyRoot = filterBindings([ROOT_BINDING], {
      treeId: TREE_A,
      kind: "descendants",
      scopeNodeId: ROOT_NODE,
    });
    expect(onlyRoot.map((b) => b.nodeId)).toEqual([ROOT_NODE]);
  });

  it("rejects a missing scope node (fail-closed)", () => {
    expect(() =>
      filterBindings(TREE_A_BINDINGS, {
        treeId: TREE_A,
        kind: "ancestors",
        scopeNodeId: OTHER_TREE_NODE,
      }),
    ).toThrow();
  });
});
