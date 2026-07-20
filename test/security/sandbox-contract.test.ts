import { describe, expect, it } from "vitest";
import { createSandboxPolicyFingerprinter } from "../../packages/adapters/src/sandbox-policy.js";
import {
  createSandboxContractFixture,
  createTestSandboxLifecycle,
  executeSandboxContract,
  sandboxContractScenarios,
} from "../../packages/testkit/src/index.js";

describe("sandbox policy contract", () => {
  it("denies every malicious fixture scenario without changing host sentinels", async () => {
    const fixture = await createSandboxContractFixture();
    try {
      const fingerprinter = createSandboxPolicyFingerprinter();
      const lifecycle = createTestSandboxLifecycle({
        fingerprinter,
        sensitivePaths: fixture.sensitivePaths,
      });
      const report = await executeSandboxContract(lifecycle, fixture, fingerprinter);

      expect(report.scenarioCount).toBe(sandboxContractScenarios.length);
      expect(report.results.filter((result) => !result.passed)).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.results).toHaveLength(sandboxContractScenarios.length);
      expect(report.results.every((result) => result.passed)).toBe(true);
      expect(report.results.map((result) => result.id)).toEqual(
        sandboxContractScenarios.map((scenario) => scenario.id),
      );
      expect(report.sentinelsUnchanged).toBe(true);
      expect(report.sentinelsAfter).toEqual(report.sentinelsBefore);
      expect(report.sentinelsAfter).toEqual(fixture.sentinelContents);
    } finally {
      await fixture.dispose();
    }
  });
});
