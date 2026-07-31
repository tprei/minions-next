/**
 * Landing coordinator (PR 36) — the single mutation that lands one PR onto the
 * trunk after a full preflight, then keeps the stack consistent.
 *
 * Composes every upstream deliverable into one explicit, human-initiated
 * operation:
 * - {@link createPullRequestManager} (PR 32) — fresh eligible human review.
 * - {@link createRemoteCiManager} (PR 35) — success-only required checks.
 * - {@link inspectRuleset} (PR 31) — independent-review ruleset enforcement.
 * - {@link validateGateReceipts} (PR 25) — fresh passing local gates.
 * - {@link createStackParentageManager} (PR 33) — parent-before-child retarget.
 * - {@link createSqliteVcsChangeBindingStore} (PR 29) — node identity.
 *
 * ## Only a human initiates (GIT-03, GIT-04, GIT-08, GIT-12)
 * The only entry point is {@link LandingCoordinator.land}, which takes a
 * {@link LandingIntent} carrying a verified {@link HumanApproval} — a capability
 * issued at the authenticated boundary, never a request-body field. There is no
 * auto-merge path, no timer, no queue: one explicit human command lands exactly
 * one named PR. `validateLandingIntent` re-asserts the capability at runtime and
 * fails closed when it is absent or forged.
 *
 * ## Preflight order + crash reconciliation
 * 1. Idempotency: a recorded receipt for this PR → `duplicate_command` (return).
 * 2. Reconciliation: the PR is already merged on GitHub → reconstruct the
 *    receipt from GitHub state → `already_landed` (return). This is the crash
 *    window: a process that died between merge and receipt recording reconciles.
 * 3. Preflight: head/parent/checks/review/ruleset/gates → `evaluatePreflight`.
 * 4. Merge (squash for engine commits) via the GitHub API with the expected head
 *    SHA pinned, so a head drift between preflight and merge fails closed.
 * 5. Retarget the landed node's children at the grandparent (PR 33).
 *
 * Every failure surfaces a typed {@link LandingError}; the pure verdict logic
 * lives in the domain (`packages/core/src/landing.ts`).
 */
import {
  timestampFromEpochMilliseconds,
  validateGateReceipts,
  validateLandingIntent,
  evaluatePreflight,
  LandingReceiptStoreError,
  type GateReceiptExpectation,
  type GateReceiptStore,
  type GitSha,
  type LandingIntent,
  type LandingMergeMethod,
  type LandingPreflight,
  type LandingReceipt,
  type LandingReceiptStore,
  type LandingVerdict,
  type RequiredCheckSet,
  type RetargetPlan,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";

import type { GitHubAppAuth } from "./github-app-auth.js";
import {
  GitHubClientError,
  type GitHubClient,
  type GitHubMergeMethod,
  type GitHubPullRequest,
} from "./github-client.js";
import { inspectRuleset } from "./github-ruleset.js";
import type { PullRequestManager } from "./github-pull-request.js";
import type { RemoteCiManager } from "./remote-ci-adapter.js";
import type { StackParentageManager } from "./stack-parentage-adapter.js";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type LandingErrorCode =
  | "preflight_failed"
  | "already_landed"
  | "parent_not_landed"
  | "ambiguous_remote"
  | "duplicate_command"
  | "merge_failed"
  | "retarget_failed"
  | "receipt_failed";

/** Typed landing error. Fail-closed: every preflight or I/O failure surfaces one. */
export class LandingError extends Error {
  readonly code: LandingErrorCode;
  /** The domain verdict this failure maps to, when applicable. */
  readonly verdict: LandingVerdict | undefined;
  override readonly cause: unknown;

  constructor(
    code: LandingErrorCode,
    message: string,
    options?: Readonly<{ cause?: unknown; verdict?: LandingVerdict }>,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LandingError";
    this.code = code;
    this.verdict = options?.verdict;
    this.cause = options?.cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Policy + ports.
// -------------------------------------------------------------------------------------------------

/**
 * Per-node landing policy. `mergeMethod` defaults to `squash` for engine commits
 * (GIT-12): one commit per landed node on the trunk.
 */
export interface LandingPolicy {
  readonly requiredChecks: RequiredCheckSet;
  readonly gateExpectation: GateReceiptExpectation;
  readonly mergeMethod: LandingMergeMethod;
}

/**
 * Ruleset-enforcement gate. Defaults to {@link inspectRuleset} (PR 31): the
 * repository's branch ruleset must classify `enforceable` (independent human
 * review required, stale dismissed, no engine bypass). Injectable for tests.
 */
export interface LandingRulesetGate {
  isEnforced(repositoryFullName: string): Promise<boolean>;
}

/** The single landed-node resolver: which node does this PR belong to? */
export interface LandingNodeResolver {
  /**
   * Resolve the node identity for `pr`'s head branch within the coordinator's
   * tree. Returns `undefined` when no binding matches (an unlandable PR).
   */
  resolveNode(pr: GitHubPullRequest): Promise<TaskNodeId | undefined>;
}

// -------------------------------------------------------------------------------------------------
// Coordinator.
// -------------------------------------------------------------------------------------------------

export interface LandingCoordinatorOptions {
  readonly auth: GitHubAppAuth;
  readonly pullRequests: PullRequestManager;
  readonly remoteCi: RemoteCiManager;
  readonly stackParentage: StackParentageManager;
  readonly bindingStore: VcsChangeBindingStore;
  readonly gateReceipts: GateReceiptStore;
  readonly receiptStore: LandingReceiptStore;
  readonly policy: LandingPolicy;
  /** The tree this coordinator lands within (node resolution + retarget scope). */
  readonly treeId: TaskTreeId;
  readonly repositoryFullName: string;
  /** Trunk a root targets. Defaults to `main`. */
  readonly trunk?: string;
  /** Overrides the default {@link inspectRuleset}-backed gate (tests). */
  readonly rulesetGate?: LandingRulesetGate;
  /** Overrides the default binding-store-backed node resolver (tests). */
  readonly nodeResolver?: LandingNodeResolver;
  /** Injectable clock returning epoch milliseconds. */
  readonly now?: () => number;
}

export interface LandingCoordinator {
  /**
   * Land the PR named by `intent`. Returns a durable {@link LandingReceipt}:
   * - `landed` — fresh merge executed this call.
   * - `already_landed` — the PR was already merged (reconstructed; idempotent).
   * - `duplicate_command` — a receipt for this PR already exists (idempotent).
   *
   * Throws {@link LandingError} for any preflight failure
   * (`preflight_failed` / `parent_not_landed` / `ambiguous_remote`) or mid-flight
   * I/O failure (`merge_failed` / `retarget_failed` / `receipt_failed`).
   */
  land(intent: LandingIntent): Promise<LandingReceipt>;
}

export function createLandingCoordinator(options: LandingCoordinatorOptions): LandingCoordinator {
  const trunk = options.trunk ?? "main";
  const now = options.now ?? Date.now;
  const rulesetGate = options.rulesetGate ?? defaultRulesetGate(options.auth);
  const nodeResolver =
    options.nodeResolver ?? defaultNodeResolver(options.bindingStore, options.treeId);
  return new LandingCoordinatorImpl(
    options.auth,
    options.pullRequests,
    options.remoteCi,
    options.stackParentage,
    options.gateReceipts,
    options.receiptStore,
    options.policy,
    options.treeId,
    options.repositoryFullName,
    trunk,
    rulesetGate,
    nodeResolver,
    now,
  );
}

/** Default ruleset gate: PR 31's `inspectRuleset` must classify `enforceable`. */
function defaultRulesetGate(auth: GitHubAppAuth): LandingRulesetGate {
  return {
    async isEnforced(repositoryFullName: string): Promise<boolean> {
      const report = await inspectRuleset(auth, repositoryFullName);
      return report.classification === "enforceable";
    },
  };
}

/** Default node resolver: the binding whose bookmark is the PR's head branch. */
function defaultNodeResolver(
  bindingStore: VcsChangeBindingStore,
  treeId: TaskTreeId,
): LandingNodeResolver {
  return {
    async resolveNode(pr: GitHubPullRequest): Promise<TaskNodeId | undefined> {
      const bindings = await bindingStore.listForTree(treeId);
      const match = bindings.find(
        (binding: VcsChangeBinding) => binding.bookmark === pr.headRefName,
      );
      return match?.nodeId;
    },
  };
}

const repositoryFullNamePattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

class LandingCoordinatorImpl implements LandingCoordinator {
  constructor(
    private readonly auth: GitHubAppAuth,
    private readonly pullRequests: PullRequestManager,
    private readonly remoteCi: RemoteCiManager,
    private readonly stackParentage: StackParentageManager,
    private readonly gateReceipts: GateReceiptStore,
    private readonly receiptStore: LandingReceiptStore,
    private readonly policy: LandingPolicy,
    private readonly treeId: TaskTreeId,
    private readonly repositoryFullName: string,
    private readonly trunk: string,
    private readonly rulesetGate: LandingRulesetGate,
    private readonly nodeResolver: LandingNodeResolver,
    private readonly now: () => number,
  ) {}

  async land(intent: LandingIntent): Promise<LandingReceipt> {
    validateLandingIntent(intent);
    if (intent.repositoryFullName !== this.repositoryFullName) {
      throw new LandingError(
        "preflight_failed",
        `intent repository '${intent.repositoryFullName}' does not match coordinator ` +
          `repository '${this.repositoryFullName}'`,
        { verdict: "preflight_failed" },
      );
    }

    // 1. Idempotency — a recorded receipt for this PR is the duplicate marker.
    const existing = await this.fetchExistingReceipt(intent.prNumber);
    if (existing !== undefined) {
      return withVerdict(existing, "duplicate_command");
    }

    // 2. Fetch the PR (the source of truth for head/merge state).
    const client = await this.acquireClient();
    const pr = await this.fetchPr(client, intent.prNumber);

    // 3. Crash reconciliation / already-landed: reconstruct from GitHub state.
    if (pr.merged) {
      return this.reconstructReceipt(pr);
    }

    // 4. Preflight — gather the six fail-closed signals.
    const preflight = await this.gatherPreflight(intent, pr, client);
    const verdict = evaluatePreflight(preflight);
    if (verdict !== "landed") {
      throw this.preflightError(verdict, preflight, pr, intent);
    }

    // 5. Resolve the node (needed for gates already gathered + retarget below).
    const nodeId = await this.resolveNodeOrFail(pr);

    // 6. Merge via the GitHub API with the expected head pinned.
    const mergedSha = await this.mergePr(client, intent, pr);

    // 7. Parent-before-child: retarget the landed node's children (PR 33).
    const retargetPlan = await this.retargetChildren(nodeId);

    // 8. Record the durable receipt.
    const receipt: LandingReceipt = Object.freeze({
      prNumber: intent.prNumber,
      repositoryFullName: this.repositoryFullName,
      mergedSha,
      landedAt: timestampFromEpochMilliseconds(this.now()),
      mergeMethod: this.policy.mergeMethod,
      parentRetargetPlan: Object.freeze(retargetPlan),
      verdict: "landed",
    });
    await this.recordReceipt(receipt);
    return receipt;
  }

  // -----------------------------------------------------------------------------------------------
  // Preflight.
  // -----------------------------------------------------------------------------------------------

  private async gatherPreflight(
    intent: LandingIntent,
    pr: GitHubPullRequest,
    client: GitHubClient,
  ): Promise<LandingPreflight> {
    const expectedHead = intent.expectedHeadSha;
    const headMatches = pr.headSha === expectedHead;

    // Parent landed (root → true; else the parent PR must be merged).
    const parentLanded = headMatches ? await this.isParentLanded(pr, client) : false;

    // The remaining gates only matter when the head is the one the human reviewed
    // and the parent has landed; otherwise short-circuit to false (the verdict is
    // already determined by head/parent).
    let checksPass = false;
    let reviewFresh = false;
    let rulesetEnforced = false;
    let allGatesPassed = false;
    if (headMatches && parentLanded) {
      checksPass = await this.checksPass(intent, expectedHead);
      reviewFresh = await this.reviewFresh(intent);
      rulesetEnforced = await this.rulesetGate.isEnforced(this.repositoryFullName);
      allGatesPassed = await this.allGatesPassed(pr);
    }

    return Object.freeze({
      headMatches,
      parentLanded,
      checksPass,
      reviewFresh,
      rulesetEnforced,
      allGatesPassed,
    });
  }

  /** All required CI checks pass (success-only, PR 35). */
  private async checksPass(intent: LandingIntent, expectedHead: GitSha): Promise<boolean> {
    const evidence = await this.remoteCi.observeCi({
      repositoryFullName: this.repositoryFullName,
      prNumber: intent.prNumber,
      requiredChecks: this.policy.requiredChecks,
    });
    // Fail-closed: evidence must be for the exact reviewed head AND success.
    return evidence.headSha === expectedHead && evidence.overallVerdict === "success";
  }

  /** A fresh eligible human approval exists after the latest push (PR 32). */
  private async reviewFresh(intent: LandingIntent): Promise<boolean> {
    const observation = await this.pullRequests.observeReviewState(
      this.repositoryFullName,
      intent.prNumber,
    );
    return observation.state === "approved";
  }

  /** Every required local gate category has a fresh passing receipt (PR 25). */
  private async allGatesPassed(pr: GitHubPullRequest): Promise<boolean> {
    const nodeId = await this.nodeResolver.resolveNode(pr);
    if (nodeId === undefined) {
      // No binding → no gate evidence → fail closed. (Node resolution is also
      // re-checked explicitly after preflight; this keeps the gate signal honest.)
      return false;
    }
    const receipts = await this.gateReceipts.listForNode(nodeId);
    const validation = validateGateReceipts(receipts, this.policy.gateExpectation);
    return validation.unblocked;
  }

  /** Root (base === trunk) → true; else the parent PR (head === this base) is merged. */
  private async isParentLanded(pr: GitHubPullRequest, client: GitHubClient): Promise<boolean> {
    if (pr.baseRefName === this.trunk) {
      return true;
    }
    const owner = ownerOf(this.repositoryFullName);
    const headFilter = `${owner}:${pr.baseRefName}`;
    let parentPrs: readonly GitHubPullRequest[];
    try {
      parentPrs = await client.listPullRequests(this.repositoryFullName, {
        head: headFilter,
        state: "all",
      });
    } catch (error: unknown) {
      throw new LandingError(
        "preflight_failed",
        `failed to inspect parent PR for base '${pr.baseRefName}': ${errorMessage(error)}`,
        { cause: error, verdict: "preflight_failed" },
      );
    }
    return parentPrs.some((candidate: GitHubPullRequest) => candidate.merged);
  }

  // -----------------------------------------------------------------------------------------------
  // Merge + retarget + receipt.
  // -----------------------------------------------------------------------------------------------

  private async mergePr(
    client: GitHubClient,
    intent: LandingIntent,
    pr: GitHubPullRequest,
  ): Promise<string> {
    const method: GitHubMergeMethod = this.policy.mergeMethod;
    try {
      const result = await client.mergePullRequest(this.repositoryFullName, intent.prNumber, {
        commitTitle: undefined,
        commitMessage: undefined,
        mergeMethod: method,
        // Pin the reviewed head: GitHub rejects (409) if it moved since preflight.
        sha: intent.expectedHeadSha,
      });
      if (result.sha === null) {
        throw new LandingError(
          "merge_failed",
          `merge of PR #${String(intent.prNumber)} returned no SHA ` +
            `(message: '${result.message}', merged: ${String(result.merged)})`,
        );
      }
      return result.sha;
    } catch (error: unknown) {
      if (error instanceof LandingError) {
        throw error;
      }
      // A 409 from a head drift between preflight and merge is ambiguous_remote.
      if (error instanceof GitHubClientError && error.status === 409) {
        throw new LandingError(
          "ambiguous_remote",
          `merge of PR #${String(intent.prNumber)} rejected (409): the head moved ` +
            `('${pr.headSha}' vs expected '${intent.expectedHeadSha}')`,
          { cause: error, verdict: "ambiguous_remote" },
        );
      }
      throw new LandingError(
        "merge_failed",
        `merge of PR #${String(intent.prNumber)} failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async retargetChildren(nodeId: TaskNodeId): Promise<readonly RetargetPlan[]> {
    try {
      return await this.stackParentage.retargetAfterParentLanding(this.treeId, nodeId);
    } catch (error: unknown) {
      // The merge already succeeded; a retarget failure must NOT be silently
      // swallowed, but it is recoverable (retarget is idempotent). Surface it.
      throw new LandingError(
        "retarget_failed",
        `retarget of children for node '${nodeId}' after landing failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /** Reconstruct a receipt from GitHub state (crash reconciliation / already-landed). */
  private async reconstructReceipt(pr: GitHubPullRequest): Promise<LandingReceipt> {
    if (pr.mergeCommitSha === null || pr.mergedAt === null) {
      throw new LandingError(
        "receipt_failed",
        `PR #${String(pr.number)} is merged but GitHub reports no merge commit SHA / ` +
          `merged-at; cannot reconstruct a landing receipt`,
      );
    }
    const landedAt = parseIsoToEpochMs(pr.mergedAt);
    const receipt: LandingReceipt = Object.freeze({
      prNumber: pr.number,
      repositoryFullName: this.repositoryFullName,
      mergedSha: pr.mergeCommitSha,
      landedAt: timestampFromEpochMilliseconds(landedAt),
      // The merge method is not recoverable from GitHub's PR object; squash is the
      // engine default. The retarget plan is empty here — children retarget is
      // idempotent and re-runs on the next stack-parentage pass if needed.
      mergeMethod: this.policy.mergeMethod,
      parentRetargetPlan: Object.freeze([]),
      verdict: "already_landed",
    });
    await this.recordReceipt(receipt);
    return receipt;
  }

  private async resolveNodeOrFail(pr: GitHubPullRequest): Promise<TaskNodeId> {
    const nodeId = await this.nodeResolver.resolveNode(pr);
    if (nodeId === undefined) {
      throw new LandingError(
        "preflight_failed",
        `no vcs-change binding matches PR #${String(pr.number)} head branch ` +
          `'${pr.headRefName}' in tree '${this.treeId}'; cannot land an unbound PR`,
        { verdict: "preflight_failed" },
      );
    }
    return nodeId;
  }

  // -----------------------------------------------------------------------------------------------
  // Ports.
  // -----------------------------------------------------------------------------------------------

  private async acquireClient(): Promise<GitHubClient> {
    try {
      return await this.auth.clientFor(this.repositoryFullName);
    } catch (error: unknown) {
      throw new LandingError(
        "preflight_failed",
        `failed to acquire GitHub client for '${this.repositoryFullName}': ${errorMessage(error)}`,
        { cause: error, verdict: "preflight_failed" },
      );
    }
  }

  private async fetchPr(client: GitHubClient, prNumber: number): Promise<GitHubPullRequest> {
    try {
      return await client.getPullRequest(this.repositoryFullName, prNumber);
    } catch (error: unknown) {
      if (error instanceof GitHubClientError && error.code === "not_found") {
        throw new LandingError(
          "preflight_failed",
          `pull request #${String(prNumber)} not found on '${this.repositoryFullName}'`,
          { cause: error, verdict: "preflight_failed" },
        );
      }
      throw new LandingError(
        "preflight_failed",
        `failed to fetch PR #${String(prNumber)}: ${errorMessage(error)}`,
        { cause: error, verdict: "preflight_failed" },
      );
    }
  }

  private async fetchExistingReceipt(prNumber: number): Promise<LandingReceipt | undefined> {
    try {
      return await this.receiptStore.getReceipt(this.repositoryFullName, prNumber);
    } catch (error: unknown) {
      throw new LandingError(
        "receipt_failed",
        `failed to read landing receipt for PR #${String(prNumber)}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async recordReceipt(receipt: LandingReceipt): Promise<void> {
    try {
      await this.receiptStore.recordReceipt(receipt);
    } catch (error: unknown) {
      if (error instanceof LandingReceiptStoreError) {
        throw new LandingError(
          "receipt_failed",
          `failed to record landing receipt for PR #${String(receipt.prNumber)}: ${error.message}`,
          { cause: error },
        );
      }
      throw new LandingError(
        "receipt_failed",
        `failed to record landing receipt for PR #${String(receipt.prNumber)}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private preflightError(
    verdict: LandingVerdict,
    preflight: LandingPreflight,
    pr: GitHubPullRequest,
    intent: LandingIntent,
  ): LandingError {
    if (verdict === "ambiguous_remote") {
      return new LandingError(
        "ambiguous_remote",
        `PR #${String(intent.prNumber)} head '${pr.headSha}' does not match the reviewed ` +
          `head '${intent.expectedHeadSha}'; reconcile before retrying`,
        { verdict },
      );
    }
    if (verdict === "parent_not_landed") {
      return new LandingError(
        "parent_not_landed",
        `PR #${String(intent.prNumber)} base '${pr.baseRefName}' parent has not landed; ` +
          `land the parent first (parent-before-child)`,
        { verdict },
      );
    }
    // preflight_failed — name the first failed gate.
    const failed = firstFailedGate(preflight);
    return new LandingError(
      "preflight_failed",
      `preflight failed for PR #${String(intent.prNumber)}: ${failed}`,
      { verdict },
    );
  }
}

// -------------------------------------------------------------------------------------------------
// Helpers.
// -------------------------------------------------------------------------------------------------

/** Return a copy of `receipt` with `verdict` overridden (idempotent outcomes). */
function withVerdict(receipt: LandingReceipt, verdict: LandingVerdict): LandingReceipt {
  if (receipt.verdict === verdict) {
    return receipt;
  }
  return Object.freeze({ ...receipt, verdict });
}

/** Human-readable name of the first preflight gate that failed. */
function firstFailedGate(preflight: LandingPreflight): string {
  if (!preflight.checksPass) {
    return "required checks did not all pass (success-only)";
  }
  if (!preflight.reviewFresh) {
    return "no fresh eligible human review after the latest push";
  }
  if (!preflight.rulesetEnforced) {
    return "branch ruleset does not enforce independent human review";
  }
  if (!preflight.allGatesPassed) {
    return "not all required local gates have a fresh passing receipt";
  }
  return "unknown preflight failure";
}

function ownerOf(repositoryFullName: string): string {
  if (!repositoryFullNamePattern.test(repositoryFullName)) {
    throw new LandingError(
      "preflight_failed",
      `invalid repository full name '${repositoryFullName}' (expected 'owner/repo')`,
      { verdict: "preflight_failed" },
    );
  }
  return repositoryFullName.slice(0, repositoryFullName.indexOf("/"));
}

function parseIsoToEpochMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new LandingError("receipt_failed", `unparseable merged-at timestamp '${iso}'`);
  }
  return ms;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
