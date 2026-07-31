/**
 * Recovery coordinator (PR 37 / REC-03..10) — drives ordered, isolated-error
 * reconciliation of every host subsystem after a crash, plus separate
 * compaction (archive + tombstone) and purge (physical removal + tombstone
 * drop) passes.
 *
 * The coordinator owns ORDER and ISOLATION only. Each subsystem is reached
 * through a {@link RecoveryReconciler} port; the canonical sequence comes from
 * {@link orderedPhases} (blobs -> ... -> landing receipts). A corrupt/ambiguous
 * node in one phase is captured as a {@link RecoveryError} and the next phase
 * still runs (REC-04). A restart is {@link RecoveryReport.converged} only when
 * every executed phase converged with zero errors — the daemon holds new
 * scheduling until then (REC-03).
 *
 * Compaction and purge are distinct from recovery and from each other:
 * {@link RecoveryCoordinator.compact} archives old events/blobs/transcripts and
 * creates tombstones; {@link RecoveryCoordinator.purge} physically removes
 * tombstoned items past the purge window and drops their tombstones
 * (REC-07..10). {@link shouldCompact} / {@link shouldPurge} are the pure
 * cadence predicates a scheduler uses to decide when to call them.
 */
import {
  orderedPhases,
  recoveryBoundary,
  recoveryError,
  recoveryReport,
  retentionPolicy,
  type ContentBlobStore,
  type ExpectedBlob,
  type RecoveryBoundary,
  type RecoveryBoundaryStatus,
  type RecoveryError,
  type RecoveryPhase,
  type RecoveryReport,
  type RetentionPolicy,
  type SchedulerStore,
  type Timestamp,
} from "@minions/core";
import type { Clock } from "@minions/core";
import type { WorkspaceManager } from "./workspace-manager.js";

// -------------------------------------------------------------------------------------------------
// Per-phase reconciliation.
// -------------------------------------------------------------------------------------------------

/**
 * What one phase produced. `beforeId` / `afterId` are the opaque state
 * identities observed immediately before and after the phase ran (a digest,
 * commit SHA, generation, ...). `reconciledCount` is durable progress made this
 * run; `divergentCount > 0` marks the boundary `divergent` (e.g. missing or
 * corrupt digests) without failing the whole recovery.
 */
export type PhaseReconciliation = Readonly<{
  /** Human-readable boundary name (e.g. `blob`, `workspace`, `vcs_oplog`). */
  boundary: string;
  /** State identity before reconciliation, when observable. */
  beforeId: string | undefined;
  /** State identity after reconciliation, when observable. */
  afterId: string | undefined;
  /** Durable progress made this run (items recovered / expired / archived). */
  reconciledCount: number;
  /** Divergences observed but not fatal (missing/corrupt/stale items). */
  divergentCount: number;
  /** Free-form operator detail, when useful. */
  notes: string | undefined;
}>;

/**
 * Reconcile exactly one {@link RecoveryPhase}. The coordinator calls
 * {@link reconcile} in canonical order; a throw becomes an isolated
 * {@link RecoveryError} (default) and the next phase still runs.
 */
export interface RecoveryReconciler {
  /** The phase this reconciler owns. */
  readonly phase: RecoveryPhase;
  /** Reconcile the subsystem; return what was done. */
  reconcile(): Promise<PhaseReconciliation>;
}

// -------------------------------------------------------------------------------------------------
// Compaction + purge (distinct from recovery).
// -------------------------------------------------------------------------------------------------

/** Result of a compaction (archive) pass: old items folded into tombstones. */
export type CompactionReport = Readonly<{
  /** Epoch ms the pass completed. */
  compactedAt: number;
  /** Events folded into a tombstoned/archived form. */
  eventsCompacted: number;
  /** Blobs folded into a tombstoned/archived form. */
  blobsCompacted: number;
  /** Transcripts folded into a tombstoned/archived form. */
  transcriptsCompacted: number;
  /** Tombstones created this pass (the archive markers purge later drops). */
  tombstonesCreated: number;
}>;

/** Result of a purge pass: tombstoned items physically removed. */
export type PurgeReport = Readonly<{
  /** Epoch ms the pass completed. */
  purgedAt: number;
  /** Events physically purged. */
  eventsPurged: number;
  /** Blobs physically purged. */
  blobsPurged: number;
  /** Transcripts physically purged. */
  transcriptsPurged: number;
  /** Tombstones dropped this pass (the items they marked are now gone). */
  tombstonesPurged: number;
}>;

/** Compact old events/blobs/transcripts into tombstoned form per `policy`. */
export interface RecoveryCompactor {
  compact(policy: RetentionPolicy, now: number): Promise<CompactionReport>;
}

/** Physically purge tombstoned items past the purge window per `policy`. */
export interface RecoveryPurger {
  purge(policy: RetentionPolicy, now: number): Promise<PurgeReport>;
}

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type RecoveryCoordinatorErrorCode =
  /**
   * A phase reconciler threw while recovery is configured fail-fast
   * (`isolateErrors: false`). With the default isolated mode the throw is
   * captured as a {@link RecoveryError} instead.
   */
  | "phase_failed"
  /** Recovery ran but did not converge and `failIfNotConverged` was set. */
  | "convergence_failed"
  /** A compaction pass failed. */
  | "compaction_failed"
  /** A purge pass failed. */
  | "purge_failed";

/** Typed recovery-coordinator error. Fail-closed: every I/O failure surfaces one. */
export class RecoveryCoordinatorError extends Error {
  readonly code: RecoveryCoordinatorErrorCode;

  constructor(code: RecoveryCoordinatorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecoveryCoordinatorError";
    this.code = code;
  }
}

// -------------------------------------------------------------------------------------------------
// Options + coordinator surface.
// -------------------------------------------------------------------------------------------------

/** Minimal structured logger. Optional; defaults to a silent sink. */
export interface RecoveryLogger {
  log(event: string, payload?: Readonly<Record<string, unknown>>): void;
}

const SILENT_LOGGER: RecoveryLogger = Object.freeze({ log: () => undefined });

export type RecoveryCoordinatorOptions = Readonly<{
  /** Epoch-millisecond clock. */
  readonly now: () => number;
  /**
   * One reconciler per phase, keyed by {@link RecoveryPhase}. Phases without an
   * entry are skipped (not failed). Explicit entries override any built-in
   * adapter helper.
   */
  readonly reconcilers?: Partial<Record<RecoveryPhase, RecoveryReconciler>>;
  /** Compaction (archive) port. Required for {@link RecoveryCoordinator.compact}. */
  readonly compactor?: RecoveryCompactor;
  /** Purge port. Required for {@link RecoveryCoordinator.purge}. */
  readonly purger?: RecoveryPurger;
  readonly logger?: RecoveryLogger;
  /**
   * Default `true`: a phase throw becomes an isolated {@link RecoveryError} and
   * recovery continues (REC-04). `false`: the first throw aborts recovery as a
   * `phase_failed` {@link RecoveryCoordinatorError}.
   */
  readonly isolateErrors?: boolean;
  /**
   * Default `false`: {@link RecoveryCoordinator.recover} always returns a
   * report. `true`: throw `convergence_failed` when the report is not
   * converged — the daemon uses this to hold scheduling until the host is
   * consistent (REC-03).
   */
  readonly failIfNotConverged?: boolean;
}>;

export interface RecoveryCoordinator {
  /**
   * Reconcile every attached subsystem in canonical order with isolated errors.
   * Returns a {@link RecoveryReport}; never throws for per-phase failures
   * unless `isolateErrors: false`. Throws `convergence_failed` only when
   * `failIfNotConverged` is set and the host did not converge.
   */
  recover(): Promise<RecoveryReport>;
  /** Archive old events/blobs/transcripts into tombstoned form. */
  compact(policy: RetentionPolicy): Promise<CompactionReport>;
  /** Physically purge tombstoned items past the purge window. */
  purge(policy: RetentionPolicy): Promise<PurgeReport>;
}

// -------------------------------------------------------------------------------------------------
// Factory.
// -------------------------------------------------------------------------------------------------

/**
 * Compose per-phase reconcilers, a compactor, and a purger into an ordered,
 * isolated-error recovery coordinator. The coordinator depends only on ports —
 * concrete stores/adapters are injected (directly or via the
 * `blobReconciler` / `schedulerLeaseReconciler` / `workspaceReconciler`
 * helpers), never imported.
 */
export function createRecoveryCoordinator(
  options: RecoveryCoordinatorOptions,
): RecoveryCoordinator {
  return new ComposedRecoveryCoordinator(
    options.now,
    options.reconcilers ?? {},
    options.compactor,
    options.purger,
    options.logger ?? SILENT_LOGGER,
    options.isolateErrors ?? true,
    options.failIfNotConverged ?? false,
  );
}

class ComposedRecoveryCoordinator implements RecoveryCoordinator {
  readonly #now: () => number;
  readonly #reconcilers: Partial<Record<RecoveryPhase, RecoveryReconciler>>;
  readonly #compactor: RecoveryCompactor | undefined;
  readonly #purger: RecoveryPurger | undefined;
  readonly #logger: RecoveryLogger;
  readonly #isolateErrors: boolean;
  readonly #failIfNotConverged: boolean;

  constructor(
    now: () => number,
    reconcilers: Partial<Record<RecoveryPhase, RecoveryReconciler>>,
    compactor: RecoveryCompactor | undefined,
    purger: RecoveryPurger | undefined,
    logger: RecoveryLogger,
    isolateErrors: boolean,
    failIfNotConverged: boolean,
  ) {
    this.#now = now;
    this.#reconcilers = { ...reconcilers };
    this.#compactor = compactor;
    this.#purger = purger;
    this.#logger = logger;
    this.#isolateErrors = isolateErrors;
    this.#failIfNotConverged = failIfNotConverged;
  }

  async recover(): Promise<RecoveryReport> {
    const boundaries: RecoveryBoundary[] = [];
    const errors: RecoveryError[] = [];
    const skipped: RecoveryPhase[] = [];
    for (const phase of orderedPhases()) {
      const reconciler = this.#reconcilers[phase];
      if (reconciler === undefined) {
        skipped.push(phase);
        this.#logger.log("recovery_skip", { phase });
        continue;
      }
      const phaseStart = this.#now();
      try {
        const result = await reconciler.reconcile();
        const status: RecoveryBoundaryStatus =
          result.divergentCount > 0 ? "divergent" : "converged";
        boundaries.push(
          recoveryBoundary({
            phase,
            boundary: result.boundary,
            beforeId: result.beforeId,
            afterId: result.afterId,
            status,
          }),
        );
        this.#logger.log("recovery_phase", {
          phase,
          status,
          reconciledCount: result.reconciledCount,
          divergentCount: result.divergentCount,
          elapsedMs: this.#now() - phaseStart,
        });
      } catch (error: unknown) {
        const message = errorMessage(error);
        const phaseError = recoveryError({
          phase,
          message,
          nodeId: nodeIdFromError(error),
          remediation: remediationForPhase(phase),
        });
        if (!this.#isolateErrors) {
          throw new RecoveryCoordinatorError("phase_failed", `${phase}: ${message}`, {
            cause: error,
          });
        }
        errors.push(phaseError);
        boundaries.push(
          recoveryBoundary({
            phase,
            boundary: phase,
            beforeId: undefined,
            afterId: undefined,
            status: "error",
          }),
        );
        this.#logger.log("recovery_phase_error", { phase, message });
      }
    }
    const report = recoveryReport({ phases: boundaries, errors, skippedPhases: skipped });
    if (this.#failIfNotConverged && !report.converged) {
      throw new RecoveryCoordinatorError(
        "convergence_failed",
        `recovery did not converge: ${String(errors.length)} error(s), ${String(boundaries.filter((b) => b.status !== "converged").length)} non-converged boundary(ies)`,
      );
    }
    return report;
  }

  async compact(policy: RetentionPolicy): Promise<CompactionReport> {
    const compactor = this.#compactor;
    if (compactor === undefined) {
      throw new RecoveryCoordinatorError("compaction_failed", "no compactor is configured");
    }
    try {
      return await compactor.compact(retentionPolicy(policy), this.#now());
    } catch (error: unknown) {
      throw new RecoveryCoordinatorError("compaction_failed", errorMessage(error), {
        cause: error,
      });
    }
  }

  async purge(policy: RetentionPolicy): Promise<PurgeReport> {
    const purger = this.#purger;
    if (purger === undefined) {
      throw new RecoveryCoordinatorError("purge_failed", "no purger is configured");
    }
    try {
      return await purger.purge(retentionPolicy(policy), this.#now());
    } catch (error: unknown) {
      throw new RecoveryCoordinatorError("purge_failed", errorMessage(error), { cause: error });
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Built-in store adapters.
// -------------------------------------------------------------------------------------------------

/**
 * Adapt a {@link ContentBlobStore} into a `blobs` {@link RecoveryReconciler}.
 * `expected` is a thunk evaluated at reconcile time so the referenced-blob set
 * is always current; the store's {@link ContentBlobStore.reconcile} removes
 * temporary/orphan blobs and reports missing/corrupt digests (PR 13/14).
 */
export function blobReconciler(
  store: ContentBlobStore,
  expected: () => readonly ExpectedBlob[],
): RecoveryReconciler {
  return {
    phase: "blobs",
    async reconcile(): Promise<PhaseReconciliation> {
      const referenced = expected();
      const result = await store.reconcile(referenced);
      const removed = result.removedTemporaryPaths.length + result.removedOrphanPaths.length;
      const divergent = result.missingDigests.length + result.corruptDigests.length;
      return {
        boundary: "blob",
        beforeId: undefined,
        afterId: undefined,
        reconciledCount: removed,
        divergentCount: divergent,
        notes:
          `referenced=${String(referenced.length)} removed=${String(removed)} ` +
          `missing=${String(result.missingDigests.length)} corrupt=${String(result.corruptDigests.length)}`,
      };
    },
  };
}

/**
 * Adapt a {@link SchedulerStore} into a `leases` {@link RecoveryReconciler}.
 * Expires stale scheduler leases via {@link SchedulerStore.recoverExpired}
 * (PR 11); each recovered/retried lease is durable progress, each error is a
 * divergence.
 */
export function schedulerLeaseReconciler(store: SchedulerStore, clock: Clock): RecoveryReconciler {
  return {
    phase: "leases",
    async reconcile(): Promise<PhaseReconciliation> {
      const at: Timestamp = clock.now();
      const results = await store.recoverExpired(at);
      let recovered = 0;
      let divergent = 0;
      for (const result of results) {
        if (result.recovered || result.retryScheduled) {
          recovered += 1;
        }
        if (result.error !== undefined) {
          divergent += 1;
        }
      }
      return {
        boundary: "lease",
        beforeId: undefined,
        afterId: undefined,
        reconciledCount: recovered,
        divergentCount: divergent,
        notes: `expired=${String(results.length)} recovered=${String(recovered)} errors=${String(divergent)}`,
      };
    },
  };
}

/**
 * Adapt a {@link WorkspaceManager} into a `workspaces` {@link RecoveryReconciler}
 * via {@link WorkspaceManager.recover} (PR 14): stopped/abandoned workspaces are
 * driven to a terminal state (archive or cleanup).
 */
export function workspaceReconciler(manager: WorkspaceManager): RecoveryReconciler {
  return {
    phase: "workspaces",
    async reconcile(): Promise<PhaseReconciliation> {
      const receipts = await manager.recover();
      return {
        boundary: "workspace",
        beforeId: undefined,
        afterId: undefined,
        reconciledCount: receipts.length,
        divergentCount: 0,
        notes: `recovered=${String(receipts.length)}`,
      };
    },
  };
}

// -------------------------------------------------------------------------------------------------
// Internal helpers.
// -------------------------------------------------------------------------------------------------

/** Default operator remediation hint for a failed phase. */
function remediationForPhase(phase: RecoveryPhase): string {
  switch (phase) {
    case "blobs":
      return "Inspect the blob store for corrupt/missing digests and re-publish referenced content.";
    case "leases":
      return "Inspect stale scheduler leases and confirm the owning host is live or decommissioned.";
    case "sandboxes":
      return "Destroy orphan sandboxes whose owning attempt is no longer live.";
    case "workspaces":
      return "Drive stopped/abandoned workspaces to a terminal state (archive or cleanup).";
    case "vcs_oplog":
      return "Reconcile the jj operation log against durable bindings; repair divergent changes.";
    case "gates":
      return "Invalidate gate receipts whose head changed since the gate ran and re-run them.";
    case "pull_requests":
      return "Reconcile PR state; archive bindings for merged/closed PRs.";
    case "ci":
      return "Invalidate stale CI evidence and re-observe the current head.";
    case "restacks":
      return "Resume or abort incomplete restacks; preserve durable restack progress.";
    case "landing_receipts":
      return "Reconstruct missing landing receipts for merged PRs from GitHub state.";
  }
  // Compile-time exhaustiveness guard: adding a RecoveryPhase breaks this line.
  const exhaustive: never = phase;
  return exhaustive;
}

/** Extract a `nodeId` from a thrown error when it carries one. */
function nodeIdFromError(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "nodeId" in error) {
    const value = error.nodeId;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
