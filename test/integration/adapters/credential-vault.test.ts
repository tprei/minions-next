import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CredentialVaultError,
  createCredentialVault,
  type CredentialVault,
  type SystemdCredsKeyMode,
} from "@minions/adapters";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Integration test for the SystemdCredentialVault (PR 19, deliverable 8). Exercises
 * a real `systemd-creds encrypt/decrypt` round-trip plus the fail-closed paths:
 * invalid name rejection, at-rest permission drift detection, and `not_found` on
 * absent/deleted entries.
 *
 * ## Empirical deviation (documented in `credential-vault.ts`)
 * `--with-key=host` requires read access to the root-only
 * `/var/lib/systemd/credential.secret`. This dev box has no host key, so the test
 * probes for a working mode at setup and uses it explicitly via
 * `systemdCredsKeyMode`. The factory default remains `"host"` (production-correct);
 * the test never silently falls back.
 */

const HOST_ID = "01900000-0000-7000-8000-000000000010";
const systemdCredsPath = "/usr/bin/systemd-creds";
const keyMode = detectKeyMode();
const live = keyMode !== undefined;

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir === undefined) break;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe.skipIf(!live)("SystemdCredentialVault round-trip (real systemd-creds)", () => {
  it("round-trips a secret through put/get/delete and validates 0600 at rest", async () => {
    const vault = makeVault();
    const probe = vault.probe();
    expect(probe.available).toBe(true);
    expect(probe.backend).toBe("systemd-creds");
    expect(probe.detail).toContain(`key=${keyMode ?? "unknown"}`);

    const secret = new TextEncoder().encode("broker-bearer-0123456789abcdef");
    await vault.put("auth-broker.token", secret);

    const cipherPath = join(vaultStoreDir(vault), "auth-broker.token.cred");
    const info = statSync(cipherPath);
    expect(info.mode & 0o777).toBe(0o600);

    const got = await vault.get("auth-broker.token");
    expect(new TextDecoder().decode(got)).toBe("broker-bearer-0123456789abcdef");

    await vault.delete("auth-broker.token");
    await expect(vault.get("auth-broker.token")).rejects.toMatchObject({
      code: "not_found",
      name: "CredentialVaultError",
    });
  });

  it("overwrites a prior secret on subsequent put", async () => {
    const vault = makeVault();
    await vault.put("auth-broker.token", new TextEncoder().encode("first-secret-value"));
    await vault.put("auth-broker.token", new TextEncoder().encode("second-secret-value"));
    const got = await vault.get("auth-broker.token");
    expect(new TextDecoder().decode(got)).toBe("second-secret-value");
  });

  it("rejects invalid credential names fail-closed", async () => {
    const vault = makeVault();
    await expect(vault.put("not/allowed", new TextEncoder().encode("x"))).rejects.toMatchObject({
      code: "invalid_name",
      name: "CredentialVaultError",
    });
    await expect(vault.get("../etc-passwd")).rejects.toMatchObject({
      code: "invalid_name",
      name: "CredentialVaultError",
    });
  });

  it("fails closed when at-rest permissions drift from 0600", async () => {
    const vault = makeVault();
    await vault.put("auth-broker.token", new TextEncoder().encode("secret-value"));
    const cipherPath = join(vaultStoreDir(vault), "auth-broker.token.cred");
    chmodSync(cipherPath, 0o644);
    await expect(vault.get("auth-broker.token")).rejects.toMatchObject({
      code: "permission_invalid",
      name: "CredentialVaultError",
    });
  });

  it("delete is idempotent", async () => {
    const vault = makeVault();
    await vault.delete("never.existed");
    await vault.delete("never.existed");
  });
});

it("factory createCredentialVault selects the systemd-creds backend on this host", () => {
  const vaultOptions: {
    storeDirectory: string;
    systemdCredsKeyMode?: SystemdCredsKeyMode;
  } = { storeDirectory: makeStoreDirectory() };
  if (keyMode !== undefined) {
    vaultOptions.systemdCredsKeyMode = keyMode;
  }
  const vault = createCredentialVault(HOST_ID, vaultOptions);
  expect(vault.backend).toBe("systemd-creds");
});

describe("SystemdCredentialVault factory (always run)", () => {
  it("probe reports the configured key mode in detail", () => {
    const dir = makeStoreDirectory();
    const vault = createCredentialVault(HOST_ID, {
      storeDirectory: dir,
      systemdCredsKeyMode: "auto-initrd",
    });
    const probe = vault.probe();
    expect(probe.backend).toBe("systemd-creds");
    expect(probe.detail).toContain("key=auto-initrd");
  });

  it("probe surfaces a missing systemd-creds binary", () => {
    const vault = createCredentialVault(HOST_ID, {
      storeDirectory: makeStoreDirectory(),
      systemdCredsPath: "/does/not/exist/systemd-creds",
      systemdCredsKeyMode: "host",
    });
    const probe = vault.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("/does/not/exist/systemd-creds");
  });

  it("throws CredentialVaultError with stable codes", () => {
    const err = new CredentialVaultError("not_found", "systemd-creds", "absent");
    expect(err.code).toBe("not_found");
    expect(err.backend).toBe("systemd-creds");
    expect(err.name).toBe("CredentialVaultError");
  });

  it("rejects tpm2-absent as an unencrypted-at-rest key mode", () => {
    let thrown: unknown;
    try {
      createCredentialVault(HOST_ID, {
        storeDirectory: makeStoreDirectory(),
        systemdCredsKeyMode: "tpm2-absent",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CredentialVaultError);
    expect((thrown as CredentialVaultError).code).toBe("vault_unavailable");
  });
});

function makeVault(): CredentialVault {
  return createCredentialVault(HOST_ID, {
    storeDirectory: makeStoreDirectory(),
    systemdCredsPath,
    systemdCredsKeyMode: keyMode ?? "host",
  });
}

function makeStoreDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "mvault-test-"));
  temporaryDirectories.push(dir);
  return dir;
}

function vaultStoreDir(vault: CredentialVault): string {
  // probe() detail string embeds the store directory; parse it out for assertions.
  const detail = vault.probe().detail;
  const marker = "store ";
  const start = detail.indexOf(marker);
  if (start < 0) throw new Error(`cannot locate store directory in detail: ${detail}`);
  const rest = detail.slice(start + marker.length);
  const comma = rest.indexOf(",");
  return (comma < 0 ? rest : rest.slice(0, comma)).trim();
}

/**
 * Probe which `--with-key=` mode actually works on this host. `host` is preferred
 * (matches the factory default); on a stock WSL2 dev box the root-only host key
 * is unavailable so we fall back to `auto-initrd` (works without setup) for test
 * purposes only. Returns `undefined` when no mode works → tests skip.
 */
function detectKeyMode(): SystemdCredsKeyMode | undefined {
  if (!existsSync(systemdCredsPath)) return undefined;
  const plain = join(tmpdir(), `mvault-probe-${String(process.pid)}-${String(Date.now())}.plain`);
  writeFileSync(plain, "probe");
  try {
    // tpm2-absent deliberately excluded: createCredentialVault now rejects it
    // (P1, review #20 - it stores the vault unencrypted at rest), so it must
    // never be selected here as a "working" mode for makeVault() to use.
    const modes: readonly SystemdCredsKeyMode[] = ["host", "auto-initrd", "auto"];
    for (const mode of modes) {
      const cipher = join(
        tmpdir(),
        `mvault-probe-${String(process.pid)}-${String(Date.now())}.cipher`,
      );
      const result = spawnSync(
        systemdCredsPath,
        ["encrypt", "--name=probe", `--with-key=${mode}`, plain, cipher],
        { encoding: "utf8" },
      );
      if (result.status === 0 && existsSync(cipher)) {
        rmSync(cipher, { force: true });
        return mode;
      }
      rmSync(cipher, { force: true });
    }
    return undefined;
  } finally {
    rmSync(plain, { force: true });
  }
}
