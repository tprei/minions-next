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

function isRecognizedKind(kind: string): kind is RecoveryActionKind {
  return RECOVERY_ACTION_KINDS[kind] === true;
}

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
  const kind: string = action.kind;
  if (!isRecognizedKind(kind)) {
    return invalid(`recovery action kind '${kind}' is not recognized`);
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

/**
 * Lifecycle of a requested elevation grant. A `pending` grant has not yet
 * collected enough independent human approvals to authorize anything under
 * it; `approved` may run its `authorizedKinds` until it expires or is
 * consumed; `denied`, `expired`, and `consumed` are terminal — no action is
 * ever executable under a grant in one of those states.
 */
export type ElevationGrantState = "pending" | "approved" | "denied" | "expired" | "consumed";

/**
 * A human-approved grant authorizing one or more {@link RecoveryActionKind}s
 * for a bounded duration. Fail-closed: an action kind outside
 * `authorizedKinds` is never executable under it — see
 * {@link validateActionAgainstGrant}.
 */
export type ElevationGrant = Readonly<{
  readonly id: string;
  readonly requestedBySessionId: string;
  readonly authorizedKinds: readonly RecoveryActionKind[];
  readonly justification: string;
  readonly state: ElevationGrantState;
  readonly approvalsReceived: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}>;

/** Verdict from {@link validateElevationRequest}. `reason` is non-empty when invalid. */
export type ElevationRequestVerdict = Readonly<{
  readonly valid: boolean;
  readonly reason?: string;
}>;

/**
 * Validate a requested elevation before a grant is minted. Fail-closed,
 * checked in order: `requestedKinds` must be non-empty; every requested kind
 * must be a recognized {@link RecoveryActionKind}; `justification` must be
 * non-empty; and — this profile's core fail-closed rule — every requested
 * kind must already appear in `profile.allowedKinds` ("a kind absent from
 * allowed_kinds is never grantable under this profile"). Pure: no I/O; the
 * caller supplies `nowMs` (reserved for future time-scoped profiles, unused
 * today).
 */
export function validateElevationRequest(
  requestedKinds: readonly RecoveryActionKind[],
  justification: string,
  profile: RecoveryGateProfile,
  nowMs: number,
): ElevationRequestVerdict {
  void nowMs;
  if (requestedKinds.length === 0) {
    return invalid("requested kinds must not be empty");
  }
  for (const kind of requestedKinds) {
    const requestedKind: string = kind;
    if (!isRecognizedKind(requestedKind)) {
      return invalid(`recovery action kind '${requestedKind}' is not recognized`);
    }
  }
  if (justification.length === 0) {
    return invalid("justification must not be empty");
  }
  for (const kind of requestedKinds) {
    if (!profile.allowedKinds.includes(kind)) {
      return invalid(`recovery action kind '${kind}' is not in this profile's allowed kinds`);
    }
  }
  return Object.freeze({ valid: true });
}

/**
 * Resolve a fresh grant's initial approval state (pure — no I/O). Under this
 * RPC surface the requesting session's own authenticated request counts as
 * exactly one approval; `RequestElevationRequest` carries no mechanism to
 * attach further approvals to an existing grant (there is no ApproveElevation
 * RPC in this contract). A grant requested against a `requiredApprovals > 1`
 * profile therefore stays `pending` forever under this RPC surface — this is
 * correct, fail-closed behavior (a grant is never falsely `approved`), not a
 * bug. Supporting multi-party approval requires a future PR to add a distinct
 * approval RPC that can raise `approvalsReceived` on an existing grant.
 */
export function resolveGrantApproval(
  profile: RecoveryGateProfile,
): Readonly<{ readonly state: ElevationGrantState; readonly approvalsReceived: number }> {
  const approvalsReceived = 1;
  return Object.freeze({
    state: approvalsReceived >= profile.requiredApprovals ? "approved" : "pending",
    approvalsReceived,
  });
}

/**
 * Lifecycle of an executed recovery action. A `pending` action has been
 * authorized and persisted but not yet run. `executed` ran to completion;
 * `failed` was attempted and did not succeed; `rejected` was never attempted
 * (e.g. a target mismatch, or a kind with no adapter in this revision);
 * `expired` never ran before its authorization window lapsed. Every state
 * but `pending` is terminal.
 */
export type RecoveryActionState = "pending" | "executed" | "failed" | "rejected" | "expired";

/**
 * A {@link RecoveryAction} as persisted: identity, the grant that authorized
 * it, lifecycle state, and outcome detail.
 */
export type RecordedRecoveryAction = RecoveryAction &
  Readonly<{
    readonly id: string;
    readonly grantId: string;
    readonly state: RecoveryActionState;
    readonly createdAt: number;
    readonly executedAt?: number;
    readonly failure?: string;
  }>;

/**
 * Validate a {@link RecoveryAction} against the {@link ElevationGrant} it
 * claims to run under. Delegates to {@link validateRecoveryAction} first (the
 * same structural fail-closed checks apply to a granted action); then fails
 * closed, in order, on: a grant that is not `approved` (covers a still-
 * `pending` or `denied` grant — an unapproved action is never authorized); a
 * grant that has expired; an actor session that does not match who requested
 * the grant; and a kind the grant does not authorize (fail-closed default-
 * deny — "an action kind outside authorized_kinds is never executable under
 * it").
 */
export function validateActionAgainstGrant(
  action: RecoveryAction,
  grant: ElevationGrant,
  nowMs: number,
): RecoveryActionVerdict {
  const structural = validateRecoveryAction(action, nowMs);
  if (!structural.valid) {
    return structural;
  }
  if (grant.state !== "approved") {
    return invalid("elevation grant is not approved");
  }
  if (grant.expiresAt <= nowMs) {
    return invalid("elevation grant has expired");
  }
  if (action.actorSessionId !== grant.requestedBySessionId) {
    return invalid("actor session does not match the grant");
  }
  if (!grant.authorizedKinds.includes(action.kind)) {
    return invalid(`recovery action kind '${action.kind}' is not authorized by this grant`);
  }
  return Object.freeze({ valid: true });
}

export type RecoveryStoreErrorCode = "invalid_input" | "write_failed" | "not_found" | "corrupt";

/** Typed recovery-store error. Fail-closed: every write failure surfaces. */
export class RecoveryStoreError extends Error {
  readonly code: RecoveryStoreErrorCode;

  constructor(code: RecoveryStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecoveryStoreError";
    this.code = code;
  }
}

/**
 * Durable store for elevation grants and the recovery actions executed under
 * them. `listActions` orders newest-first by `createdAt` then `id`
 * (descending) for stable keyset pagination; `before` is an action id cursor,
 * exclusive of that action itself.
 */
export interface RecoveryStore {
  createGrant(grant: ElevationGrant): Promise<void>;
  getGrant(id: string): Promise<ElevationGrant | undefined>;
  createAction(action: RecordedRecoveryAction): Promise<void>;
  recordActionOutcome(
    id: string,
    outcome: Readonly<{ state: RecoveryActionState; executedAt?: number; failure?: string }>,
  ): Promise<void>;
  markGrantConsumed(id: string): Promise<void>;
  listActions(
    options: Readonly<{ target?: string; limit: number; before?: string }>,
  ): Promise<readonly RecordedRecoveryAction[]>;
}
