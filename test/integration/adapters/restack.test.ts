import {
  contentHash,
  gitSha,
  invalidateStaleGates,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  validateAncestry,
  type ConflictBundle,
  type ContentHash,
  type GitSha,
  type NonEmptyText,
  type RestackNodeResult,
  type TaskNodeId,
  type VcsChangeBinding,
} from "@minions/core";
import {
  createRestackCoordinator,
  createSqliteVcsChangeBindingStore,
  type RestackCoordinator,
  type RestackHumanAttention,
  type RestackRepairHarness,
  type RestackRebaseOutcome,
  type RestackStaleSink,
  type RestackWorkingCopy,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * PR 34 — restack + bounded conflict repair.
 *
 * Restacks descendants parent-first after a parent rewrite through the masked
 * jj working-copy broker, detects textual/semantic conflicts, attempts bounded
 * semantic repair via the node's OMP session (PR 26 retry budget), squashes a
 * successful resolution + verifies clean ancestry, and produces durable
 * conflict-as-commit state for exhausted repair (GIT-05..07).
 *
 * The working-copy broker + repair harness + sinks are test doubles; the
 * binding store is the real SQLite implementation.
 */

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000034");
const PARENT_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000040");
const CHILD_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000041");
const GRANDCHILD_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000042");
const SIBLING_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000043");

const NEW_PARENT_COMMIT = gitSha("f".repeat(40));

/** Repeat a numeric seed's hex unit to exactly `length` lowercase-hex chars. */
function hexRun(seed: number, length: number): string {
  const unit = (seed % 256).toString(16).padStart(2, "0");
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

const change = (seed: number): ContentHash => contentHash(hexRun(seed, 64));
const op = (seed: number): ContentHash => contentHash(hexRun(seed + 64, 64));
const commit = (seed: number): GitSha => gitSha(hexRun(seed, 40));

/** A registered working-copy change id (jj change ids are 32 lowercase chars). */
const CHILD_CHANGE = change(11);
const GRANDCHILD_CHANGE = change(12);
const SIBLING_CHANGE = change(13);

// Distinct registered working-copy change ids (jj change ids are 32 lowercase
// chars). The UUID node ids differ only in their trailing segment, so slicing
// them would collide — use stable per-node literals instead.
const CHILD_WC = "c".repeat(32);
const GRANDCHILD_WC = "g".repeat(32);
const SIBLING_WC = "s".repeat(32);

// -------------------------------------------------------------------------------------------------
// Binding helper.
// -------------------------------------------------------------------------------------------------

type BindingOverrides = Partial<Omit<VcsChangeBinding, "treeId" | "nodeId">>;

function binding(nodeId: TaskNodeId, overrides: BindingOverrides = {}): VcsChangeBinding {
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
// Fake working-copy broker.
// -------------------------------------------------------------------------------------------------

type RebaseConfig =
  | { readonly kind: "clean" }
  | {
      readonly kind: "textual_conflict";
      readonly conflictDiff?: string;
      readonly paths?: readonly string[];
    }
  | {
      readonly kind: "semantic_conflict";
      readonly paths?: readonly string[];
      readonly conflictDiff?: string;
    }
  | { readonly kind: "multi_parent"; readonly parentCount?: number }
  | { readonly kind: "crash"; readonly error?: string };

interface FakeWorkingCopyConfig {
  /** Per-node rebase behavior. Nodes without an entry default to `clean`. */
  readonly rebase?: Readonly<Record<string, RebaseConfig>>;
  /** Commit seed base for clean/rebased outcomes; increments per rebase. */
  readonly commitSeed?: number;
  /** Diff bytes returned by `diff`; defaults to a marker-free empty diff. */
  readonly diffText?: string;
  /** Commit returned by `squashResolve`. */
  readonly squashCommit?: GitSha;
}

const SINGLE_PARENT: { readonly parentCount: number; readonly parentCommitIds: readonly GitSha[] } =
  {
    parentCount: 1,
    parentCommitIds: [NEW_PARENT_COMMIT],
  };

class FakeWorkingCopy implements RestackWorkingCopy {
  readonly rebaseCalls: Readonly<{
    workingCopyId: string;
    changeId: ContentHash;
    newParentCommit: GitSha;
  }>[] = [];
  readonly diffCalls: string[] = [];
  readonly squashCalls: Readonly<{ workingCopyId: string; message: NonEmptyText }>[] = [];
  readonly destroyed: string[] = [];
  #config: FakeWorkingCopyConfig;
  #commitSeed: number;

  constructor(config: FakeWorkingCopyConfig = {}) {
    this.#config = config;
    this.#commitSeed = config.commitSeed ?? 100;
  }

  /** Swap the rebase config (used to simulate crash-then-resume). */
  reconfigure(config: FakeWorkingCopyConfig): void {
    this.#config = config;
  }

  rebase(
    workingCopyId: string,
    changeId: ContentHash,
    newParentCommit: GitSha,
  ): Promise<RestackRebaseOutcome> {
    const cfg = this.#config.rebase?.[workingCopyId] ?? { kind: "clean" };
    this.rebaseCalls.push(Object.freeze({ workingCopyId, changeId, newParentCommit }));
    const newCommitId = commit(this.#commitSeed);
    this.#commitSeed += 1;
    const newChangeId = changeId;
    const operationLogId = op(this.#commitSeed);
    this.#commitSeed += 1;

    if (cfg.kind === "crash") {
      return Promise.reject(new Error(cfg.error ?? "jj rebase crashed"));
    }
    if (cfg.kind === "multi_parent") {
      return Promise.resolve(
        Object.freeze({
          workingCopyId,
          clean: true,
          conflictingPaths: [],
          semanticConflictPaths: [],
          newCommitId,
          newChangeId,
          ancestry: Object.freeze({
            parentCount: cfg.parentCount ?? 2,
            parentCommitIds: Object.freeze([NEW_PARENT_COMMIT, gitSha("e".repeat(40))]),
          }),
          operationLogId,
        }),
      );
    }
    if (cfg.kind === "textual_conflict" || cfg.kind === "semantic_conflict") {
      const paths = cfg.paths ?? Object.freeze(["src/conflicted.ts"]);
      return Promise.resolve(
        Object.freeze({
          workingCopyId,
          clean: false,
          conflictingPaths: cfg.kind === "textual_conflict" ? paths : [],
          semanticConflictPaths: cfg.kind === "semantic_conflict" ? paths : [],
          newCommitId,
          newChangeId,
          ancestry: SINGLE_PARENT,
          operationLogId,
        }),
      );
    }
    // clean
    return Promise.resolve(
      Object.freeze({
        workingCopyId,
        clean: true,
        conflictingPaths: [],
        semanticConflictPaths: [],
        newCommitId,
        newChangeId,
        ancestry: SINGLE_PARENT,
        operationLogId,
      }),
    );
  }

  diff(workingCopyId: string): Promise<Uint8Array> {
    this.diffCalls.push(workingCopyId);
    const text = this.#config.diffText ?? "<<<<<<<\nours\n=======\ntheirs\n>>>>>>>\n";
    return Promise.resolve(new TextEncoder().encode(text));
  }

  squashResolve(
    workingCopyId: string,
    message: NonEmptyText,
  ): Promise<{
    commitSha: GitSha;
    changeId: ContentHash;
    operationLogId: ContentHash;
    ancestry: { readonly parentCount: number; readonly parentCommitIds: readonly GitSha[] };
  }> {
    this.squashCalls.push(Object.freeze({ workingCopyId, message }));
    const operationLogId = op(this.#commitSeed);
    this.#commitSeed += 1;
    return Promise.resolve(
      Object.freeze({
        commitSha: this.#config.squashCommit ?? commit(250),
        changeId: CHILD_CHANGE,
        operationLogId,
        ancestry: SINGLE_PARENT,
      }),
    );
  }
}

// -------------------------------------------------------------------------------------------------
// Fake repair harness + sinks.
// -------------------------------------------------------------------------------------------------

/** Resolves on the Nth attempt (1-indexed); never resolves when undefined. */
class FakeRepairHarness implements RestackRepairHarness {
  readonly attempts: Readonly<{ workingCopyId: string; conflict: ConflictBundle }>[] = [];
  readonly resolveOnAttempt: number | undefined;
  #resolveText: string;
  constructor(resolveOnAttempt?: number, resolveText = "resolved conflict") {
    this.resolveOnAttempt = resolveOnAttempt;
    this.#resolveText = resolveText;
  }
  attemptRepair(input: {
    readonly workingCopyId: string;
    readonly conflict: ConflictBundle;
  }): Promise<{ resolved: boolean; resolutionText: string }> {
    this.attempts.push(
      Object.freeze({ workingCopyId: input.workingCopyId, conflict: input.conflict }),
    );
    const attemptNumber = this.attempts.length;
    const resolved = this.resolveOnAttempt === attemptNumber;
    return Promise.resolve(Object.freeze({ resolved, resolutionText: this.#resolveText }));
  }
}

class FakeStaleSink implements RestackStaleSink {
  readonly invalidations: TaskNodeId[][] = [];
  invalidateStale(nodeIds: readonly TaskNodeId[]): Promise<void> {
    this.invalidations.push([...nodeIds]);
    return Promise.resolve();
  }
}

class FakeAttentionSink {
  readonly attentions: RestackHumanAttention[] = [];
  record(attention: RestackHumanAttention): Promise<void> {
    this.attentions.push(attention);
    return Promise.resolve();
  }
}

// -------------------------------------------------------------------------------------------------
// Harness: fresh host database + coordinator per test.
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

interface CoordinatorConfig {
  readonly workingCopy: FakeWorkingCopy;
  readonly repairHarness?: FakeRepairHarness;
  readonly staleSink?: FakeStaleSink;
  readonly attentionSink?: FakeAttentionSink;
  readonly repairCeiling?: number;
}

function coordinator(config: CoordinatorConfig): RestackCoordinator {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createRestackCoordinator({
    workingCopy: config.workingCopy,
    bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
    clock,
    ids: new SequenceIdGenerator(["restack-1", "restack-2", "restack-3"]),
    ...(config.repairHarness !== undefined ? { repairHarness: config.repairHarness } : {}),
    ...(config.staleSink !== undefined ? { staleSink: config.staleSink } : {}),
    ...(config.attentionSink !== undefined ? { attentionSink: config.attentionSink } : {}),
    ...(config.repairCeiling !== undefined ? { repairCeiling: config.repairCeiling } : {}),
  });
}

/** A two-deep subtree: CHILD (parent=PARENT) and GRANDCHILD (parent=CHILD). */
function twoDeepDescendants(): Readonly<{
  child: Readonly<{
    nodeId: TaskNodeId;
    parentNodeId: TaskNodeId;
    workingCopyId: string;
    jjChangeId: ContentHash;
    currentCommitId: GitSha;
  }>;
  grandchild: Readonly<{
    nodeId: TaskNodeId;
    parentNodeId: TaskNodeId;
    workingCopyId: string;
    jjChangeId: ContentHash;
    currentCommitId: GitSha;
  }>;
}> {
  return {
    child: {
      nodeId: CHILD_NODE_ID,
      parentNodeId: PARENT_NODE_ID,
      workingCopyId: CHILD_WC,
      jjChangeId: CHILD_CHANGE,
      currentCommitId: commit(21),
    },
    grandchild: {
      nodeId: GRANDCHILD_NODE_ID,
      parentNodeId: CHILD_NODE_ID,
      workingCopyId: GRANDCHILD_WC,
      jjChangeId: GRANDCHILD_CHANGE,
      currentCommitId: commit(22),
    },
  };
}

// -------------------------------------------------------------------------------------------------
// Local store helpers.
// -------------------------------------------------------------------------------------------------

async function seedBinding(value: VcsChangeBinding): Promise<void> {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  await createSqliteVcsChangeBindingStore({ database: temporary.database }).upsertBinding(value);
}

async function bindingFor(nodeId: TaskNodeId): Promise<VcsChangeBinding | undefined> {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createSqliteVcsChangeBindingStore({ database: temporary.database }).getBinding(
    TREE_ID,
    nodeId,
  );
}

// -------------------------------------------------------------------------------------------------
// Clean restack.
// -------------------------------------------------------------------------------------------------

describe("restack: clean restack rebases parent-first and updates bindings", () => {
  it("restacks each descendant cleanly, advances rewrite generation, and returns a receipt", async () => {
    const workingCopy = new FakeWorkingCopy({ commitSeed: 100 });
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    await seedBinding(
      binding(GRANDCHILD_NODE_ID, { currentCommitId: commit(22), jjChangeId: GRANDCHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy, staleSink: new FakeStaleSink() });

    const receipt = await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child, desc.grandchild],
    });

    expect(receipt.cleanNodes).toHaveLength(2);
    expect(receipt.conflictNodes).toHaveLength(0);
    expect(receipt.abortedNodes).toHaveLength(0);
    expect(receipt.restackedNodes.map((n) => n.nodeId)).toEqual([
      CHILD_NODE_ID,
      GRANDCHILD_NODE_ID,
    ]);

    // Bindings advanced: rewriteGeneration +1, currentCommitId is the fresh commit.
    const childBinding = await bindingFor(CHILD_NODE_ID);
    const grandchildBinding = await bindingFor(GRANDCHILD_NODE_ID);
    expect(childBinding?.rewriteGeneration).toBe(1);
    expect(childBinding?.currentCommitId).toBe(commit(100));
    expect(childBinding?.conflictState).toBe("clean");
    expect(grandchildBinding?.rewriteGeneration).toBe(1);
    expect(grandchildBinding?.currentCommitId).toBe(commit(102));
    // GRANDCHILD stacked on CHILD's fresh commit (parent-first).
    expect(workingCopy.rebaseCalls[1]?.newParentCommit).toBe(commit(100));
  });

  it("restacks parent-first regardless of the input order", async () => {
    const workingCopy = new FakeWorkingCopy({ commitSeed: 200 });
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    await seedBinding(
      binding(GRANDCHILD_NODE_ID, { currentCommitId: commit(22), jjChangeId: GRANDCHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy });

    // Input order is reversed (grandchild before child); restack must still go child-first.
    await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.grandchild, desc.child],
    });

    expect(workingCopy.rebaseCalls.map((c) => c.workingCopyId)).toEqual([CHILD_WC, GRANDCHILD_WC]);
  });
});

// -------------------------------------------------------------------------------------------------
// Stale invalidation.
// -------------------------------------------------------------------------------------------------
describe("restack: stale gate + review invalidation", () => {
  it("reports every restacked node to the stale sink (skips aborted)", async () => {
    const workingCopy = new FakeWorkingCopy({ commitSeed: 100 });
    const stale = new FakeStaleSink();
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    await seedBinding(
      binding(GRANDCHILD_NODE_ID, { currentCommitId: commit(22), jjChangeId: GRANDCHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy, staleSink: stale });

    await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child, desc.grandchild],
    });

    expect(stale.invalidations).toHaveLength(1);
    expect(stale.invalidations[0]?.slice().sort()).toEqual(
      [CHILD_NODE_ID, GRANDCHILD_NODE_ID].sort(),
    );
  });
});

// -------------------------------------------------------------------------------------------------
// Textual conflict.
// -------------------------------------------------------------------------------------------------

describe("restack: textual conflict produces a ConflictBundle and durable conflict state", () => {
  it("detects textual markers, records conflict-as-commit, and escalates without a harness", async () => {
    const workingCopy = new FakeWorkingCopy({
      rebase: {
        [CHILD_WC]: { kind: "textual_conflict", paths: ["src/conflicted.ts"] },
      },
      diffText:
        "diff --git a/src/conflicted.ts b/src/conflicted.ts\n<<<<<<<\nours\n=======\ntheirs\n>>>>>>>\n",
      commitSeed: 100,
    });
    const attention = new FakeAttentionSink();
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    await seedBinding(
      binding(GRANDCHILD_NODE_ID, { currentCommitId: commit(22), jjChangeId: GRANDCHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy, attentionSink: attention });

    const receipt = await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child, desc.grandchild],
    });

    // CHILD is conflicted; GRANDCHILD aborted (cannot stack on a conflicted parent).
    const childResult = receipt.restackedNodes.find((n) => n.nodeId === CHILD_NODE_ID);
    expect(childResult?.outcome).toBe("conflict");
    const conflict: ConflictBundle | undefined = childResult?.conflict;
    expect(conflict).toBeDefined();
    expect(conflict?.kind).toBe("textual");
    expect(conflict?.ancestryValid).toBe(true);
    expect(conflict?.conflictMarkers.length).toBeGreaterThan(0);
    expect(conflict?.conflictMarkers[0]?.path).toBe("src/conflicted.ts");
    expect(receipt.conflictNodes.map((n) => n.nodeId)).toEqual([CHILD_NODE_ID]);
    expect(receipt.abortedNodes.map((n) => n.nodeId)).toEqual([GRANDCHILD_NODE_ID]);

    // Durable conflict state: binding is conflict, generation advanced.
    const childBinding = await bindingFor(CHILD_NODE_ID);
    expect(childBinding?.conflictState).toBe("conflict");
    expect(childBinding?.rewriteGeneration).toBe(1);

    // Typed human attention emitted (no harness).
    expect(attention.attentions).toHaveLength(1);
    expect(attention.attentions[0]?.kind).toBe("no_harness");
    expect(attention.attentions[0]?.preservedWorkingCopyId).toBe(CHILD_WC);
  });
});

// -------------------------------------------------------------------------------------------------
// Semantic conflict.
// -------------------------------------------------------------------------------------------------

describe("restack: semantic conflict (no textual markers) produces a ConflictBundle", () => {
  it("classifies a marker-free conflict with semantic paths as semantic", async () => {
    const workingCopy = new FakeWorkingCopy({
      rebase: {
        [CHILD_WC]: { kind: "semantic_conflict", paths: ["src/renamed.ts"] },
      },
      // No textual markers in the diff.
      diffText: "diff --git a/src/renamed.ts b/src/renamed.ts\n+renamed content\n",
      commitSeed: 100,
    });
    const attention = new FakeAttentionSink();
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy, attentionSink: attention });

    const receipt = await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child],
    });

    const childResult = receipt.restackedNodes[0];
    expect(childResult?.outcome).toBe("conflict");
    expect(childResult?.conflict?.kind).toBe("semantic");
    expect(childResult?.conflict?.conflictMarkers).toHaveLength(0);
    expect(childResult?.conflict?.conflictingPaths).toEqual(["src/renamed.ts"]);
  });
});

// -------------------------------------------------------------------------------------------------
// Repair success.
// -------------------------------------------------------------------------------------------------

describe("restack: bounded repair resolves a conflict, squashes, and verifies ancestry", () => {
  it("repairs on the first attempt, squashes the resolution, and marks the node repaired", async () => {
    const workingCopy = new FakeWorkingCopy({
      rebase: { [CHILD_WC]: { kind: "textual_conflict", paths: ["src/x.ts"] } },
      diffText: "diff --git a/src/x.ts b/src/x.ts\n<<<<<<<\na\n=======\nb\n>>>>>>>\n",
      commitSeed: 100,
      squashCommit: commit(250),
    });
    const harness = new FakeRepairHarness(1);
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    await seedBinding(
      binding(GRANDCHILD_NODE_ID, { currentCommitId: commit(22), jjChangeId: GRANDCHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy, repairHarness: harness });

    const receipt = await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child, desc.grandchild],
    });

    const childResult = receipt.restackedNodes.find((n) => n.nodeId === CHILD_NODE_ID);
    expect(childResult?.outcome).toBe("repaired");
    expect(childResult?.newCommitId).toBe(commit(250));
    expect(harness.attempts).toHaveLength(1);
    expect(workingCopy.squashCalls).toHaveLength(1);

    // Binding transitioned conflict -> resolved; generation advanced.
    const childBinding = await bindingFor(CHILD_NODE_ID);
    expect(childBinding?.conflictState).toBe("resolved");
    expect(childBinding?.currentCommitId).toBe(commit(250));
    expect(childBinding?.rewriteGeneration).toBe(2);

    // GRANDCHILD restacked cleanly on CHILD's repaired commit.
    const grandchildResult = receipt.restackedNodes.find((n) => n.nodeId === GRANDCHILD_NODE_ID);
    expect(grandchildResult?.outcome).toBe("clean");
    expect(receipt.cleanNodes.map((n) => n.nodeId)).toEqual([CHILD_NODE_ID, GRANDCHILD_NODE_ID]);
  });
});

// -------------------------------------------------------------------------------------------------
// Repair exhausted.
// -------------------------------------------------------------------------------------------------

describe("restack: exhausted repair becomes typed human attention with the workspace preserved", () => {
  it("attempts to the budget ceiling, then escalates and preserves the workspace", async () => {
    const workingCopy = new FakeWorkingCopy({
      rebase: { [CHILD_WC]: { kind: "textual_conflict", paths: ["src/x.ts"] } },
      diffText: "diff --git a/src/x.ts b/src/x.ts\n<<<<<<<\na\n=======\nb\n>>>>>>>\n",
      commitSeed: 100,
    });
    // Never resolves.
    const harness = new FakeRepairHarness(undefined);
    const attention = new FakeAttentionSink();
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    const restack = coordinator({
      workingCopy,
      repairHarness: harness,
      attentionSink: attention,
      repairCeiling: 2,
    });

    const receipt = await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child],
    });

    const childResult = receipt.restackedNodes[0];
    expect(childResult?.outcome).toBe("exhausted");
    expect(harness.attempts).toHaveLength(2);

    // Durable conflict-as-commit; export blocked.
    const childBinding = await bindingFor(CHILD_NODE_ID);
    expect(childBinding?.conflictState).toBe("conflict");

    // Typed human attention with the workspace preserved.
    expect(attention.attentions).toHaveLength(1);
    expect(attention.attentions[0]?.kind).toBe("repair_exhausted");
    expect(attention.attentions[0]?.attempts).toBe(2);
    expect(attention.attentions[0]?.preservedWorkingCopyId).toBe(CHILD_WC);
  });
});

// -------------------------------------------------------------------------------------------------
// Multi-parent rejection.
// -------------------------------------------------------------------------------------------------

describe("restack: multi-parent (merge/fan-in) rejection", () => {
  it("throws multi_parent_detected when a rebase produces more than one parent", async () => {
    const workingCopy = new FakeWorkingCopy({
      rebase: { [CHILD_WC]: { kind: "multi_parent", parentCount: 2 } },
      commitSeed: 100,
    });
    const attention = new FakeAttentionSink();
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy, attentionSink: attention });

    await expect(
      restack.restack({
        treeId: TREE_ID,
        parentNodeId: PARENT_NODE_ID,
        newParentCommit: NEW_PARENT_COMMIT,
        descendants: [desc.child],
      }),
    ).rejects.toMatchObject({ name: "RestackError", code: "multi_parent_detected" });

    // The multi-parent conflict was recorded as durable state before the throw.
    expect(attention.attentions[0]?.kind).toBe("multi_parent");
  });

  it("assertExportReady blocks export for a conflicted binding", async () => {
    const workingCopy = new FakeWorkingCopy({
      rebase: { [CHILD_WC]: { kind: "textual_conflict", paths: ["src/x.ts"] } },
      diffText: "<<<<<<<\na\n=======\nb\n>>>>>>>\n",
      commitSeed: 100,
    });
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy });

    await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child],
    });

    // CHILD is conflicted → export blocked.
    await expect(restack.assertExportReady(TREE_ID, [CHILD_NODE_ID])).rejects.toMatchObject({
      name: "RestackError",
      code: "export_blocked",
    });

    // A clean sibling does not block.
    await seedBinding(
      binding(SIBLING_NODE_ID, {
        currentCommitId: commit(31),
        jjChangeId: SIBLING_CHANGE,
        conflictState: "clean",
      }),
    );
    await expect(restack.assertExportReady(TREE_ID, [SIBLING_NODE_ID])).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------
// Crash recovery.
// -------------------------------------------------------------------------------------------------

describe("restack: crash recovery resumes from the last restacked node", () => {
  it("skips already-restacked nodes on retry after a mid-rebase crash", async () => {
    // First run: CHILD restacks cleanly, GRANDCHILD crashes mid-rebase.
    const workingCopy = new FakeWorkingCopy({
      rebase: { [GRANDCHILD_WC]: { kind: "crash", error: "jj crashed" } },
      commitSeed: 100,
    });
    const desc = twoDeepDescendants();
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    await seedBinding(
      binding(GRANDCHILD_NODE_ID, { currentCommitId: commit(22), jjChangeId: GRANDCHILD_CHANGE }),
    );
    const restack = coordinator({ workingCopy });

    const firstReceipt = await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child, desc.grandchild],
    });

    // CHILD clean; GRANDCHILD aborted (crash).
    const firstChild = firstReceipt.restackedNodes.find((n) => n.nodeId === CHILD_NODE_ID);
    const firstGrandchild = firstReceipt.restackedNodes.find(
      (n) => n.nodeId === GRANDCHILD_NODE_ID,
    );
    expect(firstChild?.outcome).toBe("clean");
    expect(firstGrandchild?.outcome).toBe("aborted");
    expect(firstReceipt.abortedNodes.map((n) => n.nodeId)).toEqual([GRANDCHILD_NODE_ID]);
    // CHILD's binding advanced despite the crash on GRANDCHILD.
    expect((await bindingFor(CHILD_NODE_ID))?.currentCommitId).toBe(commit(100));

    // Second run: the crash is gone. CHILD is already restacked (binding advanced
    // off the pre-restack commit) → skipped; GRANDCHILD resumes on CHILD's commit.
    workingCopy.reconfigure({ commitSeed: 200 });
    const secondReceipt = await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [desc.child, desc.grandchild],
    });

    // Only GRANDCHILD was rebased on the second run; CHILD was skipped.
    expect(workingCopy.rebaseCalls.filter((c) => c.workingCopyId === CHILD_WC)).toHaveLength(1);
    expect(workingCopy.rebaseCalls.filter((c) => c.workingCopyId === GRANDCHILD_WC)).toHaveLength(
      2,
    );
    const secondGrandchild = secondReceipt.restackedNodes.find(
      (n) => n.nodeId === GRANDCHILD_NODE_ID,
    );
    expect(secondGrandchild?.outcome).toBe("clean");
    // GRANDCHILD stacked on CHILD's first-run commit (resume continued the chain).
    expect(workingCopy.rebaseCalls[workingCopy.rebaseCalls.length - 1]?.newParentCommit).toBe(
      commit(100),
    );
  });
});

// -------------------------------------------------------------------------------------------------
// Subtree ordering (deep).
// -------------------------------------------------------------------------------------------------

describe("restack: subtree ordering across a three-deep chain", () => {
  it("restacks root-first, then child, then grandchild", async () => {
    const workingCopy = new FakeWorkingCopy({ commitSeed: 300 });
    const restack = coordinator({ workingCopy });
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(21), jjChangeId: CHILD_CHANGE }),
    );
    await seedBinding(
      binding(GRANDCHILD_NODE_ID, { currentCommitId: commit(22), jjChangeId: GRANDCHILD_CHANGE }),
    );
    await seedBinding(
      binding(SIBLING_NODE_ID, { currentCommitId: commit(23), jjChangeId: SIBLING_CHANGE }),
    );

    // A three-deep chain: SIBLING -> CHILD -> PARENT, plus GRANDCHILD -> CHILD.
    await restack.restack({
      treeId: TREE_ID,
      parentNodeId: PARENT_NODE_ID,
      newParentCommit: NEW_PARENT_COMMIT,
      descendants: [
        {
          nodeId: GRANDCHILD_NODE_ID,
          parentNodeId: CHILD_NODE_ID,
          workingCopyId: GRANDCHILD_WC,
          jjChangeId: GRANDCHILD_CHANGE,
          currentCommitId: commit(22),
        },
        {
          nodeId: SIBLING_NODE_ID,
          parentNodeId: CHILD_NODE_ID,
          workingCopyId: SIBLING_WC,
          jjChangeId: SIBLING_CHANGE,
          currentCommitId: commit(23),
        },
        {
          nodeId: CHILD_NODE_ID,
          parentNodeId: PARENT_NODE_ID,
          workingCopyId: CHILD_WC,
          jjChangeId: CHILD_CHANGE,
          currentCommitId: commit(21),
        },
      ],
    });

    // CHILD (depth 0) is rebased before both its descendants.
    const order = workingCopy.rebaseCalls.map((c) => c.workingCopyId);
    const childIdx = order.indexOf(CHILD_WC);
    const grandchildIdx = order.indexOf(GRANDCHILD_WC);
    const siblingIdx = order.indexOf(SIBLING_WC);
    expect(childIdx).toBeLessThan(grandchildIdx);
    expect(childIdx).toBeLessThan(siblingIdx);
    expect(order[0]).toBe(CHILD_WC);
  });
});

// -------------------------------------------------------------------------------------------------
// Pure helpers (smoke coverage through the public core barrel).
// -------------------------------------------------------------------------------------------------

describe("restack pure helpers", () => {
  it("validateAncestry rejects multi-parent and accepts single-parent", () => {
    expect(
      validateAncestry({
        nodeId: CHILD_NODE_ID,
        parentCount: 1,
        parentCommitIds: [NEW_PARENT_COMMIT],
      }).valid,
    ).toBe(true);
    expect(
      validateAncestry({
        nodeId: CHILD_NODE_ID,
        parentCount: 2,
        parentCommitIds: [NEW_PARENT_COMMIT, NEW_PARENT_COMMIT],
      }).valid,
    ).toBe(false);
    expect(
      validateAncestry({ nodeId: CHILD_NODE_ID, parentCount: 0, parentCommitIds: [] }).valid,
    ).toBe(false);
  });

  it("invalidateStaleGates skips aborted nodes", () => {
    const nodes: readonly RestackNodeResult[] = Object.freeze([
      Object.freeze({
        nodeId: CHILD_NODE_ID,
        outcome: "clean",
        conflict: undefined,
        newCommitId: undefined,
        newChangeId: undefined,
        rewriteGeneration: undefined,
      }),
      Object.freeze({
        nodeId: GRANDCHILD_NODE_ID,
        outcome: "aborted",
        conflict: undefined,
        newCommitId: undefined,
        newChangeId: undefined,
        rewriteGeneration: undefined,
      }),
      Object.freeze({
        nodeId: SIBLING_NODE_ID,
        outcome: "exhausted",
        conflict: undefined as never,
        newCommitId: undefined,
        newChangeId: undefined,
        rewriteGeneration: undefined,
      }),
    ]);
    expect(invalidateStaleGates(nodes)).toEqual([CHILD_NODE_ID, SIBLING_NODE_ID]);
  });
});
