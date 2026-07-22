/**
 * OMP auth-broker manager (PR 19). Drives `omp auth-broker serve / token / status /
 * login / logout` as a supervised subprocess, persists the broker control bearer
 * into the per-host {@link CredentialVault}, and recovers it noninteractively
 * across process and machine restart.
 *
 * ## Lifecycle (PR 19, §10.5; PRD OPS-03 / acceptance 11)
 * 1. `start()` reserves a loopback port, probes the vault fail-closed, spawns
 *    `omp auth-broker serve --bind=127.0.0.1:<port>` as a detached process-group
 *    child, polls `status --json` to `ok:true`, then reads the control bearer via
 *    `token --json` and stores it in the vault. If the vault already holds a
 *    bearer (prior run) and the broker's current bearer differs, the manager
 *    fails closed (`recovery_failed`) — restart recovery must be transparent and
 *    unambiguous.
 * 2. `stop()` terminates the broker's process group.
 * 3. `login(provider)` drives the interactive `omp auth-broker login` flow
 *    (TTY-attached; requires real provider credentials — DEFERRED for synthetic).
 * 4. `revoke(provider)` calls `omp auth-broker logout <provider>`.
 *
 * Fail-closed paths: missing vault backend → `vault_unavailable`; broker exits
 * before readiness → `spawn_failed`; status never reaches `ok:true` within the
 * readiness window → `status_unhealthy`.
 *
 * Secrets: the control bearer is held only as a transient field on the manager
 * and is never logged. It leaves the boundary only via the vault (at-rest 0600)
 * and via the auth-gateway manager (which needs it to authenticate to the broker).
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer, type Server } from "node:http";

import {
  CredentialVaultError,
  type CredentialVault,
  type CredentialVaultProbeResult,
} from "./credential-vault.js";
import { redactSecrets } from "./secret-redaction.js";

export type AuthBrokerErrorCode =
  | "invalid_configuration"
  | "spawn_failed"
  | "not_running"
  | "already_running"
  | "vault_unavailable"
  | "status_unhealthy"
  | "command_failed"
  | "recovery_failed";

export class AuthBrokerError extends Error {
  readonly code: AuthBrokerErrorCode;

  constructor(code: AuthBrokerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthBrokerError";
    this.code = code;
  }
}

export type AuthBrokerHealth = Readonly<{
  ok: boolean;
  reason?: string;
  version?: string;
  url?: string;
}>;

export type AuthBrokerLoginOptions = Readonly<{
  /** SSH tunnel target (`user@host`) for `omp auth-broker login --via=user@host`. */
  via?: string;
}>;

export type AuthBrokerLogger = Pick<Console, "log" | "error" | "warn">;

export type AuthBrokerManagerOptions = Readonly<{
  /** Absolute path to the `omp` executable. */
  ompPath: string;
  /** Host identifier — scopes the vault namespace and credential names. */
  hostId: string;
  /** Per-host credential vault. The manager stores the control bearer under
   *  `auth-broker.token`. */
  vault: CredentialVault;
  /** Bind host (default 127.0.0.1). */
  bindHost?: string;
  /** Bind port (default 0 → ephemeral, reserved via probe socket). */
  bindPort?: number;
  /** Readiness timeout (ms; default 15_000). */
  readinessTimeoutMs?: number;
  /** Readiness poll interval (ms; default 200). */
  readinessPollIntervalMs?: number;
  /** Logger sink; secret values are never logged. */
  logger?: AuthBrokerLogger;
  /** Extra environment variables merged into the spawned broker env. */
  extraEnv?: Readonly<Record<string, string>>;
}>;

export interface AuthBrokerManager {
  /** Spawn the broker and persist its control bearer. Idempotent. */
  start(): Promise<void>;
  /** Terminate the broker process group. Idempotent. */
  stop(): Promise<void>;
  /**
   * Best-effort SYNCHRONOUS hard-kill of the broker process group. Intended for
   * `process.on("exit", …)` cleanup where async `stop()` cannot complete; safe to
   * call when not running.
   */
  killSync(): void;
  /** `omp auth-broker status --json` → typed result. */
  health(): Promise<AuthBrokerHealth>;
  /** Interactive `omp auth-broker login <provider>` (TTY-attached). */
  login(provider: string, options?: AuthBrokerLoginOptions): Promise<void>;
  /** `omp auth-broker logout <provider>`. */
  revoke(provider: string): Promise<void>;
  /** Vault probe — never throws. */
  probeVault(): CredentialVaultProbeResult;
  /** Loopback broker URL once `start()` has completed. */
  readonly endpoint: string | undefined;
  /** Whether the broker is currently running. */
  readonly running: boolean;
}

const controlBearerSecretName = "auth-broker.token";
const defaultBindHost = "127.0.0.1";
const defaultReadinessTimeoutMs = 15_000;
const defaultReadinessPollIntervalMs = 200;
const stderrLimitBytes = 1_048_576;

export function createAuthBrokerManager(options: AuthBrokerManagerOptions): AuthBrokerManager {
  return new AuthBrokerManagerImpl(options);
}

class AuthBrokerManagerImpl implements AuthBrokerManager {
  private child: ChildProcess | undefined;
  private port: number | undefined;
  private readonly bindHost: string;
  private readonly bindPort: number;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollIntervalMs: number;
  private stderrChunks: Uint8Array[] = [];
  private stderrBytes = 0;
  private stderrOverflowed = false;

  constructor(private readonly options: AuthBrokerManagerOptions) {
    this.bindHost = options.bindHost ?? defaultBindHost;
    this.bindPort = options.bindPort ?? 0;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? defaultReadinessTimeoutMs;
    this.readinessPollIntervalMs =
      options.readinessPollIntervalMs ?? defaultReadinessPollIntervalMs;
  }

  get endpoint(): string | undefined {
    if (this.port === undefined) return undefined;
    return `http://${this.bindHost}:${String(this.port)}`;
  }

  get running(): boolean {
    return this.child?.exitCode === null && !this.child.killed;
  }

  probeVault(): CredentialVaultProbeResult {
    return this.options.vault.probe();
  }

  async start(): Promise<void> {
    if (this.child !== undefined) {
      throw new AuthBrokerError("already_running", "auth-broker is already running");
    }
    const probe = this.options.vault.probe();
    if (!probe.available) {
      throw new AuthBrokerError(
        "vault_unavailable",
        `credential vault unavailable on ${probe.backend}: ${probe.detail}`,
      );
    }
    this.port = this.bindPort === 0 ? await reserveLoopbackPort(this.bindHost) : this.bindPort;
    const endpoint = `http://${this.bindHost}:${String(this.port)}`;
    const env = this.brokerEnv(endpoint);
    const child = spawnBroker(this.options.ompPath, this.bindHost, this.port, env);
    this.child = child;
    this.resetStderr();
    child.stderr?.on("data", (chunk: unknown) => {
      this.captureStderr(chunk);
    });

    try {
      await this.waitForReadiness(endpoint);
      const controlBearer = await this.readControlBearer(env);
      await this.persistControlBearerOrFail(controlBearer);
    } catch (error) {
      await this.killChild();
      if (error instanceof AuthBrokerError) throw error;
      throw new AuthBrokerError(
        "spawn_failed",
        `auth-broker failed to start: ${errorToString(error)}`,
        { cause: error },
      );
    }
  }

  async stop(): Promise<void> {
    await this.killChild();
    this.port = undefined;
  }

  killSync(): void {
    // Best-effort synchronous SIGKILL of the process group. `stop()` is async
    // and cannot run inside `process.on("exit", …)`; this is the hard-crash
    // fallback so the detached broker does not orphan when the daemon dies.
    const child = this.child;
    if (child === undefined) return;
    const pid = child.pid;
    if (pid !== undefined) {
      signalProcessGroup(child, pid, "SIGKILL");
    }
  }

  async health(): Promise<AuthBrokerHealth> {
    if (this.endpoint === undefined) {
      return { ok: false, reason: "not_running" };
    }
    const env = this.brokerEnv(this.endpoint);
    const result = await runOmpJson(this.options.ompPath, ["auth-broker", "status", "--json"], env);
    return parseBrokerStatus(result);
  }

  async login(provider: string, options: AuthBrokerLoginOptions = {}): Promise<void> {
    const endpoint = this.requireEndpoint();
    const env = this.brokerEnv(endpoint);
    const args = ["auth-broker", "login", provider];
    if (options.via !== undefined) {
      args.push(`--via=${options.via}`);
    }
    const result = await runOmp(this.options.ompPath, args, env, {
      stdio: "inherit", // interactive: pass the controlling TTY through.
    });
    if (result.exitCode !== 0) {
      throw new AuthBrokerError(
        "command_failed",
        `omp auth-broker login ${provider} exited with ${String(result.exitCode)}`,
      );
    }
    // Persist the (potentially rotated) control bearer after a successful login.
    const controlBearer = await this.readControlBearer(env);
    await this.persistControlBearerOrFail(controlBearer);
  }

  async revoke(provider: string): Promise<void> {
    const endpoint = this.requireEndpoint();
    const env = this.brokerEnv(endpoint);
    const result = await runOmp(this.options.ompPath, ["auth-broker", "logout", provider], env, {
      stdio: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new AuthBrokerError(
        "command_failed",
        `omp auth-broker logout ${provider} exited with ${String(result.exitCode)}`,
      );
    }
  }

  private requireEndpoint(): string {
    if (this.endpoint === undefined) {
      throw new AuthBrokerError("not_running", "auth-broker is not running");
    }
    return this.endpoint;
  }

  private brokerEnv(endpoint: string): Record<string, string> {
    return {
      ...process.env,
      OMP_AUTH_BROKER_URL: endpoint,
      ...this.options.extraEnv,
    };
  }

  private async waitForReadiness(endpoint: string): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    const child = this.child;
    if (child === undefined) {
      throw new AuthBrokerError("not_running", "auth-broker child missing before readiness poll");
    }
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.killed) {
        throw new AuthBrokerError(
          "spawn_failed",
          `auth-broker exited before readiness (code=${String(child.exitCode)})${this.stderrSummary()}`,
        );
      }
      // status can fail transiently (broker not yet listening, token file not yet
      // written). Treat any error as "not ready yet" and keep polling until the
      // deadline; only `spawn_failed` (process exit) is fatal.
      try {
        const status = await this.health();
        if (status.ok && status.url === endpoint) return;
      } catch (error) {
        if (error instanceof AuthBrokerError && error.code === "command_failed") {
          // keep polling
        } else {
          throw error;
        }
      }
      await delay(this.readinessPollIntervalMs);
    }
    throw new AuthBrokerError(
      "status_unhealthy",
      `auth-broker did not become ready within ${String(this.readinessTimeoutMs)}ms${this.stderrSummary()}`,
    );
  }

  private async readControlBearer(env: Record<string, string>): Promise<string> {
    const result = await runOmpJson(this.options.ompPath, ["auth-broker", "token", "--json"], env);
    const parsed = parseJsonObject(result.stdout);
    const token = parsed?.["token"];
    if (typeof token !== "string" || token.length === 0) {
      throw new AuthBrokerError(
        "command_failed",
        `auth-broker token response missing 'token' string field: ${redactSecrets(result.stdout).slice(0, 256)}`,
      );
    }
    return token;
  }

  private async persistControlBearerOrFail(controlBearer: string): Promise<void> {
    try {
      const priorBytes = await this.options.vault.get(controlBearerSecretName);
      const prior = new TextDecoder().decode(priorBytes);
      if (prior !== controlBearer) {
        // Token drift is a fail-closed integrity error: the broker's state diverged
        // from our durable record. Refuse to operate rather than silently re-stamping.
        throw new AuthBrokerError(
          "recovery_failed",
          "auth-broker control bearer does not match the vault record",
        );
      }
    } catch (error: unknown) {
      if (error instanceof CredentialVaultError) {
        if (error.code === "not_found") {
          await this.options.vault.put(
            controlBearerSecretName,
            new TextEncoder().encode(controlBearer),
          );
          return;
        }
        throw new AuthBrokerError(
          "vault_unavailable",
          `vault read failed during broker recovery: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    const pid = child.pid;
    try {
      child.stdin?.end();
    } catch {
      // process-group signal is the authoritative teardown
    }
    if (pid !== undefined) {
      signalProcessGroup(child, pid, "SIGTERM");
      const killTimer = setTimeout(() => {
        signalProcessGroup(child, pid, "SIGKILL");
      }, 1_000);
      killTimer.unref();
    }
    await childExitPromise(child).catch(() => undefined);
  }

  private captureStderr(chunk: unknown): void {
    const bytes = toBytes(chunk);
    if (this.stderrBytes + bytes.byteLength > stderrLimitBytes) {
      this.stderrOverflowed = true;
      return;
    }
    this.stderrBytes += bytes.byteLength;
    this.stderrChunks.push(bytes);
  }

  private resetStderr(): void {
    this.stderrChunks = [];
    this.stderrBytes = 0;
    this.stderrOverflowed = false;
  }

  private stderrSummary(): string {
    if (this.stderrBytes === 0 && !this.stderrOverflowed) return "";
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
      concatenate(this.stderrChunks),
    );
    const body = this.stderrOverflowed
      ? `${decoded}\n[stderr truncated at ${String(stderrLimitBytes)} bytes]`
      : decoded;
    // omp child stderr may echo a bearer (e.g. on a failed command that logged
    // the auth header). Redact known token shapes before the summary reaches an
    // exception message; the broker manager does not retain the control bearer,
    // so we rely on the default shapes plus the bounded length below.
    return `\nstderr: ${redactSecrets(body).slice(0, 256).trim()}`;
  }
}

// -------------------------------------------------------------------------------------------------
// Subprocess + JSON helpers (shared with the gateway manager).
// -------------------------------------------------------------------------------------------------

export type OmpJsonResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

type RawOmpResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

/** Run `omp` with stdio captured; resolves with exit code and captured output. */
export async function runOmp(
  ompPath: string,
  args: readonly string[],
  env: Record<string, string>,
  spawnOptions: Pick<SpawnOptions, "stdio">,
): Promise<RawOmpResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RawOmpResult>();
  const child = spawn(ompPath, [...args], { env, shell: false, ...spawnOptions });
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  child.once("error", (error: unknown) => {
    reject(
      new AuthBrokerError(
        "spawn_failed",
        `failed to spawn ${ompPath} ${args.join(" ")}: ${errorToString(error)}`,
        { cause: error },
      ),
    );
  });
  if (child.stdout !== null) {
    child.stdout.on("data", (chunk: Uint8Array) => stdoutChunks.push(new Uint8Array(chunk)));
  }
  if (child.stderr !== null) {
    child.stderr.on("data", (chunk: Uint8Array) => stderrChunks.push(new Uint8Array(chunk)));
  }
  child.once("close", (code: number | null) => {
    resolve({
      exitCode: code ?? -1,
      stdout: new TextDecoder("utf-8", { fatal: false }).decode(concatenate(stdoutChunks)),
      stderr: new TextDecoder("utf-8", { fatal: false }).decode(concatenate(stderrChunks)),
    });
  });
  return promise;
}

/** Run `omp` requiring a 0 exit; throws `command_failed` (broker) on nonzero. */
export async function runOmpJson(
  ompPath: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<OmpJsonResult> {
  const result = await runOmp(ompPath, args, env, { stdio: ["ignore", "pipe", "pipe"] });
  if (result.exitCode !== 0) {
    // omp child stderr may echo a bearer (failed commands sometimes log the
    // auth header). Redact known token shapes + bound the length so a leaked
    // secret can never reach an exception message.
    const stderr = redactSecrets(result.stderr).slice(0, 256).trim();
    throw new AuthBrokerError(
      "command_failed",
      `omp ${args.join(" ")} exited with ${String(result.exitCode)}${stderr.length > 0 ? `: ${stderr}` : ""}`,
    );
  }
  return result;
}

function spawnBroker(
  ompPath: string,
  bindHost: string,
  bindPort: number,
  env: Record<string, string>,
): ChildProcess {
  try {
    return spawn(ompPath, ["auth-broker", "serve", `--bind=${bindHost}:${String(bindPort)}`], {
      cwd: process.cwd(),
      env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    throw new AuthBrokerError(
      "spawn_failed",
      `cannot spawn omp auth-broker serve: ${errorToString(error)}`,
      { cause: error },
    );
  }
}

function childExitPromise(
  child: ChildProcess,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  const { promise, resolve } = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  child.once("close", (code, signal) => {
    resolve({ code, signal });
  });
  return promise;
}
function parseBrokerStatus(result: OmpJsonResult): AuthBrokerHealth {
  const parsed = parseJsonObject(result.stdout);
  if (parsed === null) {
    return {
      ok: false,
      reason: `unparsable status: ${redactSecrets(result.stdout).slice(0, 256)}`,
    };
  }
  const ok = parsed["ok"];
  const reason = typeof parsed["reason"] === "string" ? parsed["reason"] : undefined;
  const version = typeof parsed["version"] === "string" ? parsed["version"] : undefined;
  const url = typeof parsed["url"] === "string" ? parsed["url"] : undefined;
  if (typeof ok !== "boolean") {
    return {
      ok: false,
      reason: `status missing 'ok' boolean: ${redactSecrets(result.stdout).slice(0, 256)}`,
    };
  }
  return {
    ok,
    ...(reason !== undefined ? { reason } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (groupError: unknown) {
    if (!(isErrorWithCode(groupError) && groupError.code === "ESRCH")) {
      try {
        child.kill(signal);
      } catch {
        // best-effort
      }
    }
  }
}

export async function reserveLoopbackPort(host: string): Promise<number> {
  const server: Server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const onError = (error: Error): void => {
    reject(error);
  };
  server.once("error", onError);
  server.listen(0, host, () => {
    server.off("error", onError);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : undefined;
    if (typeof port !== "number") {
      reject(new AuthBrokerError("invalid_configuration", `could not reserve port on ${host}`));
      return;
    }
    server.close(() => {
      resolve(port);
    });
  });
  return promise;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, milliseconds);
    timer.unref();
  });
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array();
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isErrorWithCode(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
