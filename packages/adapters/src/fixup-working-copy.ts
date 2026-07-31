/**
 * Production {@link FixupWorkingCopy} (PR 39, deliverable 2 concrete layer) —
 * wraps a {@link JjWorkingCopyManager} (PR 28's broker, extended with
 * `newChange` / `squashInto` / `applyPatch` / `describeRevision` /
 * `currentOperationId` / `restoreOperation`) to implement the fixup
 * coordinator's absorb surface against a REAL jj working copy, instead of only
 * `test/integration/adapters/fixup.test.ts`'s test-local fake.
 *
 * ContentHash resolution: `createChildFixup` / `applyFix` / `absorb` all speak
 * in the durable {@link ContentHash} fingerprint space (matching
 * `VcsChangeBinding.jjChangeId` — see vcs-change-binding.ts), never raw jj
 * change ids or broker working-copy ids. SHA-256 fingerprinting
 * ({@link changeIdFingerprint}) is one-way, so this adapter cannot invert a
 * `ContentHash` on its own; it resolves through an injected
 * {@link JjChangeIdRegistry} (defaults to a private, per-adapter instance).
 * `registerChange` (exposed beyond the {@link FixupWorkingCopy} port, on
 * {@link ProductionFixupWorkingCopy}) lets a caller teach the adapter a raw jj
 * identity's fingerprint before referencing it; `createChildFixup` registers
 * the fixup change it creates itself, so only the ALREADY-EXISTING
 * originating/descendant changes need registering up front (e.g. by resolving
 * a durably-recorded commit SHA to its local change id within the target
 * working copy — see fixup-working-copy.test.ts for a worked example against a
 * real git+jj repo).
 *
 * `absorb()` independently re-verifies rather than trusting the squash
 * receipt alone: it captures the working copy's current jj operation id
 * before squashing (the rollback anchor), runs `jjManager.squashInto`, then
 * separately re-queries the resulting graph to confirm the originating
 * change's parent count, the restacked descendant's parent count, AND that
 * the fixup change is now gone (unresolvable — jj abandons an emptied
 * change). Any of those checks failing rolls back via
 * `jjManager.restoreOperation` to the captured anchor and throws a typed
 * error; `absorb()` never returns a receipt describing a state it has not
 * itself confirmed. A genuine textual conflict (the fix not folding cleanly)
 * is NOT a rollback condition here — like restack-coordinator.ts, a conflict
 * is durable, inspectable commit state (conflict-as-commit); it is reported
 * via `AbsorbReceipt.outcome`/`conflictMarkers` for the coordinator's own
 * `conflict_in_absorb` rejection, not silently undone.
 *
 * Composition scope: this factory makes the port genuinely real-implementable
 * — a working `FixupWorkingCopy` a `createFixupCoordinator` composition CAN
 * use, backed by real jj. Wiring it as the daemon's default (an RPC
 * composition root importing `createFixupCoordinator({ workingCopy:
 * createProductionFixupWorkingCopy(jjManager), ... })`) is out of scope here —
 * no such composition point exists yet in apps/daemon (the same pre-accepted
 * "not composed into the real daemon" gap as node-execution's production
 * wiring).
 */
import type { ContentHash } from "@minions/core";
import { detectConflictMarkers } from "@minions/core";

import type {
  AbsorbOutcome,
  AbsorbReceipt,
  FixContent,
  FixupWorkingCopy,
} from "./fixup-coordinator.js";
import { changeIdFingerprint } from "./fixup-coordinator.js";
import { createJjChangeIdRegistry, type JjChangeIdRegistry } from "./jj-change-registry.js";
import type { JjSquashReceipt, JjWorkingCopyManager } from "./jj-working-copy.js";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type ProductionFixupWorkingCopyErrorCode =
  | "resolve_failed"
  | "create_child_failed"
  | "apply_fix_failed"
  | "absorb_failed"
  | "verification_failed"
  | "mis_targeted_working_copy"
  | "rollback_failed";

/** Typed production-adapter error. Fail-closed: every invariant breach surfaces a typed code. */
export class ProductionFixupWorkingCopyError extends Error {
  readonly code: ProductionFixupWorkingCopyErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(
    code: ProductionFixupWorkingCopyErrorCode,
    message: string,
    remediation: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProductionFixupWorkingCopyError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Public surface.
// -------------------------------------------------------------------------------------------------

/** {@link FixupWorkingCopy} plus the registration seam a real caller needs to bootstrap it. */
export interface ProductionFixupWorkingCopy extends FixupWorkingCopy {
  /**
   * Teach the adapter that `rawChangeId`, currently live in `workingCopyId` (a
   * {@link JjWorkingCopyManager} broker id), is the change a {@link
   * FixupTarget}'s `descendantChangeId` / `originatingChangeId` will refer to.
   * Returns the fingerprint the caller must then pass as that `ContentHash`.
   */
  registerChange(workingCopyId: string, rawChangeId: string): ContentHash;
}

/**
 * Compose a {@link JjWorkingCopyManager} (and, optionally, a shared {@link
 * JjChangeIdRegistry} — defaults to a private per-adapter instance) into a
 * real, jj-backed {@link FixupWorkingCopy}.
 */
export function createProductionFixupWorkingCopy(
  jjManager: JjWorkingCopyManager,
  registry: JjChangeIdRegistry = createJjChangeIdRegistry(),
): ProductionFixupWorkingCopy {
  function resolve(
    changeId: ContentHash,
    role: "descendant" | "fixup" | "originating",
  ): Readonly<{ workingCopyId: string; rawChangeId: string }> {
    try {
      return registry.resolve(changeId);
    } catch (error: unknown) {
      throw new ProductionFixupWorkingCopyError(
        "resolve_failed",
        `could not resolve the ${role} change '${changeId}' to a raw jj identity: ${errorMessage(error)}`,
        "Call registerChange(workingCopyId, rawChangeId) for this change before referencing it in a FixupTarget.",
        error,
      );
    }
  }

  return {
    registerChange(workingCopyId: string, rawChangeId: string): ContentHash {
      return registry.register(workingCopyId, rawChangeId);
    },

    async createChildFixup(
      descendantChangeId: ContentHash,
    ): Promise<Readonly<{ readonly fixupChangeId: ContentHash }>> {
      const descendant = resolve(descendantChangeId, "descendant");
      let created: Readonly<{ changeId: string }>;
      try {
        created = await jjManager.newChange(descendant.workingCopyId, descendant.rawChangeId);
      } catch (error: unknown) {
        throw new ProductionFixupWorkingCopyError(
          "create_child_failed",
          `failed to create a child fixup change on '${descendantChangeId}': ${errorMessage(error)}`,
          "Inspect the working copy via the broker; ensure the descendant change is resolvable.",
          error,
        );
      }
      const fixupChangeId = registry.register(descendant.workingCopyId, created.changeId);
      return Object.freeze({ fixupChangeId });
    },

    async applyFix(fixupChangeId: ContentHash, fix: FixContent): Promise<void> {
      const fixup = resolve(fixupChangeId, "fixup");
      try {
        await jjManager.applyPatch(fixup.workingCopyId, fix.patch);
      } catch (error: unknown) {
        throw new ProductionFixupWorkingCopyError(
          "apply_fix_failed",
          `failed to apply fix content to fixup change '${fixupChangeId}': ${errorMessage(error)}`,
          "Inspect the patch content; it must be a unified diff that applies cleanly to the fixup change's working copy.",
          error,
        );
      }
    },

    async absorb(
      fixupChangeId: ContentHash,
      originatingChangeId: ContentHash,
    ): Promise<AbsorbReceipt> {
      const fixup = resolve(fixupChangeId, "fixup");
      const origin = resolve(originatingChangeId, "originating");
      if (fixup.workingCopyId !== origin.workingCopyId) {
        throw new ProductionFixupWorkingCopyError(
          "mis_targeted_working_copy",
          `fixup change '${fixupChangeId}' and originating change '${originatingChangeId}' resolve to different working copies ('${fixup.workingCopyId}' vs '${origin.workingCopyId}'); jj squash requires both revisions in the same repo`,
          "Register both the fixup and the originating change against the same working copy before absorbing.",
        );
      }
      const workingCopyId = fixup.workingCopyId;

      // Capture the descendant's identity BEFORE squashing (the fixup change
      // itself becomes unresolvable once absorbed, so its parent must be read
      // now to report the restacked descendant afterward).
      let preDescendantChangeId: string;
      try {
        preDescendantChangeId = (
          await jjManager.describeRevision(workingCopyId, `${fixup.rawChangeId}-`)
        ).changeId;
      } catch (error: unknown) {
        throw new ProductionFixupWorkingCopyError(
          "absorb_failed",
          `failed to resolve the descendant of fixup change '${fixupChangeId}': ${errorMessage(error)}`,
          "Inspect the working copy via the broker; the fixup change must have exactly one parent.",
          error,
        );
      }

      const rollbackOperationId = await jjManager.currentOperationId(workingCopyId);

      let squashed: JjSquashReceipt;
      try {
        squashed = await jjManager.squashInto(workingCopyId, fixup.rawChangeId, origin.rawChangeId);
      } catch (error: unknown) {
        throw new ProductionFixupWorkingCopyError(
          "absorb_failed",
          `jj squash --from '${fixup.rawChangeId}' --into '${origin.rawChangeId}' failed: ${errorMessage(error)}`,
          "Inspect the working copy via the broker; the fixup change is preserved for retry.",
          error,
        );
      }

      // Independent re-verification: do NOT trust the squash receipt alone.
      let fixupStillResolvable = true;
      try {
        await jjManager.describeRevision(workingCopyId, fixup.rawChangeId);
      } catch {
        fixupStillResolvable = false;
      }
      const restackedDescribed = await jjManager.describeRevision(
        workingCopyId,
        preDescendantChangeId,
      );

      if (
        squashed.parentCount !== 1 ||
        restackedDescribed.parentCount !== 1 ||
        fixupStillResolvable
      ) {
        try {
          await jjManager.restoreOperation(workingCopyId, rollbackOperationId);
        } catch (error: unknown) {
          throw new ProductionFixupWorkingCopyError(
            "rollback_failed",
            `absorb of '${fixupChangeId}' into '${originatingChangeId}' failed independent verification AND the rollback to the pre-absorb operation also failed: ${errorMessage(error)}`,
            "Inspect the working copy directly via jj op log; it may be left in a post-absorb state that failed verification.",
            error,
          );
        }
        throw new ProductionFixupWorkingCopyError(
          "verification_failed",
          `absorb of '${fixupChangeId}' into '${originatingChangeId}' failed independent verification (originating parentCount=${String(squashed.parentCount)}, restacked parentCount=${String(restackedDescribed.parentCount)}, fixup still resolvable=${String(fixupStillResolvable)}); rolled back to the pre-absorb operation`,
          "Re-target the fixup at the true originating ancestor; a correctly-targeted absorb never leaves a multi-parent result or a still-resolvable fixup change.",
        );
      }

      const outcome: AbsorbOutcome = squashed.conflicted ? "conflict" : "clean";
      const conflictMarkers = squashed.conflicted
        ? detectConflictMarkers(
            new TextDecoder().decode(
              await jjManager.diffRevision(workingCopyId, squashed.changeId),
            ),
          )
        : [];

      return Object.freeze({
        outcome,
        originatingCommit: squashed.commit,
        originatingChangeId: registry.register(workingCopyId, squashed.changeId),
        parentCount: squashed.parentCount,
        restackedChangeId: registry.register(workingCopyId, restackedDescribed.changeId),
        restackedCommit: restackedDescribed.commit,
        restackedParentCount: restackedDescribed.parentCount,
        // Same SHA-256-into-ContentHash fingerprint changeIdFingerprint uses for
        // change ids (mirrors commit-capture's captureOperationLogId, PR 30):
        // jj operation ids exceed the binding's 64-hex ContentHash space.
        operationLogId: changeIdFingerprint(squashed.operationLogId),
        conflictMarkers,
      });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
