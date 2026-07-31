import { describe, it, expect } from "vitest";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { buildReviewHeader, classifyReviewFreshness, type VcsChangeBinding } from "@minions/core";

/**
 * Unit tests for the pure review-header helpers (PR 48 — interdiff-since-review-backend).
 * The adapter's jj interdiff invocation is tested separately in test/integration/adapters/revset.test.ts.
 */

function makeBinding(overrides: Partial<VcsChangeBinding> = {}): VcsChangeBinding {
  return Object.freeze({
    treeId: "tree-001" as never,
    nodeId: "node-001" as never,
    jjChangeId: "abc123" as never,
    currentCommitId: "c".repeat(40) as never,
    parentChangeId: undefined,
    bookmark: undefined,
    rewriteGeneration: 0,
    lastJjOperationId: "op-001" as never,
    lastPushedCommitId: undefined,
    lastReviewedCommitId: undefined,
    conflictState: "clean",
    recordedAt: timestampFromEpochMilliseconds(0),
    ...overrides,
  });
}

describe("classifyReviewFreshness", () => {
  it("returns never_reviewed when lastReviewedCommitId is undefined", () => {
    const binding = makeBinding({ lastReviewedCommitId: undefined });
    expect(classifyReviewFreshness(binding)).toBe("never_reviewed");
  });

  it("returns fresh when lastReviewedCommitId equals currentCommitId", () => {
    const commit = "a".repeat(40) as never;
    const binding = makeBinding({
      lastReviewedCommitId: commit,
      currentCommitId: commit,
    });
    expect(classifyReviewFreshness(binding)).toBe("fresh");
  });

  it("returns needs_interdiff when commits differ", () => {
    const binding = makeBinding({
      lastReviewedCommitId: "a".repeat(40) as never,
      currentCommitId: "b".repeat(40) as never,
    });
    expect(classifyReviewFreshness(binding)).toBe("needs_interdiff");
  });
});

describe("buildReviewHeader", () => {
  it("builds never_reviewed header when not reviewed", () => {
    const binding = makeBinding();
    const header = buildReviewHeader(binding, true, "unused diff text");
    expect(header.freshness).toBe("never_reviewed");
    expect(header.contentChangedSinceReview).toBe(false);
    expect(header.logicalChangeId).toBe(binding.jjChangeId);
    expect(header.rewriteGeneration).toBe(0);
    expect(header.interdiffContent).toBeUndefined();
  });

  it("builds fresh header when same commit", () => {
    const commit = "a".repeat(40) as never;
    const binding = makeBinding({
      lastReviewedCommitId: commit,
      currentCommitId: commit,
    });
    const header = buildReviewHeader(binding, true);
    expect(header.freshness).toBe("fresh");
    expect(header.contentChangedSinceReview).toBe(false);
  });

  it("builds ancestry_only header when interdiff is empty (restack)", () => {
    const binding = makeBinding({
      lastReviewedCommitId: "a".repeat(40) as never,
      currentCommitId: "b".repeat(40) as never,
      rewriteGeneration: 1,
    });
    const header = buildReviewHeader(binding, true, "unused diff text");
    expect(header.freshness).toBe("ancestry_only");
    expect(header.contentChangedSinceReview).toBe(false);
    expect(header.rewriteGeneration).toBe(1);
    expect(header.interdiffContent).toBeUndefined();
  });

  it("builds stale_content header when interdiff is non-empty", () => {
    const binding = makeBinding({
      lastReviewedCommitId: "a".repeat(40) as never,
      currentCommitId: "b".repeat(40) as never,
    });
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
    const header = buildReviewHeader(binding, false, diff);
    expect(header.freshness).toBe("stale_content");
    expect(header.contentChangedSinceReview).toBe(true);
    expect(header.interdiffContent).toBe(diff);
  });

  it("carries parentChangeId from the binding", () => {
    const parent = "parent123" as never;
    const binding = makeBinding({ parentChangeId: parent });
    const header = buildReviewHeader(binding, true);
    expect(header.parentChangeId).toBe(parent);
  });
});
