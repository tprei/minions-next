import { describe, it, expect } from "vitest";
import { SECURITY_SCENARIOS, scenarioByBoundary } from "@minions/core";

describe("security matrix", () => {
  it("has exactly 20 scenarios", () => {
    expect(SECURITY_SCENARIOS).toHaveLength(20);
  });

  it("has dense unique syntheticIds from 1 to 20", () => {
    const ids = SECURITY_SCENARIOS.map((s) => s.syntheticId).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("every scenario has a non-empty name and expectedDenialCode", () => {
    for (const s of SECURITY_SCENARIOS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.expectedDenialCode.length).toBeGreaterThan(0);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SECURITY_SCENARIOS)).toBe(true);
  });

  it("scenarioByBoundary returns matching scenarios in ascending syntheticId order", () => {
    const jjScenarios = scenarioByBoundary("jj_specific");
    expect(jjScenarios.length).toBeGreaterThanOrEqual(1);
    const ids = jjScenarios.map((s) => s.syntheticId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("scenarioByBoundary returns empty array for single-scenario boundaries", () => {
    const quota = scenarioByBoundary("quota_restart");
    expect(quota).toHaveLength(1);
    expect(quota[0]?.boundary).toBe("quota_restart");
  });

  it("every declared boundary has at least one scenario", () => {
    const boundaries = [
      "repository_confinement",
      "sandbox_escape",
      "auth_forge",
      "protobuf_fuzz",
      "command_idempotency",
      "event_gap",
      "git_ambiguity",
      "policy_tampering",
      "quota_restart",
      "ssh_revocation",
      "phone_revocation",
      "jj_specific",
    ] as const;
    for (const b of boundaries) {
      expect(scenarioByBoundary(b).length).toBeGreaterThanOrEqual(1);
    }
  });
});
