/**
 * Fixup coordinator (PR 39, deliverable 2) — routes a review fix to the
 * originating change via jj absorb.
 *
 * When editing a descendant change C, a fix destined for the ancestor change A
 * is turned into a temporary child fixup change of C, folded into A through
 * `jj absorb` / `jj squash --into`, and jj's native restack re-stacks C onto the
 * rewritten A. The coordinator verifies the absorb produced a single-parent
 * result (rejecting multi-parent merge/fan-in — GIT-05/GIT-06), blocks
 * mis-targeting (the fix routed to a change that is not C's ancestor, or the
 * fix content not folding cleanly into A), and rewrites the durable bindings
 * (rewriteGeneration++ + new commits) while invalidating the gate/review
 * evidence of every restacked descendant (GIT-09, QA-07).
 *
 * Composes three PRs behind ports:
 *  - PR 28 (jjWorkingCopyManager): the absorb/new/restack surface, abstracted
 *    here as {@link FixupWorkingCopy}. The production wiring wraps a
 *    {@link JjWorkingCopyManager} and adds the absorb operations through the
 *    same serialized broker.
 *  - PR 29 (bindingStore): the durable {@link VcsChangeBindingStore}.
 *  - PR 30 (commitCapture): evidence invalidation mirrors its
 *    `markStaleDescendants` semantics — restacked descendants' gate/review
 *    receipts go stale.
 *
 * The coordinator never invokes jj directly; every mutation flows through the
 * injected broker. Fail-closed: every invariant breach surfaces a typed
 * {@link FixupError}.
 */

import { createHash } from "node:crypto";

import {
  contentHash,
  isValidConflictTransition,
  nonEmptyText,
  previewAffectedChanges,
  validateFixupTarget,
  type Clock,
  type ConflictMarker,
  type ContentHash,
  type GitSha,
  type IdGenerator,
  type NonEmptyText,
  type RewriteGeneration,
  type TaskTreeId,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";

import type { FixupPreview, FixupResult, FixupTarget } from "@minions/core";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type FixupErrorCode =
  | "target_not_found"
  | "absorb_failed"
  | "multi_parent_result"
  | "conflict_in_absorb"
  | "binding_update_failed"
  | "mis_targeting_detected";

/** Typed fixup error. Fail-closed: every invariant breach surfaces a typed code. */
export class FixupError extends Error {
  readonly code: FixupErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: FixupErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FixupError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Ports.
// -------------------------------------------------------------------------------------------------

/**
 * The fix content to fold into the originating change. `patch` is a unified
 * diff applied to the temporary fixup change's working copy before the absorb.
 */
export type FixContent = Readonly<{
  readonly patch: NonEmptyText;
}>;

/** Outcome of a {@link FixupWorkingCopy.absorb} through the broker. */
export type AbsorbOutcome = "clean" | "conflict" | "multi_parent";

/**
 * Receipt for {@link FixupWorkingCopy.absorb}. Carries everything the
 * coordinator needs to verify the absorb (single-parent result), rewrite the
 * bindings, and record invalidated evidence.
 */
export type AbsorbReceipt = Readonly<{
  readonly outcome: AbsorbOutcome;
  /** New commit of the originating change A after the fix is folded in. */
  readonly originatingCommit: GitSha;
  /** Stable change id of A after the absorb (jj may rewrite it on squash). */
  readonly originatingChangeId: ContentHash;
  /** Parent count of the resulting A; MUST be 1 (a jj change has exactly one). */
  readonly parentCount: number;
  /** New change id of the restacked descendant C. */
  readonly restackedChangeId: ContentHash;
  /** New commit of the restacked descendant C. */
  readonly restackedCommit: GitSha;
  /** Parent count of the restacked C; MUST be 1 (no merge/fan-in — GIT-05). */
  readonly restackedParentCount: number;
  /** jj operation-log id after the absorb + native restack. */
  readonly operationLogId: ContentHash;
  /** Textual conflict markers parsed from the absorb; non-empty on conflict. */
  readonly conflictMarkers: readonly ConflictMarker[];
}>;

/**
 * The masked jj working-copy surface the fixup coordinator needs. PR 28's
 * {@link JjWorkingCopyManager} satisfies the broker contract; `createChildFixup`
 * (`jj new` on the descendant), `applyFix` (write the patch), and `absorb`
 * (`jj absorb` / `jj squash --into`) are the fixup-specific operations, invoked
 * through the same serialized broker. Change-id handles are the durable
 * {@link ContentHash} fingerprints stored on bindings; the production wiring
 * resolves them to raw jj change ids against the working copy.
 */
export interface FixupWorkingCopy {
  /** Create a temporary empty child change on top of `descendantChangeId`. */
  createChildFixup(
    descendantChangeId: ContentHash,
  ): Promise<Readonly<{ readonly fixupChangeId: ContentHash }>>;
  /** Apply the fix content (patch) to the fixup change's working copy. */
  applyFix(fixupChangeId: ContentHash, fix: FixContent): Promise<void>;
  /**
   * Fold the fixup change into the originating change and auto-restack the
   * descendant. Returns the post-absorb receipt.
   */
  absorb(fixupChangeId: ContentHash, originatingChangeId: ContentHash): Promise<AbsorbReceipt>;
}

/** Minimal structured logger. Optional; defaults to a silent sink. */
export interface FixupLogger {
  debug(message: string, meta?: Readonly<Record<string, unknown>>): void;
  info(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error(message: string, meta?: Readonly<Record<string, unknown>>): void;
}

// -------------------------------------------------------------------------------------------------
// Options + factory surface.
// -------------------------------------------------------------------------------------------------

export type FixupCoordinatorOptions = Readonly<{
  /** Serialized working-copy broker surface (PR 28 + absorb/new). */
  readonly workingCopy: FixupWorkingCopy;
  /** Durable change-id binding store (PR 29). */
  readonly bindingStore: VcsChangeBindingStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Optional structured logger; defaults to a silent sink. */
  readonly logger?: FixupLogger;
}>;

export interface FixupCoordinator {
  /**
   * Absorb a review fix into the originating change: create a temporary child
   * fixup change on the descendant, apply the fix, fold it into the originating
   * change via jj absorb, verify a single-parent result, auto-restack the
   * descendant, invalidate stale evidence, and rewrite the bindings.
   */
  absorbFixup(target: FixupTarget, fix: FixContent): Promise<FixupResult>;
  /** Dry-run preview of the affected changes + invalidated evidence. */
  previewAbsorb(target: FixupTarget): Promise<FixupPreview>;
}

// -------------------------------------------------------------------------------------------------
// Internal helpers.
// -------------------------------------------------------------------------------------------------

const silentLogger: FixupLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

const DEFAULT_FIXUP_MESSAGE = nonEmptyText("absorb review fixup into originating change", "fixup");

function fixupError(
  code: FixupErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): FixupError {
  return new FixupError(code, message, remediation, cause);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function markerPaths(markers: readonly ConflictMarker[]): string {
  if (markers.length === 0) {
    return "(no paths)";
  }
  return markers.map((marker) => marker.path).join(", ");
}

// -------------------------------------------------------------------------------------------------
// Factory.
// -------------------------------------------------------------------------------------------------

/**
 * Compose the working-copy broker and binding store into a fixup coordinator.
 * The coordinator depends only on ports — concrete adapters are injected, never
 * imported. Throws {@link FixupError} on any invariant breach (fail-closed).
 */
export function createFixupCoordinator(options: FixupCoordinatorOptions): FixupCoordinator {
  const workingCopy = options.workingCopy;
  const bindingStore = options.bindingStore;
  const clock = options.clock;
  const ids = options.ids;
  const logger = options.logger ?? silentLogger;

  return {
    async absorbFixup(target: FixupTarget, fix: FixContent): Promise<FixupResult> {
      const fixupId = ids.nextId();

      // 1. Structural validation — a fixup may not target the editing change.
      const verdict = validateFixupTarget(target);
      if (!verdict.valid) {
        throw fixupError(
          "mis_targeting_detected",
          `invalid fixup target: ${verdict.reason ?? "unknown"}`,
          "Re-target the fixup at the originating ancestor change, not the change being edited.",
        );
      }

      // 2. Resolve bindings for the originating (A) and descendant (C) changes.
      const [originBinding, descendantBinding] = await Promise.all([
        readBindingByChange(target.treeId, target.originatingChangeId, "originating"),
        readBindingByChange(target.treeId, target.descendantChangeId, "descendant"),
      ]);

      // 3. Mis-targeting detection (structural): C MUST be a descendant of A.
      //    A fix routed to a change that is not the ancestor of the edited
      //    change is mis-targeted — block before any jj mutation.
      const bindings = await listBindings(target.treeId);
      const preview = previewAffectedChanges(bindings, target);
      if (!preview.restackedChangeIds.includes(target.descendantChangeId)) {
        throw fixupError(
          "mis_targeting_detected",
          `descendant change is not a descendant of the originating change '${target.originatingChangeId}'; the fix is routed to a change that is not the ancestor of the edited change`,
          "Re-target the fixup at the true originating ancestor of the edited change.",
        );
      }

      // 4. Create the temporary child fixup change (or reuse a provided one).
      let fixupChangeId = target.fixupChangeId;
      if (fixupChangeId === undefined) {
        try {
          const created = await workingCopy.createChildFixup(target.descendantChangeId);
          fixupChangeId = created.fixupChangeId;
        } catch (error: unknown) {
          throw fixupError(
            "absorb_failed",
            `failed to create child fixup change on '${target.descendantChangeId}': ${errorMessage(error)}`,
            "Inspect the working copy via the broker; destroy and recreate it if it is corrupt.",
            error,
          );
        }
      }

      // 5. Apply the fix content to the fixup change.
      try {
        await workingCopy.applyFix(fixupChangeId, fix);
      } catch (error: unknown) {
        throw fixupError(
          "absorb_failed",
          `failed to apply fix content to fixup change '${fixupChangeId}': ${errorMessage(error)}`,
          "Inspect the patch and the working copy via the broker.",
          error,
        );
      }

      // 6. Fold the fixup into the originating change and auto-restack C.
      let receipt: AbsorbReceipt;
      try {
        receipt = await workingCopy.absorb(fixupChangeId, target.originatingChangeId);
      } catch (error: unknown) {
        throw fixupError(
          "absorb_failed",
          `jj absorb failed for fixup '${fixupChangeId}' into '${target.originatingChangeId}': ${errorMessage(error)}`,
          "Inspect the working copy via the broker; the fixup change is preserved for retry.",
          error,
        );
      }

      // 7. Verify a single-parent result — reject multi-parent (merge/fan-in).
      if (receipt.parentCount > 1 || receipt.restackedParentCount > 1) {
        throw fixupError(
          "multi_parent_result",
          `absorb produced a multi-parent result (originating parentCount=${String(receipt.parentCount)}, restacked parentCount=${String(receipt.restackedParentCount)}); a jj change must have exactly one parent (GIT-05/GIT-06)`,
          "Re-run the absorb; a single-parent fold must not produce a merge or fan-in.",
        );
      }
      if (receipt.outcome === "multi_parent") {
        throw fixupError(
          "multi_parent_result",
          `absorb reported a multi-parent outcome for fixup '${fixupChangeId}'`,
          "Re-run the absorb; a single-parent fold must not produce a merge or fan-in.",
        );
      }

      // 8. Reject a conflict in the absorb — the fix did not fold cleanly into
      //    A. This is the runtime mis-targeting signal: a correctly-targeted
      //    fix applies without conflict. Block with a typed error; the fixup
      //    change is preserved for inspection.
      if (receipt.outcome === "conflict" || receipt.conflictMarkers.length > 0) {
        throw fixupError(
          "conflict_in_absorb",
          `absorb of fixup '${fixupChangeId}' into '${target.originatingChangeId}' conflicted at ${markerPaths(receipt.conflictMarkers)}; the fix content does not fold cleanly into the originating change (mis-targeting)`,
          "Re-target the fixup at the change the fix actually belongs to, or resolve the conflict and retry.",
        );
      }

      // 9. Rewrite bindings: A absorbs the fix (rewriteGeneration++ + new
      //    commit); C is restacked (new change id + commit). Evidence for every
      //    restacked descendant is invalidated.
      const nextOriginGeneration = await rewriteOriginBinding(
        target.treeId,
        originBinding,
        receipt,
      );
      await rewriteDescendantBinding(target.treeId, descendantBinding, receipt);

      const restackedNodes: string[] = [String(descendantBinding.nodeId)];
      const invalidatedEvidence = preview.invalidatedNodes.map((nodeId) => String(nodeId));

      logger.info("fixup_absorbed", {
        fixup_id: fixupId,
        tree_id: target.treeId,
        originating_node: originBinding.nodeId,
        originating_generation: nextOriginGeneration,
        restacked_node: descendantBinding.nodeId,
        invalidated: invalidatedEvidence.length,
      });

      return Object.freeze({
        absorbed: true,
        restackedNodes: Object.freeze(restackedNodes),
        invalidatedEvidence: Object.freeze(invalidatedEvidence),
        verificationPassed: true,
      });
    },

    async previewAbsorb(target: FixupTarget): Promise<FixupPreview> {
      const verdict = validateFixupTarget(target);
      if (!verdict.valid) {
        throw fixupError(
          "mis_targeting_detected",
          `invalid fixup target: ${verdict.reason ?? "unknown"}`,
          "Re-target the fixup at the originating ancestor change, not the change being edited.",
        );
      }
      // Validate both endpoints exist (target_not_found) before computing the
      // affected set. The preview itself is pure over the listed bindings.
      await readBindingByChange(target.treeId, target.originatingChangeId, "originating");
      await readBindingByChange(target.treeId, target.descendantChangeId, "descendant");
      const bindings = await listBindings(target.treeId);
      return previewAffectedChanges(bindings, target);
    },
  };

  // -----------------------------------------------------------------------------------------------
  // Binding I/O.
  // -----------------------------------------------------------------------------------------------

  async function readBindingByChange(
    treeId: TaskTreeId,
    changeId: ContentHash,
    role: "originating" | "descendant",
  ): Promise<VcsChangeBinding> {
    let binding: VcsChangeBinding | undefined;
    try {
      binding = await bindingStore.getByChangeId(treeId, changeId);
    } catch (error: unknown) {
      throw fixupError(
        "binding_update_failed",
        `failed to read ${role} binding for change '${changeId}': ${errorMessage(error)}`,
        "Inspect the binding store and rerun the fixup.",
        error,
      );
    }
    if (binding === undefined) {
      throw fixupError(
        "target_not_found",
        `no binding found for the ${role} change '${changeId}' in tree '${treeId}'`,
        "Ensure both the originating and descendant changes have captured bindings before absorbing.",
      );
    }
    return binding;
  }

  async function listBindings(treeId: TaskTreeId): Promise<readonly VcsChangeBinding[]> {
    try {
      return await bindingStore.listForTree(treeId);
    } catch (error: unknown) {
      throw fixupError(
        "binding_update_failed",
        `failed to list bindings for tree '${treeId}': ${errorMessage(error)}`,
        "Inspect the binding store and rerun the fixup.",
        error,
      );
    }
  }

  async function rewriteOriginBinding(
    treeId: TaskTreeId,
    existing: VcsChangeBinding,
    receipt: AbsorbReceipt,
  ): Promise<RewriteGeneration> {
    // The absorb rewrites A: advance the generation, carry the new commit, and
    // keep the conflict lifecycle consistent (a clean absorb keeps/stabilizes a
    // clean state; a previously-conflicted A is resolved by the clean fold).
    const fromState = existing.conflictState;
    const nextState: "clean" | "conflict" | "resolved" =
      fromState === "conflict" ? "resolved" : "clean";
    if (!isValidConflictTransition(fromState, nextState)) {
      throw fixupError(
        "binding_update_failed",
        `invalid conflict-state transition for originating node '${existing.nodeId}': ${fromState} -> ${nextState}`,
        "Inspect the binding lifecycle; the transition table is in vcs-change-binding.ts.",
      );
    }
    const generation: RewriteGeneration = existing.rewriteGeneration + 1;
    const binding: VcsChangeBinding = Object.freeze({
      treeId,
      nodeId: existing.nodeId,
      jjChangeId: receipt.originatingChangeId,
      currentCommitId: receipt.originatingCommit,
      parentChangeId: existing.parentChangeId,
      bookmark: existing.bookmark,
      rewriteGeneration: generation,
      lastJjOperationId: receipt.operationLogId,
      lastPushedCommitId: existing.lastPushedCommitId,
      lastReviewedCommitId: existing.lastReviewedCommitId,
      conflictState: nextState,
      recordedAt: clock.now(),
    });
    try {
      await bindingStore.upsertBinding(binding);
    } catch (error: unknown) {
      throw fixupError(
        "binding_update_failed",
        `failed to record originating binding for node '${existing.nodeId}': ${errorMessage(error)}`,
        "Inspect the binding store and rerun the fixup; the absorb already landed in the working copy.",
        error,
      );
    }
    return generation;
  }

  async function rewriteDescendantBinding(
    treeId: TaskTreeId,
    existing: VcsChangeBinding,
    receipt: AbsorbReceipt,
  ): Promise<void> {
    // C is restacked onto the rewritten A: new change id + commit, advanced
    // generation, clean state (a clean restack resolves a prior conflict).
    const fromState = existing.conflictState;
    const nextState: "clean" | "conflict" | "resolved" =
      fromState === "conflict" ? "resolved" : "clean";
    if (!isValidConflictTransition(fromState, nextState)) {
      throw fixupError(
        "binding_update_failed",
        `invalid conflict-state transition for descendant node '${existing.nodeId}': ${fromState} -> ${nextState}`,
        "Inspect the binding lifecycle; the transition table is in vcs-change-binding.ts.",
      );
    }
    const generation: RewriteGeneration = existing.rewriteGeneration + 1;
    const binding: VcsChangeBinding = Object.freeze({
      treeId,
      nodeId: existing.nodeId,
      jjChangeId: receipt.restackedChangeId,
      currentCommitId: receipt.restackedCommit,
      // The restack re-parented C onto the rewritten A.
      parentChangeId: receipt.originatingChangeId,
      bookmark: existing.bookmark,
      rewriteGeneration: generation,
      lastJjOperationId: receipt.operationLogId,
      lastPushedCommitId: existing.lastPushedCommitId,
      lastReviewedCommitId: existing.lastReviewedCommitId,
      conflictState: nextState,
      recordedAt: clock.now(),
    });
    try {
      await bindingStore.upsertBinding(binding);
    } catch (error: unknown) {
      throw fixupError(
        "binding_update_failed",
        `failed to record descendant binding for node '${existing.nodeId}': ${errorMessage(error)}`,
        "Inspect the binding store and rerun the fixup; the restack already landed in the working copy.",
        error,
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Convenience.
// -------------------------------------------------------------------------------------------------

/**
 * Deterministic SHA-256 fingerprint of a raw jj change id (32-char) into the
 * binding's 64-hex {@link ContentHash} identity space. Stable: the same raw
 * change id always fingerprints to the same binding identity. Mirrors the
 * fingerprint commit-capture and the binding store already use.
 */
export function changeIdFingerprint(rawChangeId: string): ContentHash {
  return contentHash(createHash("sha256").update(rawChangeId).digest("hex"));
}

/** Default commit message applied to an absorbed fixup. */
export const DEFAULT_FIXUP_COMMIT_MESSAGE: NonEmptyText = DEFAULT_FIXUP_MESSAGE;
