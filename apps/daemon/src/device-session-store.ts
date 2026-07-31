import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { validateDeviceSession, type DeviceSession, type PairingScope } from "@minions/core";

/**
 * Shared, in-memory device-session store (PR 57 — private-phone-pairing).
 *
 * Extracted from `pairing-service.ts` so both the pairing RPCs (which mint,
 * list, and revoke sessions) and the remote-access interceptor (which
 * authenticates them on every non-loopback mutation RPC) operate on the exact
 * same session set — two independently constructed stores would let a
 * revoked-in-one, still-valid-in-the-other session slip through. Scoped to the
 * daemon process lifetime: no cross-restart persistence requirement in this
 * revision (a restarted daemon requires every paired device to re-pair).
 */

export const SESSION_COOKIE_NAME = "minions_device_session";
export const CSRF_HEADER_NAME = "X-Minions-Csrf-Token";

/** An authenticated device session: the pure domain session plus its live credentials. */
export type AuthenticatedSession = Readonly<{
  session: DeviceSession;
  sessionToken: string;
  csrfToken: string;
  expiresAt: number;
}>;

export type DeviceSessionStore = Readonly<{
  /** Mints a new session for a just-completed pairing. Returns its live credentials. */
  create(input: {
    deviceLabel: string;
    scope: PairingScope;
    now: number;
    ttlMs: number;
  }): AuthenticatedSession;
  /** Every active session, most-recently-created order is not guaranteed. */
  list(): readonly AuthenticatedSession[];
  /** Idempotent: revoking an unknown or already-revoked session id still succeeds. */
  revoke(sessionId: string): void;
  /**
   * Authenticates the caller of a scope-gated RPC: the session cookie must name a
   * still-active, unexpired session; the CSRF header must match that session's token
   * (double-submit — an attacker who can trigger the cookie-bearing request cross-site
   * cannot read this header to forge it); the session's scope must satisfy
   * `requiredScope` (`"control"` requires exactly `"control"`; `"read_only"` accepts
   * either scope); and an `Origin` header, when the client sends one, must match the
   * request's own host (defense in depth alongside `SameSite=Strict`, which already
   * blocks the cookie from being sent cross-site by a compliant browser).
   */
  authenticate(
    requestHeader: Headers,
    requiredScope: PairingScope,
    now: number,
  ): AuthenticatedSession;
}>;

/** A URL-safe, 256-bit opaque secret — used for both the session and CSRF tokens. */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time equality for secrets of possibly-differing length. */
function secretsMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function parseCookie(header: string | null, name: string): string | undefined {
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    if (part.slice(0, separatorIndex).trim() !== name) {
      continue;
    }
    return part.slice(separatorIndex + 1).trim();
  }
  return undefined;
}

/** Whether `origin` (an `Origin` header value) names the same host as `host` (a `Host`
 * header value). Parses `origin` as a URL rather than substring-matching, so a
 * malformed or attacker-crafted `Origin` value fails closed instead of coincidentally
 * matching. */
function originMatchesHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function satisfiesScope(sessionScope: PairingScope, requiredScope: PairingScope): boolean {
  return requiredScope === "read_only" ? true : sessionScope === "control";
}

export function createDeviceSessionStore(): DeviceSessionStore {
  const deviceSessions = new Map<string, AuthenticatedSession>();
  const sessionIdByToken = new Map<string, string>();

  return {
    create({ deviceLabel, scope, now, ttlMs }) {
      const session = validateDeviceSession({
        sessionId: randomUUID(),
        deviceLabel,
        scope,
        createdAt: now,
        lastSeen: now,
      });
      const authenticated: AuthenticatedSession = {
        session,
        sessionToken: randomToken(),
        csrfToken: randomToken(),
        expiresAt: now + ttlMs,
      };
      deviceSessions.set(session.sessionId, authenticated);
      sessionIdByToken.set(authenticated.sessionToken, session.sessionId);
      return authenticated;
    },
    list() {
      return [...deviceSessions.values()];
    },
    revoke(sessionId) {
      const target = deviceSessions.get(sessionId);
      if (target !== undefined) {
        sessionIdByToken.delete(target.sessionToken);
      }
      deviceSessions.delete(sessionId);
    },
    authenticate(requestHeader, requiredScope, now) {
      const cookieToken = parseCookie(requestHeader.get("Cookie"), SESSION_COOKIE_NAME);
      if (cookieToken === undefined) {
        throw new ConnectError("no device session cookie presented", Code.PermissionDenied);
      }
      const sessionId = sessionIdByToken.get(cookieToken);
      const authenticated = sessionId === undefined ? undefined : deviceSessions.get(sessionId);
      if (authenticated === undefined || !secretsMatch(authenticated.sessionToken, cookieToken)) {
        throw new ConnectError("device session is unknown or revoked", Code.PermissionDenied);
      }
      if (now >= authenticated.expiresAt) {
        throw new ConnectError("device session has expired", Code.PermissionDenied);
      }
      const csrfHeader = requestHeader.get(CSRF_HEADER_NAME);
      if (csrfHeader === null || !secretsMatch(authenticated.csrfToken, csrfHeader)) {
        throw new ConnectError("CSRF token is missing or does not match", Code.PermissionDenied);
      }
      const origin = requestHeader.get("Origin");
      const host = requestHeader.get("Host");
      if (origin !== null && host !== null && !originMatchesHost(origin, host)) {
        throw new ConnectError(
          "request origin does not match the request host",
          Code.PermissionDenied,
        );
      }
      if (!satisfiesScope(authenticated.session.scope, requiredScope)) {
        throw new ConnectError(
          `this action requires a ${requiredScope} session`,
          Code.PermissionDenied,
        );
      }
      return authenticated;
    },
  };
}
