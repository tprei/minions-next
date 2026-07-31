/**
 * Bounded repair-retry domain (PR 26).
 *
 * Pure classification, per-node retry budgeting, no-progress signature
 * detection, and the repair decision. No I/O lives here — the repair
 * coordinator (adapters) composes this with the execution coordinator
 * (PR 23), the gate runner (PR 25), the VCS backend, and the plan registry.
 *
 * Fail-closed: every failure resolves to exactly one {@link FailureClass},
 * and {@link decideRepair} never retries a blocker, a no-progress loop, a
 * human-edit race, or an exhausted budget. QA-08; REC-08 through REC-10.
 */
import type { GateReceipt } from "./gate-runner.js";
import type { NodeOutcome } from "./execution.js";
import type { SandboxDeniedError, SandboxDenialCode } from "./sandbox.js";
import type { AttemptId, ContentHash, GitSha, TaskNodeId, TaskTreeId } from "./value-objects.js";

// -------------------------------------------------------------------------------------------------
// Failure classification.
// -------------------------------------------------------------------------------------------------

/**
 * Terminal classification of a failed attempt. The three blocker classes
 * (`auth_blocker`, `isolation_blocker`, `config_blocker`) consume NO coding
 * tokens: {@link decideRepair} escalates them immediately (acceptance).
 */
export type FailureClass =
  | "gate_failure"
  | "sandbox_failure"
  | "harness_failure"
  | "auth_blocker"
  | "isolation_blocker"
  | "config_blocker"
  | "infrastructure_error"
  | "human_intervention_required";

/**
 * Membership table over the full {@link FailureClass} union. `true` marks a
 * blocker class that escalates immediately and consumes no coding tokens.
 * Declared as a complete `Record` so the compiler fails closed when a new
 * class is added.
 */
export const IS_BLOCKER_FAILURE_CLASS: Readonly<Record<FailureClass, boolean>> = Object.freeze({
  gate_failure: false,
  sandbox_failure: false,
  harness_failure: false,
  auth_blocker: true,
  isolation_blocker: true,
  config_blocker: true,
  infrastructure_error: false,
  human_intervention_required: false,
});

/**
 * Membership table for terminal classes (fail-closed: no retry, no escalation
 * loop). Complete `Record` for the same fail-closed guarantee.
 */
export const IS_TERMINAL_FAILURE_CLASS: Readonly<Record<FailureClass, boolean>> = Object.freeze({
  gate_failure: false,
  sandbox_failure: false,
  harness_failure: false,
  auth_blocker: false,
  isolation_blocker: false,
  config_blocker: false,
  infrastructure_error: true,
  human_intervention_required: true,
});

/**
 * Exhaustive mapping of every {@link SandboxDenialCode} to a failure class.
 * Declared as a `Record` so the compiler fails closed when a new denial code
 * is added without a classification.
 */
const SANDBOX_DENIAL_CLASS: Readonly<Record<SandboxDenialCode, FailureClass>> = Object.freeze({
  // Authentication surfaced through the sandbox (credential vault / git creds).
  home_credentials: "auth_blocker",
  git_credential_blocked: "auth_blocker",
  // Isolation: the sandbox refused an escape, network reach, or mount.
  backend_unavailable: "isolation_blocker",
  backend_unconfined: "isolation_blocker",
  instance_not_found: "isolation_blocker",
  invalid_state: "isolation_blocker",
  process_escape: "isolation_blocker",
  device: "isolation_blocker",
  control_socket: "isolation_blocker",
  symlink_escape: "isolation_blocker",
  path_traversal: "isolation_blocker",
  absolute_host_path: "isolation_blocker",
  sibling_workspace: "isolation_blocker",
  read_only_mount: "isolation_blocker",
  mount_not_allowed: "isolation_blocker",
  executable_not_allowed: "isolation_blocker",
  network_private: "isolation_blocker",
  network_loopback: "isolation_blocker",
  network_link_local: "isolation_blocker",
  network_metadata: "isolation_blocker",
  network_host_denied: "isolation_blocker",
  // Configuration: the declared policy or limits are wrong/too tight.
  invalid_policy: "config_blocker",
  policy_fingerprint_mismatch: "config_blocker",
  idempotency_conflict: "config_blocker",
  git_commit_blocked: "config_blocker",
  git_branch_blocked: "config_blocker",
  git_remote_blocked: "config_blocker",
  git_push_blocked: "config_blocker",
  git_fetch_blocked: "config_blocker",
  git_worktree_blocked: "config_blocker",
  output_limit: "config_blocker",
  timeout_limit: "config_blocker",
  resource_limit: "config_blocker",
});

/**
 * Pure failure classification. Given the coordinator outcome, the gate
 * receipts captured for the attempt, and the optional sandbox denial, resolve
 * exactly one {@link FailureClass}.
 *
 * Precedence: a sandbox denial (blocker) wins — these consume no coding
 * tokens. Then gate outcomes (`missing_executable` is a config blocker; any
 * other non-passing gate is a gate failure). Then the harness outcome itself.
 */
export function classifyFailure(
  outcome: NodeOutcome,
  gateReceipts: readonly GateReceipt[],
  sandboxError?: SandboxDeniedError,
): FailureClass {
  if (sandboxError !== undefined) {
    return SANDBOX_DENIAL_CLASS[sandboxError.code];
  }
  for (const receipt of gateReceipts) {
    if (receipt.outcome === "missing_executable") {
      return "config_blocker";
    }
    if (receipt.outcome !== "passed") {
      return "gate_failure";
    }
  }
  if (outcome.kind === "failed") {
    return "harness_failure";
  }
  if (outcome.kind === "cancelled") {
    return "infrastructure_error";
  }
  // A succeeded outcome with no failing gate is not a failure at all; fail
  // closed rather than silently retrying an unknown state.
  return "human_intervention_required";
}

// -------------------------------------------------------------------------------------------------
// No-progress signature.
// -------------------------------------------------------------------------------------------------

/**
 * Deterministic signature for no-progress detection. Two attempts with the
 * same failure class, the same changed-paths fingerprint, the same head
 * commit, and the same output fingerprint made no progress — retrying would
 * loop. REC-09.
 */
export type NoProgressSignature = Readonly<{
  failureClass: FailureClass;
  changedPathsDigest: ContentHash;
  headCommit: GitSha;
  outputDigest: ContentHash;
}>;

/** Structural equality for two no-progress signatures (all four fields). */
export function signaturesEqual(left: NoProgressSignature, right: NoProgressSignature): boolean {
  return (
    left.failureClass === right.failureClass &&
    left.changedPathsDigest === right.changedPathsDigest &&
    left.headCommit === right.headCommit &&
    left.outputDigest === right.outputDigest
  );
}

/**
 * True when `signature` matches any prior signature. The repair coordinator
 * calls this before deciding to retry so an identical repeat escalates
 * immediately instead of looping (REC-09).
 */
export function isNoProgress(
  previousSignatures: readonly NoProgressSignature[],
  signature: NoProgressSignature,
): boolean {
  return previousSignatures.some((prior) => signaturesEqual(prior, signature));
}

// -------------------------------------------------------------------------------------------------
// Retry budget.
// -------------------------------------------------------------------------------------------------

/**
 * Independent per-node retry budget. `nodeBudget` is the absolute per-node
 * ceiling; `ceiling` is the effective cap (equal to `nodeBudget` by default,
 * lowered when a retry is known-futile); `consumed`/`remaining` track usage.
 * Default ceiling: {@link DEFAULT_REPAIR_CEILING}.
 */
export type RetryBudget = Readonly<{
  nodeBudget: number;
  consumed: number;
  ceiling: number;
  remaining: number;
}>;

/** Default per-node repair ceiling (REC-08: bounded, visible retry scopes). */
export const DEFAULT_REPAIR_CEILING = 3;

/**
 * Build a fresh per-node budget. `consumed` defaults to 0; `ceiling` and
 * `nodeBudget` are pinned to the supplied ceiling.
 */
export function createRetryBudget(ceiling: number, consumed = 0): RetryBudget {
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    throw new RangeError(`retry ceiling must be a non-negative integer, got ${String(ceiling)}`);
  }
  if (!Number.isSafeInteger(consumed) || consumed < 0) {
    throw new RangeError(`consumed must be a non-negative integer, got ${String(consumed)}`);
  }
  const effectiveConsumed = Math.min(consumed, ceiling);
  return Object.freeze({
    nodeBudget: ceiling,
    consumed: effectiveConsumed,
    ceiling,
    remaining: Math.max(0, ceiling - effectiveConsumed),
  });
}

/** True when the budget still allows another attempt. */
export function canRetry(budget: RetryBudget): boolean {
  return budget.remaining > 0;
}

/** Return a budget with one attempt consumed (immutable). */
export function consume(budget: RetryBudget): RetryBudget {
  return createRetryBudget(budget.ceiling, budget.consumed + 1);
}

// -------------------------------------------------------------------------------------------------
// Repair decision.
// -------------------------------------------------------------------------------------------------

/** The coordinator's verdict for a failed attempt. */
export type RepairAction = "retry" | "escalate" | "terminal";

export type RepairDecision = Readonly<{
  action: RepairAction;
  /** Human-readable reason (carried into the terminal attention). */
  reason: string;
  failureClass: FailureClass;
  budget: RetryBudget;
  /** True when escalation is driven by a repeated no-progress signature. */
  noProgress: boolean;
}>;

/**
 * Pure repair decision. The single source of truth for retry vs escalate vs
 * terminal:
 * - Blocker class (auth/isolation/config) → escalate immediately (no tokens).
 * - Terminal class (infrastructure/human-intervention) → terminal (fail closed).
 * - Human edited files between attempts → escalate (do not loop on human edits).
 * - No-progress (signature seen before) → escalate.
 * - Budget exhausted → escalate.
 * - Otherwise → retry.
 */
export function decideRepair(
  failureClass: FailureClass,
  budget: RetryBudget,
  previousSignatures: readonly NoProgressSignature[],
  currentSignature: NoProgressSignature,
  humanChangedFiles: boolean,
): RepairDecision {
  if (IS_BLOCKER_FAILURE_CLASS[failureClass]) {
    return Object.freeze({
      action: "escalate",
      reason: `blocker class '${failureClass}' requires human action; no coding retry`,
      failureClass,
      budget,
      noProgress: false,
    });
  }
  if (IS_TERMINAL_FAILURE_CLASS[failureClass]) {
    return Object.freeze({
      action: "terminal",
      reason: `terminal failure class '${failureClass}'`,
      failureClass,
      budget,
      noProgress: false,
    });
  }
  if (humanChangedFiles) {
    return Object.freeze({
      action: "escalate",
      reason: "human modified the working copy between attempts; refusing to loop",
      failureClass,
      budget,
      noProgress: false,
    });
  }
  if (isNoProgress(previousSignatures, currentSignature)) {
    return Object.freeze({
      action: "escalate",
      reason: "no progress: identical failure signature repeated",
      failureClass,
      budget,
      noProgress: true,
    });
  }
  if (!canRetry(budget)) {
    return Object.freeze({
      action: "escalate",
      reason: "retry budget exhausted",
      failureClass,
      budget,
      noProgress: false,
    });
  }
  return Object.freeze({
    action: "retry",
    reason: "retryable failure within budget",
    failureClass,
    budget,
    noProgress: false,
  });
}

// -------------------------------------------------------------------------------------------------
// Terminal attention + outcome.
// -------------------------------------------------------------------------------------------------

/** Why a repair escalated to typed human attention. */
export type RepairAttentionKind = "blocked" | "no_progress" | "budget_exhausted" | "human_change";

/**
 * A reference to one attempt's preserved evidence. Transcripts and gate
 * receipts are append-only (QA-08); repair never erases them.
 */
export type RepairEvidenceRef = Readonly<{
  attemptId: AttemptId;
  outcomeText: string;
  gateReceiptSequences: readonly number[];
}>;

/**
 * Typed terminal attention produced when a repair escalates. Carries the
 * failure class, the attempt count, and references to every preserved
 * attempt so a human can review without losing evidence.
 */
export type RepairAttention = Readonly<{
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  failureClass: FailureClass;
  attemptCount: number;
  evidenceRefs: readonly RepairEvidenceRef[];
  attentionKind: RepairAttentionKind;
  /** Human-readable escalation reason (mirrors the triggering decision). */
  reason: string;
}>;

/** Evidence captured for one repair attempt (never erased across retries). */
export type RepairAttemptEvidence = Readonly<{
  attemptId: AttemptId;
  failureClass: FailureClass;
  /** The coordinator outcome, or `undefined` when the attempt threw before producing one. */
  outcome: NodeOutcome | undefined;
  gateReceipts: readonly GateReceipt[];
  signature: NoProgressSignature;
  /** Set when the attempt threw (sandbox/coordinator error) instead of producing an outcome. */
  errorMessage: string | undefined;
}>;

/** Terminal status of a repair run. */
export type RepairStatus = "repaired" | "escalated";

/** The full outcome of a bounded repair run. */
export type RepairOutcome = Readonly<{
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  status: RepairStatus;
  /** Every attempt, in order — preserved evidence (QA-08). */
  attempts: readonly RepairAttemptEvidence[];
  budget: RetryBudget;
  /** The decision that ended an escalated run; `undefined` when the node was repaired. */
  decision: RepairDecision | undefined;
  /** Present iff the run escalated. */
  attention: RepairAttention | undefined;
}>;
