/**
 * Review-header projection (PR 48 — interdiff-since-review-backend).
 *
 * Powers "what changed since my last approval" from jj. A ReviewHeader is derived
 * per VcsChangeBinding: it carries the logical change identity, rewrite generation,
 * parent change, and — critically — whether the node's *content* changed since the
 * last review, distinguishing ancestry-only rewrites (jj rebased the change without
 * modifying files) from genuine content deltas.
 *
 * The pure helpers here classify the review state from binding fields alone; the
 * adapter (packages/adapters/src) resolves "needs_interdiff" by running
 * `jj interdiff --from <lastReviewedCommitId> --to <currentCommitId>`.
 */

import type { ContentHash, TaskNodeId } from "./value-objects.js";
import type { RewriteGeneration, VcsChangeBinding } from "./vcs-change-binding.js";

/**
 * Classification of a binding's review freshness. The first three are computable
 * from binding fields alone; `needs_interdiff` requires the adapter to run jj.
 */
export type ReviewFreshness =
  "never_reviewed" | "fresh" | "ancestry_only" | "stale_content" | "needs_interdiff";

/**
 * Per-node review-header projection (PRD QA-07, UI-03). Surfaced to the reviewer
 * so they can see exactly what changed since their last approval — or that only
 * ancestry moved (a restack, not a content change).
 */
export type ReviewHeader = Readonly<{
  readonly nodeId: TaskNodeId;
  /** jj change id (64-hex) — the logical identity that survives rewrites. */
  readonly logicalChangeId: ContentHash;
  /** How many times this change has been rewritten (rebased/amended). */
  readonly rewriteGeneration: RewriteGeneration;
  /** Parent change id (64-hex), or undefined for a root change. */
  readonly parentChangeId: ContentHash | undefined;
  /** True iff the file content changed since the last review commit. */
  readonly contentChangedSinceReview: boolean;
  /** Full classification — distinguishes ancestry-only from content deltas. */
  readonly freshness: ReviewFreshness;
}>;

/**
 * Classify review freshness from binding fields alone, without running jj.
 *
 * - `never_reviewed`: `lastReviewedCommitId` is undefined.
 * - `fresh`: `lastReviewedCommitId === currentCommitId` (same commit, no rewrite).
 * - `needs_interdiff`: commits differ — the adapter must run `jj interdiff` to
 *   determine whether the *content* changed or only the ancestry (a restack).
 *
 * Pure: no I/O, no side effects. The adapter resolves `needs_interdiff`.
 */
export function classifyReviewFreshness(binding: VcsChangeBinding): ReviewFreshness {
  if (binding.lastReviewedCommitId === undefined) return "never_reviewed";
  if (binding.lastReviewedCommitId === binding.currentCommitId) return "fresh";
  return "needs_interdiff";
}

/**
 * Build a complete ReviewHeader from a binding and a pre-computed interdiff result.
 *
 * When `interdiffEmpty` is true, the commits differ but the file content is identical
 * (ancestry-only rewrite — jj rebased the change without modifying files). When false,
 * genuine content changed since the review.
 *
 * Pure: the caller (adapter) is responsible for running jj to obtain `interdiffEmpty`.
 */
export function buildReviewHeader(
  binding: VcsChangeBinding,
  interdiffEmpty: boolean,
): ReviewHeader {
  const base = classifyReviewFreshness(binding);
  const freshness: ReviewFreshness =
    base === "needs_interdiff" ? (interdiffEmpty ? "ancestry_only" : "stale_content") : base;
  return Object.freeze({
    nodeId: binding.nodeId,
    logicalChangeId: binding.jjChangeId,
    rewriteGeneration: binding.rewriteGeneration,
    parentChangeId: binding.parentChangeId,
    contentChangedSinceReview: freshness === "stale_content",
    freshness,
  });
}
