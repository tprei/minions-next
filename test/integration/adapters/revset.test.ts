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

// All TREE_A commit ids; the double returns these for a "fully confirming" jj.
const TREE_A_COMMITS: readonly string[] = [commit(1), commit(2), commit(31), commit(4), commit(5)];

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

/** A double that returns the seeded commit ids for any `jj log` revset. */
function fakeRunner(commitIds: readonly string[]): RevsetJjRunner {
  return () =>
    Promise.resolve<RevsetJjRunResult>({
      exitCode: 0,
      stdout: `${commitIds.join("\n")}\n`,
      stderr: "",
    });
}
function manager(commitIds: readonly string[] = TREE_A_COMMITS) {
  if (temporary === undefined) {
    throw new Error("test database not initialized");
  }
  return createRevsetManager({
    jjBinaryPath: "/nonexistent/jj",
    workingCopyPath: "/nonexistent/repo",
    bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
    runJj: fakeRunner(commitIds),
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
    // Even a double that "confirms" every commit id (including the other tree)
    // cannot surface TREE_B: listForTree(TREE_A) excludes it.
    const result = await manager([...TREE_A_COMMITS, commit(6)]).execute({
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
    const result = await manager([commit(6)]).execute({
      treeId: TREE_B,
      kind: "heads",
    });
    expect(nodeIdsOf(result.bindings)).toEqual([OTHER_TREE_NODE]);
  });
});

describe("revset manager: results match the binding table", () => {
  it("drops jj commit ids that have no binding in the tree (cross-check)", async () => {
    const foreign = commit(99);
    const result = await manager([...TREE_A_COMMITS, foreign]).execute({
      treeId: TREE_A,
      kind: "heads",
    });
    expect(result.changeIds).not.toContain(foreign);
    expect(result.bindings.every((b) => b.treeId === TREE_A)).toBe(true);
  });

  it("drops bindings the live jj answer did not confirm", async () => {
    // Double confirms only ROOT + CHILD; the heads filter {LEAF, SIBLING} is
    // therefore empty after the cross-check.
    const result = await manager([commit(1), commit(2)]).execute({
      treeId: TREE_A,
      kind: "heads",
    });
    expect(result.bindings).toEqual([]);
    expect(result.changeIds).toEqual([]);
  });

  it("requests commit_id template from jj log", async () => {
    const capturedArgs: string[][] = [];
    const runner: RevsetJjRunner = (args) => {
      capturedArgs.push([...args]);
      return Promise.resolve<RevsetJjRunResult>({
        exitCode: 0,
        stdout: `${TREE_A_COMMITS.join("\n")}\n`,
        stderr: "",
      });
    };
    if (temporary === undefined) {
      throw new Error("test database not initialized");
    }
    const mgr = createRevsetManager({
      jjBinaryPath: "/nonexistent/jj",
      workingCopyPath: "/nonexistent/repo",
      bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
      runJj: runner,
    });
    await mgr.execute({ treeId: TREE_A, kind: "heads" });
    const logCall = capturedArgs.find((args) => args[0] === "log");
    expect(logCall).toBeDefined();
    if (logCall === undefined) throw new Error("expected jj log call");
    const templateIndex = logCall.indexOf("-T");
    expect(templateIndex).toBeGreaterThan(-1);
    expect(logCall[templateIndex + 1]).toBe('commit_id ++ "\\n"');
  });
  it("yields zero bindings when the runner returns z-base-32 change ids instead of commit ids", async () => {
    const zBase32ChangeIds = [
      "kkmrssonomvr",
      "qpvuntsmwlqt",
      "zsuskulnlkno",
      "mpvwkrmkltno",
      "vrstkwonlqpm",
    ];
    const result = await manager(zBase32ChangeIds).execute({
      treeId: TREE_A,
      kind: "descendants",
      scopeNodeId: ROOT_NODE,
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

describe("revset manager: reviewHeaders", () => {
  /**
   * A runner that returns commit ids for `log` and configurable interdiff output.
   * `capturedArgs`, when supplied, records every `interdiff` invocation's argv so tests
   * can assert on exactly what was passed to jj (e.g. that `--summary` is no longer used).
   */
  function reviewRunner(
    commitIds: readonly string[],
    interdiffOutput = "",
    capturedArgs?: string[][],
  ): RevsetJjRunner {
    return (args) => {
      if (args[0] === "interdiff") {
        capturedArgs?.push([...args]);
        return Promise.resolve<RevsetJjRunResult>({
          exitCode: 0,
          stdout: interdiffOutput,
          stderr: "",
        });
      }
      return Promise.resolve<RevsetJjRunResult>({
        exitCode: 0,
        stdout: `${commitIds.join("\n")}\n`,
        stderr: "",
      });
    };
  }

  async function upsertReviewBindings(): Promise<void> {
    if (temporary === undefined) throw new Error("test database not initialized");
    const store = createSqliteVcsChangeBindingStore({ database: temporary.database });
    // GRANDCHILD: needs interdiff (commits differ, rewrite generation 1).
    await store.upsertBinding(
      bindingA(GRANDCHILD_NODE, {
        currentCommitId: commit(31),
        lastReviewedCommitId: commit(3),
        rewriteGeneration: 1,
      }),
    );
    // LEAF: needs interdiff (commits differ, same generation).
    await store.upsertBinding(
      bindingA(LEAF_NODE, {
        currentCommitId: commit(41),
        lastReviewedCommitId: commit(4),
      }),
    );
  }

  function reviewManager(interdiffOutput = "", capturedArgs?: string[][]) {
    if (temporary === undefined) throw new Error("test database not initialized");
    return createRevsetManager({
      jjBinaryPath: "/nonexistent/jj",
      workingCopyPath: "/nonexistent/repo",
      bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
      runJj: reviewRunner(TREE_A_COMMITS, interdiffOutput, capturedArgs),
    });
  }

  it("classifies fresh and never_reviewed from binding fields alone", async () => {
    // beforeEach already seeded ROOT (fresh) and SIBLING (never_reviewed).
    const headers = await reviewManager().reviewHeaders(TREE_A);
    const byNode = new Map(headers.map((h) => [String(h.nodeId), h]));
    expect(byNode.get(String(ROOT_NODE))?.freshness).toBe("fresh");
    expect(byNode.get(String(SIBLING_NODE))?.freshness).toBe("never_reviewed");
    expect(byNode.get(String(ROOT_NODE))?.contentChangedSinceReview).toBe(false);
    // Neither classification runs jj interdiff, so there is no diff body to carry.
    expect(byNode.get(String(ROOT_NODE))?.interdiffContent).toBeUndefined();
    expect(byNode.get(String(SIBLING_NODE))?.interdiffContent).toBeUndefined();
  });

  it("classifies ancestry_only when interdiff is empty (restack) and carries no diff content", async () => {
    await upsertReviewBindings();
    const headers = await reviewManager("").reviewHeaders(TREE_A);
    const byNode = new Map(headers.map((h) => [String(h.nodeId), h]));
    expect(byNode.get(String(GRANDCHILD_NODE))?.freshness).toBe("ancestry_only");
    expect(byNode.get(String(GRANDCHILD_NODE))?.contentChangedSinceReview).toBe(false);
    // The interdiff ran but found nothing: no diff body left to show the reviewer.
    expect(byNode.get(String(GRANDCHILD_NODE))?.interdiffContent).toBeUndefined();
  });

  it("classifies stale_content when interdiff is non-empty, drops --summary, and carries the full diff body", async () => {
    await upsertReviewBindings();
    const diff =
      "diff --git a/src/handler.ts b/src/handler.ts\n" +
      "--- a/src/handler.ts\n" +
      "+++ b/src/handler.ts\n" +
      "@@ -1,3 +1,4 @@\n" +
      " export function handler() {\n" +
      '+  console.log("reviewed");\n' +
      "   return true;\n" +
      " }\n";
    const capturedArgs: string[][] = [];
    const headers = await reviewManager(diff, capturedArgs).reviewHeaders(TREE_A);
    const byNode = new Map(headers.map((h) => [String(h.nodeId), h]));
    expect(byNode.get(String(LEAF_NODE))?.freshness).toBe("stale_content");
    expect(byNode.get(String(LEAF_NODE))?.contentChangedSinceReview).toBe(true);
    // The full interdiff body is captured and carried on the header — not discarded, and
    // not a --summary (one line per changed file) list.
    expect(byNode.get(String(LEAF_NODE))?.interdiffContent).toBe(diff);
    expect(capturedArgs.length).toBeGreaterThan(0);
    expect(capturedArgs.every((call) => !call.includes("--summary"))).toBe(true);
  });
});
