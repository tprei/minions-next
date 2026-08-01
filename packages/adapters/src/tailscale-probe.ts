/**
 * Tailscale capability probe adapter (PR 57 — private-phone-pairing).
 *
 * Queries the real, locally running `tailscaled` via `tailscale status --json` —
 * read-only, never mutates tailnet state, never issues a certificate, never touches
 * any other device. Fail-closed: any error (binary missing, daemon not running,
 * malformed output) reports `connected: false`, never throws.
 */

import { spawn } from "node:child_process";

import type { TailscaleCapability } from "@minions/core";

export type TailscaleCommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

/** Run a shell command. Test seam — production spawns the real `tailscale` binary. */
export type TailscaleCommandRunner = (args: readonly string[]) => Promise<TailscaleCommandResult>;

export type TailscaleProbeOptions = Readonly<{
  tailscalePath?: string;
  runCommand?: TailscaleCommandRunner;
}>;

export interface TailscaleProbe {
  checkCapability(): Promise<TailscaleCapability>;
}

const DEFAULT_TAILSCALE = "tailscale";
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 65_536;

/** The `Self` field of `tailscale status --json`'s output, narrowed to what's used. */
type TailscaleStatusJson = Readonly<{
  BackendState?: unknown;
  CertDomains?: unknown;
  Self?: Readonly<{ DNSName?: unknown; Online?: unknown }>;
}>;

const notConnected: TailscaleCapability = Object.freeze({
  connected: false,
  tailnetHostname: undefined,
  httpsCapable: false,
  certDomain: undefined,
});

export function createTailscaleProbe(options: TailscaleProbeOptions = {}): TailscaleProbe {
  const tailscalePath = options.tailscalePath ?? DEFAULT_TAILSCALE;
  const injectedRunner = options.runCommand;

  async function runCommand(args: readonly string[]): Promise<TailscaleCommandResult> {
    if (injectedRunner !== undefined) return injectedRunner(args);
    return runBounded(args);
  }

  async function checkCapability(): Promise<TailscaleCapability> {
    let result: TailscaleCommandResult;
    try {
      result = await runCommand([tailscalePath, "status", "--json"]);
    } catch {
      return notConnected;
    }
    if (result.exitCode !== 0) {
      return notConnected;
    }
    let parsed: TailscaleStatusJson;
    try {
      parsed = JSON.parse(result.stdout) as TailscaleStatusJson;
    } catch {
      return notConnected;
    }
    if (parsed.BackendState !== "Running" || parsed.Self?.Online !== true) {
      return notConnected;
    }
    // Tailscale reports the DNS name with a trailing dot (the FQDN root label).
    const rawHostname = typeof parsed.Self.DNSName === "string" ? parsed.Self.DNSName : undefined;
    const tailnetHostname = rawHostname?.endsWith(".") ? rawHostname.slice(0, -1) : rawHostname;
    const certDomains = Array.isArray(parsed.CertDomains)
      ? parsed.CertDomains.filter((entry): entry is string => typeof entry === "string")
      : [];
    const certDomain = certDomains[0];
    return Object.freeze({
      connected: true,
      tailnetHostname,
      httpsCapable: certDomain !== undefined,
      certDomain,
    });
  }

  return Object.freeze({ checkCapability });
}

function runBounded(args: readonly string[]): Promise<TailscaleCommandResult> {
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
