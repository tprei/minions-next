/**
 * Ordered crash recovery + retention domain (PR 37 / REC-03..10).
 *
 * Pure: types + total helpers only. No I/O. The coordinator that drives these
 * lives in `@minions/adapters`; this module is the fail-closed, ordered,
 * isolated-error vocabulary every recovery boundary speaks.
 *
 * Design notes
 * ------------
 * - {@link orderedPhases} is the single canonical recovery sequence. Recovery
 *   runs blobs -> ... -> landing receipts so a later phase never observes a
 *   pre-reconciliation artifact of an earlier one (REC-03).
 * - Errors are isolated per phase: one corrupt/ambiguous node produces a
 *   {@link RecoveryError} and the next phase still runs (REC-04). A report is
 *   {@link RecoveryReport.converged} only when every executed phase reached
 *   `converged` with zero errors.
 * - Retention is split into compaction (archive + tombstone) and purge
 *   (physical removal + tombstone drop); {@link shouldCompact} /
 *   {@link shouldPurge} are pure, total cadence predicates a scheduler uses to
 *   decide when to invoke them (REC-07..10).
 */

// -------------------------------------------------------------------------------------------------
// Phases.
// -------------------------------------------------------------------------------------------------

/**
 * The ten recovery phases in canonical order. The literal order IS the recovery
 * order; {@link orderedPhases} returns it and nothing reorders it.
 */
export type RecoveryPhase =
  | "blobs"
  | "leases"
  | "sandboxes"
  | "workspaces"
  | "vcs_oplog"
  | "gates"
  | "pull_requests"
  | "ci"
  | "restacks"
  | "landing_receipts";

/**
 * Canonical ordered recovery sequence (REC-03). Frozen: callers must not mutate
 * it. Each phase reconciles exactly one subsystem boundary.
 */
export const RECOVERY_PHASE_ORDER: readonly RecoveryPhase[] = Object.freeze([
  "blobs",
  "leases",
  "sandboxes",
  "workspaces",
  "vcs_oplog",
  "gates",
  "pull_requests",
  "ci",
  "restacks",
  "landing_receipts",
]);

/** The canonical ordered recovery sequence (a fresh frozen view per call). */
export function orderedPhases(): readonly RecoveryPhase[] {
  return RECOVERY_PHASE_ORDER;
}

// -------------------------------------------------------------------------------------------------
// Boundary state.
// -------------------------------------------------------------------------------------------------

/** Outcome of reconciling one subsystem boundary. */
export type RecoveryBoundaryStatus = "converged" | "divergent" | "error";

/**
 * The reconciled state at one subsystem boundary. `beforeId` / `afterId` are
 * the opaque state identities observed immediately before and after the phase
 * ran (a digest, commit SHA, generation, ...); equal identities mean the phase
 * was a no-op and unequal mean it made durable progress.
 */
export type RecoveryBoundary = Readonly<{
  /** The phase this boundary belongs to. */
  phase: RecoveryPhase;
  /** Human-readable boundary name (e.g. `blob`, `workspace`, `vcs_oplog`). */
  boundary: string;
  /** State identity before reconciliation, when observable. */
  beforeId: string | undefined;
  /** State identity after reconciliation, when observable. */
  afterId: string | undefined;
  /** Reconciled status of this boundary. */
  status: RecoveryBoundaryStatus;
}>;

/**
 * One isolated per-phase recovery error. A corrupt/ambiguous node in one phase
 * produces one of these; unrelated phases keep running (REC-04). `nodeId` is the
 * offending node when the error is local to one, `undefined` for a phase-wide
 * failure. `remediation` is a non-empty operator-facing instruction.
 */
export type RecoveryError = Readonly<{
  /** The phase that failed. */
  phase: RecoveryPhase;
  /** What went wrong. */
  message: string;
  /** The offending node id, when the failure is local to one node. */
  nodeId: string | undefined;
  /** Non-empty operator remediation instruction. */
  remediation: string;
}>;

/**
 * The full recovery result. {@link converged} is true iff every executed phase
 * reached `converged` with zero errors; {@link skippedPhases} lists phases that
 * had no reconciler attached (nothing to reconcile, not a failure).
 */
export type RecoveryReport = Readonly<{
  /** One boundary per executed phase, in canonical order. */
  phases: readonly RecoveryBoundary[];
  /** True iff every executed phase converged with zero errors. */
  converged: boolean;
  /** Isolated per-phase errors (one corrupt node does not block others). */
  errors: readonly RecoveryError[];
  /** Phases with no attached reconciler (skipped, not failed). */
  skippedPhases: readonly RecoveryPhase[];
}>;

// -------------------------------------------------------------------------------------------------
// Retention policy.
// -------------------------------------------------------------------------------------------------

/**
 * Retention + compaction policy. Every field is a non-negative safe integer
 * count of days; `0` disables that operation:
 * - `eventRetentionDays` / `blobRetentionDays` / `transcriptRetentionDays` —
 *   how long each kind is kept before it is eligible for compaction.
 * - `compactionIntervalDays` — cadence for compaction AND purge runs; `0`
 *   disables both.
 * - `purgeAfterDays` — age at which a compacted (tombstoned) item is physically
 *   purged; `0` disables purge (tombstones are retained indefinitely).
 */
export type RetentionPolicy = Readonly<{
  eventRetentionDays: number;
  blobRetentionDays: number;
  transcriptRetentionDays: number;
  compactionIntervalDays: number;
  purgeAfterDays: number;
}>;

/**
 * Evaluation context for the {@link shouldCompact} / {@link shouldPurge}
 * cadence predicates. `lastRunAtMs` is the epoch-ms of the previous run of the
 * same operation (`undefined` when it has never run).
 */
export type RetentionEvaluation = Readonly<{
  /** Epoch milliseconds at which the cadence is being evaluated. */
  now: number;
  /** Epoch ms of the previous run of this operation, if any. */
  lastRunAtMs: number | undefined;
}>;

/** Milliseconds per day. */
export const MILLIS_PER_DAY = 86_400_000;

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/**
 * Validate + construct a {@link RetentionPolicy}. Every field must be a
 * non-negative safe integer (days). Throws on any breach. Pure.
 */
export function retentionPolicy(input: RetentionPolicy): RetentionPolicy {
  requireNonNegativeDays(input.eventRetentionDays, "eventRetentionDays");
  requireNonNegativeDays(input.blobRetentionDays, "blobRetentionDays");
  requireNonNegativeDays(input.transcriptRetentionDays, "transcriptRetentionDays");
  requireNonNegativeDays(input.compactionIntervalDays, "compactionIntervalDays");
  requireNonNegativeDays(input.purgeAfterDays, "purgeAfterDays");
  return Object.freeze({ ...input });
}

/**
 * Is a compaction run due at `evaluation.now`? Compaction runs when its cadence
 * is enabled (`compactionIntervalDays > 0`) and the cadence has elapsed since
 * the last run (or it has never run). Pure and total.
 *
 * Note: the brief sketches `shouldCompact(policy, now)`; the `now` argument is
 * generalized to a {@link RetentionEvaluation} so the predicate can make a real
 * interval-elapsed decision against the previous run — a bare timestamp cannot.
 */
export function shouldCompact(policy: RetentionPolicy, evaluation: RetentionEvaluation): boolean {
  if (policy.compactionIntervalDays <= 0) {
    return false;
  }
  if (evaluation.lastRunAtMs === undefined) {
    return true;
  }
  return evaluation.now - evaluation.lastRunAtMs >= policy.compactionIntervalDays * MILLIS_PER_DAY;
}

/**
 * Is a purge run due at `evaluation.now`? Purge runs when purge is enabled
 * (`purgeAfterDays > 0`), shares the compaction cadence
 * (`compactionIntervalDays > 0`), and that cadence has elapsed since the last
 * purge (or purge has never run). Pure and total.
 */
export function shouldPurge(policy: RetentionPolicy, evaluation: RetentionEvaluation): boolean {
  if (policy.purgeAfterDays <= 0 || policy.compactionIntervalDays <= 0) {
    return false;
  }
  if (evaluation.lastRunAtMs === undefined) {
    return true;
  }
  return evaluation.now - evaluation.lastRunAtMs >= policy.compactionIntervalDays * MILLIS_PER_DAY;
}

/**
 * Construct a {@link RecoveryBoundary}. `status` must be a recognized value.
 * Pure.
 */
export function recoveryBoundary(input: {
  readonly phase: RecoveryPhase;
  readonly boundary: string;
  readonly beforeId?: string | undefined;
  readonly afterId?: string | undefined;
  readonly status: RecoveryBoundaryStatus;
}): RecoveryBoundary {
  if (input.boundary.length === 0) {
    throw new TypeError("recovery boundary name must be non-empty");
  }
  return Object.freeze({
    phase: input.phase,
    boundary: input.boundary,
    beforeId: input.beforeId,
    afterId: input.afterId,
    status: input.status,
  });
}

/**
 * Construct an isolated {@link RecoveryError}. `message` and `remediation` must
 * be non-empty. Pure.
 */
export function recoveryError(input: {
  readonly phase: RecoveryPhase;
  readonly message: string;
  readonly nodeId?: string | undefined;
  readonly remediation: string;
}): RecoveryError {
  if (input.message.length === 0) {
    throw new TypeError("recovery error message must be non-empty");
  }
  if (input.remediation.length === 0) {
    throw new TypeError("recovery error remediation must be non-empty");
  }
  return Object.freeze({
    phase: input.phase,
    message: input.message,
    nodeId: input.nodeId,
    remediation: input.remediation,
  });
}

/**
 * Construct a {@link RecoveryReport} and derive {@link RecoveryReport.converged}.
 * A report is converged iff there are zero errors and every recorded boundary
 * reached `converged` (skipped phases do not count against convergence — they
 * had nothing to reconcile). Pure.
 */
export function recoveryReport(input: {
  readonly phases: readonly RecoveryBoundary[];
  readonly errors: readonly RecoveryError[];
  readonly skippedPhases: readonly RecoveryPhase[];
}): RecoveryReport {
  const phases = Object.freeze([...input.phases]);
  const errors = Object.freeze([...input.errors]);
  const skippedPhases = Object.freeze([...input.skippedPhases]);
  const everyConverged = phases.every((boundary) => boundary.status === "converged");
  return Object.freeze({
    phases,
    errors,
    skippedPhases,
    converged: errors.length === 0 && everyConverged,
  });
}

// -------------------------------------------------------------------------------------------------
// Internal validation.
// -------------------------------------------------------------------------------------------------

function requireNonNegativeDays(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer (days)`);
  }
}
