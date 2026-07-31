/**
 * Restack coordinator (PR 34, deliverable 2) — restacks descendants parent-first
 * after a parent rewrite and attempts bounded semantic conflict repair through
 * the node's OMP session.
 *
 * Composes:
 *  - {@link RestackWorkingCopy}: the masked jj working-copy broker surface the
 *    coordinator needs (a focused subset/extension of PR 28's
 *    {@link JjWorkingCopyManager} — it adds `rebase` and `squashResolve`, the
 *    two operations commit-capture did not need). Every mutation flows through
 *    the serialized broker; the coordinator never invokes jj directly.
 *  - {@link VcsChangeBindingStore}: the durable change-id binding (PR 29). Each
 *    restacked descendant's binding is rewritten in place: `currentCommitId`,
 *    `rewriteGeneration` (monotonic +1), `lastJjOperationId`, and
 *    `conflictState` advance.
 *  - {@link RestackRepairHarness}: OPTIONAL. When present, a conflicted
 *    descendant gets bounded semantic repair (the harness re-reads the conflict
 *    markers from the workspace and proposes a resolution). Bounded by the PR 26
 *    repair retry budget. When absent, a conflict goes straight to typed human
 *    attention (fail-closed).
 *  - {@link RestackStaleSink} / {@link RestackAttentionSink}: optional sinks for
 *    stale-gate invalidation (PR 32 push guard) and typed human attention.
 *
 * GIT-05..07 invariants enforced here:
 *  - GIT-05: NO merge commit or sibling fan-in resolves a conflict. A rebase
 *    result with more than one parent is rejected (validateAncestry) — only a
 *    single-parent rebase + squash is valid.
 *  - GIT-06: every branch has exactly one parent.
 *  - GIT-07: exhausted repair becomes typed human attention with the workspace
 *    preserved. The conflicted change is durable (conflict-as-commit); export is
 *    blocked until conflict-free.
 */
import { createHash } from "node:crypto";

import {
  canRetry,
  consume,
  contentHash,
  createRetryBudget,
  DEFAULT_REPAIR_CEILING,
  detectConflictMarkers,
  invalidateStaleGates,
  isValidConflictTransition,
  nonEmptyText,
  subtreeOrder,
  validateAncestry,
  type Clock,
  type ConflictBundle,
  type ContentHash,
  type DescendantNode,
  type GitSha,
  type IdGenerator,
  type NonEmptyText,
  type RestackAncestry,
  type RestackNodeResult,
  type RestackReceipt,
  type RestackRequest,
  type RetryBudget,
  type RewriteGeneration,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type RestackErrorCode =
  | "conflict_unresolved"
  | "multi_parent_detected"
  | "ancestry_invalid"
  | "repair_exhausted"
  | "restack_failed"
  | "binding_update_failed"
  | "export_blocked";

/** Typed restack error. Fail-closed: every invariant breach surfaces a typed code. */
export class RestackError extends Error {
  readonly code: RestackErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: RestackErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RestackError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Ports.
// -------------------------------------------------------------------------------------------------

/**
 * The ancestry a rebase produced, reported by the broker. `parentCount` is the
 * number of parents the rebased change has; jj changes have exactly one, so any
 * other value is a multi-parent (merge/fan-in) result that GIT-05 rejects.
 */
export type RestackRebaseAncestry = Readonly<{
  readonly parentCount: number;
  readonly parentCommitIds: readonly GitSha[];
}>;

/**
 * One descendant's rebase outcome through the broker. A clean rebase carries the
 * fresh commit + ancestry; a conflicted rebase carries the conflicting paths
 * (textual, from jj) and any semantic-conflict paths (from a detector the
 * production wiring may plug in — empty in the base broker). A conflicted
 * change still has a commit id (jj moves the change; the conflict lives in its
 * tree) — that commit is the durable conflict-as-commit state (GIT-07).
 */
export type RestackRebaseOutcome = Readonly<{
  readonly workingCopyId: string;
  readonly clean: boolean;
  readonly conflictingPaths: readonly string[];
  /** Paths flagged by a semantic detector (rename/behavior); empty when none. */
  readonly semanticConflictPaths: readonly string[];
  /** Commit id of the rebased change (clean or conflicted). */
  readonly newCommitId: GitSha;
  /** Stable jj change id of the rebased change (jj preserves change ids across rebase). */
  readonly newChangeId: ContentHash;
  readonly ancestry: RestackRebaseAncestry;
  readonly operationLogId: ContentHash;
}>;

/** Receipt for {@link RestackWorkingCopy.squashResolve}. */
export type RestackSquashReceipt = Readonly<{
  readonly commitSha: GitSha;
  readonly changeId: ContentHash;
  readonly operationLogId: ContentHash;
  readonly ancestry: RestackRebaseAncestry;
}>;

/**
 * The masked jj working-copy surface the restack coordinator needs. PR 28's
 * {@link JjWorkingCopyManager} satisfies `diff` structurally; `rebase` and
 * `squashResolve` are the restack-specific operations, invoked through the same
 * serialized broker. The production wiring wraps a JjWorkingCopyManager and
 * adds the two operations (running `jj rebase -r <change> -d <parent>` and
 * `jj squash` through the broker). The per-operation jj op-log id is carried on
 * each rebase/squash receipt; crash recovery reads durable bindings, not a
 * separate op-log probe.
 */
export interface RestackWorkingCopy {
  /** Rebase `changeId` onto `newParentCommit` through the broker. */
  rebase(
    workingCopyId: string,
    changeId: ContentHash,
    newParentCommit: GitSha,
  ): Promise<RestackRebaseOutcome>;
  /** The conflict diff bytes (for {@link detectConflictMarkers}). */
  diff(workingCopyId: string): Promise<Uint8Array>;
  /**
   * Squash the working-copy resolution into the original change under `message`,
   * returning the squashed commit + ancestry. Used after a successful repair.
   */
  squashResolve(workingCopyId: string, message: NonEmptyText): Promise<RestackSquashReceipt>;
}

/** Outcome of one bounded repair attempt over a conflicted working copy. */
export type RestackRepairAttemptOutcome = Readonly<{
  readonly resolved: boolean;
  readonly resolutionText: string;
}>;

/**
 * The node's OMP session, abstracted to the repair surface the coordinator
 * needs: given a conflicted working copy + its conflict bundle, attempt one
 * resolution pass. The harness re-reads the conflict markers from the workspace
 * and proposes a resolution; `resolved` is true when the workspace no longer
 * conflicts after the attempt.
 */
export interface RestackRepairHarness {
  attemptRepair(
    input: Readonly<{
      readonly workingCopyId: string;
      readonly conflict: ConflictBundle;
      readonly treeId: TaskTreeId;
      readonly nodeId: TaskNodeId;
    }>,
  ): Promise<RestackRepairAttemptOutcome>;
}

/**
 * Sink for stale-gate invalidation. The coordinator reports every restacked
 * node (outcome other than `aborted`); the PR 32 push guard consumes this to
 * reject pushes whose gate/review receipts predate the restack.
 */
export interface RestackStaleSink {
  invalidateStale(nodeIds: readonly TaskNodeId[]): Promise<void>;
}

/** Why a restacked node escalated to typed human attention. */
export type RestackAttentionKind = "repair_exhausted" | "no_harness" | "multi_parent";

/**
 * Typed human attention for a conflicted descendant. Produced when repair is
 * exhausted (or unavailable). The workspace is preserved (`preservedWorkingCopyId`)
 * so a human can inspect the conflicted tree; the binding records durable
 * conflict-as-commit state.
 */
export type RestackHumanAttention = Readonly<{
  readonly treeId: TaskTreeId;
  readonly nodeId: TaskNodeId;
  readonly kind: RestackAttentionKind;
  readonly conflict: ConflictBundle;
  readonly attempts: number;
  readonly reason: string;
  readonly preservedWorkingCopyId: string;
}>;

/** Persistence seam for {@link RestackHumanAttention}. */
export interface RestackAttentionSink {
  record(attention: RestackHumanAttention): Promise<void>;
}

/** Minimal structured logger. Optional; defaults to a silent sink. */
export interface RestackLogger {
  debug(message: string, meta?: Readonly<Record<string, unknown>>): void;
  info(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error(message: string, meta?: Readonly<Record<string, unknown>>): void;
}

// -------------------------------------------------------------------------------------------------
// Options + factory surface.
// -------------------------------------------------------------------------------------------------

export type RestackCoordinatorOptions = Readonly<{
  /** Serialized working-copy broker surface (PR 28 + rebase/squash). */
  readonly workingCopy: RestackWorkingCopy;
  /** Durable change-id binding store (PR 29). */
  readonly bindingStore: VcsChangeBindingStore;
  /** Optional repair harness (the node's OMP session). */
  readonly repairHarness?: RestackRepairHarness;
  /** Optional stale-gate invalidation sink (PR 32 push guard). */
  readonly staleSink?: RestackStaleSink;
  /** Optional typed-human-attention sink. */
  readonly attentionSink?: RestackAttentionSink;
  /** Per-node repair ceiling; defaults to {@link DEFAULT_REPAIR_CEILING} (PR 26). */
  readonly repairCeiling?: number;
  /** Commit message applied to a squashed repair resolution. */
  readonly repairCommitMessage?: NonEmptyText;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Optional structured logger; defaults to a silent sink. */
  readonly logger?: RestackLogger;
}>;

export interface RestackCoordinator {
  restack(request: RestackRequest): Promise<RestackReceipt>;
  /**
   * Fail-closed export gate. Throws {@link RestackError}(`export_blocked`) if
   * any of `nodeIds` is still in a conflicted binding state. The PR 32 push
   * guard calls this before pushing (GIT-07: block export until conflict-free).
   */
  assertExportReady(treeId: TaskTreeId, nodeIds: readonly TaskNodeId[]): Promise<void>;
}

// -------------------------------------------------------------------------------------------------
// Internal constants + helpers.
// -------------------------------------------------------------------------------------------------

const silentLogger: RestackLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

const DEFAULT_REPAIR_MESSAGE = nonEmptyText("resolve restack conflict", "repair commit message");
const TEXT_DECODER = new TextDecoder();

function defaultDigest(utf8: string): ContentHash {
  return contentHash(createHash("sha256").update(utf8).digest("hex"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restackError(
  code: RestackErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): RestackError {
  return new RestackError(code, message, remediation, cause);
}

/**
 * Has this descendant already been restacked in a prior (crashed) run? A binding
 * that has advanced off the pre-restack commit AND is not in an unresolved
 * conflict state represents durable progress: retry resumes past it. Pure.
 */
function isAlreadyRestacked(binding: VcsChangeBinding, descendant: DescendantNode): boolean {
  if (binding.currentCommitId === descendant.currentCommitId) {
    return false;
  }
  return binding.conflictState === "clean" || binding.conflictState === "resolved";
}

// -------------------------------------------------------------------------------------------------
// Factory.
// -------------------------------------------------------------------------------------------------

/**
 * Compose the working-copy broker, binding store, optional repair harness, and
 * repair retry budget into a restack coordinator. The coordinator depends only
 * on ports — concrete adapters are injected, never imported.
 */
export function createRestackCoordinator(options: RestackCoordinatorOptions): RestackCoordinator {
  const workingCopy = options.workingCopy;
  const bindingStore = options.bindingStore;
  const repairHarness = options.repairHarness;
  const staleSink = options.staleSink;
  const attentionSink = options.attentionSink;
  const repairCeiling = options.repairCeiling ?? DEFAULT_REPAIR_CEILING;
  const repairCommitMessage = options.repairCommitMessage ?? DEFAULT_REPAIR_MESSAGE;
  const clock = options.clock;
  const ids = options.ids;
  const logger = options.logger ?? silentLogger;

  if (!Number.isSafeInteger(repairCeiling) || repairCeiling < 0) {
    throw new RangeError(
      `repairCeiling must be a non-negative integer, got ${String(repairCeiling)}`,
    );
  }

  return {
    async restack(request: RestackRequest): Promise<RestackReceipt> {
      validateRestackRequest(request);
      const order = subtreeOrder(request.descendants);

      // Resolved commits per node (the new ancestry as it is built, parent-first).
      // Seeded with the rewritten parent so first-level descendants can stack on it.
      const resolvedCommits = new Map<TaskNodeId, GitSha>();
      resolvedCommits.set(request.parentNodeId, request.newParentCommit);

      const results: RestackNodeResult[] = [];
      let aborted = false;

      for (const descendant of order) {
        if (aborted) {
          results.push(abortedResult(descendant.nodeId));
          continue;
        }
        const newParent = resolvedCommits.get(descendant.parentNodeId);
        if (newParent === undefined) {
          // Parent-first ordering guarantees this never fires; fail-closed anyway.
          results.push(abortedResult(descendant.nodeId));
          aborted = true;
          continue;
        }

        // Crash recovery: a prior (crashed) run may have restacked this node.
        const existing = await readBinding(request.treeId, descendant.nodeId);
        if (existing !== undefined && isAlreadyRestacked(existing, descendant)) {
          resolvedCommits.set(descendant.nodeId, existing.currentCommitId);
          results.push(
            cleanResult(
              descendant.nodeId,
              existing.currentCommitId,
              descendant.jjChangeId,
              existing.rewriteGeneration,
            ),
          );
          logger.info("restack_skip_already_restacked", {
            tree_id: request.treeId,
            node_id: descendant.nodeId,
          });
          continue;
        }

        // Rebase through the broker.
        let outcome: RestackRebaseOutcome;
        try {
          outcome = await workingCopy.rebase(
            descendant.workingCopyId,
            descendant.jjChangeId,
            newParent,
          );
        } catch (error: unknown) {
          // Crash mid-rebase: the durable state (binding + jj op-log) survives.
          // Mark this and every subsequent node aborted; the caller retries and
          // resume skips the already-restacked prefix (GIT-07 crash recovery).
          logger.warn("restack_rebase_crashed", {
            tree_id: request.treeId,
            node_id: descendant.nodeId,
            error: errorMessage(error),
          });
          results.push(abortedResult(descendant.nodeId));
          aborted = true;
          continue;
        }

        const result = await processRebaseOutcome(request, descendant, outcome, existing);
        results.push(result);

        if (result.outcome === "clean" || result.outcome === "repaired") {
          const commit = result.newCommitId;
          if (commit !== undefined) {
            resolvedCommits.set(descendant.nodeId, commit);
          }
        } else {
          // conflict / exhausted: descendants cannot stack on a conflicted parent.
          aborted = true;
        }
      }

      await invalidateStale(request.treeId, results);

      const receiptId = ids.nextId();
      logger.info("restack_completed", {
        receipt_id: receiptId,
        tree_id: request.treeId,
        total: results.length,
        conflicts: results.filter((r) => r.outcome === "conflict" || r.outcome === "exhausted")
          .length,
      });

      return buildReceipt(request, results, receiptId, clock.now());
    },

    async assertExportReady(treeId: TaskTreeId, nodeIds: readonly TaskNodeId[]): Promise<void> {
      for (const nodeId of nodeIds) {
        const binding = await bindingStore.getBinding(treeId, nodeId);
        if (binding === undefined) {
          continue;
        }
        if (binding.conflictState === "conflict") {
          throw restackError(
            "export_blocked",
            `node '${nodeId}' is in a conflicted binding state; export is blocked until the conflict is resolved (GIT-07)`,
            "Restack the node to a clean/resolved state before exporting.",
          );
        }
      }
    },
  };

  // -----------------------------------------------------------------------------------------------
  // Per-outcome processing.
  // -----------------------------------------------------------------------------------------------

  async function processRebaseOutcome(
    request: RestackRequest,
    descendant: DescendantNode,
    outcome: RestackRebaseOutcome,
    existing: VcsChangeBinding | undefined,
  ): Promise<RestackNodeResult> {
    // Ancestry is verified first for BOTH clean and conflicted outcomes: a
    // multi-parent result is rejected regardless of conflict state (GIT-05).
    const ancestryInput: RestackAncestry = {
      nodeId: descendant.nodeId,
      parentCount: outcome.ancestry.parentCount,
      parentCommitIds: outcome.ancestry.parentCommitIds,
    };
    const verdict = validateAncestry(ancestryInput);
    if (!verdict.valid) {
      // Invariant breach — a single-parent jj rebase cannot produce this. The
      // conflicted change is durable (preserved), but export is blocked and the
      // node escalates immediately. `multi_parent_detected` is the merge/fan-in
      // case (GIT-05); any other ancestry breach is `ancestry_invalid`.
      const code: RestackErrorCode =
        outcome.ancestry.parentCount > 1 ? "multi_parent_detected" : "ancestry_invalid";
      const attentionKind: RestackAttentionKind = "multi_parent";
      const conflict = await buildConflictBundle(request, descendant, outcome, "semantic", false);
      await recordDurableConflict(request, descendant, outcome);
      await emitAttention({
        treeId: request.treeId,
        nodeId: descendant.nodeId,
        kind: attentionKind,
        conflict,
        attempts: 0,
        reason: verdict.reason,
        preservedWorkingCopyId: descendant.workingCopyId,
      });
      // Fail-closed: an invalid ancestry is a hard rejection, not a retryable conflict.
      throw restackError(
        code,
        verdict.reason,
        "Re-run the restack; a single-parent rebase must not produce a merge or orphan.",
      );
    }

    if (outcome.clean) {
      return await recordClean(request, descendant, outcome, existing);
    }

    // Conflicted: build the bundle (textual vs semantic) and attempt repair.
    const diffBytes = await readDiff(descendant.workingCopyId);
    const diffText = TEXT_DECODER.decode(diffBytes);
    const markers = detectConflictMarkers(diffText);
    const kind =
      markers.length > 0 || outcome.semanticConflictPaths.length === 0 ? "textual" : "semantic";
    const conflict = await buildConflictBundle(request, descendant, outcome, kind, true, diffText);

    // Record durable conflict state up-front (conflict-as-commit). If repair
    // succeeds this is transitioned to `resolved`; if exhausted it stays `conflict`.
    await recordDurableConflict(request, descendant, outcome);

    if (repairHarness === undefined) {
      // No harness: straight to typed human attention. Workspace preserved.
      await emitAttention({
        treeId: request.treeId,
        nodeId: descendant.nodeId,
        kind: "no_harness",
        conflict,
        attempts: 0,
        reason: "no repair harness configured; conflict requires human resolution",
        preservedWorkingCopyId: descendant.workingCopyId,
      });
      return conflictResult(descendant.nodeId, conflict);
    }

    return await attemptBoundedRepair(
      request,
      descendant,
      outcome,
      existing,
      conflict,
      repairHarness,
    );
  }

  async function recordClean(
    request: RestackRequest,
    descendant: DescendantNode,
    outcome: RestackRebaseOutcome,
    existing: VcsChangeBinding | undefined,
  ): Promise<RestackNodeResult> {
    // A clean rebase of a previously-conflicted node resolves the conflict.
    const nextState = existing?.conflictState === "conflict" ? "resolved" : "clean";
    const generation = await updateBinding(
      request,
      descendant,
      outcome.newCommitId,
      outcome.newChangeId,
      outcome.operationLogId,
      nextState,
    );
    return cleanResult(descendant.nodeId, outcome.newCommitId, outcome.newChangeId, generation);
  }

  async function attemptBoundedRepair(
    request: RestackRequest,
    descendant: DescendantNode,
    outcome: RestackRebaseOutcome,
    existing: VcsChangeBinding | undefined,
    conflict: ConflictBundle,
    harness: RestackRepairHarness,
  ): Promise<RestackNodeResult> {
    let budget: RetryBudget = createRetryBudget(repairCeiling);
    const resolutionTexts: string[] = [];
    let attempts = 0;

    while (canRetry(budget)) {
      attempts += 1;
      let attempt: RestackRepairAttemptOutcome;
      try {
        attempt = await harness.attemptRepair({
          workingCopyId: descendant.workingCopyId,
          conflict,
          treeId: request.treeId,
          nodeId: descendant.nodeId,
        });
      } catch (error: unknown) {
        logger.warn("restack_repair_attempt_threw", {
          tree_id: request.treeId,
          node_id: descendant.nodeId,
          attempt: attempts,
          error: errorMessage(error),
        });
        resolutionTexts.push(errorMessage(error));
        budget = consume(budget);
        continue;
      }
      resolutionTexts.push(attempt.resolutionText);

      if (!attempt.resolved) {
        budget = consume(budget);
        continue;
      }

      // Repair resolved the conflict: squash the resolution into the original
      // change and verify clean (single-parent) ancestry (GIT-05).
      const squashed = await workingCopy.squashResolve(
        descendant.workingCopyId,
        repairCommitMessage,
      );
      const squashVerdict = validateAncestry({
        nodeId: descendant.nodeId,
        parentCount: squashed.ancestry.parentCount,
        parentCommitIds: squashed.ancestry.parentCommitIds,
      });
      if (!squashVerdict.valid) {
        throw restackError(
          "multi_parent_detected",
          squashVerdict.reason,
          "The squashed repair resolution produced a merge; reject and re-run.",
        );
      }

      const generation = await updateBinding(
        request,
        descendant,
        squashed.commitSha,
        descendant.jjChangeId,
        squashed.operationLogId,
        "resolved",
      );
      logger.info("restack_repair_succeeded", {
        tree_id: request.treeId,
        node_id: descendant.nodeId,
        attempts,
      });
      return repairedResult(
        descendant.nodeId,
        squashed.commitSha,
        descendant.jjChangeId,
        generation,
        conflict,
      );
    }

    // Budget exhausted: durable conflict-as-commit, workspace preserved, human attention.
    await emitAttention({
      treeId: request.treeId,
      nodeId: descendant.nodeId,
      kind: "repair_exhausted",
      conflict,
      attempts,
      reason: `repair budget exhausted after ${String(attempts)} attempt(s); conflict unresolved`,
      preservedWorkingCopyId: descendant.workingCopyId,
    });
    logger.warn("restack_repair_exhausted", {
      tree_id: request.treeId,
      node_id: descendant.nodeId,
      attempts,
      ceiling: repairCeiling,
    });
    return exhaustedResult(descendant.nodeId, conflict);
  }

  // -----------------------------------------------------------------------------------------------
  // Binding I/O.
  // -----------------------------------------------------------------------------------------------

  async function readBinding(
    treeId: TaskTreeId,
    nodeId: TaskNodeId,
  ): Promise<VcsChangeBinding | undefined> {
    try {
      return await bindingStore.getBinding(treeId, nodeId);
    } catch (error: unknown) {
      throw restackError(
        "binding_update_failed",
        `failed to read binding for node '${nodeId}': ${errorMessage(error)}`,
        "Inspect the binding store and rerun the restack.",
        error,
      );
    }
  }

  async function updateBinding(
    request: RestackRequest,
    descendant: DescendantNode,
    commitId: GitSha,
    changeId: ContentHash,
    operationLogId: ContentHash,
    nextState: "clean" | "conflict" | "resolved",
  ): Promise<RewriteGeneration> {
    // Re-read the live binding: a prior step in this restack (e.g.
    // recordDurableConflict) may have already advanced the conflict state and
    // rewrite generation. The transition check and carry-over fields must
    // reflect the durable store, not a stale snapshot from before the rebase.
    const current = await readBinding(request.treeId, descendant.nodeId);
    const from = current?.conflictState ?? "clean";
    if (!isValidConflictTransition(from, nextState)) {
      throw restackError(
        "binding_update_failed",
        `invalid conflict-state transition for node '${descendant.nodeId}': ${from} -> ${nextState}`,
        "Inspect the binding lifecycle; the transition table is in vcs-change-binding.ts.",
      );
    }
    const generation: RewriteGeneration = (current?.rewriteGeneration ?? 0) + 1;
    const binding: VcsChangeBinding = Object.freeze({
      treeId: request.treeId,
      nodeId: descendant.nodeId,
      jjChangeId: changeId,
      currentCommitId: commitId,
      parentChangeId: current?.parentChangeId ?? descendant.jjChangeId,
      bookmark: current?.bookmark,
      rewriteGeneration: generation,
      lastJjOperationId: operationLogId,
      lastPushedCommitId: current?.lastPushedCommitId,
      lastReviewedCommitId: current?.lastReviewedCommitId,
      conflictState: nextState,
      recordedAt: clock.now(),
    });
    try {
      await bindingStore.upsertBinding(binding);
    } catch (error: unknown) {
      throw restackError(
        "binding_update_failed",
        `failed to record binding for node '${descendant.nodeId}': ${errorMessage(error)}`,
        "Inspect the binding store and rerun the restack; the rebase already landed in the working copy.",
        error,
      );
    }
    return generation;
  }

  async function recordDurableConflict(
    request: RestackRequest,
    descendant: DescendantNode,
    outcome: RestackRebaseOutcome,
  ): Promise<void> {
    // Conflict-as-commit (GIT-07): the conflicted change's commit is durable
    // state. The binding records it under conflictState "conflict" so the export
    // guard blocks until a human (or a later repair) resolves it. The workspace
    // is NOT destroyed — a human can inspect the conflicted tree.
    await updateBinding(
      request,
      descendant,
      outcome.newCommitId,
      outcome.newChangeId,
      outcome.operationLogId,
      "conflict",
    );
  }

  // -----------------------------------------------------------------------------------------------
  // Sinks.
  // -----------------------------------------------------------------------------------------------

  async function invalidateStale(
    treeId: TaskTreeId,
    results: readonly RestackNodeResult[],
  ): Promise<void> {
    if (staleSink === undefined) {
      return;
    }
    const stale = invalidateStaleGates(results);
    if (stale.length === 0) {
      return;
    }
    try {
      await staleSink.invalidateStale(stale);
    } catch (error: unknown) {
      // Best-effort: the receipt still carries the outcomes; do not fail the
      // restack because the stale sink was unavailable.
      logger.error("restack_stale_invalidation_failed", {
        tree_id: treeId,
        error: errorMessage(error),
      });
    }
  }

  async function emitAttention(attention: RestackHumanAttention): Promise<void> {
    if (attentionSink === undefined) {
      return;
    }
    try {
      await attentionSink.record(attention);
    } catch (error: unknown) {
      logger.error("restack_attention_persist_failed", {
        node_id: attention.nodeId,
        kind: attention.kind,
        error: errorMessage(error),
      });
    }
  }

  async function readDiff(workingCopyId: string): Promise<Uint8Array> {
    try {
      return await workingCopy.diff(workingCopyId);
    } catch (error: unknown) {
      throw restackError(
        "restack_failed",
        `failed to read conflict diff: ${errorMessage(error)}`,
        "Inspect the working copy via the broker; destroy and recreate it if it is corrupt.",
        error,
      );
    }
  }

  async function buildConflictBundle(
    request: RestackRequest,
    descendant: DescendantNode,
    outcome: RestackRebaseOutcome,
    kind: "textual" | "semantic",
    ancestryValid: boolean,
    diffText?: string,
  ): Promise<ConflictBundle> {
    if (diffText === undefined) {
      const bytes = await readDiff(descendant.workingCopyId);
      diffText = TEXT_DECODER.decode(bytes);
    }
    const markers = detectConflictMarkers(diffText);
    const contentDelta = defaultDigest(diffText);
    const ancestorDelta = defaultDigest(
      `${request.newParentCommit}\n${outcome.conflictingPaths.join("\n")}\n${outcome.semanticConflictPaths.join("\n")}`,
    );
    return Object.freeze({
      nodeId: descendant.nodeId,
      kind,
      conflictingPaths: Object.freeze([
        ...outcome.conflictingPaths,
        ...outcome.semanticConflictPaths,
      ]),
      conflictMarkers: markers,
      ancestryValid,
      contentDelta,
      ancestorDelta,
    });
  }
}

// -------------------------------------------------------------------------------------------------
// Pure request validation + result builders.
// -------------------------------------------------------------------------------------------------

function validateRestackRequest(request: RestackRequest): void {
  if (request.descendants.length === 0) {
    throw restackError(
      "restack_failed",
      "restack request requires at least one descendant",
      "Pass the descendant set stacked on the rewritten parent.",
    );
  }
  const seen = new Set<TaskNodeId>();
  for (const node of request.descendants) {
    if (seen.has(node.nodeId)) {
      throw restackError(
        "restack_failed",
        `duplicate descendant node '${node.nodeId}'`,
        "Pass a de-duplicated descendant set.",
      );
    }
    seen.add(node.nodeId);
  }
}

function cleanResult(
  nodeId: TaskNodeId,
  commitId: GitSha,
  changeId: ContentHash,
  generation: RewriteGeneration,
): RestackNodeResult {
  return Object.freeze({
    nodeId,
    outcome: "clean",
    conflict: undefined,
    newCommitId: commitId,
    newChangeId: changeId,
    rewriteGeneration: generation,
  });
}

function repairedResult(
  nodeId: TaskNodeId,
  commitId: GitSha,
  changeId: ContentHash,
  generation: RewriteGeneration,
  conflict: ConflictBundle,
): RestackNodeResult {
  return Object.freeze({
    nodeId,
    outcome: "repaired",
    conflict,
    newCommitId: commitId,
    newChangeId: changeId,
    rewriteGeneration: generation,
  });
}

function conflictResult(nodeId: TaskNodeId, conflict: ConflictBundle): RestackNodeResult {
  return Object.freeze({
    nodeId,
    outcome: "conflict",
    conflict,
    newCommitId: undefined,
    newChangeId: undefined,
    rewriteGeneration: undefined,
  });
}

function exhaustedResult(nodeId: TaskNodeId, conflict: ConflictBundle): RestackNodeResult {
  return Object.freeze({
    nodeId,
    outcome: "exhausted",
    conflict,
    newCommitId: undefined,
    newChangeId: undefined,
    rewriteGeneration: undefined,
  });
}

function abortedResult(nodeId: TaskNodeId): RestackNodeResult {
  return Object.freeze({
    nodeId,
    outcome: "aborted",
    conflict: undefined,
    newCommitId: undefined,
    newChangeId: undefined,
    rewriteGeneration: undefined,
  });
}

function buildReceipt(
  request: RestackRequest,
  results: readonly RestackNodeResult[],
  receiptId: string,
  completedAt: Timestamp,
): RestackReceipt {
  const restackedNodes = Object.freeze([...results]);
  const conflictNodes = Object.freeze(
    results.filter((r) => r.outcome === "conflict" || r.outcome === "exhausted"),
  );
  const cleanNodes = Object.freeze(
    results.filter((r) => r.outcome === "clean" || r.outcome === "repaired"),
  );
  const abortedNodes = Object.freeze(results.filter((r) => r.outcome === "aborted"));
  return Object.freeze({
    receiptId,
    treeId: request.treeId,
    parentNodeId: request.parentNodeId,
    restackedNodes,
    conflictNodes,
    cleanNodes,
    abortedNodes,
    completedAt,
  });
}
