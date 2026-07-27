/**
 * Pull-request management + review/check observation (PR 32, deliverable 2).
 *
 * ## One active PR per commit node (GIT-03)
 * `createOrUpdatePR` is idempotent on the head branch: it lists OPEN pull
 * requests for the head ref and either updates the single open one or creates a
 * new one. Two or more open PRs for the same head is an invariant breach
 * (`multiple_open_prs`); a closed/merged history is ignored (a fresh PR is
 * created) so each commit node has at most one ACTIVE review at any time.
 *
 * ## Review classification (GIT-11 — stale-approval detection after push)
 * `observeReviewState` fetches the PR's reviews and classifies each APPROVED
 * review against the PR's current head SHA. A review whose `commit_id` equals
 * the live `head.sha` was submitted against the latest push → FRESH. A review
 * whose `commit_id` differs predates the latest push → STALE (this is exactly
 * the `require_last_push_approval` semantics). Approvals from a bot — the
 * engine identity or any other App — are NOT eligible for independent human
 * review. The observation reduces to a single state by priority:
 * `approved` (a fresh eligible human approval) > `stale` (only stale human
 * approvals) > `bot` (only bot approvals) > `pending` (no approval).
 *
 * ## Credentials (SEC-10)
 * Like the ruleset and push managers, this module never sees a token; it
 * acquires an installation-scoped client through {@link GitHubAppAuth.clientFor}.
 */
import { type BotIdentity, GitHubAppAuthError, type GitHubAppAuth } from "./github-app-auth.js";
import {
  GitHubClientError,
  type GitHubClient,
  type GitHubCheckRun,
  type GitHubPullRequest,
  type GitHubReview,
} from "./github-client.js";

export type PullRequestErrorCode =
  | "pr_not_found"
  | "multiple_open_prs"
  | "review_fetch_failed"
  | "check_fetch_failed"
  | "create_failed"
  | "update_failed"
  | "auth_failed"
  | "api_error";

export class PullRequestError extends Error {
  readonly code: PullRequestErrorCode;
  override readonly cause: unknown;

  constructor(code: PullRequestErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PullRequestError";
    this.code = code;
    this.cause = cause;
  }
}

export interface PullRequestInput {
  readonly repositoryFullName: string;
  /** Head branch (the pushed bookmark). */
  readonly bookmark: string;
  /** Base branch the PR targets (e.g. `main`). */
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string | null;
  readonly draft: boolean;
}

export type PullRequestAction = "created" | "updated";

export interface PullRequestReceipt {
  readonly repositoryFullName: string;
  readonly prNumber: number;
  readonly bookmark: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly headSha: string;
  readonly action: PullRequestAction;
  readonly htmlUrl: string;
}

export type ReviewState = "approved" | "stale" | "bot" | "pending";

export interface ReviewApprovalSummary {
  readonly reviewId: number;
  readonly userLogin: string;
  readonly submittedAt: string;
  /** `true` iff the review's `commit_id` equals the PR's current head SHA. */
  readonly fresh: boolean;
  readonly isBot: boolean;
}

export interface ReviewObservation {
  readonly repositoryFullName: string;
  readonly prNumber: number;
  /** The PR head SHA reviews were classified against. */
  readonly headSha: string;
  readonly state: ReviewState;
  readonly freshApprovals: readonly ReviewApprovalSummary[];
  readonly staleApprovals: readonly ReviewApprovalSummary[];
  readonly botApprovals: readonly ReviewApprovalSummary[];
  /** ISO-8601 timestamp the observation was taken. */
  readonly observedAt: string;
}

export type CheckState = "pass" | "fail" | "pending" | "missing";

export interface CheckObservation {
  readonly repositoryFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly state: CheckState;
  readonly totalCheckRuns: number;
  readonly failingNames: readonly string[];
  readonly pendingNames: readonly string[];
  /** ISO-8601 timestamp the observation was taken. */
  readonly observedAt: string;
}

export interface PullRequestManagerOptions {
  readonly auth: GitHubAppAuth;
  /** Engine bot identity for review eligibility. Resolved lazily if omitted. */
  readonly botIdentity?: BotIdentity;
  readonly now?: () => number;
}

export interface PullRequestManager {
  createOrUpdatePR(input: PullRequestInput): Promise<PullRequestReceipt>;
  observeReviewState(repositoryFullName: string, prNumber: number): Promise<ReviewObservation>;
  observeChecks(repositoryFullName: string, prNumber: number): Promise<CheckObservation>;
}

export function createPullRequestManager(options: PullRequestManagerOptions): PullRequestManager {
  const now = options.now ?? Date.now;
  return new PullRequestManagerImpl(options.auth, options.botIdentity, now);
}

const repositoryFullNamePattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const branchNamePattern = /^(?!.*\.\.)(?!.*\.$)[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

const FAILING_CONCLUSIONS: Readonly<Record<string, true>> = {
  failure: true,
  cancelled: true,
  timed_out: true,
  action_required: true,
};

class PullRequestManagerImpl implements PullRequestManager {
  private cachedBotIdentity: BotIdentity | undefined;

  constructor(
    private readonly auth: GitHubAppAuth,
    private readonly botIdentity: BotIdentity | undefined,
    private readonly now: () => number,
  ) {}

  async createOrUpdatePR(input: PullRequestInput): Promise<PullRequestReceipt> {
    validatePullRequestInput(input);
    const client = await this.acquireClient(input.repositoryFullName);
    const slashIndex = input.repositoryFullName.indexOf("/");
    const headFilter = `${input.repositoryFullName.slice(0, slashIndex)}:${input.bookmark}`;
    const openPrs = await this.listOpenPrs(client, input.repositoryFullName, headFilter);

    if (openPrs.length > 1) {
      throw new PullRequestError(
        "multiple_open_prs",
        `found ${String(openPrs.length)} open pull requests for head '${input.bookmark}' ` +
          `on '${input.repositoryFullName}'; expected at most one`,
      );
    }

    const existing = openPrs[0];
    if (existing !== undefined) {
      const updated = await this.updateExistingPr(client, input, existing.number);
      return toReceipt(input, updated, "updated");
    }

    const created = await this.createNewPr(client, input, headFilter);
    return toReceipt(input, created, "created");
  }

  async observeReviewState(
    repositoryFullName: string,
    prNumber: number,
  ): Promise<ReviewObservation> {
    validateRepository(repositoryFullName);
    const client = await this.acquireClient(repositoryFullName);
    const pr = await this.fetchPr(client, repositoryFullName, prNumber);
    const botIdentity = await this.resolveBotIdentity();
    const reviews = await this.fetchReviews(client, repositoryFullName, prNumber);

    const fresh: ReviewApprovalSummary[] = [];
    const stale: ReviewApprovalSummary[] = [];
    const bots: ReviewApprovalSummary[] = [];
    for (const review of reviews) {
      if (review.state !== "APPROVED") {
        continue;
      }
      const isBot = isBotReviewer(review, botIdentity);
      const summary: ReviewApprovalSummary = Object.freeze({
        reviewId: review.id,
        userLogin: review.user.login,
        submittedAt: review.submittedAt,
        fresh: !isBot && review.commitId === pr.headSha,
        isBot,
      });
      if (isBot) {
        bots.push(summary);
      } else if (summary.fresh) {
        fresh.push(summary);
      } else {
        stale.push(summary);
      }
    }

    const state: ReviewState =
      fresh.length > 0
        ? "approved"
        : stale.length > 0
          ? "stale"
          : bots.length > 0
            ? "bot"
            : "pending";

    return Object.freeze({
      repositoryFullName,
      prNumber,
      headSha: pr.headSha,
      state,
      freshApprovals: Object.freeze(fresh),
      staleApprovals: Object.freeze(stale),
      botApprovals: Object.freeze(bots),
      observedAt: new Date(this.now()).toISOString(),
    });
  }

  async observeChecks(repositoryFullName: string, prNumber: number): Promise<CheckObservation> {
    validateRepository(repositoryFullName);
    const client = await this.acquireClient(repositoryFullName);
    const pr = await this.fetchPr(client, repositoryFullName, prNumber);
    const checkRuns = await this.fetchCheckRuns(client, repositoryFullName, pr.headSha);
    const combined = await this.fetchCombinedStatus(client, repositoryFullName, pr.headSha);

    const failingNames: string[] = [];
    const pendingNames: string[] = [];
    for (const run of checkRuns) {
      categorizeCheckRun(run, failingNames, pendingNames);
    }
    const combinedFailing = combined.state === "failure" || combined.state === "error";
    const combinedPending = combined.state === "pending";

    const hasAny = checkRuns.length > 0 || combined.totalCount > 0;
    const state: CheckState = !hasAny
      ? "missing"
      : failingNames.length > 0 || combinedFailing
        ? "fail"
        : pendingNames.length > 0 || combinedPending
          ? "pending"
          : "pass";

    return Object.freeze({
      repositoryFullName,
      prNumber,
      headSha: pr.headSha,
      state,
      totalCheckRuns: checkRuns.length,
      failingNames: Object.freeze(failingNames),
      pendingNames: Object.freeze(pendingNames),
      observedAt: new Date(this.now()).toISOString(),
    });
  }
  private async acquireClient(repositoryFullName: string): Promise<GitHubClient> {
    try {
      return await this.auth.clientFor(repositoryFullName);
    } catch (error: unknown) {
      throw wrapAuth(error, `authenticate for '${repositoryFullName}'`);
    }
  }

  private async resolveBotIdentity(): Promise<BotIdentity | undefined> {
    if (this.botIdentity !== undefined) {
      return this.botIdentity;
    }
    if (this.cachedBotIdentity !== undefined) {
      return this.cachedBotIdentity;
    }
    try {
      this.cachedBotIdentity = await this.auth.resolveAppIdentity();
      return this.cachedBotIdentity;
    } catch (error: unknown) {
      // A bot-identity resolution failure must NOT silently widen eligibility:
      // fail closed so a misconfigured App can never count its own review.
      throw new PullRequestError(
        "auth_failed",
        `failed to resolve engine bot identity: ${errorToString(error)}`,
        error,
      );
    }
  }

  private async listOpenPrs(
    client: GitHubClient,
    repositoryFullName: string,
    headFilter: string,
  ): Promise<readonly GitHubPullRequest[]> {
    try {
      return await client.listPullRequests(repositoryFullName, {
        head: headFilter,
        state: "open",
      });
    } catch (error: unknown) {
      throw wrapClient(error, "api_error", `list open PRs for head '${headFilter}'`);
    }
  }

  private async createNewPr(
    client: GitHubClient,
    input: PullRequestInput,
    headFilter: string,
  ): Promise<GitHubPullRequest> {
    try {
      return await client.createPullRequest(input.repositoryFullName, {
        title: input.title,
        body: input.body,
        head: input.bookmark,
        base: input.baseBranch,
        draft: input.draft,
      });
    } catch (error: unknown) {
      throw wrapClient(
        error,
        "create_failed",
        `create PR for head '${headFilter}' against '${input.baseBranch}'`,
      );
    }
  }

  private async updateExistingPr(
    client: GitHubClient,
    input: PullRequestInput,
    prNumber: number,
  ): Promise<GitHubPullRequest> {
    try {
      return await client.updatePullRequest(input.repositoryFullName, prNumber, {
        title: input.title,
        body: input.body,
        base: input.baseBranch,
        state: undefined,
      });
    } catch (error: unknown) {
      throw wrapClient(error, "update_failed", `update PR #${String(prNumber)}`);
    }
  }

  private async fetchPr(
    client: GitHubClient,
    repositoryFullName: string,
    prNumber: number,
  ): Promise<GitHubPullRequest> {
    try {
      return await client.getPullRequest(repositoryFullName, prNumber);
    } catch (error: unknown) {
      if (error instanceof GitHubClientError && error.code === "not_found") {
        throw new PullRequestError(
          "pr_not_found",
          `pull request #${String(prNumber)} not found on '${repositoryFullName}'`,
          error,
        );
      }
      throw wrapClient(error, "api_error", `fetch PR #${String(prNumber)}`);
    }
  }

  private async fetchReviews(
    client: GitHubClient,
    repositoryFullName: string,
    prNumber: number,
  ): Promise<readonly GitHubReview[]> {
    try {
      return await client.listReviews(repositoryFullName, prNumber);
    } catch (error: unknown) {
      throw wrapClient(error, "review_fetch_failed", `fetch reviews for PR #${String(prNumber)}`);
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
  ): Promise<{ readonly state: string; readonly totalCount: number }> {
    try {
      const status = await client.getCombinedStatus(repositoryFullName, headSha);
      return { state: status.state, totalCount: status.totalCount };
    } catch (error: unknown) {
      // A missing commit-status endpoint must never mask real check runs; treat
      // it as "no status signal" rather than failing the whole observation.
      if (error instanceof GitHubClientError && error.code === "not_found") {
        return { state: "pending", totalCount: 0 };
      }
      throw wrapClient(error, "check_fetch_failed", `fetch combined status for commit ${headSha}`);
    }
  }
}
function isBotReviewer(review: GitHubReview, botIdentity: BotIdentity | undefined): boolean {
  // `review.user.login` is always a non-empty string, so it can never equal the
  // `undefined` produced by `botIdentity?.botLogin` when the identity is unset.
  return review.user.type === "Bot" || review.user.login === botIdentity?.botLogin;
}

function categorizeCheckRun(
  run: GitHubCheckRun,
  failingNames: string[],
  pendingNames: string[],
): void {
  if (run.status !== "completed") {
    pendingNames.push(run.name);
    return;
  }
  if (run.conclusion !== null && FAILING_CONCLUSIONS[run.conclusion] === true) {
    failingNames.push(run.name);
    return;
  }
  if (run.conclusion === null) {
    pendingNames.push(run.name);
  }
}

function toReceipt(
  input: PullRequestInput,
  pr: GitHubPullRequest,
  action: PullRequestAction,
): PullRequestReceipt {
  return Object.freeze({
    repositoryFullName: input.repositoryFullName,
    prNumber: pr.number,
    bookmark: input.bookmark,
    baseBranch: input.baseBranch,
    title: pr.title,
    headSha: pr.headSha,
    action,
    htmlUrl: pr.htmlUrl,
  });
}

function validatePullRequestInput(input: PullRequestInput): void {
  validateRepository(input.repositoryFullName);
  if (!branchNamePattern.test(input.bookmark)) {
    throw new PullRequestError("api_error", `invalid head bookmark '${input.bookmark}'`);
  }
  if (!branchNamePattern.test(input.baseBranch)) {
    throw new PullRequestError("api_error", `invalid base branch '${input.baseBranch}'`);
  }
  if (input.title.length === 0) {
    throw new PullRequestError("api_error", "pull-request title must not be empty");
  }
}

function validateRepository(repositoryFullName: string): void {
  if (!repositoryFullNamePattern.test(repositoryFullName)) {
    throw new PullRequestError(
      "api_error",
      `invalid repository full name '${repositoryFullName}' (expected 'owner/name')`,
    );
  }
}

function wrapAuth(error: unknown, context: string): PullRequestError {
  if (error instanceof PullRequestError) {
    return error;
  }
  if (error instanceof GitHubAppAuthError) {
    return new PullRequestError("auth_failed", `${context}: ${error.message}`, error);
  }
  if (error instanceof GitHubClientError && error.code === "auth_failed") {
    return new PullRequestError("auth_failed", `${context}: ${error.message}`, error);
  }
  return new PullRequestError("auth_failed", `${context}: ${errorToString(error)}`, error);
}

function wrapClient(error: unknown, code: PullRequestErrorCode, context: string): PullRequestError {
  if (error instanceof PullRequestError) {
    return error;
  }
  if (error instanceof GitHubClientError) {
    if (code !== "auth_failed" && error.code === "auth_failed") {
      return new PullRequestError("auth_failed", `${context}: ${error.message}`, error);
    }
    return new PullRequestError(
      code,
      `${context}: ${error.code} (${String(error.status)}) ${error.message}`,
      error,
    );
  }
  return new PullRequestError(code, `${context}: ${errorToString(error)}`, error);
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
