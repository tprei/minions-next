/**
 * SSH execution-host adapter (PR 53 — ssh-execution-hosts).
 *
 * Manages the SSH ControlMaster lifecycle for a remote execution host: establishes a
 * persistent multiplexed connection, verifies the host key against the pinned fingerprint,
 * sets up local port forwarding to the remote daemon's loopback Connect API, and tears
 * everything down cleanly.
 *
 * SSH runs bootstrap/service commands only — node commands, events, and evidence use the
 * tunneled generated Connect API, never raw SSH (acceptance: "SSH runs bootstrap/service
 * commands only"). This adapter never sends application data over the SSH channel.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ApiVersionSchema, SystemService } from "@minions/contracts";
import { checkVersionSkew, type SshProfile } from "@minions/core";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type SshErrorCode =
  | "invalid_options"
  | "ssh_unavailable"
  | "connection_failed"
  | "host_key_mismatch"
  | "version_skew"
  | "forward_failed"
  | "timeout";

export class SshAdapterError extends Error {
  readonly code: SshErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: SshErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SshAdapterError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Test seam.
// -------------------------------------------------------------------------------------------------

export type SshRunResult = Readonly<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}>;

/** Run the system `ssh` binary with `args`. Test seam — production spawns the real binary. */
export type SshRunner = (args: readonly string[]) => Promise<SshRunResult>;

// -------------------------------------------------------------------------------------------------
// Types.
// -------------------------------------------------------------------------------------------------

export type SshAdapterOptions = Readonly<{
  readonly profile: SshProfile;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Run ssh with the given args. Test seam — defaults to the bounded subprocess runner. */
  readonly runSsh?: SshRunner;
  /** Run ssh-keyscan with the given args. Test seam — defaults to the bounded subprocess runner. */
  readonly runKeyscan?: SshRunner;
  /**
   * This supervisor's own server version, exchanged with the remote host's version on
   * connect (PR 53 — version skew policy). Connect is rejected fail-closed when
   * {@link checkVersionSkew} finds the versions incompatible.
   */
  readonly supervisorVersion: string;
  /**
   * Query the remote host's server version over the just-established tunnel. Test seam —
   * defaults to a real `GetServerInfo` RPC call against `127.0.0.1:localForwardPort`.
   */
  readonly queryHostVersion?: (localForwardPort: number) => Promise<string>;
}>;

export type SshConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface SshConnection {
  /** Current connection state. */
  readonly state: SshConnectionState;
  /** The local port the remote daemon is forwarded to. */
  readonly localForwardPort: number;
  /** Establish the ControlMaster connection and port forward. */
  connect(): Promise<void>;
  /** Health-check the multiplexed connection. */
  checkHealth(): Promise<boolean>;
  /** Tear down the ControlMaster connection and port forward. */
  disconnect(): Promise<void>;
}

// -------------------------------------------------------------------------------------------------
// Implementation.
// -------------------------------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Create an SSH connection manager for a remote execution host. The connection uses
 * OpenSSH ControlMaster multiplexing so every subsequent ssh invocation reuses one
 * persistent TCP connection (no re-authentication per command).
 */
export function createSshConnection(options: SshAdapterOptions): SshConnection {
  const { profile, signal, runSsh, runKeyscan, supervisorVersion } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const injectedRunner = runSsh;
  const injectedKeyscanRunner = runKeyscan;
  const queryHostVersion = options.queryHostVersion ?? defaultQueryHostVersion;

  let state: SshConnectionState = "disconnected";

  // Serialized broker: SSH commands chain off the previous one so concurrent callers
  // cannot interleave on the shared ControlMaster socket.
  let chain: Promise<void> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const pending = chain.catch(() => undefined).then(fn);
    chain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function run(args: readonly string[]): Promise<SshRunResult> {
    const result =
      injectedRunner !== undefined ? injectedRunner(args) : runSshBounded(args, timeoutMs, signal);
    const resolved = await result;
    if (resolved.exitCode !== 0) {
      throw sshError(
        "connection_failed",
        `ssh ${args.join(" ")} exited with code ${String(resolved.exitCode)}: ${resolved.stderr.trim() || resolved.stdout.trim() || "unknown error"}`,
        "Verify the host is reachable and credentials are valid.",
      );
    }
    return resolved;
  }

  /**
   * Fetch the host key(s) currently presented by `profile.hostname:port` via
   * `ssh-keyscan`, and find the one whose SHA-256 hex fingerprint matches the
   * pinned {@link SshProfile.knownHostKey}. Returns the matching known_hosts
   * line (verbatim, for reuse as the connection's pinned known_hosts entry).
   *
   * A bare content-hash fingerprint cannot be handed to OpenSSH's own
   * `KnownHostsCommand`/known_hosts machinery — that mechanism compares full
   * key material, not a hash of it. Verification therefore happens at the
   * application level: fetch the presented key(s), hash each, and only trust
   * the one that matches the pin (fail-closed: no match is a rejection).
   */
  async function verifyHostKey(): Promise<string> {
    const keyscanArgs = [
      "-p",
      String(profile.port),
      "-T",
      String(Math.max(1, Math.floor(timeoutMs / 1000))),
      profile.hostname,
    ];
    const result =
      injectedKeyscanRunner !== undefined
        ? await injectedKeyscanRunner(keyscanArgs)
        : await runKeyscanBounded(keyscanArgs, timeoutMs, signal);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    for (const line of lines) {
      const parts = line.split(/\s+/u);
      const base64Key = parts[2];
      if (base64Key === undefined) {
        continue;
      }
      let raw: Buffer;
      try {
        raw = Buffer.from(base64Key, "base64");
      } catch {
        continue;
      }
      const fingerprint = createHash("sha256").update(raw).digest("hex");
      if (fingerprint === profile.knownHostKey) {
        return line;
      }
    }
    throw sshError(
      "host_key_mismatch",
      `no host key presented by ${profile.hostname}:${String(profile.port)} matches the pinned fingerprint for '${profile.alias}'`,
      "Verify the host's identity out-of-band before trusting a new key. If the change is expected (host rebuild, key rotation), update the pinned knownHostKey.",
    );
  }

  function connect(): Promise<void> {
    return serialized(async () => {
      state = "connecting";
      let knownHostsDir: string | undefined;
      try {
        // 1. Verify the presented host key against the pinned fingerprint
        // BEFORE any ControlMaster handshake (fail-closed on mismatch).
        const knownHostsLine = await verifyHostKey();
        knownHostsDir = await mkdtemp(join(tmpdir(), "minions-ssh-known-hosts-"));
        const knownHostsFile = join(knownHostsDir, "known_hosts");
        await writeFile(knownHostsFile, `${knownHostsLine}\n`, { mode: 0o600 });

        // 2. Establish the ControlMaster connection pinned to the just-verified key.
        await run([
          "-o",
          `ControlMaster=yes`,
          "-o",
          `ControlPath=${profile.controlMasterPath}`,
          "-o",
          `ControlPersist=300`,
          "-o",
          `StrictHostKeyChecking=yes`,
          "-o",
          `UserKnownHostsFile=${knownHostsFile}`,
          "-o",
          `ConnectTimeout=${String(Math.floor(timeoutMs / 1000))}`,
          "-fN", // background, no command
          "-L",
          `${String(profile.localForwardPort)}:127.0.0.1:${String(profile.localForwardPort)}`,
          "-p",
          String(profile.port),
          `${profile.user}@${profile.hostname}`,
        ]);
        state = "connected";

        // 3. Exchange version strings over the tunnel just established (PR 53 — version
        // skew policy) and reject fail-closed on incompatibility, tearing the ControlMaster
        // back down rather than leaving a live but untrusted-version connection up.
        const hostVersion = await queryHostVersion(profile.localForwardPort);
        const verdict = checkVersionSkew(supervisorVersion, hostVersion);
        if (!verdict.compatible) {
          await teardownControlMaster();
          state = "error";
          throw sshError(
            "version_skew",
            `SSH connection to ${profile.alias} rejected: ${verdict.reason ?? "incompatible versions"}`,
            "Upgrade the supervisor or the remote host so their major versions match, then retry.",
          );
        }
      } catch (error: unknown) {
        state = "error";
        if (
          error instanceof SshAdapterError &&
          (error.code === "host_key_mismatch" || error.code === "version_skew")
        ) {
          throw error;
        }
        throw sshError(
          "connection_failed",
          `SSH connection to ${profile.alias} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "Verify the host is reachable, credentials are valid, and the host key matches.",
          error,
        );
      } finally {
        // The known_hosts pin is only needed for this one handshake; ControlMaster
        // reuse (`-O check` / `-O exit`) never re-verifies the host key.
        if (knownHostsDir !== undefined) {
          await rm(knownHostsDir, { recursive: true, force: true });
        }
      }
    });
  }

  /** Best-effort `-O exit` teardown of the ControlMaster socket. Never throws. */
  async function teardownControlMaster(): Promise<void> {
    try {
      await run([
        "-o",
        `ControlPath=${profile.controlMasterPath}`,
        "-O",
        "exit",
        `${profile.user}@${profile.hostname}`,
      ]);
    } catch {
      // Best-effort teardown — the ControlPersist timeout will clean up regardless.
    }
  }

  function checkHealth(): Promise<boolean> {
    return serialized(async () => {
      if (state !== "connected") return false;
      try {
        const result = await run([
          "-o",
          `ControlPath=${profile.controlMasterPath}`,
          "-O",
          "check",
          `${profile.user}@${profile.hostname}`,
        ]);
        return result.exitCode === 0;
      } catch {
        return false;
      }
    });
  }

  function disconnect(): Promise<void> {
    return serialized(async () => {
      if (state === "disconnected") return;
      await teardownControlMaster();
      state = "disconnected";
    });
  }

  return Object.freeze({
    get state() {
      return state;
    },
    get localForwardPort() {
      return profile.localForwardPort;
    },
    connect,
    checkHealth,
    disconnect,
  });
}

// -------------------------------------------------------------------------------------------------
// Version exchange.
// -------------------------------------------------------------------------------------------------

/**
 * Query the remote host's server version via `GetServerInfo` over the tunnel's forwarded
 * local port (`127.0.0.1:localForwardPort`, the "remote daemon's loopback Connect API"
 * this adapter forwards to). A lightweight, read-only, non-application-data call — the
 * kind of "service command" this adapter's own bootstrap/service boundary permits.
 */
async function defaultQueryHostVersion(localForwardPort: number): Promise<string> {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${String(localForwardPort)}`,
    httpVersion: "1.1",
    useBinaryFormat: true,
  });
  const client = createClient(SystemService, transport);
  const response = await client.getServerInfo({
    clientName: "minions-ssh-adapter",
    apiVersion: create(ApiVersionSchema, { major: 1 }),
  });
  return response.serverVersion;
}

// -------------------------------------------------------------------------------------------------
// Bounded subprocess runner.
// -------------------------------------------------------------------------------------------------

function runSshBounded(
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SshRunResult> {
  return spawnBounded("ssh", args, timeoutMs, signal);
}

function runKeyscanBounded(
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SshRunResult> {
  return spawnBounded("ssh-keyscan", args, timeoutMs, signal);
}

function spawnBounded(
  binary: "ssh" | "ssh-keyscan",
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        sshError(
          "timeout",
          `${binary} ${args.join(" ")} timed out after ${String(timeoutMs)}ms`,
          "Increase the timeout or check network connectivity.",
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(
        sshError(
          "ssh_unavailable",
          `${binary} binary not found or failed to start: ${error.message}`,
          "Ensure OpenSSH is installed and on PATH.",
          error,
        ),
      );
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function sshError(
  code: SshErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): SshAdapterError {
  return new SshAdapterError(code, message, remediation, cause);
}
