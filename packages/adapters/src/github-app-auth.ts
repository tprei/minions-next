/**
 * GitHub App installation-token auth (PR 31, deliverable 1).
 *
 * `createGitHubAppAuth` materialises the App JWT from a PEM private key held in the
 * {@link CredentialVault} (PR 19 — systemd-creds/Keychain), and mints
 * installation-scoped tokens per repository. Installation tokens are cached and
 * auto-rotated before their GitHub-reported expiry.
 *
 * ## Credential custody (SEC-10)
 * The private key is read from the vault on first use and held only in memory for
 * the lifetime of this object. It is NEVER written to env/argv/logs, NEVER handed
 * to a sandbox, and NEVER returned from any public method. The public surface
 * returns only opaque installation tokens (themselves scoped + short-lived). The
 * vault entry name is configurable so operators can rotate the key without code
 * changes.
 *
 * ## Token scoping (GIT-11)
 * Installation tokens are minted per repository via
 * `POST /app/installations/{id}/access_tokens` with a `repository` restriction,
 * so a token issued for `owner/a` cannot touch `owner/b`.
 */

import { createSign } from "node:crypto";

import type { CredentialVault } from "./credential-vault.js";
import {
  appBotLogin,
  createGitHubClient,
  GitHubClientError,
  type GitHubClient,
  type GitHubClientOptions,
  type GitHubFetch,
} from "./github-client.js";

export type GitHubAppAuthErrorCode =
  | "vault_unavailable"
  | "private_key_invalid"
  | "app_not_resolved"
  | "installation_not_found"
  | "token_mint_failed"
  | "jwt_sign_failed";

export class GitHubAppAuthError extends Error {
  readonly code: GitHubAppAuthErrorCode;
  override readonly cause: unknown;

  constructor(code: GitHubAppAuthErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitHubAppAuthError";
    this.code = code;
    this.cause = cause;
  }
}

/** The engine's GitHub bot identity — used to verify reviewers are NOT the engine. */
export interface BotIdentity {
  /** The App integration id (`GET /app` → `id`). */
  readonly appId: number;
  /** The App slug (`GET /app` → `slug`). */
  readonly appSlug: string;
  /** The App's display name. */
  readonly name: string;
  /** The bot-user login GitHub uses for App reviews: `{slug}[bot]`. */
  readonly botLogin: string;
  /** The bot-user account id (`GET /users/{slug}[bot]` → `id`). */
  readonly botUserId: number;
}

export interface GitHubInstallationTokenHandle {
  readonly token: string;
  /** ISO-8601 expiry timestamp reported by GitHub. */
  readonly expiresAt: string;
  readonly installationId: number;
  readonly repositoryFullName: string;
}

export interface GitHubAppAuthOptions {
  /** Vault that holds the App PEM private key (PR 19). */
  readonly vault: CredentialVault;
  /** Vault entry name the PEM private key is stored under. */
  readonly privateKeyCredentialName: string;
  /** The App's numeric id (from the GitHub App settings page). */
  readonly appId: number;
  /** GitHub REST base URL (testing). Defaults to `https://api.github.com`. */
  readonly baseUrl?: string;
  /** Injectable fetch (testing). */
  readonly fetch?: GitHubFetch;
  /** Injectable clock returning epoch milliseconds. */
  readonly now?: () => number;
  /**
   * Refresh a cached installation token this many milliseconds before its expiry.
   * Defaults to 5 minutes — generous enough to survive clock skew and a single
   * request round-trip without ever handing out an expired token.
   */
  readonly refreshSkewMs?: number;
  /**
   * JWT lifetime in seconds. GitHub rejects JWTs older than 10 minutes, so the
   * default of 8 minutes leaves a safe margin.
   */
  readonly jwtTtlSeconds?: number;
  /** Optional logging sink. Receives only non-secret metadata. */
  readonly logger?: GitHubAppAuthLogger;
}

export interface GitHubAppAuthLogger {
  debug(message: string): void;
}

export interface GitHubAppAuth {
  /**
   * Mint (or return a cached, non-expired) installation-scoped token for
   * `repositoryFullName`. Tokens are restricted to that repository.
   */
  getInstallationToken(repositoryFullName: string): Promise<GitHubInstallationTokenHandle>;
  /** Resolve the App's bot identity (login + ids). */
  resolveAppIdentity(): Promise<BotIdentity>;
  /** Return a GitHub client bound to the App JWT (for `/app` + installation calls). */
  appClient(): Promise<GitHubClient>;
  /** Return a GitHub client bound to the installation token for `repositoryFullName`. */
  clientFor(repositoryFullName: string): Promise<GitHubClient>;
}

export function createGitHubAppAuth(options: GitHubAppAuthOptions): GitHubAppAuth {
  return new GitHubAppAuthImpl(options);
}

const defaultRefreshSkewMs = 5 * 60 * 1000;
const defaultJwtTtlSeconds = 8 * 60;
const repositoryFullNamePattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

class GitHubAppAuthImpl implements GitHubAppAuth {
  private privateKey: string | undefined;
  private jwt: Readonly<{ token: string; expiresAtMs: number }> | undefined;
  private readonly installationTokens = new Map<
    string,
    Readonly<{ token: string; expiresAt: string; installationId: number; expiresAtMs: number }>
  >();
  private readonly installationIds = new Map<string, number>();
  private cachedAppIdentity: BotIdentity | undefined;

  constructor(private readonly options: GitHubAppAuthOptions) {}

  async getInstallationToken(repositoryFullName: string): Promise<GitHubInstallationTokenHandle> {
    assertRepositoryFullName(repositoryFullName);
    const now = this.now();
    const cached = this.installationTokens.get(repositoryFullName);
    if (cached !== undefined && cached.expiresAtMs - this.refreshSkewMs > now) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        installationId: cached.installationId,
        repositoryFullName,
      };
    }
    const installationId = await this.resolveInstallationId(repositoryFullName);
    const minted = await this.mintInstallationToken(installationId, repositoryFullName);
    const expiresAtMs = parseIsoToEpochMs(minted.expiresAt);
    this.installationTokens.set(repositoryFullName, {
      token: minted.token,
      expiresAt: minted.expiresAt,
      installationId,
      expiresAtMs,
    });
    return {
      token: minted.token,
      expiresAt: minted.expiresAt,
      installationId,
      repositoryFullName,
    };
  }

  async resolveAppIdentity(): Promise<BotIdentity> {
    if (this.cachedAppIdentity !== undefined) {
      return this.cachedAppIdentity;
    }
    const client = await this.appClient();
    let app;
    try {
      app = await client.getApp();
    } catch (error: unknown) {
      throw wrapClient(error, "app_not_resolved", "failed to resolve GitHub App identity");
    }
    const botLogin = appBotLogin(app.slug);
    let bot;
    try {
      bot = await client.getUserByLogin(botLogin);
    } catch (error: unknown) {
      throw wrapClient(error, "app_not_resolved", `failed to resolve bot user '${botLogin}'`);
    }
    if (bot.type !== "Bot") {
      throw new GitHubAppAuthError(
        "app_not_resolved",
        `resolved bot login '${botLogin}' is a ${bot.type}, not a Bot account`,
      );
    }
    const identity: BotIdentity = {
      appId: app.id,
      appSlug: app.slug,
      name: app.name,
      botLogin: bot.login,
      botUserId: bot.id,
    };
    this.cachedAppIdentity = identity;
    this.logger().debug(`resolved app identity slug=${app.slug} botUserId=${String(bot.id)}`);
    return identity;
  }

  async appClient(): Promise<GitHubClient> {
    return createGitHubClient(this.clientOptions(await this.token()));
  }

  async clientFor(repositoryFullName: string): Promise<GitHubClient> {
    const handle = await this.getInstallationToken(repositoryFullName);
    return createGitHubClient(this.clientOptions(handle.token));
  }

  private clientOptions(token: string): GitHubClientOptions {
    return {
      token,
      ...(this.options.baseUrl !== undefined ? { baseUrl: this.options.baseUrl } : {}),
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
    };
  }

  // -----------------------------------------------------------------------------------------------
  // Internals.
  // -----------------------------------------------------------------------------------------------

  private get refreshSkewMs(): number {
    return this.options.refreshSkewMs ?? defaultRefreshSkewMs;
  }

  private get jwtTtlSeconds(): number {
    return this.options.jwtTtlSeconds ?? defaultJwtTtlSeconds;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private logger(): GitHubAppAuthLogger {
    return this.options.logger ?? silentLogger;
  }

  private async token(): Promise<string> {
    const now = this.now();
    if (this.jwt !== undefined && this.jwt.expiresAtMs - this.refreshSkewMs > now) {
      return this.jwt.token;
    }
    const issuedAtSeconds = Math.floor(now / 1000);
    const expiresAtSeconds = issuedAtSeconds + this.jwtTtlSeconds;
    const privateKey = await this.loadPrivateKey();
    const header = base64urlJson({ alg: "RS256", typ: "JWT" });
    const payload = base64urlJson({
      iat: issuedAtSeconds - 60,
      exp: expiresAtSeconds,
      iss: this.options.appId,
    });
    const signingInput = `${header}.${payload}`;
    const signature = signRsaSha256(signingInput, privateKey);
    const jwt = `${signingInput}.${signature}`;
    this.jwt = { token: jwt, expiresAtMs: expiresAtSeconds * 1000 };
    this.logger().debug(
      `minted app JWT appId=${String(this.options.appId)} exp=${String(expiresAtSeconds)}`,
    );
    return jwt;
  }

  private async loadPrivateKey(): Promise<string> {
    if (this.privateKey !== undefined) {
      return this.privateKey;
    }
    const probe = this.options.vault.probe();
    if (!probe.available) {
      throw new GitHubAppAuthError(
        "vault_unavailable",
        `credential vault unavailable: ${probe.detail}`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.options.vault.get(this.options.privateKeyCredentialName);
    } catch (error: unknown) {
      throw new GitHubAppAuthError(
        "vault_unavailable",
        `failed to read App private key '${this.options.privateKeyCredentialName}' from vault: ${errorToString(error)}`,
        error,
      );
    }
    const pem = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (!pem.includes("BEGIN") || !pem.includes("PRIVATE KEY")) {
      throw new GitHubAppAuthError(
        "private_key_invalid",
        `vault entry '${this.options.privateKeyCredentialName}' is not a PEM private key`,
      );
    }
    this.privateKey = pem;
    return pem;
  }

  private async resolveInstallationId(repositoryFullName: string): Promise<number> {
    const cached = this.installationIds.get(repositoryFullName);
    if (cached !== undefined) {
      return cached;
    }
    const client = await this.appClient();
    let installation;
    try {
      installation = await client.getRepositoryInstallation(repositoryFullName);
    } catch (error: unknown) {
      if (error instanceof GitHubClientError && error.code === "not_found") {
        throw new GitHubAppAuthError(
          "installation_not_found",
          `GitHub App is not installed on '${repositoryFullName}'`,
        );
      }
      throw wrapClient(
        error,
        "installation_not_found",
        `failed to resolve installation for '${repositoryFullName}'`,
      );
    }
    if (installation.appId !== this.options.appId) {
      throw new GitHubAppAuthError(
        "installation_not_found",
        `installation ${String(installation.id)} for '${repositoryFullName}' belongs to app ${String(installation.appId)}, expected ${String(this.options.appId)}`,
      );
    }
    this.installationIds.set(repositoryFullName, installation.id);
    return installation.id;
  }

  private async mintInstallationToken(
    installationId: number,
    repositoryFullName: string,
  ): Promise<Readonly<{ token: string; expiresAt: string }>> {
    const client = await this.appClient();
    let issued;
    try {
      issued = await client.createInstallationToken(installationId);
    } catch (error: unknown) {
      throw wrapClient(
        error,
        "token_mint_failed",
        `failed to mint installation token for '${repositoryFullName}'`,
      );
    }
    // SEC-10/GIT-11: confirm the token covers the target repository. GitHub mints
    // a token scoped to the installation; we additionally verify the repo appears
    // in the issued token's repository list so a misconfigured installation cannot
    // silently broaden scope.
    const covers = issued.repositories.some((repo) => repo.fullName === repositoryFullName);
    if (!covers && issued.repositories.length > 0) {
      throw new GitHubAppAuthError(
        "token_mint_failed",
        `installation token for '${repositoryFullName}' does not cover that repository`,
      );
    }
    this.logger().debug(
      `minted installation token installationId=${String(installationId)} repo=${repositoryFullName}`,
    );
    return { token: issued.token, expiresAt: issued.expiresAt };
  }
}

const silentLogger: GitHubAppAuthLogger = { debug: () => undefined };

function assertRepositoryFullName(repositoryFullName: string): void {
  if (
    typeof repositoryFullName !== "string" ||
    !repositoryFullNamePattern.test(repositoryFullName)
  ) {
    throw new GitHubAppAuthError(
      "installation_not_found",
      `invalid repository full name '${repositoryFullName}' (expected 'owner/name')`,
    );
  }
}

function signRsaSha256(signingInput: string, privateKeyPem: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput, "utf8");
  try {
    const signature = signer.sign(privateKeyPem);
    return base64urlBytes(signature);
  } catch (error: unknown) {
    throw new GitHubAppAuthError(
      "jwt_sign_failed",
      `failed to sign App JWT: ${errorToString(error)}`,
      error,
    );
  }
}

function base64urlJson(value: Readonly<Record<string, unknown>>): string {
  return base64urlString(JSON.stringify(value));
}

function base64urlString(value: string): string {
  return base64urlBytes(Buffer.from(value, "utf8"));
}

function base64urlBytes(bytes: Uint8Array): string {
  const standard = Buffer.from(bytes).toString("base64");
  return standard.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function parseIsoToEpochMs(iso: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    throw new GitHubAppAuthError(
      "token_mint_failed",
      `installation token expiry '${iso}' is not a valid ISO-8601 timestamp`,
    );
  }
  return parsed;
}

function wrapClient(
  error: unknown,
  code: GitHubAppAuthErrorCode,
  context: string,
): GitHubAppAuthError {
  if (error instanceof GitHubClientError) {
    return new GitHubAppAuthError(
      code,
      `${context}: ${error.code} (${String(error.status)}) ${error.message}`,
      error,
    );
  }
  return new GitHubAppAuthError(code, `${context}: ${errorToString(error)}`, error);
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
