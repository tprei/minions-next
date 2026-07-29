import {
  DomainError,
  generatePairingCode,
  isPairingCodeValid,
  validateDeviceSession,
  type DeviceSession,
  type PairingCode,
} from "@minions/core";
import { describe, expect, it } from "vitest";

const NOW_MS = 1_700_000_000_000;

/** Deterministic random source cycling through fixed rolls for reproducible codes. */
function fixedRandomSource(...rolls: readonly number[]): () => number {
  let index = 0;
  return () => {
    const roll = rolls[index % rolls.length];
    index += 1;
    if (roll === undefined) {
      throw new Error("fixedRandomSource ran out of rolls");
    }
    return roll;
  };
}

describe("generatePairingCode", () => {
  it("produces a 6-character uppercase alphanumeric code bound to scope and expiry", () => {
    const pairing = generatePairingCode("control", NOW_MS + 60_000, fixedRandomSource(0));
    expect(pairing.code).toHaveLength(6);
    expect(pairing.code).toMatch(/^[0-9A-Z]{6}$/u);
    expect(pairing.scope).toBe<PairingCode["scope"]>("control");
    expect(pairing.expiresAt).toBe(NOW_MS + 60_000);
  });

  it("excludes easily-confused glyphs (0, O, 1, I, L) from the charset", () => {
    const rolls = Array.from({ length: 32 }, (_, index) => index / 32);
    const pairing = generatePairingCode("read_only", NOW_MS + 60_000, fixedRandomSource(...rolls));
    expect(pairing.code).not.toMatch(/[01ILO]/u);
  });

  it("is deterministic for a given random source", () => {
    const first = generatePairingCode(
      "read_only",
      NOW_MS,
      fixedRandomSource(0.1, 0.5, 0.9, 0.2, 0.6, 0.05),
    );
    const second = generatePairingCode(
      "read_only",
      NOW_MS,
      fixedRandomSource(0.1, 0.5, 0.9, 0.2, 0.6, 0.05),
    );
    expect(first.code).toBe(second.code);
  });

  it("rejects an invalid scope", () => {
    expect(() => generatePairingCode("admin" as never, NOW_MS + 1000)).toThrow(DomainError);
  });

  it("rejects a negative or non-integer expiry", () => {
    expect(() => generatePairingCode("control", -1)).toThrow(DomainError);
    expect(() => generatePairingCode("control", 1.5)).toThrow(DomainError);
  });

  it("rejects a random source that returns outside [0, 1)", () => {
    expect(() => generatePairingCode("control", NOW_MS, fixedRandomSource(1))).toThrow(DomainError);
    expect(() => generatePairingCode("control", NOW_MS, fixedRandomSource(-0.1))).toThrow(
      DomainError,
    );
  });
});

describe("isPairingCodeValid", () => {
  const code: PairingCode = Object.freeze({
    code: "AB23CD",
    expiresAt: NOW_MS,
    scope: "read_only",
  });

  it("is valid strictly before expiry", () => {
    expect(isPairingCodeValid(code, NOW_MS - 1)).toBe(true);
  });

  it("is invalid at or after expiry", () => {
    expect(isPairingCodeValid(code, NOW_MS)).toBe(false);
    expect(isPairingCodeValid(code, NOW_MS + 1)).toBe(false);
  });

  it("fails closed for a non-finite now", () => {
    expect(isPairingCodeValid(code, Number.NaN)).toBe(false);
    expect(isPairingCodeValid(code, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("validateDeviceSession", () => {
  const validSession: DeviceSession = Object.freeze({
    sessionId: "session-1",
    deviceLabel: "Ada's iPhone",
    scope: "control",
    createdAt: NOW_MS,
    lastSeen: NOW_MS + 5_000,
  });

  it("accepts and freezes a well-formed session", () => {
    const validated = validateDeviceSession(validSession);
    expect(validated).toEqual(validSession);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it("rejects an invalid scope", () => {
    expect(() => validateDeviceSession({ ...validSession, scope: "admin" as never })).toThrow(
      DomainError,
    );
  });

  it("rejects an empty sessionId", () => {
    expect(() => validateDeviceSession({ ...validSession, sessionId: "  " })).toThrow(DomainError);
  });

  it("rejects an empty deviceLabel", () => {
    expect(() => validateDeviceSession({ ...validSession, deviceLabel: "" })).toThrow(DomainError);
  });

  it("rejects a negative or non-integer createdAt", () => {
    expect(() => validateDeviceSession({ ...validSession, createdAt: -1 })).toThrow(DomainError);
    expect(() => validateDeviceSession({ ...validSession, createdAt: 1.5 })).toThrow(DomainError);
  });

  it("rejects a negative or non-integer lastSeen", () => {
    expect(() => validateDeviceSession({ ...validSession, lastSeen: -1 })).toThrow(DomainError);
    expect(() => validateDeviceSession({ ...validSession, lastSeen: 1.5 })).toThrow(DomainError);
  });

  it("rejects lastSeen preceding createdAt", () => {
    expect(() =>
      validateDeviceSession({ ...validSession, createdAt: NOW_MS, lastSeen: NOW_MS - 1 }),
    ).toThrow(DomainError);
  });
});
