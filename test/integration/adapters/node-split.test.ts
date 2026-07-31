import {
  contentHash,
  gitSha,
  nonEmptyText,
  planRevisionId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type ContentHash,
  type ExistingTreeNode,
  type GitSha,
  type PlanRevisionId,
  type SplitProposal,
  type SplitSegment,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
} from "@minions/core";
import {
  changeIdFingerprint,
  createSplitCoordinator,
  createSqliteVcsChangeBindingStore,
  type SplitChildRecord,
  type SplitCoordinator,
  type SplitError,
  type SplitPlanRegistry,
  type SplitSegmentReceipt,
  type SplitWorkingCopy,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * PR 40 — plan repair via split.
 *
 * Decomposes an oversized node into N reviewable child changes via jj split:
 * each segment's fileset/hunk-ranges become a new child change (one parent each),
 * the split is recorded as a plan revision, and the bindings are updated so the
 * task tree and the change tree stay in sync (TREE-07, TREE-09).
 *
 * The working-copy broker is a test double (mocked jj split); the binding store
 * is the real SQLite implementation; the plan registry is an in-memory test
 * double that records the split + mints a plan revision id.
 */

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000040");
const ORIGIN_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000041");
const CHILD_A_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000042");
const CHILD_B_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000043");
const CHILD_C_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000044");

/** Raw 32-char jj change ids. */
const ORIGIN_CHANGE_RAW = "a1".repeat(16);
const CHILD_A_CHANGE_RAW = "b2".repeat(16);
const CHILD_B_CHANGE_RAW = "c3".repeat(16);
const CHILD_C_CHANGE_RAW = "d4".repeat(16);

const fp = (rawChangeId: string): ContentHash => changeIdFingerprint(rawChangeId);
const ORIGIN_CHANGE = fp(ORIGIN_CHANGE_RAW);
const CHILD_A_CHANGE = fp(CHILD_A_CHANGE_RAW);
const CHILD_B_CHANGE = fp(CHILD_B_CHANGE_RAW);
const CHILD_C_CHANGE = fp(CHILD_C_CHANGE_RAW);

/** Repeat a numeric seed's hex unit to exactly `length` lowercase-hex chars. */
function hexRun(seed: number, length: number): string {
  const unit = (seed % 256).toString(16).padStart(2, "0");
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

const commit = (seed: number): GitSha => gitSha(hexRun(seed, 40));
const op = (seed: number): ContentHash => contentHash(hexRun(seed + 128, 64));

const ORIGIN_COMMIT = commit(1);
const CHILD_A_COMMIT = commit(11);
const CHILD_B_COMMIT = commit(12);
const CHILD_C_COMMIT = commit(13);
const SPLIT_OP_A = op(50);
const SPLIT_OP_B = op(51);
const SPLIT_OP_C = op(52);
const PLAN_REVISION = planRevisionId("01900000-0000-7000-8000-000000000099");

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
// Segment helpers.
// -------------------------------------------------------------------------------------------------

function segment(label: string, files: readonly string[]): SplitSegment {
  return Object.freeze({ label: nonEmptyText(label, "segment label"), fileset: files });
}

/** A standard two-segment proposal for the origin node. */
function twoSegmentProposal(): SplitProposal {
  return Object.freeze({
    nodeId: ORIGIN_NODE_ID,
    treeId: TREE_ID,
    splits: [
      segment("frontend", ["src/ui.ts", "src/styles.css"]),
      segment("backend", ["src/api.ts", "src/db.ts"]),
    ],
  });
}

/** A three-segment proposal for the origin node. */
function threeSegmentProposal(): SplitProposal {
  return Object.freeze({
    nodeId: ORIGIN_NODE_ID,
    treeId: TREE_ID,
    splits: [
      segment("frontend", ["src/ui.ts"]),
      segment("backend", ["src/api.ts"]),
      segment("tests", ["src/api.test.ts"]),
    ],
  });
}

// -------------------------------------------------------------------------------------------------
// Fake working-copy broker.
// -------------------------------------------------------------------------------------------------

interface FakeWorkingCopyConfig {
  /**
   * Scripted receipts, one per segment (in order). Defaults to clean
   * single-parent receipts with distinct change ids per segment index.
   */
  readonly receipts?: readonly SplitSegmentReceipt[];
  /** If set, the split for the given segment index rejects with this error. */
  readonly splitError?: { readonly segmentIndex: number; readonly error: Error };
  /** Override the parent count on every receipt (for multi-parent tests). */
  readonly parentCountOverride?: number;
}

class FakeWorkingCopy implements SplitWorkingCopy {
  readonly splitCalls: Readonly<{
    readonly originalChangeId: ContentHash;
    readonly segment: SplitSegment;
    readonly segmentIndex: number;
  }>[] = [];
  readonly #config: FakeWorkingCopyConfig;

  constructor(config: FakeWorkingCopyConfig = {}) {
    this.#config = config;
  }

  splitSegment(
    originalChangeId: ContentHash,
    segment: SplitSegment,
    segmentIndex: number,
  ): Promise<SplitSegmentReceipt> {
    (this.splitCalls as object[]).push(Object.freeze({ originalChangeId, segment, segmentIndex }));
    if (
      this.#config.splitError !== undefined &&
      this.#config.splitError.segmentIndex === segmentIndex
    ) {
      return Promise.reject(this.#config.splitError.error);
    }
    const defaultReceipts: readonly SplitSegmentReceipt[] = [
      defaultReceipt(0),
      defaultReceipt(1),
      defaultReceipt(2),
    ];
    const scripted = this.#config.receipts?.[segmentIndex];
    const base = scripted ?? defaultReceipts[segmentIndex];
    if (base === undefined) {
      return Promise.reject(new Error(`no scripted receipt for segment ${String(segmentIndex)}`));
    }
    const receipt =
      this.#config.parentCountOverride !== undefined
        ? Object.freeze({ ...base, parentCount: this.#config.parentCountOverride })
        : base;
    return Promise.resolve(receipt);
  }
}

function defaultReceipt(segmentIndex: number): SplitSegmentReceipt {
  const changeIds = [CHILD_A_CHANGE, CHILD_B_CHANGE, CHILD_C_CHANGE];
  const commits = [CHILD_A_COMMIT, CHILD_B_COMMIT, CHILD_C_COMMIT];
  const ops = [SPLIT_OP_A, SPLIT_OP_B, SPLIT_OP_C];
  return Object.freeze({
    segmentIndex,
    changeId: changeIds[segmentIndex] ?? CHILD_A_CHANGE,
    commit: commits[segmentIndex] ?? CHILD_A_COMMIT,
    parentCount: 1,
    operationLogId: ops[segmentIndex] ?? SPLIT_OP_A,
  });
}

// -------------------------------------------------------------------------------------------------
// In-memory plan registry test double.
// -------------------------------------------------------------------------------------------------

interface FakePlanRegistryConfig {
  readonly approved?: boolean;
  readonly existing?: readonly ExistingTreeNode[];
  readonly recordSplitError?: Error;
}

class FakePlanRegistry implements SplitPlanRegistry {
  readonly recordSplitCalls: readonly {
    readonly treeId: TaskTreeId;
    readonly originalNodeId: TaskNodeId;
    readonly children: readonly SplitChildRecord[];
  }[] = [];
  readonly #config: FakePlanRegistryConfig;

  constructor(config: FakePlanRegistryConfig = {}) {
    this.#config = config;
  }

  getNode(_treeId: TaskTreeId, nodeId: TaskNodeId): Promise<ExistingTreeNode | undefined> {
    const existing = this.#config.existing?.find((node) => node.nodeId === nodeId);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return Promise.resolve(
      Object.freeze({
        nodeId,
        depth: 0,
        approved: this.#config.approved === true,
      }),
    );
  }

  recordSplit(input: {
    readonly treeId: TaskTreeId;
    readonly originalNodeId: TaskNodeId;
    readonly children: readonly SplitChildRecord[];
  }): Promise<{ readonly planRevisionId: PlanRevisionId }> {
    (this.recordSplitCalls as object[]).push(Object.freeze({ ...input }));
    if (this.#config.recordSplitError !== undefined) {
      return Promise.reject(this.#config.recordSplitError);
    }
    return Promise.resolve(Object.freeze({ planRevisionId: PLAN_REVISION }));
  }
}

// -------------------------------------------------------------------------------------------------
// Harness: fresh host database + split coordinator per test.
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

function coordinator(
  workingCopy: FakeWorkingCopy,
  planRegistry: FakePlanRegistry,
  ids: readonly string[] = [CHILD_A_NODE_ID, CHILD_B_NODE_ID, CHILD_C_NODE_ID],
): SplitCoordinator {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createSplitCoordinator({
    workingCopy,
    bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
    planRegistry,
    clock,
    ids: new SequenceIdGenerator(ids),
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

/** Seed the origin node binding. */
async function seedOrigin(): Promise<void> {
  await seedBinding(
    binding(ORIGIN_NODE_ID, {
      jjChangeId: ORIGIN_CHANGE,
      currentCommitId: ORIGIN_COMMIT,
      parentChangeId: undefined,
    }),
  );
}

function isSplitError(value: unknown): value is SplitError {
  return value instanceof Error && value.name === "SplitError";
}

// -------------------------------------------------------------------------------------------------
// executeSplit — success path: 2 segments.
// -------------------------------------------------------------------------------------------------

describe("split: 2 segments -> 2 child nodes + plan revision + bindings", () => {
  it("splits the origin into two children, each a single-parent child of the origin", async () => {
    await seedOrigin();
    const workingCopy = new FakeWorkingCopy();
    const planRegistry = new FakePlanRegistry();

    const plan = await coordinator(workingCopy, planRegistry).executeSplit(twoSegmentProposal());

    // Two resulting nodes, one parent each, parent = origin, depth = 1.
    expect(plan.resultingNodes).toHaveLength(2);
    for (const node of plan.resultingNodes) {
      expect(node.parentNodeId).toBe(ORIGIN_NODE_ID);
      expect(node.depth).toBe(1);
    }
    expect(plan.resultingNodes[0]?.changeId).toBe(CHILD_A_CHANGE);
    expect(plan.resultingNodes[1]?.changeId).toBe(CHILD_B_CHANGE);
    expect(plan.resultingNodes[0]?.nodeId).toBe(CHILD_A_NODE_ID);
    expect(plan.resultingNodes[1]?.nodeId).toBe(CHILD_B_NODE_ID);
    expect(plan.planRevisionId).toBe(PLAN_REVISION);

    // The broker was called once per segment on the origin change.
    expect(workingCopy.splitCalls).toHaveLength(2);
    expect(workingCopy.splitCalls[0]?.originalChangeId).toBe(ORIGIN_CHANGE);
    expect(workingCopy.splitCalls[0]?.segmentIndex).toBe(0);
    expect(workingCopy.splitCalls[1]?.segmentIndex).toBe(1);
  });

  it("records the split as a plan revision (original + children + filesets)", async () => {
    await seedOrigin();
    const planRegistry = new FakePlanRegistry();
    await coordinator(new FakeWorkingCopy(), planRegistry).executeSplit(twoSegmentProposal());

    expect(planRegistry.recordSplitCalls).toHaveLength(1);
    const record = planRegistry.recordSplitCalls[0];
    expect(record?.treeId).toBe(TREE_ID);
    expect(record?.originalNodeId).toBe(ORIGIN_NODE_ID);
    expect(record?.children).toHaveLength(2);
    expect(record?.children[0]?.label).toBe("frontend");
    expect(record?.children[0]?.fileset).toStrictEqual(["src/ui.ts", "src/styles.css"]);
    expect(record?.children[0]?.changeId).toBe(CHILD_A_CHANGE);
    expect(record?.children[1]?.label).toBe("backend");
    expect(record?.children[1]?.fileset).toStrictEqual(["src/api.ts", "src/db.ts"]);
  });

  it("creates a child binding per segment (new change id, parent = origin change id)", async () => {
    await seedOrigin();
    await coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).executeSplit(
      twoSegmentProposal(),
    );

    const childA = await readBinding(CHILD_A_NODE_ID);
    expect(childA.jjChangeId).toBe(CHILD_A_CHANGE);
    expect(childA.currentCommitId).toBe(CHILD_A_COMMIT);
    expect(childA.parentChangeId).toBe(ORIGIN_CHANGE);
    expect(childA.rewriteGeneration).toBe(0);
    expect(childA.conflictState).toBe("clean");

    const childB = await readBinding(CHILD_B_NODE_ID);
    expect(childB.jjChangeId).toBe(CHILD_B_CHANGE);
    expect(childB.parentChangeId).toBe(ORIGIN_CHANGE);
  });

  it("leaves the original binding intact (split produces children, not a rewrite)", async () => {
    await seedOrigin();
    await coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).executeSplit(
      twoSegmentProposal(),
    );

    const origin = await readBinding(ORIGIN_NODE_ID);
    expect(origin.jjChangeId).toBe(ORIGIN_CHANGE);
    expect(origin.currentCommitId).toBe(ORIGIN_COMMIT);
    expect(origin.rewriteGeneration).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// executeSplit — success path: 3 segments.
// -------------------------------------------------------------------------------------------------

describe("split: 3 segments -> 3 child nodes", () => {
  it("splits the origin into three children, one parent each", async () => {
    await seedOrigin();
    const workingCopy = new FakeWorkingCopy();
    const plan = await coordinator(workingCopy, new FakePlanRegistry()).executeSplit(
      threeSegmentProposal(),
    );

    expect(plan.resultingNodes).toHaveLength(3);
    expect(workingCopy.splitCalls).toHaveLength(3);
    for (const node of plan.resultingNodes) {
      expect(node.parentNodeId).toBe(ORIGIN_NODE_ID);
      expect(node.depth).toBe(1);
    }
    expect(plan.resultingNodes[2]?.changeId).toBe(CHILD_C_CHANGE);

    const childC = await readBinding(CHILD_C_NODE_ID);
    expect(childC.jjChangeId).toBe(CHILD_C_CHANGE);
    expect(childC.parentChangeId).toBe(ORIGIN_CHANGE);
  });
});

// -------------------------------------------------------------------------------------------------
// previewSplit — dry-run.
// -------------------------------------------------------------------------------------------------

describe("split preview: dry-run fileset assignment (no broker mutation)", () => {
  it("reports one segment preview per segment with its fileset, no mutation", async () => {
    await seedOrigin();
    const workingCopy = new FakeWorkingCopy();
    const planRegistry = new FakePlanRegistry();

    const preview = await coordinator(workingCopy, planRegistry).previewSplit(twoSegmentProposal());

    expect(preview.resultingNodeCount).toBe(2);
    expect(preview.segments).toHaveLength(2);
    expect(preview.segments[0]?.segmentIndex).toBe(0);
    expect(preview.segments[0]?.label).toBe("frontend");
    expect(preview.segments[0]?.fileset).toStrictEqual(["src/ui.ts", "src/styles.css"]);
    expect(preview.segments[1]?.segmentIndex).toBe(1);
    expect(preview.segments[1]?.fileset).toStrictEqual(["src/api.ts", "src/db.ts"]);

    // Dry-run: no broker or registry mutation.
    expect(workingCopy.splitCalls).toStrictEqual([]);
    expect(planRegistry.recordSplitCalls).toStrictEqual([]);
  });

  it("rejects a structurally invalid proposal before previewing", async () => {
    await seedOrigin();
    await expect(
      coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).previewSplit(
        Object.freeze({
          nodeId: ORIGIN_NODE_ID,
          treeId: TREE_ID,
          splits: [segment("only", ["src/a.ts"])],
        }),
      ),
    ).rejects.toMatchObject({ name: "SplitError", code: "invalid_proposal" });
  });
});

// -------------------------------------------------------------------------------------------------
// node_already_approved — rejected.
// -------------------------------------------------------------------------------------------------

describe("split: approved node rejected without explicit revision approval", () => {
  it("rejects splitting an approved node (TREE-09)", async () => {
    await seedOrigin();
    const planRegistry = new FakePlanRegistry({ approved: true });

    await expect(
      coordinator(new FakeWorkingCopy(), planRegistry).executeSplit(twoSegmentProposal()),
    ).rejects.toMatchObject({ name: "SplitError", code: "node_already_approved" });

    // No broker mutation occurred.
    expect(planRegistry.recordSplitCalls).toStrictEqual([]);
  });

  it("permits splitting an approved node with explicit revision approval", async () => {
    await seedOrigin();
    const planRegistry = new FakePlanRegistry({ approved: true });

    const plan = await coordinator(new FakeWorkingCopy(), planRegistry).executeSplit(
      twoSegmentProposal(),
      { explicitRevisionApproval: true },
    );

    expect(plan.resultingNodes).toHaveLength(2);
    expect(planRegistry.recordSplitCalls).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------------
// invalid_proposal — empty / overlapping / single-segment.
// -------------------------------------------------------------------------------------------------

describe("split: invalid proposals rejected", () => {
  it("rejects an empty split list", async () => {
    await seedOrigin();
    await expect(
      coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).executeSplit(
        Object.freeze({ nodeId: ORIGIN_NODE_ID, treeId: TREE_ID, splits: [] }),
      ),
    ).rejects.toMatchObject({ name: "SplitError", code: "invalid_proposal" });
  });

  it("rejects a single-segment split (no-op)", async () => {
    await seedOrigin();
    await expect(
      coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).executeSplit(
        Object.freeze({
          nodeId: ORIGIN_NODE_ID,
          treeId: TREE_ID,
          splits: [segment("only", ["src/a.ts"])],
        }),
      ),
    ).rejects.toMatchObject({ name: "SplitError", code: "invalid_proposal" });
  });

  it("rejects overlapping filesets across segments", async () => {
    await seedOrigin();
    await expect(
      coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).executeSplit(
        Object.freeze({
          nodeId: ORIGIN_NODE_ID,
          treeId: TREE_ID,
          splits: [
            segment("a", ["src/shared.ts", "src/a.ts"]),
            segment("b", ["src/shared.ts", "src/b.ts"]),
          ],
        }),
      ),
    ).rejects.toMatchObject({ name: "SplitError", code: "invalid_proposal" });
  });

  it("rejects a segment with an empty fileset", async () => {
    await seedOrigin();
    await expect(
      coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).executeSplit(
        Object.freeze({
          nodeId: ORIGIN_NODE_ID,
          treeId: TREE_ID,
          splits: [segment("a", ["src/a.ts"]), segment("b", [])],
        }),
      ),
    ).rejects.toMatchObject({ name: "SplitError", code: "invalid_proposal" });
  });
});

// -------------------------------------------------------------------------------------------------
// node_not_found — unknown node.
// -------------------------------------------------------------------------------------------------

describe("split: unknown node rejected", () => {
  it("rejects a split of a node with no binding + no registry entry", async () => {
    // No seedBinding; the registry returns a default node, but the binding store
    // has nothing. The coordinator resolves the node (registry says it exists),
    // then fails reading the binding as node_not_found.
    await expect(
      coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).executeSplit(twoSegmentProposal()),
    ).rejects.toMatchObject({ name: "SplitError", code: "node_not_found" });
  });

  it("rejects a split when the registry reports the node unknown", async () => {
    const planRegistry = new FakePlanRegistry({
      existing: [],
    });
    // Override getNode to return undefined for the origin.
    planRegistry.getNode = () => Promise.resolve(undefined);
    await expect(
      coordinator(new FakeWorkingCopy(), planRegistry).executeSplit(twoSegmentProposal()),
    ).rejects.toMatchObject({ name: "SplitError", code: "node_not_found" });
  });
});

// -------------------------------------------------------------------------------------------------
// multi_parent_result — rejected.
// -------------------------------------------------------------------------------------------------

describe("split: multi-parent result rejected (GIT-06)", () => {
  it("rejects a child with more than one parent", async () => {
    await seedOrigin();
    const workingCopy = new FakeWorkingCopy({ parentCountOverride: 2 });

    await expect(
      coordinator(workingCopy, new FakePlanRegistry()).executeSplit(twoSegmentProposal()),
    ).rejects.toMatchObject({ name: "SplitError", code: "multi_parent_result" });

    // No plan revision recorded.
    expect(workingCopy.splitCalls).toHaveLength(2);
  });
});

// -------------------------------------------------------------------------------------------------
// split_failed — broker error.
// -------------------------------------------------------------------------------------------------

describe("split: broker failure surfaces split_failed", () => {
  it("surfaces a jj split failure as split_failed", async () => {
    await seedOrigin();
    const workingCopy = new FakeWorkingCopy({
      splitError: { segmentIndex: 1, error: new Error("jj split: conflict") },
    });

    await expect(
      coordinator(workingCopy, new FakePlanRegistry()).executeSplit(twoSegmentProposal()),
    ).rejects.toMatchObject({ name: "SplitError", code: "split_failed" });
  });
});

// -------------------------------------------------------------------------------------------------
// plan_revision_failed — registry error.
// -------------------------------------------------------------------------------------------------

describe("split: plan revision failure surfaces plan_revision_failed", () => {
  it("surfaces a recordSplit failure as plan_revision_failed", async () => {
    await seedOrigin();
    const planRegistry = new FakePlanRegistry({
      recordSplitError: new Error("registry locked"),
    });

    await expect(
      coordinator(new FakeWorkingCopy(), planRegistry).executeSplit(twoSegmentProposal()),
    ).rejects.toMatchObject({ name: "SplitError", code: "plan_revision_failed" });
  });
});

// -------------------------------------------------------------------------------------------------
// SplitError typed surface — usable guard.
// -------------------------------------------------------------------------------------------------

describe("SplitError typed surface", () => {
  it("carries the code + remediation on every invariant breach", async () => {
    await seedOrigin();
    let caught: SplitError | undefined;
    try {
      await coordinator(new FakeWorkingCopy(), new FakePlanRegistry()).executeSplit(
        Object.freeze({ nodeId: ORIGIN_NODE_ID, treeId: TREE_ID, splits: [] }),
      );
    } catch (error: unknown) {
      if (isSplitError(error)) {
        caught = error;
      }
    }
    expect(caught?.code).toBe("invalid_proposal");
    expect(caught?.remediation.length).toBeGreaterThan(0);
  });
});
