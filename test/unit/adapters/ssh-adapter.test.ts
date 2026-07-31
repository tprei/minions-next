import { describe, it, expect } from "vitest";
import {
  createSshConnection,
  SshAdapterError,
  type SshRunResult,
  type SshRunner,
} from "@minions/adapters";
import type { SshProfile } from "@minions/core";

/**
 * Unit tests for the SSH adapter (PR 53 — ssh-execution-hosts).
 * Uses test doubles for the `ssh` and `ssh-keyscan` binaries — no real SSH
 * connections or network calls are made.
 */

// A well-formed base64 Ed25519 public key blob (structurally valid, not tied to
// any real host) and its SHA-256 hex fingerprint — the format `knownHostKey`
// pins against. Computed once via `createHash("sha256")` over the decoded bytes.
const PINNED_KEY_BASE64 = "AAAAC3NzaC1lZDI1NTE5AAAAIMWTqRchDqzassJCK+vayKnWxoWIexa3JR6wK//KFe6G";
const PINNED_FINGERPRINT = "9bec24547d896e818b370c5d30bea9c13181b979569e83c584675c34b5462e8e";
const OTHER_KEY_BASE64 = "AAAAC3NzaC1lZDI1NTE5AAAAIHKlVvVQxN8XyKQZ3tGqW9fJZ2vN4LxYcRp8bDmQnE5T";

const PROFILE: SshProfile = Object.freeze({
  alias: "test-host",
  hostname: "192.168.1.100",
  port: 22,
  user: "operator",
  knownHostKey: PINNED_FINGERPRINT as never,
  controlMasterPath: "/tmp/ssh-test-%r@%h:%p",
  localForwardPort: 4275,
});

const SUPERVISOR_VERSION = "1.0.0";

/** Version-exchange test seam returning a version compatible with {@link SUPERVISOR_VERSION}. */
function compatibleHostVersion(): () => Promise<string> {
  return () => Promise.resolve("1.4.2");
}

function successRunner(): SshRunner {
  return () => Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" });
}

function failingRunner(exitCode: number, stderr: string): SshRunner {
  return () => Promise.resolve<SshRunResult>({ exitCode, stdout: "", stderr });
}

/** A double for `ssh-keyscan` that presents the given base64 key for the host. */
function keyscanRunner(base64Key: string): SshRunner {
  return () =>
    Promise.resolve<SshRunResult>({
      exitCode: 0,
      stdout: `${PROFILE.hostname} ssh-ed25519 ${base64Key}\n`,
      stderr: "",
    });
}

describe("SSH connection lifecycle", () => {
  it("verifies the host key, then establishes ControlMaster with port forwarding", async () => {
    const calls: string[][] = [];
    const runner: SshRunner = (args) => {
      calls.push([...args]);
      return Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" });
    };
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: runner,
      runKeyscan: keyscanRunner(PINNED_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
      queryHostVersion: compatibleHostVersion(),
    });
    await conn.connect();
    expect(conn.state).toBe("connected");

    // The connect call must include ControlMaster, ControlPath, port forward, and host key pinning.
    const connectArgs = calls[0];
    expect(connectArgs).toContain("ControlMaster=yes");
    expect(connectArgs).toContain(`ControlPath=${PROFILE.controlMasterPath}`);
    expect(connectArgs).toContain(`-L`);
    const forwardSpec = `${String(PROFILE.localForwardPort)}:127.0.0.1:${String(PROFILE.localForwardPort)}`;
    expect(connectArgs).toContain(forwardSpec);
    expect(connectArgs).toContain("StrictHostKeyChecking=yes");
    expect(connectArgs).toContain(`${PROFILE.user}@${PROFILE.hostname}`);
    // The known_hosts file must be pinned to the just-verified key, never /dev/null
    // or a bare fingerprint (OpenSSH's known_hosts machinery compares full keys).
    const knownHostsArg = connectArgs?.find((a) => a.startsWith("UserKnownHostsFile="));
    expect(knownHostsArg).toBeDefined();
    expect(knownHostsArg).not.toBe("UserKnownHostsFile=/dev/null");
  });

  it("reports connected state after successful connect", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: successRunner(),
      runKeyscan: keyscanRunner(PINNED_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
      queryHostVersion: compatibleHostVersion(),
    });
    expect(conn.state).toBe("disconnected");
    await conn.connect();
    expect(conn.state).toBe("connected");
  });

  it("health check returns true when connection is alive", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: successRunner(),
      runKeyscan: keyscanRunner(PINNED_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
      queryHostVersion: compatibleHostVersion(),
    });
    await conn.connect();
    const healthy = await conn.checkHealth();
    expect(healthy).toBe(true);
  });

  it("health check returns false when not connected", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: successRunner(),
      supervisorVersion: SUPERVISOR_VERSION,
    });
    const healthy = await conn.checkHealth();
    expect(healthy).toBe(false);
  });

  it("disconnect sends ControlMaster exit", async () => {
    const calls: string[][] = [];
    const runner: SshRunner = (args) => {
      calls.push([...args]);
      return Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" });
    };
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: runner,
      runKeyscan: keyscanRunner(PINNED_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
      queryHostVersion: compatibleHostVersion(),
    });
    await conn.connect();
    await conn.disconnect();
    expect(conn.state).toBe("disconnected");

    const disconnectArgs = calls[calls.length - 1];
    expect(disconnectArgs).toContain("-O");
    expect(disconnectArgs).toContain("exit");
  });

  it("disconnect when already disconnected is a no-op", async () => {
    const calls: string[][] = [];
    const runner: SshRunner = (args) => {
      calls.push([...args]);
      return Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" });
    };
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: runner,
      supervisorVersion: SUPERVISOR_VERSION,
    });
    await conn.disconnect();
    expect(calls.length).toBe(0);
    expect(conn.state).toBe("disconnected");
  });

  it("sets error state on connection failure", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: failingRunner(255, "Permission denied"),
      runKeyscan: keyscanRunner(PINNED_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
    });
    await expect(conn.connect()).rejects.toThrow(/SSH connection.*failed/);
    expect(conn.state).toBe("error");
  });
});

describe("SSH version exchange on connect (PR 53 — version skew policy)", () => {
  it("rejects fail-closed with a typed version_skew error on major version mismatch", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: successRunner(),
      runKeyscan: keyscanRunner(PINNED_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
      queryHostVersion: () => Promise.resolve("2.0.0"),
    });
    try {
      await conn.connect();
      expect.unreachable("connect() must reject on a version skew");
    } catch (error) {
      expect(error).toBeInstanceOf(SshAdapterError);
      expect(error instanceof SshAdapterError ? error.code : undefined).toBe("version_skew");
      expect(error instanceof Error ? error.message : "").toContain("major version mismatch");
    }
    expect(conn.state).toBe("error");
  });

  it("tears the ControlMaster back down when rejecting a version-skewed connection", async () => {
    const calls: string[][] = [];
    const runner: SshRunner = (args) => {
      calls.push([...args]);
      return Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" });
    };
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: runner,
      runKeyscan: keyscanRunner(PINNED_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
      queryHostVersion: () => Promise.resolve("2.0.0"),
    });
    await expect(conn.connect()).rejects.toThrow(SshAdapterError);
    // First call establishes ControlMaster; the rejection must issue a second,
    // best-effort `-O exit` teardown rather than leaving a live socket dangling.
    expect(calls.length).toBe(2);
    const teardownArgs = calls[1];
    expect(teardownArgs).toContain("-O");
    expect(teardownArgs).toContain("exit");
  });

  it("accepts a compatible host version and reports connected", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: successRunner(),
      runKeyscan: keyscanRunner(PINNED_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
      queryHostVersion: () => Promise.resolve("1.9.9"),
    });
    await conn.connect();
    expect(conn.state).toBe("connected");
  });
});

describe("SSH host key verification (PR 59 — ssh_revocation, syntheticId 14)", () => {
  it("rejects a connection when the presented key does not match the pin", async () => {
    const sshCalls: string[][] = [];
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: (args) => {
        sshCalls.push([...args]);
        return Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" });
      },
      runKeyscan: keyscanRunner(OTHER_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
    });
    await expect(conn.connect()).rejects.toThrow(/host key/i);
    expect(conn.state).toBe("error");
    // The mismatch must be caught BEFORE any ControlMaster handshake is attempted.
    expect(sshCalls.length).toBe(0);
  });

  it("surfaces a typed host_key_mismatch error code, not the generic connection_failed", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: successRunner(),
      runKeyscan: keyscanRunner(OTHER_KEY_BASE64),
      supervisorVersion: SUPERVISOR_VERSION,
    });
    try {
      await conn.connect();
      expect.unreachable("connect() must reject on a host key mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(SshAdapterError);
      expect(error instanceof SshAdapterError ? error.code : undefined).toBe("host_key_mismatch");
    }
  });

  it("rejects when the host presents no key at all", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: successRunner(),
      runKeyscan: () => Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" }),
      supervisorVersion: SUPERVISOR_VERSION,
    });
    try {
      await conn.connect();
      expect.unreachable("connect() must reject when no key is presented");
    } catch (error) {
      expect(error).toBeInstanceOf(SshAdapterError);
      expect(error instanceof SshAdapterError ? error.code : undefined).toBe("host_key_mismatch");
    }
  });

  it("accepts whichever presented key matches the pin among several", async () => {
    const conn = createSshConnection({
      profile: PROFILE,
      runSsh: successRunner(),
      runKeyscan: () =>
        Promise.resolve<SshRunResult>({
          exitCode: 0,
          stdout: [
            `${PROFILE.hostname} ecdsa-sha2-nistp256 ${OTHER_KEY_BASE64}`,
            `${PROFILE.hostname} ssh-ed25519 ${PINNED_KEY_BASE64}`,
          ].join("\n"),
          stderr: "",
        }),
      supervisorVersion: SUPERVISOR_VERSION,
      queryHostVersion: compatibleHostVersion(),
    });
    await conn.connect();
    expect(conn.state).toBe("connected");
  });
});
