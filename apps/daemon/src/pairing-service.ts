import { randomInt } from "node:crypto";
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
 * requires). CompletePairing consumes a still-valid code exactly once, mints a new
 * `DeviceSession` via the shared {@link DeviceSessionStore}, and authenticates it going
 * forward with an HttpOnly Secure SameSite=Strict cookie plus a double-submit CSRF token
 * (returned via a response header, never in the cookie itself — a cross-site page can
 * trigger a cookie-bearing request but cannot read the header to reproduce the token).
 * RevokeDevice requires that authentication and a control-scope session: the caller must
 * present the cookie issued to *some* still-valid control session and echo its CSRF token
 * back, closing the "read-only/control boundaries" and "CSRF/origin protections"
 * requirements. ListDevices and RequestPairingCode stay open reads/bootstrapping,
 * unchanged.
 *
 * The device-session store is shared with `remote-access-interceptor.ts` (passed in via
 * `options.sessionStore`, defaulting to a private store when omitted) so a session this
 * service mints or revokes is authenticated identically wherever a non-loopback caller
 * invokes a scope-gated mutation RPC. Pairing codes stay private to this module — they
 * are single-use and exist only to bootstrap a session, so nothing outside pairing needs
 * to see them.
 *
 * Both stores are in-memory and scoped to the daemon process lifetime — pairing codes are
 * short-lived by design (5 minutes) and device sessions have no cross-restart persistence
 * requirement in this revision (no durable store exists yet; a restarted daemon requires
 * every paired device to re-pair). This matches `RequestPairingCode`'s pre-existing
 * "ephemeral, not persisted" precedent.
 */
export type PairingServiceOptions = Readonly<Record<string, never>>;

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    completePairing(request, context) {
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

      context.responseHeader.set(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=${authenticated.sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${String(
          Math.floor(DEVICE_SESSION_TTL_MS / 1000),
        )}`,
      );
      context.responseHeader.set(CSRF_HEADER_NAME, authenticated.csrfToken);
      return create(CompletePairingResponseSchema, {
        session: toProtoSession(authenticated.session),
      });
    },
    listDevices() {
      return create(ListDevicesResponseSchema, {
        devices: sessionStore.list().map((entry) => toProtoSession(entry.session)),
      });
    },
    revokeDevice(request, context) {
      sessionStore.authenticate(context.requestHeader, "control", Date.now());
      sessionStore.revoke(request.sessionId);
      return create(RevokeDeviceResponseSchema, {});
    },
  });
}
