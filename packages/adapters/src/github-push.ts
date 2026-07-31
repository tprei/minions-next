/**
 * Push with leases (PR 32, deliverable 1) — expected-remote-head lease +
 * conflict-free guard via `jj git export`, idempotent re-push, typed errors.
 *
 * ## Lease model (GIT-04/GIT-08)
 * The caller passes `expectedRemoteHeadSha` — the commit it believes the remote
 * `refs/heads/<bookmark>` currently points at (or `undefined` when the branch
 * does not yet exist remotely). Before updating the ref the manager reads the
 * actual remote head and compares it against the expectation. A mismatch means
 * an ambiguous remote effect happened (another push, a force-update, a branch
 * deletion) and the caller MUST reconcile before retrying — surfaced as
 * `remote_drift`, never silently overwritten.
 *
 * ## Wire implementation of `git push +<sha>:refs/heads/<bookmark>`
 * The remote ref is updated through the GitHub git-refs REST API
 * (`PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` with `force: true`).
 * This is the wire-equivalent of a force-push with an explicit expected-head
 * check performed up front: functionally identical (advance the remote branch
 * ref to a specific SHA), but testable through the same mock-fetch seam as the
 * rest of the GitHub client and immune to the credential plumbing a real
 * `git push` shell-out would require. The local half — turning a jj change into
 * a conflict-free git commit — is delegated to the {@link PushWorkingCopy} port.
 *
 * ## Idempotence
 * Re-pushing the same commit to the same bookmark is a no-op: when the remote
 * head already equals the exported commit SHA, the manager returns a receipt
 * with `action: "noop"` without touching the ref.
 *
 * ## Credentials (SEC-10)
 * The manager never sees a token; it acquires an installation-scoped client
 * through {@link GitHubAppAuth.clientFor}. No credential enters a sandbox.
 */
import { contentHash, gitSha, type ContentHash, type GitSha } from "@minions/core";

import { GitHubClientError, type GitHubClient } from "./github-client.js";
import { GitHubAppAuthError, type GitHubAppAuth } from "./github-app-auth.js";

export type PushErrorCode =
  | "conflict_unresolved"
  | "remote_drift"
  | "push_failed"
  | "lease_expired"
  | "refspec_invalid"
  | "auth_failed";

export class PushError extends Error {
  readonly code: PushErrorCode;
  override readonly cause: unknown;

  constructor(code: PushErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PushError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Local jj working-copy export — the `jj git export` half of the push. The real
 * implementation (wired from {@link createJjWorkingCopyManager}) aborts with a
 * `PushError("conflict_unresolved", …)` when the change has unresolved
 * conflicts, so the manager never pushes broken state. It is the only seam
 * between this module and jj/git; the remote half goes through the GitHub API.
 */
export interface PushWorkingCopy {
  /** Export the jj change to a conflict-free git commit, returning its SHA. */
  exportCommit(jjChangeId: ContentHash): Promise<{ readonly commitSha: GitSha }>;
}

export interface PushInput {
  /** Repository the bookmark lives on, `owner/name`. */
  readonly repositoryFullName: string;
  /** Remote branch name (without the `refs/heads/` prefix). */
  readonly bookmark: string;
  /** jj change id to export and push. */
  readonly jjChangeId: ContentHash;
  /**
   * Expected remote head SHA — the lease. `undefined` asserts the branch does
   * not yet exist remotely. Any divergence from the actual remote head is a
   * `remote_drift` failure the caller reconciles before retrying.
   */
  readonly expectedRemoteHeadSha: GitSha | undefined;
}

export type PushAction = "pushed" | "noop";

export interface PushReceipt {
  readonly repositoryFullName: string;
  readonly bookmark: string;
  /** The exported commit that was pushed (or already present, for a no-op). */
  readonly commitSha: GitSha;
  /** Remote head after the push — equals `commitSha` on success. */
  readonly remoteHeadSha: GitSha;
  /** The lease that was checked, unchanged from the input. */
  readonly expectedRemoteHeadSha: GitSha | undefined;
  /** ISO-8601 timestamp of the push (or no-op observation). */
  readonly pushedAt: string;
  readonly action: PushAction;
}

export interface PushManagerOptions {
  readonly auth: GitHubAppAuth;
  readonly workingCopy: PushWorkingCopy;
  /** Injectable clock returning epoch milliseconds (testing). */
  readonly now?: () => number;
}

export interface PushManager {
  push(input: PushInput): Promise<PushReceipt>;
}

export function createPushManager(options: PushManagerOptions): PushManager {
  const now = options.now ?? Date.now;
  return new PushManagerImpl(options.auth, options.workingCopy, now);
}

const repositoryFullNamePattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
// Conservative git branch-name shape: no spaces, no `..`, no leading dot/dash,
// no `.lock` suffix, no ref-components. Engine bookmarks look like
// `minions/node-<id>`; this admits them while rejecting path-confused input.
const bookmarkPattern =
  /^(?!.*\.\.)(?!.*\.$)(?!.*\.lock$)(?!.*[/\\]$)[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

class PushManagerImpl implements PushManager {
  constructor(
    private readonly auth: GitHubAppAuth,
    private readonly workingCopy: PushWorkingCopy,
    private readonly now: () => number,
  ) {}

  async push(input: PushInput): Promise<PushReceipt> {
    validatePushInput(input);
    const commitSha = await this.exportConflictFreeCommit(input.jjChangeId);
    const client = await this.acquireClient(input.repositoryFullName);
    const actualRemoteHead = await this.readRemoteHead(client, input);

    assertLeaseSatisfied(input, actualRemoteHead);

    if (actualRemoteHead !== undefined && actualRemoteHead === commitSha) {
      return makeReceipt(input, commitSha, commitSha, "noop", this.now());
    }

    await this.updateRemoteHead(client, input, commitSha);
    return makeReceipt(input, commitSha, commitSha, "pushed", this.now());
  }

  private async exportConflictFreeCommit(jjChangeId: ContentHash): Promise<GitSha> {
    try {
      const result = await this.workingCopy.exportCommit(jjChangeId);
      return result.commitSha;
    } catch (error: unknown) {
      // The working copy signals an unresolved conflict with a typed PushError;
      // pass it through unchanged so the caller can distinguish it from a
      // transport failure.
      if (error instanceof PushError) {
        throw error;
      }
      throw new PushError(
        "push_failed",
        `jj git export failed for change ${jjChangeId}: ${errorToString(error)}`,
        error,
      );
    }
  }

  private async acquireClient(repositoryFullName: string): Promise<GitHubClient> {
    try {
      return await this.auth.clientFor(repositoryFullName);
    } catch (error: unknown) {
      throw wrapAuth(error, `authenticate for push to '${repositoryFullName}'`);
    }
  }

  private async readRemoteHead(
    client: GitHubClient,
    input: PushInput,
  ): Promise<GitSha | undefined> {
    try {
      const ref = await client.getRef(input.repositoryFullName, input.bookmark);
      return ref === undefined ? undefined : gitSha(ref.sha);
    } catch (error: unknown) {
      throw wrapClient(error, "push_failed", `read remote head for '${input.bookmark}'`);
    }
  }

  private async updateRemoteHead(
    client: GitHubClient,
    input: PushInput,
    commitSha: GitSha,
  ): Promise<void> {
    try {
      await client.updateRef(input.repositoryFullName, input.bookmark, commitSha, true);
    } catch (error: unknown) {
      // A 422 from the git-refs API means the server refused the update — a
      // protected-branch lease or a concurrent non-fast-forward. That is a
      // lease expiry, distinct from a generic transport failure.
      const code: PushErrorCode = isLeaseRejection(error) ? "lease_expired" : "push_failed";
      throw wrapClient(error, code, `update remote head for '${input.bookmark}'`);
    }
  }
}

function validatePushInput(input: PushInput): void {
  if (!repositoryFullNamePattern.test(input.repositoryFullName)) {
    throw new PushError(
      "refspec_invalid",
      `invalid repository full name '${input.repositoryFullName}' (expected 'owner/name')`,
    );
  }
  if (!bookmarkPattern.test(input.bookmark)) {
    throw new PushError(
      "refspec_invalid",
      `invalid bookmark '${input.bookmark}' (not a valid git branch name)`,
    );
  }
  // Re-validate the branded ids so a malformed value fails closed here rather
  // than mid-flight against the API.
  contentHash(input.jjChangeId);
  if (input.expectedRemoteHeadSha !== undefined) {
    gitSha(input.expectedRemoteHeadSha);
  }
}

function assertLeaseSatisfied(input: PushInput, actualRemoteHead: GitSha | undefined): void {
  const expected = input.expectedRemoteHeadSha;
  const leaseMatches =
    expected === undefined ? actualRemoteHead === undefined : actualRemoteHead === expected;
  if (leaseMatches) {
    return;
  }
  const expectedText = expected ?? "<no branch>";
  const actualText = actualRemoteHead ?? "<no branch>";
  throw new PushError(
    "remote_drift",
    `expected remote head for '${input.bookmark}' was ${expectedText} but the actual ` +
      `remote head is ${actualText}; reconcile the ambiguous remote effect before retrying`,
  );
}

function isLeaseRejection(error: unknown): boolean {
  return error instanceof GitHubClientError && error.status === 422;
}

function makeReceipt(
  input: PushInput,
  commitSha: GitSha,
  remoteHeadSha: GitSha,
  action: PushAction,
  now: number,
): PushReceipt {
  return Object.freeze({
    repositoryFullName: input.repositoryFullName,
    bookmark: input.bookmark,
    commitSha,
    remoteHeadSha,
    expectedRemoteHeadSha: input.expectedRemoteHeadSha,
    pushedAt: new Date(now).toISOString(),
    action,
  });
}

function wrapAuth(error: unknown, context: string): PushError {
  if (error instanceof PushError) {
    return error;
  }
  if (error instanceof GitHubAppAuthError) {
    return new PushError("auth_failed", `${context}: ${error.message}`, error);
  }
  if (error instanceof GitHubClientError && error.code === "auth_failed") {
    return new PushError("auth_failed", `${context}: ${error.message}`, error);
  }
  return new PushError("auth_failed", `${context}: ${errorToString(error)}`, error);
}

function wrapClient(error: unknown, code: PushErrorCode, context: string): PushError {
  if (error instanceof PushError) {
    return error;
  }
  if (error instanceof GitHubClientError) {
    if (code !== "auth_failed" && error.code === "auth_failed") {
      return new PushError("auth_failed", `${context}: ${error.message}`, error);
    }
    return new PushError(
      code,
      `${context}: ${error.code} (${String(error.status)}) ${error.message}`,
      error,
    );
  }
  return new PushError(code, `${context}: ${errorToString(error)}`, error);
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
