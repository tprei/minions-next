/**
 * Masked jj working copy manager (PR 28 / GIT-15, SEC-02/03/05).
 *
 * Each task node receives a jj working copy whose file tree IS its workspace.
 * The working copy is created by `jj git clone` of the host-owned central jj
 * repo (PR 27) followed by `jj new <baseCommit>` to pin the working copy to the
 * requested base. The `.jj` metadata directory is present in the working copy on
 * the host BUT is never mounted into any sandbox: the shared sandbox policy
 * validators reject every mount whose source or target path contains a `.jj`
 * segment (see {@link ./sandbox-policy.ts} and {@link ../../testkit/src/sandbox.ts}),
 * so `.jj` is unreachable from inside any sandbox (GIT-15).
 *
 * Every jj mutation (clone, checkout, diff, status, commit, destroy) flows
 * through this manager — the serialized host broker. The harness and node never
 * invoke `jj` directly; they call the broker. The pinned, digest-verified `jj`
 * binary from PR 21's {@link ensureJjCapability} is the ONLY binary this manager
 * runs. A bounded subprocess runner (mirrors the PR-21 / PR-27 runners) enforces
 * a timeout, an output ceiling, and AbortSignal propagation, and resolves with
 * `exitCode null` only when the binary could not be spawned.
 *
 * The workspace receipt carries the working-copy change id, the parent (base)
 * change id, and the base git commit SHA. Binding a working-copy id to an attempt
 * id is PR 29 (the change-id binding table); this broker operates purely on
 * working-copy ids, so it defines dedicated {@link JjWorkingCopyDiff},
 * {@link JjWorkingCopyStatus}, and {@link JjCommitReceipt} shapes rather than the
 * attempt-bound `VcsDiff` / `WorkspaceStatus` / `VcsCommitReceipt` types.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

import type {
  Clock,
  GitSha,
  IdGenerator,
  NonEmptyText,
  TaskNodeId,
  Timestamp,
} from "@minions/core";
import { gitSha, nonEmptyText } from "@minions/core";

export const JJ_METADATA_DIR = ".jj";

export type JjWorkingCopyErrorCode =
  | "invalid_options"
  | "jj_unavailable"
  | "working_copy_exists"
  | "working_copy_missing"
  | "not_found"
  | "clone_failed"
  | "checkout_failed"
  | "diff_failed"
  | "status_failed"
  | "commit_failed"
  | "destroy_failed"
  | "output_limit"
  | "filesystem_error";

export class JjWorkingCopyError extends Error {
  readonly code: JjWorkingCopyErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: JjWorkingCopyErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JjWorkingCopyError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

/**
 * A masked jj working copy. `workingCopyPath` is the host-local absolute path
 * to the working-copy tree (it contains `.jj` on the host); `.jj` is excluded
 * from every sandbox mount by the shared policy validators. `workingCopyId` is
 * the jj change id of the working-copy change (`@`); `parentChangeId` is the
 * change id of the base commit (`@-`); `baseCommit` is the git commit SHA the
 * working copy was pinned to.
 */
export type JjWorkingCopy = Readonly<{
  readonly workingCopyId: string;
  readonly workingCopyPath: string;
  readonly parentChangeId: string;
  readonly baseCommit: GitSha;
  readonly createdAt: Timestamp;
}>;

/** The diff of uncommitted working-copy changes against the parent, through the broker. */
export type JjWorkingCopyDiff = Readonly<{
  readonly workingCopyId: string;
  readonly parentChangeId: string;
  readonly diff: Uint8Array;
  readonly capturedAt: Timestamp;
}>;

/** The working-copy status (changed paths + cleanliness), through the broker. */
export type JjWorkingCopyStatus = Readonly<{
  readonly workingCopyId: string;
  readonly parentChangeId: string;
  readonly baseCommit: GitSha;
  readonly changedPaths: readonly string[];
  readonly clean: boolean;
  readonly capturedAt: Timestamp;
}>;

/** Receipt for {@link JjWorkingCopyManager.commit}, through the broker. */
export type JjCommitReceipt = Readonly<{
  readonly workingCopyId: string;
  readonly newWorkingCopyId: string;
  readonly parentChangeId: string;
  readonly commitSha: GitSha;
  readonly message: NonEmptyText;
  readonly committedAt: Timestamp;
}>;

export type JjWorkingCopyManagerOptions = Readonly<{
  /** Absolute path to the pinned, digest-verified jj binary (from `ensureJjCapability`). */
  readonly jjBinaryPath: string;
  /** Absolute host-local path to the central colocated jj repo (from PR 27's `JjCentralRepo.jjRepoPath`). */
  readonly centralRepoPath: string;
  /** Absolute host-local root under which per-node working copies are created. */
  readonly hostRoot: string;
  readonly clock: Clock;
  /**
   * Engine id generator. Reserved for the PR-29 change-id binding table (binding a
   * working-copy id to an attempt id); the jj change ids themselves come from jj.
   */
  readonly ids: IdGenerator;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}>;

export interface JjWorkingCopyManager {
  createWorkingCopy(nodeId: TaskNodeId, baseCommit: GitSha): Promise<JjWorkingCopy>;
  diff(workingCopyId: string): Promise<JjWorkingCopyDiff>;
  status(workingCopyId: string): Promise<JjWorkingCopyStatus>;
  commit(workingCopyId: string, message: NonEmptyText): Promise<JjCommitReceipt>;
  destroyWorkingCopy(workingCopyId: string): Promise<void>;
}

// -------------------------------------------------------------------------------------------------
// Constants.
// -------------------------------------------------------------------------------------------------

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 1_048_576;
const workingCopyMode = 0o700;
const dotJjMode = 0o700;
const changeIdPattern = /^[0-9a-z]{32}$/u;
const commitIdPattern = /^[0-9a-f]{40}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

interface JjRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface StoredWorkingCopy {
  readonly workingCopyId: string;
  readonly workingCopyPath: string;
  readonly parentChangeId: string;
  readonly baseCommit: GitSha;
  readonly createdAt: Timestamp;
}

// -------------------------------------------------------------------------------------------------
// Bounded jj subprocess runner (mirrors the PR-21 / PR-27 bounded runner).
// -------------------------------------------------------------------------------------------------

function runJj(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<JjRunResult> {
  return new Promise<JjRunResult>((resolve) => {
    const child = spawn(binaryPath, args, {
      cwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (!truncated && stdoutLength + chunk.length > maxOutputBytes) {
        truncated = true;
        child.kill("SIGKILL");
      }
      if (stdoutLength < maxOutputBytes) {
        stdoutChunks.push(chunk);
        stdoutLength += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrLength < maxOutputBytes) {
        stderrChunks.push(chunk);
        stderrLength += chunk.length;
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const finalize = (exitCode: number | null, error?: Error): void => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: error === undefined ? Buffer.concat(stderrChunks).toString("utf8") : error.message,
      });
    };
    child.once("error", (error) => {
      finalize(null, error);
    });
    child.once("close", (code) => {
      finalize(code);
    });
  });
}

function wcError(
  code: JjWorkingCopyErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): JjWorkingCopyError {
  return new JjWorkingCopyError(code, message, remediation, cause);
}

function errorToString(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns `true` iff `candidate` is the same as or a descendant of `root` (both absolute).
 *   Resolves no symlinks — this is a lexical containment check used only on engine-owned
 *   host paths to guard `rm -rf` against path confusion.
 */
function isSameOrWithinLexical(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

function firstNonEmptyLine(value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

// -------------------------------------------------------------------------------------------------
// Factory.
// -------------------------------------------------------------------------------------------------

/**
 * Create a masked jj working copy manager. The manager creates one jj working copy per
 * node under `<hostRoot>/wc-<nodeId>/`, keeps `.jj` host-owned, and routes every jj
 * mutation through this serialized broker. The harness/node never calls `jj` directly.
 */
export function createJjWorkingCopyManager(
  options: JjWorkingCopyManagerOptions,
): JjWorkingCopyManager {
  if (
    typeof options.jjBinaryPath !== "string" ||
    !isAbsolute(options.jjBinaryPath) ||
    options.jjBinaryPath.length === 0
  ) {
    throw wcError(
      "invalid_options",
      "jjBinaryPath must be an absolute path",
      "Pass the binaryPath from an available ensureJjCapability probe.",
    );
  }
  if (
    typeof options.centralRepoPath !== "string" ||
    !isAbsolute(options.centralRepoPath) ||
    options.centralRepoPath.length === 0
  ) {
    throw wcError(
      "invalid_options",
      "centralRepoPath must be an absolute path",
      "Pass the jjRepoPath from a bootstrapped JjCentralRepo (PR 27).",
    );
  }
  if (
    typeof options.hostRoot !== "string" ||
    !isAbsolute(options.hostRoot) ||
    options.hostRoot.length === 0
  ) {
    throw wcError(
      "invalid_options",
      "hostRoot must be an absolute path",
      "Configure an absolute host-local root owned by the engine.",
    );
  }
  if (isSameOrWithinLexical(options.centralRepoPath, options.hostRoot)) {
    throw wcError(
      "invalid_options",
      "centralRepoPath must not live under hostRoot (siblings must be unreachable)",
      "Place the central jj repo outside the working-copy host root.",
    );
  }

  const jjBinaryPath = options.jjBinaryPath;
  const centralRepoPath = options.centralRepoPath;
  const hostRoot = options.hostRoot;
  const clock = options.clock;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;

  const store = new Map<string, StoredWorkingCopy>();
  // Serialized broker: every jj invocation chains off the previous one so concurrent
  // callers cannot interleave jj operations on the shared op log (GIT-15).
  let chain: Promise<void> = Promise.resolve();

  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const pending = chain.catch(() => undefined).then(fn);
    chain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function run(
    args: readonly string[],
    cwd: string,
    code: JjWorkingCopyErrorCode,
    failureMessage: string,
    remediation: string,
  ): Promise<JjRunResult> {
    const binaryReady = await pathExists(jjBinaryPath);
    if (!binaryReady) {
      throw wcError(
        "jj_unavailable",
        `jj binary not found at '${jjBinaryPath}'`,
        "Run host setup (ensureJjCapability) before creating working copies.",
      );
    }
    let result: JjRunResult;
    try {
      result = await runJj(jjBinaryPath, args, cwd, signal, timeoutMs, maxOutputBytes);
    } catch (error: unknown) {
      throw wcError(code, `${failureMessage}: ${errorToString(error)}`, remediation, error);
    }
    if (result.stdout.length > maxOutputBytes || result.stderr.length > maxOutputBytes) {
      throw wcError(
        "output_limit",
        `jj ${args.join(" ")} output exceeds the configured limit`,
        "Raise maxOutputBytes or reduce the working-copy scope.",
      );
    }
    if (result.exitCode !== 0) {
      throw wcError(
        code,
        `${failureMessage}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
        remediation,
      );
    }
    return result;
  }

  function requireWorkingCopy(workingCopyId: string): StoredWorkingCopy {
    const stored = store.get(workingCopyId);
    if (stored === undefined) {
      throw wcError(
        "not_found",
        `working copy '${workingCopyId}' is not registered with this broker`,
        "Create the working copy before mutating it.",
      );
    }
    return stored;
  }

  async function captureChangeId(revset: string, cwd: string): Promise<string> {
    const result = await run(
      ["log", "--no-graph", "-r", revset, "-T", 'change_id ++ "\n"'],
      cwd,
      "status_failed",
      `jj log change_id for '${revset}' failed`,
      "Inspect the working copy; destroy and recreate it if it is corrupt.",
    );
    const id = firstNonEmptyLine(result.stdout);
    if (!changeIdPattern.test(id)) {
      throw wcError(
        "status_failed",
        `could not parse a change id for '${revset}' (got '${id}')`,
        "Inspect the working copy; destroy and recreate it if it is corrupt.",
      );
    }
    return id;
  }

  async function captureCommitId(revset: string, cwd: string): Promise<string> {
    const result = await run(
      ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\n"'],
      cwd,
      "status_failed",
      `jj log commit_id for '${revset}' failed`,
      "Inspect the working copy; destroy and recreate it if it is corrupt.",
    );
    const id = firstNonEmptyLine(result.stdout);
    if (!commitIdPattern.test(id)) {
      throw wcError(
        "status_failed",
        `could not parse a commit id for '${revset}' (got '${id}')`,
        "Inspect the working copy; destroy and recreate it if it is corrupt.",
      );
    }
    return id;
  }

  return {
    async createWorkingCopy(nodeId: TaskNodeId, baseCommit: GitSha): Promise<JjWorkingCopy> {
      return serialized(async (): Promise<JjWorkingCopy> => {
        if (typeof nodeId !== "string" || nodeId.length === 0) {
          throw wcError(
            "invalid_options",
            "nodeId must be a non-empty TaskNodeId",
            "Pass the owning task node id.",
          );
        }
        if (!shaPattern.test(baseCommit)) {
          throw wcError(
            "invalid_options",
            "baseCommit must be a 40- or 64-character lowercase-hex git SHA",
            "Pass the base commit SHA from the central jj repo.",
          );
        }
        const workingCopyPath = join(hostRoot, `wc-${nodeId}`);
        if (await pathExists(join(workingCopyPath, JJ_METADATA_DIR))) {
          throw wcError(
            "working_copy_exists",
            `a working copy already exists at '${workingCopyPath}'`,
            "Destroy the existing working copy before recreating it for this node.",
          );
        }
        const binaryReady = await pathExists(jjBinaryPath);
        if (!binaryReady) {
          throw wcError(
            "jj_unavailable",
            `jj binary not found at '${jjBinaryPath}'`,
            "Run host setup (ensureJjCapability) before creating working copies.",
          );
        }
        if (!(await pathExists(join(centralRepoPath, JJ_METADATA_DIR)))) {
          throw wcError(
            "working_copy_missing",
            `central jj repo at '${centralRepoPath}' has no ${JJ_METADATA_DIR}`,
            "Bootstrap the central jj repo (PR 27) before creating working copies.",
          );
        }
        try {
          await mkdir(workingCopyPath, { recursive: true, mode: workingCopyMode });
          await chmod(workingCopyPath, workingCopyMode);
        } catch (error: unknown) {
          throw wcError(
            "filesystem_error",
            `could not create working copy directory '${workingCopyPath}': ${errorToString(error)}`,
            "Ensure the host root is writable by the engine.",
            error,
          );
        }
        try {
          await run(
            ["git", "clone", centralRepoPath, workingCopyPath],
            hostRoot,
            "clone_failed",
            `jj git clone of '${centralRepoPath}' into '${workingCopyPath}' failed`,
            "Inspect the central jj repo and the working-copy host root.",
          );
          await run(
            ["new", baseCommit],
            workingCopyPath,
            "checkout_failed",
            `jj new ${baseCommit} failed in '${workingCopyPath}'`,
            "Ensure the base commit is reachable from the central jj repo's bookmarks.",
          );
        } catch (error: unknown) {
          if (error instanceof JjWorkingCopyError) {
            // Best-effort cleanup of a half-created working copy.
            await rm(workingCopyPath, { recursive: true, force: true });
            throw error;
          }
          await rm(workingCopyPath, { recursive: true, force: true });
          throw wcError(
            "clone_failed",
            `unexpected failure creating working copy: ${errorToString(error)}`,
            "Inspect the central jj repo and the working-copy host root.",
            error,
          );
        }

        if (!(await pathExists(join(workingCopyPath, JJ_METADATA_DIR)))) {
          throw wcError(
            "clone_failed",
            `working copy at '${workingCopyPath}' is missing ${JJ_METADATA_DIR}`,
            "Destroy and recreate the working copy.",
          );
        }
        // Lock `.jj` owner-only (GIT-15): never traversable by a sandbox even if mounted.
        try {
          await chmod(join(workingCopyPath, JJ_METADATA_DIR), dotJjMode);
        } catch (error: unknown) {
          await rm(workingCopyPath, { recursive: true, force: true });
          throw wcError(
            "filesystem_error",
            `could not enforce owner-only permissions on '${join(workingCopyPath, JJ_METADATA_DIR)}': ${errorToString(error)}`,
            "Ensure the working-copy host root is writable by the engine.",
            error,
          );
        }

        const workingCopyId = await captureChangeId("@", workingCopyPath);
        const parentChangeId = await captureChangeId("@-", workingCopyPath);
        const observedBaseCommit = await captureCommitId("@-", workingCopyPath);
        if (observedBaseCommit !== baseCommit) {
          await rm(workingCopyPath, { recursive: true, force: true });
          throw wcError(
            "checkout_failed",
            `working copy parent commit '${observedBaseCommit}' does not match base commit '${baseCommit}'`,
            "Ensure the base commit is reachable from the central jj repo's bookmarks.",
          );
        }
        const createdAt = clock.now();
        const record: StoredWorkingCopy = {
          workingCopyId,
          workingCopyPath,
          parentChangeId,
          baseCommit: gitSha(baseCommit),
          createdAt,
        };
        store.set(workingCopyId, record);
        return Object.freeze({ ...record });
      });
    },

    diff(workingCopyId: string): Promise<JjWorkingCopyDiff> {
      return serialized(async (): Promise<JjWorkingCopyDiff> => {
        const stored = requireWorkingCopy(workingCopyId);
        const result = await run(
          ["diff"],
          stored.workingCopyPath,
          "diff_failed",
          `jj diff failed in '${stored.workingCopyPath}'`,
          "Inspect the working copy; destroy and recreate it if it is corrupt.",
        );
        return Object.freeze({
          workingCopyId: stored.workingCopyId,
          parentChangeId: stored.parentChangeId,
          diff: new TextEncoder().encode(result.stdout),
          capturedAt: clock.now(),
        });
      });
    },

    status(workingCopyId: string): Promise<JjWorkingCopyStatus> {
      return serialized(async (): Promise<JjWorkingCopyStatus> => {
        const stored = requireWorkingCopy(workingCopyId);
        const result = await run(
          ["diff", "--name-only"],
          stored.workingCopyPath,
          "status_failed",
          `jj diff --name-only failed in '${stored.workingCopyPath}'`,
          "Inspect the working copy; destroy and recreate it if it is corrupt.",
        );
        const changedPaths = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .sort();
        return Object.freeze({
          workingCopyId: stored.workingCopyId,
          parentChangeId: stored.parentChangeId,
          baseCommit: stored.baseCommit,
          changedPaths: Object.freeze(changedPaths),
          clean: changedPaths.length === 0,
          capturedAt: clock.now(),
        });
      });
    },

    commit(workingCopyId: string, message: NonEmptyText): Promise<JjCommitReceipt> {
      return serialized(async (): Promise<JjCommitReceipt> => {
        const stored = requireWorkingCopy(workingCopyId);
        if (typeof message !== "string" || message.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "commit message must be non-empty",
            "Pass a non-empty commit message.",
          );
        }
        const committed = nonEmptyText(message, "commit message");
        // The current working-copy change is the one being committed. Sanity-check it
        // matches the caller's workingCopyId; if it has drifted, the caller's id is stale.
        const currentId = await captureChangeId("@", stored.workingCopyPath);
        if (currentId !== workingCopyId) {
          throw wcError(
            "not_found",
            `working-copy change id '${currentId}' no longer matches the registered id '${workingCopyId}'`,
            "Re-fetch the working-copy id from the broker before committing.",
          );
        }
        // `jj commit -m <msg>` describes @ with the message, commits it, and creates a
        // new empty working-copy change on top — all atomically, through the broker.
        await run(
          ["commit", "-m", message],
          stored.workingCopyPath,
          "commit_failed",
          `jj commit failed in '${stored.workingCopyPath}'`,
          "Inspect the working copy; destroy and recreate it if it is corrupt.",
        );
        // Capture the committed change's git commit SHA and the new working-copy change id.
        const commitSha = gitSha(await captureCommitId(workingCopyId, stored.workingCopyPath));
        const newWorkingCopyId = await captureChangeId("@", stored.workingCopyPath);
        const newRecord: StoredWorkingCopy = {
          workingCopyId: newWorkingCopyId,
          workingCopyPath: stored.workingCopyPath,
          parentChangeId: workingCopyId,
          baseCommit: stored.baseCommit,
          createdAt: stored.createdAt,
        };
        store.set(newWorkingCopyId, newRecord);
        // Retire the old id: it is now a committed (immutable) change, no longer @.
        store.delete(workingCopyId);
        return Object.freeze({
          workingCopyId,
          newWorkingCopyId,
          parentChangeId: stored.parentChangeId,
          commitSha,
          message: committed,
          committedAt: clock.now(),
        });
      });
    },

    destroyWorkingCopy(workingCopyId: string): Promise<void> {
      return serialized(async (): Promise<void> => {
        const stored = store.get(workingCopyId);
        if (stored === undefined) {
          // Idempotent: destroying an unknown id is a no-op.
          return;
        }
        if (!isSameOrWithinLexical(stored.workingCopyPath, hostRoot)) {
          throw wcError(
            "destroy_failed",
            `refusing to destroy working copy '${stored.workingCopyPath}' outside hostRoot '${hostRoot}'`,
            "Ensure the working-copy host root is configured correctly.",
          );
        }
        try {
          await rm(stored.workingCopyPath, { recursive: true, force: true });
        } catch (error: unknown) {
          throw wcError(
            "destroy_failed",
            `could not destroy working copy '${stored.workingCopyPath}': ${errorToString(error)}`,
            "Remove the working-copy directory manually and rerun.",
            error,
          );
        }
        store.delete(workingCopyId);
      });
    },
  };
}

/**
 * Lexical test: does `path` contain a `.jj` path segment? Used to assert, independent of
 * the sandbox policy validators, that a candidate mount source never brings jj metadata
 * into a sandbox (GIT-15). Both POSIX and Windows separators are accepted.
 */
export function pathContainsDotJj(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  return path.split(/[\\/]/u).some((segment) => segment === JJ_METADATA_DIR);
}
