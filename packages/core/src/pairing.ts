import { DomainError } from "./domain-error.js";

/**
 * Private phone pairing (PR 57 — private-phone-pairing).
 *
 * Exposes the Mac supervisor securely to a phone over a private network with
 * revocable application identity. Requires both private-network reachability
 * AND a valid application session; no public listener or relay.
 */
export type PairingScope = "read_only" | "control";

export type PairingCode = Readonly<{
  readonly code: string;
  readonly expiresAt: number;
  readonly scope: PairingScope;
}>;

export type DeviceSession = Readonly<{
  readonly sessionId: string;
  readonly deviceLabel: string;
  readonly scope: PairingScope;
  readonly createdAt: number;
  readonly lastSeen: number;
}>;

const pairingScopes: readonly PairingScope[] = ["read_only", "control"];

/** Legible alphanumeric charset for pairing codes: excludes 0/O and 1/I/L. */
const pairingCodeCharset = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const pairingCodeLength = 6;

function isPairingScope(value: unknown): value is PairingScope {
  return typeof value === "string" && (pairingScopes as readonly string[]).includes(value);
}

/**
 * Generate a fresh {@link PairingCode}: a 6-character alphanumeric code (uppercase
 * letters + digits, excluding easily-confused glyphs) bound to `scope` and
 * `expiresAt`. `randomSource` defaults to `Math.random`; core has no `node:crypto`
 * access (see eslint `no-restricted-imports`), so callers that need
 * cryptographically strong codes MUST inject a secure source (e.g. one backed by
 * `node:crypto.randomInt` from an adapter) — this keeps the function pure and
 * deterministically testable.
 */
export function generatePairingCode(
  scope: PairingScope,
  expiresAt: number,
  randomSource: () => number = Math.random,
): PairingCode {
  if (!isPairingScope(scope)) {
    throw new DomainError(
      "invalid_value",
      `pairing scope must be one of ${pairingScopes.join(", ")}`,
    );
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new DomainError(
      "invalid_value",
      "pairing code expiresAt must be a non-negative integer (epoch ms)",
    );
  }
  let code = "";
  for (let index = 0; index < pairingCodeLength; index += 1) {
    const roll = randomSource();
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
      throw new DomainError(
        "invalid_value",
        "pairing code random source must return a value in [0, 1)",
      );
    }
    const charIndex = Math.floor(roll * pairingCodeCharset.length);
    const char = pairingCodeCharset[charIndex];
    if (char === undefined) {
      throw new DomainError(
        "invalid_value",
        "pairing code random source produced an out-of-range index",
      );
    }
    code += char;
  }
  return Object.freeze({ code, expiresAt, scope });
}

/**
 * Whether `code` is still usable at `now`: not expired. Fail-closed — a code
 * whose expiry cannot be compared (non-finite `now`) is treated as invalid.
 */
export function isPairingCodeValid(code: PairingCode, now: number): boolean {
  if (!Number.isFinite(now)) {
    return false;
  }
  return now < code.expiresAt;
}

/**
 * Validate a {@link DeviceSession}: `scope` must be a known {@link PairingScope},
 * `sessionId`/`deviceLabel` non-empty, and `createdAt`/`lastSeen` non-negative
 * integers with `lastSeen >= createdAt`. Returns the frozen, validated session on
 * success; throws {@link DomainError} on the first violation.
 */
export function validateDeviceSession(session: DeviceSession): DeviceSession {
  if (!isPairingScope(session.scope)) {
    throw new DomainError(
      "invalid_value",
      `device session scope must be one of ${pairingScopes.join(", ")}`,
    );
  }
  if (typeof session.sessionId !== "string" || session.sessionId.trim().length === 0) {
    throw new DomainError("invalid_value", "device session sessionId must be a non-empty string");
  }
  if (typeof session.deviceLabel !== "string" || session.deviceLabel.trim().length === 0) {
    throw new DomainError("invalid_value", "device session deviceLabel must be a non-empty string");
  }
  if (!Number.isSafeInteger(session.createdAt) || session.createdAt < 0) {
    throw new DomainError(
      "invalid_value",
      "device session createdAt must be a non-negative integer (epoch ms)",
    );
  }
  if (!Number.isSafeInteger(session.lastSeen) || session.lastSeen < 0) {
    throw new DomainError(
      "invalid_value",
      "device session lastSeen must be a non-negative integer (epoch ms)",
    );
  }
  if (session.lastSeen < session.createdAt) {
    throw new DomainError("invalid_value", "device session lastSeen must not precede createdAt");
  }
  return Object.freeze({ ...session });
}

/**
 * QR payload for phone pairing (PR 57). Encodes the pairing code, scope, and
 * supervisor origin into a compact URL format the phone app scans via QR.
 * The payload never contains long-lived credentials — only the one-time code.
 */
export type QrPayload = Readonly<{
  readonly origin: string;
  readonly code: string;
  readonly scope: PairingScope;
}>;

/** Build a QR-scannable pairing URL from a code and supervisor origin (pure). */
export function buildQrPayload(code: PairingCode, origin: string): QrPayload {
  if (origin.trim().length === 0) {
    throw new DomainError("invalid_value", "QR payload origin must not be empty");
  }
  return Object.freeze({
    origin: origin.trim(),
    code: code.code,
    scope: code.scope,
  });
}

/** Serialize a QrPayload into a `minions://pair?...` URL string (pure). */
export function serializeQrPayload(payload: QrPayload): string {
  return `minions://pair?origin=${payload.origin}&code=${payload.code}&scope=${payload.scope}`;
}
