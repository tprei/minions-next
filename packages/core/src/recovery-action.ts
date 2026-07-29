/**
 * Recovery elevation actions (PR 56 — maintenance-elevation-recovery).
 *
 * Permits narrowly elevated, human-approved recovery without silent state-table
 * edits or unreviewed deployment. Every mutation names one action, target,
 * expected state, expiry, and human actor.
 */
export type RecoveryActionKind =
  | "signal"
  | "restart"
  | "quarantine"
  | "reconcile"
  | "debug_attach"
  | "source_patch_branch"
  | "shadow_verify"
  | "candidate_activate"
  | "force_rollback";

export type RecoveryAction = Readonly<{
  readonly kind: RecoveryActionKind;
  readonly target: string;
  readonly expectedState: string;
  readonly actorSessionId: string;
  readonly expiresAt: number;
}>;

/**
 * Gate profile controlling which {@link RecoveryActionKind}s an elevation
 * grant may authorize, how many independent human approvals a grant requires,
 * and the longest a single grant may remain valid. Fail-closed: a kind absent
 * from `allowedKinds` is never grantable under this profile.
 */
export type RecoveryGateProfile = Readonly<{
  readonly allowedKinds: readonly RecoveryActionKind[];
  readonly requiredApprovals: number;
  readonly maxGrantDurationMs: number;
}>;

/** Verdict from {@link validateRecoveryAction}. `reason` is non-empty when invalid. */
export type RecoveryActionVerdict = Readonly<{ readonly valid: boolean; readonly reason?: string }>;

const RECOVERY_ACTION_KINDS: Record<string, true> = {
  signal: true,
  restart: true,
  quarantine: true,
  reconcile: true,
  debug_attach: true,
  source_patch_branch: true,
  shadow_verify: true,
  candidate_activate: true,
  force_rollback: true,
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Validate a {@link RecoveryAction} before it is granted or executed.
 * Fail-closed: rejects an unrecognized `kind`, an empty `target` or
 * `expectedState`, an `actorSessionId` that is not a lowercase UUID, and an
 * `expiresAt` that is not strictly after `nowMs` (an already-expired or
 * present-moment grant authorizes nothing). Pure: no I/O, no clock reads —
 * the caller supplies `nowMs`.
 */
export function validateRecoveryAction(
  action: RecoveryAction,
  nowMs: number,
): RecoveryActionVerdict {
  if (RECOVERY_ACTION_KINDS[action.kind] !== true) {
    return invalid(`recovery action kind '${action.kind}' is not recognized`);
  }
  if (action.target.length === 0) {
    return invalid("recovery action target must not be empty");
  }
  if (action.expectedState.length === 0) {
    return invalid("recovery action expected state must not be empty");
  }
  if (!uuidPattern.test(action.actorSessionId)) {
    return invalid("recovery action actor session id must be a lowercase UUID");
  }
  if (!Number.isSafeInteger(action.expiresAt) || action.expiresAt <= nowMs) {
    return invalid("recovery action must expire strictly in the future");
  }
  return Object.freeze({ valid: true });
}

function invalid(reason: string): RecoveryActionVerdict {
  return Object.freeze({ valid: false, reason });
}

/**
 * Audit trail entry for a recovery action (PR 56 — "receipt import after recovery").
 *
 * Every executed recovery action produces an immutable audit entry naming the
 * action, the actor who authorized it, the outcome, and the timestamp. These
 * entries are imported into the primary DB after recovery and surfaced in the
 * audit UI — they are never silently dropped.
 */
export type RecoveryAuditEntry = Readonly<{
  readonly actionKind: RecoveryActionKind;
  readonly target: string;
  readonly actorSessionId: string;
  readonly outcome: "succeeded" | "failed" | "rolled_back";
  readonly detail: string;
  readonly recordedAt: number;
}>;

/** Create a frozen audit entry from an action and its result (pure). */
export function createAuditEntry(
  action: RecoveryAction,
  outcome: RecoveryAuditEntry["outcome"],
  detail: string,
  recordedAt: number,
): RecoveryAuditEntry {
  return Object.freeze({
    actionKind: action.kind,
    target: action.target,
    actorSessionId: action.actorSessionId,
    outcome,
    detail,
    recordedAt,
  });
}
