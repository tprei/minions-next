import { createHash } from "node:crypto";

import {
  contentHash,
  gitSha,
  nonEmptyText,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type ContentHash,
  type GateCategoryValue,
  type GateReceipt,
  type GateReceiptExpectation,
  type GitSha,
  type NonEmptyText,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
} from "@minions/core";
import {
  createCommitCaptureManager,
  createSqliteVcsChangeBindingStore,
  DETERMINISTIC_ENGINE_IDENTITY,
  type AuthorIdentity,
  type CommitCaptureManager,
  type CommitCaptureWorkingCopy,
  type JjCentralRepo,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * PR 30 — commit capture + child unblock.
 *
 * Captures validated node changes as engine-owned jj commits through the broker,
 * updates the change-id binding, resolves child base revisions across non-commit
 * ancestors, and marks stale descendants after a parent change. Only a locally
 * gated engine-captured commit unblocks commit-dependent children; a no-change
 * node uses the unchanged revision (GIT-02..05, GIT-09).
 *
 * The working-copy broker + task tree are test doubles; the binding store is the
 * real SQLite implementation.
 */

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000012");
const NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000014");
const CHILD_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000021");
const GRANDCHILD_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000022");
const SIBLING_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000023");
const UNRELATED_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000099");

const HEAD_COMMIT = gitSha("a".repeat(40));
const PROFILE_HASH = contentHash("b".repeat(64));
const ENVIRONMENT_DIGEST = contentHash("c".repeat(64));
const LINT_CATEGORY = 1 satisfies GateCategoryValue;
const TYPECHECK_CATEGORY = 2 satisfies GateCategoryValue;

/** A registered working-copy change id (jj change ids are 32 lowercase chars). */
const WORKING_COPY_ID = "0".repeat(32);
const NEW_WORKING_COPY_ID = "1".repeat(32);
const COMMIT_MESSAGE = nonEmptyText("engine-captured change", "commit message");

/** Repeat a numeric seed's hex unit to exactly `length` lowercase-hex chars. */
function hexRun(seed: number, length: number): string {
  const unit = (seed % 256).toString(16).padStart(2, "0");
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

const change = (seed: number): ContentHash => contentHash(hexRun(seed, 64));
const op = (seed: number): ContentHash => contentHash(hexRun(seed + 128, 64));
const commit = (seed: number): GitSha => gitSha(hexRun(seed, 40));

/** SHA-256 fingerprint of a jj change id into the binding's 64-hex identity space. */
const fingerprint = (changeId: string): ContentHash =>
  contentHash(createHash("sha256").update(changeId).digest("hex"));

// -------------------------------------------------------------------------------------------------
// Gate receipt helpers.
// -------------------------------------------------------------------------------------------------

function passingReceipt(
  overrides: Partial<GateReceipt> & { category: GateCategoryValue },
): GateReceipt {
  return Object.freeze({
    gateName: `gate-${String(overrides.category)}`,
    outcome: "passed",
    exitCode: 0,
    durationMs: 0,
    stdoutDigest: contentHash("0".repeat(64)),
    stderrDigest: contentHash("0".repeat(64)),
    headCommit: HEAD_COMMIT,
    profileHash: PROFILE_HASH,
    environmentDigest: ENVIRONMENT_DIGEST,
    capturedAt: timestampFromEpochMilliseconds(BASE_TIME),
    sequence: 1,
    ...overrides,
  });
}

function expectation(
  categories: readonly GateCategoryValue[],
  headCommit: GitSha = HEAD_COMMIT,
): GateReceiptExpectation {
  return Object.freeze({
    bindings: Object.freeze({
      headCommit,
      profileHash: PROFILE_HASH,
      environmentDigest: ENVIRONMENT_DIGEST,
    }),
    requiredCategories: Object.freeze([...categories]),
  });
}

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

interface FakeWorkingCopyConfig {
  /** Live `@` change id reported by `head`. Defaults to WORKING_COPY_ID. */
  liveChangeId?: string;
  /** Live `@-` parent change id reported by `head`. */
  parentChangeId?: string;
  /** Live `@-` parent commit reported by `head` (the expected head). */
  parentCommit?: GitSha;
  /** Whether the working copy reports changes. Defaults to false (dirty). */
  clean?: boolean;
  /** Commit SHA the fake `commit` returns. */
  commitSha?: GitSha;
}

class FakeWorkingCopy implements CommitCaptureWorkingCopy {
  readonly commits: Readonly<{
    workingCopyId: string;
    message: NonEmptyText;
    author: AuthorIdentity;
  }>[] = [];
  readonly operationLogReads: string[] = [];
  readonly statusReads: string[] = [];
  #config: Required<FakeWorkingCopyConfig>;
  #opSeed = 200;

  constructor(config: FakeWorkingCopyConfig = {}) {
    this.#config = {
      liveChangeId: config.liveChangeId ?? WORKING_COPY_ID,
      parentChangeId: config.parentChangeId ?? "2".repeat(32),
      parentCommit: config.parentCommit ?? HEAD_COMMIT,
      clean: config.clean ?? false,
      commitSha: config.commitSha ?? commit(7),
    };
  }

  head(workingCopyId: string) {
    return Promise.resolve(
      Object.freeze({
        workingCopyId,
        workingCopyChangeId: this.#config.liveChangeId,
        parentChangeId: this.#config.parentChangeId,
        parentCommit: this.#config.parentCommit,
        capturedAt: timestampFromEpochMilliseconds(BASE_TIME),
      }),
    );
  }

  status(workingCopyId: string) {
    this.statusReads.push(workingCopyId);
    return Promise.resolve(Object.freeze({ clean: this.#config.clean }));
  }

  commit(workingCopyId: string, message: NonEmptyText, author: AuthorIdentity) {
    this.commits.push({ workingCopyId, message, author });
    return Promise.resolve(
      Object.freeze({
        workingCopyId,
        newWorkingCopyId: NEW_WORKING_COPY_ID,
        parentChangeId: this.#config.parentChangeId,
        commitSha: this.#config.commitSha,
        message,
        committedAt: timestampFromEpochMilliseconds(BASE_TIME),
      }),
    );
  }

  currentOperationLogId(workingCopyId: string) {
    this.operationLogReads.push(workingCopyId);
    const id = op(this.#opSeed);
    this.#opSeed += 1;
    return Promise.resolve(id);
  }
}

// -------------------------------------------------------------------------------------------------
// Fake task tree.
// -------------------------------------------------------------------------------------------------

class FakeTree {
  readonly #parents: Readonly<Record<string, TaskNodeId | null>>;

  constructor(parents: Readonly<Record<string, TaskNodeId | null>>) {
    this.#parents = parents;
  }

  getParentNode(_treeId: TaskTreeId, nodeId: TaskNodeId): TaskNodeId | null {
    return this.#parents[nodeId] ?? null;
  }
}

// -------------------------------------------------------------------------------------------------
// Harness: fresh host database + capture manager per test.
// -------------------------------------------------------------------------------------------------

const clock = new FixedClock(timestampFromEpochMilliseconds(BASE_TIME));

const CENTRAL_REPO: JjCentralRepo = Object.freeze({
  repositoryId: repositoryId("01900000-0000-7000-8000-000000000001"),
  jjRepoPath: "/tmp/minions-central",
  operationLogId: op(50),
  snapshotTrackingLocked: true,
  hooksAbsent: true,
  bootstrappedAt: timestampFromEpochMilliseconds(BASE_TIME),
});

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

function manager(
  workingCopy: FakeWorkingCopy,
  parents: Readonly<Record<string, TaskNodeId | null>>,
): CommitCaptureManager {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createCommitCaptureManager({
    workingCopy,
    bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
    centralRepo: CENTRAL_REPO,
    jjBinaryPath: "/usr/local/bin/jj",
    tree: new FakeTree(parents),
    clock,
    ids: new SequenceIdGenerator(["capture-1", "capture-2", "capture-3", "capture-4"]),
  });
}

// -------------------------------------------------------------------------------------------------
// captureCommit.
// -------------------------------------------------------------------------------------------------

describe("commit capture: change node gate-passed", () => {
  it("captures the commit, updates the binding, and returns a receipt", async () => {
    const workingCopy = new FakeWorkingCopy();
    const parents = { [NODE_ID]: null };
    const capture = manager(workingCopy, parents);

    const receipt = await capture.captureCommit({
      treeId: TREE_ID,
      nodeId: NODE_ID,
      workingCopyId: WORKING_COPY_ID,
      expectedHead: HEAD_COMMIT,
      nodeKind: "change",
      message: COMMIT_MESSAGE,
      gateReceipts: [
        passingReceipt({ category: LINT_CATEGORY }),
        passingReceipt({ category: TYPECHECK_CATEGORY }),
      ],
      gateExpectation: expectation([LINT_CATEGORY, TYPECHECK_CATEGORY]),
    });

    expect(receipt.committed).toBe(true);
    expect(receipt.nodeId).toBe(NODE_ID);
    expect(receipt.treeId).toBe(TREE_ID);
    expect(receipt.newCommitId).toBe(commit(7));
    expect(receipt.authorIdentity).toEqual(DETERMINISTIC_ENGINE_IDENTITY);
    expect(receipt.beforeOpId).not.toBe(receipt.afterOpId);

    // Exactly one engine commit flowed through the broker, under the engine identity.
    expect(workingCopy.commits).toHaveLength(1);
    expect(workingCopy.commits[0]?.author).toEqual(DETERMINISTIC_ENGINE_IDENTITY);
    expect(workingCopy.commits[0]?.message).toBe(COMMIT_MESSAGE);

    // The binding now points the node at the fresh engine commit + after-op id.
    const bindings = await captureBindingList();
    expect(bindings).toHaveLength(1);
    const stored = firstBinding(bindings);
    expect(stored.parentChangeId).toBe(fingerprint("2".repeat(32)));
    expect(stored.currentCommitId).toBe(commit(7));
    expect(stored.lastJjOperationId).toBe(receipt.afterOpId);
    expect(stored.conflictState).toBe("clean");
    expect(stored.rewriteGeneration).toBe(0);
  });

  it("preserves rewrite generation when re-capturing an already-bound node", async () => {
    // Seed an existing binding at generation 3 (a prior rewrite) so a clean
    // capture must carry the generation forward, not reset it.
    const workingCopy = new FakeWorkingCopy();
    const capture = manager(workingCopy, { [NODE_ID]: null });
    await seedBinding(
      binding(NODE_ID, {
        currentCommitId: commit(5),
        rewriteGeneration: 3,
        bookmark: nonEmptyText("feat/x", "bookmark"),
      }),
    );

    const receipt = await capture.captureCommit({
      treeId: TREE_ID,
      nodeId: NODE_ID,
      workingCopyId: WORKING_COPY_ID,
      expectedHead: HEAD_COMMIT,
      nodeKind: "change",
      message: COMMIT_MESSAGE,
      gateReceipts: [passingReceipt({ category: LINT_CATEGORY })],
      gateExpectation: expectation([LINT_CATEGORY]),
    });

    expect(receipt.committed).toBe(true);
    const stored = firstBinding(await captureBindingList());
    expect(stored.rewriteGeneration).toBe(3);
    expect(stored.bookmark).toBe("feat/x");
    expect(stored.currentCommitId).toBe(commit(7));
  });
});

describe("commit capture: no-change node uses the unchanged revision", () => {
  it("returns the parent commit without committing", async () => {
    const workingCopy = new FakeWorkingCopy({ parentCommit: commit(9) });
    const capture = manager(workingCopy, { [NODE_ID]: null });

    const receipt = await capture.captureCommit({
      treeId: TREE_ID,
      nodeId: NODE_ID,
      workingCopyId: WORKING_COPY_ID,
      expectedHead: commit(9),
      nodeKind: "no-change",
      message: COMMIT_MESSAGE,
      gateReceipts: [passingReceipt({ category: LINT_CATEGORY, headCommit: commit(9) })],
      gateExpectation: expectation([LINT_CATEGORY], commit(9)),
    });

    // No commit is made; the unchanged parent revision is the result.
    expect(receipt.committed).toBe(false);
    expect(receipt.newCommitId).toBe(commit(9));
    expect(receipt.beforeOpId).toBe(receipt.afterOpId);
    expect(workingCopy.commits).toHaveLength(0);

    // A no-change node carries no binding of its own (resolveChildBase walks past it).
    expect(await captureBindingList()).toHaveLength(0);
  });
});

describe("commit capture: validation rejections (fail-closed)", () => {
  it("rejects with gate_not_passed when no category is unblocked", async () => {
    const workingCopy = new FakeWorkingCopy();
    const capture = manager(workingCopy, { [NODE_ID]: null });

    await expect(
      capture.captureCommit({
        treeId: TREE_ID,
        nodeId: NODE_ID,
        workingCopyId: WORKING_COPY_ID,
        expectedHead: HEAD_COMMIT,
        nodeKind: "change",
        message: COMMIT_MESSAGE,
        gateReceipts: [],
        gateExpectation: expectation([LINT_CATEGORY]),
      }),
    ).rejects.toMatchObject({ name: "CommitCaptureError", code: "gate_not_passed" });

    expect(workingCopy.commits).toHaveLength(0);
  });

  it("rejects with gate_not_passed when a required category only has a failing receipt", async () => {
    const workingCopy = new FakeWorkingCopy();
    const capture = manager(workingCopy, { [NODE_ID]: null });

    await expect(
      capture.captureCommit({
        treeId: TREE_ID,
        nodeId: NODE_ID,
        workingCopyId: WORKING_COPY_ID,
        expectedHead: HEAD_COMMIT,
        nodeKind: "change",
        message: COMMIT_MESSAGE,
        gateReceipts: [
          passingReceipt({ category: LINT_CATEGORY }),
          passingReceipt({ category: TYPECHECK_CATEGORY, outcome: "failed", exitCode: 1 }),
        ],
        gateExpectation: expectation([LINT_CATEGORY, TYPECHECK_CATEGORY]),
      }),
    ).rejects.toMatchObject({ name: "CommitCaptureError", code: "gate_not_passed" });
  });

  it("rejects with agent_commit_detected when the working-copy change id drifted", async () => {
    // The agent committed out-of-band: @ is no longer the registered id.
    const workingCopy = new FakeWorkingCopy({ liveChangeId: NEW_WORKING_COPY_ID });
    const capture = manager(workingCopy, { [NODE_ID]: null });

    await expect(
      capture.captureCommit({
        treeId: TREE_ID,
        nodeId: NODE_ID,
        workingCopyId: WORKING_COPY_ID,
        expectedHead: HEAD_COMMIT,
        nodeKind: "change",
        message: COMMIT_MESSAGE,
        gateReceipts: [passingReceipt({ category: LINT_CATEGORY })],
        gateExpectation: expectation([LINT_CATEGORY]),
      }),
    ).rejects.toMatchObject({ name: "CommitCaptureError", code: "agent_commit_detected" });

    expect(workingCopy.commits).toHaveLength(0);
  });

  it("rejects with unexpected_head when the working copy base moved since the gate", async () => {
    // The base advanced after the gate ran (e.g. a sibling landed); the gate's
    // captured head no longer matches the working copy's parent.
    const workingCopy = new FakeWorkingCopy({ parentCommit: commit(8) });
    const capture = manager(workingCopy, { [NODE_ID]: null });

    await expect(
      capture.captureCommit({
        treeId: TREE_ID,
        nodeId: NODE_ID,
        workingCopyId: WORKING_COPY_ID,
        expectedHead: HEAD_COMMIT,
        nodeKind: "change",
        message: COMMIT_MESSAGE,
        gateReceipts: [passingReceipt({ category: LINT_CATEGORY })],
        gateExpectation: expectation([LINT_CATEGORY]),
      }),
    ).rejects.toMatchObject({ name: "CommitCaptureError", code: "unexpected_head" });

    expect(workingCopy.commits).toHaveLength(0);
  });

  it("rejects with no_change when a change node has nothing to commit", async () => {
    const workingCopy = new FakeWorkingCopy({ clean: true });
    const capture = manager(workingCopy, { [NODE_ID]: null });

    await expect(
      capture.captureCommit({
        treeId: TREE_ID,
        nodeId: NODE_ID,
        workingCopyId: WORKING_COPY_ID,
        expectedHead: HEAD_COMMIT,
        nodeKind: "change",
        message: COMMIT_MESSAGE,
        gateReceipts: [passingReceipt({ category: LINT_CATEGORY })],
        gateExpectation: expectation([LINT_CATEGORY]),
      }),
    ).rejects.toMatchObject({ name: "CommitCaptureError", code: "no_change" });

    expect(workingCopy.commits).toHaveLength(0);
  });

  it("rejects with commit_failed when the broker cannot commit", async () => {
    const failing: CommitCaptureWorkingCopy = {
      head: () =>
        Promise.resolve(
          Object.freeze({
            workingCopyId: WORKING_COPY_ID,
            workingCopyChangeId: WORKING_COPY_ID,
            parentChangeId: "2".repeat(32),
            parentCommit: HEAD_COMMIT,
            capturedAt: timestampFromEpochMilliseconds(BASE_TIME),
          }),
        ),
      status: () => Promise.resolve(Object.freeze({ clean: false })),
      commit: () => Promise.reject(new Error("jj commit exploded")),
      currentOperationLogId: () => Promise.resolve(op(200)),
    };
    const capture = manager(failing as unknown as FakeWorkingCopy, { [NODE_ID]: null });

    await expect(
      capture.captureCommit({
        treeId: TREE_ID,
        nodeId: NODE_ID,
        workingCopyId: WORKING_COPY_ID,
        expectedHead: HEAD_COMMIT,
        nodeKind: "change",
        message: COMMIT_MESSAGE,
        gateReceipts: [passingReceipt({ category: LINT_CATEGORY })],
        gateExpectation: expectation([LINT_CATEGORY]),
      }),
    ).rejects.toMatchObject({ name: "CommitCaptureError", code: "commit_failed" });
  });
});

describe("commit capture: deterministic engine author identity", () => {
  it("attributes the capture to the engine, not the agent", async () => {
    const workingCopy = new FakeWorkingCopy();
    const capture = manager(workingCopy, { [NODE_ID]: null });

    const receipt = await capture.captureCommit({
      treeId: TREE_ID,
      nodeId: NODE_ID,
      workingCopyId: WORKING_COPY_ID,
      expectedHead: HEAD_COMMIT,
      nodeKind: "change",
      message: COMMIT_MESSAGE,
      gateReceipts: [passingReceipt({ category: LINT_CATEGORY })],
      gateExpectation: expectation([LINT_CATEGORY]),
    });

    expect(receipt.authorIdentity).toBe(DETERMINISTIC_ENGINE_IDENTITY);
    expect(receipt.authorIdentity.name).toBe("Minions Engine");
    expect(receipt.authorIdentity.email).toBe("engine@minions.local");
    expect(workingCopy.commits[0]?.author).toBe(DETERMINISTIC_ENGINE_IDENTITY);
  });
});

// -------------------------------------------------------------------------------------------------
// resolveChildBase.
// -------------------------------------------------------------------------------------------------

describe("resolveChildBase: walks non-commit ancestors", () => {
  it("resolves to the nearest committed ancestor's commit", async () => {
    // The direct parent is a committed change node; the grandchild stacks on it.
    const workingCopy = new FakeWorkingCopy();
    const parents = {
      [CHILD_NODE_ID]: NODE_ID,
      [GRANDCHILD_NODE_ID]: CHILD_NODE_ID,
      [NODE_ID]: null,
    };
    const capture = manager(workingCopy, parents);
    await seedBinding(
      binding(NODE_ID, {
        currentCommitId: commit(11),
        jjChangeId: change(11),
        rewriteGeneration: 2,
      }),
    );

    const base = await capture.resolveChildBase(TREE_ID, GRANDCHILD_NODE_ID);

    // The child itself has no binding, so the walk reaches the committed grandparent.
    expect(base.baseNodeId).toBe(NODE_ID);
    expect(base.baseCommitId).toBe(commit(11));
    expect(base.baseChangeId).toBe(change(11));
    expect(base.rewriteGeneration).toBe(2);
  });

  it("rejects with child_base_unresolved when no ancestor is committed", async () => {
    const workingCopy = new FakeWorkingCopy();
    const parents = { [CHILD_NODE_ID]: NODE_ID, [NODE_ID]: null };
    const capture = manager(workingCopy, parents);

    await expect(capture.resolveChildBase(TREE_ID, CHILD_NODE_ID)).rejects.toMatchObject({
      name: "CommitCaptureError",
      code: "child_base_unresolved",
    });
  });

  it("skips an uncommitted (no-binding) parent to reach a committed grandparent", async () => {
    // Parent is a no-change node (no binding); grandparent is committed.
    const workingCopy = new FakeWorkingCopy();
    const parents = {
      [CHILD_NODE_ID]: SIBLING_NODE_ID,
      [SIBLING_NODE_ID]: NODE_ID,
      [NODE_ID]: null,
    };
    const capture = manager(workingCopy, parents);
    await seedBinding(binding(NODE_ID, { currentCommitId: commit(13) }));

    const base = await capture.resolveChildBase(TREE_ID, CHILD_NODE_ID);

    expect(base.baseNodeId).toBe(NODE_ID);
    expect(base.baseCommitId).toBe(commit(13));
  });
});

// -------------------------------------------------------------------------------------------------
// markStaleDescendants.
// -------------------------------------------------------------------------------------------------

describe("markStaleDescendants: flags descendants after a parent rewrite", () => {
  it("marks every bound descendant conflict and leaves non-descendants untouched", async () => {
    const workingCopy = new FakeWorkingCopy();
    // NODE_ID is the rewritten parent; CHILD + GRANDCHILD descend; SIBLING does not.
    const parents = {
      [CHILD_NODE_ID]: NODE_ID,
      [GRANDCHILD_NODE_ID]: CHILD_NODE_ID,
      [SIBLING_NODE_ID]: null,
      [NODE_ID]: null,
      [UNRELATED_NODE_ID]: SIBLING_NODE_ID,
    };
    const capture = manager(workingCopy, parents);
    await seedBinding(binding(NODE_ID, { currentCommitId: commit(1) }));
    await seedBinding(binding(CHILD_NODE_ID, { currentCommitId: commit(2) }));
    await seedBinding(binding(GRANDCHILD_NODE_ID, { currentCommitId: commit(3) }));
    await seedBinding(binding(SIBLING_NODE_ID, { currentCommitId: commit(4) }));
    await seedBinding(binding(UNRELATED_NODE_ID, { currentCommitId: commit(5) }));

    const stale = await capture.markStaleDescendants(TREE_ID, NODE_ID);

    const staleIds = stale.map((entry) => entry.nodeId).sort();
    expect(staleIds).toEqual([CHILD_NODE_ID, GRANDCHILD_NODE_ID]);

    // Each marked descendant was clean before and is now conflict.
    for (const entry of stale) {
      expect(entry.previousConflictState).toBe("clean");
    }

    const byNode = new Map((await captureBindingList()).map((b) => [b.nodeId, b]));
    expect(byNode.get(CHILD_NODE_ID)?.conflictState).toBe("conflict");
    expect(byNode.get(GRANDCHILD_NODE_ID)?.conflictState).toBe("conflict");
    // The rewritten parent and the non-descendants are untouched.
    expect(byNode.get(NODE_ID)?.conflictState).toBe("clean");
    expect(byNode.get(SIBLING_NODE_ID)?.conflictState).toBe("clean");
    expect(byNode.get(UNRELATED_NODE_ID)?.conflictState).toBe("clean");
  });

  it("is idempotent: already-conflict descendants are reported but not re-transitioned", async () => {
    const workingCopy = new FakeWorkingCopy();
    const parents = { [CHILD_NODE_ID]: NODE_ID, [NODE_ID]: null };
    const capture = manager(workingCopy, parents);
    await seedBinding(binding(NODE_ID, { currentCommitId: commit(1) }));
    await seedBinding(
      binding(CHILD_NODE_ID, { currentCommitId: commit(2), conflictState: "conflict" }),
    );

    const stale = await capture.markStaleDescendants(TREE_ID, NODE_ID);

    expect(stale).toHaveLength(1);
    expect(stale[0]?.previousConflictState).toBe("conflict");
    expect(
      (await captureBindingList()).find((b) => b.nodeId === CHILD_NODE_ID)?.conflictState,
    ).toBe("conflict");
  });
});

// -------------------------------------------------------------------------------------------------
// Local store helpers.
// -------------------------------------------------------------------------------------------------

function captureBindingList(): Promise<readonly VcsChangeBinding[]> {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createSqliteVcsChangeBindingStore({ database: temporary.database }).listForTree(TREE_ID);
}

function seedBinding(value: VcsChangeBinding): Promise<void> {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createSqliteVcsChangeBindingStore({ database: temporary.database }).upsertBinding(value);
}

function firstBinding(bindings: readonly VcsChangeBinding[]): VcsChangeBinding {
  const first = bindings[0];
  if (first === undefined) {
    throw new Error("expected at least one binding");
  }
  return first;
}
