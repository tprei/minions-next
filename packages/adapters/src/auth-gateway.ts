/**
 * OMP auth-gateway manager (PR 19). Drives `omp auth-gateway serve / token /
 * status` as a supervised subprocess and is the ONLY surface through which a
 * harness obtains provider access. The gateway runs in front of an authenticated
 * broker and proxies provider requests; refresh/access credentials never leave the
 * broker↔gateway boundary.
 *
 * ## SEC-06 capability model
 * `issueAttemptCapability(attemptId)` returns a SHORT-LIVED, attempt-scoped record
 * containing only the gateway endpoint and the current gateway bearer — that is
 * the entire capability surface a harness ever sees. The capability is revocable:
 * `revokeAttemptCapability(attemptId)` removes the attempt from the live set and,
 * when no other attempt is live, rotates the gateway bearer via
 * `omp auth-gateway token --regenerate`. The previous bearer is invalidated, so
 * an attacker (or a stale harness) holding a revoked bearer cannot reach the
 * provider. The control broker bearer is never handed out.
 *
 * ## Confinement ceiling: shared gateway bearer (F1)
 * OMP mints ONE gateway bearer per running gateway; concurrent live attempts
 * therefore SHARE it for the duration of their overlap. Revoking a single
 * attempt while others remain live CANNOT invalidate that attempt's view of the
 * bearer without invalidating every other live attempt — the bearer is only
 * rotated when the LAST live attempt is revoked. Per-attempt invalidation
 * requires a future OMP per-attempt-token API and is tracked as a follow-up.
 * If that final rotation fails, `revokeAttemptCapability` rejects with
 * `revocation_failed` so callers know the capability is still live (fail-closed)
 * rather than observing a silent success.
 *
 * ## Empirical deviations from --help (documented for reviewers)
 * - `omp auth-gateway serve` emits plaintext log lines (NOT JSON, even with
 *   `--json`); readiness is therefore verified by polling `status --json`, which
 *   returns `{"ready":true,...,"brokerAuthenticated":true}` once the gateway has
 *   authenticated to its upstream broker.
 * - `omp auth-gateway token --regenerate` rotates the gateway bearer; subsequent
 *   `status` calls still report `tokenPresent:true` but the value differs. We
 *   re-read after each rotate.
 */

import { spawn, type ChildProcess } from "node:child_process";

import {
  AuthBrokerError,
  parseJsonObject,
  reserveLoopbackPort,
  runOmp,
  runOmpJson,
} from "./auth-broker.js";
import { redactSecrets } from "./secret-redaction.js";

export type AuthGatewayErrorCode =
  | "invalid_configuration"
  | "spawn_failed"
  | "not_running"
  | "already_running"
  | "broker_unconfigured"
  | "status_unhealthy"
  | "command_failed"
  | "capability_unknown"
  | "capability_active"
  | "revocation_failed";

export class AuthGatewayError extends Error {
  readonly code: AuthGatewayErrorCode;

  constructor(code: AuthGatewayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthGatewayError";
    this.code = code;
  }
}

export type AuthGatewayHealth = Readonly<{
  ready: boolean;
  reason?: string;
  brokerConfigured?: boolean;
  brokerAuthenticated?: boolean;
  credentialCount?: number;
}>;

export type AttemptCapability = Readonly<{
  attemptId: string;
  /** Loopback gateway endpoint harnesses call. */
  endpoint: string;
  /** Short-lived gateway bearer — the ONLY secret a harness receives. */
  bearer: string;
  issuedAtMs: number;
}>;

export type AuthGatewayLogger = Pick<Console, "log" | "error" | "warn">;

export type AuthGatewayManagerOptions = Readonly<{
  /** Absolute path to the `omp` executable. */
  ompPath: string;
  /** Upstream broker URL (loopback). */
  brokerEndpoint: string;
  /** Upstream broker control bearer — used to authenticate the gateway to the broker. */
  brokerControlToken: string;
  /** Bind host (default 127.0.0.1). */
  bindHost?: string;
  /** Bind port (default 0 → ephemeral, reserved via probe socket). */
  bindPort?: number;
  /** Readiness timeout (ms; default 15_000). */
  readinessTimeoutMs?: number;
  /** Readiness poll interval (ms; default 200). */
  readinessPollIntervalMs?: number;
  /** Disable inbound bearer-token auth on the gateway (loopback-only; default false). */
  noAuth?: boolean;
  /** Logger sink; secret values are never logged. */
  logger?: AuthGatewayLogger;
  /** Extra environment variables merged into the spawned gateway env. */
  extraEnv?: Readonly<Record<string, string>>;
}>;

export interface AuthGatewayManager {
  /** Spawn the gateway and authenticate it to the upstream broker. */
  start(): Promise<void>;
  /** Terminate the gateway process group. Idempotent. */
  stop(): Promise<void>;
  /**
   * Best-effort SYNCHRONOUS hard-kill of the gateway process group. Intended for
   * `process.on("exit", …)` cleanup where async `stop()` cannot complete; safe to
   * call when not running.
   */
  killSync(): void;
  /** `omp auth-gateway status --json` → typed result. */
  health(): Promise<AuthGatewayHealth>;
  /** Issue (or return the cached) short-lived attempt capability. */
  issueAttemptCapability(attemptId: string): Promise<AttemptCapability>;
  /** Revoke a previously-issued capability; rotates the gateway bearer when the
   *  live set becomes empty. */
  revokeAttemptCapability(attemptId: string): Promise<void>;
  /** Number of currently-live attempt capabilities. */
  readonly liveAttemptCount: number;
  /** Loopback gateway URL once `start()` has completed. */
  readonly endpoint: string | undefined;
  /** Whether the gateway is currently running. */
  readonly running: boolean;
}

const defaultBindHost = "127.0.0.1";
const defaultReadinessTimeoutMs = 15_000;
const defaultReadinessPollIntervalMs = 200;
const stderrLimitBytes = 1_048_576;

export function createAuthGatewayManager(options: AuthGatewayManagerOptions): AuthGatewayManager {
  return new AuthGatewayManagerImpl(options);
}

class AuthGatewayManagerImpl implements AuthGatewayManager {
  private child: ChildProcess | undefined;
  private port: number | undefined;
  private gatewayToken: string | undefined;
  private readonly liveAttempts = new Map<string, number>();
  private readonly bindHost: string;
  private readonly bindPort: number;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollIntervalMs: number;
  private readonly noAuth: boolean;
  private stderrChunks: Uint8Array[] = [];
  private stderrBytes = 0;
  private stderrOverflowed = false;

  constructor(private readonly options: AuthGatewayManagerOptions) {
    this.bindHost = options.bindHost ?? defaultBindHost;
    this.bindPort = options.bindPort ?? 0;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? defaultReadinessTimeoutMs;
    this.readinessPollIntervalMs =
      options.readinessPollIntervalMs ?? defaultReadinessPollIntervalMs;
    this.noAuth = options.noAuth ?? false;
  }

  get endpoint(): string | undefined {
    if (this.port === undefined) return undefined;
    return `http://${this.bindHost}:${String(this.port)}`;
  }

  get running(): boolean {
    return this.child?.exitCode === null && !this.child.killed;
  }

  get liveAttemptCount(): number {
    return this.liveAttempts.size;
  }

  async start(): Promise<void> {
    if (this.child !== undefined) {
      throw new AuthGatewayError("already_running", "auth-gateway is already running");
    }
    this.port = this.bindPort === 0 ? await reserveLoopbackPort(this.bindHost) : this.bindPort;
    const endpoint = this.endpoint ?? "";
    const env = this.gatewayEnv();
    const child = spawnGateway(this.options.ompPath, this.bindHost, this.port, this.noAuth, env);
    this.child = child;
    this.resetStderr();
    child.stderr?.on("data", (chunk: unknown) => {
      this.captureStderr(chunk);
    });

    try {
      await this.waitForReadiness();
      this.gatewayToken = await this.readGatewayToken();
    } catch (error) {
      await this.killChild();
      if (error instanceof AuthGatewayError) throw error;
      throw new AuthGatewayError(
        "spawn_failed",
        `auth-gateway failed to start: ${errorToString(error)}`,
        { cause: error },
      );
    }
    void endpoint;
  }

  async stop(): Promise<void> {
    await this.killChild();
    this.port = undefined;
    this.gatewayToken = undefined;
    this.liveAttempts.clear();
  }

  killSync(): void {
    // Best-effort synchronous SIGKILL of the process group. `stop()` is async
    // and cannot run inside `process.on("exit", …)`; this is the hard-crash
    // fallback so the detached gateway does not orphan when the daemon dies.
    const child = this.child;
    if (child === undefined) return;
    const pid = child.pid;
    if (pid !== undefined) {
      signalProcessGroup(child, pid, "SIGKILL");
    }
  }

  async health(): Promise<AuthGatewayHealth> {
    if (this.endpoint === undefined) {
      return { ready: false, reason: "not_running" };
    }
    const env = this.gatewayEnv();
    const result = await runOmpJson(
      this.options.ompPath,
      ["auth-gateway", "status", "--json"],
      env,
    );
    return parseGatewayStatus(result);
  }

  issueAttemptCapability(attemptId: string): Promise<AttemptCapability> {
    // The validation + issuance is synchronous, but the public contract returns a
    // Promise so that failure paths reject (callers and tests rely on `.rejects`).
    // Wrapping via `.then` preserves throw→rejection semantics without a pointless
    // `await` (require-await) and without changing observable behavior.
    return Promise.resolve().then((): AttemptCapability => {
      if (typeof attemptId !== "string" || attemptId.length === 0) {
        throw new AuthGatewayError("invalid_configuration", "attemptId must be a non-empty string");
      }
      if (this.endpoint === undefined || this.gatewayToken === undefined) {
        throw new AuthGatewayError("not_running", "auth-gateway is not running");
      }
      if (this.liveAttempts.has(attemptId)) {
        throw new AuthGatewayError(
          "capability_active",
          `attempt capability already issued for ${attemptId}`,
        );
      }
      this.liveAttempts.set(attemptId, Date.now());
      return {
        attemptId,
        endpoint: this.endpoint,
        bearer: this.gatewayToken,
        issuedAtMs: this.liveAttempts.get(attemptId) ?? Date.now(),
      };
    });
  }

  async revokeAttemptCapability(attemptId: string): Promise<void> {
    if (!this.liveAttempts.has(attemptId)) {
      throw new AuthGatewayError(
        "capability_unknown",
        `no live attempt capability for ${attemptId}`,
      );
    }
    this.liveAttempts.delete(attemptId);
    // SEC-06 revocation: when the last live attempt ends, rotate the gateway bearer
    // so the previous capability value is invalidated. OMP mints a single bearer
    // per running gateway; we rotate when the live set becomes empty to avoid
    // disrupting concurrent in-flight attempts.
    if (this.liveAttempts.size === 0 && this.child !== undefined) {
      // F1 (HIGH): if the LAST live attempt is being revoked and the bearer
      // rotation fails, the prior capability is STILL live in omp. Fail closed
      // by rejecting — callers must learn the capability was not invalidated
      // rather than observing a silent success. While other attempts remain live
      // we keep the shared bearer (per-attempt invalidation would require an
      // OMP per-attempt-token API — see the module header).
      try {
        await this.rotateGatewayToken();
      } catch (error) {
        throw new AuthGatewayError(
          "revocation_failed",
          `failed to rotate gateway bearer during revocation of ${attemptId}: ${errorToString(error)}`,
          { cause: error },
        );
      }
    }
  }

  private async rotateGatewayToken(): Promise<void> {
    const env = this.gatewayEnv();
    const result = await runOmp(
      this.options.ompPath,
      ["auth-gateway", "token", "--regenerate", "--json"],
      env,
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.exitCode !== 0) {
      throw new AuthGatewayError(
        "command_failed",
        `omp auth-gateway token --regenerate exited with ${String(result.exitCode)}: ${this.redactForError(result.stderr).slice(0, 256).trim()}`,
      );
    }
    const parsed = parseJsonObject(result.stdout);
    const token = parsed?.["token"];
    if (typeof token !== "string" || token.length === 0) {
      throw new AuthGatewayError(
        "command_failed",
        `auth-gateway token regenerate response missing 'token' field`,
      );
    }
    this.gatewayToken = token;
  }

  private gatewayEnv(): Record<string, string> {
    return {
      ...process.env,
      OMP_AUTH_BROKER_URL: this.options.brokerEndpoint,
      OMP_AUTH_BROKER_TOKEN: this.options.brokerControlToken,
      ...this.options.extraEnv,
    };
  }

  private async waitForReadiness(): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    const child = this.child;
    if (child === undefined) {
      throw new AuthGatewayError("not_running", "auth-gateway child missing before readiness poll");
    }
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.killed) {
        throw new AuthGatewayError(
          "spawn_failed",
          `auth-gateway exited before readiness (code=${String(child.exitCode)})${this.stderrSummary()}`,
        );
      }
      // status can fail transiently (gateway not yet listening, broker handshake
      // in flight). Treat any error as "not ready yet" and keep polling until
      // the deadline; only `spawn_failed` (process exit) is fatal.
      try {
        const status = await this.health();
        if (status.ready && status.brokerConfigured && status.brokerAuthenticated) {
          return;
        }
      } catch (error) {
        if (error instanceof AuthBrokerError && error.code === "command_failed") {
          // keep polling
        } else if (error instanceof AuthGatewayError && error.code === "command_failed") {
          // keep polling
        } else {
          throw error;
        }
      }
      await delay(this.readinessPollIntervalMs);
    }
    throw new AuthGatewayError(
      "status_unhealthy",
      `auth-gateway did not become ready within ${String(this.readinessTimeoutMs)}ms${this.stderrSummary()}`,
    );
  }

  private async readGatewayToken(): Promise<string> {
    const env = this.gatewayEnv();
    const result = await runOmpJson(this.options.ompPath, ["auth-gateway", "token", "--json"], env);
    const parsed = parseJsonObject(result.stdout);
    const token = parsed?.["token"];
    if (typeof token !== "string" || token.length === 0) {
      throw new AuthGatewayError(
        "command_failed",
        `auth-gateway token response missing 'token' field: ${this.redactForError(result.stdout).slice(0, 256)}`,
      );
    }
    return token;
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
    return `\nstderr: ${this.redactForError(body).slice(0, 256).trim()}`;
  }

  /**
   * Redact captured omp child output before it reaches an exception message.
   * Passes the manager's known bearers (current gateway bearer + upstream
   * broker control token) so a literal leak in omp stdout/stderr is stripped in
   * addition to the default token shapes. Bounded length is enforced at the
   * call sites.
   */
  private redactForError(raw: string): string {
    const knownSecrets: string[] = [];
    if (this.gatewayToken !== undefined && this.gatewayToken.length > 0) {
      knownSecrets.push(this.gatewayToken);
    }
    if (this.options.brokerControlToken.length > 0) {
      knownSecrets.push(this.options.brokerControlToken);
    }
    return redactSecrets(raw, knownSecrets);
  }
}

function spawnGateway(
  ompPath: string,
  bindHost: string,
  bindPort: number,
  noAuth: boolean,
  env: Record<string, string>,
): ChildProcess {
  const args = ["auth-gateway", "serve", `--bind=${bindHost}:${String(bindPort)}`];
  if (noAuth) {
    args.push("--no-auth");
  }
  try {
    return spawn(ompPath, args, {
      cwd: process.cwd(),
      env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    throw new AuthGatewayError(
      "spawn_failed",
      `cannot spawn omp auth-gateway serve: ${errorToString(error)}`,
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

function parseGatewayStatus(result: Readonly<{ stdout: string }>): AuthGatewayHealth {
  const parsed = parseJsonObject(result.stdout);
  if (parsed === null) {
    return {
      ready: false,
      reason: `unparsable status: ${redactSecrets(result.stdout).slice(0, 256)}`,
    };
  }
  const ready = parsed["ready"];
  const reason = typeof parsed["reason"] === "string" ? parsed["reason"] : undefined;
  const brokerConfigured =
    typeof parsed["brokerConfigured"] === "boolean" ? parsed["brokerConfigured"] : undefined;
  const brokerAuthenticated =
    typeof parsed["brokerAuthenticated"] === "boolean" ? parsed["brokerAuthenticated"] : undefined;
  const credentialCount =
    typeof parsed["credentialCount"] === "number" ? parsed["credentialCount"] : undefined;
  if (typeof ready !== "boolean") {
    return {
      ready: false,
      reason: `status missing 'ready' boolean: ${redactSecrets(result.stdout).slice(0, 256)}`,
    };
  }
  return {
    ready,
    ...(reason !== undefined ? { reason } : {}),
    ...(brokerConfigured !== undefined ? { brokerConfigured } : {}),
    ...(brokerAuthenticated !== undefined ? { brokerAuthenticated } : {}),
    ...(credentialCount !== undefined ? { credentialCount } : {}),
  };
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
  if (error instanceof AuthBrokerError || error instanceof AuthGatewayError) {
    return error.message;
  }
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
