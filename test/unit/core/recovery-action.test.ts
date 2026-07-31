import { describe, expect, it } from "vitest";
import {
  resolveGrantApproval,
  validateActionAgainstGrant,
  validateElevationRequest,
  validateRecoveryAction,
  type ElevationGrant,
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
      allowedKinds: ["restart", "signal"] as const,
      requiredApprovals: 2,
      maxGrantDurationMs: 900_000,
    });
    expect(profile.allowedKinds).toContain<RecoveryActionKind>("restart");
    expect(profile.allowedKinds).not.toContain<RecoveryActionKind>("force_rollback");
    expect(profile.requiredApprovals).toBe(2);
  });
});

describe("validateElevationRequest", () => {
  const PROFILE: RecoveryGateProfile = Object.freeze({
    allowedKinds: ["restart", "signal"] as const,
    requiredApprovals: 1,
    maxGrantDurationMs: 900_000,
  });

  it("accepts a valid request", () => {
    const verdict = validateElevationRequest(
      ["restart"],
      "investigating a stuck sandbox",
      PROFILE,
      NOW_MS,
    );
    expect(verdict).toEqual({ valid: true });
  });

  it("rejects empty requested kinds", () => {
    const verdict = validateElevationRequest([], "justification", PROFILE, NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/requested kinds/i);
  });

  it("rejects an unrecognized kind", () => {
    const verdict = validateElevationRequest(
      ["reboot_planet" as RecoveryActionKind],
      "justification",
      PROFILE,
      NOW_MS,
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/not recognized/i);
  });

  it("rejects an empty justification", () => {
    const verdict = validateElevationRequest(["restart"], "", PROFILE, NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/justification/i);
  });

  it("rejects a kind outside the profile's allowed kinds", () => {
    const verdict = validateElevationRequest(["force_rollback"], "justification", PROFILE, NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/force_rollback/);
    expect(verdict.reason).toMatch(/allowed kinds/i);
  });
});

describe("resolveGrantApproval", () => {
  it("approves immediately when the profile requires a single approval", () => {
    const profile: RecoveryGateProfile = Object.freeze({
      allowedKinds: ["restart"] as const,
      requiredApprovals: 1,
      maxGrantDurationMs: 900_000,
    });
    expect(resolveGrantApproval(profile)).toEqual({ state: "approved", approvalsReceived: 1 });
  });

  it("stays pending when the profile requires more than one approval", () => {
    const profile: RecoveryGateProfile = Object.freeze({
      allowedKinds: ["restart"] as const,
      requiredApprovals: 2,
      maxGrantDurationMs: 900_000,
    });
    expect(resolveGrantApproval(profile)).toEqual({ state: "pending", approvalsReceived: 1 });
  });
});

describe("validateActionAgainstGrant", () => {
  function makeGrant(overrides: Partial<ElevationGrant> = {}): ElevationGrant {
    return Object.freeze({
      id: "0190af1e-7b2d-7c3a-89ab-1234567890ac",
      requestedBySessionId: VALID_ACTOR,
      authorizedKinds: ["restart"] as const,
      justification: "investigating a stuck sandbox",
      state: "approved",
      approvalsReceived: 1,
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 900_000,
      ...overrides,
    });
  }

  it("accepts an action matching an approved, unexpired grant from its authorized actor", () => {
    const verdict = validateActionAgainstGrant(makeAction(), makeGrant(), NOW_MS);
    expect(verdict).toEqual({ valid: true });
  });

  it("rejects an action against a still-pending (unapproved) grant", () => {
    const verdict = validateActionAgainstGrant(
      makeAction(),
      makeGrant({ state: "pending" }),
      NOW_MS,
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/not approved/i);
  });

  it("rejects an action against an expired grant", () => {
    const verdict = validateActionAgainstGrant(
      makeAction(),
      makeGrant({ expiresAt: NOW_MS - 1 }),
      NOW_MS,
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/expired/i);
  });

  it("rejects an action from an actor session that does not match the grant", () => {
    const otherActor = "0290af1e-7b2d-7c3a-89ab-1234567890ab";
    const verdict = validateActionAgainstGrant(
      makeAction({ actorSessionId: otherActor }),
      makeGrant(),
      NOW_MS,
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/actor session/i);
  });

  it("rejects a kind the grant does not authorize", () => {
    const verdict = validateActionAgainstGrant(
      makeAction({ kind: "quarantine" }),
      makeGrant(),
      NOW_MS,
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/not authorized/i);
  });
});
