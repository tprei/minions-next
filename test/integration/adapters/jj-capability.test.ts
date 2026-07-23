import { afterAll, describe, expect, it, vi } from "vitest";

import { appendFile, chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PINNED_JJ_VERSION, ensureJjCapability, type JjCapabilityProbe } from "@minions/adapters";

/**
 * Integration tests for the engine-managed jj capability probe (PR 21 / GIT-14).
 *
 * These run against the LIVE jj-vcs/jj v0.43.0 release: the probe really downloads the archive,
 * verifies its pinned sha256, extracts the `jj` binary owner-only, probes `--version`, and runs a
 * capability handshake. Fail-closed cases (corrupt binary, wrong version, digest mismatch,
 * missing/unavailable platform) assert the probe never reports `available:true` and never runs a
 * tampered or unverified binary.
 */

const downloadTimeoutMs = 120_000;
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeToolsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jj-capability-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function requireAvailable(probe: JjCapabilityProbe) {
  expect(probe.available).toBe(true);
  if (!probe.available) {
    throw new Error("expected an available jj capability probe");
  }
  return probe;
}

function requireUnavailable(probe: JjCapabilityProbe) {
  expect(probe.available).toBe(false);
  if (probe.available) {
    throw new Error("expected an unavailable jj capability probe");
  }
  return probe;
}

describe("ensureJjCapability — jj v0.43.0 release", () => {
  it(
    "downloads, digest-verifies, and probes the pinned jj binary",
    { timeout: downloadTimeoutMs },
    async () => {
      const toolsDirectory = await makeToolsDirectory();
      const probe = requireAvailable(await ensureJjCapability({ toolsDirectory }));

      expect(probe.version).toBe(PINNED_JJ_VERSION);
      expect(probe.binaryPath).toBe(join(toolsDirectory, `jj-${PINNED_JJ_VERSION}`, "jj"));
      expect(probe.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(existsSync(probe.binaryPath)).toBe(true);
      expect(probe.capabilities).toEqual({
        workingCopy: true,
        oplog: true,
        absorb: true,
        conflictMarker: true,
      });

      // The installed binary is owner-only: no group/other write bit (not writable by a sandbox).
      const mode = (await stat(probe.binaryPath)).mode & 0o777;
      expect(mode & 0o022).toBe(0);
      // The install directory and manifest are owner-only too (not writable by a sandbox).
      const versionDirectory = join(toolsDirectory, `jj-${PINNED_JJ_VERSION}`);
      expect((await stat(versionDirectory)).mode & 0o777 & 0o022).toBe(0);
      expect((await stat(join(versionDirectory, "manifest.json"))).mode & 0o777 & 0o022).toBe(0);
    },
  );

  it(
    "is idempotent: a second call reuses the verified binary without re-downloading",
    { timeout: downloadTimeoutMs },
    async () => {
      const toolsDirectory = await makeToolsDirectory();
      const first = requireAvailable(await ensureJjCapability({ toolsDirectory }));

      // Spy AFTER the first install so only the reuse path is observed.
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const second = requireAvailable(await ensureJjCapability({ toolsDirectory }));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(second.binaryPath).toBe(first.binaryPath);
      expect(second.digest).toBe(first.digest);
      expect(second.version).toBe(first.version);
    },
  );

  it(
    "fails closed with corrupt_binary when the installed binary is tampered (never runs it)",
    { timeout: downloadTimeoutMs },
    async () => {
      const toolsDirectory = await makeToolsDirectory();
      const installed = requireAvailable(await ensureJjCapability({ toolsDirectory }));

      const suffix = Buffer.from("-tampered-by-test");
      await chmod(installed.binaryPath, 0o700);
      await appendFile(installed.binaryPath, suffix);

      const probe = requireUnavailable(await ensureJjCapability({ toolsDirectory }));
      expect(probe.failureCode).toBe("corrupt_binary");

      // The tampered binary was not repaired or re-extracted (and was never executed): the
      // appended bytes are still on disk.
      const after = await readFile(installed.binaryPath);
      expect(after.subarray(-suffix.length).toString("utf8")).toBe(suffix.toString("utf8"));
    },
  );

  it(
    "fails closed with version_mismatch when the version does not match the pin",
    { timeout: downloadTimeoutMs },
    async () => {
      const toolsDirectory = await makeToolsDirectory();
      const probe = requireUnavailable(
        await ensureJjCapability({ toolsDirectory, expectedVersion: "0.99.0" }),
      );
      expect(probe.failureCode).toBe("version_mismatch");
    },
  );

  it(
    "fails closed with digest_mismatch and never extracts an unverifiable archive",
    { timeout: downloadTimeoutMs },
    async () => {
      const toolsDirectory = await makeToolsDirectory();
      const probe = requireUnavailable(
        await ensureJjCapability({ toolsDirectory, expectedDigest: "0".repeat(64) }),
      );
      expect(probe.failureCode).toBe("digest_mismatch");
      // A tampered/unverifiable archive is never extracted or run: no jj binary lands on disk.
      expect(existsSync(join(toolsDirectory, `jj-${PINNED_JJ_VERSION}`, "jj"))).toBe(false);
    },
  );

  it("fails closed when no release asset exists for the host platform/arch", async () => {
    const toolsDirectory = await makeToolsDirectory();
    const probe = requireUnavailable(
      await ensureJjCapability({ toolsDirectory, archOverride: "mips64" }),
    );
    expect(probe.failureCode).toBe("invalid_options");
  });
});
