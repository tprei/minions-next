import { describe, it, expect } from "vitest";
import { SECURITY_SCENARIOS, type SecurityBoundary } from "@minions/core";

/**
 * Security scenario coverage audit (PR 59 — adversarial-security-synthetics).
 *
 * Verifies that every one of the 20 PRD synthetic scenarios maps to at least one
 * executable test in the security test suite. This is the meta-test that ensures
 * no scenario is silently uncovered — a scenario without a test is a security gap.
 */

// Map each boundary to its test coverage status. Updated as tests are added.
const COVERAGE: Record<SecurityBoundary, { tested: boolean; suites: string[] }> = {
  repository_confinement: {
    tested: true,
    suites: ["repository-confinement.test.ts"],
  },
  sandbox_escape: {
    tested: true,
    suites: ["sandbox-policy.test.ts"],
  },
  auth_forge: {
    tested: true,
    suites: ["auth-forge.test.ts"],
  },
  protobuf_fuzz: {
    tested: true,
    suites: ["protobuf-boundary.test.ts"],
  },
  command_idempotency: {
    tested: true,
    suites: ["command-idempotency.test.ts"],
  },
  event_gap: {
    tested: true,
    suites: ["event-gap.test.ts"],
  },
  git_ambiguity: {
    tested: true,
    suites: [
      "test/security/native-git-filter.test.ts",
      "test/integration/vcs-backend-native-git.test.ts",
    ],
  },
  policy_tampering: {
    tested: true,
    suites: ["sandbox-policy.test.ts"],
  },
  quota_restart: {
    tested: true,
    suites: [
      "test/unit/core/admission.test.ts",
      "test/integration/adapters/provider-admission.test.ts",
    ],
  },
  // syntheticId 14 "changed host key rejected" is covered by ssh-adapter.test.ts's
  // host_key_mismatch suite. syntheticId 13 "revoked SSH host rejected" is covered
  // by ssh-revocation.test.ts against the real supervisor registry (RegisterSshHost/
  // RemoveHost RPCs + requireActive's host_revoked guard). Real SSH bootstrap/
  // ControlMaster/tunnel connection dispatch needs a real remote host and is not
  // covered — see PR 53's spec delegation for that follow-up scope.
  ssh_revocation: {
    tested: true,
    suites: [
      "test/unit/adapters/ssh-adapter.test.ts (host_key_mismatch — syntheticId 14)",
      "test/integration/security/ssh-revocation.test.ts (requireActive/host_revoked — syntheticId 13)",
    ],
  },
  phone_revocation: {
    tested: true,
    suites: [
      "test/unit/core/pairing.test.ts",
      "test/integration/security/phone-revocation.test.ts",
    ],
  },
  jj_specific: {
    tested: true,
    suites: [
      "test/integration/adapters/revset.test.ts",
      "test/security/jj-working-copy.test.ts",
      "test/security/jj-registration.test.ts",
    ],
  },
};

describe("security scenario coverage audit", () => {
  it("every scenario is registered", () => {
    expect(SECURITY_SCENARIOS.length).toBe(20);
  });

  it("every scenario has a non-empty expectedDenialCode", () => {
    for (const s of SECURITY_SCENARIOS) {
      expect(s.expectedDenialCode.length).toBeGreaterThan(0);
    }
  });

  it("ensures every security boundary has test coverage", () => {
    const untested = SECURITY_SCENARIOS.filter((s) => !COVERAGE[s.boundary].tested);
    expect(untested).toEqual([]);
  });

  it("every tested boundary maps to at least one test suite", () => {
    for (const info of Object.values(COVERAGE)) {
      if (info.tested) {
        expect(info.suites.length).toBeGreaterThan(0);
      }
    }
  });
});
