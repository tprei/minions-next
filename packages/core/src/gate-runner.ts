/**
 * Gate runner domain (PR 25).
 *
 * Pure domain types + helpers for running blocking deterministic gates
 * against an exact captured revision and preserving typed evidence receipts.
 * The runner binds every receipt to (head SHA, profile hash, environment
 * digest) so a stale receipt can never unblock children or landing (QA-03).
 *
 * This module performs NO I/O and imports no `node:*` modules. The SHA-256
 * digest is injected as a {@link DigestFunction} (same convention as the
 * execution coordinator) so determinism stays in core without pulling a
 * crypto dependency. The {@link GateCategoryValue} mirrors the numeric
 * `GateCategory` enum from `@minions/contracts`; core keeps it as an opaque
 * number so it stays free of the contracts import.
 */
import type { DigestFunction } from "./execution.js";
import type { AttemptId, ContentHash, GitSha, TaskNodeId, Timestamp } from "./value-objects.js";
import type { Clock } from "./ports.js";
import type { SandboxLifecycle, SandboxPolicyFingerprint } from "./sandbox.js";

// -------------------------------------------------------------------------------------------------
// Outcomes + receipts.
// -------------------------------------------------------------------------------------------------

/**
 * Numeric gate category. Mirrors the contracts `GateCategory` protobuf enum
 * (LINT, TYPECHECK, TESTS, BUILD, SECURITY_REVIEW). Core treats it as an
 * opaque number to avoid importing contracts; the adapter converts the enum
 * value when building a {@link GateCommandDescriptor}.
 */
export type GateCategoryValue = number;

/**
 * Terminal classification of a single gate execution. Deterministic exit
 * facts only — never an LLM diagnosis (QA-03).
 *
 * - `passed` — exit code 0.
 * - `failed` — non-zero exit code.
 * - `timeout` — the gate exceeded its bounded timeout.
 * - `cancelled` — the gate was cancelled (abort signal) before completing.
 * - `missing_executable` — the executable was not available to run.
 * - `error` — structural invalidity or an unrecoverable sandbox denial.
 */
export type GateOutcome =
  "passed" | "failed" | "timeout" | "cancelled" | "missing_executable" | "error";

/**
 * Durable evidence receipt for one gate run. Every receipt is bound to the
 * exact (headCommit, profileHash, environmentDigest) triple captured at run
 * time; if any of those change, {@link isReceiptStale} flags the receipt and
 * it can no longer unblock children or landing (QA-03).
 *
 * Raw stdout/stderr are never stored on the receipt — only their SHA-256
 * digests (bounded output, QA-09).
 */
export type GateReceipt = Readonly<{
  /** Human-readable gate identifier (the category name, e.g. "lint"). */
  gateName: string;
  /** Numeric gate category (mirrors the contracts enum). */
  category: GateCategoryValue;
  outcome: GateOutcome;
  /** Process exit code, or `null` when no process completed. */
  exitCode: number | null;
  /** Measured wall-clock duration in milliseconds. */
  durationMs: number;
  /** SHA-256 digest of the bounded stdout stream. */
  stdoutDigest: ContentHash;
  /** SHA-256 digest of the bounded stderr stream. */
  stderrDigest: ContentHash;
  /** Exact captured revision the gate ran against. */
  headCommit: GitSha;
  /** Hash of the gate profile that defined this gate. */
  profileHash: ContentHash;
  /** Digest of the captured execution environment. */
  environmentDigest: ContentHash;
  /** When the receipt was captured (epoch milliseconds). */
  capturedAt: Timestamp;
  /** Monotonic sequence within the run (storage/range key). */
  sequence: number;
}>;

/**
 * One gate command to execute, derived from a validated {@link
 * https://github.com/minions/minions-next GateProfile} entry by the adapter.
 */
export type GateCommandDescriptor = Readonly<{
  name: string;
  category: GateCategoryValue;
  executable: string;
  args: readonly string[];
  envAllowlist: readonly string[];
  timeoutMs: number;
}>;

/**
 * Request to run a set of gates against an exact captured revision inside a
 * bound sandbox instance. The sandbox instance + policy fingerprint are
 * supplied by the caller (the execution coordinator creates the sandbox).
 */
export type GateRunRequest = Readonly<{
  nodeId: TaskNodeId;
  attemptId: AttemptId | undefined;
  headCommit: GitSha;
  profileHash: ContentHash;
  /** Environment captured for the environment digest. */
  environment: Readonly<Record<string, string>>;
  sandboxInstanceId: string;
  expectedPolicyFingerprint: SandboxPolicyFingerprint;
  workingDirectory: string;
  maxOutputBytes: number;
  /** Optional cancellation signal; aborting yields a `cancelled` outcome. */
  signal: GateAbortSignal | undefined;
  gates: readonly GateCommandDescriptor[];
}>;

/**
 * Structural abort-signal surface the runner depends on. Declared here so the
 * kernel stays free of `node:` and DOM type dependencies; a runtime
 * `AbortSignal` is structurally assignable and is what callers pass in practice.
 */
export interface GateAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: GateAbortListener, options?: GateAbortOptions): void;
  removeEventListener(type: "abort", listener: GateAbortListener): void;
}

export type GateAbortListener = () => void;

export type GateAbortOptions = Readonly<{ once?: boolean }>;

/** The bindings a receipt must match to count as fresh. */
export type GateReceiptBindings = Readonly<{
  headCommit: GitSha;
  profileHash: ContentHash;
  environmentDigest: ContentHash;
}>;

/** What a set of receipts must satisfy to unblock a node. */
export type GateReceiptExpectation = Readonly<{
  bindings: GateReceiptBindings;
  requiredCategories: readonly GateCategoryValue[];
}>;

/** A reason a required category is not satisfied. */
export type GateValidationProblem = Readonly<{
  category: GateCategoryValue;
  reason: "no_receipt" | "stale_receipt" | "missing_passing_receipt";
}>;

/** Result of validating a set of receipts against an expectation. */
export type GateValidation = Readonly<{
  /** True only when every required category has a fresh, passing receipt. */
  unblocked: boolean;
  problems: readonly GateValidationProblem[];
}>;

// -------------------------------------------------------------------------------------------------
// Storage port (implementation lives in adapters).
// -------------------------------------------------------------------------------------------------

/** A receipt plus its storage provenance. */
export type GateReceiptRecord = Readonly<{
  nodeId: TaskNodeId;
  attemptId: AttemptId | undefined;
  receipt: GateReceipt;
}>;

export type GateReceiptStoreErrorCode = "invalid_input" | "write_failed" | "corrupt";

/** Typed gate-receipt-store error. Fail-closed: every write failure surfaces. */
export class GateReceiptStoreError extends Error {
  readonly code: GateReceiptStoreErrorCode;

  constructor(code: GateReceiptStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GateReceiptStoreError";
    this.code = code;
  }
}

/**
 * Durable, append-friendly store for {@link GateReceipt}s. Keyed by node +
 * gate name + sequence; queryable by node and by node+gate (QA-06).
 */
export interface GateReceiptStore {
  /** Persist a receipt (crash-safe; idempotent for an identical key). */
  record(record: GateReceiptRecord): Promise<void>;
  /** Every receipt for a node, ordered by sequence ascending. */
  listForNode(nodeId: TaskNodeId): Promise<readonly GateReceipt[]>;
  /** Every receipt for a node + gate name, ordered by sequence ascending. */
  listForGate(nodeId: TaskNodeId, gateName: string): Promise<readonly GateReceipt[]>;
}

// -------------------------------------------------------------------------------------------------
// Runner error + interface.
// -------------------------------------------------------------------------------------------------

export type GateRunnerErrorCode =
  "invalid_request" | "store_failed" | "sandbox_failed" | "invariant";

/** Typed gate-runner error. Fail-closed: a port failure never silently passes. */
export class GateRunnerError extends Error {
  readonly code: GateRunnerErrorCode;

  constructor(code: GateRunnerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GateRunnerError";
    this.code = code;
  }
}

/**
 * Runs blocking gates against an exact captured revision and preserves typed
 * evidence receipts. All required categories are blocking: a node cannot
 * proceed unless every required category has a fresh, passing receipt (QA-03).
 */
export interface GateRunner {
  /** Run every gate in the request and return one receipt per gate. */
  runGates(request: GateRunRequest): Promise<readonly GateReceipt[]>;
  /** Validate a set of receipts against an expectation (pure delegation). */
  validateReceipts(
    receipts: readonly GateReceipt[],
    expected: GateReceiptExpectation,
  ): GateValidation;
}

/** Ports the gate runner composes. None are concrete adapters. */
export type GateRunnerPorts = Readonly<{
  sandbox: SandboxLifecycle;
  store: GateReceiptStore;
  clock: Clock;
  /** Overrides the default SHA-256 environment digest. */
  digest?: DigestFunction;
}>;

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/** Signals that indicate a fatal (cancellation) termination. */
const CANCEL_SIGNALS: Readonly<Record<string, true>> = Object.freeze({
  SIGTERM: true,
  SIGINT: true,
  SIGHUP: true,
  SIGQUIT: true,
});

/**
 * Classify a gate outcome from deterministic exit facts. Pure: given the same
 * (exitCode, signal, timedOut) it always yields the same outcome.
 *
 * - `timedOut` wins over everything.
 * - A cancellation signal (`SIGTERM`/`SIGINT`/`SIGHUP`/`SIGQUIT`) → `cancelled`.
 * - Any other signal (`SIGKILL` from the timeout enforcer, etc.) → `timeout`.
 * - `exitCode === null` with no signal → `missing_executable` (no process ran).
 * - `exitCode === 0` → `passed`; any other exit code → `failed`.
 */
export function classifyOutcome(
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean,
): GateOutcome {
  if (timedOut) {
    return "timeout";
  }
  if (signal !== null) {
    return CANCEL_SIGNALS[signal] === true ? "cancelled" : "timeout";
  }
  if (exitCode === null) {
    return "missing_executable";
  }
  return exitCode === 0 ? "passed" : "failed";
}

/**
 * Canonical, deterministic JSON for an environment map. Keys are sorted; the
 * result is a JSON array of `[key, value]` pairs so byte-identical content is
 * guaranteed regardless of insertion order.
 */
function canonicalEnvironmentJson(env: Readonly<Record<string, string>>): string {
  const entries = Object.entries(env).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return JSON.stringify(entries);
}

/** Compute the stable digest over an environment map. */
export function computeEnvironmentDigest(
  env: Readonly<Record<string, string>>,
  digest: DigestFunction,
): ContentHash {
  return digest(canonicalEnvironmentJson(env));
}

/**
 * A receipt is stale when any of its binding triple changed. Stale receipts
 * never unblock children or landing (QA-03).
 */
export function isReceiptStale(receipt: GateReceipt, current: GateReceiptBindings): boolean {
  return (
    receipt.headCommit !== current.headCommit ||
    receipt.profileHash !== current.profileHash ||
    receipt.environmentDigest !== current.environmentDigest
  );
}

/**
 * Base-failure probe: structural validity of a gate command before execution.
 * Returns `"error"` when the command cannot be executed safely, otherwise
 * `null`. (The GateProfile validator already enforces this; the runner
 * double-checks fail-closed.)
 */
export function probeGateCommand(command: GateCommandDescriptor): GateOutcome | null {
  if (command.executable.length === 0) {
    return "error";
  }
  if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0) {
    return "error";
  }
  return null;
}

/**
 * Validate a set of receipts against an expectation. A required category is
 * satisfied only when it has at least one fresh, passing receipt. Fail-closed:
 * any unsatisfied required category keeps the node blocked (QA-03).
 */
export function validateGateReceipts(
  receipts: readonly GateReceipt[],
  expected: GateReceiptExpectation,
): GateValidation {
  const problems: GateValidationProblem[] = [];
  for (const category of expected.requiredCategories) {
    const matching = receipts.filter((receipt) => receipt.category === category);
    if (matching.length === 0) {
      problems.push(Object.freeze({ category, reason: "no_receipt" }));
      continue;
    }
    const fresh = matching.filter((receipt) => !isReceiptStale(receipt, expected.bindings));
    if (fresh.length === 0) {
      problems.push(Object.freeze({ category, reason: "stale_receipt" }));
      continue;
    }
    if (!fresh.some((receipt) => receipt.outcome === "passed")) {
      problems.push(Object.freeze({ category, reason: "missing_passing_receipt" }));
    }
  }
  return Object.freeze({
    unblocked: problems.length === 0,
    problems: Object.freeze(problems),
  });
}

/** Validate the structural shape of a {@link GateRunRequest}. */
export function validateGateRunRequest(request: GateRunRequest): void {
  if (request.gates.length === 0) {
    throw new GateRunnerError("invalid_request", "gate run request must include at least one gate");
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
    throw new GateRunnerError(
      "invalid_request",
      "gate run request maxOutputBytes must be a positive safe integer",
    );
  }
  if (request.workingDirectory.length === 0) {
    throw new GateRunnerError("invalid_request", "gate run request workingDirectory is required");
  }
  if (request.sandboxInstanceId.length === 0) {
    throw new GateRunnerError("invalid_request", "gate run request sandboxInstanceId is required");
  }
  const seen = new Set<GateCategoryValue>();
  for (const gate of request.gates) {
    if (gate.name.length === 0) {
      throw new GateRunnerError("invalid_request", "gate name is required");
    }
    if (seen.has(gate.category)) {
      throw new GateRunnerError(
        "invalid_request",
        `duplicate gate category in request: ${String(gate.category)}`,
      );
    }
    seen.add(gate.category);
  }
}
