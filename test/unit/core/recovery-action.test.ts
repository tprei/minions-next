import { describe, expect, it } from "vitest";
import {
  validateRecoveryAction,
  type RecoveryAction,
  type RecoveryActionKind,
  type RecoveryGateProfile,
} from "@minions/core";

/**
 * Unit tests for the pure recovery-elevation helpers (PR 56 —
 * maintenance-elevation-recovery). `validateRecoveryAction` is the fail-closed
 * gate a broker must pass before granting or executing a {@link RecoveryAction}.
 */

const NOW_MS = 1_700_000_000_000;
const VALID_ACTOR = "0190af1e-7b2d-7c3a-89ab-1234567890ab";

function makeAction(overrides: Partial<RecoveryAction> = {}): RecoveryAction {
  return Object.freeze({
    kind: "restart",
    target: "sandbox-42",
    expectedState: "running",
    actorSessionId: VALID_ACTOR,
    expiresAt: NOW_MS + 60_000,
    ...overrides,
  });
}

describe("validateRecoveryAction", () => {
  it("accepts a well-formed action with a future expiry", () => {
    expect(validateRecoveryAction(makeAction(), NOW_MS)).toEqual({ valid: true });
  });

  it("accepts every recognized RecoveryActionKind", () => {
    const kinds: readonly RecoveryActionKind[] = [
      "signal",
      "restart",
      "quarantine",
      "reconcile",
      "debug_attach",
      "source_patch_branch",
      "shadow_verify",
      "candidate_activate",
      "force_rollback",
    ];
    for (const kind of kinds) {
      expect(validateRecoveryAction(makeAction({ kind }), NOW_MS).valid).toBe(true);
    }
  });

  it("rejects an unrecognized kind", () => {
    const action = makeAction({ kind: "reboot_planet" as RecoveryActionKind });
    const verdict = validateRecoveryAction(action, NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/kind/i);
  });

  it("rejects an empty target", () => {
    const verdict = validateRecoveryAction(makeAction({ target: "" }), NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/target/i);
  });

  it("rejects an empty expected state", () => {
    const verdict = validateRecoveryAction(makeAction({ expectedState: "" }), NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/expected state/i);
  });

  it("rejects an actorSessionId that is not a lowercase UUID", () => {
    const verdict = validateRecoveryAction(makeAction({ actorSessionId: "not-a-uuid" }), NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/actor session id/i);

    const uppercase = validateRecoveryAction(
      makeAction({ actorSessionId: VALID_ACTOR.toUpperCase() }),
      NOW_MS,
    );
    expect(uppercase.valid).toBe(false);
  });

  it("rejects an expiresAt that has already passed", () => {
    const verdict = validateRecoveryAction(makeAction({ expiresAt: NOW_MS - 1 }), NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/expire/i);
  });

  it("rejects an expiresAt equal to now (not strictly in the future)", () => {
    const verdict = validateRecoveryAction(makeAction({ expiresAt: NOW_MS }), NOW_MS);
    expect(verdict.valid).toBe(false);
  });

  it("rejects a non-finite expiresAt", () => {
    const verdict = validateRecoveryAction(
      makeAction({ expiresAt: Number.POSITIVE_INFINITY }),
      NOW_MS,
    );
    expect(verdict.valid).toBe(false);
  });
});

describe("RecoveryGateProfile", () => {
  it("describes which kinds a grant may authorize and its approval/duration limits", () => {
    const profile: RecoveryGateProfile = Object.freeze({
      allowedKinds: ["restart", "signal"],
      requiredApprovals: 2,
      maxGrantDurationMs: 900_000,
    });
    expect(profile.allowedKinds).toContain<RecoveryActionKind>("restart");
    expect(profile.allowedKinds).not.toContain<RecoveryActionKind>("force_rollback");
    expect(profile.requiredApprovals).toBe(2);
  });
});
