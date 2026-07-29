/**
 * Revset manager (PR 38, UI-02/05 + GIT-05).
 *
 * Composes the pure revset domain (revset.ts) with the pinned `jj` binary
 * (PR 21) and the durable binding store (PR 29) into the operations the UI and
 * landing pipeline consume:
 *
 * - {@link RevsetManager.execute}: build the scoped jj revset, run it through
 *   the bounded jj runner (`jj log -r '<expr>'`), parse the change ids, and
 *   cross-check them against the binding table. The query can never escape the
 *   registered tree: the binding store is read tree-scoped, the expression is
 *   tree-intersected, and any change id without a binding in the tree is
 *   dropped (fail-closed).
 * - {@link RevsetManager.stackImpact}: per-node descendant counts, derived from
 *   the binding-table topology (UI stack-impact view).
 * - {@link RevsetManager.readyToLand}: per-node readiness (gates pushed on the
 *   current commit, fresh review, clean ancestry) for the ready-to-land view.
 *
 * Every mutation the engine performs flows through a serialized broker; this
 * manager is read-only and never mutates jj state. The bounded runner mirrors
 * the PR-21 / PR-28 runners (timeout, output ceiling, AbortSignal). A test seam
 * ({@link RevsetManagerOptions.runJj}) lets the integration tests swap in a
 * double without spawning the pinned binary.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  buildReviewHeader,
  buildRevsetExpression,
  classifyReviewFreshness,
  filterBindings,
  type RevsetQuery,
  type RevsetResult,
  type ReviewHeader,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type RevsetErrorCode =
  "invalid_options" | "jj_unavailable" | "revset_failed" | "output_limit";

/** Typed revset-manager error. Fail-closed: every jj failure surfaces. */
export class RevsetManagerError extends Error {
  readonly code: RevsetErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: RevsetErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RevsetManagerError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Public surface.
// -------------------------------------------------------------------------------------------------

/** Result of a bounded jj invocation (mirrors the PR-21/PR-28 bounded runner). */
export type RevsetJjRunResult = Readonly<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}>;

/** Run the pinned jj binary with `args` from the working copy. Test seam. */
export type RevsetJjRunner = (args: readonly string[]) => Promise<RevsetJjRunResult>;

export type RevsetManagerOptions = Readonly<{
  /** Absolute path to the pinned, digest-verified jj binary (from ensureJjCapability, PR 21). */
  readonly jjBinaryPath: string;
  /** Absolute path to the colocated jj repo the revset is evaluated against. */
  readonly workingCopyPath: string;
  /** Durable node<->change bindings (PR 29); the source of tree topology + scope. */
  readonly bindingStore: VcsChangeBindingStore;
  /** Aborts an in-flight jj invocation. */
  readonly signal?: AbortSignal;
  /** Per-invocation timeout (default 30s). */
  readonly timeoutMs?: number;
  /** Bounded output ceiling in bytes (default 1MiB). */
  readonly maxOutputBytes?: number;
  /**
   * Test seam: run jj with the given args. Defaults to the bounded jj subprocess
   * runner (spawns the pinned binary). Tests pass a double that returns the
   * change ids the revset "would" match.
   */
  readonly runJj?: RevsetJjRunner;
}>;

/** Per-node stack impact (UI-02): the descendants that ripple from a change here. */
export type NodeImpact = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly changeId: string;
  /** Descendant node ids (excluding the node itself), root-first. */
  readonly descendantNodeIds: readonly TaskNodeId[];
  /** Number of descendant nodes impacted by a change at this node. */
  readonly impactedCount: number;
}>;

/** Per-node readiness (UI-05): whether a node may land right now. */
export type NodeReadiness = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly changeId: string;
  /** `true` iff every gate passed, review is fresh, and ancestry is clean. */
  readonly ready: boolean;
  /** Empty when `ready`; otherwise the fail-closed blockers (machine-readable). */
  readonly blockers: readonly string[];
}>;

export interface RevsetManager {
  /** Run a scoped revset query and cross-check it against the binding table. */
  execute(query: RevsetQuery): Promise<RevsetResult>;
  /** Per-node descendant impact for the tree (UI stack-impact view). */
  stackImpact(treeId: TaskTreeId): Promise<readonly NodeImpact[]>;
  /** Per-node review-header projection: what changed since last review (PR 48). */
  reviewHeaders(treeId: TaskTreeId): Promise<readonly ReviewHeader[]>;
  /** Per-node landing readiness for the tree (ready-to-land view). */
  readyToLand(treeId: TaskTreeId): Promise<readonly NodeReadiness[]>;
}

/**
 * Create a revset manager. Reads are tree-scoped and fail-closed: a query for
 * one tree can never return another tree's bindings. Production passes the
 * pinned binary from {@link ensureJjCapability}; tests pass a `runJj` double.
 */
export function createRevsetManager(options: RevsetManagerOptions): RevsetManager {
  if (
    typeof options.jjBinaryPath !== "string" ||
    !isAbsolute(options.jjBinaryPath) ||
    options.jjBinaryPath.length === 0
  ) {
    throw new RevsetManagerError(
      "invalid_options",
      "jjBinaryPath must be an absolute path",
      "Pass the binaryPath from an available ensureJjCapability probe.",
    );
  }
  if (
    typeof options.workingCopyPath !== "string" ||
    !isAbsolute(options.workingCopyPath) ||
    options.workingCopyPath.length === 0
  ) {
    throw new RevsetManagerError(
      "invalid_options",
      "workingCopyPath must be an absolute path",
      "Pass the colocated jj repo path the revset is evaluated against.",
    );
  }

  const jjBinaryPath = options.jjBinaryPath;
  const workingCopyPath = options.workingCopyPath;
  const bindingStore = options.bindingStore;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
  const injectedRunner = options.runJj;

  // Serialized broker: revset reads are cheap, but every jj invocation chains
  // off the previous one so concurrent callers cannot interleave on the shared
  // op log (mirrors the PR-28 working-copy broker).
  let chain: Promise<void> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const pending = chain.catch(() => undefined).then(fn);
    chain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function run(args: readonly string[]): Promise<RevsetJjRunResult> {
    if (injectedRunner !== undefined) {
      return injectedRunner(args);
    }
    if (!(await pathExists(jjBinaryPath))) {
      throw revError(
        "jj_unavailable",
        `jj binary not found at '${jjBinaryPath}'`,
        "Run host setup (ensureJjCapability) before evaluating revsets.",
      );
    }
    let result: RevsetJjRunResult;
    try {
      result = await runJjBounded(
        jjBinaryPath,
        args,
        workingCopyPath,
        signal,
        timeoutMs,
        maxOutputBytes,
      );
    } catch (error: unknown) {
      throw revError(
        "revset_failed",
        `jj ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
        "Inspect the working copy; rerun host setup if the binary is missing.",
        error,
      );
    }
    if (result.stdout.length > maxOutputBytes || result.stderr.length > maxOutputBytes) {
      throw revError(
        "output_limit",
        `jj ${args.join(" ")} output exceeds the configured limit`,
        "Raise maxOutputBytes or narrow the revset scope.",
      );
    }
    if (result.exitCode !== 0) {
      throw revError(
        "revset_failed",
        `jj ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
        "Inspect the working copy; destroy and recreate it if it is corrupt.",
      );
    }
    return result;
  }

  function execute(query: RevsetQuery): Promise<RevsetResult> {
    return serialized(() => executeQuery(query));
  }

  async function executeQuery(query: RevsetQuery): Promise<RevsetResult> {
    // The binding store is read tree-scoped: a query for one tree can never
    // surface another tree's bindings (acceptance: scoped).
    const treeBindings = await bindingStore.listForTree(query.treeId);

    // Resolve the scope change token (tree-scoped). A scope node that is not
    // bound in THIS tree yields an empty result rather than escaping the tree.
    const treeChangeIds = treeBindings.map((binding) => binding.jjChangeId);
    let scopeBinding: VcsChangeBinding | undefined;
    if (query.scopeNodeId !== undefined) {
      scopeBinding = await bindingStore.getBinding(query.treeId, query.scopeNodeId);
      if (scopeBinding === undefined) {
        return EMPTY_RESULT;
      }
    }
    const expression = buildRevsetExpression(
      query,
      scopeBinding === undefined
        ? { treeChangeIds }
        : { treeChangeIds, scopeChangeId: scopeBinding.jjChangeId },
    );

    const args = ["log", "--no-graph", "-r", expression, "-T", 'change_id ++ "\\n"'];
    const result = await run(args);
    const jjChangeIds = parseChangeIds(result.stdout);
    const jjConfirmed = new Set<string>(jjChangeIds);

    // The binding table is the topology authority; filterBindings recovers the
    // answer from parentChangeId. The live jj answer then confirms each binding
    // is currently in the revset, and any jj change id without a binding is
    // dropped (scoped, fail-closed). The two projections agree on a consistent
    // tree; drift would drop the binding here.
    const filtered = filterBindings(treeBindings, query);
    const finalBindings = filtered.filter((binding) => jjConfirmed.has(binding.jjChangeId));
    return Object.freeze({
      changeIds: finalBindings.map((binding) => binding.jjChangeId),
      bindings: finalBindings,
    });
  }

  async function stackImpactImpl(treeId: TaskTreeId): Promise<readonly NodeImpact[]> {
    const treeBindings = await bindingStore.listForTree(treeId);
    return treeBindings.map((binding) => {
      const descendants = filterBindings(treeBindings, {
        treeId,
        kind: "descendants",
        scopeNodeId: binding.nodeId,
      });
      const descendantNodeIds = descendants
        .filter((descendant) => descendant.nodeId !== binding.nodeId)
        .map((descendant) => descendant.nodeId);
      return Object.freeze({
        nodeId: binding.nodeId,
        changeId: binding.jjChangeId,
        descendantNodeIds: Object.freeze(descendantNodeIds),
        impactedCount: descendants.length - 1,
      });
    });
  }

  async function readyToLandImpl(treeId: TaskTreeId): Promise<readonly NodeReadiness[]> {
    const treeBindings = await bindingStore.listForTree(treeId);
    return treeBindings.map((binding) => {
      const blockers: string[] = [];

      // Gates passed: the node has been pushed on its current commit, i.e. CI
      // and gates ran against exactly this commit (no stale push).
      if (binding.lastPushedCommitId === undefined) {
        blockers.push("not_pushed");
      } else if (binding.lastPushedCommitId !== binding.currentCommitId) {
        blockers.push("pushed_commit_stale");
      }

      // Fresh review: the node was reviewed at its current commit.
      if (binding.lastReviewedCommitId === undefined) {
        blockers.push("not_reviewed");
      } else if (binding.lastReviewedCommitId !== binding.currentCommitId) {
        blockers.push("review_stale");
      }

      // Clean ancestry: the node and every ancestor is conflict-clean and
      // pushed on its current commit (nothing stale or conflicted above).
      if (binding.conflictState !== "clean") {
        blockers.push(`conflict_state_${binding.conflictState}`);
      }
      const ancestors = filterBindings(treeBindings, {
        treeId,
        kind: "ancestors",
        scopeNodeId: binding.nodeId,
      });
      for (const ancestor of ancestors) {
        if (ancestor.nodeId === binding.nodeId) continue;
        if (ancestor.conflictState !== "clean") {
          blockers.push(`ancestor_conflict:${ancestor.nodeId}`);
        }
        if (
          ancestor.lastPushedCommitId === undefined ||
          ancestor.lastPushedCommitId !== ancestor.currentCommitId
        ) {
          blockers.push(`ancestor_not_current:${ancestor.nodeId}`);
        }
      }

      return Object.freeze({
        nodeId: binding.nodeId,
        changeId: binding.jjChangeId,
        ready: blockers.length === 0,
        blockers: Object.freeze(blockers),
      });
    });
  }
  async function reviewHeadersImpl(treeId: TaskTreeId): Promise<readonly ReviewHeader[]> {
    const treeBindings = await bindingStore.listForTree(treeId);
    const headers: ReviewHeader[] = [];
    for (const binding of treeBindings) {
      const base = classifyReviewFreshness(binding);
      if (base !== "needs_interdiff") {
        headers.push(buildReviewHeader(binding, true));
        continue;
      }
      // Commits differ — run jj interdiff to check if content actually changed.
      // `--summary` gives one line per modified file; empty output = ancestry-only.
      const from = binding.lastReviewedCommitId;
      const to = binding.currentCommitId;
      if (from === undefined) {
        headers.push(buildReviewHeader(binding, true));
        continue;
      }
      const result = await run(["interdiff", "--from", from, "--to", to, "--summary"]);
      const interdiffEmpty = result.stdout.trim().length === 0;
      headers.push(buildReviewHeader(binding, interdiffEmpty));
    }
    return Object.freeze(headers);
  }

  return Object.freeze({
    execute,
    stackImpact: (treeId: TaskTreeId) => serialized(() => stackImpactImpl(treeId)),
    reviewHeaders: (treeId: TaskTreeId) => serialized(() => reviewHeadersImpl(treeId)),
    readyToLand: (treeId: TaskTreeId) => serialized(() => readyToLandImpl(treeId)),
  });
}

// -------------------------------------------------------------------------------------------------
// Bounded jj subprocess runner (mirrors the PR-21 / PR-28 bounded runner).
// -------------------------------------------------------------------------------------------------

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 1_048_576;

function runJjBounded(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<RevsetJjRunResult> {
  return new Promise<RevsetJjRunResult>((resolve) => {
    const child = spawn(binaryPath, [...args], {
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

// -------------------------------------------------------------------------------------------------
// Helpers.
// -------------------------------------------------------------------------------------------------

const EMPTY_RESULT: RevsetResult = Object.freeze({ changeIds: [], bindings: [] });

/** Parse non-empty jj change-id lines from `jj log` stdout (deduped, ordered). */
function parseChangeIds(stdout: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    ids.push(line);
  }
  return ids;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function revError(
  code: RevsetErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): RevsetManagerError {
  return new RevsetManagerError(code, message, remediation, cause);
}
