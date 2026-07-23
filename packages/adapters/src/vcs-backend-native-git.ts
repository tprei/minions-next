import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import {
  contentHash,
  gitSha,
  nonEmptyText,
  timestampFromEpochMilliseconds,
  GitProcessError,
  VcsBackendError,
  type AttemptId,
  type Clock,
  type CreateWorkingCopyAtCommitInput,
  type GitProcess,
  type GitSha,
  type NonEmptyText,
  type Timestamp,
  type VcsBackend,
  type VcsCommitInput,
  type VcsCommitReceipt,
  type VcsConflictState,
  type VcsDescendants,
  type VcsDescendantsInput,
  type VcsDiff,
  type VcsOperationKind,
  type VcsOperationReceipt,
  type VcsPushBookmarkInput,
  type VcsPushReceipt,
  type VcsRestackInput,
  type VcsRestackReceipt,
  type VcsWorkingCopyRef,
  type WorkspaceReceipt,
  type WorkspaceStatus,
} from "@minions/core";
import type { WorkspaceRegistry } from "./sqlite/workspace-registry.js";
import {
  createWorkspaceManager,
  type WorkspaceManager,
  type WorkspaceManagerOptions,
} from "./workspace-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DEFAULT_REMOTE = "origin";
const DEFAULT_IDENTITY_NAME = nonEmptyText("Minions Vcs", "default commit author name");
const DEFAULT_IDENTITY_EMAIL = nonEmptyText("vcs@minions.local", "default commit author email");

/**
 * Inline `-c user.name` / `-c user.email` flags. Git operations that create
 * commits (commit, rebase) need a committer identity; the GitProcess runs with
 * no global config, so the identity must be supplied per invocation.
 */
function identityConfig(name: NonEmptyText, email: NonEmptyText): readonly string[] {
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

/**
 * Build the sole {@link VcsBackend} implementation, backed by native Git.
 *
 * Lifecycle operations ({@link VcsBackend.createWorkingCopyAtCommit},
 * {@link VcsBackend.captureStatus}, {@link VcsBackend.cleanup},
 * {@link VcsBackend.recover}) delegate verbatim to the existing
 * {@link WorkspaceManager}; {@link VcsBackend.captureDiff} delegates to
 * {@link WorkspaceManager.captureStatus}. No WorkspaceManager logic is
 * reimplemented, so existing behavior is provably unchanged.
 *
 * The additive operations ({@link VcsBackend.commit},
 * {@link VcsBackend.resolveHead}, {@link VcsBackend.enumerateDescendants},
 * {@link VcsBackend.restack}, {@link VcsBackend.conflictState},
 * {@link VcsBackend.pushBookmark}) are implemented through the existing
 * {@link GitProcess.run} seam with the equivalent native-Git commands
 * (commit / rev-parse / rev-list / rebase / ls-files / push). They carry no
 * prior behavior to preserve.
 */
export function createNativeGitVcsBackend(options: WorkspaceManagerOptions): VcsBackend {
  return new NativeGitVcsBackend(options);
}

class NativeGitVcsBackend implements VcsBackend {
  readonly #manager: WorkspaceManager;
  readonly #git: GitProcess;
  readonly #workspaceRegistry: WorkspaceRegistry;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: WorkspaceManagerOptions) {
    this.#manager = createWorkspaceManager(options);
    this.#git = options.git;
    this.#workspaceRegistry = options.workspaceRegistry;
    this.#clock = options.clock;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async createWorkingCopyAtCommit(
    input: CreateWorkingCopyAtCommitInput,
  ): Promise<WorkspaceReceipt> {
    return this.#manager.create(input);
  }

  async captureStatus(input: VcsWorkingCopyRef): Promise<WorkspaceStatus> {
    return this.#manager.captureStatus(input);
  }

  async captureDiff(input: VcsWorkingCopyRef): Promise<VcsDiff> {
    const status = await this.#manager.captureStatus(input);
    return Object.freeze({
      attemptId: status.attemptId,
      headCommit: status.headCommit,
      diff: new Uint8Array(status.diff),
      capturedAt: status.capturedAt,
    });
  }

  async commit(input: VcsCommitInput): Promise<VcsCommitReceipt> {
    const workspace = this.#workspaceOf(input.attemptId).workspacePath;
    const parentCommit = await this.#headOf(workspace);
    const authorName = input.authorName ?? DEFAULT_IDENTITY_NAME;
    const authorEmail = input.authorEmail ?? DEFAULT_IDENTITY_EMAIL;
    await this.#runGit(workspace, ["add", "-A", "--"]);
    await this.#runGit(workspace, [
      ...identityConfig(authorName, authorEmail),
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      input.message,
    ]);
    const headCommit = await this.#headOf(workspace);
    if (headCommit === parentCommit) {
      throw new VcsBackendError("git_failed", "commit produced no new head");
    }
    return Object.freeze({
      receipt: this.#receipt(
        "commit",
        input.attemptId,
        `${parentCommit}\n${headCommit}\n${input.message}`,
      ),
      parentCommit,
      headCommit,
    });
  }

  async resolveHead(input: VcsWorkingCopyRef): Promise<GitSha> {
    return this.#headOf(this.#workspaceOf(input.attemptId).workspacePath);
  }

  async enumerateDescendants(input: VcsDescendantsInput): Promise<VcsDescendants> {
    const workspace = this.#workspaceOf(input.attemptId).workspacePath;
    const arguments_: string[] = ["rev-list", `${input.change}..HEAD`];
    if (input.limit !== undefined) {
      arguments_.push(`--max-count=${String(input.limit)}`);
    }
    const descendants = (await this.#gitText(workspace, arguments_))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => parseGitSha(line, "descendant"));
    return Object.freeze({ attemptId: input.attemptId, change: input.change, descendants });
  }

  async restack(input: VcsRestackInput): Promise<VcsRestackReceipt> {
    const workspace = this.#workspaceOf(input.attemptId).workspacePath;
    let conflicts = false;
    let rebasedHead: GitSha;
    try {
      await this.#runGit(workspace, [
        ...identityConfig(DEFAULT_IDENTITY_NAME, DEFAULT_IDENTITY_EMAIL),
        "rebase",
        "--onto",
        input.ontoParent,
        input.change,
      ]);
      rebasedHead = await this.#headOf(workspace);
    } catch (error: unknown) {
      const unmerged = await this.#unmergedPaths(workspace);
      if (unmerged.length === 0) throw error;
      conflicts = true;
      await this.#abortRebase(workspace);
      rebasedHead = await this.#headOf(workspace);
    }
    return Object.freeze({
      receipt: this.#receipt(
        "restack",
        input.attemptId,
        `${input.change}\n${input.ontoParent}\n${rebasedHead}\n${String(conflicts)}`,
      ),
      rebasedHead,
      conflicts,
    });
  }

  async conflictState(input: VcsWorkingCopyRef): Promise<VcsConflictState> {
    const workspace = this.#workspaceOf(input.attemptId).workspacePath;
    const unmergedPaths = await this.#unmergedPaths(workspace);
    return Object.freeze({
      attemptId: input.attemptId,
      inConflict: unmergedPaths.length > 0,
      unmergedPaths,
    });
  }

  async pushBookmark(input: VcsPushBookmarkInput): Promise<VcsPushReceipt> {
    const workspace = this.#workspaceOf(input.attemptId).workspacePath;
    const remote = input.remote ?? DEFAULT_REMOTE;
    const pushedCommit = await this.#headOf(workspace);
    const arguments_: string[] = ["push", remote, input.bookmark];
    if (input.force) arguments_.push("--force");
    await this.#runGit(workspace, arguments_);
    return Object.freeze({
      receipt: this.#receipt(
        "push_bookmark",
        input.attemptId,
        `${remote}\n${input.bookmark}\n${pushedCommit}`,
      ),
      bookmark: input.bookmark,
      remote,
      pushedCommit,
    });
  }

  async cleanup(input: VcsWorkingCopyRef): Promise<WorkspaceReceipt> {
    return this.#manager.cleanup(input);
  }

  async recover(): Promise<readonly WorkspaceReceipt[]> {
    return this.#manager.recover();
  }

  #workspaceOf(attemptId: AttemptId): WorkspaceReceipt {
    try {
      return this.#workspaceRegistry.get(attemptId);
    } catch (error: unknown) {
      throw new VcsBackendError("not_found", "working copy is not registered", { cause: error });
    }
  }

  async #headOf(workspace: string): Promise<GitSha> {
    return parseGitSha(await this.#gitText(workspace, ["rev-parse", "HEAD"]), "working copy HEAD");
  }

  async #unmergedPaths(workspace: string): Promise<readonly string[]> {
    const text = await this.#gitText(workspace, ["ls-files", "--unmerged", "-z"]);
    const paths = new Set<string>();
    for (const record of text.split("\0")) {
      if (record === "") continue;
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      paths.add(record.slice(tab + 1));
    }
    return [...paths].sort();
  }

  async #abortRebase(workspace: string): Promise<void> {
    try {
      await this.#runGit(workspace, ["rebase", "--abort"]);
    } catch {
      // Best-effort: a failed abort leaves the working copy as-is.
    }
  }

  async #gitText(workspace: string, arguments_: readonly string[]): Promise<string> {
    const result = await this.#runGit(workspace, arguments_);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
    } catch (error: unknown) {
      throw new VcsBackendError("git_failed", "Git output is not valid UTF-8", { cause: error });
    }
  }

  async #runGit(
    workspace: string,
    arguments_: readonly string[],
  ): Promise<{ readonly stdout: Uint8Array; readonly stderr: Uint8Array }> {
    let metadata: BigIntStats;
    try {
      metadata = await lstat(workspace, { bigint: true });
    } catch (error: unknown) {
      throw new VcsBackendError("git_failed", "Git working directory is unavailable", {
        cause: error,
      });
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new VcsBackendError("git_failed", "Git working directory is not a directory");
    }
    const commandArguments = [
      "-c",
      `core.worktree=${workspace}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      ...arguments_,
    ];
    try {
      const result = await this.#git.run({
        workingDirectory: workspace,
        workingDirectoryDevice: metadata.dev,
        workingDirectoryInode: metadata.ino,
        arguments: commandArguments,
        timeoutMs: this.#timeoutMs,
        maxOutputBytes: this.#maxOutputBytes,
      });
      if (
        result.stdout.byteLength > this.#maxOutputBytes ||
        result.stderr.byteLength > this.#maxOutputBytes
      ) {
        throw new VcsBackendError("output_limit", "Git output exceeds the configured limit");
      }
      return Object.freeze({
        stdout: new Uint8Array(result.stdout),
        stderr: new Uint8Array(result.stderr),
      });
    } catch (error: unknown) {
      if (error instanceof VcsBackendError) throw error;
      if (error instanceof GitProcessError && error.kind === "output_limit") {
        throw new VcsBackendError("output_limit", "Git output exceeds the configured limit", {
          cause: error,
        });
      }
      throw new VcsBackendError("git_failed", `Git command failed: git ${arguments_.join(" ")}`, {
        cause: error,
      });
    }
  }

  #receipt(
    operation: VcsOperationKind,
    attemptId: AttemptId,
    payload: string,
  ): VcsOperationReceipt {
    let recordedAt: Timestamp;
    try {
      recordedAt = timestampFromEpochMilliseconds(this.#clock.now());
    } catch (error: unknown) {
      throw new VcsBackendError("invalid_input", "clock returned an invalid timestamp", {
        cause: error,
      });
    }
    const digest = createHash("sha256");
    digest.update(operation);
    digest.update("\n");
    digest.update(attemptId);
    digest.update("\n");
    digest.update(payload);
    return Object.freeze({
      operation,
      contentHash: contentHash(digest.digest("hex")),
      attemptId,
      recordedAt,
    });
  }
}

function parseGitSha(value: string, field: string): GitSha {
  if (!SHA_PATTERN.test(value)) {
    throw new VcsBackendError("git_failed", `${field} is not a valid Git SHA`);
  }
  return gitSha(value);
}
