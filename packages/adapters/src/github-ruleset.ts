/**
 * Independent-human-review ruleset enforcement (PR 31, deliverable 2).
 *
 * Inspects, installs, and drift-checks the GitHub branch ruleset that enforces the
 * Minions landing policy (PRD GIT-10 / GIT-11 / SEC-10):
 *
 * - at least one approving review is required,
 * - stale approvals are dismissed on push,
 * - approval is required after the engine's most recent push,
 * - the engine bot identity is NEVER granted a ruleset bypass.
 *
 * `onboardRepository` is the onboarding wiring (deliverable 4): it resolves the
 * App installation for the repository, inspects the ruleset fail-closed, installs
 * the required policy when missing/weak, strips any engine bypass, and re-verifies
 * the engine identity is not an eligible reviewer. A repository whose ruleset is
 * not enforceable after install cannot become landing-enabled (acceptance 7).
 *
 * Credentials never enter this module: every call goes through the
 * {@link GitHubAppAuth} handle, which returns only opaque installation tokens.
 */

import type {
  GitHubBypassActor,
  GitHubClient,
  GitHubPullRequestParameters,
  GitHubRule,
  GitHubRulesetDetail,
  GitHubRulesetSummary,
} from "./github-client.js";
import { GitHubClientError } from "./github-client.js";
import type { BotIdentity, GitHubAppAuth } from "./github-app-auth.js";
import { GitHubAppAuthError } from "./github-app-auth.js";

export type GitHubRulesetErrorCode =
  | "auth_failed"
  | "api_error"
  | "ruleset_missing"
  | "ruleset_weak"
  | "engine_eligible"
  | "drift_detected"
  | "install_failed"
  | "identity_unresolved";

export class GitHubRulesetError extends Error {
  readonly code: GitHubRulesetErrorCode;
  override readonly cause: unknown;

  constructor(code: GitHubRulesetErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitHubRulesetError";
    this.code = code;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Policy model.
// -------------------------------------------------------------------------------------------------

/**
 * The independent-human-review policy. Each field is fail-closed: a repository
 * whose current ruleset does not meet every field is classified non-enforceable.
 */
export interface GitHubReviewPolicy {
  /** Minimum approving reviews required (GIT-10: ≥ 1). */
  readonly requireApprovingReviews: number;
  /** Stale approvals must be dismissed on push (GIT-10). */
  readonly dismissStaleReviews: boolean;
  /** Whether code-owner reviews are required (repo-specific; default false). */
  readonly requireCodeOwnerReviews: boolean;
  /** Approval required after the engine's latest push (GIT-10). */
  readonly requireLatestPushApproval: boolean;
  /** The engine bot identity must not hold a ruleset bypass (GIT-10/GIT-11). */
  readonly noBypassForEngine: boolean;
}

/** The baseline policy enforced at onboarding (PR 31 acceptance). */
export const REQUIRED_REVIEW_POLICY: GitHubReviewPolicy = Object.freeze({
  requireApprovingReviews: 1,
  dismissStaleReviews: true,
  requireCodeOwnerReviews: false,
  requireLatestPushApproval: true,
  noBypassForEngine: true,
});

/** The ruleset name this engine installs/owns. */
export const MINIONS_REVIEW_RULESET_NAME = "minions-independent-review";

const defaultBranchName = "main";

// -------------------------------------------------------------------------------------------------
// Inspection report.
// -------------------------------------------------------------------------------------------------

export type GitHubRulesetClassification =
  "enforceable" | "ruleset_missing" | "ruleset_weak" | "engine_eligible";

export type GitHubRulesetFindingKind =
  | "missing_pull_request_rule"
  | "approval_count_below_minimum"
  | "stale_reviews_not_dismissed"
  | "latest_push_approval_not_required"
  | "code_owner_reviews_mismatch"
  | "enforcement_disabled"
  | "engine_bypass_granted";

export interface GitHubRulesetFinding {
  readonly kind: GitHubRulesetFindingKind;
  readonly detail: string;
}

export interface GitHubRulesetReport {
  readonly repositoryFullName: string;
  readonly classification: GitHubRulesetClassification;
  readonly findings: readonly GitHubRulesetFinding[];
  readonly matchedRuleset: GitHubRulesetDetail | undefined;
  readonly expectedPolicy: GitHubReviewPolicy;
  readonly engineBotIdentity: BotIdentity;
  readonly defaultBranch: string;
  readonly inspectedAt: string;
}

export type InspectRulesetOptions = Readonly<{
  policy?: GitHubReviewPolicy;
  defaultBranch?: string;
  /** Injectable clock returning epoch milliseconds. */
  now?: () => number;
}>;

// -------------------------------------------------------------------------------------------------
// Install receipt.
// -------------------------------------------------------------------------------------------------

export type InstallAction = "created" | "updated" | "unchanged";

export interface GitHubRulesetReceipt {
  readonly repositoryFullName: string;
  readonly action: InstallAction;
  readonly ruleset: GitHubRulesetDetail;
  readonly policy: GitHubReviewPolicy;
  readonly engineBotIdentity: BotIdentity;
  readonly classification: GitHubRulesetClassification;
  readonly installedAt: string;
}

export type InstallRulesetOptions = Readonly<{
  policy?: GitHubReviewPolicy;
  defaultBranch?: string;
  now?: () => number;
}>;

// -------------------------------------------------------------------------------------------------
// Drift report.
// -------------------------------------------------------------------------------------------------

export type DriftStatus = "ok" | "drift_detected" | "engine_eligible";

export type DriftFindingKind =
  | "rule_removed"
  | "approval_count_weakened"
  | "stale_dismissal_disabled"
  | "latest_push_approval_disabled"
  | "code_owner_reviews_changed"
  | "enforcement_disabled"
  | "engine_bypass_granted";

export interface DriftFinding {
  readonly kind: DriftFindingKind;
  readonly detail: string;
}

export interface DriftReport {
  readonly repositoryFullName: string;
  readonly status: DriftStatus;
  readonly findings: readonly DriftFinding[];
  readonly expectedPolicy: GitHubReviewPolicy;
  readonly inspectedAt: string;
}

export type DetectDriftOptions = Readonly<{
  policy?: GitHubReviewPolicy;
  defaultBranch?: string;
  now?: () => number;
}>;

// -------------------------------------------------------------------------------------------------
// Public API.
// -------------------------------------------------------------------------------------------------

/**
 * Inspect the current repository ruleset and classify whether it enforces
 * independent current human review. Never throws for a non-enforceable state —
 * that is returned as the `classification`. Throws only on API/identity failure.
 */
export async function inspectRuleset(
  auth: GitHubAppAuth,
  repositoryFullName: string,
  options?: InspectRulesetOptions,
): Promise<GitHubRulesetReport> {
  const policy = options?.policy ?? REQUIRED_REVIEW_POLICY;
  const branch = options?.defaultBranch ?? defaultBranchName;
  const client = await acquireClient(auth, repositoryFullName);
  const engineBotIdentity = await resolveEngineBotIdentity(auth);
  const summaries = await fetchRulesetSummaries(client, repositoryFullName);
  const branchCandidates = summaries.filter(
    (summary) => summary.target === "branch" && summary.enforcement === "active",
  );
  const inspectedDetails: GitHubRulesetDetail[] = [];
  for (const summary of branchCandidates) {
    const detail = await fetchRulesetDetail(client, repositoryFullName, summary.id);
    if (rulesetCoversBranch(detail, branch)) {
      inspectedDetails.push(detail);
    }
  }
  const findings: GitHubRulesetFinding[] = [];
  let engineBypass = false;
  for (const detail of inspectedDetails) {
    if (policy.noBypassForEngine && engineHasBypass(detail, engineBotIdentity.appId)) {
      findings.push({
        kind: "engine_bypass_granted",
        detail: `ruleset '${detail.name}' grants the engine App (integration id ${String(engineBotIdentity.appId)}) a bypass`,
      });
      engineBypass = true;
    }
  }
  const matched = findPullRequestRuleset(inspectedDetails);
  if (matched === undefined) {
    findings.push({
      kind: "missing_pull_request_rule",
      detail: `no active branch ruleset with a pull_request rule covers refs/heads/${branch}`,
    });
  } else {
    collectPolicyFindings(matched, policy, findings);
  }
  const classification = classify(findings, engineBypass);
  return Object.freeze({
    repositoryFullName,
    classification,
    findings: Object.freeze(findings),
    matchedRuleset: matched,
    expectedPolicy: policy,
    engineBotIdentity,
    defaultBranch: branch,
    inspectedAt: isoNow(options?.now),
  });
}

/**
 * Install or update the required ruleset so the repository enforces `policy`.
 * Creates the ruleset when absent, updates it when present-but-mismatched, and is
 * a no-op (action `unchanged`) when the current ruleset already matches.
 */
export async function installRuleset(
  auth: GitHubAppAuth,
  repositoryFullName: string,
  options?: InstallRulesetOptions,
): Promise<GitHubRulesetReceipt> {
  const policy = options?.policy ?? REQUIRED_REVIEW_POLICY;
  const branch = options?.defaultBranch ?? defaultBranchName;
  const client = await acquireClient(auth, repositoryFullName);
  const engineBotIdentity = await resolveEngineBotIdentity(auth);
  const existing = await findOwnedRuleset(client, repositoryFullName, branch);
  const config = policyToRulesetConfig(policy, branch);
  let action: InstallAction;
  let ruleset: GitHubRulesetDetail;
  if (existing === undefined) {
    try {
      ruleset = await client.createRuleset(repositoryFullName, config);
    } catch (error: unknown) {
      throw rulesetError(
        error,
        "install_failed",
        `failed to create ruleset on '${repositoryFullName}'`,
      );
    }
    action = "created";
  } else if (rulesetMatchesPolicy(existing, policy, engineBotIdentity.appId)) {
    ruleset = existing;
    action = "unchanged";
  } else {
    try {
      ruleset = await client.updateRuleset(repositoryFullName, existing.id, config);
    } catch (error: unknown) {
      throw rulesetError(
        error,
        "install_failed",
        `failed to update ruleset ${String(existing.id)} on '${repositoryFullName}'`,
      );
    }
    action = "updated";
  }
  const classification = classifyRulesetDetail(ruleset, policy, engineBotIdentity.appId, branch);
  return Object.freeze({
    repositoryFullName,
    action,
    ruleset,
    policy,
    engineBotIdentity,
    classification,
    installedAt: isoNow(options?.now),
  });
}

/**
 * Compare the current ruleset against `expectedPolicy`. Detects a removed rule,
 * a weakened parameter, disabled enforcement, or an engine bypass grant.
 */
export async function detectDrift(
  auth: GitHubAppAuth,
  repositoryFullName: string,
  options?: DetectDriftOptions,
): Promise<DriftReport> {
  const report = await inspectRuleset(auth, repositoryFullName, options);
  const findings: DriftFinding[] = [];
  let engineEligible = false;
  for (const finding of report.findings) {
    const mapped = mapInspectionFinding(finding);
    if (mapped !== undefined) {
      findings.push(mapped);
      if (mapped.kind === "engine_bypass_granted") {
        engineEligible = true;
      }
    }
  }
  const status: DriftStatus =
    findings.length === 0 ? "ok" : engineEligible ? "engine_eligible" : "drift_detected";
  return Object.freeze({
    repositoryFullName,
    status,
    findings: Object.freeze(findings),
    expectedPolicy: report.expectedPolicy,
    inspectedAt: report.inspectedAt,
  });
}

/** Resolve the App's bot identity (login + ids) for reviewer-eligibility checks. */
export async function resolveEngineBotIdentity(auth: GitHubAppAuth): Promise<BotIdentity> {
  try {
    return await auth.resolveAppIdentity();
  } catch (error: unknown) {
    if (error instanceof GitHubRulesetError) {
      throw error;
    }
    const message =
      error instanceof GitHubAppAuthError
        ? error.message
        : `failed to resolve engine bot identity: ${errorToString(error)}`;
    throw new GitHubRulesetError("identity_unresolved", message, error);
  }
}

// -------------------------------------------------------------------------------------------------
// Onboarding wiring (deliverable 4).
// -------------------------------------------------------------------------------------------------

export type OnboardRepositoryOptions = Readonly<{
  policy?: GitHubReviewPolicy;
  defaultBranch?: string;
  now?: () => number;
}>;

export interface RepositoryOnboardingReceipt {
  readonly repositoryFullName: string;
  readonly installReceipt: GitHubRulesetReceipt;
  /** Final classification after install + re-verification. Always `enforceable` on success. */
  readonly classification: GitHubRulesetClassification;
  readonly engineBotIdentity: BotIdentity;
  readonly onboardedAt: string;
}

/**
 * Onboard a repository for landing (acceptance 7). Resolves the App installation,
 * inspects the ruleset fail-closed, installs the required policy when missing or
 * weak (stripping any engine bypass), and re-verifies the engine identity is not
 * an eligible reviewer. Throws `GitHubRulesetError` (any code) if the repository
 * cannot be made enforceable — it NEVER silently lands a non-enforceable repo.
 */
export async function onboardRepository(
  auth: GitHubAppAuth,
  repositoryFullName: string,
  options?: OnboardRepositoryOptions,
): Promise<RepositoryOnboardingReceipt> {
  const installReceipt = await installRuleset(auth, repositoryFullName, options);
  // Defense-in-depth: re-inspect after install. An org-level rule we cannot modify
  // could keep the repo non-enforceable even after our install; fail-closed then.
  const verification = await inspectRuleset(auth, repositoryFullName, options);
  if (verification.classification === "engine_eligible") {
    throw new GitHubRulesetError(
      "engine_eligible",
      `repository '${repositoryFullName}' grants the engine bot a ruleset bypass after install; cannot become landing-enabled`,
    );
  }
  if (verification.classification !== "enforceable") {
    throw new GitHubRulesetError(
      verification.classification === "ruleset_missing" ? "ruleset_missing" : "ruleset_weak",
      `repository '${repositoryFullName}' is not enforceable after install (classification=${verification.classification})`,
    );
  }
  return Object.freeze({
    repositoryFullName,
    installReceipt,
    classification: verification.classification,
    engineBotIdentity: verification.engineBotIdentity,
    onboardedAt: isoNow(options?.now),
  });
}

// -------------------------------------------------------------------------------------------------
// Internals: client acquisition + error wrapping.
// -------------------------------------------------------------------------------------------------

async function acquireClient(
  auth: GitHubAppAuth,
  repositoryFullName: string,
): Promise<GitHubClient> {
  try {
    return await auth.clientFor(repositoryFullName);
  } catch (error: unknown) {
    throw rulesetError(error, "auth_failed", `failed to authenticate for '${repositoryFullName}'`);
  }
}

async function fetchRulesetSummaries(
  client: GitHubClient,
  repositoryFullName: string,
): Promise<readonly GitHubRulesetSummary[]> {
  return wrapApi(
    () => client.getRulesets(repositoryFullName),
    `list rulesets on '${repositoryFullName}'`,
  );
}

async function fetchRulesetDetail(
  client: GitHubClient,
  repositoryFullName: string,
  id: number,
): Promise<GitHubRulesetDetail> {
  return wrapApi(
    () => client.getRuleset(repositoryFullName, id),
    `fetch ruleset ${String(id)} on '${repositoryFullName}'`,
  );
}

async function wrapApi<T>(operation: () => Promise<T>, context: string): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof GitHubClientError) {
      const code: GitHubRulesetErrorCode =
        error.code === "auth_failed" ? "auth_failed" : "api_error";
      throw new GitHubRulesetError(
        code,
        `${context}: ${error.code} (${String(error.status)}) ${error.message}`,
        error,
      );
    }
    throw new GitHubRulesetError("api_error", `${context}: ${errorToString(error)}`, error);
  }
}

function rulesetError(
  error: unknown,
  code: GitHubRulesetErrorCode,
  context: string,
): GitHubRulesetError {
  if (error instanceof GitHubRulesetError) {
    return error;
  }
  if (error instanceof GitHubClientError) {
    return new GitHubRulesetError(
      code,
      `${context}: ${error.code} (${String(error.status)}) ${error.message}`,
      error,
    );
  }
  return new GitHubRulesetError(code, `${context}: ${errorToString(error)}`, error);
}

// -------------------------------------------------------------------------------------------------
// Internals: classification.
// -------------------------------------------------------------------------------------------------

function classify(
  findings: readonly GitHubRulesetFinding[],
  engineBypass: boolean,
): GitHubRulesetClassification {
  if (engineBypass) {
    return "engine_eligible";
  }
  const missing = findings.some((finding) => finding.kind === "missing_pull_request_rule");
  if (missing) {
    return "ruleset_missing";
  }
  if (findings.length > 0) {
    return "ruleset_weak";
  }
  return "enforceable";
}

function classifyRulesetDetail(
  detail: GitHubRulesetDetail,
  policy: GitHubReviewPolicy,
  engineAppId: number,
  branch: string,
): GitHubRulesetClassification {
  const findings: GitHubRulesetFinding[] = [];
  const engineBypass = policy.noBypassForEngine && engineHasBypass(detail, engineAppId);
  if (rulesetCoversBranch(detail, branch)) {
    collectPolicyFindings(detail, policy, findings);
  } else {
    findings.push({
      kind: "missing_pull_request_rule",
      detail: "ruleset does not cover the default branch",
    });
  }
  return classify(findings, engineBypass);
}

function findPullRequestRuleset(
  details: readonly GitHubRulesetDetail[],
): GitHubRulesetDetail | undefined {
  for (const detail of details) {
    if (detail.rules.some((rule) => rule.type === "pull_request")) {
      return detail;
    }
  }
  return undefined;
}

function collectPolicyFindings(
  detail: GitHubRulesetDetail,
  policy: GitHubReviewPolicy,
  findings: GitHubRulesetFinding[],
): void {
  const rule = detail.rules.find(
    (candidate): candidate is PullRequestRule =>
      candidate.type === "pull_request" && candidate.pullRequestParameters !== undefined,
  );
  if (rule === undefined) {
    findings.push({
      kind: "missing_pull_request_rule",
      detail: `ruleset '${detail.name}' has no pull_request rule`,
    });
    return;
  }
  const params = rule.pullRequestParameters;
  if (params.requiredApprovingReviewCount < policy.requireApprovingReviews) {
    findings.push({
      kind: "approval_count_below_minimum",
      detail: `required_approving_review_count=${String(params.requiredApprovingReviewCount)} is below the required ${String(policy.requireApprovingReviews)}`,
    });
  }
  if (policy.dismissStaleReviews && !params.dismissStaleReviewsOnPush) {
    findings.push({
      kind: "stale_reviews_not_dismissed",
      detail: "dismiss_stale_reviews_on_push is false; stale approvals are not dismissed",
    });
  }
  if (policy.requireLatestPushApproval && !params.requireLastPushApproval) {
    findings.push({
      kind: "latest_push_approval_not_required",
      detail: "require_last_push_approval is false; approval after the engine push is not required",
    });
  }
  if (params.requireCodeOwnerReviews !== policy.requireCodeOwnerReviews) {
    findings.push({
      kind: "code_owner_reviews_mismatch",
      detail: `require_code_owner_reviews=${String(params.requireCodeOwnerReviews)} does not match policy ${String(policy.requireCodeOwnerReviews)}`,
    });
  }
}

type PullRequestRule = GitHubRule & { readonly pullRequestParameters: GitHubPullRequestParameters };

function engineHasBypass(detail: GitHubRulesetDetail, engineAppId: number): boolean {
  return detail.bypassActors.some(
    (actor: GitHubBypassActor) =>
      actor.actorType === "Integration" && actor.actorId === engineAppId,
  );
}

// -------------------------------------------------------------------------------------------------
// Internals: branch coverage + ruleset matching.
// -------------------------------------------------------------------------------------------------

function rulesetCoversBranch(detail: GitHubRulesetDetail, branch: string): boolean {
  const conditionsValue = detail.raw["conditions"];
  if (conditionsValue === undefined || conditionsValue === null) {
    // A repo ruleset without conditions applies to every branch.
    return true;
  }
  if (typeof conditionsValue !== "object") {
    return false;
  }
  const conditions = conditionsValue as Readonly<Record<string, unknown>>;
  const refNameValue = conditions["ref_name"];
  if (refNameValue === undefined || refNameValue === null) {
    return true;
  }
  if (typeof refNameValue !== "object") {
    return false;
  }
  const refName = refNameValue as Readonly<Record<string, unknown>>;
  const include = Array.isArray(refName["include"])
    ? (refName["include"] as readonly unknown[])
    : [];
  const exclude = Array.isArray(refName["exclude"])
    ? (refName["exclude"] as readonly unknown[])
    : [];
  const branchRef = `refs/heads/${branch}`;
  const wildcardCovers = (entry: unknown): boolean =>
    entry === "~DEFAULT_BRANCH" || entry === "~ALL" || entry === branchRef;
  const included = include.length === 0 || include.some(wildcardCovers);
  const excluded = exclude.some((entry) => entry === branchRef || entry === "~DEFAULT_BRANCH");
  return included && !excluded;
}

function rulesetMatchesPolicy(
  detail: GitHubRulesetDetail,
  policy: GitHubReviewPolicy,
  engineAppId: number,
): boolean {
  const params = pullRequestParametersOf(detail);
  if (params === undefined) {
    return false;
  }
  if (policy.noBypassForEngine && engineHasBypass(detail, engineAppId)) {
    return false;
  }
  return (
    params.requiredApprovingReviewCount >= policy.requireApprovingReviews &&
    params.dismissStaleReviewsOnPush === policy.dismissStaleReviews &&
    params.requireLastPushApproval === policy.requireLatestPushApproval &&
    params.requireCodeOwnerReviews === policy.requireCodeOwnerReviews
  );
}

function pullRequestParametersOf(
  detail: GitHubRulesetDetail,
): GitHubPullRequestParameters | undefined {
  for (const rule of detail.rules) {
    if (rule.type === "pull_request" && rule.pullRequestParameters !== undefined) {
      return rule.pullRequestParameters;
    }
  }
  return undefined;
}

async function findOwnedRuleset(
  client: GitHubClient,
  repositoryFullName: string,
  branch: string,
): Promise<GitHubRulesetDetail | undefined> {
  const summaries = await fetchRulesetSummaries(client, repositoryFullName);
  for (const summary of summaries) {
    if (
      summary.name === MINIONS_REVIEW_RULESET_NAME &&
      summary.target === "branch" &&
      summary.enforcement === "active"
    ) {
      const detail = await fetchRulesetDetail(client, repositoryFullName, summary.id);
      if (rulesetCoversBranch(detail, branch)) {
        return detail;
      }
    }
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------------
// Internals: policy -> wire config.
// -------------------------------------------------------------------------------------------------

function policyToRulesetConfig(policy: GitHubReviewPolicy, branch: string): GitHubRulesetConfigOut {
  return {
    name: MINIONS_REVIEW_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    includeBranches: [`refs/heads/${branch}`],
    excludeBranches: [],
    rules: [
      {
        type: "pull_request",
        pullRequestParameters: {
          requiredApprovingReviewCount: policy.requireApprovingReviews,
          dismissStaleReviewsOnPush: policy.dismissStaleReviews,
          requireCodeOwnerReviews: policy.requireCodeOwnerReviews,
          requireLastPushApproval: policy.requireLatestPushApproval,
          requiredReviewThreadResolution: true,
        },
      },
    ],
    // `noBypassForEngine` is enforced by OMITTING the engine from bypassActors.
    bypassActors: [],
  };
}

type GitHubRulesetConfigOut = Readonly<{
  name: string;
  target: "branch";
  enforcement: "active";
  includeBranches: readonly string[];
  excludeBranches: readonly string[];
  rules: readonly Readonly<{
    type: "pull_request";
    pullRequestParameters: GitHubPullRequestParameters;
  }>[];
  bypassActors: readonly GitHubBypassActor[];
}>;

// -------------------------------------------------------------------------------------------------
// Internals: drift mapping.
// -------------------------------------------------------------------------------------------------

function mapInspectionFinding(finding: GitHubRulesetFinding): DriftFinding | undefined {
  switch (finding.kind) {
    case "missing_pull_request_rule":
      return { kind: "rule_removed", detail: finding.detail };
    case "approval_count_below_minimum":
      return { kind: "approval_count_weakened", detail: finding.detail };
    case "stale_reviews_not_dismissed":
      return { kind: "stale_dismissal_disabled", detail: finding.detail };
    case "latest_push_approval_not_required":
      return { kind: "latest_push_approval_disabled", detail: finding.detail };
    case "code_owner_reviews_mismatch":
      return { kind: "code_owner_reviews_changed", detail: finding.detail };
    case "enforcement_disabled":
      return { kind: "enforcement_disabled", detail: finding.detail };
    case "engine_bypass_granted":
      return { kind: "engine_bypass_granted", detail: finding.detail };
  }
}

// -------------------------------------------------------------------------------------------------
// Internals: misc.
// -------------------------------------------------------------------------------------------------

function isoNow(now: (() => number) | undefined): string {
  return new Date((now ?? Date.now)()).toISOString();
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
