/**
 * Per-revision gate runner (PR 41, QA-04/07/10).
 *
 * Composes the pure revision-gate domain ({@link
 * "packages/core/src/revision-gates"} in `@minions/core`) with the pinned `jj`
 * binary (PR 21), the gate receipt store (PR 25) and the change-binding store
 * (PR 29) to validate EVERY revision in a PR stack independently via `jj run`.
 *
 * Flow:
 * 1. Snapshot the registered tree's (change id, commit id) pairs before the run.
 * 2. Resolve the gate revset to the revisions to validate.
 * 3. Run every gate command against every revision with bounded parallelism.
 *    `jj run` provides an isolated working copy per revision; the runner bounds
 *    how many revisions run at once.
 * 4. Snapshot the tree again and prove no revision mutated outside the intended
 *    revset. When `trackedSourceReadOnly` is set ANY mutation fails; otherwise
 *    only mutations outside the intended revset fail.
 * 5. On unexpected mutation, roll the repo back via the op log and fail closed.
 * 6. Record one durable receipt per (revision, gate) and return the aggregate
 *    outcome. `allPassed` is `true` only when every revision passed every gate,
 *    so a green stack head fails when an intermediate revision fails.
 *
 * A test seam ({@link RevisionGateRunnerOptions.jjRunner}) lets the integration
 * tests swap in a double that scripts per-revision outcomes and tracks
 * concurrency, without spawning the pinned binary.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  classifyOutcome,
  computeEnvironmentDigest,
  contentHash,
  gitSha,
  validateNoUnexpectedMutation,
  type AttemptId,
  type Clock,
  type ContentHash,
  type DigestFunction,
  type GateCommandDescriptor,
  type GateReceipt,
  type GateReceiptRecord,
  type GateReceiptStore,
  type RevisionGateRequest,
  type RevisionGateResult,
  type RevisionIdSnapshot,
  type RevisionOutcome,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBindingStore,
} from "@minions/core";
import { buildRevisionRevset } from "@minions/core";
import type { RevsetJjRunResult } from "./revset-adapter.js";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type RevisionGateErrorCode =
  | "jj_run_failed"
  | "unexpected_mutation_detected"
  | "rollback_failed"
  | "receipt_failed"
  | "revset_invalid";

/**
 * Typed revision-gate-runner error. Fail-closed: a jj failure, an unexpected
 * mutation, a rollback failure or a receipt-store failure never silently passes
 * a gate.
 */
export class RevisionGateError extends Error {
  readonly code: RevisionGateErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: RevisionGateErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RevisionGateError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Test seam.
// -------------------------------------------------------------------------------------------------

/** Raw per-gate execution result for one revision, before receipt building. */
export type RevisionGateRawResult = Readonly<{
  gate: GateCommandDescriptor;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
  durationMs: number;
}>;

/**
 * Execute every gate command against a single revision in an isolated working
 * copy. Production spawns `jj run -r '<changeId>' -- '<cmd>'` per gate; tests
 * inject a double that returns scripted outcomes and tracks concurrency.
 */
export type RevisionGateRevisionRunner = (
  changeId: string,
  commitId: string,
  gates: readonly GateCommandDescriptor[],
) => Promise<readonly RevisionGateRawResult[]>;

/** Snapshot the (change id, commit id) pairs a revset currently resolves to. */
export type RevisionSnapshotFn = (revsetExpression: string) => Promise<RevsetJjRunResult>;

/** Capture the current jj operation id (rollback anchor). */
export type RevisionOperationIdFn = () => Promise<string>;

/** Restore the repo to a captured operation id (rollback). */
export type RevisionRestoreOpFn = (operationId: string) => Promise<void>;

/**
 * The jj surface the runner composes. Production builds this from the pinned
 * binary + working copy; tests inject a double.
 */
export type RevisionGateJjRunner = Readonly<{
  snapshot: RevisionSnapshotFn;
  runRevisionGates: RevisionGateRevisionRunner;
  currentOperationId: RevisionOperationIdFn;
  restoreOperation: RevisionRestoreOpFn;
}>;

// -------------------------------------------------------------------------------------------------
// Public surface.
// -------------------------------------------------------------------------------------------------

export type RevisionGateRunnerOptions = Readonly<{
  /** Absolute path to the pinned, digest-verified jj binary (ensureJjCapability, PR 21). */
  jjBinaryPath: string;
  /** Absolute path to the colocated jj repo the gates run against. */
  workingCopyPath: string;
  /** Durable gate receipts (PR 25). */
  gateReceiptStore: GateReceiptStore;
  /** Durable node<->change bindings (PR 29); tree scope + receipt node binding. */
  bindingStore: VcsChangeBindingStore;
  /** Wall clock for receipt capture timestamps. */
  clock: Clock;
  /** Overrides the default SHA-256 environment digest. */
  digest?: DigestFunction;
  /**
   * Test seam: the jj surface. Defaults to a production runner that spawns the
   * pinned binary. Tests pass a double that scripts per-revision outcomes.
   */
  jjRunner?: RevisionGateJjRunner;
  /** Aborts an in-flight jj invocation (production path). */
  signal?: AbortSignal;
  /** Per-invocation timeout in ms (production path, default 30s). */
  timeoutMs?: number;
  /** Bounded output ceiling in bytes (production path, default 1MiB). */
  maxOutputBytes?: number;
}>;

/** Runs the gate profile over every revision in a revset. */
export interface RevisionGateRunner {
  runRevisionGates(request: RevisionGateRequest): Promise<RevisionGateResult>;
}

/**
 * Create a revision gate runner. The runner is fail-closed: an unexpected
 * mutation, a rollback failure, a receipt-store failure or a jj failure never
 * silently passes a gate.
 */
export function createRevisionGateRunner(options: RevisionGateRunnerOptions): RevisionGateRunner {
  return new ComposedRevisionGateRunner(options);
}

// -------------------------------------------------------------------------------------------------
// Implementation.
// -------------------------------------------------------------------------------------------------

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 1_048_576;

class ComposedRevisionGateRunner implements RevisionGateRunner {
  readonly #bindingStore: VcsChangeBindingStore;
  readonly #gateReceiptStore: GateReceiptStore;
  readonly #clock: Clock;
  readonly #digest: DigestFunction;
  readonly #jjRunner: RevisionGateJjRunner;

  constructor(options: RevisionGateRunnerOptions) {
    if (
      typeof options.jjBinaryPath !== "string" ||
      !isAbsolute(options.jjBinaryPath) ||
      options.jjBinaryPath.length === 0
    ) {
      throw new RevisionGateError(
        "revset_invalid",
        "jjBinaryPath must be an absolute path",
        "Pass the binaryPath from an available ensureJjCapability probe.",
      );
    }
    if (
      typeof options.workingCopyPath !== "string" ||
      !isAbsolute(options.workingCopyPath) ||
      options.workingCopyPath.length === 0
    ) {
      throw new RevisionGateError(
        "revset_invalid",
        "workingCopyPath must be an absolute path",
        "Pass the colocated jj repo path the gates run against.",
      );
    }
    this.#bindingStore = options.bindingStore;
    this.#gateReceiptStore = options.gateReceiptStore;
    this.#clock = options.clock;
    this.#digest = options.digest ?? defaultDigest;
    this.#jjRunner = options.jjRunner ?? createProductionJjRunner(options);
  }

  async runRevisionGates(request: RevisionGateRequest): Promise<RevisionGateResult> {
    validateRevisionGateRequest(request);
    const environmentDigest = computeEnvironmentDigest(request.environment, this.#digest);

    const operationBefore = await this.#currentOperationId();
    const beforeTree = await this.#snapshotTree(request.treeId);
    const gateRevisions = await this.#snapshotRevisions(request.revsetExpression);
    if (gateRevisions.length === 0) {
      throw gateError(
        "revset_invalid",
        `revset matched no revisions: ${request.revsetExpression}`,
        "Narrow the request or register the tree's change bindings.",
      );
    }

    // Run every gate against every revision with bounded parallelism. `jj run`
    // isolates each revision's working copy; the pool bounds concurrency.
    const rawByRevision = await mapBounded(gateRevisions, request.parallelism, (revision) =>
      this.#runRevisionGatesOrFail(revision, request.gateCommands).then((rawResults) => ({
        revision,
        rawResults,
      })),
    );

    const afterTree = await this.#snapshotTree(request.treeId);
    const proof = validateNoUnexpectedMutation(request.intendedChangeIds, beforeTree, afterTree);
    const unexpected = request.trackedSourceReadOnly
      ? proof.changedChangeIds
      : proof.unexpectedChangeIds;
    if (unexpected.length > 0) {
      await this.#rollbackOrFail(operationBefore, unexpected);
    }

    const nodeByChangeId = await this.#indexNodeIds(request.treeId);
    const outcomes: RevisionOutcome[] = [];
    let allPassed = true;
    for (const { revision, rawResults } of rawByRevision) {
      const receipts = this.#buildReceipts(revision, rawResults, environmentDigest, request);
      const passed = receipts.every((receipt) => receipt.outcome === "passed");
      if (!passed) allPassed = false;
      await this.#recordReceipts(nodeByChangeId, revision.changeId, request.attemptId, receipts);
      outcomes.push(
        Object.freeze({
          changeId: revision.changeId,
          commitId: revision.commitId,
          gateResults: Object.freeze(receipts),
          passed,
        }),
      );
    }

    return Object.freeze({
      perRevision: Object.freeze(outcomes),
      allPassed,
      changedChangeIds: proof.changedChangeIds,
    });
  }

  async #snapshotTree(treeId: TaskTreeId): Promise<readonly RevisionIdSnapshot[]> {
    const bindings = await this.#bindingStore.listForTree(treeId);
    const treeChangeIds = bindings.map((binding) => binding.jjChangeId);
    return this.#snapshotRevisions(buildRevisionRevset(treeChangeIds));
  }

  async #snapshotRevisions(revsetExpression: string): Promise<readonly RevisionIdSnapshot[]> {
    let result: RevsetJjRunResult;
    try {
      result = await this.#jjRunner.snapshot(revsetExpression);
    } catch (error: unknown) {
      throw gateError(
        "revset_invalid",
        `jj log -r '${revsetExpression}' failed: ${errorMessage(error)}`,
        "Inspect the working copy; rerun host setup if the binary is missing.",
        error,
      );
    }
    if (result.exitCode !== 0) {
      throw gateError(
        "revset_invalid",
        `jj log -r '${revsetExpression}' failed: ${
          result.stderr.trim() || result.stdout.trim() || "unknown error"
        }`,
        "Inspect the revset expression and the working copy.",
      );
    }
    return parseSnapshots(result.stdout);
  }

  async #currentOperationId(): Promise<string> {
    try {
      return await this.#jjRunner.currentOperationId();
    } catch (error: unknown) {
      throw gateError(
        "jj_run_failed",
        `jj op log failed: ${errorMessage(error)}`,
        "Inspect the working copy op log.",
        error,
      );
    }
  }

  async #runRevisionGatesOrFail(
    revision: RevisionIdSnapshot,
    gates: readonly GateCommandDescriptor[],
  ): Promise<readonly RevisionGateRawResult[]> {
    try {
      return await this.#jjRunner.runRevisionGates(revision.changeId, revision.commitId, gates);
    } catch (error: unknown) {
      throw gateError(
        "jj_run_failed",
        `jj run failed for change ${revision.changeId}: ${errorMessage(error)}`,
        "Inspect the working copy; rerun host setup if the binary is missing.",
        error,
      );
    }
  }

  async #rollbackOrFail(operationBefore: string, unexpected: readonly string[]): Promise<never> {
    try {
      await this.#jjRunner.restoreOperation(operationBefore);
    } catch (error: unknown) {
      throw gateError(
        "rollback_failed",
        `rollback to operation ${operationBefore} failed after unexpected mutation: ${errorMessage(error)}`,
        "Inspect the op log; the working copy may need manual repair.",
        error,
      );
    }
    throw gateError(
      "unexpected_mutation_detected",
      `unexpected mutation outside the intended revset: ${unexpected.join(", ")}`,
      "The gate or formatter amended a revision outside the intended revset; the repo was rolled back.",
    );
  }

  #buildReceipts(
    revision: RevisionIdSnapshot,
    rawResults: readonly RevisionGateRawResult[],
    environmentDigest: ContentHash,
    request: RevisionGateRequest,
  ): GateReceipt[] {
    const headCommit = gitSha(revision.commitId);
    const receipts: GateReceipt[] = [];
    for (const [index, raw] of rawResults.entries()) {
      receipts.push(
        Object.freeze({
          gateName: raw.gate.name,
          category: raw.gate.category,
          outcome: classifyOutcome(raw.exitCode, raw.signal, raw.timedOut),
          exitCode: raw.exitCode,
          durationMs: raw.durationMs,
          stdoutDigest: byteDigest(raw.stdout),
          stderrDigest: byteDigest(raw.stderr),
          headCommit,
          profileHash: request.profileHash,
          environmentDigest,
          capturedAt: this.#clock.now(),
          sequence: index,
        }),
      );
    }
    return receipts;
  }

  async #recordReceipts(
    nodeByChangeId: ReadonlyMap<string, TaskNodeId>,
    changeId: string,
    attemptId: AttemptId | undefined,
    receipts: readonly GateReceipt[],
  ): Promise<void> {
    const nodeId = nodeByChangeId.get(changeId);
    if (nodeId === undefined) {
      throw gateError(
        "receipt_failed",
        `no node binding for change ${changeId}; cannot bind the gate receipt`,
        "Register the revision's change binding before running gates.",
      );
    }
    for (const receipt of receipts) {
      const record: GateReceiptRecord = Object.freeze({ nodeId, attemptId, receipt });
      try {
        await this.#gateReceiptStore.record(record);
      } catch (error: unknown) {
        throw gateError(
          "receipt_failed",
          `gate receipt store failed for gate ${receipt.gateName} on change ${changeId}: ${errorMessage(error)}`,
          "Inspect the gate receipt database.",
          error,
        );
      }
    }
  }

  async #indexNodeIds(treeId: TaskTreeId): Promise<ReadonlyMap<string, TaskNodeId>> {
    const bindings = await this.#bindingStore.listForTree(treeId);
    const nodeByChangeId = new Map<string, TaskNodeId>();
    for (const binding of bindings) {
      nodeByChangeId.set(binding.jjChangeId, binding.nodeId);
    }
    return nodeByChangeId;
  }
}

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/** Validate the structural shape of a {@link RevisionGateRequest}. */
function validateRevisionGateRequest(request: RevisionGateRequest): void {
  if (request.revsetExpression.length === 0) {
    throw gateError(
      "revset_invalid",
      "revsetExpression is required",
      "Build the revset with buildRevisionRevset before running gates.",
    );
  }
  if (request.intendedChangeIds.length === 0) {
    throw gateError(
      "revset_invalid",
      "intendedChangeIds must list at least one change id",
      "Pass the revset membership so the no-mutation proof can run.",
    );
  }
  if (request.gateCommands.length === 0) {
    throw gateError(
      "revset_invalid",
      "gateCommands must include at least one gate",
      "Derive the gate commands from a validated gate profile.",
    );
  }
  if (!Number.isSafeInteger(request.parallelism) || request.parallelism <= 0) {
    throw gateError(
      "revset_invalid",
      "parallelism must be a positive safe integer",
      "Set request.parallelism to the bounded concurrency across revisions.",
    );
  }
}

/** Parse `<changeId> <commitId>` lines from `jj log` stdout into snapshots. */
function parseSnapshots(stdout: string): readonly RevisionIdSnapshot[] {
  const snapshots: RevisionIdSnapshot[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const [changeId, commitId] = line.split(/\s+/u);
    if (changeId !== undefined && commitId !== undefined) {
      snapshots.push(Object.freeze({ changeId, commitId }));
    }
  }
  return Object.freeze(snapshots);
}

/**
 * Map `items` through `fn` with at most `parallelism` concurrent invocations.
 * Preserves input order in the result. The bound is observable by a test
 * double tracking concurrent entries, which is how the bounded-parallelism
 * contract is verified.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  parallelism: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  }
  const workerCount = Math.max(1, Math.min(parallelism, items.length));
  const workers: Promise<void>[] = [];
  for (let index = 0; index < workerCount; index++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// -------------------------------------------------------------------------------------------------
// Digest helpers.
// -------------------------------------------------------------------------------------------------

/** Default deterministic digest: SHA-256 over UTF-8. */
function defaultDigest(utf8: string): ContentHash {
  return contentHash(createHash("sha256").update(utf8).digest("hex"));
}

/** SHA-256 digest over raw bytes (bounded subprocess output, QA-09). */
function byteDigest(bytes: Uint8Array): ContentHash {
  return contentHash(createHash("sha256").update(bytes).digest("hex"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gateError(
  code: RevisionGateErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): RevisionGateError {
  return new RevisionGateError(code, message, remediation, cause);
}

// -------------------------------------------------------------------------------------------------
// Production jj runner: spawns the pinned binary with bounded output + timeout.
// -------------------------------------------------------------------------------------------------
type BoundedRunResult = Readonly<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
  durationMs: number;
}>;

function createProductionJjRunner(options: RevisionGateRunnerOptions): RevisionGateJjRunner {
  const binaryPath = options.jjBinaryPath;
  const cwd = options.workingCopyPath;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;

  async function snapshot(revsetExpression: string): Promise<RevsetJjRunResult> {
    const args = [
      "log",
      "--no-graph",
      "-r",
      revsetExpression,
      "-T",
      'change_id ++ " " ++ commit_id ++ "\\n"',
    ];
    const result = await runJjBounded(binaryPath, args, cwd, signal, timeoutMs, maxOutputBytes);
    return {
      exitCode: result.exitCode,
      stdout: bytesToString(result.stdout),
      stderr: bytesToString(result.stderr),
    };
  }

  async function runRevisionGates(
    changeId: string,
    commitId: string,
    gates: readonly GateCommandDescriptor[],
  ): Promise<readonly RevisionGateRawResult[]> {
    // commitId is not needed to invoke jj run (it resolves by change id); it is
    // retained on the raw result's receipt via the snapshot. Acknowledge use.
    void commitId;
    const results: RevisionGateRawResult[] = [];
    for (const gate of gates) {
      const args = ["run", "-r", changeId, "--", gate.executable, ...gate.args];
      const run = await runJjBounded(binaryPath, args, cwd, signal, timeoutMs, maxOutputBytes);
      results.push(
        Object.freeze({
          gate,
          exitCode: run.exitCode,
          signal: run.signal,
          timedOut: run.timedOut,
          stdout: run.stdout,
          stderr: run.stderr,
          durationMs: run.durationMs,
        }),
      );
    }
    return Object.freeze(results);
  }

  async function currentOperationId(): Promise<string> {
    const result = await runJjBounded(
      binaryPath,
      ["op", "log", "--no-graph", "-T", 'id ++ "\\n"', "--limit", "1"],
      cwd,
      signal,
      timeoutMs,
      maxOutputBytes,
    );
    const id = bytesToString(result.stdout)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (id === undefined) {
      throw gateError(
        "jj_run_failed",
        "jj op log returned no operation id",
        "Inspect the working copy op log.",
      );
    }
    return id;
  }

  async function restoreOperation(operationId: string): Promise<void> {
    const result = await runJjBounded(
      binaryPath,
      ["op", "restore", operationId],
      cwd,
      signal,
      timeoutMs,
      maxOutputBytes,
    );
    if (result.exitCode !== 0) {
      throw gateError(
        "rollback_failed",
        `jj op restore ${operationId} failed: ${bytesToString(result.stderr).trim()}`,
        "Inspect the op log; the working copy may need manual repair.",
      );
    }
  }

  return Object.freeze({ snapshot, runRevisionGates, currentOperationId, restoreOperation });
}

/** Bounded jj subprocess runner: timeout, output ceiling, AbortSignal, duration. */
function runJjBounded(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<BoundedRunResult> {
  return new Promise<BoundedRunResult>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(binaryPath, [...args], {
      cwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutLength + chunk.length > maxOutputBytes) {
        chunk = chunk.subarray(0, Math.max(0, maxOutputBytes - stdoutLength));
      }
      if (chunk.length > 0) {
        stdoutChunks.push(chunk);
        stdoutLength += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrLength + chunk.length > maxOutputBytes) {
        chunk = chunk.subarray(0, Math.max(0, maxOutputBytes - stderrLength));
      }
      if (chunk.length > 0) {
        stderrChunks.push(chunk);
        stderrLength += chunk.length;
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finalize = (exitCode: number | null, signalName: string | null): void => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal: signalName,
        timedOut,
        stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
        stderr: new Uint8Array(Buffer.concat(stderrChunks)),
        durationMs: Date.now() - startedAt,
      });
    };
    child.once("error", () => {
      finalize(null, null);
    });
    child.once("close", (code, signalName) => {
      finalize(code, signalName);
    });
  });
}

function bytesToString(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  return Buffer.from(bytes).toString("utf8");
}
