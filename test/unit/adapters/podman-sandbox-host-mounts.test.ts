import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import type * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertHostMounts,
  type PodmanSandboxOptions,
} from "../../../packages/adapters/src/podman-sandbox.js";
import { contentHash, type SandboxPolicy } from "@minions/core";

const DIGEST = "a".repeat(64);
const fakeHome = vi.hoisted(() => ({ path: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual: typeof nodeOs = await importOriginal();
  return { ...actual, homedir: () => fakeHome.path };
});

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const directory = cleanups.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(root);
  return root;
}

async function makeDirectory(root: string, ...segments: string[]): Promise<string> {
  const path = join(root, ...segments);
  await mkdir(path, { recursive: true });
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

function options(storageRoot: string, stateRoot: string): PodmanSandboxOptions {
  return {
    storageRoot,
    stateRoot,
    podmanPath: "/usr/bin/podman",
    seccompProfilePath: "/usr/bin/podman-test/seccomp.json",
    template: {
      podmanPath: "/usr/bin/podman",
      imageReference: `registry.example/minions/node:24.18.0@sha256:${DIGEST}`,
      expectedImageDigest: contentHash(DIGEST),
      storageRoot,
      stateRoot,
      runtime: { podmanPath: "/usr/bin/podman", version: "5.0.0" },
    },
    expectedTemplateFingerprint: { policyVersion: 1, digest: contentHash(DIGEST) },
  };
}

// Mirrors SENSITIVE_MACOS_MOUNT_SOURCE_ROOTS coverage in
// lima-sandbox-host-mounts.test.ts: podman is the backend on Linux and WSL2,
// where workspaces normally live under $HOME, so an ordinary workspace under
// the caller's home must be accepted while the credential/config roots under
// that same home must stay forbidden.
describe("podman sandbox host mount confinement", () => {
  it("accepts an ordinary workspace directory living under the caller's home", async () => {
    const home = await makeTempRoot("minions-podman-home-");
    fakeHome.path = home;
    const storageRoot = await makeTempRoot("minions-podman-storage-");
    const stateRoot = await makeTempRoot("minions-podman-state-");
    const workspace = await makeDirectory(home, "repos", "example");
    await expect(
      assertHostMounts(
        policyWithSource(workspace),
        "linux_podman",
        options(storageRoot, stateRoot),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects credential and config roots under the caller's home", async () => {
    const home = await makeTempRoot("minions-podman-home-");
    fakeHome.path = home;
    const storageRoot = await makeTempRoot("minions-podman-storage-");
    const stateRoot = await makeTempRoot("minions-podman-state-");
    for (const sensitiveRoot of [
      ".ssh",
      ".gnupg",
      ".aws",
      ".config/gh",
      ".docker",
      ".kube",
      ".local/share/keyrings",
    ]) {
      const source = await makeDirectory(home, ...sensitiveRoot.split("/"));
      await expect(
        assertHostMounts(policyWithSource(source), "linux_podman", options(storageRoot, stateRoot)),
      ).rejects.toMatchObject({ code: "invalid_configuration" });
    }
  });

  it("still rejects the home directory itself and its ancestors", async () => {
    const home = await makeTempRoot("minions-podman-home-");
    fakeHome.path = home;
    const storageRoot = await makeTempRoot("minions-podman-storage-");
    const stateRoot = await makeTempRoot("minions-podman-state-");
    for (const source of [home, dirname(home)]) {
      await expect(
        assertHostMounts(policyWithSource(source), "linux_podman", options(storageRoot, stateRoot)),
      ).rejects.toMatchObject({ code: "invalid_configuration" });
    }
  });
});
