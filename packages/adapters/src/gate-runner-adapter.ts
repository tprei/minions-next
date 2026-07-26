import { createHash } from "node:crypto";

import {
  classifyOutcome,
  computeEnvironmentDigest,
  contentHash,
  GateRunnerError,
  probeGateCommand,
  SandboxDeniedError,
  validateGateReceipts,
  validateGateRunRequest,
  type Clock,
  type ContentHash,
  type DigestFunction,
  type GateAbortSignal,
  type GateCommandDescriptor,
  type GateOutcome,
  type GateReceipt,
  type GateReceiptExpectation,
  type GateReceiptRecord,
  type GateReceiptStore,
  type GateRunnerPorts,
  type GateRunRequest,
  type GateValidation,
  type SandboxExecutionResult,
  type GateRunner,
  type SandboxLifecycle,
  type Timestamp,
} from "@minions/core";

export type CreateGateRunnerOptions = GateRunnerPorts;

/** Default deterministic digest: SHA-256 over UTF-8. */
function defaultDigest(utf8: string): ContentHash {
  return contentHash(createHash("sha256").update(utf8).digest("hex"));
}

/** SHA-256 digest over raw bytes (bounded subprocess output, QA-09). */
function byteDigest(bytes: Uint8Array): ContentHash {
  return contentHash(createHash("sha256").update(bytes).digest("hex"));
}

/**
 * Compose a {@link SandboxLifecycle} and a {@link GateReceiptStore} into a
 * {@link GateRunner}. For each gate in the request the runner executes the
 * validated command inside the bound sandbox, classifies the outcome, digests
 * the bounded stdout/stderr, builds a receipt bound to the exact
 * (headCommit, profileHash, environmentDigest) triple, and stores it durably.
 *
 * Bounded output is content-addressed (digest, never raw). Timeout, cancel,
 * and missing-executable are classified distinctly. All required categories
 * are blocking (QA-03): a node proceeds only when every required category has
 * a fresh, passing receipt.
 */
export function createGateRunner(options: CreateGateRunnerOptions): GateRunner {
  return new ComposedGateRunner(
    options.sandbox,
    options.store,
    options.clock,
    options.digest ?? defaultDigest,
  );
}

/** Outcome of a single gate execution attempt, as observed by the runner. */
type ObservedOutcome = Readonly<{
  outcome: GateOutcome;
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  durationMs: number;
}>;

const EMPTY_BYTES: Uint8Array = new Uint8Array();

class ComposedGateRunner implements GateRunner {
  readonly #sandbox: SandboxLifecycle;
  readonly #store: GateReceiptStore;
  readonly #clock: Clock;
  readonly #digest: DigestFunction;

  constructor(
    sandbox: SandboxLifecycle,
    store: GateReceiptStore,
    clock: Clock,
    digest: DigestFunction,
  ) {
    this.#sandbox = sandbox;
    this.#store = store;
    this.#clock = clock;
    this.#digest = digest;
  }

  async runGates(request: GateRunRequest): Promise<readonly GateReceipt[]> {
    validateGateRunRequest(request);
    const environmentDigest = computeEnvironmentDigest(request.environment, this.#digest);
    const receipts: GateReceipt[] = [];
    for (const [index, gate] of request.gates.entries()) {
      const observed = await this.#runGate(gate, request);
      const receipt = buildReceipt(
        gate,
        request,
        environmentDigest,
        observed,
        index,
        this.#clock.now(),
      );
      receipts.push(receipt);
      await this.#persist(request, receipt);
    }
    return Object.freeze(receipts);
  }

  validateReceipts(
    receipts: readonly GateReceipt[],
    expected: GateReceiptExpectation,
  ): GateValidation {
    return validateGateReceipts(receipts, expected);
  }

  async #runGate(gate: GateCommandDescriptor, request: GateRunRequest): Promise<ObservedOutcome> {
    const probed = probeGateCommand(gate);
    if (probed !== null) {
      return staticOutcome(probed);
    }
    return executeGate(
      this.#sandbox,
      {
        instanceId: request.sandboxInstanceId,
        expectedPolicyFingerprint: request.expectedPolicyFingerprint,
        executable: gate.executable,
        arguments: gate.args,
        workingDirectory: request.workingDirectory,
        environment: request.environment,
        timeoutMs: gate.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      },
      gate.timeoutMs,
      request.signal,
      this.#clock,
    );
  }

  async #persist(request: GateRunRequest, receipt: GateReceipt): Promise<void> {
    const record: GateReceiptRecord = Object.freeze({
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      receipt,
    });
    try {
      await this.#store.record(record);
    } catch (error: unknown) {
      throw new GateRunnerError(
        "store_failed",
        `gate receipt store failed for gate ${receipt.gateName}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function buildReceipt(
  gate: GateCommandDescriptor,
  request: GateRunRequest,
  environmentDigest: ContentHash,
  observed: ObservedOutcome,
  sequence: number,
  capturedAt: Timestamp,
): GateReceipt {
  return Object.freeze({
    gateName: gate.name,
    category: gate.category,
    outcome: observed.outcome,
    exitCode: observed.exitCode,
    durationMs: observed.durationMs,
    stdoutDigest: byteDigest(observed.stdout),
    stderrDigest: byteDigest(observed.stderr),
    headCommit: request.headCommit,
    profileHash: request.profileHash,
    environmentDigest,
    capturedAt,
    sequence,
  });
}

/** The per-gate sandbox request the runner assembles. */
type GateExecutionRequest = Readonly<{
  instanceId: string;
  expectedPolicyFingerprint: GateRunRequest["expectedPolicyFingerprint"];
  executable: string;
  arguments: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}>;

/**
 * Execute one gate inside the sandbox, racing the bounded timeout and an
 * optional cancellation signal. The sandbox enforces its own timeout; this
 * wrapper provides deterministic classification regardless of backend:
 *
 * - cancellation signal aborts → `cancelled`.
 * - the runner's timeout fires before the sandbox resolves → `timeout`.
 * - `SandboxDeniedError` with code `executable_not_allowed` →
 *   `missing_executable`.
 * - `SandboxDeniedError` with code `timeout_limit` → `timeout`.
 * - any other rejection → `error`.
 * - a resolved result → {@link classifyOutcome} from the exit code.
 */
async function executeGate(
  sandbox: SandboxLifecycle,
  request: GateExecutionRequest,
  timeoutMs: number,
  signal: GateAbortSignal | undefined,
  clock: Clock,
): Promise<ObservedOutcome> {
  if (signal?.aborted === true) {
    return staticOutcome("cancelled");
  }
  const startedAt = clock.now();
  return new Promise<ObservedOutcome>((resolve) => {
    let settled = false;
    const settle = (partial: Omit<ObservedOutcome, "durationMs">): void => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({ ...partial, durationMs: elapsedSince(clock, startedAt) }));
    };
    const timer = setTimeout(
      () => {
        settle({ outcome: "timeout", exitCode: null, stdout: EMPTY_BYTES, stderr: EMPTY_BYTES });
      },
      Math.max(1, timeoutMs),
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      settle({ outcome: "cancelled", exitCode: null, stdout: EMPTY_BYTES, stderr: EMPTY_BYTES });
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    sandbox
      .execute({
        instanceId: request.instanceId,
        expectedPolicyFingerprint: request.expectedPolicyFingerprint,
        executable: request.executable,
        arguments: request.arguments,
        workingDirectory: request.workingDirectory,
        environment: request.environment,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      })
      .then(
        (result: SandboxExecutionResult) => {
          clearTimeout(timer);
          settle({
            outcome: classifyOutcome(result.exitCode, null, false),
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        },
        (error: unknown) => {
          clearTimeout(timer);
          settle({
            outcome: classifyRejection(error),
            exitCode: null,
            stdout: EMPTY_BYTES,
            stderr: EMPTY_BYTES,
          });
        },
      );
  });
}

function classifyRejection(error: unknown): GateOutcome {
  if (error instanceof SandboxDeniedError) {
    if (error.code === "executable_not_allowed") {
      return "missing_executable";
    }
    if (error.code === "timeout_limit") {
      return "timeout";
    }
  }
  return "error";
}

function elapsedSince(clock: Clock, startedAt: Timestamp): number {
  const now = clock.now();
  return now >= startedAt ? now - startedAt : 0;
}

/** An outcome with no captured output and zero duration (pre-execution). */
function staticOutcome(outcome: GateOutcome): ObservedOutcome {
  return Object.freeze({
    outcome,
    exitCode: null,
    stdout: EMPTY_BYTES,
    stderr: EMPTY_BYTES,
    durationMs: 0,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
