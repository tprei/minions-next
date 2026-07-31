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

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

import type {
  Clock,
  ContentHash,
  GitSha,
  IdGenerator,
  NonEmptyText,
  SandboxMount,
  SandboxMountAccess,
  TaskNodeId,
  Timestamp,
} from "@minions/core";
import { contentHash, gitSha, nonEmptyText, SandboxDeniedError } from "@minions/core";
import { createNodeGitProcess } from "./git-process.js";

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
  | "filesystem_error"
  | "new_change_failed"
  | "squash_failed"
  | "split_failed"
  | "restore_failed"
  | "apply_patch_failed";

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

/**
 * Author identity applied to engine-owned commits. Always the deterministic
 * engine identity — never the agent's (GIT-02/GIT-09). The broker sets this on
 * the working-copy repo config before committing so every captured commit is
 * attributable to the engine, not whoever happened to call the broker.
 */
export type AuthorIdentity = Readonly<{
  readonly name: NonEmptyText;
  readonly email: NonEmptyText;
}>;

/**
 * Live working-copy head, read through the broker. `workingCopyChangeId` is the
 * current `@` change; `parentChangeId` / `parentCommit` are `@-`. Used by the
 * PR-30 commit-capture manager to detect agent-side commits (the registered
 * working-copy id drifting off `@`) and to verify the expected workspace head.
 */
export type JjWorkingCopyHead = Readonly<{
  readonly workingCopyId: string;
  readonly workingCopyChangeId: string;
  readonly parentChangeId: string;
  readonly parentCommit: GitSha;
  readonly capturedAt: Timestamp;
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

/** Receipt for {@link JjWorkingCopyManager.newChange}. */
export type JjNewChangeReceipt = Readonly<{
  readonly changeId: string;
}>;

/** Receipt for {@link JjWorkingCopyManager.squashInto}. */
export type JjSquashReceipt = Readonly<{
  readonly changeId: string;
  readonly commit: GitSha;
  readonly parentCount: number;
  readonly conflicted: boolean;
  readonly operationLogId: string;
}>;

/** Receipt for {@link JjWorkingCopyManager.split}. */
export type JjSplitReceipt = Readonly<{
  readonly changeId: string;
  readonly commit: GitSha;
  readonly parentCount: number;
  readonly operationLogId: string;
}>;

/** Result of {@link JjWorkingCopyManager.describeRevision} / the internal state {@link JjWorkingCopyManager.squashInto} re-queries after a fold. */
export type JjRevisionDescriptor = Readonly<{
  readonly changeId: string;
  readonly commit: GitSha;
  readonly parentCount: number;
  readonly conflicted: boolean;
}>;

export interface JjWorkingCopyManager {
  createWorkingCopy(nodeId: TaskNodeId, baseCommit: GitSha): Promise<JjWorkingCopy>;
  /** Live `@` change id + `@-` parent change id / commit, read through the broker. */
  head(workingCopyId: string): Promise<JjWorkingCopyHead>;
  diff(workingCopyId: string): Promise<JjWorkingCopyDiff>;
  status(workingCopyId: string): Promise<JjWorkingCopyStatus>;
  /**
   * Describe `@` with `message` and commit it through the broker. When `author`
   * is supplied the engine identity is written to the working-copy repo config
   * first, so the new commit is attributable to the engine, not the caller.
   */
  commit(
    workingCopyId: string,
    message: NonEmptyText,
    author?: AuthorIdentity,
  ): Promise<JjCommitReceipt>;
  /** Current jj operation-log id of the working copy, read through the broker. */
  currentOperationLogId(workingCopyId: string): Promise<ContentHash>;
  destroyWorkingCopy(workingCopyId: string): Promise<void>;
  /**
   * Create a new empty change on top of `parentChangeId` (a raw jj change id,
   * commit SHA, or other revset jj resolves within this working copy) and move
   * `@` onto it (`jj new <parentChangeId>`). Used to create a temporary fixup
   * child a caller then writes fix content into (see {@link applyPatch}).
   */
  newChange(workingCopyId: string, parentChangeId: string): Promise<JjNewChangeReceipt>;
  /**
   * Fold `fromChangeId`'s full diff into `intoChangeId`
   * (`jj squash --from <fromChangeId> --into <intoChangeId>`), keeping
   * `intoChangeId`'s own description. Reports the resulting parent count and
   * conflict state; does NOT throw on a conflicted fold — jj represents a
   * conflict as durable commit state (conflict-as-commit), so the caller must
   * inspect `conflicted` (and, if true, {@link diffRevision} the result) rather
   * than relying on a non-zero exit code.
   */
  squashInto(
    workingCopyId: string,
    fromChangeId: string,
    intoChangeId: string,
  ): Promise<JjSquashReceipt>;
  /**
   * Split `fileset`'s changes out of `revision` into a new sibling change
   * parented on `revision`'s OWN parent (`jj split -r <revision> -o <parent>
   * <fileset...>`), non-interactive since a fileset is always supplied.
   * `revision` itself keeps the remaining (non-selected) changes and its own
   * jj change id; repeated calls against the same shrinking `revision` do not
   * disturb previously-split siblings (they are not `revision`'s descendants,
   * so jj's auto-rebase never touches them). `message` (default
   * `"split segment"`) is the new sibling's description.
   */
  split(
    workingCopyId: string,
    revision: string,
    fileset: readonly string[],
    message?: string,
  ): Promise<JjSplitReceipt>;
  /** Git-format diff (`jj diff --git -r <revision>`) of an arbitrary revision, through the broker. */
  diffRevision(workingCopyId: string, revision: string): Promise<Uint8Array>;
  /** Read {changeId, commit, parentCount, conflicted} for an arbitrary revision, through the broker. */
  describeRevision(workingCopyId: string, revision: string): Promise<JjRevisionDescriptor>;
  /** Raw jj operation-log id of the working copy (a rollback anchor for {@link restoreOperation}), through the broker. */
  currentOperationId(workingCopyId: string): Promise<string>;
  /** Restore the working copy to a previously-captured operation id (`jj operation restore <operationId>`), through the broker. */
  restoreOperation(workingCopyId: string, operationId: string): Promise<void>;
  /**
   * Apply a unified diff to the working copy's files (`git apply`, since jj
   * commits are backed by the underlying colocated git store) without staging
   * it in git's index. The next jj invocation through the broker auto-snapshots
   * the result onto `@`, exactly like a direct file write picked up by
   * {@link commit} / {@link diff} / {@link status}.
   */
  applyPatch(workingCopyId: string, patch: string): Promise<void>;
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
const opIdPattern = /^[0-9a-f]{64,}$/u;
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

function nonEmptyLines(value: string): readonly string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
  const ids = options.ids;
  const gitProcess = createNodeGitProcess();

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
  async function captureParentCount(revset: string, cwd: string): Promise<number> {
    const result = await run(
      ["log", "--no-graph", "-r", revset, "-T", 'parents.len() ++ "\\n"'],
      cwd,
      "status_failed",
      `jj log parent count for '${revset}' failed`,
      "Inspect the working copy; destroy and recreate it if it is corrupt.",
    );
    const raw = firstNonEmptyLine(result.stdout);
    const count = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(count) || count < 0 || String(count) !== raw) {
      throw wcError(
        "status_failed",
        `could not parse a parent count for '${revset}' (got '${raw}')`,
        "Inspect the working copy; destroy and recreate it if it is corrupt.",
      );
    }
    return count;
  }

  async function captureConflicted(revset: string, cwd: string): Promise<boolean> {
    const result = await run(
      ["log", "--no-graph", "-r", revset, "-T", 'conflict ++ "\\n"'],
      cwd,
      "status_failed",
      `jj log conflict state for '${revset}' failed`,
      "Inspect the working copy; destroy and recreate it if it is corrupt.",
    );
    const raw = firstNonEmptyLine(result.stdout);
    if (raw !== "true" && raw !== "false") {
      throw wcError(
        "status_failed",
        `could not parse a conflict state for '${revset}' (got '${raw}')`,
        "Inspect the working copy; destroy and recreate it if it is corrupt.",
      );
    }
    return raw === "true";
  }

  async function captureChangeIdList(revset: string, cwd: string): Promise<readonly string[]> {
    const result = await run(
      ["log", "--no-graph", "-r", revset, "-T", 'change_id ++ "\\n"'],
      cwd,
      "status_failed",
      `jj log change_id list for '${revset}' failed`,
      "Inspect the working copy; destroy and recreate it if it is corrupt.",
    );
    return nonEmptyLines(result.stdout).filter((line) => changeIdPattern.test(line));
  }

  async function captureRawOperationId(cwd: string): Promise<string> {
    const result = await run(
      ["op", "log", "--no-graph", "--limit", "1", "-T", 'id ++ "\\n"'],
      cwd,
      "status_failed",
      `jj op log failed in '${cwd}'`,
      "Inspect the working copy; destroy and recreate it if it is corrupt.",
    );
    const id = firstNonEmptyLine(result.stdout);
    if (!/^[0-9a-f]{64,}$/u.test(id)) {
      throw wcError(
        "status_failed",
        `could not parse an operation-log id in '${cwd}' (got '${id}')`,
        "Inspect the working copy; destroy and recreate it if it is corrupt.",
      );
    }
    return id;
  }

  async function describeRevisionInternal(
    revset: string,
    cwd: string,
  ): Promise<JjRevisionDescriptor> {
    const changeId = await captureChangeId(revset, cwd);
    const commit = gitSha(await captureCommitId(changeId, cwd));
    const parentCount = await captureParentCount(changeId, cwd);
    const conflicted = await captureConflicted(changeId, cwd);
    return Object.freeze({ changeId, commit, parentCount, conflicted });
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

  async function captureOperationLogId(cwd: string): Promise<ContentHash> {
    const result = await run(
      ["op", "log", "--no-graph", "--limit", "1", "-T", 'id ++ "\n"'],
      cwd,
      "status_failed",
      `jj op log failed in '${cwd}'`,
      "Inspect the working copy; destroy and recreate it if it is corrupt.",
    );
    const id = firstNonEmptyLine(result.stdout);
    if (!opIdPattern.test(id)) {
      throw wcError(
        "status_failed",
        `could not parse an operation-log id in '${cwd}' (got '${id}')`,
        "Inspect the working copy; destroy and recreate it if it is corrupt.",
      );
    }
    // jj operation-log ids are longer than the binding's 64-hex ContentHash space
    // (jj 0.43 emits ~160-hex composite op ids), so fingerprint them via SHA-256
    // into the stable, content-addressed id the binding stores.
    return contentHash(createHash("sha256").update(id).digest("hex"));
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

    head(workingCopyId: string): Promise<JjWorkingCopyHead> {
      return serialized(async (): Promise<JjWorkingCopyHead> => {
        const stored = requireWorkingCopy(workingCopyId);
        const workingCopyChangeId = await captureChangeId("@", stored.workingCopyPath);
        const parentChangeId = await captureChangeId("@-", stored.workingCopyPath);
        const parentCommit = gitSha(await captureCommitId("@-", stored.workingCopyPath));
        return Object.freeze({
          workingCopyId,
          workingCopyChangeId,
          parentChangeId,
          parentCommit,
          capturedAt: clock.now(),
        });
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

    commit(
      workingCopyId: string,
      message: NonEmptyText,
      author?: AuthorIdentity,
    ): Promise<JjCommitReceipt> {
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
        // When an author identity is supplied, pin it on the working-copy repo config so
        // the captured commit is attributable to the engine, not whoever called the
        // broker (GIT-02/GIT-09). `jj describe -m <message>` then `jj commit` keeps the
        // describe + commit steps explicit and the new working-copy change empty on top.
        if (author !== undefined) {
          await run(
            ["config", "set", "--repo", "user.name", author.name],
            stored.workingCopyPath,
            "commit_failed",
            `jj config set user.name failed in '${stored.workingCopyPath}'`,
            "Inspect the working copy; destroy and recreate it if it is corrupt.",
          );
          await run(
            ["config", "set", "--repo", "user.email", author.email],
            stored.workingCopyPath,
            "commit_failed",
            `jj config set user.email failed in '${stored.workingCopyPath}'`,
            "Inspect the working copy; destroy and recreate it if it is corrupt.",
          );
          await run(
            ["describe", "-m", message],
            stored.workingCopyPath,
            "commit_failed",
            `jj describe failed in '${stored.workingCopyPath}'`,
            "Inspect the working copy; destroy and recreate it if it is corrupt.",
          );
          // `jj commit` (bare) is equivalent to an interactive `jj describe` followed by
          // `jj new` — it opens an editor for @'s description regardless of the prior
          // `describe -m` above, and the broker never has a TTY to satisfy it. Passing
          // `-m` here re-asserts the same message non-interactively instead.
          await run(
            ["commit", "-m", message],
            stored.workingCopyPath,
            "commit_failed",
            `jj commit failed in '${stored.workingCopyPath}'`,
            "Inspect the working copy; destroy and recreate it if it is corrupt.",
          );
        } else {
          // `jj commit -m <msg>` describes @ with the message, commits it, and creates a
          // new empty working-copy change on top — all atomically, through the broker.
          await run(
            ["commit", "-m", message],
            stored.workingCopyPath,
            "commit_failed",
            `jj commit failed in '${stored.workingCopyPath}'`,
            "Inspect the working copy; destroy and recreate it if it is corrupt.",
          );
        }
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

    currentOperationLogId(workingCopyId: string): Promise<ContentHash> {
      return serialized(async (): Promise<ContentHash> => {
        const stored = requireWorkingCopy(workingCopyId);
        return captureOperationLogId(stored.workingCopyPath);
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
    newChange(workingCopyId: string, parentChangeId: string): Promise<JjNewChangeReceipt> {
      return serialized(async (): Promise<JjNewChangeReceipt> => {
        const stored = requireWorkingCopy(workingCopyId);
        if (typeof parentChangeId !== "string" || parentChangeId.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "parentChangeId must be a non-empty revset",
            "Pass the raw jj change id, commit SHA, or revset of the change to build the new child on top of.",
          );
        }
        await run(
          ["new", parentChangeId],
          stored.workingCopyPath,
          "new_change_failed",
          `jj new ${parentChangeId} failed in '${stored.workingCopyPath}'`,
          "Inspect the working copy; ensure the parent revision exists.",
        );
        const changeId = await captureChangeId("@", stored.workingCopyPath);
        const resolvedParentChangeId = await captureChangeId("@-", stored.workingCopyPath);
        store.set(changeId, {
          workingCopyId: changeId,
          workingCopyPath: stored.workingCopyPath,
          parentChangeId: resolvedParentChangeId,
          baseCommit: stored.baseCommit,
          createdAt: clock.now(),
        });
        return Object.freeze({ changeId });
      });
    },

    squashInto(
      workingCopyId: string,
      fromChangeId: string,
      intoChangeId: string,
    ): Promise<JjSquashReceipt> {
      return serialized(async (): Promise<JjSquashReceipt> => {
        const stored = requireWorkingCopy(workingCopyId);
        if (typeof fromChangeId !== "string" || fromChangeId.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "fromChangeId must be a non-empty revset",
            "Pass the change id to squash from (e.g. the fixup change).",
          );
        }
        if (typeof intoChangeId !== "string" || intoChangeId.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "intoChangeId must be a non-empty revset",
            "Pass the destination change id to squash into.",
          );
        }
        await run(
          ["squash", "--from", fromChangeId, "--into", intoChangeId, "--use-destination-message"],
          stored.workingCopyPath,
          "squash_failed",
          `jj squash --from ${fromChangeId} --into ${intoChangeId} failed in '${stored.workingCopyPath}'`,
          "Inspect the working copy via the broker; the source change is preserved for retry.",
        );
        const described = await describeRevisionInternal(intoChangeId, stored.workingCopyPath);
        const operationLogId = await captureRawOperationId(stored.workingCopyPath);
        return Object.freeze({ ...described, operationLogId });
      });
    },

    split(
      workingCopyId: string,
      revision: string,
      fileset: readonly string[],
      message?: string,
    ): Promise<JjSplitReceipt> {
      return serialized(async (): Promise<JjSplitReceipt> => {
        const stored = requireWorkingCopy(workingCopyId);
        if (typeof revision !== "string" || revision.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "revision must be a non-empty revset",
            "Pass the change id to split.",
          );
        }
        if (
          fileset.length === 0 ||
          fileset.some((path) => typeof path !== "string" || path.trim().length === 0)
        ) {
          throw wcError(
            "invalid_options",
            "fileset must be a non-empty array of non-empty path strings",
            "Pass at least one file path for the segment.",
          );
        }
        const cwd = stored.workingCopyPath;
        const parent = await captureChangeId(`${revision}-`, cwd);
        const before = new Set(await captureChangeIdList(`${parent}+`, cwd));
        await run(
          ["split", "-r", revision, "-o", parent, ...fileset, "-m", message ?? "split segment"],
          cwd,
          "split_failed",
          `jj split -r ${revision} -o ${parent} failed in '${cwd}'`,
          "Inspect the working copy via the broker; the original change is preserved for retry.",
        );
        const after = await captureChangeIdList(`${parent}+`, cwd);
        const created = after.filter((id) => !before.has(id));
        const changeId = created[0];
        if (changeId === undefined || created.length !== 1) {
          throw wcError(
            "split_failed",
            `expected exactly one new child of '${parent}' after splitting '${revision}', found ${String(created.length)}`,
            "Inspect the working copy; destroy and recreate it if it is corrupt.",
          );
        }
        const commit = gitSha(await captureCommitId(changeId, cwd));
        const parentCount = await captureParentCount(changeId, cwd);
        const operationLogId = await captureRawOperationId(cwd);
        return Object.freeze({ changeId, commit, parentCount, operationLogId });
      });
    },

    diffRevision(workingCopyId: string, revision: string): Promise<Uint8Array> {
      return serialized(async (): Promise<Uint8Array> => {
        const stored = requireWorkingCopy(workingCopyId);
        if (typeof revision !== "string" || revision.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "revision must be a non-empty revset",
            "Pass the change id to diff.",
          );
        }
        const result = await run(
          ["diff", "--git", "-r", revision],
          stored.workingCopyPath,
          "diff_failed",
          `jj diff --git -r ${revision} failed in '${stored.workingCopyPath}'`,
          "Inspect the working copy; destroy and recreate it if it is corrupt.",
        );
        return new TextEncoder().encode(result.stdout);
      });
    },
    describeRevision(workingCopyId: string, revision: string): Promise<JjRevisionDescriptor> {
      return serialized(async (): Promise<JjRevisionDescriptor> => {
        const stored = requireWorkingCopy(workingCopyId);
        if (typeof revision !== "string" || revision.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "revision must be a non-empty revset",
            "Pass the change id to describe.",
          );
        }
        return describeRevisionInternal(revision, stored.workingCopyPath);
      });
    },

    currentOperationId(workingCopyId: string): Promise<string> {
      return serialized(async (): Promise<string> => {
        const stored = requireWorkingCopy(workingCopyId);
        return captureRawOperationId(stored.workingCopyPath);
      });
    },

    restoreOperation(workingCopyId: string, operationId: string): Promise<void> {
      return serialized(async (): Promise<void> => {
        const stored = requireWorkingCopy(workingCopyId);
        if (typeof operationId !== "string" || operationId.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "operationId must be a non-empty operation id",
            "Pass the operation id captured (via currentOperationId) before the mutation to roll back.",
          );
        }
        await run(
          ["operation", "restore", operationId],
          stored.workingCopyPath,
          "restore_failed",
          `jj operation restore ${operationId} failed in '${stored.workingCopyPath}'`,
          "Inspect the working copy; the operation log may not contain this id.",
        );
      });
    },

    applyPatch(workingCopyId: string, patch: string): Promise<void> {
      return serialized(async (): Promise<void> => {
        const stored = requireWorkingCopy(workingCopyId);
        if (typeof patch !== "string" || patch.trim().length === 0) {
          throw wcError(
            "invalid_options",
            "patch must be a non-empty unified diff",
            "Pass a non-empty unified diff to apply.",
          );
        }
        const patchPath = join(tmpdir(), `jj-wc-patch-${ids.nextId()}.diff`);
        try {
          await writeFile(patchPath, patch, "utf8");
          const metadata = await lstat(stored.workingCopyPath, { bigint: true });
          if (metadata.isSymbolicLink()) {
            throw wcError(
              "apply_patch_failed",
              `working copy directory '${stored.workingCopyPath}' is a symlink`,
              "Inspect the working copy; destroy and recreate it if it is corrupt.",
            );
          }
          await gitProcess.run({
            workingDirectory: stored.workingCopyPath,
            workingDirectoryDevice: metadata.dev,
            workingDirectoryInode: metadata.ino,
            arguments: ["apply", "--recount", patchPath],
            timeoutMs,
            maxOutputBytes,
          });
        } catch (error: unknown) {
          if (error instanceof JjWorkingCopyError) throw error;
          throw wcError(
            "apply_patch_failed",
            `applying patch failed in '${stored.workingCopyPath}': ${errorToString(error)}`,
            "Inspect the patch content; it must be a unified diff that applies cleanly to the working copy.",
            error,
          );
        } finally {
          await rm(patchPath, { force: true });
        }
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

/**
 * Build the sandbox mounts for a jj working copy's file tree WITHOUT ever
 * exposing `.jj`.
 *
 * P0 fix (review #29): the accepted-as-"safe" pattern —
 * `{ sourcePath: workingCopy.workingCopyPath, targetPath: "/workspace" }` as a
 * SINGLE mount — binds the whole working-copy directory, and `.jj` lives
 * directly inside it on the host, so it is fully reachable at
 * `/workspace/.jj` in the guest. `pathContainsDotJj`/`validateSandboxPolicy`
 * only reject a mount whose SOURCE or TARGET *string* contains a `.jj`
 * segment — neither `workingCopyPath` nor `/workspace` does, so that check
 * never fires. Masking `.jj` by inspecting path strings cannot work when the
 * mount source is a directory whose *contents* include `.jj`.
 *
 * A later "shadow mount" design (mount the whole working-copy root as the
 * single workspace mount, then mount an empty directory directly over
 * `/workspace/.jj` to shadow it) was considered and rejected:
 * `validateSandboxPolicy` explicitly rejects any mount whose TARGET path
 * traverses a `.jj` segment (the same GIT-15 defense-in-depth check quoted
 * above), by design — the validator does not distinguish "a mount that
 * exposes real `.jj` metadata" from "a mount that happens to target a path
 * spelled `.../.jj`", because allowing the latter is itself the attack
 * surface a less careful caller could exploit. That rule is not something
 * this function should punch a hole through.
 *
 * The fix instead masks at the mount/bind layer by construction: bind-mount
 * each of the working copy's top-level entries INDIVIDUALLY, skip `.jj`,
 * and never construct (or accept) a mount for the working-copy root itself.
 * `.jj` is never a source or target of any returned mount, so a sandbox
 * built from exactly this list structurally cannot reach it — regardless of
 * whether a caller also inspects path strings. Every remaining top-level
 * entry is bind-mounted directly (not copied/mirrored): sandbox reads and
 * writes land on the SAME files jj tracks, so `status`/`diff`/`commit` see
 * them exactly as before, with no host-side mirror, sync step, or staleness
 * window.
 *
 * Known, accepted limitation: a BRAND-NEW top-level entry a sandboxed
 * process creates directly under the mount target (a sibling of the entries
 * mounted here, not inside one of them) has no corresponding bind mount and
 * is lost when the sandbox is destroyed. Callers that need to observe
 * genuinely new top-level paths must rebuild the mount list (call this
 * again) before the next sandbox attempt against the same working copy.
 */
export async function workspaceSandboxMounts(
  workingCopyPath: string,
  targetPath: string,
  access: SandboxMountAccess,
): Promise<readonly SandboxMount[]> {
  const entries = await readdir(workingCopyPath, { withFileTypes: true });
  const mounts: SandboxMount[] = [];
  for (const entry of entries) {
    if (entry.name === JJ_METADATA_DIR) continue;
    const sourcePath = join(workingCopyPath, entry.name);
    const mountTargetPath = join(targetPath, entry.name);
    // Defense in depth beyond the name check above: an entry that is itself a
    // symlink to (or through) `.jj` — e.g. a top-level entry literally named
    // something else that resolves onto the metadata directory — would still
    // expose it once bind-mounted under its own name. Fail closed rather than
    // silently mount it.
    const resolved = await realpath(sourcePath);
    if (pathContainsDotJj(resolved)) {
      throw new SandboxDeniedError(
        "symlink_escape",
        "build_workspace_mounts",
        `working-copy entry '${entry.name}' resolves through '.jj' (${resolved}); refusing to mount it`,
        { workingCopyPath, entry: entry.name },
      );
    }
    mounts.push(
      Object.freeze({
        kind: "workspace" as const,
        sourcePath,
        targetPath: mountTargetPath,
        access,
      }),
    );
  }
  return Object.freeze(mounts);
}
