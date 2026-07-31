/**
 * Typed GitHub REST client — a minimal `fetch` wrapper with rate-limit handling,
 * strict response validation, and typed errors. Covers the subset of the GitHub
 * REST API needed for independent-human-review ruleset enforcement (PR 31):
 * repository rulesets, branch protection, App identity, installation tokens, and
 * installation repositories.
 *
 * ## Strict parsing discipline
 * No `any`: every response body is read as `unknown` and walked through dedicated
 * validators (`requireObject`, `requireString`, `requireNumber`, …) that throw
 * `response_invalid` on a malformed shape. This mirrors the omp-acp-adapter
 * strict-parsing discipline and means a GitHub schema drift cannot smuggle an
 * unvalidated value into the ruleset classifier.
 *
 * ## Credentials (SEC-10)
 * The client accepts a single pre-resolved bearer `token`. It NEVER reads
 * credentials from env/argv/logs and has no path into a sandbox. The App private
 * key lives in the {@link CredentialVault} (PR 19) and is materialised into a JWT
 * only inside `github-app-auth.ts`; this module only ever sees opaque tokens.
 */

const defaultBaseUrl = "https://api.github.com";
const defaultApiVersion = "2022-11-28";
const defaultUserAgent = "minions-github-ruleset/0";
const jsonMediaType = "application/json";
const githubAccept = "application/vnd.github+json";

export type GitHubClientErrorCode =
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "response_invalid";

export class GitHubClientError extends Error {
  readonly code: GitHubClientErrorCode;
  readonly status: number;
  /** Seconds until the rate-limit window resets, when known (rate_limited only). */
  readonly retryAfterSeconds: number | undefined;
  override readonly cause: unknown;

  constructor(
    code: GitHubClientErrorCode,
    message: string,
    status: number,
    options?: Readonly<{ cause?: unknown; retryAfterSeconds?: number }>,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubClientError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.cause = options?.cause;
  }
}

export type GitHubFetch = typeof globalThis.fetch;

export type GitHubClientOptions = Readonly<{
  /** Pre-resolved bearer token (installation token or App JWT). Never logged. */
  token: string;
  baseUrl?: string;
  apiVersion?: string;
  userAgent?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: GitHubFetch;
  /** Injectable clock returning epoch milliseconds (for rate-limit reset math). */
  now?: () => number;
}>;

// -------------------------------------------------------------------------------------------------
// Wire response models (strictly validated).
// -------------------------------------------------------------------------------------------------

export type GitHubRulesetEnforcement = "active" | "disabled" | "evaluate";
export type GitHubRulesetTarget = "branch" | "tag";
export type GitHubRuleType =
  | "pull_request"
  | "required_signatures"
  | "required_status_checks"
  | "commit_message"
  | "non_fast_forward"
  | "creation"
  | "update"
  | "deletion";

export interface GitHubPullRequestParameters {
  readonly requiredApprovingReviewCount: number;
  readonly dismissStaleReviewsOnPush: boolean;
  readonly requireCodeOwnerReviews: boolean;
  readonly requireLastPushApproval: boolean;
  readonly requiredReviewThreadResolution: boolean;
}

export interface GitHubRule {
  readonly type: GitHubRuleType;
  /** Present only for `type === "pull_request"`. */
  readonly pullRequestParameters: GitHubPullRequestParameters | undefined;
  /** The validated raw rule object (additional unmodeled parameters preserved). */
  readonly raw: Readonly<Record<string, unknown>>;
}

export type GitHubBypassActorType =
  "RepositoryRole" | "Integration" | "OrganizationAdmin" | "Team" | "User";

export type GitHubBypassMode = "always" | "pull_request";

export interface GitHubBypassActor {
  readonly actorId: number;
  readonly actorType: GitHubBypassActorType;
  readonly bypassMode: GitHubBypassMode;
}

export interface GitHubRulesetSummary {
  readonly id: number;
  readonly name: string;
  readonly target: GitHubRulesetTarget;
  readonly sourceType: string;
  readonly enforcement: GitHubRulesetEnforcement;
}

export interface GitHubRulesetDetail extends GitHubRulesetSummary {
  readonly rules: readonly GitHubRule[];
  readonly bypassActors: readonly GitHubBypassActor[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * The validated raw ruleset object. Preserves fields this client does not
   * model (e.g. `conditions.ref_name`) so callers can inspect branch coverage.
   */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GitHubBranchProtectionPullRequestReviews {
  readonly requiredApprovingReviewCount: number;
  readonly dismissStaleReviews: boolean;
  readonly requireCodeOwnerReviews: boolean;
}

export interface GitHubBranchProtection {
  readonly branch: string;
  readonly requiredPullRequestReviews: GitHubBranchProtectionPullRequestReviews | undefined;
}

export interface GitHubAppInfo {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
}

export type GitHubUserType = "Bot" | "User" | "Organization";

export interface GitHubUser {
  readonly id: number;
  readonly login: string;
  readonly type: GitHubUserType;
}

export interface GitHubInstallationRepository {
  readonly id: number;
  readonly fullName: string;
}

export interface GitHubRepositoryInstallation {
  readonly id: number;
  readonly appId: number;
  readonly appSlug: string;
}

export interface GitHubInstallationToken {
  readonly token: string;
  /** ISO-8601 expiry timestamp from GitHub. */
  readonly expiresAt: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly repositories: readonly GitHubInstallationRepository[];
}

// -------------------------------------------------------------------------------------------------
// Request body models (typed outbound payloads).
// -------------------------------------------------------------------------------------------------

export interface GitHubRulesetConfig {
  readonly name: string;
  readonly target: GitHubRulesetTarget;
  readonly enforcement: GitHubRulesetEnforcement;
  readonly includeBranches: readonly string[];
  readonly excludeBranches: readonly string[];
  readonly rules: readonly GitHubRulesetRuleConfig[];
  readonly bypassActors: readonly GitHubBypassActor[];
}

export interface GitHubRulesetRuleConfig {
  readonly type: GitHubRuleType;
  readonly pullRequestParameters: GitHubPullRequestParameters | undefined;
}

export interface GitHubClient {
  readonly token: string;
  getRulesets(repositoryFullName: string): Promise<readonly GitHubRulesetSummary[]>;
  getRuleset(repositoryFullName: string, id: number): Promise<GitHubRulesetDetail>;
  createRuleset(
    repositoryFullName: string,
    config: GitHubRulesetConfig,
  ): Promise<GitHubRulesetDetail>;
  updateRuleset(
    repositoryFullName: string,
    id: number,
    config: GitHubRulesetConfig,
  ): Promise<GitHubRulesetDetail>;
  deleteRuleset(repositoryFullName: string, id: number): Promise<void>;
  getBranchProtection(
    repositoryFullName: string,
    branch: string,
  ): Promise<GitHubBranchProtection | undefined>;
  getApp(): Promise<GitHubAppInfo>;
  getUserByLogin(login: string): Promise<GitHubUser>;
  getInstallationRepositories(): Promise<readonly GitHubInstallationRepository[]>;
  getRepositoryInstallation(repositoryFullName: string): Promise<GitHubRepositoryInstallation>;
  createInstallationToken(installationId: number): Promise<GitHubInstallationToken>;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const token = options.token;
  if (token.length === 0) {
    throw new GitHubClientError("auth_failed", "GitHub client token is empty", 0);
  }
  const baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/u, "");
  const apiVersion = options.apiVersion ?? defaultApiVersion;
  const userAgent = options.userAgent ?? defaultUserAgent;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());

  return new GitHubClientImpl(token, baseUrl, apiVersion, userAgent, fetchImpl, now);
}

class GitHubClientImpl implements GitHubClient {
  constructor(
    readonly token: string,
    private readonly baseUrl: string,
    private readonly apiVersion: string,
    private readonly userAgent: string,
    private readonly fetchImpl: GitHubFetch,
    private readonly now: () => number,
  ) {}

  async getRulesets(repositoryFullName: string): Promise<readonly GitHubRulesetSummary[]> {
    const body = await this.requestJson("GET", `/repos/${repositoryFullName}/rulesets`);
    return parseRulesetSummaryArray(body);
  }

  async getRuleset(repositoryFullName: string, id: number): Promise<GitHubRulesetDetail> {
    const body = await this.requestJson(
      "GET",
      `/repos/${repositoryFullName}/rulesets/${String(id)}`,
    );
    return parseRulesetDetail(body);
  }

  async createRuleset(
    repositoryFullName: string,
    config: GitHubRulesetConfig,
  ): Promise<GitHubRulesetDetail> {
    const body = await this.requestJson(
      "POST",
      `/repos/${repositoryFullName}/rulesets`,
      serializeRulesetConfig(config),
    );
    return parseRulesetDetail(body);
  }

  async updateRuleset(
    repositoryFullName: string,
    id: number,
    config: GitHubRulesetConfig,
  ): Promise<GitHubRulesetDetail> {
    const body = await this.requestJson(
      "PUT",
      `/repos/${repositoryFullName}/rulesets/${String(id)}`,
      serializeRulesetConfig(config),
    );
    return parseRulesetDetail(body);
  }

  async deleteRuleset(repositoryFullName: string, id: number): Promise<void> {
    await this.requestEmpty("DELETE", `/repos/${repositoryFullName}/rulesets/${String(id)}`);
  }

  async getBranchProtection(
    repositoryFullName: string,
    branch: string,
  ): Promise<GitHubBranchProtection | undefined> {
    const result = await this.requestOptional(
      "GET",
      `/repos/${repositoryFullName}/branches/${branch}/protection`,
    );
    if (result === undefined) {
      return undefined;
    }
    return parseBranchProtection(result, branch);
  }

  async getApp(): Promise<GitHubAppInfo> {
    const body = await this.requestJson("GET", "/app");
    return parseAppInfo(body);
  }

  async getUserByLogin(login: string): Promise<GitHubUser> {
    const body = await this.requestJson("GET", `/users/${login}`);
    return parseUser(body);
  }

  async getInstallationRepositories(): Promise<readonly GitHubInstallationRepository[]> {
    const body = await this.requestJson("GET", `/installation/repositories`);
    return parseInstallationRepositories(body);
  }
  async getRepositoryInstallation(
    repositoryFullName: string,
  ): Promise<GitHubRepositoryInstallation> {
    const body = await this.requestJson("GET", `/repos/${repositoryFullName}/installation`);
    return parseRepositoryInstallation(body);
  }

  async createInstallationToken(installationId: number): Promise<GitHubInstallationToken> {
    const body = await this.requestJson(
      "POST",
      `/app/installations/${String(installationId)}/access_tokens`,
      {},
    );
    return parseInstallationToken(body);
  }

  // -----------------------------------------------------------------------------------------------
  // Core request helpers.
  // -----------------------------------------------------------------------------------------------

  private async requestJson(
    method: string,
    path: string,
    requestBody?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const { response } = await this.send(method, path, requestBody);
    const text = await response.text();
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new GitHubClientError(
        "response_invalid",
        `GitHub ${method} ${path} returned a non-JSON body`,
        response.status,
        { cause: error },
      );
    }
  }

  private async requestOptional(method: string, path: string): Promise<unknown> {
    const { response } = await this.send(method, path, undefined);
    if (response.status === 404) {
      return undefined;
    }
    this.assertAcceptable(response, method, path);
    const text = await response.text();
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new GitHubClientError(
        "response_invalid",
        `GitHub ${method} ${path} returned a non-JSON body`,
        response.status,
        { cause: error },
      );
    }
  }

  private async requestEmpty(method: string, path: string): Promise<void> {
    const { response } = await this.send(method, path, undefined);
    if (response.status === 204 || response.status === 200) {
      return;
    }
    this.assertAcceptable(response, method, path);
  }

  private async send(
    method: string,
    path: string,
    requestBody: Readonly<Record<string, unknown>> | undefined,
  ): Promise<{ response: Response }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      accept: githubAccept,
      "x-github-api-version": this.apiVersion,
      authorization: `Bearer ${this.token}`,
      "user-agent": this.userAgent,
    };
    const init: RequestInit = { method, headers };
    if (requestBody !== undefined) {
      headers["content-type"] = jsonMediaType;
      init.body = JSON.stringify(requestBody);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error: unknown) {
      throw new GitHubClientError(
        "network_error",
        `GitHub ${method} ${path} network request failed: ${errorToString(error)}`,
        0,
        { cause: error },
      );
    }
    this.assertAcceptable(response, method, path);
    return { response };
  }

  private assertAcceptable(response: Response, method: string, path: string): void {
    if (response.status >= 200 && response.status < 300) {
      return;
    }
    if (response.status === 401) {
      throw new GitHubClientError(
        "auth_failed",
        `GitHub ${method} ${path} rejected the bearer token (401)`,
        response.status,
      );
    }
    if (response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        throw new GitHubClientError(
          "rate_limited",
          `GitHub ${method} ${path} exhausted the rate limit (403)`,
          response.status,
          rateLimitOptions(response.headers, this.now()),
        );
      }
      throw new GitHubClientError(
        "forbidden",
        `GitHub ${method} ${path} returned 403 Forbidden`,
        response.status,
      );
    }
    if (response.status === 404) {
      throw new GitHubClientError(
        "not_found",
        `GitHub ${method} ${path} returned 404 Not Found`,
        response.status,
      );
    }
    if (response.status === 429) {
      throw new GitHubClientError(
        "rate_limited",
        `GitHub ${method} ${path} returned 429 Too Many Requests`,
        response.status,
        rateLimitOptions(response.headers, this.now()),
      );
    }
    if (response.status >= 500) {
      throw new GitHubClientError(
        "server_error",
        `GitHub ${method} ${path} returned ${String(response.status)}`,
        response.status,
      );
    }
    throw new GitHubClientError(
      "server_error",
      `GitHub ${method} ${path} returned unexpected status ${String(response.status)}`,
      response.status,
    );
  }
}

// -------------------------------------------------------------------------------------------------
// Rate-limit plumbing. `x-ratelimit-reset` is a unix epoch in seconds; the caller
// guards NaN. `retry-after` (seconds) takes precedence when GitHub sends it.
// -------------------------------------------------------------------------------------------------

function retryAfterSeconds(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const parsed = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  const resetEpoch = headers.get("x-ratelimit-reset");
  if (resetEpoch !== null) {
    const parsed = Number.parseInt(resetEpoch, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed - Math.floor(now / 1000));
    }
  }
  return undefined;
}

function rateLimitOptions(headers: Headers, now: number): Readonly<{ retryAfterSeconds?: number }> {
  const retry = retryAfterSeconds(headers, now);
  if (retry === undefined) {
    return {};
  }
  return { retryAfterSeconds: retry };
}

// -------------------------------------------------------------------------------------------------
// Strict validators (unknown -> typed). Each throws response_invalid on a bad shape.
// -------------------------------------------------------------------------------------------------

function requireObject(value: unknown, context: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubClientError(
      "response_invalid",
      `${context}: expected a JSON object, got ${describe(value)}`,
      200,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new GitHubClientError(
      "response_invalid",
      `${context}: expected a JSON array, got ${describe(value)}`,
      200,
    );
  }
  return value;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubClientError(
      "response_invalid",
      `${context}: expected a non-empty string, got ${describe(value)}`,
      200,
    );
  }
  return value;
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GitHubClientError(
      "response_invalid",
      `${context}: expected a finite number, got ${describe(value)}`,
      200,
    );
  }
  return value;
}

function requireBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new GitHubClientError(
      "response_invalid",
      `${context}: expected a boolean, got ${describe(value)}`,
      200,
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseEnforcement(value: unknown, context: string): GitHubRulesetEnforcement {
  const text = requireString(value, context);
  if (text === "active" || text === "disabled" || text === "evaluate") {
    return text;
  }
  throw new GitHubClientError("response_invalid", `${context}: unknown enforcement '${text}'`, 200);
}

function parseTarget(value: unknown, context: string): GitHubRulesetTarget {
  const text = requireString(value, context);
  if (text === "branch" || text === "tag") {
    return text;
  }
  throw new GitHubClientError("response_invalid", `${context}: unknown target '${text}'`, 200);
}

function parseRuleType(value: unknown, context: string): GitHubRuleType {
  const text = requireString(value, context);
  const known: readonly GitHubRuleType[] = [
    "pull_request",
    "required_signatures",
    "required_status_checks",
    "commit_message",
    "non_fast_forward",
    "creation",
    "update",
    "deletion",
  ];
  for (const candidate of known) {
    if (text === candidate) {
      return candidate;
    }
  }
  throw new GitHubClientError("response_invalid", `${context}: unknown rule type '${text}'`, 200);
}

function parseBypassActorType(value: unknown, context: string): GitHubBypassActorType {
  const text = requireString(value, context);
  const known: readonly GitHubBypassActorType[] = [
    "RepositoryRole",
    "Integration",
    "OrganizationAdmin",
    "Team",
    "User",
  ];
  for (const candidate of known) {
    if (text === candidate) {
      return candidate;
    }
  }
  throw new GitHubClientError(
    "response_invalid",
    `${context}: unknown bypass actor type '${text}'`,
    200,
  );
}

function parseBypassMode(value: unknown, context: string): GitHubBypassMode {
  const text = requireString(value, context);
  if (text === "always" || text === "pull_request") {
    return text;
  }
  throw new GitHubClientError("response_invalid", `${context}: unknown bypass mode '${text}'`, 200);
}

function parsePullRequestParameters(value: unknown, context: string): GitHubPullRequestParameters {
  const object = requireObject(value, context);
  return Object.freeze({
    requiredApprovingReviewCount: requireNumber(
      object["required_approving_review_count"],
      `${context}.required_approving_review_count`,
    ),
    dismissStaleReviewsOnPush: requireBoolean(
      object["dismiss_stale_reviews_on_push"],
      `${context}.dismiss_stale_reviews_on_push`,
    ),
    requireCodeOwnerReviews: requireBoolean(
      object["require_code_owner_reviews"],
      `${context}.require_code_owner_reviews`,
    ),
    requireLastPushApproval: requireBoolean(
      object["require_last_push_approval"],
      `${context}.require_last_push_approval`,
    ),
    requiredReviewThreadResolution: requireBoolean(
      object["required_review_thread_resolution"],
      `${context}.required_review_thread_resolution`,
    ),
  });
}

function indexPath(context: string, index: number): string {
  return `${context}[${String(index)}]`;
}

function parseRule(value: unknown, index: number, context: string): GitHubRule {
  const here = indexPath(context, index);
  const object = requireObject(value, here);
  const type = parseRuleType(object["type"], `${here}.type`);
  return Object.freeze({
    type,
    pullRequestParameters:
      type === "pull_request"
        ? parsePullRequestParameters(object["parameters"], `${here}.parameters`)
        : undefined,
    raw: object,
  });
}

function parseBypassActor(value: unknown, index: number, context: string): GitHubBypassActor {
  const here = indexPath(context, index);
  const object = requireObject(value, here);
  return Object.freeze({
    actorId: requireNumber(object["actor_id"], `${here}.actor_id`),
    actorType: parseBypassActorType(object["actor_type"], `${here}.actor_type`),
    bypassMode: parseBypassMode(object["bypass_mode"] ?? "always", `${here}.bypass_mode`),
  });
}

function parseRulesetSummary(value: unknown, index: number, context: string): GitHubRulesetSummary {
  const here = indexPath(context, index);
  const object = requireObject(value, here);
  return Object.freeze({
    id: requireNumber(object["id"], `${here}.id`),
    name: requireString(object["name"], `${here}.name`),
    target: parseTarget(object["target"], `${here}.target`),
    sourceType: requireString(object["source_type"], `${here}.source_type`),
    enforcement: parseEnforcement(object["enforcement"], `${here}.enforcement`),
  });
}

function parseRulesetSummaryArray(value: unknown): readonly GitHubRulesetSummary[] {
  const array = requireArray(value, "rulesets");
  return Object.freeze(array.map((entry, index) => parseRulesetSummary(entry, index, "rulesets")));
}

function parseRulesetDetail(value: unknown): GitHubRulesetDetail {
  const object = requireObject(value, "ruleset");
  const summary = parseRulesetSummary(value, 0, "ruleset");
  const rulesArray = requireArray(object["rules"], "ruleset.rules");
  const bypassArray = requireArray(object["bypass_actors"], "ruleset.bypass_actors");
  return Object.freeze({
    ...summary,
    rules: Object.freeze(
      rulesArray.map((entry, index) => parseRule(entry, index, "ruleset.rules")),
    ),
    bypassActors: Object.freeze(
      bypassArray.map((entry, index) => parseBypassActor(entry, index, "ruleset.bypass_actors")),
    ),
    createdAt: requireString(object["created_at"], "ruleset.created_at"),
    updatedAt: requireString(object["updated_at"], "ruleset.updated_at"),
    raw: object,
  });
}

function parseBranchProtection(value: unknown, branch: string): GitHubBranchProtection {
  const object = requireObject(value, "branch_protection");
  const reviewsValue = object["required_pull_request_reviews"];
  let reviews: GitHubBranchProtectionPullRequestReviews | undefined;
  if (reviewsValue !== undefined && reviewsValue !== null) {
    const reviewsObject = requireObject(
      reviewsValue,
      "branch_protection.required_pull_request_reviews",
    );
    reviews = Object.freeze({
      requiredApprovingReviewCount: requireNumber(
        reviewsObject["required_approving_review_count"],
        "branch_protection.required_pull_request_reviews.required_approving_review_count",
      ),
      dismissStaleReviews: requireBoolean(
        reviewsObject["dismiss_stale_reviews"],
        "branch_protection.required_pull_request_reviews.dismiss_stale_reviews",
      ),
      requireCodeOwnerReviews: requireBoolean(
        reviewsObject["require_code_owner_reviews"],
        "branch_protection.required_pull_request_reviews.require_code_owner_reviews",
      ),
    });
  }
  return Object.freeze({ branch, requiredPullRequestReviews: reviews });
}

function parseAppInfo(value: unknown): GitHubAppInfo {
  const object = requireObject(value, "app");
  return Object.freeze({
    id: requireNumber(object["id"], "app.id"),
    slug: requireString(object["slug"], "app.slug"),
    name: requireString(object["name"], "app.name"),
  });
}

function parseUserType(value: unknown, context: string): GitHubUserType {
  const text = requireString(value, context);
  if (text === "Bot" || text === "User" || text === "Organization") {
    return text;
  }
  throw new GitHubClientError("response_invalid", `${context}: unknown user type '${text}'`, 200);
}

function parseUser(value: unknown): GitHubUser {
  const object = requireObject(value, "user");
  return Object.freeze({
    id: requireNumber(object["id"], "user.id"),
    login: requireString(object["login"], "user.login"),
    type: parseUserType(object["type"], "user.type"),
  });
}

function parseInstallationRepositories(value: unknown): readonly GitHubInstallationRepository[] {
  const object = requireObject(value, "installation_repositories");
  const array = requireArray(object["repositories"], "installation_repositories.repositories");
  return Object.freeze(
    array.map((entry, index) => {
      const here = `installation_repositories.repositories[${String(index)}]`;
      const repo = requireObject(entry, here);
      return Object.freeze({
        id: requireNumber(repo["id"], `${here}.id`),
        fullName: requireString(repo["full_name"], `${here}.full_name`),
      });
    }),
  );
}

function parseRepositoryInstallation(value: unknown): GitHubRepositoryInstallation {
  const object = requireObject(value, "repository_installation");
  return Object.freeze({
    id: requireNumber(object["id"], "repository_installation.id"),
    appId: requireNumber(object["app_id"], "repository_installation.app_id"),
    appSlug: requireString(object["app_slug"], "repository_installation.app_slug"),
  });
}

function parseInstallationToken(value: unknown): GitHubInstallationToken {
  const object = requireObject(value, "installation_token");
  const permissionsRaw = requireObject(object["permissions"], "installation_token.permissions");
  const permissions: Record<string, string> = {};
  for (const [key, entry] of Object.entries(permissionsRaw)) {
    permissions[key] = requireString(entry, `installation_token.permissions.${key}`);
  }
  const repositoriesRaw = requireArray(object["repositories"], "installation_token.repositories");
  return Object.freeze({
    token: requireString(object["token"], "installation_token.token"),
    expiresAt: requireString(object["expires_at"], "installation_token.expires_at"),
    permissions: Object.freeze(permissions),
    repositories: Object.freeze(
      repositoriesRaw.map((entry, index) => {
        const here = `installation_token.repositories[${String(index)}]`;
        const repo = requireObject(entry, here);
        return Object.freeze({
          id: requireNumber(repo["id"], `${here}.id`),
          fullName: requireString(repo["full_name"], `${here}.full_name`),
        });
      }),
    ),
  });
}

// -------------------------------------------------------------------------------------------------
// Outbound serialization (typed -> wire).
// -------------------------------------------------------------------------------------------------

function serializeRulesetConfig(config: GitHubRulesetConfig): Readonly<Record<string, unknown>> {
  const rules = config.rules.map((rule) => {
    const entry: Record<string, unknown> = { type: rule.type };
    if (rule.pullRequestParameters !== undefined) {
      entry["parameters"] = {
        required_approving_review_count: rule.pullRequestParameters.requiredApprovingReviewCount,
        dismiss_stale_reviews_on_push: rule.pullRequestParameters.dismissStaleReviewsOnPush,
        require_code_owner_reviews: rule.pullRequestParameters.requireCodeOwnerReviews,
        require_last_push_approval: rule.pullRequestParameters.requireLastPushApproval,
        required_review_thread_resolution:
          rule.pullRequestParameters.requiredReviewThreadResolution,
      };
    }
    return entry;
  });
  return {
    name: config.name,
    target: config.target,
    enforcement: config.enforcement,
    conditions: {
      ref_name: {
        include: [...config.includeBranches],
        exclude: [...config.excludeBranches],
      },
    },
    rules,
    bypass_actors: config.bypassActors.map((actor) => ({
      actor_id: actor.actorId,
      actor_type: actor.actorType,
      bypass_mode: actor.bypassMode,
    })),
  };
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Format the App bot login (`{slug}[bot]`) GitHub uses for reviews posted by an App.
 * Exported so the ruleset classifier can compare review/bypass actor logins
 * consistently with the value GitHub itself emits.
 */
export function appBotLogin(appSlug: string): string {
  return `${appSlug}[bot]`;
}
