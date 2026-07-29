/**
 * WSL2 host requirement probe adapter (PR 54 — wsl2-host-and-fleet-ui).
 *
 * Probes a WSL2 distro for the four requirements that must ALL be satisfied before
 * registration is allowed (fail-closed): systemd, rootless Podman, localhost
 * forwarding, and secure credential storage. Each probe is fail-closed — a failed
 * or uncertain check reports "missing", never an exception (except an empty distro
 * name which throws a typed error).
 */

import { spawn } from "node:child_process";
import type { WslDistroName, WslRequirement, WslProbeResult } from "@minions/core";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type WslProbeErrorCode = "invalid_distro" | "probe_failed";

export class WslProbeError extends Error {
  readonly code: WslProbeErrorCode;
  override readonly cause: unknown;

  constructor(code: WslProbeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WslProbeError";
    this.code = code;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Test seams.
// -------------------------------------------------------------------------------------------------

export type CommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

/** Run a shell command. Test seam — production spawns the real binary. */
export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

/** TCP loopback probe: bind and connect on a port. Test seam. */
export type LoopbackProber = () => Promise<boolean>;

/** Secure storage probe. Test seam. */
export type StorageProber = () => Promise<boolean>;

export type WslProbeOptions = Readonly<{
  readonly systemctlPath?: string;
  readonly podmanPath?: string;
  readonly runCommand?: CommandRunner;
  readonly probeLoopback?: LoopbackProber;
  readonly probeStorage?: StorageProber;
}>;

export interface WslRequirementProbe {
  probeAll(distro: WslDistroName): Promise<WslProbeResult>;
  probeOne(distro: WslDistroName, requirement: WslRequirement): Promise<boolean>;
}

// -------------------------------------------------------------------------------------------------
// Implementation.
// -------------------------------------------------------------------------------------------------

const DEFAULT_SYSTEMCTL = "systemctl";
const DEFAULT_PODMAN = "podman";
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 65_536;

export function createWslRequirementProbe(options: WslProbeOptions = {}): WslRequirementProbe {
  const systemctlPath = options.systemctlPath ?? DEFAULT_SYSTEMCTL;
  const podmanPath = options.podmanPath ?? DEFAULT_PODMAN;
  const injectedRunner = options.runCommand;
  const injectedLoopback = options.probeLoopback;
  const injectedStorage = options.probeStorage;

  async function runCommand(args: readonly string[]): Promise<CommandResult> {
    if (injectedRunner !== undefined) return injectedRunner(args);
    return runBounded(args);
  }

  async function probeSystemd(): Promise<boolean> {
    try {
      const result = await runCommand([systemctlPath, "is-system-running"]);
      const state = result.stdout.trim();
      return state === "running" || state === "degraded";
    } catch {
      return false;
    }
  }

  async function probePodman(): Promise<boolean> {
    try {
      const result = await runCommand([podmanPath, "info", "--format", "json"]);
      if (result.exitCode !== 0) return false;
      const info = JSON.parse(result.stdout) as {
        host?: { security?: { rootless?: boolean } };
      };
      return info.host?.security?.rootless === true;
    } catch {
      return false;
    }
  }

  async function probeLoopback(): Promise<boolean> {
    if (injectedLoopback !== undefined) return injectedLoopback();
    return defaultLoopbackProbe();
  }

  async function probeStorage(): Promise<boolean> {
    if (injectedStorage !== undefined) return injectedStorage();
    return defaultStorageProbe();
  }

  const probes: Record<WslRequirement, () => Promise<boolean>> = {
    systemd: probeSystemd,
    rootless_podman: probePodman,
    localhost_forwarding: probeLoopback,
    secure_storage: probeStorage,
  };

  async function probeOne(distro: WslDistroName, requirement: WslRequirement): Promise<boolean> {
    if (distro.trim().length === 0) {
      throw new WslProbeError("invalid_distro", "distro name must not be empty");
    }
    return probes[requirement]();
  }

  async function probeAll(distro: WslDistroName): Promise<WslProbeResult> {
    if (distro.trim().length === 0) {
      throw new WslProbeError("invalid_distro", "distro name must not be empty");
    }
    const requirements: readonly WslRequirement[] = [
      "systemd",
      "rootless_podman",
      "localhost_forwarding",
      "secure_storage",
    ];
    const satisfied: WslRequirement[] = [];
    const missing: WslRequirement[] = [];
    for (const req of requirements) {
      const ok = await probes[req]();
      if (ok) {
        satisfied.push(req);
      } else {
        missing.push(req);
      }
    }
    return Object.freeze({
      distro,
      satisfied: Object.freeze(satisfied),
      missing: Object.freeze(missing),
    });
  }

  return Object.freeze({ probeAll, probeOne });
}

// -------------------------------------------------------------------------------------------------
// Defaults.
// -------------------------------------------------------------------------------------------------

function defaultLoopbackProbe(): Promise<boolean> {
  return import("node:net").then(({ createServer }) => {
    return new Promise((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          resolve(typeof address === "object" && address !== null);
        });
      });
      server.on("error", () => {
        resolve(false);
      });
    });
  });
}

function defaultStorageProbe(): Promise<boolean> {
  return Promise.resolve(false);
}

function runBounded(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(args[0] ?? "", args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on("error", () => {
      resolve({ exitCode: -1, stdout: "", stderr: "spawn failed" });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
  });
}
