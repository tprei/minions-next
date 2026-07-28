/**
 * Split coordinator (PR 40, deliverable 2) — decomposes an oversized node into
 * N reviewable child changes via jj split, as a plan revision.
 *
 * A split of node N produces N child changes (one parent each — the original N),
 * each scoped to a segment of N's fileset. The coordinator:
 *  1. Validates the proposal (reject an approved node without explicit revision
 *     approval — TREE-09: never silently split an approved node; reject empty /
 *     overlapping / single-segment proposals).
 *  2. For each segment: runs `jj split` through the broker with the segment's
 *     fileset/hunk-ranges → a new child change.
 *  3. Verifies one parent per child (jj split semantics + a post-split ancestry
 *     check) — GIT-06: every change has exactly one parent.
 *  4. Mints a task node id per segment and computes the resulting topology.
 *  5. Records the split as a plan revision via the plan registry (so the task
 *     tree + change tree stay in sync).
 *  6. Updates the bindings: each child gets a new binding (new change id,
 *     parent = the original's change id).
 *
 * Composes three PRs behind ports:
 *  - PR 28 (jjWorkingCopyManager): the split surface, abstracted here as
 *    {@link SplitWorkingCopy}. The production wiring wraps a
 *    {@link JjWorkingCopyManager} and adds the split operations through the same
 *    serialized broker.
 *  - PR 29 (bindingStore): the durable {@link VcsChangeBindingStore}.
 *  - PR 09 (planRegistry): the task-tree + plan-revision store, abstracted here
 *    as {@link SplitPlanRegistry}.
 *
 * The coordinator never invokes jj directly; every mutation flows through the
 * injected broker. Fail-closed: every invariant breach surfaces a typed
 * {@link SplitError}.
 */

import {
  computeResultingTopology,
  isValidConflictTransition,
  previewSplit,
  taskNodeId,
  validateSplitProposal,
  type AssignedChildIdentity,
  type Clock,
  type ConflictState,
  type ContentHash,
  type ExistingTreeNode,
  type GitSha,
  type IdGenerator,
  type PlanRevisionId,
  type RewriteGeneration,
  type SplitPlan,
  type SplitPreview,
  type SplitProposal,
  type SplitResultNode,
  type SplitSegment,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type SplitErrorCode =
  | "node_not_found"
  | "node_already_approved"
  | "invalid_proposal"
  | "split_failed"
  | "multi_parent_result"
  | "binding_update_failed"
  | "plan_revision_failed";

/** Typed split error. Fail-closed: every invariant breach surfaces a typed code. */
export class SplitError extends Error {
  readonly code: SplitErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: SplitErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SplitError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Ports.
// -------------------------------------------------------------------------------------------------

/**
 * Receipt for one segment's {@link SplitWorkingCopy.splitSegment}. Carries the
 * new child change id (a durable {@link ContentHash} fingerprint) and the parent
 * count the split produced — the coordinator rejects anything other than 1
 * (GIT-06: every change has exactly one parent).
 */
export type SplitSegmentReceipt = Readonly<{
  /** 0-based segment index this receipt corresponds to. */
  readonly segmentIndex: number;
  /** New child change id produced by `jj split` for this segment. */
  readonly changeId: ContentHash;
  /** New commit of the child change. */
  readonly commit: GitSha;
  /** Parent count of the child; MUST be 1. */
  readonly parentCount: number;
  /** jj operation-log id after this segment's split. */
  readonly operationLogId: ContentHash;
}>;

/**
 * The masked jj working-copy surface the split coordinator needs. PR 28's
 * {@link JjWorkingCopyManager} satisfies the broker contract; `splitSegment`
 * (`jj split` with the segment's fileset/hunk-ranges) is the split-specific
 * operation, invoked through the same serialized broker. The original change id
 * handle is the durable {@link ContentHash} fingerprint stored on bindings; the
 * production wiring resolves it to a raw jj change id against the working copy.
 */
export interface SplitWorkingCopy {
  /**
   * Run `jj split` on the original change for one segment's fileset/hunk-ranges.
   * Returns the new child change id + parent count.
   */
  splitSegment(
    originalChangeId: ContentHash,
    segment: SplitSegment,
    segmentIndex: number,
  ): Promise<SplitSegmentReceipt>;
}

/**
 * The plan-registry surface the split coordinator needs. PR 09's plan registry
 * satisfies the contract in production; this narrow port lets the coordinator
 * depend only on the operations it needs (read a node's approval state; record
 * the split as a plan revision creating N child nodes).
 */
export interface SplitPlanRegistry {
  /** Read the target node + its approval state. Returns `undefined` if unknown. */
  getNode(treeId: TaskTreeId, nodeId: TaskNodeId): Promise<ExistingTreeNode | undefined>;
  /**
   * Record the split: create N child nodes (each with the original as parent) and
   * a new plan revision recording the split. Returns the new plan revision id.
   */
  recordSplit(input: SplitRecordInput): Promise<SplitRecordResult>;
}

/** Input for {@link SplitPlanRegistry.recordSplit}: one entry per child node. */
export type SplitRecordInput = Readonly<{
  readonly treeId: TaskTreeId;
  readonly originalNodeId: TaskNodeId;
  readonly children: readonly SplitChildRecord[];
}>;

/** One child to create in the task tree. */
export type SplitChildRecord = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly label: string;
  readonly changeId: ContentHash;
  readonly fileset: readonly string[];
}>;

/** Result of {@link SplitPlanRegistry.recordSplit}. */
export type SplitRecordResult = Readonly<{
  readonly planRevisionId: PlanRevisionId;
}>;

/** Minimal structured logger. Optional; defaults to a silent sink. */
export interface SplitLogger {
  debug(message: string, meta?: Readonly<Record<string, unknown>>): void;
  info(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error(message: string, meta?: Readonly<Record<string, unknown>>): void;
}

// -------------------------------------------------------------------------------------------------
// Options + factory surface.
// -------------------------------------------------------------------------------------------------

export type SplitCoordinatorOptions = Readonly<{
  /** Serialized working-copy broker surface (PR 28 + split). */
  readonly workingCopy: SplitWorkingCopy;
  /** Durable change-id binding store (PR 29). */
  readonly bindingStore: VcsChangeBindingStore;
  /** Task-tree + plan-revision store (PR 09). */
  readonly planRegistry: SplitPlanRegistry;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Optional structured logger; defaults to a silent sink. */
  readonly logger?: SplitLogger;
}>;

/** Options for {@link SplitCoordinator.executeSplit}. */
export type ExecuteSplitOptions = Readonly<{
  /**
   * Whether this split carries explicit revision approval — required to split an
   * approved node (TREE-09). Defaults to `false`: splitting an approved node
   * without this flag is rejected as `node_already_approved`.
   */
  readonly explicitRevisionApproval?: boolean;
}>;

export interface SplitCoordinator {
  /**
   * Execute a split: validate, run jj split per segment, verify one parent per
   * child, mint child node ids, compute the topology, record the plan revision,
   * and update the bindings. Returns the completed {@link SplitPlan}.
   */
  executeSplit(proposal: SplitProposal, options?: ExecuteSplitOptions): Promise<SplitPlan>;
  /** Dry-run preview of a split: which files/hunks go to which segment, no I/O. */
  previewSplit(proposal: SplitProposal): Promise<SplitPreview>;
}

// -------------------------------------------------------------------------------------------------
// Internal helpers.
// -------------------------------------------------------------------------------------------------

const silentLogger: SplitLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

function splitError(
  code: SplitErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): SplitError {
  return new SplitError(code, message, remediation, cause);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -------------------------------------------------------------------------------------------------
// Factory.
// -------------------------------------------------------------------------------------------------

/**
 * Compose the working-copy broker, binding store, and plan registry into a split
 * coordinator. The coordinator depends only on ports — concrete adapters are
 * injected, never imported. Throws {@link SplitError} on any invariant breach
 * (fail-closed).
 */
export function createSplitCoordinator(options: SplitCoordinatorOptions): SplitCoordinator {
  const workingCopy = options.workingCopy;
  const bindingStore = options.bindingStore;
  const planRegistry = options.planRegistry;
  const clock = options.clock;
  const ids = options.ids;
  const logger = options.logger ?? silentLogger;

  return {
    async executeSplit(
      proposal: SplitProposal,
      executeOptions?: ExecuteSplitOptions,
    ): Promise<SplitPlan> {
      const explicitRevisionApproval = executeOptions?.explicitRevisionApproval === true;

      // 1. Resolve the target node + its approval state. An unknown node is
      //    node_not_found (fail before any mutation).
      let existing: ExistingTreeNode;
      try {
        const resolved = await planRegistry.getNode(proposal.treeId, proposal.nodeId);
        if (resolved === undefined) {
          throw splitError(
            "node_not_found",
            `node '${proposal.nodeId}' is not present in tree '${proposal.treeId}'`,
            "Ensure the node exists before splitting it.",
          );
        }
        existing = resolved;
      } catch (error: unknown) {
        if (error instanceof SplitError) throw error;
        throw splitError(
          "node_not_found",
          `failed to resolve node '${proposal.nodeId}' in tree '${proposal.treeId}': ${errorMessage(error)}`,
          "Inspect the plan registry and rerun the split.",
          error,
        );
      }

      // 2. Hard approval guard: never silently split an approved node. Even
      //    though validateSplitProposal also enforces this with the context, the
      //    coordinator surfaces it with the dedicated node_already_approved code
      //    so a caller can distinguish "approved, no explicit approval" from a
      //    generic invalid_proposal.
      if (existing.approved && !explicitRevisionApproval) {
        throw splitError(
          "node_already_approved",
          `node '${proposal.nodeId}' is approved; splitting an approved node requires explicit revision approval (TREE-09)`,
          "Pass explicitRevisionApproval: true when the split is part of an approved revision, or supersede the revision first.",
        );
      }

      // 3. Structural validation (empty / overlapping / single-segment).
      const verdict = validateSplitProposal(proposal, {
        nodeApproved: existing.approved,
        explicitRevisionApproval,
      });
      if (!verdict.valid) {
        throw splitError(
          "invalid_proposal",
          `invalid split proposal for node '${proposal.nodeId}': ${verdict.reason ?? "unknown"}`,
          "Re-shape the proposal: at least two segments, distinct non-empty filesets, no single-segment no-op.",
        );
      }

      // 4. Resolve the original binding — needed to derive the parent change id
      //    for each child binding.
      const originalBinding = await readBinding(proposal.treeId, proposal.nodeId);

      // 5. Run jj split per segment, serially through the broker. Each split
      //    produces a new child change scoped to the segment's fileset.
      const receipts: SplitSegmentReceipt[] = [];
      for (let index = 0; index < proposal.splits.length; index += 1) {
        const segment = proposal.splits[index];
        if (segment === undefined) {
          throw splitError(
            "invalid_proposal",
            `segment at index ${String(index)} is undefined`,
            "Re-shape the proposal segments.",
          );
        }
        let receipt: SplitSegmentReceipt;
        try {
          receipt = await workingCopy.splitSegment(originalBinding.jjChangeId, segment, index);
        } catch (error: unknown) {
          if (error instanceof SplitError) throw error;
          throw splitError(
            "split_failed",
            `jj split failed for segment ${String(index)} ('${segment.label}') on change '${originalBinding.jjChangeId}': ${errorMessage(error)}`,
            "Inspect the working copy via the broker; the original change is preserved for retry.",
            error,
          );
        }
        if (receipt.segmentIndex !== index) {
          throw splitError(
            "split_failed",
            `split segment ${String(index)} ('${segment.label}') returned a receipt for segment ${String(receipt.segmentIndex)}; the broker and proposal are out of sync`,
            "Inspect the working-copy broker wiring; the segment index must round-trip.",
          );
        }
        receipts.push(receipt);
      }

      // 6. One-parent-per-child ancestry check (GIT-06). jj split's semantics
      //    produce a single parent, but a corrupt/fan-in result is rejected.
      for (const receipt of receipts) {
        if (receipt.parentCount !== 1) {
          throw splitError(
            "multi_parent_result",
            `split for segment ${String(receipt.segmentIndex)} produced a change with ${String(receipt.parentCount)} parents; a jj change must have exactly one parent (GIT-06)`,
            "Re-run the split; a single-parent result must not produce a merge or fan-in.",
          );
        }
      }

      // 7. Mint a task node id per segment + assemble the assigned identities.
      const assigned: AssignedChildIdentity[] = receipts.map((receipt) =>
        Object.freeze({
          segmentIndex: receipt.segmentIndex,
          nodeId: taskNodeId(ids.nextId()),
          changeId: receipt.changeId,
        }),
      );

      // 8. Compute the resulting topology (pure). The existing tree is just the
      //    original node for the depth calculation.
      let resultingNodes: readonly SplitResultNode[];
      try {
        resultingNodes = computeResultingTopology([existing], proposal, assigned);
      } catch (error: unknown) {
        throw splitError(
          "invalid_proposal",
          `failed to compute the resulting topology: ${errorMessage(error)}`,
          "Re-shape the proposal and rerun.",
          error,
        );
      }

      // 9. Record the split as a plan revision: create N child nodes (one parent
      //    each) + a new revision.
      let planRevisionId: PlanRevisionId;
      try {
        const children: SplitChildRecord[] = proposal.splits.map((segment, index) => {
          const receipt = receipts[index];
          const identity = assigned[index];
          if (receipt === undefined || identity === undefined) {
            throw new Error(`internal: missing receipt/identity for segment ${String(index)}`);
          }
          return Object.freeze({
            nodeId: identity.nodeId,
            label: segment.label,
            changeId: receipt.changeId,
            fileset: Object.freeze([...segment.fileset]),
          });
        });
        const result = await planRegistry.recordSplit({
          treeId: proposal.treeId,
          originalNodeId: proposal.nodeId,
          children: Object.freeze(children),
        });
        planRevisionId = result.planRevisionId;
      } catch (error: unknown) {
        if (error instanceof SplitError) throw error;
        throw splitError(
          "plan_revision_failed",
          `failed to record the split as a plan revision for node '${proposal.nodeId}': ${errorMessage(error)}`,
          "Inspect the plan registry; the jj splits already landed in the working copy.",
          error,
        );
      }

      // 10. Update bindings: each child gets a new binding (new change id,
      //     parent = original's change id). The original binding is left intact —
      //     the split produced children, not a rewrite.
      for (let index = 0; index < resultingNodes.length; index += 1) {
        const node = resultingNodes[index];
        const receipt = receipts[index];
        if (node === undefined || receipt === undefined) {
          throw splitError(
            "binding_update_failed",
            `internal: resulting node / receipt mismatch at index ${String(index)}`,
            "This is an internal invariant breach; report it.",
          );
        }
        await recordChildBinding(proposal.treeId, node, receipt, originalBinding);
      }

      logger.info("node_split", {
        tree_id: proposal.treeId,
        original_node: proposal.nodeId,
        plan_revision_id: planRevisionId,
        child_count: resultingNodes.length,
      });

      return Object.freeze({
        proposal,
        resultingNodes: Object.freeze([...resultingNodes]),
        planRevisionId,
      });
    },

    previewSplit(proposal: SplitProposal): Promise<SplitPreview> {
      // The preview validates only structurally; the approval context is
      // resolved + enforced by executeSplit. A preview of an unknown node is
      // still useful (it shows the fileset assignment), so the node is not
      // required to exist here.
      return Promise.resolve().then(() => {
        const verdict = validateSplitProposal(proposal, {
          nodeApproved: false,
          explicitRevisionApproval: false,
        });
        if (!verdict.valid) {
          throw splitError(
            "invalid_proposal",
            `invalid split proposal for node '${proposal.nodeId}': ${verdict.reason ?? "unknown"}`,
            "Re-shape the proposal before previewing.",
          );
        }
        return previewSplit(proposal);
      });
    },
  };

  // -----------------------------------------------------------------------------------------------
  // Binding I/O.
  // -----------------------------------------------------------------------------------------------

  async function readBinding(treeId: TaskTreeId, nodeId: TaskNodeId): Promise<VcsChangeBinding> {
    let binding: VcsChangeBinding | undefined;
    try {
      binding = await bindingStore.getBinding(treeId, nodeId);
    } catch (error: unknown) {
      throw splitError(
        "binding_update_failed",
        `failed to read binding for node '${nodeId}' in tree '${treeId}': ${errorMessage(error)}`,
        "Inspect the binding store and rerun the split.",
        error,
      );
    }
    if (binding === undefined) {
      throw splitError(
        "node_not_found",
        `no binding found for node '${nodeId}' in tree '${treeId}'`,
        "Capture the node's change before splitting it.",
      );
    }
    return binding;
  }

  async function recordChildBinding(
    treeId: TaskTreeId,
    node: SplitResultNode,
    receipt: SplitSegmentReceipt,
    originalBinding: VcsChangeBinding,
  ): Promise<void> {
    // Each child is a fresh change (rewriteGeneration 0) parented onto the
    // original's change id. A split produces new children; the original's
    // conflict lifecycle is untouched, so the child starts clean.
    const conflictState: ConflictState = "clean";
    if (!isValidConflictTransition(originalBinding.conflictState, conflictState)) {
      // Defensive: the original's state does not constrain the child's (the
      // child is new), but assert the invariant for completeness.
      throw splitError(
        "binding_update_failed",
        `invalid conflict-state projection for child node '${node.nodeId}'`,
        "Inspect the binding lifecycle; the transition table is in vcs-change-binding.ts.",
      );
    }
    const generation: RewriteGeneration = 0;
    const binding: VcsChangeBinding = Object.freeze({
      treeId,
      nodeId: node.nodeId,
      jjChangeId: receipt.changeId,
      currentCommitId: receipt.commit,
      parentChangeId: originalBinding.jjChangeId,
      bookmark: undefined,
      rewriteGeneration: generation,
      lastJjOperationId: receipt.operationLogId,
      lastPushedCommitId: undefined,
      lastReviewedCommitId: undefined,
      conflictState,
      recordedAt: clock.now(),
    });
    try {
      await bindingStore.upsertBinding(binding);
    } catch (error: unknown) {
      throw splitError(
        "binding_update_failed",
        `failed to record binding for child node '${node.nodeId}': ${errorMessage(error)}`,
        "Inspect the binding store; the jj split + plan revision already landed.",
        error,
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Convenience.
// -------------------------------------------------------------------------------------------------
