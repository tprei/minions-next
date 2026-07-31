import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GateCategory } from "@minions/contracts";
import { loadGateProfile } from "@minions/adapters";
import { describe, expect, it } from "vitest";

// Points at the real repository root (three levels up from this file), not a fixture
// directory, so this test proves the maintained `.minions/gates.yaml` this repository ships
// with actually loads and validates — the PR 42 bootstrap threshold for self-registration.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("this repository's maintained gate profile", () => {
  it("loads .minions/gates.yaml and requires all five gate categories", async () => {
    const loaded = await loadGateProfile(repoRoot);

    expect(loaded.profile.requiredCategories).toEqual([
      GateCategory.LINT,
      GateCategory.TYPECHECK,
      GateCategory.TESTS,
      GateCategory.BUILD,
      GateCategory.SECURITY_REVIEW,
    ]);
    expect(loaded.profile.gates).toHaveLength(5);
    for (const entry of loaded.profile.gates) {
      expect(entry.command.executable).toBe("pnpm");
      expect(entry.command.args.length).toBeGreaterThan(0);
    }
    expect(loaded.profile.networkPolicy.allowedHosts).toEqual([]);
    expect(loaded.profile.worktreePolicy.weakeningPermitted).toBe(false);
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.profile.profileHash).toBe(loaded.hash);
  });
});
