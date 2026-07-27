/**
 * jj compatibility gates (PR 27 / GIT-14).
 *
 * Before a repository is allowed to register against the host-owned colocated jj
 * store, this module probes it for features jj cannot safely replicate: submodules,
 * Git LFS, `.gitattributes`-dependent behaviour, partial clones, linked worktrees,
 * a dirty checkout, and symlink aliases. Every detection uses a REAL git command
 * (or, where git has no command, a direct filesystem read) and emits a typed
 * denial carrying evidence + a remediation. The report also records whether Git
 * hooks are absent — jj ignores hooks, and the host records that fact so a later
 * hooks-bearing checkout can be flagged. Fail-closed: a repository is reported
 * compatible only when every probe is cleanly negative.
 */

import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type JjCompatibilityDenialCode =
  | "submodules_present"
  | "lfs_required"
  | "gitattributes_required"
  | "partial_clone"
  | "linked_worktree"
  | "dirty_checkout"
  | "symlink_alias";

export type JjCompatibilityDenial = Readonly<{
  readonly code: JjCompatibilityDenialCode;
  readonly message: string;
  readonly remediation: string;
  readonly evidence: readonly string[];
}>;

export type JjCompatibilityReport = Readonly<{
  readonly compatible: boolean;
  readonly denials: readonly JjCompatibilityDenial[];
  readonly hooksAbsent: boolean;
}>;

export type JjCompatibilityGateOptions = Readonly<{
  /** Abort the bounded git probes midway. */
  readonly signal?: AbortSignal;
}>;

const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_SUBMODULE_EVIDENCE = 32;
const MAX_DIRTY_EVIDENCE = 32;
const MAX_GITATTRIBUTES_EVIDENCE = 32;

interface GitSoftResult {
  /** Numeric exit code when git ran and exited; `null` when git could not be spawned. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Runs git resolving with a result object (never rejects on a non-zero exit; resolves
 * with `exitCode: null` only when git itself could not be spawned). Detectors inspect
 * the exit code + stderr to distinguish "feature absent" from "command unavailable".
 */
function runGitSoft(
  root: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<GitSoftResult> {
  return new Promise<GitSoftResult>((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        maxBuffer: GIT_MAX_BUFFER,
        killSignal: "SIGKILL",
        shell: false,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const processError = error as NodeJS.ErrnoException & { status?: number | null };
          const numericExit =
            typeof processError.status === "number"
              ? processError.status
              : typeof processError.code === "number"
                ? processError.code
                : null;
          resolve({
            exitCode: numericExit,
            stdout,
            stderr,
          });
          return;
        }
        resolve({ exitCode: 0, stdout, stderr });
      },
    );
  });
}

function denial(
  code: JjCompatibilityDenialCode,
  message: string,
  remediation: string,
  evidence: readonly string[],
): JjCompatibilityDenial {
  return Object.freeze({
    code,
    message,
    remediation,
    evidence: Object.freeze([...evidence]),
  });
}

function nonEmptyLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// -------------------------------------------------------------------------------------------------
// Filesystem probes (no git command exists for these).
// -------------------------------------------------------------------------------------------------

async function detectSymlinkAlias(root: string): Promise<JjCompatibilityDenial | undefined> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    return denial(
      "symlink_alias",
      `repository root '${root}' is a symbolic link`,
      "Register the canonical repository path; jj requires a real directory it owns.",
      [root],
    );
  }
  try {
    const dotGitStat = await lstat(join(root, ".git"));
    if (dotGitStat.isSymbolicLink()) {
      return denial(
        "symlink_alias",
        `repository '.git' at '${root}' is a symbolic link`,
        "Register a repository whose '.git' is a real entry jj can own.",
        [join(root, ".git")],
      );
    }
  } catch (error: unknown) {
    // A missing .git is reported by the other probes / upstream inspector; not a symlink alias.
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
  return undefined;
}

async function detectLinkedWorktree(root: string): Promise<JjCompatibilityDenial | undefined> {
  let dotGitStat;
  try {
    dotGitStat = await lstat(join(root, ".git"));
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
    return undefined;
  }
  if (!dotGitStat.isFile()) {
    return undefined;
  }
  const content = (await readFile(join(root, ".git"), "utf8")).trim();
  if (content.startsWith("gitdir:")) {
    return denial(
      "linked_worktree",
      `repository '${root}' is a linked Git worktree (.git -> ${content})`,
      "Register the main worktree; jj must own the repository's git directory.",
      [content],
    );
  }
  return undefined;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// -------------------------------------------------------------------------------------------------
// Git-backed probes.
// -------------------------------------------------------------------------------------------------

async function detectDirtyCheckout(
  root: string,
  signal: AbortSignal | undefined,
): Promise<JjCompatibilityDenial | undefined> {
  const result = await runGitSoft(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    signal,
  );
  if (result.exitCode !== 0) {
    throw new Error(`git status failed in '${root}': ${result.stderr.trim() || "unknown error"}`);
  }
  const lines = nonEmptyLines(result.stdout);
  if (lines.length === 0) {
    return undefined;
  }
  return denial(
    "dirty_checkout",
    `repository '${root}' has uncommitted or untracked changes`,
    "Commit, stash, or discard changes so the checkout is clean before registering.",
    lines.slice(0, MAX_DIRTY_EVIDENCE),
  );
}

async function detectSubmodules(
  root: string,
  signal: AbortSignal | undefined,
): Promise<JjCompatibilityDenial | undefined> {
  const status = await runGitSoft(root, ["submodule", "status"], signal);
  const paths: string[] = [];
  if (status.exitCode === 0) {
    for (const line of nonEmptyLines(status.stdout)) {
      const path = /^\S+\s+(\S+)/.exec(line)?.[1];
      if (path !== undefined) {
        paths.push(path);
      }
    }
  }
  // Corroborate with .gitmodules: a configured-but-uninitialized submodule still makes the
  // repository jj-incompatible, and `git submodule status` can be empty in that state.
  try {
    const modules = await readFile(join(root, ".gitmodules"), "utf8");
    for (const line of modules.split("\n")) {
      const path = /^\s*path\s*=\s*(\S+)/.exec(line)?.[1];
      if (path !== undefined && !paths.includes(path)) {
        paths.push(path);
      }
    }
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
  if (paths.length === 0) {
    return undefined;
  }
  return denial(
    "submodules_present",
    `repository '${root}' contains Git submodules`,
    "Flatten or remove submodules; jj does not replicate Git submodule behaviour.",
    [...new Set(paths)].sort().slice(0, MAX_SUBMODULE_EVIDENCE),
  );
}

const LFS_ATTRIBUTE_TOKENS: Record<string, true> = {
  "filter=lfs": true,
  "diff=lfs": true,
  "merge=lfs": true,
  "-text": true,
};

interface GitattributesRule {
  readonly pattern: string;
  readonly attributes: readonly string[];
}

function parseGitattributesRules(content: string): readonly GitattributesRule[] {
  const rules: GitattributesRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const tokens = line.split(/\s+/u);
    const pattern = tokens[0];
    const attributes = tokens.slice(1);
    if (pattern === undefined || attributes.length === 0) {
      continue;
    }
    rules.push(Object.freeze({ pattern, attributes: Object.freeze(attributes) }));
  }
  return Object.freeze(rules);
}

async function readGitattributesRules(root: string): Promise<readonly GitattributesRule[]> {
  try {
    const content = await readFile(join(root, ".gitattributes"), "utf8");
    return parseGitattributesRules(content);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
    return [];
  }
}

function isPureLfsRule(rule: GitattributesRule): boolean {
  return rule.attributes.every((attribute) => LFS_ATTRIBUTE_TOKENS[attribute] === true);
}

async function detectLfs(
  root: string,
  signal: AbortSignal | undefined,
): Promise<JjCompatibilityDenial | undefined> {
  // Prefer the real `git lfs ls-files`: it reports tracked files actually present. It does
  // NOT report a `.gitattributes` filter=lfs declaration that has no matching file yet, so a
  // clean exit with zero files does not mean the repository is LFS-free — fall through to the
  // `.gitattributes` check below either way, same as when git-lfs is not installed.
  const lfs = await runGitSoft(root, ["lfs", "ls-files"], signal);
  if (lfs.exitCode === 0) {
    const files = nonEmptyLines(lfs.stdout);
    if (files.length > 0) {
      return denial(
        "lfs_required",
        `repository '${root}' contains Git LFS tracked files`,
        "Remove Git LFS tracking or migrate the files to plain blobs; jj has no LFS smudge/clean.",
        files.slice(0, MAX_DIRTY_EVIDENCE),
      );
    }
  } else if (!/is not a git command/i.test(lfs.stderr)) {
    // A genuine failure to probe — surface it rather than silently allowing the repository.
    throw new Error(
      `git lfs ls-files failed in '${root}': ${lfs.stderr.trim() || "unknown error"}`,
    );
  }
  const rules = await readGitattributesRules(root);
  const lfsRules = rules.filter((rule) => rule.attributes.includes("filter=lfs"));
  if (lfsRules.length === 0) {
    return undefined;
  }
  return denial(
    "lfs_required",
    `repository '${root}' declares Git LFS tracking in .gitattributes`,
    "Remove Git LFS tracking or migrate the files to plain blobs; jj has no LFS smudge/clean.",
    lfsRules.map((rule) => rule.pattern).slice(0, MAX_GITATTRIBUTES_EVIDENCE),
  );
}

async function detectGitattributes(root: string): Promise<JjCompatibilityDenial | undefined> {
  const rules = await readGitattributesRules(root);
  // Pure LFS stanzas are covered by detectLfs; any other attribute rule (line endings,
  // binary detection, merge/diff drivers, working-tree-encoding, …) is jj-incompatible.
  const offending = rules.filter((rule) => !isPureLfsRule(rule));
  if (offending.length === 0) {
    return undefined;
  }
  return denial(
    "gitattributes_required",
    `repository '${root}' declares .gitattributes rules jj does not replicate`,
    "Remove non-LFS .gitattributes rules (text/eol/binary/diff/merge drivers); jj ignores them.",
    offending
      .map((rule) => `${rule.pattern} ${rule.attributes.join(" ")}`)
      .slice(0, MAX_GITATTRIBUTES_EVIDENCE),
  );
}

async function detectPartialClone(
  root: string,
  signal: AbortSignal | undefined,
): Promise<JjCompatibilityDenial | undefined> {
  const shallow = await runGitSoft(root, ["rev-parse", "--is-shallow-repository"], signal);
  const evidence: string[] = [];
  if (shallow.exitCode === 0 && shallow.stdout.trim() === "true") {
    evidence.push("shallow clone");
  } else if (shallow.exitCode !== 0) {
    throw new Error(
      `git rev-parse --is-shallow-repository failed in '${root}': ${shallow.stderr.trim() || "unknown error"}`,
    );
  }
  const promisor = await runGitSoft(root, ["config", "--get", "remote.origin.promisor"], signal);
  if (promisor.exitCode === 0 && promisor.stdout.trim() === "true") {
    evidence.push("promisor/partial remote");
  } else if (promisor.exitCode !== 0 && promisor.exitCode !== 1) {
    // exit 1 is the clean "config unset" case; anything else is a genuine probe failure.
    throw new Error(
      `git config remote.origin.promisor failed in '${root}': ${promisor.stderr.trim() || "unknown error"}`,
    );
  }
  if (evidence.length === 0) {
    return undefined;
  }
  return denial(
    "partial_clone",
    `repository '${root}' is a partial Git clone (${evidence.join(", ")})`,
    "Re-clone the repository fully (no --depth, --single-branch, or filter); jj needs complete history.",
    evidence,
  );
}

async function detectHooksAbsent(root: string, signal: AbortSignal | undefined): Promise<boolean> {
  const path = await runGitSoft(root, ["rev-parse", "--git-path", "hooks"], signal);
  if (path.exitCode !== 0) {
    throw new Error(
      `git rev-parse --git-path hooks failed in '${root}': ${path.stderr.trim() || "unknown error"}`,
    );
  }
  const hooksDirectory = path.stdout.trim();
  if (hooksDirectory.length === 0) {
    return true;
  }
  const directory = isAbsolute(hooksDirectory) ? hooksDirectory : join(root, hooksDirectory);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
    return true;
  }
  // Git ships *.sample stubs and (with jj colocate) a docs.url pointer — neither is a live hook.
  const live = entries.filter((name) => !name.endsWith(".sample") && name !== "docs.url");
  return live.length === 0;
}

// -------------------------------------------------------------------------------------------------
// Public entry point.
// -------------------------------------------------------------------------------------------------

/**
 * Inspect a repository for jj-incompatible features. Returns a fail-closed report: the
 * repository is `compatible` only when every probe is cleanly negative and git hooks are
 * absent. Each `denials` entry carries a typed code, a human message, a remediation, and
 * the evidence (paths / rules / porcelain lines) that triggered it.
 */
export async function checkJjCompatibility(
  repositoryRoot: string,
  options: JjCompatibilityGateOptions = {},
): Promise<JjCompatibilityReport> {
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
    throw new TypeError("repositoryRoot must be an absolute path");
  }
  const signal = options.signal;
  const symlinkAlias = await detectSymlinkAlias(repositoryRoot);
  const linkedWorktree = await detectLinkedWorktree(repositoryRoot);
  const dirtyCheckout = await detectDirtyCheckout(repositoryRoot, signal);
  const submodules = await detectSubmodules(repositoryRoot, signal);
  const lfs = await detectLfs(repositoryRoot, signal);
  const gitattributes = await detectGitattributes(repositoryRoot);
  const partialClone = await detectPartialClone(repositoryRoot, signal);
  const hooksAbsent = await detectHooksAbsent(repositoryRoot, signal);

  const denials: JjCompatibilityDenial[] = [];
  for (const candidate of [
    symlinkAlias,
    linkedWorktree,
    dirtyCheckout,
    submodules,
    lfs,
    gitattributes,
    partialClone,
  ]) {
    if (candidate !== undefined) {
      denials.push(candidate);
    }
  }
  return Object.freeze({
    compatible: denials.length === 0,
    denials: Object.freeze(denials),
    hooksAbsent,
  });
}
