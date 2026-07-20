import { describe, expect, it } from "vitest";
import {
  createLinuxPodmanSandboxLifecycle,
  createWsl2PodmanSandboxLifecycle,
  PodmanSandboxError,
  type PodmanSandboxOptions,
} from "../../packages/adapters/src/podman-sandbox.js";
import { contentHash, type ContentHash } from "@minions/core";

const DIGEST_64 = "a".repeat(64);

function baseOptions(): PodmanSandboxOptions {
  return {
    storageRoot: "/tmp/minions-podman-test/storage",
    stateRoot: "/tmp/minions-podman-test/state",
    podmanPath: "/usr/bin/podman",
    seccompProfilePath: "/tmp/minions-podman-test/seccomp.json",
    template: {
      podmanPath: "/usr/bin/podman",
      imageReference: `registry.example/minions/node:24.18.0@sha256:${DIGEST_64}`,
      expectedImageDigest: contentHash(DIGEST_64),
      storageRoot: "/tmp/minions-podman-test/storage",
      stateRoot: "/tmp/minions-podman-test/state",
      runtime: { podmanPath: "/usr/bin/podman", version: "5.0.0" },
    },
    expectedTemplateFingerprint: { policyVersion: 1, digest: contentHash(DIGEST_64) },
  };
}

function expectInvalidConfiguration(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PodmanSandboxError);
    expect((error as PodmanSandboxError).code).toBe("invalid_configuration");
    return;
  }
  throw new Error("expected createLinuxPodmanSandboxLifecycle to throw");
}

describe("podman sandbox backend kind confinement", () => {
  it("constructs a linux_podman lifecycle with the correct backend kind", () => {
    const lifecycle = createLinuxPodmanSandboxLifecycle(baseOptions());
    expect(lifecycle.backendKind).toBe("linux_podman");
  });

  it("constructs a wsl2_podman lifecycle with the correct backend kind", () => {
    const lifecycle = createWsl2PodmanSandboxLifecycle({
      ...baseOptions(),
      wslDistroName: "Ubuntu",
    });
    expect(lifecycle.backendKind).toBe("wsl2_podman");
  });

  it("rejects a WSL distribution name on the Linux Podman backend", () => {
    expectInvalidConfiguration(() =>
      createLinuxPodmanSandboxLifecycle({ ...baseOptions(), wslDistroName: "Ubuntu" }),
    );
  });

  it("requires a named WSL distribution on the WSL2 Podman backend", () => {
    expectInvalidConfiguration(() => createWsl2PodmanSandboxLifecycle(baseOptions()));
  });

  it("rejects an empty WSL distribution name on the WSL2 Podman backend", () => {
    expectInvalidConfiguration(() =>
      createWsl2PodmanSandboxLifecycle({ ...baseOptions(), wslDistroName: "" }),
    );
  });
});

describe("podman sandbox fail-closed option validation", () => {
  it("rejects a relative storage root", () => {
    expectInvalidConfiguration(() =>
      createLinuxPodmanSandboxLifecycle({ ...baseOptions(), storageRoot: "relative/storage" }),
    );
  });

  it("rejects a relative state root", () => {
    expectInvalidConfiguration(() =>
      createLinuxPodmanSandboxLifecycle({ ...baseOptions(), stateRoot: "relative/state" }),
    );
  });

  it("rejects a relative podman path", () => {
    expectInvalidConfiguration(() =>
      createLinuxPodmanSandboxLifecycle({ ...baseOptions(), podmanPath: "podman" }),
    );
  });

  it("rejects a relative seccomp profile path", () => {
    expectInvalidConfiguration(() =>
      createLinuxPodmanSandboxLifecycle({
        ...baseOptions(),
        seccompProfilePath: "relative/seccomp.json",
      }),
    );
  });

  it("rejects a template state root that differs from the sandbox state root", () => {
    expectInvalidConfiguration(() =>
      createLinuxPodmanSandboxLifecycle({
        ...baseOptions(),
        template: { ...baseOptions().template, stateRoot: "/tmp/different-state" },
      }),
    );
  });

  it("rejects an invalid expected template fingerprint", () => {
    expectInvalidConfiguration(() =>
      createLinuxPodmanSandboxLifecycle({
        ...baseOptions(),
        expectedTemplateFingerprint: { policyVersion: 1, digest: "not-a-digest" as ContentHash },
      }),
    );
  });
});
