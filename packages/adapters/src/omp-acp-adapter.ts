/**
 * OMP ACP harness adapter — drives `omp acp` (Agent Client Protocol) sessions through
 * the Minions {@link HarnessAdapter} / {@link HarnessSession} contract.
 *
 * ## Protocol decision (authoritative)
 * The PR 18 spec says "run OMP RPC sessions through the harness contract". OMP exposes two
 * stdio surfaces:
 *  1. `omp --mode=rpc` — emits a UI-decoupling event stream (`ready`, `extension_ui_request`,
 *     `available_commands_update`, `setWidget`). It carries NO agent-session semantics
 *     (no prompt/message/tool/usage) and cannot satisfy the harness contract.
 *  2. `omp acp` — Agent Client Protocol (zed-industries/agent-client-protocol): a documented
 *     JSON-RPC 2.0 over stdio standard carrying agent-session semantics
 *     (`initialize` / `session/new` / `session/load` / `session/prompt` / `session/close`
 *     plus `session/update` and `message/part` notifications). This maps cleanly to the harness
 *     contract.
 *
 * This adapter uses `omp acp` — the faithful interpretation. The pinned version is read from
 * `result.agentInfo.version` of the ACP `initialize` response (confirmed `17.0.4`) and verified
 * fail-closed before any session binding.
 *
 * Verified against the installed `omp acp` 17.0.4: `initialize` + `authenticate` (methodId
 * `"agent"`) + `session/new` / `session/load` / `session/close` all succeed WITHOUT provider
 * model auth; only `session/prompt` (the model call) is auth-gated and is deferred to the
 * `synthetic:omp-rpc` runner.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  contentHash,
  DomainError,
  requireHarnessCapabilities,
  timestampFromEpochMilliseconds,
  type ContentHash,
  type HarnessAdapter,
  type HarnessCapability,
  type HarnessEvent,
  type HarnessEventPayload,
  type HarnessHandshake,
  type HarnessSession,
  type HarnessSessionIdentity,
  type HarnessSessionSnapshot,
  type HarnessUsage,
  type JsonValue,
  type ResumeHarnessSessionRequest,
  type StartHarnessSessionRequest,
  type Timestamp,
} from "@minions/core";

export type OmpAcpAdapterErrorCode =
  | "invalid_configuration"
  | "capability_unavailable"
  | "version_mismatch"
  | "capability_missing"
  | "spawn_failed"
  | "frame_invalid"
  | "session_conflict"
  | "session_not_found"
  | "protocol_error"
  | "command_failed"
  | "filesystem_error";

export class OmpAcpAdapterError extends Error {
  readonly code: OmpAcpAdapterErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: OmpAcpAdapterErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OmpAcpAdapterError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

/**
 * Resolve the `omp` binary path. Honors `OMP_PATH` (test/diagnostic override); otherwise
 * probes the standard install locations. Throws {@link OmpAcpAdapterError}
 * (`invalid_configuration`) when no usable binary is found — callers are fail-closed on a
 * missing OMP runtime (mirrors the CLI's `auth-login`/`auth-status` resolution in
 * apps/cli/src/index.ts). Shared by the daemon's PR 19 host-mode auth-broker wiring
 * (defaultRuntimeOptions in apps/daemon/src/runtime.ts): a host daemon with no OMP
 * available cannot run any harness safely, so resolution failure must fail closed rather
 * than silently skip the auth broker (acceptance 11: missing secure credential storage
 * fails host registration).
 */
export function resolveOmpPath(): string {
  const fromEnv = process.env["OMP_PATH"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const candidates = ["/usr/local/bin/omp", "/usr/bin/omp", `${homedir()}/.local/bin/omp`];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new OmpAcpAdapterError(
    "invalid_configuration",
    "omp binary not found; install the pinned OMP runtime or set OMP_PATH",
    "Install the pinned OMP runtime and rerun host setup, or set OMP_PATH to its absolute path.",
  );
}

export type OmpAcpAdapterOptions = Readonly<{
  /** Absolute path to the `omp` executable. */
  ompPath: string;
  /** Required `agentInfo.version` (e.g. `"17.0.4"`); mismatch fails closed before any session. */
  expectedVersion: string;
  /** Working directory passed to `session/new` / `session/load` and the spawned process. */
  cwd: string;
  /** Node-local protected directory (created 0o700) for the durable-session manifest. */
  sessionDirectory: string;
  /** Override model id reported in the handshake; otherwise the server default is used. */
  model?: string;
  /** Override reasoning level reported in the handshake; otherwise the server default is used. */
  reasoningLevel?: string;
  /** Exact tool allowlist passed to `session/new`. Subagent-spawning tools are rejected here. */
  allowedTools: readonly string[];
  /** Security policy digest reported in the handshake. */
  securityPolicyDigest: ContentHash;
  /** Capabilities the caller requires; feature-detected at handshake, fail-closed if missing. */
  requiredCapabilities: readonly HarnessCapability[];
}>;

const harnessKind = "omp-acp";
const requestTimeoutMs = 30_000;
const stderrLimitBytes = 1_048_576;
const sessionDirectoryMode = 0o700;
const manifestFileMode = 0o600;
const maxStdoutBufferBytes = 4 * 1024 * 1024;
const versionPattern = /^\d+\.\d+\.\d+$/u;
const contentHashPattern = /^[0-9a-f]{64}$/u;
const manifestSchemaVersion = 1;

/**
 * Tool names that would let the managed OMP agent spawn subagents or bypass the sandbox / Git
 * broker. They are refused in the allowlist so `session/new` can never enable subagent spawning
 * (HAR-04). The allowlist passed to `session/new` is exactly
 * {@link OmpAcpAdapterOptions.allowedTools}.
 */
const forbiddenToolNames: Record<string, true> = {
  delegate: true,
  dispatch: true,
  new_task: true,
  spawn: true,
  spawn_agent: true,
  subagent: true,
  task: true,
};

/**
 * `session/update` variants that carry session metadata (UI commands, info, plan, agent-type)
 * rather than transcript content. They decode strictly and emit no events.
 */
const metadataSessionUpdates: Record<string, true> = {
  agent_type_update: true,
  available_commands_update: true,
  plan_update: true,
  session_info_update: true,
  agent_thought_chunk: true,
  agent_message_chunk: true,
};

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if ("constructor" in value) {
    return value.constructor === Object;
  }
  return true;
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (!isPlainObject(value)) {
    throw new OmpAcpAdapterError(
      "frame_invalid",
      `${path} must be a JSON object`,
      "Update OMP to a version whose ACP frames conform to JSON-RPC 2.0.",
    );
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new OmpAcpAdapterError(
      "frame_invalid",
      `${path} must be a string`,
      "Update OMP to a version whose ACP frames conform to JSON-RPC 2.0.",
    );
  }
  return value;
}

function asJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => asJsonValue(entry, path)));
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value))
      out[key] = asJsonValue(entry, `${path}.${key}`);
    return Object.freeze(out);
  }
  throw new OmpAcpAdapterError(
    "frame_invalid",
    `${path} contains a value that is not JSON-compatible`,
    "Update OMP to a version whose ACP frames conform to JSON-RPC 2.0.",
  );
}

// -------------------------------------------------------------------------------------------------
// Strict JSON-RPC frame decoding (pure, exported for unit tests).
// -------------------------------------------------------------------------------------------------

export type AcpRpcError = Readonly<{ code: number; message: string; data?: unknown }>;

export type AcpFrame =
  | Readonly<{ kind: "response"; id: number | string; result: unknown }>
  | Readonly<{ kind: "error_response"; id: number | string; error: AcpRpcError }>
  | Readonly<{ kind: "notification"; method: string; params: unknown }>;

export type DecodeAcpFrameResult =
  | Readonly<{ ok: true; frame: AcpFrame }>
  | Readonly<{ ok: false; code: "frame_invalid"; reason: string }>;

/**
 * Decode one stdio line as JSON-RPC 2.0, strictly. A frame is accepted only when it is a plain
 * object carrying `jsonrpc:"2.0"` and exactly one of: a notification (`method`, no `id`), a
 * successful response (`id` + `result`), or an error response (`id` + `error:{code,message}`).
 * Anything else — malformed JSON, missing `jsonrpc`, a server-to-client request, a notification
 * carrying `result`/`error`, or an `error` object of the wrong shape — yields `frame_invalid`.
 * The decoder never throws; callers translate `frame_invalid` into a typed error event.
 */
export function decodeAcpFrame(line: string): DecodeAcpFrameResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "frame_invalid", reason: "empty frame" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: "frame_invalid", reason: "malformed JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: "frame_invalid", reason: "frame must be a JSON object" };
  }
  const record = parsed;
  if (record["jsonrpc"] !== "2.0") {
    return { ok: false, code: "frame_invalid", reason: 'jsonrpc must equal "2.0"' };
  }
  const hasMethod = typeof record["method"] === "string";
  const hasId =
    record["id"] !== undefined &&
    (typeof record["id"] === "number" || typeof record["id"] === "string");
  const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
  const hasError = Object.prototype.hasOwnProperty.call(record, "error");

  if (hasMethod) {
    if (hasId) {
      return {
        ok: false,
        code: "frame_invalid",
        reason: "server-to-client requests are unsupported",
      };
    }
    if (hasResult || hasError) {
      return {
        ok: false,
        code: "frame_invalid",
        reason: "notification must not carry result or error",
      };
    }
    const params = record["params"];
    if (params !== undefined && !isPlainObject(params) && !Array.isArray(params)) {
      return { ok: false, code: "frame_invalid", reason: "params must be an object or array" };
    }
    return {
      ok: true,
      frame: { kind: "notification", method: record["method"] as string, params },
    };
  }
  if (!hasId) {
    return { ok: false, code: "frame_invalid", reason: "frame must carry method or id" };
  }
  const id = record["id"] as number | string;
  if (hasResult && hasError) {
    return {
      ok: false,
      code: "frame_invalid",
      reason: "frame must not carry both result and error",
    };
  }
  if (hasError) {
    const error = record["error"];
    if (
      !isPlainObject(error) ||
      typeof error["code"] !== "number" ||
      typeof error["message"] !== "string"
    ) {
      return {
        ok: false,
        code: "frame_invalid",
        reason: "error must be {code:number, message:string}",
      };
    }
    return {
      ok: true,
      frame: {
        kind: "error_response",
        id,
        error: Object.freeze({
          code: error["code"],
          message: error["message"],
          data: error["data"],
        }),
      },
    };
  }
  if (hasResult) {
    return { ok: true, frame: { kind: "response", id, result: record["result"] } };
  }
  return {
    ok: false,
    code: "frame_invalid",
    reason: "response frame must carry result or error",
  };
}

// -------------------------------------------------------------------------------------------------
// ACP notification → HarnessEventPayload normalization (pure, exported for unit tests).
// The decoder is defensive: known transcript kinds map to typed payloads; session-metadata
// kinds decode strictly and emit nothing; genuinely unknown kinds surface as a typed,
// non-retryable error event so they are observable without crashing the session (no invented
// events).
// -------------------------------------------------------------------------------------------------

/**
 * Normalize one ACP notification (`session/update`, `message/part`, or the `session/notification`
 * alias) into zero or more {@link HarnessEventPayload}s. Pure: no session state, no timestamps,
 * no sequence numbers — the caller attaches those.
 */
export function normalizeAcpNotification(
  method: string,
  params: unknown,
): readonly HarnessEventPayload[] {
  if (method === "session/update" || method === "session/notification") {
    return normalizeSessionUpdate(params);
  }
  if (method === "message/part") {
    return normalizeMessagePart(params);
  }
  return [
    {
      kind: "error",
      code: "frame_invalid",
      message: `unsupported ACP notification method: ${method}`,
      retryable: false,
    },
  ];
}

function normalizeSessionUpdate(params: unknown): readonly HarnessEventPayload[] {
  const record = asRecord(params, "session/update params");
  const update = asRecord(record["update"], "session/update params.update");
  const sessionUpdate = asString(
    update["sessionUpdate"],
    "session/update params.update.sessionUpdate",
  );
  if (metadataSessionUpdates[sessionUpdate] === true) return [];
  switch (sessionUpdate) {
    case "prompt_start":
      return promptLifecycle(update, "prompt_start");
    case "prompt_end":
      return promptLifecycle(update, "prompt_end");
    case "usage":
      return [normalizeUsage(update)];
    case "error":
      return [normalizeErrorUpdate(update)];
    case "retry":
      return [normalizeRetry(update)];
    case "session_end":
      return [normalizeResult(update)];
    default:
      return [
        {
          kind: "error",
          code: "frame_invalid",
          message: `unknown session/update kind: ${sessionUpdate}`,
          retryable: false,
        },
      ];
  }
}

function promptLifecycle(
  update: UnknownRecord,
  phase: "prompt_start" | "prompt_end",
): readonly HarnessEventPayload[] {
  const rawPromptId = update["promptId"];
  if (typeof rawPromptId !== "string" || rawPromptId.length === 0) {
    return [
      {
        kind: "error",
        code: "frame_invalid",
        message: `session/update ${phase} lacks a non-empty promptId`,
        retryable: false,
      },
    ];
  }
  return phase === "prompt_start"
    ? [
        { kind: "turn_started", turnId: rawPromptId },
        { kind: "prompt_started", promptId: rawPromptId },
      ]
    : [
        { kind: "prompt_finished", promptId: rawPromptId },
        { kind: "turn_finished", turnId: rawPromptId },
      ];
}

function normalizeMessagePart(params: unknown): readonly HarnessEventPayload[] {
  const record = asRecord(params, "message/part params");
  const part = asRecord(record["part"], "message/part params.part");
  const type = asString(part["type"], "message/part params.part.type");
  switch (type) {
    case "text":
      return [
        {
          kind: "message",
          role: "assistant",
          text: asString(part["text"], "message/part params.part.text"),
        },
      ];
    case "thought":
      return [{ kind: "thinking", text: asString(part["text"], "message/part params.part.text") }];
    case "tool_call":
      return [
        {
          kind: "tool_call",
          callId: asString(part["toolCallId"], "message/part params.part.toolCallId"),
          tool: asString(part["toolName"], "message/part params.part.toolName"),
          input: asJsonValue(part["input"], "message/part params.part.input"),
        },
      ];
    case "tool_result":
      return [
        {
          kind: "tool_result",
          callId: asString(part["toolCallId"], "message/part params.part.toolCallId"),
          output: asJsonValue(part["output"], "message/part params.part.output"),
          failed: part["isError"] === true,
        },
      ];
    case "resource_link":
      return [
        {
          kind: "message",
          role: "assistant",
          text: asString(part["uri"], "message/part params.part.uri"),
        },
      ];
    default:
      return [
        {
          kind: "error",
          code: "frame_invalid",
          message: `unknown message part type: ${type}`,
          retryable: false,
        },
      ];
  }
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, path);
}

function normalizeUsage(update: UnknownRecord): HarnessEventPayload {
  const usage: HarnessUsage = {
    inputTokens: nonNegativeInteger(
      update["inputTokens"] ?? update["input_tokens"],
      "session/update params.update.inputTokens",
    ),
    outputTokens: nonNegativeInteger(
      update["outputTokens"] ?? update["output_tokens"],
      "session/update params.update.outputTokens",
    ),
    cachedInputTokens: nonNegativeInteger(
      update["cachedInputTokens"] ??
        update["cacheReadInputTokens"] ??
        update["cache_read_input_tokens"],
      "session/update params.update.cachedInputTokens",
    ),
  };
  return { kind: "usage", usage };
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OmpAcpAdapterError(
      "frame_invalid",
      `${path} must be a number`,
      "Update OMP to a version whose ACP frames conform to JSON-RPC 2.0.",
    );
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OmpAcpAdapterError(
      "frame_invalid",
      `${path} must be a non-negative safe integer`,
      "Update OMP to a version whose ACP frames conform to JSON-RPC 2.0.",
    );
  }
  return value;
}

function normalizeErrorUpdate(update: UnknownRecord): HarnessEventPayload {
  const data = update["data"];
  const message =
    typeof data === "string"
      ? data
      : isPlainObject(data) && typeof data["message"] === "string"
        ? data["message"]
        : asString(update["message"], "session/update params.update.message");
  return {
    kind: "error",
    code: "command_failed",
    message,
    retryable: false,
  };
}

function normalizeRetry(update: UnknownRecord): HarnessEventPayload {
  const record = asRecord(update["retry"], "session/update params.update.retry");
  return {
    kind: "retry",
    providerRequestOrdinal: nonNegativeInteger(
      record["providerRequestOrdinal"] ?? record["attempt"],
      "session/update params.update.retry.providerRequestOrdinal",
    ),
    reason: asString(record["reason"], "session/update params.update.retry.reason"),
  };
}

function normalizeResult(update: UnknownRecord): HarnessEventPayload {
  const outcomeRaw = optionalString(update["outcome"], "session/update params.update.outcome");
  const outcome: "succeeded" | "failed" | "cancelled" =
    outcomeRaw === "failed" ? "failed" : outcomeRaw === "cancelled" ? "cancelled" : "succeeded";
  return {
    kind: "result",
    outcome,
    text: optionalString(update["text"], "session/update params.update.text") ?? "",
  };
}

// -------------------------------------------------------------------------------------------------
// Capability mapping, param builders, manifest persistence.
// -------------------------------------------------------------------------------------------------

interface AgentCapabilities {
  readonly loadSession?: unknown;
  readonly promptCapabilities?: unknown;
  readonly sessionCapabilities?: UnknownRecord;
}

interface InitializeResult {
  readonly protocolVersion: number;
  readonly agentInfo: Readonly<{ name: string; version: string }>;
  readonly agentCapabilities: AgentCapabilities;
}

/**
 * Map the ACP `agentCapabilities` to {@link HarnessCapability}s, faithfully to the installed
 * `omp acp` 17.0.4. `interrupt` is never advertised because OMP 17.0.4 has no
 * `session/cancel` method (verified), so requiring `interrupt` fails closed (HAR-06).
 */
function mapHarnessCapabilities(agent: AgentCapabilities): readonly HarnessCapability[] {
  const capabilities: HarnessCapability[] = [];
  if (agent.loadSession === true) capabilities.push("resume");
  if (agent.promptCapabilities !== undefined) {
    capabilities.push("steer", "follow_up");
  }
  if (agent.sessionCapabilities !== undefined) {
    capabilities.push("snapshot");
    if (agent.sessionCapabilities["close"] !== undefined) capabilities.push("abort");
  }
  return Object.freeze(capabilities);
}

/**
 * Build the `session/new` params. The tool allowlist is exactly `allowedTools`; no subagent /
 * spawn tool is ever injected (HAR-04). Exported for the disabled-subagent-spawning test.
 */
export function buildSessionNewParams(cwd: string, allowedTools: readonly string[]): UnknownRecord {
  return Object.freeze({
    cwd,
    mcpServers: Object.freeze({}) as Readonly<Record<string, never>>,
    session: Object.freeze({ tools: Object.freeze([...allowedTools]) }),
  });
}

interface SessionManifest {
  readonly schemaVersion: typeof manifestSchemaVersion;
  readonly durableHarnessId: string;
  readonly sessionId: string;
  readonly harnessVersion: string;
  readonly createdAt: Timestamp;
}

async function ensureProtectedSessionDirectory(sessionDirectory: string): Promise<void> {
  await mkdir(sessionDirectory, { recursive: true, mode: sessionDirectoryMode });
  const info = await stat(sessionDirectory);
  if (!info.isDirectory()) {
    throw new OmpAcpAdapterError(
      "filesystem_error",
      `session directory is not a directory: ${sessionDirectory}`,
      "Point sessionDirectory at a writable directory used only by this node.",
    );
  }
  const mode = info.mode & 0o777;
  if (mode & 0o077) {
    throw new OmpAcpAdapterError(
      "filesystem_error",
      `session directory is group/other accessible (mode ${mode.toString(8)}): ${sessionDirectory}`,
      `Restrict the directory to the owner (chmod 0700 ${sessionDirectory}).`,
    );
  }
  try {
    await chmod(sessionDirectory, sessionDirectoryMode);
  } catch (error: unknown) {
    throw new OmpAcpAdapterError(
      "filesystem_error",
      `cannot protect session directory: ${sessionDirectory}`,
      "Restrict the directory owner permissions before starting a session.",
      error,
    );
  }
}

/**
 * P1 (review #19): neither writeManifest nor readManifest validated
 * durableHarnessId's shape before joining it into a filesystem path -
 * `../../etc/passwd` (or any other traversal payload) escapes the
 * protected session directory for both reads and writes. durableHarnessId
 * is caller-supplied (it flows in from request.durableHarnessId with no
 * upstream format check), so validate it here, at the sole place both
 * manifest operations construct a path from it.
 */
const durableHarnessIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

function manifestPath(sessionDirectory: string, durableHarnessId: string): string {
  if (!durableHarnessIdPattern.test(durableHarnessId)) {
    throw new OmpAcpAdapterError(
      "invalid_configuration",
      `durable harness id is not a safe filename: ${durableHarnessId}`,
      "Use an alphanumeric durable harness id (letters, digits, '-', '_' only).",
    );
  }
  return join(sessionDirectory, `${durableHarnessId}.json`);
}

async function writeManifest(sessionDirectory: string, manifest: SessionManifest): Promise<void> {
  const path = manifestPath(sessionDirectory, manifest.durableHarnessId);
  try {
    await writeFile(path, JSON.stringify(manifest), { mode: manifestFileMode, encoding: "utf-8" });
    await chmod(path, manifestFileMode);
  } catch (error: unknown) {
    throw new OmpAcpAdapterError(
      "filesystem_error",
      `cannot write durable session manifest: ${path}`,
      "Ensure the session directory is owner-writable.",
      error,
    );
  }
}

async function readManifest(
  sessionDirectory: string,
  durableHarnessId: string,
): Promise<SessionManifest> {
  const path = manifestPath(sessionDirectory, durableHarnessId);
  let raw: string;
  try {
    raw = await readFile(path, { encoding: "utf-8" });
  } catch (error: unknown) {
    throw new OmpAcpAdapterError(
      "session_not_found",
      `no durable session manifest for ${durableHarnessId} at ${path}`,
      "Start a new session instead of resuming a missing durable identity.",
      error,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw manifestInvalid(path, "durable session manifest is corrupted", error);
  }
  if (!isPlainObject(parsed)) {
    throw manifestInvalid(path, "durable session manifest must be a JSON object");
  }
  const record = parsed;
  const schemaVersion = record["schemaVersion"];
  const sessionId = record["sessionId"];
  const storedDurable = record["durableHarnessId"];
  const harnessVersion = record["harnessVersion"];
  const createdAt = record["createdAt"];
  if (
    schemaVersion !== manifestSchemaVersion ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    storedDurable !== durableHarnessId ||
    typeof harnessVersion !== "string" ||
    typeof createdAt !== "number"
  ) {
    throw manifestInvalid(path, "durable session manifest has invalid fields");
  }
  return Object.freeze({
    schemaVersion: manifestSchemaVersion,
    durableHarnessId,
    sessionId,
    harnessVersion,
    createdAt: timestampFromEpochMilliseconds(createdAt),
  });
}

function manifestInvalid(path: string, message: string, cause?: unknown): OmpAcpAdapterError {
  return new OmpAcpAdapterError(
    "filesystem_error",
    `${message}: ${path}`,
    "Remove the invalid manifest and start a new session.",
    cause,
  );
}

// -------------------------------------------------------------------------------------------------
// Bounded subprocess JSON-RPC client (one persistent `omp acp` child per session).
// -------------------------------------------------------------------------------------------------

type NotificationSink = (method: string, params: unknown) => void;

const noopNotification: NotificationSink = () => undefined;
const noopProtocolError: (reason: string) => void = () => undefined;

/**
 * Mutable callback holder. The client reads these properties on every frame, so a caller can
 * re-route the notification stream into a live session by reassigning them after the session is
 * constructed.
 */
interface ClientCallbacks {
  onNotification: NotificationSink;
  onProtocolError: (reason: string) => void;
}

interface PendingRequest {
  readonly id: number;
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: OmpAcpAdapterError) => void;
  readonly timer: NodeJS.Timeout;
}

class OmpAcpClient {
  private child: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly stderrChunks: Uint8Array[] = [];
  private stderrBytes = 0;
  private stderrOverflowed = false;
  private closed = false;
  private readonly callbacks: ClientCallbacks;

  constructor(ompPath: string, cwd: string, callbacks: ClientCallbacks) {
    this.callbacks = callbacks;
    let child: ChildProcess;
    try {
      child = spawn(ompPath, ["acp"], {
        cwd,
        env: { ...process.env },
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      throw new OmpAcpAdapterError(
        "spawn_failed",
        `omp acp process could not be started: ${ompPath}`,
        "Install the pinned OMP runtime and rerun host setup.",
        error,
      );
    }
    this.child = child;
    if (child.stdout !== null) {
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        this.consumeStdout(chunk);
      });
    }
    if (child.stderr !== null) {
      child.stderr.on("data", (chunk: unknown) => {
        this.captureStderr(chunk);
      });
    }
    child.once("error", (error: unknown) => {
      this.failAll(
        new OmpAcpAdapterError(
          this.closed ? "command_failed" : "spawn_failed",
          `omp acp process failed: ${errorToString(error)}`,
          "Install the pinned OMP runtime and rerun host setup.",
          error,
        ),
      );
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.failAll(
        new OmpAcpAdapterError(
          "command_failed",
          `omp acp process exited (code=${code === null ? "null" : String(code)} signal=${signal ?? "null"})`,
          "Inspect the captured stderr and restart the harness session.",
        ),
      );
    });
  }

  send(method: string, params: UnknownRecord): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new OmpAcpAdapterError(
          "command_failed",
          `omp acp client is closed; cannot send ${method}`,
          "Start or resume the harness session to obtain a live process.",
        ),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          rejectPromise(
            new OmpAcpAdapterError(
              "command_failed",
              `omp acp ${method} request timed out after ${String(requestTimeoutMs)}ms`,
              "Inspect the captured stderr and restart the harness session.",
            ),
          );
        }
      }, requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { id, method, resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.child.stdin?.write(`${frame}\n`);
      } catch (error: unknown) {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectPromise(
          new OmpAcpAdapterError(
            "command_failed",
            `cannot write ${method} request to omp acp stdin: ${errorToString(error)}`,
            "Restart the harness session.",
            error,
          ),
        );
      }
    });
  }

  notify(method: string, params?: UnknownRecord): void {
    if (this.closed) return;
    const frame = JSON.stringify(
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
    );
    try {
      this.child.stdin?.write(`${frame}\n`);
    } catch {
      // Notifications are best-effort (initialize handshake); a closed pipe surfaces via close().
    }
  }

  stderrSummary(): string {
    if (!this.stderrOverflowed && this.stderrBytes === 0) return "";
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
      concatenate(this.stderrChunks),
    );
    return this.stderrOverflowed
      ? `${decoded}\n[stderr truncated at ${String(stderrLimitBytes)} bytes]`
      : decoded;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    terminateProcessGroup(this.child);
    for (const pending of [...this.pending.values()]) {
      this.pending.delete(pending.id);
      clearTimeout(pending.timer);
      pending.reject(
        new OmpAcpAdapterError(
          "command_failed",
          "omp acp client was closed",
          "Start or resume the harness session to obtain a live process.",
        ),
      );
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    if (newlineIndex < 0 && this.stdoutBuffer.length > maxStdoutBufferBytes) {
      this.stdoutBuffer = "";
      this.safeProtocolError(
        `omp acp stdout exceeded ${String(maxStdoutBufferBytes)} bytes without a newline`,
      );
      return;
    }
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    try {
      const decoded = decodeAcpFrame(line);
      if (!decoded.ok) {
        this.safeProtocolError(decoded.reason);
        return;
      }
      const frame = decoded.frame;
      if (frame.kind === "notification") {
        this.callbacks.onNotification(frame.method, frame.params);
        return;
      }
      if (typeof frame.id !== "number") {
        this.safeProtocolError(`response with non-numeric id ${frame.id}`);
        return;
      }
      const pending = this.pending.get(frame.id);
      if (pending === undefined) {
        this.safeProtocolError(`response with unknown id ${String(frame.id)}`);
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.kind === "response") {
        pending.resolve(frame.result);
        return;
      }
      pending.reject(rpcErrorToAdapterError(pending.method, frame.error));
    } catch (error: unknown) {
      this.safeProtocolError(`frame handling threw: ${errorToString(error)}`);
    }
  }

  private safeProtocolError(reason: string): void {
    try {
      this.callbacks.onProtocolError(reason);
    } catch {
      // Protocol-error routing must never crash the stdout stream handler.
    }
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

  private failAll(error: OmpAcpAdapterError): void {
    for (const pending of [...this.pending.values()]) {
      this.pending.delete(pending.id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function rpcErrorToAdapterError(method: string, error: AcpRpcError): OmpAcpAdapterError {
  const detail = error.data === undefined ? "" : ` ${errorToString(error.data)}`;
  const text = `${error.message}${detail}`;
  if (method === "session/load" && /session not found/iu.test(text)) {
    return new OmpAcpAdapterError(
      "session_not_found",
      `ACP session/load could not find the session: ${text}`,
      "Start a new session instead of resuming a missing durable identity.",
    );
  }
  if (error.code === -32601 || /unknown acp .* method/iu.test(text)) {
    return new OmpAcpAdapterError(
      "capability_unavailable",
      `omp acp does not implement ${method}: ${text}`,
      "Use an OMP build that supports the required ACP method.",
    );
  }
  if (error.code === -32602) {
    return new OmpAcpAdapterError(
      "protocol_error",
      `ACP ${method} rejected the request params: ${text}`,
      "Update the adapter to match the installed OMP ACP schema.",
    );
  }
  return new OmpAcpAdapterError(
    "command_failed",
    `ACP ${method} failed (${String(error.code)}): ${text}`,
    "Inspect the captured stderr and retry after resolving the operation.",
  );
}

function terminateProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  try {
    if (child.stdin !== null) child.stdin.end();
  } catch {
    // ignore — process-group signal is the authoritative teardown
  }
  if (pid === undefined) return;
  signalProcessGroup(child, pid, "SIGTERM");
  const killTimer = setTimeout(() => {
    signalProcessGroup(child, pid, "SIGKILL");
  }, 1_000);
  killTimer.unref();
}

function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (groupError: unknown) {
    if (!(isNodeError(groupError) && groupError.code === "ESRCH")) {
      try {
        child.kill(signal);
      } catch {
        // best-effort
      }
    }
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new TypeError("omp acp stderr chunk is not bytes");
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function errorToString(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// -------------------------------------------------------------------------------------------------
// Handshake parsing + capability gating.
// -------------------------------------------------------------------------------------------------

function protocolError(message: string): OmpAcpAdapterError {
  return new OmpAcpAdapterError(
    "protocol_error",
    message,
    "Update OMP to a build that conforms to Agent Client Protocol.",
  );
}

function parseInitializeResult(result: unknown, expectedVersion: string): InitializeResult {
  if (!isPlainObject(result)) {
    throw protocolError("ACP initialize result must be a JSON object");
  }
  if (typeof result["protocolVersion"] !== "number") {
    throw protocolError("ACP initialize result lacks a numeric protocolVersion");
  }
  const agentInfo = result["agentInfo"];
  if (!isPlainObject(agentInfo)) {
    throw protocolError("ACP initialize result.agentInfo must be a JSON object");
  }
  if (typeof agentInfo["name"] !== "string" || agentInfo["name"].length === 0) {
    throw protocolError("ACP initialize result.agentInfo.name is missing");
  }
  if (typeof agentInfo["version"] !== "string" || !versionPattern.test(agentInfo["version"])) {
    throw protocolError("ACP initialize result.agentInfo.version is missing or malformed");
  }
  const version = agentInfo["version"];
  if (version !== expectedVersion) {
    throw new OmpAcpAdapterError(
      "version_mismatch",
      `omp acp agentInfo.version is ${version}, expected ${expectedVersion}`,
      `Install the pinned OMP ${expectedVersion} runtime before binding a session.`,
    );
  }
  const rawCapabilities = result["agentCapabilities"];
  if (!isPlainObject(rawCapabilities)) {
    throw protocolError("ACP initialize result.agentCapabilities must be a JSON object");
  }
  return {
    protocolVersion: result["protocolVersion"],
    agentInfo: { name: agentInfo["name"], version },
    agentCapabilities: rawCapabilities,
  };
}

function buildHandshake(
  initialized: InitializeResult,
  options: ValidatedOptions,
): HarnessHandshake {
  const model = options.model ?? "omp-default";
  const slash = model.indexOf("/");
  const providerKind = slash > 0 ? model.slice(0, slash) : "omp";
  return {
    harnessKind,
    harnessVersion: initialized.agentInfo.version,
    providerKind,
    model,
    reasoningLevel: options.reasoningLevel ?? "default",
    capabilities: mapHarnessCapabilities(initialized.agentCapabilities),
    tools: options.allowedTools,
    securityPolicyDigest: options.securityPolicyDigest,
  };
}

function gateRequiredCapabilities(
  handshakeResult: HarnessHandshake,
  required: readonly HarnessCapability[],
): void {
  try {
    requireHarnessCapabilities(handshakeResult, required);
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      throw new OmpAcpAdapterError(
        "capability_missing",
        error.message,
        "Adjust requiredCapabilities or use an OMP build that advertises them.",
        error,
      );
    }
    throw error;
  }
}

async function initializeClient(
  client: OmpAcpClient,
  options: ValidatedOptions,
): Promise<InitializeResult> {
  let raw: unknown;
  try {
    raw = await client.send("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "minions-omp-acp", version: options.expectedVersion },
    });
  } catch (error: unknown) {
    throw rethrowAdapter(
      error,
      `omp acp initialize failed: ${errorToString(error)}`,
      "Install the pinned OMP runtime and rerun host setup.",
    );
  }
  return parseInitializeResult(raw, options.expectedVersion);
}

function rethrowAdapter(
  error: unknown,
  fallbackMessage: string,
  fallbackRemediation: string,
): OmpAcpAdapterError {
  if (error instanceof OmpAcpAdapterError) return error;
  return new OmpAcpAdapterError("command_failed", fallbackMessage, fallbackRemediation, error);
}

function parseSessionId(result: unknown): string {
  if (!isPlainObject(result)) {
    throw protocolError("ACP session/new result must be a JSON object");
  }
  if (typeof result["sessionId"] !== "string" || result["sessionId"].length === 0) {
    throw protocolError("ACP session/new result lacks a non-empty sessionId");
  }
  return result["sessionId"];
}

// -------------------------------------------------------------------------------------------------
// Harness session.
// -------------------------------------------------------------------------------------------------

type SessionState = "idle" | "running" | "interrupted" | "finished" | "aborted";
type WaitSignal = "event" | "closed";

class OmpAcpHarnessSession implements HarnessSession {
  readonly identity: HarnessSessionIdentity;
  private readonly client: OmpAcpClient;
  private readonly handshake: HarnessHandshake;
  private readonly buffer: HarnessEvent[] = [];
  private nextSequence = 1n;
  private promptOrdinal = 0;
  private state: SessionState = "idle";
  private terminated = false;
  private readonly waiters = new Set<(signal: WaitSignal) => void>();
  private readonly onDispose: () => void;

  constructor(args: {
    readonly identity: HarnessSessionIdentity;
    readonly client: OmpAcpClient;
    readonly handshake: HarnessHandshake;
    readonly onDispose: () => void;
  }) {
    this.identity = args.identity;
    this.client = args.client;
    this.handshake = args.handshake;
    this.onDispose = args.onDispose;
  }

  handleNotification(method: string, params: unknown): void {
    const payloads = normalizeAcpNotification(method, params);
    for (const payload of payloads) this.emit(payload);
  }

  handleProtocolError(reason: string): void {
    this.emit({
      kind: "error",
      code: "frame_invalid",
      message: `omp acp emitted a malformed frame: ${reason}`,
      retryable: false,
    });
  }

  stderrSummary(): string {
    return this.client.stderrSummary();
  }

  /** Terminate the backing process and release the durable identity (test/dispose seam). */
  dispose(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.client.close();
    this.onDispose();
    if (this.waiters.size > 0) {
      for (const waiter of this.waiters) waiter("closed");
      this.waiters.clear();
    }
  }

  isTerminated(): boolean {
    return this.terminated;
  }

  events(afterSequence: bigint): AsyncIterable<HarnessEvent> {
    const stream = async function* (
      this: OmpAcpHarnessSession,
      after: bigint,
    ): AsyncGenerator<HarnessEvent> {
      let cursor = after;
      for (;;) {
        let advanced = false;
        for (;;) {
          const next = this.nextBufferedAfter(cursor);
          if (next === undefined) break;
          cursor = next.sequence;
          advanced = true;
          yield next;
        }
        if (this.isTerminated()) return;
        if (advanced) continue;
        const signal = await this.waitForSignal();
        if (signal === "closed") {
          for (;;) {
            const next = this.nextBufferedAfter(cursor);
            if (next === undefined) break;
            cursor = next.sequence;
            yield next;
          }
          return;
        }
      }
    };
    return stream.call(this, afterSequence);
  }

  async prompt(promptId: string, text: string): Promise<void> {
    this.requireCapability("steer");
    await this.sendPrompt(promptId, text);
  }

  async steer(text: string): Promise<void> {
    this.requireCapability("steer");
    this.promptOrdinal += 1;
    await this.sendPrompt(`steer-${String(this.promptOrdinal)}`, text);
  }

  async followUp(promptId: string, text: string): Promise<void> {
    this.requireCapability("follow_up");
    await this.sendPrompt(promptId, text);
  }

  interrupt(): Promise<void> {
    if (!this.handshake.capabilities.includes("interrupt")) {
      return Promise.reject(
        new OmpAcpAdapterError(
          "capability_unavailable",
          "omp acp does not support interrupt (no session/cancel method in 17.0.4)",
          "Use abort() to end the session instead.",
        ),
      );
    }
    return Promise.resolve();
  }

  async abort(): Promise<void> {
    this.requireCapability("abort");
    if (this.terminated) return;
    try {
      await this.client.send("session/close", { sessionId: this.identity.sessionId });
    } catch (error: unknown) {
      this.emit({
        kind: "error",
        code: error instanceof OmpAcpAdapterError ? error.code : "command_failed",
        message: `session/close failed during abort: ${errorToString(error)}`,
        retryable: false,
      });
    }
    this.state = "aborted";
    this.emit({ kind: "result", outcome: "cancelled", text: "" });
    this.dispose();
  }

  snapshot(): Promise<HarnessSessionSnapshot> {
    return Promise.resolve({
      identity: this.identity,
      nextEventSequence: this.nextSequence,
      state: this.state,
    });
  }

  private requireCapability(capability: HarnessCapability): void {
    if (!this.handshake.capabilities.includes(capability)) {
      throw new OmpAcpAdapterError(
        "capability_unavailable",
        `omp acp harness does not provide capability: ${capability}`,
        "Adjust the required capabilities or use an OMP build that advertises it.",
      );
    }
  }

  private async sendPrompt(promptId: string, text: string): Promise<void> {
    if (this.terminated) {
      throw new OmpAcpAdapterError(
        "command_failed",
        "cannot prompt a disposed omp acp session",
        "Start or resume the harness session before prompting.",
      );
    }
    this.state = "running";
    this.emit({ kind: "turn_started", turnId: promptId });
    this.emit({ kind: "prompt_started", promptId });
    try {
      await this.client.send("session/prompt", {
        sessionId: this.identity.sessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (error: unknown) {
      this.state = "idle";
      this.emit({
        kind: "error",
        code: error instanceof OmpAcpAdapterError ? error.code : "command_failed",
        message: `session/prompt failed: ${errorToString(error)}`,
        retryable: false,
      });
      this.emit({ kind: "prompt_finished", promptId });
      this.emit({ kind: "turn_finished", turnId: promptId });
      throw error;
    }
    this.emit({ kind: "prompt_finished", promptId });
    this.emit({ kind: "turn_finished", turnId: promptId });
    this.emit({ kind: "result", outcome: "succeeded", text: "" });
    this.state = "idle";
  }

  private emit(payload: HarnessEventPayload): void {
    const event: HarnessEvent = {
      sequence: this.nextSequence,
      occurredAt: timestampFromEpochMilliseconds(Date.now()),
      payload,
    };
    this.nextSequence += 1n;
    this.buffer.push(event);
    if (this.waiters.size > 0) {
      for (const waiter of this.waiters) waiter("event");
      this.waiters.clear();
    }
  }

  nextBufferedAfter(cursor: bigint): HarnessEvent | undefined {
    return this.buffer.find((event) => event.sequence > cursor);
  }

  waitForSignal(): Promise<WaitSignal> {
    return new Promise<WaitSignal>((resolve) => {
      this.waiters.add(resolve);
    });
  }
}

// -------------------------------------------------------------------------------------------------
// Adapter factory.
// -------------------------------------------------------------------------------------------------

interface ValidatedOptions {
  readonly ompPath: string;
  readonly expectedVersion: string;
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly model: string | undefined;
  readonly reasoningLevel: string | undefined;
  readonly allowedTools: readonly string[];
  readonly securityPolicyDigest: ContentHash;
  readonly requiredCapabilities: readonly HarnessCapability[];
}

function validateOptions(options: OmpAcpAdapterOptions): ValidatedOptions {
  for (const [field, value] of Object.entries({
    ompPath: options.ompPath,
    cwd: options.cwd,
    sessionDirectory: options.sessionDirectory,
  })) {
    if (typeof value !== "string" || !isAbsolute(value) || basename(value).length === 0) {
      throw new OmpAcpAdapterError(
        "invalid_configuration",
        `${field} must be an absolute path`,
        "Run host setup with explicit dedicated OMP and session paths.",
      );
    }
  }
  if (!versionPattern.test(options.expectedVersion)) {
    throw new OmpAcpAdapterError(
      "invalid_configuration",
      "expectedVersion must be a semantic version (x.y.z)",
      "Configure the exact pinned OMP version.",
    );
  }
  if (
    typeof options.securityPolicyDigest !== "string" ||
    !contentHashPattern.test(options.securityPolicyDigest)
  ) {
    throw new OmpAcpAdapterError(
      "invalid_configuration",
      "securityPolicyDigest must be a 64-character hex content hash",
      "Compute the security policy digest before constructing the adapter.",
    );
  }
  // Fail-closed re-validation of the branded digest at runtime.
  contentHash(options.securityPolicyDigest);
  if (!Array.isArray(options.allowedTools)) {
    throw new OmpAcpAdapterError(
      "invalid_configuration",
      "allowedTools must be an array of tool names",
      "Configure the tool allowlist for the managed OMP agent.",
    );
  }
  const allowedTools: string[] = [];
  for (const tool of options.allowedTools) {
    if (typeof tool !== "string" || tool.length === 0) {
      throw new OmpAcpAdapterError(
        "invalid_configuration",
        "allowedTools must contain non-empty string tool names",
        "Configure the tool allowlist for the managed OMP agent.",
      );
    }
    if (forbiddenToolNames[tool.toLowerCase()] === true) {
      throw new OmpAcpAdapterError(
        "invalid_configuration",
        `allowedTools must not include a subagent-spawning tool: ${tool}`,
        "Remove task/subagent/spawn tools so OMP cannot spawn hidden agents (HAR-04).",
      );
    }
    allowedTools.push(tool);
  }
  return {
    ompPath: options.ompPath,
    expectedVersion: options.expectedVersion,
    cwd: options.cwd,
    sessionDirectory: options.sessionDirectory,
    model: options.model,
    reasoningLevel: options.reasoningLevel,
    allowedTools: Object.freeze(allowedTools),
    securityPolicyDigest: options.securityPolicyDigest,
    requiredCapabilities: Object.freeze([...options.requiredCapabilities]),
  };
}

export function createOmpAcpHarnessAdapter(options: OmpAcpAdapterOptions): HarnessAdapter {
  const validated = validateOptions(options);
  const activeIdentities = new Set<string>();

  function releaseIdentity(durableHarnessId: string): void {
    activeIdentities.delete(durableHarnessId);
  }

  async function handshake(): Promise<HarnessHandshake> {
    const router: ClientCallbacks = {
      onNotification: noopNotification,
      onProtocolError: noopProtocolError,
    };
    const client = new OmpAcpClient(validated.ompPath, validated.cwd, router);
    try {
      const initialized = await initializeClient(client, validated);
      const hs = buildHandshake(initialized, validated);
      gateRequiredCapabilities(hs, validated.requiredCapabilities);
      return hs;
    } catch (error: unknown) {
      throw rethrowAdapter(
        error,
        `omp acp handshake failed: ${errorToString(error)}`,
        "Install the pinned OMP runtime and rerun host setup.",
      );
    } finally {
      client.close();
    }
  }

  async function start(request: StartHarnessSessionRequest): Promise<HarnessSession> {
    if (activeIdentities.has(request.durableHarnessId)) {
      throw new OmpAcpAdapterError(
        "session_conflict",
        `a session is already active for durable harness identity ${request.durableHarnessId}`,
        "Dispose the existing session before starting another for the same node (HAR-01).",
      );
    }
    activeIdentities.add(request.durableHarnessId);
    try {
      await ensureProtectedSessionDirectory(validated.sessionDirectory);
      const router: ClientCallbacks = {
        onNotification: noopNotification,
        onProtocolError: noopProtocolError,
      };
      const client = new OmpAcpClient(validated.ompPath, validated.cwd, router);
      let sessionId: string;
      let initialized: InitializeResult;
      try {
        initialized = await initializeClient(client, validated);
        gateRequiredCapabilities(
          buildHandshake(initialized, validated),
          validated.requiredCapabilities,
        );
        await client.send("authenticate", { methodId: "agent" });
        const raw = await client.send(
          "session/new",
          buildSessionNewParams(validated.cwd, validated.allowedTools),
        );
        sessionId = parseSessionId(raw);
      } catch (error: unknown) {
        client.close();
        throw rethrowAdapter(
          error,
          `omp acp start failed: ${errorToString(error)}`,
          "Inspect the captured stderr and retry after resolving the operation.",
        );
      }
      const session = new OmpAcpHarnessSession({
        identity: { durableHarnessId: request.durableHarnessId, sessionId },
        client,
        handshake: buildHandshake(initialized, validated),
        onDispose: () => {
          releaseIdentity(request.durableHarnessId);
        },
      });
      router.onNotification = (method, params) => {
        session.handleNotification(method, params);
      };
      router.onProtocolError = (reason) => {
        session.handleProtocolError(reason);
      };
      try {
        await writeManifest(validated.sessionDirectory, {
          schemaVersion: manifestSchemaVersion,
          durableHarnessId: request.durableHarnessId,
          sessionId,
          harnessVersion: initialized.agentInfo.version,
          createdAt: timestampFromEpochMilliseconds(Date.now()),
        });
      } catch (error: unknown) {
        session.dispose();
        throw error;
      }
      return session;
    } catch (error) {
      activeIdentities.delete(request.durableHarnessId);
      throw error;
    }
  }

  async function resume(request: ResumeHarnessSessionRequest): Promise<HarnessSession> {
    if (activeIdentities.has(request.identity.durableHarnessId)) {
      throw new OmpAcpAdapterError(
        "session_conflict",
        `a session is already active for durable harness identity ${request.identity.durableHarnessId}`,
        "Dispose the existing session before resuming another for the same node (HAR-01).",
      );
    }
    activeIdentities.add(request.identity.durableHarnessId);
    try {
      await ensureProtectedSessionDirectory(validated.sessionDirectory);
      const manifest = await readManifest(
        validated.sessionDirectory,
        request.identity.durableHarnessId,
      );
      if (manifest.sessionId !== request.identity.sessionId) {
        throw new OmpAcpAdapterError(
          "session_not_found",
          `durable identity ${request.identity.durableHarnessId} maps to session ${manifest.sessionId}, not the requested ${request.identity.sessionId}`,
          "Resume with the session id originally bound to this durable harness identity.",
        );
      }
      const router: ClientCallbacks = {
        onNotification: noopNotification,
        onProtocolError: noopProtocolError,
      };
      const client = new OmpAcpClient(validated.ompPath, validated.cwd, router);
      let initialized: InitializeResult;
      try {
        initialized = await initializeClient(client, validated);
        gateRequiredCapabilities(
          buildHandshake(initialized, validated),
          validated.requiredCapabilities,
        );
        await client.send("authenticate", { methodId: "agent" });
        await client.send("session/load", {
          sessionId: manifest.sessionId,
          cwd: validated.cwd,
          mcpServers: Object.freeze({}),
        });
      } catch (error: unknown) {
        client.close();
        throw rethrowAdapter(
          error,
          `omp acp resume failed: ${errorToString(error)}`,
          "Start a new session if the durable identity can no longer be resumed.",
        );
      }
      const session = new OmpAcpHarnessSession({
        identity: {
          durableHarnessId: request.identity.durableHarnessId,
          sessionId: manifest.sessionId,
        },
        client,
        handshake: buildHandshake(initialized, validated),
        onDispose: () => {
          releaseIdentity(request.identity.durableHarnessId);
        },
      });
      router.onNotification = (method, params) => {
        session.handleNotification(method, params);
      };
      router.onProtocolError = (reason) => {
        session.handleProtocolError(reason);
      };
      return session;
    } catch (error) {
      activeIdentities.delete(request.identity.durableHarnessId);
      throw error;
    }
  }

  return { handshake, start, resume };
}
