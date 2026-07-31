/**
 * Remote-CI manager (PR 35) — observes GitHub CI checks for an exact head SHA,
 * classifies them as deterministic evidence, polls until complete, attempts
 * same-session repair of node failures, re-pushes, re-observes, and invalidates
 * stale checks.
 *
 * ## Composition
 * - GitHubClient (PR 31) via {@link GitHubAppAuth} — fetch check runs, combined
 *   status, and the PR head/base SHAs.
 * - Repair harness (PR 26) — re-run the failed node in the same session; the
 *   harness returns a {@link RepairOutcome} whose `status`/`attention` drive
 *   the repair decision.
 * - PushManager (PR 32) — re-push the repaired commit under a lease.
 *
 * ## Fail-closed evidence (QA-06..QA-10)
 * Evidence is built by the pure {@link classifyOverall} / {@link isCheckPassing}
 * domain. ONLY a `success` verdict counts as passing; missing/skipped/neutral/
 * cancelled/timed-out/stale/unknown never do. A check whose `headSha` differs
 * from the PR head is flagged `stale` by the domain regardless of conclusion.
 *
 * ## Repair budget + no-progress
 * `attemptCiRepair` is bounded by a {@link RetryBudget}. A repeated failing
 * signature (same set of failing required checks after a repaired re-push) is
 * detected as no-progress and escalated rather than looped. Base failures
 * (hard-red on both head and base) are never repaired — they are infrastructure.
 */
import {
  classifyOverall,
  allRequiredPresent,
  isBaseFailure,
  isFailureVerdict,
  isStaleCheck,
  isTerminalVerdict,
  type CheckObservation,
  type CheckVerdict,
  type CiEvidence,
  type GitSha,
  type RepairAttention,
  type RepairOutcome,
  type RequiredCheckSet,
  type RetryBudget,
  type ContentHash,
  type TaskNodeId,
  type TaskTreeId,
} from "@minions/core";
import { consume, gitSha } from "@minions/core";

import {
  GitHubClientError,
  type GitHubCheckConclusion,
  type GitHubCheckRun,
  type GitHubClient,
  type GitHubCombinedStatus,
} from "./github-client.js";
import { GitHubAppAuthError, type GitHubAppAuth } from "./github-app-auth.js";
import type { PushManager } from "./github-push.js";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type RemoteCiErrorCode =
  | "check_fetch_failed"
  | "required_check_missing"
  | "base_failure_detected"
  | "repair_exhausted"
  | "push_failed"
  | "timeout"
  | "pr_not_found"
  | "auth_failed"
  | "api_error";

/** Typed remote-CI error. Fail-closed: any port failure surfaces one. */
export class RemoteCiError extends Error {
  readonly code: RemoteCiErrorCode;
  override readonly cause: unknown;

  constructor(code: RemoteCiErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RemoteCiError";
    this.code = code;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Repair harness port.
// -------------------------------------------------------------------------------------------------

/**
 * Same-session node repair (PR 26). Re-runs the failed node and returns its
 * bounded repair outcome. In production this is wired from
 * {@link createRepairCoordinator}; tests inject a stub. The manager depends
 * only on the port so no concrete coordinator is imported here.
 */
export interface CiRepairHarness {
  attemptNodeRepair(input: CiNodeRepairInput): Promise<RepairOutcome>;
}

/** Input to one repair attempt for the node whose CI failed. */
export interface CiNodeRepairInput {
  readonly nodeId: TaskNodeId;
  readonly treeId: TaskTreeId;
  /** The check names that are currently hard-red on the head. */
  readonly failingChecks: readonly string[];
  /** The head SHA the failing checks ran against. */
  readonly headSha: GitSha;
}

// -------------------------------------------------------------------------------------------------
// Public input/output records.
// -------------------------------------------------------------------------------------------------

export interface RemoteCiObservationInput {
  readonly repositoryFullName: string;
  readonly prNumber: number;
  readonly requiredChecks: RequiredCheckSet;
}

export interface RemoteCiWaitInput {
  readonly repositoryFullName: string;
  readonly prNumber: number;
  readonly requiredChecks: RequiredCheckSet;
  /** Deadline in milliseconds from the call start. */
  readonly timeoutMs: number;
  /** Override the poll interval (default 1s); inject a 0-ms interval in tests. */
  readonly pollIntervalMs?: number;
}

/**
 * Context needed to repair a node whose CI failed: the node identity, the jj
 * change to re-export and re-push, the bookmark, and the repair budget.
 */
export interface RemoteCiRepairInput {
  readonly repositoryFullName: string;
  readonly prNumber: number;
  /** The failing head evidence to repair. */
  readonly evidence: CiEvidence;
  readonly requiredChecks: RequiredCheckSet;
  readonly repairContext: {
    readonly nodeId: TaskNodeId;
    readonly treeId: TaskTreeId;
    readonly jjChangeId: ContentHash;
    readonly bookmark: string;
    /** Lease: the head SHA the caller believes is currently remote (or undefined). */
    readonly expectedRemoteHeadSha: GitSha | undefined;
    readonly budget: RetryBudget;
  };
}

/** Terminal status of a CI repair run. */
export type CiRepairOutcomeStatus = "repaired" | "escalated" | "base_failure" | "no_progress";

/** The full outcome of a bounded CI repair run. */
export interface CiRepairOutcome {
  readonly status: CiRepairOutcomeStatus;
  /** Re-observed evidence after a successful repair; the original evidence otherwise. */
  readonly evidence: CiEvidence;
  /** Number of repair attempts actually performed. */
  readonly attempts: number;
  /** Present when the run escalated to typed human attention. */
  readonly attention: RepairAttention | undefined;
  /** Required check names still hard-red on the (final) head. */
  readonly failingChecks: readonly string[];
  /** Human-readable reason mirroring the triggering decision. */
  readonly reason: string;
}

// -------------------------------------------------------------------------------------------------
// Manager.
// -------------------------------------------------------------------------------------------------

export interface RemoteCiManagerOptions {
  readonly auth: GitHubAppAuth;
  /** Injectable clock returning epoch milliseconds (testing). */
  readonly now?: () => number;
  /** Injectable sleeper for polling (testing); defaults to a real timeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RemoteCiManager {
  observeCi(input: RemoteCiObservationInput): Promise<CiEvidence>;
  waitForChecks(input: RemoteCiWaitInput): Promise<CiEvidence>;
  attemptCiRepair(
    input: RemoteCiRepairInput,
    deps: Readonly<{ harness: CiRepairHarness; push: PushManager }>,
  ): Promise<CiRepairOutcome>;
  invalidateStaleChecks(
    input: RemoteCiObservationInput & { readonly currentHeadSha: GitSha },
  ): Promise<CiEvidence>;
}

export function createRemoteCiManager(options: RemoteCiManagerOptions): RemoteCiManager {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  return new RemoteCiManagerImpl(options.auth, now, sleep);
}

const defaultPollIntervalMs = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// -------------------------------------------------------------------------------------------------
// Implementation.
// -------------------------------------------------------------------------------------------------

class RemoteCiManagerImpl implements RemoteCiManager {
  constructor(
    private readonly auth: GitHubAppAuth,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}
  async observeCi(input: RemoteCiObservationInput): Promise<CiEvidence> {
    return this.observeInternal(input.repositoryFullName, input.prNumber, input.requiredChecks);
  }

  async waitForChecks(input: RemoteCiWaitInput): Promise<CiEvidence> {
    const interval = input.pollIntervalMs ?? defaultPollIntervalMs;
    const deadline = this.now() + input.timeoutMs;
    // First observation is immediate; subsequent ones wait `interval`.
    let evidence = await this.observeInternal(
      input.repositoryFullName,
      input.prNumber,
      input.requiredChecks,
    );
    for (;;) {
      if (allRequiredTerminal(evidence, input.requiredChecks)) {
        return evidence;
      }
      if (this.now() >= deadline) {
        throw new RemoteCiError(
          "timeout",
          `timed out after ${String(input.timeoutMs)}ms waiting for required checks ` +
            `[${input.requiredChecks.requiredChecks.join(", ")}] on PR #${String(input.prNumber)}`,
        );
      }
      await this.sleep(Math.min(interval, Math.max(0, deadline - this.now())));
      evidence = await this.observeInternal(
        input.repositoryFullName,
        input.prNumber,
        input.requiredChecks,
      );
    }
  }

  async attemptCiRepair(
    input: RemoteCiRepairInput,
    deps: Readonly<{ harness: CiRepairHarness; push: PushManager }>,
  ): Promise<CiRepairOutcome> {
    const { evidence, requiredChecks, repairContext } = input;
    // Gather base evidence once (for base-failure detection). A fetch failure
    // is non-fatal: without base evidence we cannot confirm a base failure, so
    // we proceed treating every failure as a node failure (fail-closed toward
    // repair rather than escalating on a transient base-lookup error).
    const baseEvidence = await this.observeBase(input).catch(() => undefined);

    const failingRequired = failingRequiredChecks(evidence, requiredChecks);
    if (failingRequired.length === 0) {
      // Nothing hard-red to repair — surface the current evidence unchanged.
      return repairOutcome("repaired", evidence, 0, undefined, [], "no failing required checks");
    }

    // Base failure: every failing required check is hard-red on the base too.
    // That is infrastructure, not a node defect — escalate without repairing.
    if (
      baseEvidence !== undefined &&
      failingRequired.every((name) => isBaseFailure(name, evidence, baseEvidence))
    ) {
      return repairOutcome(
        "base_failure",
        evidence,
        0,
        undefined,
        failingRequired,
        `checks [${failingRequired.join(", ")}] fail on both head and base (infrastructure)`,
      );
    }

    // Bounded repair loop: repair → re-push → re-observe. Repeats while the
    // budget allows and the failing signature changes (progress). An identical
    // failing signature after a repair is no-progress → escalate.
    let budget = repairContext.budget;
    const priorSignatures = new Set<string>();
    let attempts = 0;
    let current = evidence;
    let currentFailing = failingRequired;

    for (;;) {
      if (budget.remaining <= 0) {
        return repairOutcome(
          "escalated",
          current,
          attempts,
          undefined,
          currentFailing,
          "repair budget exhausted",
        );
      }

      const outcome = await deps.harness.attemptNodeRepair({
        nodeId: repairContext.nodeId,
        treeId: repairContext.treeId,
        failingChecks: currentFailing,
        headSha: current.headSha,
      });
      attempts += outcome.attempts.length;

      if (outcome.status !== "repaired") {
        // The repair coordinator escalated (blocked / no-progress / budget /
        // human-change). Surface its typed attention unchanged.
        return repairOutcome(
          "escalated",
          current,
          attempts,
          outcome.attention,
          currentFailing,
          repairEscalationReason(outcome),
        );
      }

      // Repaired: re-push the (now-repaired) commit and re-observe.
      await this.repairPush(input, deps.push);
      current = await this.observeInternal(
        input.repositoryFullName,
        input.prNumber,
        requiredChecks,
      );
      currentFailing = failingRequiredChecks(current, requiredChecks);

      if (current.overallVerdict === "success") {
        return repairOutcome(
          "repaired",
          current,
          attempts,
          undefined,
          [],
          "all required checks pass after repair and re-push",
        );
      }
      if (currentFailing.length === 0) {
        // Not success but no hard-red failures (incomplete) — still not
        // mergeable, escalate rather than spin.
        return repairOutcome(
          "escalated",
          current,
          attempts,
          undefined,
          [],
          "checks incomplete after repair (missing/stale/soft verdicts remain)",
        );
      }

      // No-progress: identical failing signature to a prior attempt.
      const signature = currentFailing.slice().sort().join(",");
      if (priorSignatures.has(signature)) {
        return repairOutcome(
          "no_progress",
          current,
          attempts,
          undefined,
          currentFailing,
          `failing signature unchanged after repair: [${currentFailing.join(", ")}]`,
        );
      }
      priorSignatures.add(signature);
      budget = consume(budget);
    }
  }

  async invalidateStaleChecks(
    input: RemoteCiObservationInput & { readonly currentHeadSha: GitSha },
  ): Promise<CiEvidence> {
    // Observe for the exact head and recompute the evidence: any check whose
    // headSha differs from `currentHeadSha` is classified `stale` by the domain
    // (via verdict or headSha comparison), so it never counts as success. The
    // observation is the invalidation — there is no server-side mutation.
    const evidence = await this.observeInternal(
      input.repositoryFullName,
      input.prNumber,
      input.requiredChecks,
    );
    if (evidence.headSha !== input.currentHeadSha) {
      throw new RemoteCiError(
        "api_error",
        `PR #${String(input.prNumber)} head ${evidence.headSha} does not match ` +
          `expected current head ${input.currentHeadSha}; cannot invalidate stale checks`,
      );
    }
    return evidence;
  }

  // -----------------------------------------------------------------------------------------------
  // Internals.
  // -----------------------------------------------------------------------------------------------

  private async acquireClient(repositoryFullName: string): Promise<GitHubClient> {
    try {
      return await this.auth.clientFor(repositoryFullName);
    } catch (error: unknown) {
      throw wrapAuth(error, `authenticate for '${repositoryFullName}'`);
    }
  }

  /**
   * Observe checks for the PR head. Returns the typed evidence plus the raw
   * combined-status state (used by waitForChecks pending detection).
   */
  private async observeInternal(
    repositoryFullName: string,
    prNumber: number,
    requiredChecks: RequiredCheckSet,
  ): Promise<CiEvidence> {
    const client = await this.acquireClient(repositoryFullName);
    const pr = await this.fetchPr(client, repositoryFullName, prNumber);
    const headSha = gitSha(pr.headSha);
    const runs = await this.fetchCheckRuns(client, repositoryFullName, pr.headSha);
    const combined = await this.fetchCombinedStatus(client, repositoryFullName, pr.headSha);

    const byName = new Map<string, GitHubCheckRun>();
    for (const run of runs) {
      // Keep the most-recent run per name (GitHub can return re-runs); the
      // array is newest-first from the API, so the first wins.
      if (!byName.has(run.name)) {
        byName.set(run.name, run);
      }
    }

    const observations: CheckObservation[] = [];
    // Required checks first (ordered), then any extra observed checks.
    const seen = new Set<string>();
    for (const name of requiredChecks.requiredChecks) {
      const run = byName.get(name);
      observations.push(
        run === undefined
          ? missingObservation(name, headSha, combined)
          : toObservation(run, headSha),
      );
      seen.add(name);
    }
    for (const run of runs) {
      if (!seen.has(run.name)) {
        observations.push(toObservation(run, headSha));
        seen.add(run.name);
      }
    }

    const checks = Object.freeze(observations);
    return Object.freeze({
      headSha,
      checks,
      overallVerdict: classifyOverall(checks, requiredChecks),
      allRequiredPresent: allRequiredPresent(checks, requiredChecks),
    });
  }

  /** Observe the PR base SHA's checks (for base-failure detection). */
  private async observeBase(input: RemoteCiRepairInput): Promise<CiEvidence> {
    const client = await this.acquireClient(input.repositoryFullName);
    const pr = await this.fetchPr(client, input.repositoryFullName, input.prNumber);
    const baseSha = gitSha(pr.baseSha);
    const runs = await this.fetchCheckRuns(client, input.repositoryFullName, pr.baseSha);
    const byName = new Map<string, GitHubCheckRun>();
    for (const run of runs) {
      if (!byName.has(run.name)) {
        byName.set(run.name, run);
      }
    }
    const observations: CheckObservation[] = input.requiredChecks.requiredChecks.map((name) => {
      const run = byName.get(name);
      return run === undefined
        ? missingObservation(name, baseSha, { state: "pending", totalCount: 0 })
        : toObservation(run, baseSha);
    });
    const checks = Object.freeze(observations);
    return Object.freeze({
      headSha: baseSha,
      checks,
      overallVerdict: classifyOverall(checks, input.requiredChecks),
      allRequiredPresent: allRequiredPresent(checks, input.requiredChecks),
    });
  }

  private async repairPush(input: RemoteCiRepairInput, push: PushManager): Promise<void> {
    try {
      await push.push({
        repositoryFullName: input.repositoryFullName,
        bookmark: input.repairContext.bookmark,
        jjChangeId: input.repairContext.jjChangeId,
        expectedRemoteHeadSha: input.repairContext.expectedRemoteHeadSha,
      });
    } catch (error: unknown) {
      throw new RemoteCiError(
        "push_failed",
        `re-push of repaired commit for bookmark '${input.repairContext.bookmark}' failed: ` +
          errorToString(error),
        error,
      );
    }
  }

  private async fetchPr(
    client: GitHubClient,
    repositoryFullName: string,
    prNumber: number,
  ): Promise<{ readonly headSha: string; readonly baseSha: string }> {
    try {
      const pr = await client.getPullRequest(repositoryFullName, prNumber);
      return { headSha: pr.headSha, baseSha: pr.baseSha };
    } catch (error: unknown) {
      if (error instanceof GitHubClientError && error.code === "not_found") {
        throw new RemoteCiError(
          "pr_not_found",
          `pull request #${String(prNumber)} not found on '${repositoryFullName}'`,
          error,
        );
      }
      throw wrapClient(error, "api_error", `fetch PR #${String(prNumber)}`);
    }
  }

  private async fetchCheckRuns(
    client: GitHubClient,
    repositoryFullName: string,
    headSha: string,
  ): Promise<readonly GitHubCheckRun[]> {
    try {
      return await client.listCheckRuns(repositoryFullName, headSha);
    } catch (error: unknown) {
      throw wrapClient(error, "check_fetch_failed", `fetch check runs for commit ${headSha}`);
    }
  }

  private async fetchCombinedStatus(
    client: GitHubClient,
    repositoryFullName: string,
    headSha: string,
  ): Promise<GitHubCombinedStatus> {
    try {
      return await client.getCombinedStatus(repositoryFullName, headSha);
    } catch (error: unknown) {
      // A missing commit-status endpoint must never mask real check runs;
      // treat it as "no status signal" rather than failing the observation.
      if (error instanceof GitHubClientError && error.code === "not_found") {
        return { state: "pending", totalCount: 0 };
      }
      throw wrapClient(error, "check_fetch_failed", `fetch combined status for commit ${headSha}`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/** Map a GitHub check run to a domain observation for `headSha`. */
function toObservation(run: GitHubCheckRun, headSha: GitSha): CheckObservation {
  return Object.freeze({
    name: run.name,
    headSha: run.headSha === "" ? headSha : gitSha(run.headSha),
    verdict: verdictFromRun(run, headSha),
    completedAt: run.completedAt,
    logUrl: run.htmlUrl,
    conclusion: run.conclusion,
  });
}

/** Synthesize a `missing` observation for a required check with no run. */
function missingObservation(
  name: string,
  headSha: GitSha,
  combined: GitHubCombinedStatus,
): CheckObservation {
  // A pending combined status means checks are still running — treat an absent
  // required check as `in_progress` rather than permanently `missing` so polling
  // waits for it. A non-pending combined status leaves it `missing` (fail-closed:
  // missing never counts as success).
  const verdict: CheckVerdict = combined.state === "pending" ? "in_progress" : "missing";
  return Object.freeze({
    name,
    headSha,
    verdict,
    completedAt: null,
    logUrl: null,
    conclusion: null,
  });
}

/** Derive the per-check verdict from run status/conclusion/headSha. */
function verdictFromRun(run: GitHubCheckRun, headSha: GitSha): CheckVerdict {
  if (run.headSha !== "" && run.headSha !== headSha) {
    // The run executed against a different commit than the head under review.
    return "stale";
  }
  if (run.status !== "completed") {
    return "in_progress";
  }
  const conclusion = run.conclusion;
  if (conclusion === null) {
    // Completed but GitHub withheld a conclusion — defensive `unknown`.
    return "unknown";
  }
  return conclusionToVerdict(conclusion);
}

function conclusionToVerdict(conclusion: GitHubCheckConclusion): CheckVerdict {
  // The GitHubCheckConclusion union is a subset of CheckVerdict; every value
  // maps identically. The switch is exhaustive (the compiler errors if a new
  // conclusion is added without a case here).
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "action_required":
      return "action_required";
    case "stale":
      return "stale";
  }
}

/** True iff every required check has reached a terminal (non-pending) verdict. */
function allRequiredTerminal(evidence: CiEvidence, required: RequiredCheckSet): boolean {
  return required.requiredChecks.every((name) => {
    const obs = evidence.checks.find((check) => check.name === name);
    if (obs === undefined) {
      return false;
    }
    // Stale on a different head is terminal for polling purposes (it will not
    // become fresh without a re-push); in_progress/missing keep waiting.
    return isStaleCheck(obs, evidence.headSha) || isTerminalVerdict(obs.verdict);
  });
}

/** The required check names that are hard-red on the head. */
function failingRequiredChecks(evidence: CiEvidence, required: RequiredCheckSet): string[] {
  const names: string[] = [];
  for (const name of required.requiredChecks) {
    const obs = evidence.checks.find((check) => check.name === name);
    if (obs !== undefined && isFailureVerdict(obs.verdict)) {
      names.push(name);
    }
  }
  return names;
}

function repairOutcome(
  status: CiRepairOutcomeStatus,
  evidence: CiEvidence,
  attempts: number,
  attention: RepairAttention | undefined,
  failingChecks: readonly string[],
  reason: string,
): CiRepairOutcome {
  return Object.freeze({
    status,
    evidence,
    attempts,
    attention,
    failingChecks: Object.freeze(failingChecks),
    reason,
  });
}

function repairEscalationReason(outcome: RepairOutcome): string {
  if (outcome.decision !== undefined) {
    return outcome.decision.reason;
  }
  return outcome.status === "repaired"
    ? "repaired"
    : "repair coordinator escalated without a decision";
}

function wrapAuth(error: unknown, context: string): RemoteCiError {
  if (error instanceof GitHubAppAuthError) {
    return new RemoteCiError("auth_failed", `${context}: ${error.message}`, error);
  }
  return new RemoteCiError("auth_failed", `${context}: ${errorToString(error)}`, error);
}

function wrapClient(error: unknown, code: RemoteCiErrorCode, context: string): RemoteCiError {
  if (error instanceof GitHubClientError) {
    return new RemoteCiError(code, `${context}: ${error.message}`, error);
  }
  return new RemoteCiError(code, `${context}: ${errorToString(error)}`, error);
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
