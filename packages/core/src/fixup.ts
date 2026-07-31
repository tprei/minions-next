/**
 * Fixup targeting domain (PR 39 / GIT-09, QA-07).
 *
 * Routes a review fix made while editing a descendant change C back to its
 * originating ancestor change A via jj absorb. The fix becomes a temporary
 * child fixup change of C, is folded into A (`jj absorb` / `jj squash --into`),
 * and jj's native restack re-stacks C onto the rewritten A. Mis-targeting — the
 * fix being routed to a change that is not the ancestor of the edited change, or
 * the fix content not folding cleanly into A — is detected and blocked at the
 * absorb boundary (the coordinator, PR 39 deliverable 2).
 *
 * Pure domain: no I/O, no crypto. The change-id identities carried on
 * {@link FixupTarget} are the durable {@link ContentHash} fingerprints stored on
 * {@link VcsChangeBinding}s, so every helper here is a plain structural
 * comparison. The adapter fingerprints raw jj change ids into this space (the
 * same SHA-256 fingerprint commit-capture / the binding store already use).
 */
import type { ContentHash, TaskNodeId, TaskTreeId } from "./value-objects.js";
import type { VcsChangeBinding } from "./vcs-change-binding.js";

// -------------------------------------------------------------------------------------------------
// Value shapes.
// -------------------------------------------------------------------------------------------------

/**
 * The target of a fixup absorb. `fixNodeId` is the originating ancestor node A
 * whose change receives the fix; `originatingChangeId` is A's durable change-id
 * fingerprint (the absorb target); `descendantChangeId` is C's change-id
 * fingerprint (the descendant being edited — a temporary child fixup change is
 * created on it, then folded into A). `fixupChangeId`, when present, is a
 * pre-created temporary fixup change (the coordinator skips creation and uses
 * it directly); otherwise the coordinator creates one via the broker.
 */
export type FixupTarget = Readonly<{
  readonly treeId: TaskTreeId;
  readonly fixNodeId: TaskNodeId;
  readonly originatingChangeId: ContentHash;
  readonly descendantChangeId: ContentHash;
  readonly fixupChangeId?: ContentHash;
}>;

/**
 * Terminal result of a fixup absorb. `restackedNodes` carries the node ids jj's
 * native restack touched (at minimum the edited descendant C); the originating
 * change A is NOT listed here — it absorbed the fix, it was not restacked.
 * `invalidatedEvidence` lists the node ids whose gate/review receipts are now
 * stale (every restacked descendant). `verificationPassed` is `true` only when
 * the absorb produced a single-parent result and folded cleanly.
 */
export type FixupResult = Readonly<{
  readonly absorbed: boolean;
  readonly restackedNodes: readonly string[];
  readonly invalidatedEvidence: readonly string[];
  readonly verificationPassed: boolean;
}>;

/**
 * Dry-run preview of a fixup absorb. `updatedChangeId` is the originating
 * change A (its commit will change); `restackedChangeIds` are A's bound
 * descendants (auto-restacked); `invalidatedNodes` are their node ids (gate +
 * review receipts go stale). Pure: computed from bindings alone.
 */
export type FixupPreview = Readonly<{
  readonly updatedChangeId: ContentHash;
  readonly restackedChangeIds: readonly ContentHash[];
  readonly invalidatedNodes: readonly TaskNodeId[];
}>;

/** Verdict from {@link validateFixupTarget}. `reason` is non-empty when invalid. */
export type FixupTargetVerdict = Readonly<{ readonly valid: boolean; readonly reason?: string }>;

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/**
 * Validate the structural shape of a fixup target before any broker work. A
 * fixup MUST target a change other than the one being edited (absorbing a fix
 * into the editing change itself is a no-op and a mis-targeting smell), and a
 * pre-created fixup change must differ from both. Returns `{ valid, reason }`;
 * the coordinator maps an invalid verdict to `mis_targeting_detected`. Pure.
 */
export function validateFixupTarget(target: FixupTarget): FixupTargetVerdict {
  if (target.originatingChangeId === target.descendantChangeId) {
    return Object.freeze({
      valid: false,
      reason:
        "originating and descendant change ids are identical; a fixup cannot target the change being edited (mis-targeting)",
    });
  }
  if (target.fixupChangeId !== undefined) {
    if (target.fixupChangeId === target.originatingChangeId) {
      return Object.freeze({
        valid: false,
        reason: "fixup change id must differ from the originating change id",
      });
    }
    if (target.fixupChangeId === target.descendantChangeId) {
      return Object.freeze({
        valid: false,
        reason: "fixup change id must differ from the descendant change id",
      });
    }
  }
  return Object.freeze({ valid: true });
}

/**
 * Preview which changes a fixup absorb affects, computed purely from bindings.
 * The originating change A is updated (its commit changes); every bound
 * descendant of A — reachable through the `parentChangeId` chain — is
 * auto-restacked and its gate/review evidence becomes stale. Returns an empty
 * `restackedChangeIds` set when A is not present in `bindings` (the coordinator
 * surfaces that as `target_not_found`). Pure: no I/O, no crypto.
 */
export function previewAffectedChanges(
  bindings: readonly VcsChangeBinding[],
  target: FixupTarget,
): FixupPreview {
  const byChange = new Map<ContentHash, VcsChangeBinding>();
  for (const binding of bindings) {
    byChange.set(binding.jjChangeId, binding);
  }

  const restacked: ContentHash[] = [];
  const invalidated: TaskNodeId[] = [];
  for (const binding of bindings) {
    if (binding.jjChangeId === target.originatingChangeId) {
      continue;
    }
    if (isDescendantByChangeId(byChange, binding.jjChangeId, target.originatingChangeId)) {
      restacked.push(binding.jjChangeId);
      invalidated.push(binding.nodeId);
    }
  }

  return Object.freeze({
    updatedChangeId: target.originatingChangeId,
    restackedChangeIds: Object.freeze(restacked),
    invalidatedNodes: Object.freeze(invalidated),
  });
}

// -------------------------------------------------------------------------------------------------
// Internal helpers.
// -------------------------------------------------------------------------------------------------

/**
 * Is the change `descendantId` a descendant of `ancestorId`? Walks the
 * `parentChangeId` chain through `byChange` until it reaches `ancestorId`
 * (true) or a change with no parent / an unknown parent (false). Cycle-safe.
 * Pure.
 */
function isDescendantByChangeId(
  byChange: ReadonlyMap<ContentHash, VcsChangeBinding>,
  descendantId: ContentHash,
  ancestorId: ContentHash,
): boolean {
  const visited = new Set<ContentHash>();
  let current: ContentHash | undefined = descendantId;
  while (current !== undefined) {
    if (current === ancestorId) {
      return true;
    }
    if (visited.has(current)) {
      // Defensive: a binding cycle is corrupt state, not a descendant relation.
      return false;
    }
    visited.add(current);
    const binding = byChange.get(current);
    if (binding === undefined) {
      return false;
    }
    current = binding.parentChangeId;
  }
  return false;
}
