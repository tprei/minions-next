import { describe, expect, it } from "vitest";
import { containerFlagSet } from "../../../packages/adapters/src/podman-sandbox.js";
import { contentHash, type SandboxPolicy } from "@minions/core";

const DIGEST_64 = "a".repeat(64);

function policy(): SandboxPolicy {
  return {
    version: 1,
    rootFilesystemDigest: contentHash(DIGEST_64),
    templateDigest: contentHash(DIGEST_64),
    mounts: [
      {
        kind: "workspace",
        sourcePath: "/tmp/minions-podman-argv-test/workspace",
        targetPath: "/workspace",
        access: "read_write",
      },
    ],
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

function stubOptions(): Parameters<typeof containerFlagSet>[1] {
  return {
    seccompProfilePath: "/tmp/seccomp.json",
    template: { imageReference: `registry.example/minions/node:24.18.0@sha256:${DIGEST_64}` },
  } as Parameters<typeof containerFlagSet>[1];
}

// PR #18 review (P0, likely-P0): `--rootless` is a Podman GLOBAL option and must
// precede the `create` subcommand in the invoked argv (`[podmanPath, ...global,
// "create", ...createArguments]`). Placing it inside `createArguments` (after
// `create`) makes `podman create` reject it as an unknown flag, so the sandbox
// can never start a container. This test asserts the argv-ordering contract
// directly against `containerFlagSet`'s output, independent of how the caller
// assembles the final `podman` invocation.
describe("podman create argv: --rootless placement", () => {
  it("returns --rootless in globalArguments, never in createArguments", () => {
    const flags = containerFlagSet(policy(), stubOptions(), "minions-test");
    expect(flags.globalArguments).toContain("--rootless");
    expect(flags.createArguments).not.toContain("--rootless");
  });

  it("places every globalArguments entry before the create subcommand in the built argv", () => {
    const flags = containerFlagSet(policy(), stubOptions(), "minions-test");
    const argv = ["/usr/bin/podman", ...flags.globalArguments, "create", ...flags.createArguments];
    const createIndex = argv.indexOf("create");
    for (const globalFlag of flags.globalArguments) {
      expect(argv.indexOf(globalFlag)).toBeLessThan(createIndex);
    }
  });
});
