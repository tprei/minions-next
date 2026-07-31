import {
  create,
  type DescMessage,
  type MessageShape,
  type MessageValidType,
} from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  ElevationGrantSchema,
  ElevationGrantState as ProtoElevationGrantState,
  ExecuteRecoveryActionResponseSchema,
  ListRecoveryActionsResponseSchema,
  RecoveryActionKind as ProtoRecoveryActionKind,
  RecoveryActionSchema,
  RecoveryActionState as ProtoRecoveryActionState,
  RecoveryService,
  RequestElevationResponseSchema,
} from "@minions/contracts";
import {
  resolveGrantApproval,
  validateActionAgainstGrant,
  validateElevationRequest,
  type Clock,
  type ElevationGrant,
  type ElevationGrantState,
  type IdGenerator,
  type RecordedRecoveryAction,
  type RecoveryAction,
  type RecoveryActionKind,
  type RecoveryActionState,
  type RecoveryGateProfile,
  type RecoveryStore,
} from "@minions/core";

import type { RecoveryRestarter } from "./recovery-restart.js";

/**
 * Recovery elevation service handler (PR 56 — maintenance-elevation-recovery).
 *
 * A real, durable, fail-closed elevation-grant + recovery-action system, scoped to the
 * `restart` action kind only. `RequestElevation` mints a grant against `gateProfile`
 * (fail-closed: a requested kind absent from `gateProfile.allowedKinds` is never
 * grantable). `ExecuteRecoveryAction` re-validates the action against its grant
 * (unapproved/expired/wrong-actor/unauthorized-kind attempts are rejected before any
 * row is persisted — no forged receipt is possible through this RPC surface), then
 * persists a `pending` receipt before running anything so a crash mid-execution still
 * leaves a durable, queryable record. Only `restart` has an adapter in this revision;
 * every other authorized kind is honestly rejected with a typed, persisted receipt
 * rather than `Code.Unimplemented` — this is spec-sanctioned incremental delivery
 * (individual recovery-action adapters land after this authorization/preconditions/
 * rollback contract is fixed).
 */
export interface RecoveryServiceOptions {
  readonly store: RecoveryStore;
  readonly gateProfile: RecoveryGateProfile;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly restart: RecoveryRestarter;
  /** The `RecoveryAction.target` that names the primary daemon. Defaults to "primary-daemon". */
  readonly primaryTarget?: string;
}

const responseValidator = createValidator();

export function registerRecoveryService(
  router: ConnectRouter,
  options: RecoveryServiceOptions,
): void {
  const primaryTarget = options.primaryTarget ?? "primary-daemon";
  router.service(RecoveryService, {
    async requestElevation(request) {
      const requestedKinds = request.requestedKinds.map((kind) => coreActionKind(kind));
      const nowMs = options.clock.now();
      const verdict = validateElevationRequest(
        requestedKinds,
        request.justification,
        options.gateProfile,
        nowMs,
      );
      if (!verdict.valid) {
        throw new ConnectError(
          verdict.reason ?? "elevation request is invalid",
          Code.InvalidArgument,
        );
      }
      const approval = resolveGrantApproval(options.gateProfile);
      const grant: ElevationGrant = {
        id: options.ids.nextId(),
        requestedBySessionId: request.requestedBySessionId,
        authorizedKinds: requestedKinds,
        justification: request.justification,
        state: approval.state,
        approvalsReceived: approval.approvalsReceived,
        createdAt: nowMs,
        expiresAt: nowMs + options.gateProfile.maxGrantDurationMs,
      };
      await options.store.createGrant(grant);
      const response = create(RequestElevationResponseSchema, { grant: toGrantMessage(grant) });
      return validateResponse(RequestElevationResponseSchema, response);
    },

    async executeRecoveryAction(request) {
      if (request.action === undefined) {
        throw new ConnectError("action is required", Code.InvalidArgument);
      }
      if (request.action.expiresAt === undefined) {
        throw new ConnectError("action.expires_at is required", Code.InvalidArgument);
      }
      const grant = await options.store.getGrant(request.grantId);
      if (grant === undefined) {
        throw new ConnectError("elevation grant not found", Code.NotFound);
      }
      const nowMs = options.clock.now();
      const action: RecoveryAction = {
        kind: coreActionKind(request.action.kind),
        target: request.action.target,
        expectedState: request.action.expectedState,
        actorSessionId: request.actorSessionId,
        expiresAt: millisecondsFromTimestamp(request.action.expiresAt),
      };
      const verdict = validateActionAgainstGrant(action, grant, nowMs);
      if (!verdict.valid) {
        throw new ConnectError(
          verdict.reason ?? "recovery action is not authorized",
          Code.FailedPrecondition,
        );
      }

      // Persist the pending receipt BEFORE running anything, so a crash mid-execution
      // still leaves a durable, queryable record — never a silently lost attempt.
      const pending: RecordedRecoveryAction = {
        ...action,
        id: options.ids.nextId(),
        grantId: grant.id,
        state: "pending",
        createdAt: nowMs,
      };
      await options.store.createAction(pending);

      const final = await executeAction(options, pending, primaryTarget);
      const response = create(ExecuteRecoveryActionResponseSchema, {
        action: toActionMessage(final),
      });
      return validateResponse(ExecuteRecoveryActionResponseSchema, response);
    },

    async listRecoveryActions(request) {
      const results = await options.store.listActions({
        ...(request.target === undefined ? {} : { target: request.target }),
        limit: request.pageSize,
        ...(request.pageToken === undefined ? {} : { before: request.pageToken }),
      });
      const response = create(ListRecoveryActionsResponseSchema, {
        actions: results.map((action) => toActionMessage(action)),
        ...(results.length === request.pageSize ? { nextPageToken: results.at(-1)?.id } : {}),
      });
      return validateResponse(ListRecoveryActionsResponseSchema, response);
    },
  });
}

/**
 * Run (or reject) a persisted `pending` action, then record its terminal outcome.
 * Only `restart` has an adapter today: a target mismatch or the restarter throwing
 * are both legitimate, authorized attempts that resolve to a typed receipt (never a
 * thrown error — the grant was valid, the *outcome* just wasn't success). Every other
 * kind is honestly rejected as unimplemented in this revision. A restarter failure
 * does NOT consume the grant (still `approved`), so a retry is possible before it
 * expires; a successful restart consumes it (one authorized restart per grant).
 */
async function executeAction(
  options: RecoveryServiceOptions,
  pending: RecordedRecoveryAction,
  primaryTarget: string,
): Promise<RecordedRecoveryAction> {
  if (pending.kind !== "restart") {
    const failure = `recovery action kind '${pending.kind}' has no adapter in this revision`;
    await options.store.recordActionOutcome(pending.id, { state: "rejected", failure });
    return { ...pending, state: "rejected", failure };
  }
  if (pending.target !== primaryTarget) {
    const failure = "target does not match the configured primary API identifier";
    await options.store.recordActionOutcome(pending.id, { state: "rejected", failure });
    return { ...pending, state: "rejected", failure };
  }
  try {
    await options.restart.restart("primary-daemon");
    const executedAt = options.clock.now();
    await options.store.recordActionOutcome(pending.id, { state: "executed", executedAt });
    await options.store.markGrantConsumed(pending.grantId);
    return { ...pending, state: "executed", executedAt };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    await options.store.recordActionOutcome(pending.id, { state: "failed", failure });
    return { ...pending, state: "failed", failure };
  }
}

// -------------------------------------------------------------------------------------------------
// Proto <-> core mapping.
// -------------------------------------------------------------------------------------------------

function coreActionKind(kind: ProtoRecoveryActionKind): RecoveryActionKind {
  switch (kind) {
    case ProtoRecoveryActionKind.SIGNAL:
      return "signal";
    case ProtoRecoveryActionKind.RESTART:
      return "restart";
    case ProtoRecoveryActionKind.QUARANTINE:
      return "quarantine";
    case ProtoRecoveryActionKind.RECONCILE:
      return "reconcile";
    case ProtoRecoveryActionKind.DEBUG_ATTACH:
      return "debug_attach";
    case ProtoRecoveryActionKind.SOURCE_PATCH_BRANCH:
      return "source_patch_branch";
    case ProtoRecoveryActionKind.SHADOW_VERIFY:
      return "shadow_verify";
    case ProtoRecoveryActionKind.CANDIDATE_ACTIVATE:
      return "candidate_activate";
    case ProtoRecoveryActionKind.FORCE_ROLLBACK:
      return "force_rollback";
    case ProtoRecoveryActionKind.UNSPECIFIED:
      throw new ConnectError(
        "recovery action kind must be specified and recognized",
        Code.InvalidArgument,
      );
  }
}

function protoActionKind(kind: RecoveryActionKind): ProtoRecoveryActionKind {
  switch (kind) {
    case "signal":
      return ProtoRecoveryActionKind.SIGNAL;
    case "restart":
      return ProtoRecoveryActionKind.RESTART;
    case "quarantine":
      return ProtoRecoveryActionKind.QUARANTINE;
    case "reconcile":
      return ProtoRecoveryActionKind.RECONCILE;
    case "debug_attach":
      return ProtoRecoveryActionKind.DEBUG_ATTACH;
    case "source_patch_branch":
      return ProtoRecoveryActionKind.SOURCE_PATCH_BRANCH;
    case "shadow_verify":
      return ProtoRecoveryActionKind.SHADOW_VERIFY;
    case "candidate_activate":
      return ProtoRecoveryActionKind.CANDIDATE_ACTIVATE;
    case "force_rollback":
      return ProtoRecoveryActionKind.FORCE_ROLLBACK;
  }
}

function protoGrantState(state: ElevationGrantState): ProtoElevationGrantState {
  switch (state) {
    case "pending":
      return ProtoElevationGrantState.PENDING;
    case "approved":
      return ProtoElevationGrantState.APPROVED;
    case "denied":
      return ProtoElevationGrantState.DENIED;
    case "expired":
      return ProtoElevationGrantState.EXPIRED;
    case "consumed":
      return ProtoElevationGrantState.CONSUMED;
  }
}

function protoActionState(state: RecoveryActionState): ProtoRecoveryActionState {
  switch (state) {
    case "pending":
      return ProtoRecoveryActionState.PENDING;
    case "executed":
      return ProtoRecoveryActionState.EXECUTED;
    case "failed":
      return ProtoRecoveryActionState.FAILED;
    case "rejected":
      return ProtoRecoveryActionState.REJECTED;
    case "expired":
      return ProtoRecoveryActionState.EXPIRED;
  }
}

function toGrantMessage(grant: ElevationGrant) {
  const message = create(ElevationGrantSchema, {
    id: grant.id,
    requestedBySessionId: grant.requestedBySessionId,
    authorizedKinds: grant.authorizedKinds.map((kind) => protoActionKind(kind)),
    justification: grant.justification,
    state: protoGrantState(grant.state),
    approvalsReceived: grant.approvalsReceived,
    createdAt: timestampFromMilliseconds(grant.createdAt),
    expiresAt: timestampFromMilliseconds(grant.expiresAt),
  });
  return validateResponse(ElevationGrantSchema, message);
}

function toActionMessage(action: RecordedRecoveryAction) {
  const message = create(RecoveryActionSchema, {
    id: action.id,
    kind: protoActionKind(action.kind),
    target: action.target,
    expectedState: action.expectedState,
    actorSessionId: action.actorSessionId,
    expiresAt: timestampFromMilliseconds(action.expiresAt),
    state: protoActionState(action.state),
    createdAt: timestampFromMilliseconds(action.createdAt),
    ...(action.executedAt === undefined
      ? {}
      : { executedAt: timestampFromMilliseconds(action.executedAt) }),
    ...(action.failure === undefined ? {} : { failure: action.failure }),
  });
  return validateResponse(RecoveryActionSchema, message);
}

function timestampFromMilliseconds(milliseconds: number) {
  return create(TimestampSchema, {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  });
}

function millisecondsFromTimestamp(
  timestamp: Readonly<{ seconds: bigint; nanos: number }>,
): number {
  return Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
}

function validateResponse<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): MessageValidType<Desc> {
  const validation = responseValidator.validate(schema, message);
  if (validation.kind !== "valid") {
    throw new ConnectError(
      "recovery service produced an invalid response",
      Code.Internal,
      undefined,
      undefined,
      validation.error,
    );
  }
  return validation.message;
}
