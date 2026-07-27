import {
  bindingFingerprint,
  contentHash,
  gitSha,
  isValidConflictTransition,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  VcsChangeBindingStoreError,
  type ConflictState,
  type ContentHash,
  type GitSha,
  type TaskNodeId,
  type VcsChangeBinding,
} from "@minions/core";
import { createSqliteVcsChangeBindingStore } from "@minions/adapters";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000012");
const NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000014");
const SECOND_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000041");
const THIRD_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000042");

/** Repeat a numeric seed's hex unit to exactly `length` lowercase-hex chars. */
function hexRun(seed: number, length: number): string {
  const unit = (seed % 256).toString(16).padStart(2, "0");
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

// Offset so operation ids never collide with change ids.
const change = (seed: number): ContentHash => contentHash(hexRun(seed, 64));
const op = (seed: number): ContentHash => contentHash(hexRun(seed + 128, 64));
const commit = (seed: number): GitSha => gitSha(hexRun(seed, 40));

type BindingOverrides = Partial<Omit<VcsChangeBinding, "treeId" | "nodeId">>;

function binding(nodeId: TaskNodeId = NODE_ID, overrides: BindingOverrides = {}): VcsChangeBinding {
  return Object.freeze({
    treeId: TREE_ID,
    nodeId,
    jjChangeId: change(1),
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

// -------------------------------------------------------------------------------------------------
// Harness: a fresh host database + store per test.
// -------------------------------------------------------------------------------------------------

const clock = new FixedClock(timestampFromEpochMilliseconds(BASE_TIME));

let temporary: TemporarySqliteDatabase | undefined;

beforeEach(async () => {
  temporary = await TemporarySqliteDatabase.create("host", clock);
});

afterEach(async () => {
  const current = temporary;
  temporary = undefined;
  if (current !== undefined) {
    await current.dispose();
  }
});

function store() {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createSqliteVcsChangeBindingStore({ database: temporary.database });
}

// -------------------------------------------------------------------------------------------------
// Tests.
// -------------------------------------------------------------------------------------------------

describe("vcs change binding store: round-trip", () => {
  it("upserts a binding and reads it back by (tree, node)", async () => {
    await store().upsertBinding(binding());
    const stored = await store().getBinding(TREE_ID, NODE_ID);
    expect(stored).toBeDefined();
    expect(stored).toEqual(binding());
  });

  it("returns undefined for an unknown (tree, node)", async () => {
    expect(await store().getBinding(TREE_ID, NODE_ID)).toBeUndefined();
  });

  it("round-trips nullable fields (parent change, bookmark, pushed/reviewed commits)", async () => {
    await store().upsertBinding(
      binding(NODE_ID, {
        parentChangeId: change(2),
        bookmark: "feature/widget",
        lastPushedCommitId: commit(7),
        lastReviewedCommitId: commit(8),
      }),
    );
    const stored = await store().getBinding(TREE_ID, NODE_ID);
    expect(stored?.parentChangeId).toBe(change(2));
    expect(stored?.bookmark).toBe("feature/widget");
    expect(stored?.lastPushedCommitId).toBe(commit(7));
    expect(stored?.lastReviewedCommitId).toBe(commit(8));
  });
});

describe("vcs change binding store: composite uniqueness", () => {
  it("updates in place when the same (tree, node) is upserted again", async () => {
    await store().upsertBinding(binding());
    await store().upsertBinding(
      binding(NODE_ID, {
        currentCommitId: commit(2),
        rewriteGeneration: 1,
        lastJjOperationId: op(2),
      }),
    );
    const stored = await store().getBinding(TREE_ID, NODE_ID);
    expect(stored?.currentCommitId).toBe(commit(2));
    expect(stored?.rewriteGeneration).toBe(1);
    expect(stored?.lastJjOperationId).toBe(op(2));
    expect(
      temporary?.database.read(
        (reader) => reader.get("SELECT COUNT(*) AS n FROM vcs_change_bindings")?.["n"],
      ),
    ).toBe(1n);
  });

  it("inserts a distinct row when the node differs", async () => {
    await store().upsertBinding(binding(NODE_ID));
    await store().upsertBinding(binding(SECOND_NODE_ID, { jjChangeId: change(2) }));
    expect(await store().getBinding(TREE_ID, NODE_ID)).toBeDefined();
    expect(await store().getBinding(TREE_ID, SECOND_NODE_ID)).toBeDefined();
    expect(
      temporary?.database.read(
        (reader) => reader.get("SELECT COUNT(*) AS n FROM vcs_change_bindings")?.["n"],
      ),
    ).toBe(2n);
  });

  it("rejects a regression of rewrite generation (fail-closed via the DB trigger)", async () => {
    await store().upsertBinding(binding(NODE_ID, { rewriteGeneration: 3 }));
    await expect(
      store().upsertBinding(binding(NODE_ID, { rewriteGeneration: 2 })),
    ).rejects.toBeInstanceOf(VcsChangeBindingStoreError);
    const stored = await store().getBinding(TREE_ID, NODE_ID);
    expect(stored?.rewriteGeneration).toBe(3);
  });
});

describe("vcs change binding store: getByChangeId", () => {
  it("looks up a binding by its jj change id within a tree", async () => {
    await store().upsertBinding(binding(NODE_ID, { jjChangeId: change(5) }));
    const stored = await store().getByChangeId(TREE_ID, change(5));
    expect(stored).toBeDefined();
    expect(stored?.nodeId).toBe(NODE_ID);
  });

  it("returns undefined for an unknown change id", async () => {
    expect(await store().getByChangeId(TREE_ID, change(5))).toBeUndefined();
  });
});

describe("vcs change binding store: listForTree", () => {
  it("lists every binding for a tree ordered by node id", async () => {
    await store().upsertBinding(binding(SECOND_NODE_ID, { jjChangeId: change(2) }));
    await store().upsertBinding(binding(NODE_ID, { jjChangeId: change(1) }));
    await store().upsertBinding(binding(THIRD_NODE_ID, { jjChangeId: change(3) }));
    const list = await store().listForTree(TREE_ID);
    expect(list.map((entry) => entry.nodeId)).toEqual([NODE_ID, SECOND_NODE_ID, THIRD_NODE_ID]);
  });

  it("returns an empty list for a tree with no bindings", async () => {
    expect(await store().listForTree(TREE_ID)).toEqual([]);
  });
});

describe("vcs change binding store: orphan detection (GIT-16)", () => {
  it("passes when every bound node is known", async () => {
    await store().upsertBinding(binding(NODE_ID));
    await store().upsertBinding(binding(SECOND_NODE_ID, { jjChangeId: change(2) }));
    await expect(
      store().assertNoOrphans(TREE_ID, [NODE_ID, SECOND_NODE_ID]),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a binding references an unknown node", async () => {
    await store().upsertBinding(binding(NODE_ID));
    await expect(store().assertNoOrphans(TREE_ID, [SECOND_NODE_ID])).rejects.toThrow(
      VcsChangeBindingStoreError,
    );
    await expect(store().assertNoOrphans(TREE_ID, [SECOND_NODE_ID])).rejects.toMatchObject({
      code: "orphan_binding",
    });
  });
});

describe("vcs change binding store: duplicate detection", () => {
  it("passes when each node and each change maps to exactly one binding", async () => {
    await store().upsertBinding(binding(NODE_ID, { jjChangeId: change(1) }));
    await store().upsertBinding(binding(SECOND_NODE_ID, { jjChangeId: change(2) }));
    await expect(store().assertNoDuplicates(TREE_ID)).resolves.toBeUndefined();
  });

  it("fails closed when one jj change is bound to multiple nodes", async () => {
    await store().upsertBinding(binding(NODE_ID, { jjChangeId: change(1) }));
    await store().upsertBinding(binding(SECOND_NODE_ID, { jjChangeId: change(1) }));
    await expect(store().assertNoDuplicates(TREE_ID)).rejects.toThrow(VcsChangeBindingStoreError);
    await expect(store().assertNoDuplicates(TREE_ID)).rejects.toMatchObject({
      code: "duplicate_binding",
    });
  });
});

describe("vcs change binding store: validation", () => {
  it("rejects an invalid binding before touching the database", async () => {
    await expect(
      store().upsertBinding(binding(NODE_ID, { conflictState: "bogus" as ConflictState })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await store().getBinding(TREE_ID, NODE_ID)).toBeUndefined();
  });

  it("rejects a negative rewrite generation", async () => {
    await expect(
      store().upsertBinding(binding(NODE_ID, { rewriteGeneration: -1 })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an empty bookmark", async () => {
    await expect(store().upsertBinding(binding(NODE_ID, { bookmark: "" }))).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("vcs change binding store: lifecycle + event-replay reconstruction", () => {
  it("advances a binding through rewrite + conflict states and reconstructs via fingerprint", async () => {
    const b = store();
    // Create the binding at generation 0, clean.
    await b.upsertBinding(binding(NODE_ID));
    // A rewrite advances the commit and the operation, bumping generation.
    await b.upsertBinding(
      binding(NODE_ID, {
        currentCommitId: commit(2),
        rewriteGeneration: 1,
        lastJjOperationId: op(2),
        parentChangeId: change(1),
      }),
    );
    // The rewrite lands in a conflict.
    await b.upsertBinding(
      binding(NODE_ID, {
        currentCommitId: commit(2),
        rewriteGeneration: 1,
        lastJjOperationId: op(2),
        parentChangeId: change(1),
        conflictState: "conflict",
      }),
    );
    // The conflict is resolved and reviewed.
    await b.upsertBinding(
      binding(NODE_ID, {
        currentCommitId: commit(2),
        rewriteGeneration: 2,
        lastJjOperationId: op(3),
        parentChangeId: change(1),
        conflictState: "resolved",
        lastReviewedCommitId: commit(2),
      }),
    );
    // The resolution is committed: clean again.
    await b.upsertBinding(
      binding(NODE_ID, {
        currentCommitId: commit(3),
        rewriteGeneration: 3,
        lastJjOperationId: op(4),
        parentChangeId: change(1),
        conflictState: "clean",
        lastPushedCommitId: commit(3),
        lastReviewedCommitId: commit(2),
      }),
    );

    const stored = await b.getBinding(TREE_ID, NODE_ID);
    if (stored === undefined) {
      throw new Error("expected a stored vcs change binding");
    }
    expect(stored.rewriteGeneration).toBe(3);
    expect(stored.currentCommitId).toBe(commit(3));
    expect(stored.conflictState).toBe("clean");
    expect(stored.lastPushedCommitId).toBe(commit(3));
    expect(stored.lastReviewedCommitId).toBe(commit(2));

    // The conflict transitions walked are all legal.
    expect(isValidConflictTransition("clean", "conflict")).toBe(true);
    expect(isValidConflictTransition("conflict", "resolved")).toBe(true);
    expect(isValidConflictTransition("resolved", "clean")).toBe(true);

    // Event replay: reconstruct the binding from the observed final facts and
    // confirm it is byte-identical to the stored row via the fingerprint.
    const reconstructed: VcsChangeBinding = Object.freeze({
      treeId: TREE_ID,
      nodeId: NODE_ID,
      jjChangeId: change(1),
      currentCommitId: commit(3),
      parentChangeId: change(1),
      bookmark: undefined,
      rewriteGeneration: 3,
      lastJjOperationId: op(4),
      lastPushedCommitId: commit(3),
      lastReviewedCommitId: commit(2),
      conflictState: "clean",
      recordedAt: timestampFromEpochMilliseconds(BASE_TIME),
    });
    expect(bindingFingerprint(stored)).toBe(bindingFingerprint(reconstructed));
  });
});
