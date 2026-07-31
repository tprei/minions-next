import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertHostMounts } from "../../../packages/adapters/src/lima-sandbox.js";
import { contentHash, type SandboxPolicy } from "@minions/core";

const DIGEST = "a".repeat(64);
const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const directory = cleanups.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function makeDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(path);
  return path;
}

function policyWithSource(sourcePath: string): SandboxPolicy {
  return {
    version: 1,
    rootFilesystemDigest: contentHash(DIGEST),
    templateDigest: contentHash(DIGEST),
    mounts: [{ kind: "workspace", sourcePath, targetPath: "/workspace", access: "read_write" }],
    network: { profile: "implementation", allowedHosts: [], allowProviderGateway: false },
    tools: { allowedExecutables: [], allowedGitSubcommands: [], blockedGitSubcommands: [] },
    resources: {
      cpuCount: 1,
      memoryMiB: 512,
      processLimit: 32,
      storageMiB: 1024,
      executionTimeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
    },
  };
}

async function options(limaHome: string, stateDirectory: string) {
  return {
    limactlPath: "/usr/local/bin/limactl",
    limaHome,
    stateDirectory,
    template: {} as never,
    expectedTemplateFingerprint: { policyVersion: 1 as const, digest: contentHash(DIGEST) },
  };
}

// PR #17 review (P1) + Codex inline comment: the previous check rejected any
// mount source CONTAINED WITHIN homedir() (rejecting every ordinary
// /Users/<user>/repo workspace) while accepting anything ELSE outside
// limaHome/stateDirectory/homedir entirely (e.g. /Library, /private/etc,
// /dev were never checked at all).
describe("lima sandbox host mount confinement", () => {
  it("accepts an ordinary workspace directory living under the caller's home", async () => {
    const limaHome = await makeDirectory("minions-lima-home-");
    const stateDirectory = await makeDirectory("minions-lima-state-");
    // Simulates a workspace at ~/some/repo: a real directory NOT equal to
    // any sensitive root, just living somewhere on disk (as a real /Users/*
    // workspace would). Pre-fix this failed whenever it happened to be a
    // descendant of the actual process homedir(); this fixture uses tmpdir
    // instead to keep the test hermetic, and the fix no longer special-cases
    // homedir() at all, so this passing is the real regression check.
    const workspace = await makeDirectory("minions-lima-workspace-");
    await expect(
      assertHostMounts(policyWithSource(workspace), await options(limaHome, stateDirectory)),
    ).resolves.toBeUndefined();
  });

  it("rejects sensitive host roots that were previously never checked", async () => {
    const limaHome = await makeDirectory("minions-lima-home-");
    const stateDirectory = await makeDirectory("minions-lima-state-");
    for (const sensitiveRoot of ["/etc", "/var", "/private", "/Library"]) {
      await expect(
        assertHostMounts(
          policyWithSource(sensitiveRoot),
          await options(limaHome, stateDirectory),
        ),
      ).rejects.toMatchObject({ code: "invalid_configuration" });
    }
  });

  it("still rejects limaHome and stateDirectory themselves", async () => {
    const limaHome = await makeDirectory("minions-lima-home-");
    const stateDirectory = await makeDirectory("minions-lima-state-");
    await expect(
      assertHostMounts(policyWithSource(limaHome), await options(limaHome, stateDirectory)),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      assertHostMounts(policyWithSource(stateDirectory), await options(limaHome, stateDirectory)),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});
