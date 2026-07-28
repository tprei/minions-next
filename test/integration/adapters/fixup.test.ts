import {
  contentHash,
  gitSha,
  nonEmptyText,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type ConflictMarker,
  type ContentHash,
  type GitSha,
  type TaskNodeId,
  type VcsChangeBinding,
} from "@minions/core";
import {
  changeIdFingerprint,
  createFixupCoordinator,
  createSqliteVcsChangeBindingStore,
  type AbsorbReceipt,
  type FixContent,
  type FixupCoordinator,
  type FixupError,
  type FixupWorkingCopy,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * PR 39 — fixup targeting via jj absorb.
 *
 * Routes a review fix made while editing a descendant change C back to its
 * originating ancestor change A: the fix becomes a temporary child fixup change
 * of C, is folded into A via jj absorb, and C is auto-restacked onto the
 * rewritten A. Mis-targeting (the fix routed to a non-ancestor, or the fix
 * content not folding cleanly into A) is detected and blocked (GIT-09, QA-07).
 *
 * The working-copy broker is a test double (mocked jj absorb/new); the binding
 * store is the real SQLite implementation.
 */

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000039");
const ORIGIN_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000040");
const DESCENDANT_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000041");
const DEEP_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000042");
const UNRELATED_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000099");

/** Raw 32-char jj change ids. */
const ORIGIN_CHANGE_RAW = "a1".repeat(16);
const DESCENDANT_CHANGE_RAW = "b2".repeat(16);
const DEEP_CHANGE_RAW = "d4".repeat(16);
const UNRELATED_CHANGE_RAW = "c3".repeat(16);
const FIXUP_CHANGE_RAW = "e5".repeat(16);
const NEW_DESCENDANT_CHANGE_RAW = "f6".repeat(16);

/** SHA-256 fingerprint of a raw jj change id into the binding's 64-hex space. */
const fp = (rawChangeId: string): ContentHash => changeIdFingerprint(rawChangeId);
const ORIGIN_CHANGE = fp(ORIGIN_CHANGE_RAW);
const DESCENDANT_CHANGE = fp(DESCENDANT_CHANGE_RAW);
const DEEP_CHANGE = fp(DEEP_CHANGE_RAW);
const UNRELATED_CHANGE = fp(UNRELATED_CHANGE_RAW);
const FIXUP_CHANGE = fp(FIXUP_CHANGE_RAW);
const NEW_DESCENDANT_CHANGE = fp(NEW_DESCENDANT_CHANGE_RAW);

const PATCH = nonEmptyText(
  "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n",
  "fixup patch",
);

/** Repeat a numeric seed's hex unit to exactly `length` lowercase-hex chars. */
function hexRun(seed: number, length: number): string {
  const unit = (seed % 256).toString(16).padStart(2, "0");
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

const commit = (seed: number): GitSha => gitSha(hexRun(seed, 40));
const op = (seed: number): ContentHash => contentHash(hexRun(seed + 128, 64));

const ORIGIN_COMMIT = commit(1);
const DESCENDANT_COMMIT = commit(2);
const NEW_ORIGIN_COMMIT = commit(11);
const NEW_DESCENDANT_COMMIT = commit(12);
const ABSORB_OP = op(50);

// -------------------------------------------------------------------------------------------------
// Binding helper.
// -------------------------------------------------------------------------------------------------

type BindingOverrides = Partial<Omit<VcsChangeBinding, "treeId" | "nodeId">>;

function binding(nodeId: TaskNodeId, overrides: BindingOverrides = {}): VcsChangeBinding {
  return Object.freeze({
    treeId: TREE_ID,
    nodeId,
    jjChangeId: contentHash("0".repeat(64)),
    currentCommitId: commit(0),
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
// Fake working-copy broker.
// -------------------------------------------------------------------------------------------------

interface FakeWorkingCopyConfig {
  /** Scripted absorb receipt. Defaults to a clean single-parent absorb. */
  readonly absorbReceipt?: AbsorbReceipt;
  /** If set, the corresponding broker call rejects with this error. */
  readonly createChildFixupError?: Error;
  readonly applyFixError?: Error;
  readonly absorbError?: Error;
}

class FakeWorkingCopy implements FixupWorkingCopy {
  readonly createChildFixupCalls: readonly ContentHash[] = [];
  readonly applyFixCalls: Readonly<{
    readonly fixupChangeId: ContentHash;
    readonly fix: FixContent;
  }>[] = [];
  readonly absorbCalls: Readonly<{
    readonly fixupChangeId: ContentHash;
    readonly originatingChangeId: ContentHash;
  }>[] = [];
  readonly #config: FakeWorkingCopyConfig;

  constructor(config: FakeWorkingCopyConfig = {}) {
    this.#config = config;
  }

  createChildFixup(
    descendantChangeId: ContentHash,
  ): Promise<Readonly<{ readonly fixupChangeId: ContentHash }>> {
    (this.createChildFixupCalls as ContentHash[]).push(descendantChangeId);
    if (this.#config.createChildFixupError !== undefined) {
      return Promise.reject(this.#config.createChildFixupError);
    }
    return Promise.resolve(Object.freeze({ fixupChangeId: FIXUP_CHANGE }));
  }

  applyFix(fixupChangeId: ContentHash, fix: FixContent): Promise<void> {
    (this.applyFixCalls as object[]).push(Object.freeze({ fixupChangeId, fix }));
    if (this.#config.applyFixError !== undefined) {
      return Promise.reject(this.#config.applyFixError);
    }
    return Promise.resolve();
  }

  absorb(fixupChangeId: ContentHash, originatingChangeId: ContentHash): Promise<AbsorbReceipt> {
    (this.absorbCalls as object[]).push(Object.freeze({ fixupChangeId, originatingChangeId }));
    if (this.#config.absorbError !== undefined) {
      return Promise.reject(this.#config.absorbError);
    }
    return Promise.resolve(this.#config.absorbReceipt ?? cleanAbsorbReceipt());
  }
}

function cleanAbsorbReceipt(overrides: Partial<AbsorbReceipt> = {}): AbsorbReceipt {
  return Object.freeze({
    outcome: "clean",
    originatingCommit: NEW_ORIGIN_COMMIT,
    originatingChangeId: ORIGIN_CHANGE,
    parentCount: 1,
    restackedChangeId: NEW_DESCENDANT_CHANGE,
    restackedCommit: NEW_DESCENDANT_COMMIT,
    restackedParentCount: 1,
    operationLogId: ABSORB_OP,
    conflictMarkers: Object.freeze([]),
    ...overrides,
  });
}

function textualConflictMarker(path: string): ConflictMarker {
  return Object.freeze({ path, kind: "textual" });
}

// -------------------------------------------------------------------------------------------------
// Harness: fresh host database + fixup coordinator per test.
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

function coordinator(workingCopy: FakeWorkingCopy): FixupCoordinator {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createFixupCoordinator({
    workingCopy,
    bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
    clock,
    ids: new SequenceIdGenerator(["fixup-1", "fixup-2", "fixup-3", "fixup-4"]),
  });
}

async function seedBinding(value: VcsChangeBinding): Promise<void> {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  await createSqliteVcsChangeBindingStore({ database: temporary.database }).upsertBinding(value);
}

async function readBinding(nodeId: TaskNodeId): Promise<VcsChangeBinding> {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  const store = createSqliteVcsChangeBindingStore({ database: temporary.database });
  const result = await store.getBinding(TREE_ID, nodeId);
  if (result === undefined) {
    throw new Error(`no binding found for node ${nodeId}`);
  }
  return result;
}

/** A standard two-change stack: A (origin) <- C (descendant). */
async function seedStack(): Promise<void> {
  await seedBinding(
    binding(ORIGIN_NODE_ID, {
      jjChangeId: ORIGIN_CHANGE,
      currentCommitId: ORIGIN_COMMIT,
      parentChangeId: undefined,
    }),
  );
  await seedBinding(
    binding(DESCENDANT_NODE_ID, {
      jjChangeId: DESCENDANT_CHANGE,
      currentCommitId: DESCENDANT_COMMIT,
      parentChangeId: ORIGIN_CHANGE,
    }),
  );
}

function isFixupError(value: unknown): value is FixupError {
  return value instanceof Error && value.name === "FixupError";
}

// -------------------------------------------------------------------------------------------------
// absorbFixup — success path.
// -------------------------------------------------------------------------------------------------

describe("fixup absorb: originating updated + descendant restacked + evidence invalidated", () => {
  it("folds the fix into the originating change and restacks the descendant", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy();
    const result = await coordinator(workingCopy).absorbFixup(
      {
        treeId: TREE_ID,
        fixNodeId: ORIGIN_NODE_ID,
        originatingChangeId: ORIGIN_CHANGE,
        descendantChangeId: DESCENDANT_CHANGE,
      },
      { patch: PATCH },
    );

    // The fix was routed correctly: child fixup created on C, applied, absorbed into A.
    expect(workingCopy.createChildFixupCalls).toStrictEqual([DESCENDANT_CHANGE]);
    expect(workingCopy.applyFixCalls).toHaveLength(1);
    expect(workingCopy.applyFixCalls[0]?.fixupChangeId).toBe(FIXUP_CHANGE);
    expect(workingCopy.absorbCalls).toStrictEqual([
      { fixupChangeId: FIXUP_CHANGE, originatingChangeId: ORIGIN_CHANGE },
    ]);

    // Result: absorbed, the descendant was restacked, its evidence is stale, verified.
    expect(result).toStrictEqual({
      absorbed: true,
      restackedNodes: [String(DESCENDANT_NODE_ID)],
      invalidatedEvidence: [String(DESCENDANT_NODE_ID)],
      verificationPassed: true,
    });
  });

  it("advances the originating binding (new commit + rewriteGeneration)", async () => {
    await seedStack();
    await coordinator(new FakeWorkingCopy()).absorbFixup(
      {
        treeId: TREE_ID,
        fixNodeId: ORIGIN_NODE_ID,
        originatingChangeId: ORIGIN_CHANGE,
        descendantChangeId: DESCENDANT_CHANGE,
      },
      { patch: PATCH },
    );

    const origin = await readBinding(ORIGIN_NODE_ID);
    expect(origin.currentCommitId).toBe(NEW_ORIGIN_COMMIT);
    expect(origin.rewriteGeneration).toBe(1);
    expect(origin.lastJjOperationId).toBe(ABSORB_OP);
    expect(origin.conflictState).toBe("clean");
    // The originating change id is stable across a clean absorb.
    expect(origin.jjChangeId).toBe(ORIGIN_CHANGE);
  });

  it("restacks the descendant binding (new change id + commit + re-parented)", async () => {
    await seedStack();
    await coordinator(new FakeWorkingCopy()).absorbFixup(
      {
        treeId: TREE_ID,
        fixNodeId: ORIGIN_NODE_ID,
        originatingChangeId: ORIGIN_CHANGE,
        descendantChangeId: DESCENDANT_CHANGE,
      },
      { patch: PATCH },
    );

    const descendant = await readBinding(DESCENDANT_NODE_ID);
    expect(descendant.jjChangeId).toBe(NEW_DESCENDANT_CHANGE);
    expect(descendant.currentCommitId).toBe(NEW_DESCENDANT_COMMIT);
    // Re-parented onto the rewritten originating change.
    expect(descendant.parentChangeId).toBe(ORIGIN_CHANGE);
    expect(descendant.rewriteGeneration).toBe(1);
    expect(descendant.conflictState).toBe("clean");
  });

  it("advances rewriteGeneration from a non-zero starting generation", async () => {
    await seedBinding(
      binding(ORIGIN_NODE_ID, {
        jjChangeId: ORIGIN_CHANGE,
        currentCommitId: ORIGIN_COMMIT,
        rewriteGeneration: 3,
      }),
    );
    await seedBinding(
      binding(DESCENDANT_NODE_ID, {
        jjChangeId: DESCENDANT_CHANGE,
        currentCommitId: DESCENDANT_COMMIT,
        parentChangeId: ORIGIN_CHANGE,
        rewriteGeneration: 7,
      }),
    );

    await coordinator(new FakeWorkingCopy()).absorbFixup(
      {
        treeId: TREE_ID,
        fixNodeId: ORIGIN_NODE_ID,
        originatingChangeId: ORIGIN_CHANGE,
        descendantChangeId: DESCENDANT_CHANGE,
      },
      { patch: PATCH },
    );

    expect((await readBinding(ORIGIN_NODE_ID)).rewriteGeneration).toBe(4);
    expect((await readBinding(DESCENDANT_NODE_ID)).rewriteGeneration).toBe(8);
  });

  it("uses a pre-created fixup change when provided (skips creation)", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy();
    await coordinator(workingCopy).absorbFixup(
      {
        treeId: TREE_ID,
        fixNodeId: ORIGIN_NODE_ID,
        originatingChangeId: ORIGIN_CHANGE,
        descendantChangeId: DESCENDANT_CHANGE,
        fixupChangeId: FIXUP_CHANGE,
      },
      { patch: PATCH },
    );

    expect(workingCopy.createChildFixupCalls).toStrictEqual([]);
    expect(workingCopy.applyFixCalls[0]?.fixupChangeId).toBe(FIXUP_CHANGE);
    expect(workingCopy.absorbCalls[0]?.fixupChangeId).toBe(FIXUP_CHANGE);
  });
});

// -------------------------------------------------------------------------------------------------
// previewAbsorb — dry-run.
// -------------------------------------------------------------------------------------------------

describe("fixup preview: dry-run affected changes (no broker mutation)", () => {
  it("reports the originating + every descendant as affected", async () => {
    // A <- C <- DEEP, plus an unrelated node.
    await seedBinding(
      binding(ORIGIN_NODE_ID, {
        jjChangeId: ORIGIN_CHANGE,
        currentCommitId: ORIGIN_COMMIT,
        parentChangeId: undefined,
      }),
    );
    await seedBinding(
      binding(DESCENDANT_NODE_ID, {
        jjChangeId: DESCENDANT_CHANGE,
        currentCommitId: DESCENDANT_COMMIT,
        parentChangeId: ORIGIN_CHANGE,
      }),
    );
    await seedBinding(
      binding(DEEP_NODE_ID, {
        jjChangeId: DEEP_CHANGE,
        currentCommitId: commit(3),
        parentChangeId: DESCENDANT_CHANGE,
      }),
    );
    await seedBinding(
      binding(UNRELATED_NODE_ID, {
        jjChangeId: UNRELATED_CHANGE,
        currentCommitId: commit(4),
        parentChangeId: undefined,
      }),
    );

    const workingCopy = new FakeWorkingCopy();
    const preview = await coordinator(workingCopy).previewAbsorb({
      treeId: TREE_ID,
      fixNodeId: ORIGIN_NODE_ID,
      originatingChangeId: ORIGIN_CHANGE,
      descendantChangeId: DESCENDANT_CHANGE,
    });

    expect(preview.updatedChangeId).toBe(ORIGIN_CHANGE);
    // Descendants of A (C and DEEP), parent-first is not guaranteed by the
    // helper; assert as a set. The unrelated node is NOT affected.
    expect(new Set(preview.restackedChangeIds)).toStrictEqual(
      new Set([DESCENDANT_CHANGE, DEEP_CHANGE]),
    );
    expect(new Set(preview.invalidatedNodes)).toStrictEqual(
      new Set([DESCENDANT_NODE_ID, DEEP_NODE_ID]),
    );

    // Dry-run: no broker mutation occurred.
    expect(workingCopy.createChildFixupCalls).toStrictEqual([]);
    expect(workingCopy.applyFixCalls).toStrictEqual([]);
    expect(workingCopy.absorbCalls).toStrictEqual([]);
  });

  it("rejects an unknown originating change as target_not_found", async () => {
    await seedStack();
    await expect(
      coordinator(new FakeWorkingCopy()).previewAbsorb({
        treeId: TREE_ID,
        fixNodeId: ORIGIN_NODE_ID,
        originatingChangeId: UNRELATED_CHANGE,
        descendantChangeId: DESCENDANT_CHANGE,
      }),
    ).rejects.toMatchObject({ name: "FixupError", code: "target_not_found" });
  });
});

// -------------------------------------------------------------------------------------------------
// multi_parent_result — rejected.
// -------------------------------------------------------------------------------------------------

describe("fixup absorb: multi-parent result rejected", () => {
  it("rejects a multi-parent originating result (GIT-05/GIT-06)", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy({
      absorbReceipt: cleanAbsorbReceipt({ parentCount: 2 }),
    });

    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "multi_parent_result" });
  });

  it("rejects a multi-parent restacked descendant", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy({
      absorbReceipt: cleanAbsorbReceipt({ restackedParentCount: 2 }),
    });

    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "multi_parent_result" });
  });

  it("rejects an explicit multi_parent outcome", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy({
      absorbReceipt: cleanAbsorbReceipt({ outcome: "multi_parent" }),
    });

    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "multi_parent_result" });
  });
});

// -------------------------------------------------------------------------------------------------
// conflict_in_absorb — blocked (mis-targeting signal).
// -------------------------------------------------------------------------------------------------

describe("fixup absorb: conflict in absorb blocks the fixup (mis-targeting)", () => {
  it("blocks when the absorb reports a conflict outcome", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy({
      absorbReceipt: cleanAbsorbReceipt({
        outcome: "conflict",
        conflictMarkers: [textualConflictMarker("src/a.ts")],
      }),
    });

    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "conflict_in_absorb" });
  });

  it("blocks when conflict markers are present even on a clean outcome", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy({
      absorbReceipt: cleanAbsorbReceipt({
        conflictMarkers: [textualConflictMarker("src/a.ts"), textualConflictMarker("src/b.ts")],
      }),
    });

    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "conflict_in_absorb" });
  });
});

// -------------------------------------------------------------------------------------------------
// mis_targeting_detected — structural.
// -------------------------------------------------------------------------------------------------

describe("fixup absorb: mis-targeting detected + blocked", () => {
  it("blocks when the descendant is not a descendant of the originating change", async () => {
    // A and an UNRELATED change (not stacked on A). Targeting the unrelated
    // change as the "descendant" is mis-targeting.
    await seedBinding(
      binding(ORIGIN_NODE_ID, {
        jjChangeId: ORIGIN_CHANGE,
        currentCommitId: ORIGIN_COMMIT,
        parentChangeId: undefined,
      }),
    );
    await seedBinding(
      binding(UNRELATED_NODE_ID, {
        jjChangeId: UNRELATED_CHANGE,
        currentCommitId: commit(4),
        parentChangeId: undefined,
      }),
    );

    const workingCopy = new FakeWorkingCopy();
    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: UNRELATED_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "mis_targeting_detected" });

    // Blocked before any broker mutation.
    expect(workingCopy.createChildFixupCalls).toStrictEqual([]);
    expect(workingCopy.absorbCalls).toStrictEqual([]);
  });

  it("blocks when the originating and descendant change ids are identical", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy();
    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: ORIGIN_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "mis_targeting_detected" });

    expect(workingCopy.createChildFixupCalls).toStrictEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// target_not_found + absorb_failed.
// -------------------------------------------------------------------------------------------------

describe("fixup absorb: target resolution + broker failures", () => {
  it("rejects an unknown originating change as target_not_found", async () => {
    await seedStack();
    await expect(
      coordinator(new FakeWorkingCopy()).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: UNRELATED_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "target_not_found" });
  });

  it("rejects an unknown descendant change as target_not_found", async () => {
    await seedStack();
    await expect(
      coordinator(new FakeWorkingCopy()).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: UNRELATED_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "target_not_found" });
  });

  it("surfaces a broker absorb failure as absorb_failed", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy({
      absorbError: new Error("jj absorb subprocess crashed"),
    });
    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "absorb_failed" });
  });

  it("surfaces a child-fixup creation failure as absorb_failed", async () => {
    await seedStack();
    const workingCopy = new FakeWorkingCopy({
      createChildFixupError: new Error("jj new failed"),
    });
    await expect(
      coordinator(workingCopy).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: ORIGIN_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "absorb_failed" });
  });
});

// -------------------------------------------------------------------------------------------------
// isFixupError guard — keeps the typed error surface usable.
// -------------------------------------------------------------------------------------------------

describe("FixupError typed surface", () => {
  it("carries a typed code + remediation", async () => {
    await seedStack();
    let caught: unknown;
    try {
      await coordinator(new FakeWorkingCopy()).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: UNRELATED_CHANGE,
          descendantChangeId: DESCENDANT_CHANGE,
        },
        { patch: PATCH },
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(isFixupError(caught)).toBe(true);
    if (isFixupError(caught)) {
      expect(caught.code).toBe("target_not_found");
      expect(caught.remediation.length).toBeGreaterThan(0);
    }
  });
});
