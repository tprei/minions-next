import { randomInt, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  CompletePairingResponseSchema,
  DeviceSessionSchema,
  ListDevicesResponseSchema,
  PairingScope as ProtoPairingScope,
  PairingService,
  RequestPairingCodeResponseSchema,
  RevokeDeviceResponseSchema,
  type DeviceSession as ProtoDeviceSession,
} from "@minions/contracts";
import {
  generatePairingCode,
  isPairingCodeValid,
  type DeviceSession,
  type PairingCode,
  type PairingScope,
} from "@minions/core";
import {
  createDeviceSessionStore,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  type AuthenticatedSession,
  type DeviceSessionStore,
} from "./device-session-store.js";

/**
 * Pairing service handler (PR 57 — private-phone-pairing).
 *
 * RequestPairingCode generates a cryptographically random 6-char legible code with a
 * 5-minute expiry (`node:crypto.randomInt` — `@minions/core` has no `node:crypto` access
 * by design, so this adapter supplies the secure random source `generatePairingCode`
 * requires). CompletePairing consumes a still-valid code exactly once and mints a new
 * `DeviceSession`; ListDevices/RevokeDevice operate on the same in-memory registry.
 *
 * Both stores are in-memory and scoped to the daemon process lifetime — pairing codes are
 * short-lived by design (5 minutes) and device sessions have no cross-restart persistence
 * requirement in this revision (no `UserKnownHostsFile`-style durable store exists yet;
 * a restarted daemon requires every paired device to re-pair). This matches
 * `RequestPairingCode`'s pre-existing "ephemeral, not persisted" precedent.
 */
export type PairingServiceOptions = Readonly<Record<string, never>>;

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** Uniform [0, 1) float sourced from a CSPRNG — pairing codes gate device trust. */
function secureRandomSource(): number {
  return randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;
}

function toDomainScope(scope: ProtoPairingScope): PairingScope {
  switch (scope) {
    case ProtoPairingScope.READ_ONLY:
      return "read_only";
    case ProtoPairingScope.CONTROL:
      return "control";
    case ProtoPairingScope.UNSPECIFIED:
      throw new ConnectError("scope must be specified", Code.InvalidArgument);
  }
}

function toProtoScope(scope: PairingScope): ProtoPairingScope {
  return scope === "control" ? ProtoPairingScope.CONTROL : ProtoPairingScope.READ_ONLY;
}

function msToTimestamp(ms: number) {
  return create(TimestampSchema, { seconds: BigInt(Math.floor(ms / 1000)), nanos: 0 });
}

function toProtoSession(session: DeviceSession): ProtoDeviceSession {
  return create(DeviceSessionSchema, {
    sessionId: session.sessionId,
    deviceLabel: session.deviceLabel,
    scope: toProtoScope(session.scope),
    createdAt: msToTimestamp(session.createdAt),
  });
}

export function registerPairingService(
  router: ConnectRouter,
  options: PairingServiceOptions,
): void {
  void options;
  const sessionStore = options.sessionStore ?? createDeviceSessionStore();
  const pendingCodes = new Map<string, PairingCode>();
  const deviceSessions = new Map<string, DeviceSession>();

  router.service(PairingService, {
    requestPairingCode(request) {
      const scope = toDomainScope(request.scope);
      const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
      const pairingCode = generatePairingCode(scope, expiresAt, secureRandomSource);
      pendingCodes.set(pairingCode.code, pairingCode);
      return create(RequestPairingCodeResponseSchema, {
        code: pairingCode.code,
        expiresAt: msToTimestamp(expiresAt),
        scope: request.scope,
      });
    },
    completePairing(request) {
      const pending = pendingCodes.get(request.code);
      // One-time use: the code is consumed on every attempt, valid or not, so a
      // leaked/observed code cannot be replayed after a single completion attempt.
      pendingCodes.delete(request.code);
      if (pending === undefined || !isPairingCodeValid(pending, Date.now())) {
        throw new ConnectError("pairing code is invalid or expired", Code.PermissionDenied);
      }
      const now = Date.now();
      const authenticated: AuthenticatedSession = sessionStore.create({
        deviceLabel: request.deviceLabel,
        scope: pending.scope,
        now,
        ttlMs: DEVICE_SESSION_TTL_MS,
      });
      deviceSessions.set(session.sessionId, session);
      return create(CompletePairingResponseSchema, { session: toProtoSession(session) });
    },
    listDevices() {
      return create(ListDevicesResponseSchema, {
        devices: [...deviceSessions.values()].map(toProtoSession),
      });
    },
    revokeDevice(request) {
      // Idempotent: revoking an already-revoked/unknown session id still succeeds — the
      // caller's postcondition ("this session cannot act") holds either way.
      deviceSessions.delete(request.sessionId);
      return create(RevokeDeviceResponseSchema, {});
    },
  });
}
