/**
 * Node-split domain (PR 40 / TREE-07, TREE-09).
 *
 * Decomposes an oversized task node into N reviewable child changes via jj split.
 * The split is a *plan revision*, not a hidden history rewrite: it produces N child
 * nodes (one parent each) and a new plan revision so the task tree and the change
 * tree stay in sync.
 *
 * This module is the pure core:
 *  - {@link SplitSegment}/{@link SplitProposal}: the proposal shape (which
 *    fileset/hunk-ranges go to which child).
 *  - {@link SplitResultNode}/{@link SplitPlan}: the resulting topology + the plan
 *    revision id that recorded the split.
 *  - {@link SplitPreview}: the dry-run view of a split (which files/hunks go to
 *    which segment), without executing.
 *  - {@link validateSplitProposal}: rejects empty splits, overlapping filesets, a
 *    single-segment no-op, and splitting an approved node without explicit
 *    revision approval (TREE-09: never silently split an approved node).
 *  - {@link computeResultingTopology}: the resulting N child nodes — one parent
 *    each, depth = original + 1 — given the assigned child identities.
 *
 * NO I/O lives here. The adapter (split-coordinator.ts) composes the jj
 * working-copy broker (PR 28), the binding store (PR 29), and the plan registry
 * (PR 09) behind ports.
 */
import {
  nonEmptyText,
  taskNodeId,
  taskTreeId,
  type ContentHash,
  type NonEmptyText,
  type PlanRevisionId,
  type TaskNodeId,
  type TaskTreeId,
} from "./value-objects.js";

// -------------------------------------------------------------------------------------------------
// Value shapes.
// -------------------------------------------------------------------------------------------------

/**
 * A single inclusive line range within a file, used to scope a segment's split
 * to specific hunks rather than whole files. `startLine` / `endLine` are
 * 1-based and inclusive (`startLine <= endLine`).
 */
export type HunkRange = Readonly<{
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}>;

/**
 * One segment of a split: the files (and optionally hunks) that move into a
 * single child change. `fileset` is a list of repository-relative paths; every
 * path across all segments of a proposal MUST be distinct (no overlaps). When
 * `hunkRanges` is supplied, the child carries only those hunks; otherwise the
 * whole files in `fileset` move.
 */
export type SplitSegment = Readonly<{
  readonly label: NonEmptyText;
  readonly fileset: readonly string[];
  readonly hunkRanges?: readonly HunkRange[];
}>;

/**
 * A proposed split of node `nodeId` in tree `treeId` into `splits.length` child
 * changes. The proposal is validated by {@link validateSplitProposal} before any
 * broker mutation; the resulting topology is computed by
 * {@link computeResultingTopology} after the jj splits assign change ids.
 */
export type SplitProposal = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly treeId: TaskTreeId;
  readonly splits: readonly SplitSegment[];
}>;

/**
 * One resulting child node of a split. Each child has exactly one parent — the
 * original node (`parentNodeId`) — a new jj change id (`changeId`, the durable
 * {@link ContentHash} fingerprint of the jj change the split produced), and a
 * depth one greater than the original.
 */
export type SplitResultNode = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly parentNodeId: TaskNodeId;
  readonly changeId: ContentHash;
  readonly depth: number;
}>;

/**
 * The completed split: the proposal, the resulting N child nodes (one parent
 * each), and the plan revision id that recorded the split (so the task tree and
 * the change tree stay in sync).
 */
export type SplitPlan = Readonly<{
  readonly proposal: SplitProposal;
  readonly resultingNodes: readonly SplitResultNode[];
  readonly planRevisionId: PlanRevisionId;
}>;

/**
 * One segment in a dry-run {@link SplitPreview}. Mirrors {@link SplitSegment}
 * with an explicit index so a caller can render "segment 0 -> [files]".
 */
export type SplitSegmentPreview = Readonly<{
  readonly segmentIndex: number;
  readonly label: NonEmptyText;
  readonly fileset: readonly string[];
  readonly hunkRanges?: readonly HunkRange[];
}>;

/** Dry-run preview of a split: which files/hunks go to which segment, no I/O. */
export type SplitPreview = Readonly<{
  readonly proposal: SplitProposal;
  readonly segments: readonly SplitSegmentPreview[];
  readonly resultingNodeCount: number;
}>;

/**
 * Context for {@link validateSplitProposal}. Carries the approval state the pure
 * helper cannot derive: whether the target node's active plan revision is
 * approved, and whether this split itself carries explicit revision approval
 * (which permits splitting an approved node — TREE-09).
 */
export type SplitProposalContext = Readonly<{
  readonly nodeApproved: boolean;
  readonly explicitRevisionApproval: boolean;
}>;

/** Verdict from {@link validateSplitProposal}. `reason` is non-empty when invalid. */
export type SplitProposalVerdict = Readonly<{ readonly valid: boolean; readonly reason?: string }>;

/**
 * Minimal view of an existing task tree node the pure helpers need. The adapter
 * projects a {@link TaskNodeRecord} (or its test double) into this shape before
 * computing topology; the pure core never depends on the registry's records.
 */
export type ExistingTreeNode = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly parentNodeId?: TaskNodeId;
  readonly depth: number;
  readonly approved: boolean;
}>;

/**
 * Identity assigned to a single resulting child *after* the jj split produced a
 * change id. `segmentIndex` is the 0-based position in {@link SplitProposal.splits}
 * this child corresponds to; `nodeId` is the task node id the coordinator minted
 * for the child; `changeId` is the durable fingerprint of the jj change the split
 * produced for this segment.
 */
export type AssignedChildIdentity = Readonly<{
  readonly segmentIndex: number;
  readonly nodeId: TaskNodeId;
  readonly changeId: ContentHash;
}>;

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/**
 * Validate the structural shape of a split proposal before any broker work.
 * Rejects (TREE-07/TREE-09):
 *  - an empty split list (`splits.length === 0`) — nothing to do;
 *  - a single-segment split (`splits.length === 1`) — a no-op that adds a node
 *    without decomposing the original;
 *  - a segment with an empty fileset — a segment that moves nothing;
 *  - overlapping filesets across segments — a file MUST belong to exactly one
 *    child (jj split would otherwise race on the same path);
 *  - splitting an approved node without explicit revision approval — never
 *    silently split an approved node.
 *
 * Pure: no I/O, no crypto. `reason` is non-empty on an invalid verdict.
 */
export function validateSplitProposal(
  proposal: SplitProposal,
  context: SplitProposalContext,
): SplitProposalVerdict {
  // Structural: ids + segments present.
  try {
    taskTreeId(proposal.treeId);
    taskNodeId(proposal.nodeId);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }

  if (proposal.splits.length === 0) {
    return invalid("proposal.splits is empty; a split must produce at least two children");
  }
  if (proposal.splits.length === 1) {
    return invalid(
      "proposal.splits has a single segment; a single-segment split is a no-op (use a plain node for that)",
    );
  }

  // Each segment: a non-empty label and a non-empty, distinct fileset.
  const seenFiles = new Map<string, number>();
  let segmentIndex = 0;
  for (const segment of proposal.splits) {
    const index = segmentIndex;
    try {
      nonEmptyText(segment.label, `segment[${String(index)}].label`);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : String(error));
    }
    if (segment.fileset.length === 0) {
      return invalid(
        `segment[${String(index)}].fileset is empty; every segment must move at least one file`,
      );
    }
    for (const path of segment.fileset) {
      if (path.length === 0) {
        return invalid(`segment[${String(index)}].fileset contains an empty path`);
      }
      const prior = seenFiles.get(path);
      if (prior !== undefined) {
        return invalid(
          `fileset overlap: path '${path}' appears in both segment ${String(prior)} and segment ${String(index)}; each file must belong to exactly one child`,
        );
      }
      seenFiles.set(path, index);
    }
    segmentIndex += 1;
  }

  // Approval guard (TREE-09): never silently split an approved node. The split
  // of an approved node is only permitted when this split itself carries
  // explicit revision approval.
  if (context.nodeApproved && !context.explicitRevisionApproval) {
    return invalid(
      "the target node's plan revision is approved; splitting an approved node requires explicit revision approval (never silently split an approved node)",
    );
  }

  return Object.freeze({ valid: true });
}

/**
 * Compute the resulting N child nodes of a split: one per segment, each with the
 * original node as its sole parent and a depth one greater than the original.
 * `assigned` carries the task node id + jj change id minted per segment after
 * the broker ran the splits; it MUST have exactly one entry per segment in
 * `proposal.splits`, indexed 0..N-1.
 *
 * Pure: no I/O. Throws a `RangeError` if the original node is unknown, if
 * `assigned` does not cover every segment, or if a cycle is detected in the
 * existing tree (corrupt state).
 */
export function computeResultingTopology(
  existing: readonly ExistingTreeNode[],
  proposal: SplitProposal,
  assigned: readonly AssignedChildIdentity[],
): readonly SplitResultNode[] {
  const byNode = new Map<TaskNodeId, ExistingTreeNode>();
  for (const node of existing) {
    if (byNode.has(node.nodeId)) {
      throw new RangeError(`duplicate existing node '${node.nodeId}'`);
    }
    byNode.set(node.nodeId, node);
  }

  const original = byNode.get(proposal.nodeId);
  if (original === undefined) {
    throw new RangeError(`original node '${proposal.nodeId}' is not present in the existing tree`);
  }
  const originalDepth = resolveDepth(proposal.nodeId, byNode);

  if (assigned.length !== proposal.splits.length) {
    throw new RangeError(
      `assigned identities (length ${String(assigned.length)}) must match the segment count (${String(proposal.splits.length)})`,
    );
  }

  const bySegment = new Map<number, AssignedChildIdentity>();
  for (const identity of assigned) {
    if (identity.segmentIndex < 0 || identity.segmentIndex >= proposal.splits.length) {
      throw new RangeError(
        `assigned identity for segment ${String(identity.segmentIndex)} is out of range [0, ${String(proposal.splits.length)})`,
      );
    }
    if (bySegment.has(identity.segmentIndex)) {
      throw new RangeError(
        `duplicate assigned identity for segment ${String(identity.segmentIndex)}`,
      );
    }
    bySegment.set(identity.segmentIndex, identity);
  }

  const results: SplitResultNode[] = [];
  for (let index = 0; index < proposal.splits.length; index += 1) {
    const identity = bySegment.get(index);
    if (identity === undefined) {
      throw new RangeError(`missing assigned identity for segment ${String(index)}`);
    }
    results.push(
      Object.freeze({
        nodeId: identity.nodeId,
        parentNodeId: proposal.nodeId,
        changeId: identity.changeId,
        depth: originalDepth + 1,
      }),
    );
  }
  return Object.freeze(results);
}

/**
 * Pure dry-run preview of a split: projects the proposal into one
 * {@link SplitSegmentPreview} per segment (with an explicit index) and reports
 * the resulting child count. No validation of approval state — the coordinator
 * runs {@link validateSplitProposal} (with its approval context) before/after
 * this. Pure: no I/O.
 */
export function previewSplit(proposal: SplitProposal): SplitPreview {
  const segments: SplitSegmentPreview[] = proposal.splits.map((segment, index) =>
    Object.freeze({
      segmentIndex: index,
      label: segment.label,
      fileset: Object.freeze([...segment.fileset]),
      ...(segment.hunkRanges !== undefined
        ? { hunkRanges: Object.freeze([...segment.hunkRanges]) }
        : {}),
    }),
  );
  return Object.freeze({
    proposal,
    segments: Object.freeze(segments),
    resultingNodeCount: proposal.splits.length,
  });
}

// -------------------------------------------------------------------------------------------------
// Internal helpers.
// -------------------------------------------------------------------------------------------------

function invalid(reason: string): SplitProposalVerdict {
  return Object.freeze({ valid: false, reason });
}

/**
 * Resolve the root-relative depth of `nodeId` by walking `parentNodeId` through
 * `byNode` until a root is reached. Cycle-safe: throws on a corrupt cycle.
 * Pure.
 */
function resolveDepth(
  nodeId: TaskNodeId,
  byNode: ReadonlyMap<TaskNodeId, ExistingTreeNode>,
): number {
  const visited = new Set<TaskNodeId>();
  let depth = 0;
  let current = byNode.get(nodeId);
  if (current === undefined) {
    return depth;
  }
  visited.add(nodeId);
  while (current.parentNodeId !== undefined) {
    if (visited.has(current.parentNodeId)) {
      throw new RangeError(`cycle detected in existing tree at node '${current.parentNodeId}'`);
    }
    visited.add(current.parentNodeId);
    const parent = byNode.get(current.parentNodeId);
    if (parent === undefined) {
      break;
    }
    depth += 1;
    current = parent;
  }
  return depth;
}
