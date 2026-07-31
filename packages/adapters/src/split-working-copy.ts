/**
 * Production {@link SplitWorkingCopy} (PR 40, deliverable 2 concrete layer) —
 * wraps a {@link JjWorkingCopyManager} (PR 28's broker, extended with `split`)
 * to implement the split coordinator's segment surface against a REAL jj
 * working copy, instead of only `test/integration/adapters/node-split.test.ts`'s
 * test-local fake ("The working-copy broker is a test double (mocked jj
 * split)").
 *
 * ContentHash resolution mirrors fixup-working-copy.ts exactly: `splitSegment`
 * speaks in the durable {@link ContentHash} fingerprint space
 * (`VcsChangeBinding.jjChangeId`), never raw jj change ids, so it resolves
 * through an injected {@link JjChangeIdRegistry} (defaults to a private
 * instance; share one with a fixup adapter via the constructor param if both
 * operate against the same working copy). `registerChange` lets a caller teach
 * the adapter a raw jj identity's fingerprint before referencing it.
 *
 * Known residual gap — `SplitSegment.hunkRanges` (optional, sub-file hunk-level
 * splitting): jj's `jj split` CLI has no scriptable non-interactive path for
 * partial-file hunk selection. `--tool <NAME>` always launches a diff-editor
 * process (interactive, or an external tool jj drives through a TUI-oriented
 * protocol); there is no `--hunks <spec>` or stdin-scriptable equivalent in jj
 * 0.43. Reverse-engineering the interactive diff-editor protocol to script
 * hunk selection was judged out of scope for this task's time budget. A
 * `hunkRanges`-only segment (no `fileset`, or a segment whose intent is
 * sub-file) throws a typed `hunk_ranges_not_supported` error; fileset-level
 * segments (the common case — the fixture proposal in this task's own tests)
 * are fully supported end to end against the real binary.
 *
 * Composition scope: this factory makes the port genuinely real-implementable.
 * Wiring it as the daemon's default is out of scope — no `createSplitCoordinator`
 * composition point exists in apps/daemon (grepped, confirmed empty), the same
 * pre-accepted gap as node-execution's production wiring.
 */
import type { ContentHash, SplitSegment } from "@minions/core";

import { changeIdFingerprint } from "./fixup-coordinator.js";
import { createJjChangeIdRegistry, type JjChangeIdRegistry } from "./jj-change-registry.js";
import type { JjSplitReceipt, JjWorkingCopyManager } from "./jj-working-copy.js";
import type { SplitSegmentReceipt, SplitWorkingCopy } from "./split-coordinator.js";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type ProductionSplitWorkingCopyErrorCode =
  "resolve_failed" | "hunk_ranges_not_supported" | "split_failed";

/** Typed production-adapter error. Fail-closed: every invariant breach surfaces a typed code. */
export class ProductionSplitWorkingCopyError extends Error {
  readonly code: ProductionSplitWorkingCopyErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(
    code: ProductionSplitWorkingCopyErrorCode,
    message: string,
    remediation: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProductionSplitWorkingCopyError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Public surface.
// -------------------------------------------------------------------------------------------------

/** {@link SplitWorkingCopy} plus the registration seam a real caller needs to bootstrap it. */
export interface ProductionSplitWorkingCopy extends SplitWorkingCopy {
  /**
   * Teach the adapter that `rawChangeId`, currently live in `workingCopyId` (a
   * {@link JjWorkingCopyManager} broker id), is the change a split proposal's
   * `nodeId` binding will refer to. Returns the fingerprint.
   */
  registerChange(workingCopyId: string, rawChangeId: string): ContentHash;
}

/**
 * Compose a {@link JjWorkingCopyManager} (and, optionally, a shared {@link
 * JjChangeIdRegistry} — e.g. the same one a co-located production
 * `FixupWorkingCopy` uses, defaults to a private per-adapter instance) into a
 * real, jj-backed {@link SplitWorkingCopy}.
 */
export function createProductionSplitWorkingCopy(
  jjManager: JjWorkingCopyManager,
  registry: JjChangeIdRegistry = createJjChangeIdRegistry(),
): ProductionSplitWorkingCopy {
  return {
    registerChange(workingCopyId: string, rawChangeId: string): ContentHash {
      return registry.register(workingCopyId, rawChangeId);
    },

    async splitSegment(
      originalChangeId: ContentHash,
      segment: SplitSegment,
      segmentIndex: number,
    ): Promise<SplitSegmentReceipt> {
      if (segment.hunkRanges !== undefined && segment.hunkRanges.length > 0) {
        throw new ProductionSplitWorkingCopyError(
          "hunk_ranges_not_supported",
          `segment ${String(segmentIndex)} ('${segment.label}') specifies hunkRanges; jj's CLI has no non-interactive path for sub-file hunk selection (only fileset-level 'jj split <paths...>' is scriptable)`,
          "Express the segment at fileset (whole-file) granularity, or resolve the split interactively outside this broker.",
        );
      }
      let resolved: Readonly<{ workingCopyId: string; rawChangeId: string }>;
      try {
        resolved = registry.resolve(originalChangeId);
      } catch (error: unknown) {
        throw new ProductionSplitWorkingCopyError(
          "resolve_failed",
          `could not resolve the original change '${originalChangeId}' to a raw jj identity: ${errorMessage(error)}`,
          "Call registerChange(workingCopyId, rawChangeId) for this change before splitting it.",
          error,
        );
      }
      let receipt: JjSplitReceipt;
      try {
        receipt = await jjManager.split(
          resolved.workingCopyId,
          resolved.rawChangeId,
          segment.fileset,
          segment.label,
        );
      } catch (error: unknown) {
        throw new ProductionSplitWorkingCopyError(
          "split_failed",
          `jj split failed for segment ${String(segmentIndex)} ('${segment.label}') on change '${originalChangeId}': ${errorMessage(error)}`,
          "Inspect the working copy via the broker; the original change is preserved for retry.",
          error,
        );
      }
      return Object.freeze({
        segmentIndex,
        changeId: registry.register(resolved.workingCopyId, receipt.changeId),
        commit: receipt.commit,
        parentCount: receipt.parentCount,
        operationLogId: changeIdFingerprint(receipt.operationLogId),
      });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
