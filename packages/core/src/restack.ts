/**
 * Restack + conflict-repair domain (PR 34 / GIT-05..07).
 *
 * When a parent change is rewritten (PR 30 commit capture, or any rebase that
 * moves a parent commit), every descendant that stacked on the old parent must
 * be restacked parent-first onto the new parent. This module is the pure core:
 *
 *  - {@link RestackRequest}/{@link RestackReceipt}: the operation shape and its
 *    durable receipt (one entry per descendant, carrying its outcome).
 *  - {@link ConflictBundle}: the conflict artifact — textual or semantic — that
 *    a restack produces when a descendant cannot rebase cleanly. It carries the
 *    conflicting paths, the parsed conflict markers, the ancestry verdict
 *    (multi-parent rejected), and the content/ancestor deltas.
 *  - {@link subtreeOrder}: deterministic parent-first ordering of a descendant
 *    set, so a rebase through the broker never tries to restack a child before
 *    its parent's new commit is known.
 *  - {@link detectConflictMarkers}: pure textual conflict-marker parser over a
 *    diff (the `jj diff` the broker returns after a conflicting rebase).
 *  - {@link validateAncestry}: rejects a multi-parent (merge/fan-in) result —
 *    GIT-06: every branch has exactly one parent, and no merge commit or sibling
 *    fan-in resolves a conflict.
 *  - {@link invalidateStaleGates}: the set of restacked nodes whose gate +
 *    review receipts are now stale (PR 32 push guard consumes this).
 *
 * NO I/O lives here. The adapter (restack-coordinator.ts) composes the jj
 * working-copy broker (PR 28), the binding store (PR 29), the commit capture
 * (PR 30), an optional repair harness (the node's OMP session), and the repair
 * retry budget (PR 26).
 */
import {
  taskNodeId,
  taskTreeId,
  type ContentHash,
  type GitSha,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
} from "./value-objects.js";
import type { RewriteGeneration } from "./vcs-change-binding.js";

// -------------------------------------------------------------------------------------------------
// Conflict artifacts.
// -------------------------------------------------------------------------------------------------

/**
 * Recognized conflict kinds. {@link detectConflictMarkers} discovers textual
 * conflicts; semantic conflicts (a rename or behavior change the parent made
 * that breaks the descendant without a textual marker) are surfaced by the
 * repair harness / rebase outcome. Both produce a {@link ConflictBundle}.
 */
export type ConflictKind = "textual" | "semantic";

/**
 * A single textual conflict marker parsed from a diff. `path` is the file the
 * marker lives in (the most recent diff file header); `kind` is always
 * `textual` (markers are textual by definition).
 */
export type ConflictMarker = Readonly<{
  readonly path: string;
  readonly kind: "textual";
}>;

/**
 * The conflict artifact for one descendant. Carries everything the repair
 * harness needs to attempt a resolution and everything a human needs to take
 * over when repair is exhausted:
 *  - `conflictingPaths`: the paths jj flagged during the rebase.
 *  - `conflictMarkers`: parsed textual markers (empty for a pure semantic conflict).
 *  - `ancestryValid`: false when the rebase produced a multi-parent (merge)
 *    result — GIT-06 forbids this and the coordinator rejects it.
 *  - `contentDelta` / `ancestorDelta`: content-addressed digests of the
 *    descendant's content delta and the ancestor (parent) delta, so no-progress
 *    detection across repair attempts is deterministic.
 */
export type ConflictBundle = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly kind: ConflictKind;
  readonly conflictingPaths: readonly string[];
  readonly conflictMarkers: readonly ConflictMarker[];
  readonly ancestryValid: boolean;
  readonly contentDelta: ContentHash;
  readonly ancestorDelta: ContentHash;
}>;

// -------------------------------------------------------------------------------------------------
// Descendant shape + request/receipt.
// -------------------------------------------------------------------------------------------------

/**
 * One descendant to restack. `parentNodeId` is the node's parent WITHIN the
 * restacked subtree: either {@link RestackRequest.parentNodeId} (the rewritten
 * parent — a first-level descendant) or another descendant in the set (a deeper
 * descendant). `workingCopyId` is the registered jj working-copy change id the
 * broker restacks through; `jjChangeId` is the durable fingerprint of that
 * change id; `currentCommitId` is the descendant's pre-restack commit.
 */
export type DescendantNode = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly parentNodeId: TaskNodeId;
  readonly workingCopyId: string;
  readonly jjChangeId: ContentHash;
  readonly currentCommitId: GitSha;
}>;

/**
 * Input to a restack. `parentNodeId` is the rewritten parent (the root of the
 * restacked subtree); `newParentCommit` is its fresh commit; `descendants` is
 * the set of nodes that stacked on the old parent and must now rebase onto the
 * new ancestry, parent-first.
 */
export type RestackRequest = Readonly<{
  readonly treeId: TaskTreeId;
  readonly parentNodeId: TaskNodeId;
  readonly newParentCommit: GitSha;
  readonly descendants: readonly DescendantNode[];
}>;

/**
 * Terminal outcome for one descendant after a restack run:
 *  - `clean`: rebased cleanly onto the new ancestry, no conflict.
 *  - `conflict`: a conflict was detected and NO repair was attempted (no repair
 *    harness available). Durable conflict state is recorded; human attention.
 *  - `repaired`: a conflict was detected and the bounded repair resolved it;
 *    the resolution was squashed into the original change and ancestry verified.
 *  - `exhausted`: repair was attempted to the budget ceiling and could not
 *    resolve the conflict. Durable conflict-as-commit state; human attention.
 *  - `aborted`: not processed this run (an upstream node is conflicted or a
 *    rebase crashed mid-flight). Retry resumes from the first aborted node.
 */
export type RestackOutcome = "clean" | "conflict" | "repaired" | "aborted" | "exhausted";

/**
 * The per-descendant result recorded in a {@link RestackReceipt}. `conflict` is
 * present for `conflict`/`exhausted` outcomes (the bundle that drove the
 * outcome). `newCommitId`/`newChangeId`/`rewriteGeneration` are present for
 * `clean`/`repaired` outcomes (the fresh ancestry the binding stores).
 */
export type RestackNodeResult = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly outcome: RestackOutcome;
  readonly conflict: ConflictBundle | undefined;
  readonly newCommitId: GitSha | undefined;
  readonly newChangeId: ContentHash | undefined;
  readonly rewriteGeneration: RewriteGeneration | undefined;
}>;

/**
 * Durable receipt for a restack run. Every descendant appears in
 * `restackedNodes`; `conflictNodes`/`cleanNodes`/`abortedNodes` are projections
 * by outcome for the caller (and the PR 32 push guard). Export is blocked while
 * `conflictNodes` is non-empty.
 */
export type RestackReceipt = Readonly<{
  readonly receiptId: string;
  readonly treeId: TaskTreeId;
  readonly parentNodeId: TaskNodeId;
  readonly restackedNodes: readonly RestackNodeResult[];
  readonly conflictNodes: readonly RestackNodeResult[];
  readonly cleanNodes: readonly RestackNodeResult[];
  readonly abortedNodes: readonly RestackNodeResult[];
  readonly completedAt: Timestamp;
}>;

// -------------------------------------------------------------------------------------------------
// Ancestry verdict.
// -------------------------------------------------------------------------------------------------

/** The ancestry of a rebased change, as observed through the broker. */
export type RestackAncestry = Readonly<{
  readonly nodeId: TaskNodeId;
  /** Number of parents the rebased change has. jj changes have exactly one. */
  readonly parentCount: number;
  /** Parent commit ids the rebased change stacks on. */
  readonly parentCommitIds: readonly GitSha[];
}>;

/** Result of {@link validateAncestry}. `reason` is non-empty when `valid` is false. */
export type AncestryVerdict = Readonly<{
  readonly valid: boolean;
  readonly reason: string;
}>;

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/**
 * The textual conflict-marker line prefixes jj/git emit in conflicted files.
 * Used by {@link detectConflictMarkers}; exported for tests.
 */
export const CONFLICT_MARKER_OURS = "<<<<<<<";
export const CONFLICT_MARKER_SEPARATOR = "=======";
export const CONFLICT_MARKER_THEIRS = ">>>>>>>";

/**
 * Deterministic parent-first ordering of a descendant set. A node always
 * appears after its parent (within the set), so a rebase through the broker
 * never restacks a child before its parent's new commit is known. Roots of the
 * subtree (whose parent is not in the set) come first; ties break by node id
 * for determinism. Throws on a duplicate node id or a parent cycle. Pure.
 */
export function subtreeOrder(descendants: readonly DescendantNode[]): readonly DescendantNode[] {
  if (descendants.length === 0) {
    return Object.freeze([]);
  }
  const byNode = new Map<TaskNodeId, DescendantNode>();
  for (const node of descendants) {
    taskNodeId(node.nodeId);
    taskNodeId(node.parentNodeId);
    if (byNode.has(node.nodeId)) {
      throw new RangeError(`duplicate descendant node '${node.nodeId}'`);
    }
    byNode.set(node.nodeId, node);
  }

  const depthCache = new Map<TaskNodeId, number>();
  function depthOf(node: DescendantNode): number {
    const cached = depthCache.get(node.nodeId);
    if (cached !== undefined) {
      return cached;
    }
    let depth = 0;
    let current: DescendantNode = node;
    const visited = new Set<TaskNodeId>([node.nodeId]);
    let parent = byNode.get(current.parentNodeId);
    while (parent !== undefined) {
      if (visited.has(parent.nodeId)) {
        throw new RangeError(`cycle detected in descendant subtree at node '${parent.nodeId}'`);
      }
      visited.add(parent.nodeId);
      depth += 1;
      current = parent;
      parent = byNode.get(current.parentNodeId);
    }
    depthCache.set(node.nodeId, depth);
    return depth;
  }
  return Object.freeze(
    [...descendants].sort((a, b) => {
      const da = depthOf(a);
      const db = depthOf(b);
      if (da !== db) {
        return da - db;
      }
      if (a.nodeId < b.nodeId) {
        return -1;
      }
      if (a.nodeId > b.nodeId) {
        return 1;
      }
      return 0;
    }),
  );
}

/**
 * Parse textual conflict markers from a diff. Returns one {@link ConflictMarker}
 * per `<<<<<<<` block, associated with the most recent diff file header
 * (`diff --git a/X b/Y`, `--- a/X`, or `+++ b/Y`). Recognizes both git-style
 * (`<<<<<<< HEAD`) and jj-style markers. Empty for a clean diff or a pure
 * semantic conflict. Pure: no I/O.
 */
export function detectConflictMarkers(diff: string): readonly ConflictMarker[] {
  if (diff.length === 0) {
    return Object.freeze([]);
  }
  const markers: ConflictMarker[] = [];
  let currentPath = "";
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/<path> b/<path>` — take the b/ side as the canonical path.
      const parsed = parseDiffGitPath(line);
      if (parsed !== undefined) {
        currentPath = parsed;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("--- ")) {
      // Prefer the +++ header when it follows; only use --- if no path is known.
      if (currentPath.length === 0) {
        currentPath = stripPrefix(line.slice(4));
      }
      continue;
    }
    if (line.startsWith(CONFLICT_MARKER_OURS)) {
      markers.push(
        Object.freeze({
          path: currentPath.length > 0 ? currentPath : "(unknown)",
          kind: "textual",
        }),
      );
    }
  }
  return Object.freeze(markers);
}

/**
 * Validate the ancestry of a rebased change. A restacked descendant MUST have
 * exactly one parent (the new ancestry); a multi-parent result is a merge or
 * sibling fan-in, which GIT-06 forbids and GIT-05 says may never resolve a
 * conflict. Returns `{ valid: false, reason }` for parentCount != 1. Pure.
 */
export function validateAncestry(ancestry: RestackAncestry): AncestryVerdict {
  if (ancestry.parentCount < 0) {
    return Object.freeze({
      valid: false,
      reason: `ancestry for node '${ancestry.nodeId}' has a negative parent count`,
    });
  }
  if (ancestry.parentCount === 0) {
    return Object.freeze({
      valid: false,
      reason: `restacked node '${ancestry.nodeId}' has no parent; a descendant must rebase onto exactly one parent`,
    });
  }
  if (ancestry.parentCount > 1) {
    return Object.freeze({
      valid: false,
      reason: `restacked node '${ancestry.nodeId}' has ${String(ancestry.parentCount)} parents; a merge commit or sibling fan-in may not resolve a conflict (GIT-05/GIT-06)`,
    });
  }
  return Object.freeze({ valid: true, reason: "" });
}

/**
 * The set of restacked nodes whose gate + review receipts are now stale and
 * must be invalidated (PR 32 push guard). A node's receipts are stale whenever
 * the restack touched it — outcome `clean`, `conflict`, `repaired`, or
 * `exhausted`. Aborted nodes (not processed) are NOT stale. Deterministic
 * parent-first order. Pure.
 */
export function invalidateStaleGates(
  restackedNodes: readonly RestackNodeResult[],
): readonly TaskNodeId[] {
  const stale: TaskNodeId[] = [];
  for (const node of restackedNodes) {
    if (node.outcome === "aborted") {
      continue;
    }
    stale.push(node.nodeId);
  }
  return Object.freeze(stale);
}

// -------------------------------------------------------------------------------------------------
// Internal helpers.
// -------------------------------------------------------------------------------------------------

/** Parse the `b/`-side path out of a `diff --git a/<p> b/<p>` header. */
function parseDiffGitPath(line: string): string | undefined {
  // Form: "diff --git a/<path> b/<path>". Split on the literal " b/" separator
  // (paths may contain spaces, but the engine-owned working copy never stages
  // such paths in practice; this mirrors how jj/git render diff headers).
  const marker = " b/";
  const idx = line.indexOf(marker);
  if (idx < 0) {
    return undefined;
  }
  return line.slice(idx + marker.length).trim();
}

/** Strip a leading `a/` or `b/` prefix and surrounding quotes from a diff path. */
function stripPrefix(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // Quoted path (git's znet format); return verbatim minus the quotes.
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}

/** Re-export the branded-id constructors for adapter convenience. */
export { taskNodeId, taskTreeId };
