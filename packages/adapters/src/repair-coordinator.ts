/**
 * Repair coordinator (PR 26).
 *
 * Composes the execution coordinator (PR 23), the gate runner (PR 25), the
 * VCS backend, and a repair-attention sink into a single bounded repair-retry
 * loop for one failed node:
 *
 *   classify → decide (retry | escalate | terminal) → budget → no-progress →
 *   human-change guard → re-run (same working copy) → preserve every attempt.
 *
 * Scopes to the single failed node only — no ancestor or sibling is re-run.
 * Evidence (transcripts, outcomes, gate receipts) is append-only: repair never
 * erases prior attempts (QA-08; REC-08 through REC-10).
 */
import { createHash } from "node:crypto";

import {
  classifyFailure,
  consume,
  contentHash,
  createRetryBudget,
  decideRepair,
  DEFAULT_REPAIR_CEILING,
  ExecutionCoordinatorError,
  SandboxDeniedError,
  type AttemptId,
  type ContentHash,
  type DigestFunction,
  type ExecutionCoordinator,
  type ExecutionCoordinatorErrorCode,
  type ExecutionCoordinatorLogger,
  type FailureClass,
  type GateReceipt,
  type GateRunRequest,
  type GateRunner,
  type GitSha,
  type HarnessUsage,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeOutcome,
  type NoProgressSignature,
  type RepairAttemptEvidence,
  type RepairAttention,
  type RepairAttentionKind,
  type RepairDecision,
  type RepairOutcome,
  type RetryBudget,
  type TaskNodeId,
  type TaskTreeId,
  type VcsBackend,
  type VcsWorkingCopyRef,
  type WorkspaceStatus,
} from "@minions/core";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type RepairCoordinatorErrorCode = "invalid_input" | "gate_run_failed" | "vcs_failed";

/** Typed repair-coordinator error. Fail-closed: a port failure surfaces one. */
export class RepairCoordinatorError extends Error {
  readonly code: RepairCoordinatorErrorCode;

  constructor(code: RepairCoordinatorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepairCoordinatorError";
    this.code = code;
  }
}

// -------------------------------------------------------------------------------------------------
// Ports + options.
// -------------------------------------------------------------------------------------------------

/**
 * Persistence seam for a {@link RepairAttention}. In production this is backed
 * by the plan registry / steering store; the coordinator depends only on the
 * port so tests can supply an in-memory sink.
 */
export interface RepairAttentionSink {
  /** Persist a terminal repair attention. Returning it confirms storage. */
  record(attention: RepairAttention): Promise<RepairAttention>;
}

export type RepairCoordinatorOptions = Readonly<{
  /** Runs each repair attempt end to end (claim → sandbox → harness → outcome). */
  coordinator: ExecutionCoordinator;
  /** Runs blocking gates against the fresh head after each attempt. */
  gateRunner: GateRunner;
  /** Captures working-copy status for human-change + no-progress detection. */
  vcs: VcsBackend;
  /** Persists terminal repair attentions. */
  attentionSink: RepairAttentionSink;
  /** Overrides the default SHA-256 digest (changed-paths + output fingerprints). */
  digest?: DigestFunction;
  /** Lifecycle logs; defaults to a silent logger. */
  logger?: ExecutionCoordinatorLogger;
}>;

/** Input for a single bounded repair run over one failed node. */
export type AttemptRepairInput = Readonly<{
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  /** The request re-run on every attempt (same working copy — same session). */
  request: NodeExecutionRequest;
  /** The stable working copy the repair operates over (VCS status/diff source). */
  workingCopy: VcsWorkingCopyRef;
  /**
   * Base gate-run request. Per attempt the coordinator freshens `headCommit`
   * (to the post-attempt head) and `attemptId`. Omit when the node has no
   * blocking gates — repair then succeeds on a harness success alone.
   */
  gates?: GateRunRequest;
  /** Overrides the per-node retry ceiling (default {@link DEFAULT_REPAIR_CEILING}). */
  ceiling?: number;
}>;

/** A bounded repair-retry coordinator scoped to a single failed node. */
export interface RepairCoordinator {
  attemptRepair(input: AttemptRepairInput): Promise<RepairOutcome>;
}

// -------------------------------------------------------------------------------------------------
// Internal helpers.
// -------------------------------------------------------------------------------------------------

const SILENT_LOGGER: ExecutionCoordinatorLogger = Object.freeze({
  log: () => undefined,
});

const ZERO_USAGE: HarnessUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});

const TEXT_DECODER = new TextDecoder();

/** Deterministic SHA-256 digest over UTF-8 (default fingerprint). */
function defaultDigest(utf8: string): ContentHash {
  return contentHash(createHash("sha256").update(utf8).digest("hex"));
}

/**
 * Map a thrown {@link ExecutionCoordinatorError} code to a failure class. A
 * down/unconfigured sandbox or policy escalates as a blocker (no tokens); an
 * unavailable harness or lease/transcript/outcome port failure is terminal
 * infrastructure (fail-closed, no retry).
 */
function classifyCoordinatorError(code: ExecutionCoordinatorErrorCode): FailureClass {
  switch (code) {
    case "sandbox_unavailable":
      return "isolation_blocker";
    case "policy_violation":
      return "config_blocker";
    case "harness_unavailable":
    case "not_leased":
    case "interrupted":
    case "checkpoint_failed":
    case "transcript_failed":
    case "outcome_failed":
      return "infrastructure_error";
  }
}

/** A captured working-copy state used for human-change + signature detection. */
type WorkingCopySnapshot = Readonly<{
  headCommit: GitSha;
  porcelainDigest: ContentHash;
  diffDigest: ContentHash;
}>;

function toSnapshot(
  status: WorkspaceStatus,
  byteDigest: (bytes: Uint8Array) => ContentHash,
): WorkingCopySnapshot {
  return {
    headCommit: status.headCommit,
    porcelainDigest: byteDigest(status.porcelainV2),
    diffDigest: byteDigest(status.diff),
  };
}

function snapshotsEqual(left: WorkingCopySnapshot, right: WorkingCopySnapshot): boolean {
  return (
    left.headCommit === right.headCommit &&
    left.porcelainDigest === right.porcelainDigest &&
    left.diffDigest === right.diffDigest
  );
}

/**
 * Build the no-progress signature for one attempt from its post-attempt
 * snapshot, outcome text, and gate receipts. Two attempts with the same
 * signature made no progress (REC-09).
 */
function buildSignature(
  failureClass: FailureClass,
  snapshot: WorkingCopySnapshot,
  outcomeText: string,
  gateReceipts: readonly GateReceipt[],
  digest: DigestFunction,
): NoProgressSignature {
  const gatePart = gateReceipts
    .map(
      (receipt) =>
        `${receipt.gateName}:${receipt.outcome}:${receipt.stdoutDigest}:${receipt.stderrDigest}`,
    )
    .join("|");
  return Object.freeze({
    failureClass,
    changedPathsDigest: snapshot.porcelainDigest,
    headCommit: snapshot.headCommit,
    outputDigest: digest(`${outcomeText}\n${gatePart}`),
  });
}

/** A coordinator outcome synthesized when an attempt threw before producing one. */
function synthesizedFailedOutcome(
  nodeId: TaskNodeId,
  attemptIdValue: AttemptId,
  message: string,
): NodeOutcome {
  return Object.freeze({
    nodeId,
    attemptId: attemptIdValue,
    kind: "failed",
    text: message,
    artifacts: [],
    revision: undefined,
    usage: ZERO_USAGE,
  });
}

function evidenceRefsFromAttempts(attempts: readonly RepairAttemptEvidence[]) {
  return attempts.map((attempt) =>
    Object.freeze({
      attemptId: attempt.attemptId,
      outcomeText: attempt.outcome?.text ?? attempt.errorMessage ?? "",
      gateReceiptSequences: attempt.gateReceipts.map((receipt) => receipt.sequence),
    }),
  );
}

function attentionKindForDecision(decision: RepairDecision): RepairAttentionKind {
  if (decision.noProgress) {
    return "no_progress";
  }
  return "blocked";
}

/** What a thrown attempt captured, for classification + evidence. */
type ThrownAttempt = Readonly<{
  sandbox?: SandboxDeniedError;
  failureClass?: FailureClass;
  message: string;
}>;

// -------------------------------------------------------------------------------------------------
// Factory.
// -------------------------------------------------------------------------------------------------

/**
 * Compose the execution coordinator, gate runner, VCS backend, and repair
 * attention sink into a bounded repair-retry coordinator. The coordinator
 * depends only on ports — concrete adapters are injected, never imported.
 */
export function createRepairCoordinator(options: RepairCoordinatorOptions): RepairCoordinator {
  const digest: DigestFunction = options.digest ?? defaultDigest;
  const byteDigest = (bytes: Uint8Array): ContentHash => digest(TEXT_DECODER.decode(bytes));
  const logger: ExecutionCoordinatorLogger = options.logger ?? SILENT_LOGGER;
  return new ComposedRepairCoordinator(
    options.coordinator,
    options.gateRunner,
    options.vcs,
    options.attentionSink,
    digest,
    byteDigest,
    logger,
  );
}

class ComposedRepairCoordinator implements RepairCoordinator {
  readonly #coordinator: ExecutionCoordinator;
  readonly #gateRunner: GateRunner;
  readonly #vcs: VcsBackend;
  readonly #attentionSink: RepairAttentionSink;
  readonly #digest: DigestFunction;
  readonly #byteDigest: (bytes: Uint8Array) => ContentHash;
  readonly #logger: ExecutionCoordinatorLogger;

  constructor(
    coordinator: ExecutionCoordinator,
    gateRunner: GateRunner,
    vcs: VcsBackend,
    attentionSink: RepairAttentionSink,
    digest: DigestFunction,
    byteDigest: (bytes: Uint8Array) => ContentHash,
    logger: ExecutionCoordinatorLogger,
  ) {
    this.#coordinator = coordinator;
    this.#gateRunner = gateRunner;
    this.#vcs = vcs;
    this.#attentionSink = attentionSink;
    this.#digest = digest;
    this.#byteDigest = byteDigest;
    this.#logger = logger;
  }

  async attemptRepair(input: AttemptRepairInput): Promise<RepairOutcome> {
    const ceiling = input.ceiling ?? DEFAULT_REPAIR_CEILING;
    if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
      throw new RepairCoordinatorError(
        "invalid_input",
        `ceiling must be a non-negative integer, got ${String(ceiling)}`,
      );
    }
    let budget: RetryBudget = createRetryBudget(ceiling);
    const signatures: NoProgressSignature[] = [];
    const attempts: RepairAttemptEvidence[] = [];
    let lastAttempt: RepairAttemptEvidence | undefined;
    let lastPostSnapshot: WorkingCopySnapshot | undefined;

    // Loop invariant: each iteration runs exactly one attempt (or escalates
    // before running). The budget bounds total attempts to `ceiling`.
    for (;;) {
      // Budget guard — fires after `ceiling` attempts without success.
      if (lastAttempt !== undefined && budget.remaining <= 0) {
        return await this.#escalate(
          input,
          attempts,
          budget,
          {
            action: "escalate",
            reason: "retry budget exhausted",
            failureClass: lastAttempt.failureClass,
            budget,
            noProgress: false,
          },
          "budget_exhausted",
        );
      }

      // Human-change guard — fires before any retry that would follow a human
      // edit, so no coding tokens are spent looping on human-introduced state.
      if (lastAttempt !== undefined && lastPostSnapshot !== undefined) {
        const currentSnapshot = await this.#captureSnapshot(input.workingCopy);
        if (!snapshotsEqual(currentSnapshot, lastPostSnapshot)) {
          const decision = decideRepair(
            lastAttempt.failureClass,
            budget,
            signatures,
            lastAttempt.signature,
            true,
          );
          return await this.#escalate(input, attempts, budget, decision, "human_change");
        }
      }

      // Run one attempt (same working copy — same session).
      const attemptIdValue = input.request.context.attemptId;
      let result: NodeExecutionResult | undefined;
      let thrown: ThrownAttempt | undefined;
      try {
        result = await this.#coordinator.runNode(input.request);
      } catch (error) {
        thrown = this.#captureThrown(error);
        this.#logger.log("warn", "repair_attempt_threw", {
          node_id: input.nodeId,
          attempt_id: attemptIdValue,
          error: thrown.message,
        });
      }

      // Capture the post-attempt working-copy state.
      const postSnapshot = await this.#captureSnapshot(input.workingCopy);
      lastPostSnapshot = postSnapshot;

      // Run gates against the fresh head (only when the attempt produced a result).
      let gateReceipts: readonly GateReceipt[] = [];
      if (result !== undefined && input.gates !== undefined) {
        gateReceipts = await this.#runGates(input.gates, postSnapshot.headCommit, attemptIdValue);
      }

      // Classify the failure.
      const outcome: NodeOutcome =
        result?.outcome ??
        synthesizedFailedOutcome(input.nodeId, attemptIdValue, thrown?.message ?? "attempt failed");
      const failureClass =
        thrown?.failureClass ?? classifyFailure(outcome, gateReceipts, thrown?.sandbox);

      // Success short-circuits — harness succeeded AND every gate passes. The
      // successful attempt is the terminal state; only failed attempts are
      // retained as repair evidence.
      if (
        result !== undefined &&
        outcome.kind === "succeeded" &&
        gateReceipts.every((receipt) => receipt.outcome === "passed")
      ) {
        this.#logger.log("info", "repair_succeeded", {
          node_id: input.nodeId,
          attempts: attempts.length + 1,
        });
        return Object.freeze({
          nodeId: input.nodeId,
          treeId: input.treeId,
          status: "repaired",
          attempts: Object.freeze([...attempts]),
          budget,
          decision: undefined,
          attention: undefined,
        });
      }

      const signature = buildSignature(
        failureClass,
        postSnapshot,
        outcome.text,
        gateReceipts,
        this.#digest,
      );
      const decision = decideRepair(failureClass, budget, signatures, signature, false);

      const evidence: RepairAttemptEvidence = Object.freeze({
        attemptId: attemptIdValue,
        failureClass,
        outcome: result?.outcome,
        gateReceipts: Object.freeze([...gateReceipts]),
        signature,
        errorMessage: thrown?.message,
      });
      attempts.push(evidence);
      signatures.push(signature);
      lastAttempt = evidence;
      budget = consume(budget);

      if (decision.action === "retry") {
        continue;
      }
      return await this.#escalate(
        input,
        attempts,
        budget,
        decision,
        attentionKindForDecision(decision),
      );
    }
  }

  #captureThrown(error: unknown): ThrownAttempt {
    if (error instanceof SandboxDeniedError) {
      return { sandbox: error, message: error.message };
    }
    if (error instanceof ExecutionCoordinatorError) {
      return { failureClass: classifyCoordinatorError(error.code), message: error.message };
    }
    return { message: error instanceof Error ? error.message : String(error) };
  }

  async #captureSnapshot(workingCopy: VcsWorkingCopyRef): Promise<WorkingCopySnapshot> {
    try {
      const status = await this.#vcs.captureStatus(workingCopy);
      return toSnapshot(status, this.#byteDigest);
    } catch (error) {
      throw new RepairCoordinatorError(
        "vcs_failed",
        `captureStatus failed during repair: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async #runGates(
    base: GateRunRequest,
    headCommit: GitSha,
    attemptIdValue: AttemptId,
  ): Promise<readonly GateReceipt[]> {
    const request: GateRunRequest = { ...base, headCommit, attemptId: attemptIdValue };
    try {
      return await this.#gateRunner.runGates(request);
    } catch (error) {
      throw new RepairCoordinatorError(
        "gate_run_failed",
        `gate runner failed during repair: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async #escalate(
    input: AttemptRepairInput,
    attempts: RepairAttemptEvidence[],
    budget: RetryBudget,
    decision: RepairDecision,
    attentionKind: RepairAttentionKind,
  ): Promise<RepairOutcome> {
    const attention: RepairAttention = Object.freeze({
      nodeId: input.nodeId,
      treeId: input.treeId,
      failureClass: decision.failureClass,
      attemptCount: attempts.length,
      evidenceRefs: Object.freeze(evidenceRefsFromAttempts(attempts)),
      attentionKind,
      reason: decision.reason,
    });
    this.#logger.log("warn", "repair_escalated", {
      node_id: input.nodeId,
      attention_kind: attentionKind,
      failure_class: decision.failureClass,
      attempts: attempts.length,
    });
    // Persistence is best-effort: the outcome always carries the attention so
    // the caller can act even if the sink is unavailable.
    try {
      await this.#attentionSink.record(attention);
    } catch (error) {
      this.#logger.log("error", "repair_attention_persist_failed", {
        node_id: input.nodeId,
        attention_kind: attentionKind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return Object.freeze({
      nodeId: input.nodeId,
      treeId: input.treeId,
      status: "escalated",
      attempts: Object.freeze([...attempts]),
      budget,
      decision,
      attention,
    });
  }
}
