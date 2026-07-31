import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, isAbsolute, relative, sep } from "node:path";

type RepositoryInspectionErrorCode =
  | "invalid_root"
  | "root_unavailable"
  | "not_repository_root"
  | "linked_worktree"
  | "remote_missing"
  | "remote_unsafe"
  | "default_branch_missing"
  | "base_commit_invalid"
  | "case_probe_failed"
  | "inspection_failed";

export type { RepositoryInspectionErrorCode };

export interface RepositoryInspection {
  readonly canonicalRoot: string;
  readonly canonicalRemote: string;
  readonly defaultBranch: string;
  readonly baseCommit: string;
  readonly caseSensitive: boolean;
  readonly submodulePaths: readonly string[];
  readonly lfsPaths: readonly string[];
  readonly nestedRepositoryPaths: readonly string[];
  readonly dirty: boolean;
}

export class RepositoryInspectionError extends Error {
  readonly code: RepositoryInspectionErrorCode;

  constructor(code: RepositoryInspectionErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RepositoryInspectionError";
    this.code = code;
  }
}

interface GitCommandFailureOptions {
  readonly command: readonly string[];
  readonly cause: Error;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | string | undefined;
}

class GitCommandFailure extends Error {
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | string | undefined;

  constructor(options: GitCommandFailureOptions) {
    super(`git ${options.command.join(" ")} failed`, { cause: options.cause });
    this.name = "GitCommandFailure";
    this.command = options.command;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
  }
}

const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const REMOTE_HEAD_PREFIX = "refs/remotes/origin/";

export async function inspectRepository(root: string): Promise<RepositoryInspection> {
  const canonicalRoot = await resolveRoot(root);

  try {
    await verifyRepositoryRoot(canonicalRoot);
    const initialIdentity = await readRepositoryIdentity(canonicalRoot);
    const topLevel = await readTopLevel(canonicalRoot);
    if (topLevel !== canonicalRoot) {
      throw new RepositoryInspectionError(
        "not_repository_root",
        "The supplied path is not the repository top-level directory",
      );
    }

    const remote = await readCanonicalRemote(canonicalRoot);
    const defaultBranch = await readDefaultBranch(canonicalRoot);
    const baseCommit = await readBaseCommit(canonicalRoot, defaultBranch);
    const caseSensitive = await probeCaseSensitivity(canonicalRoot);
    const submodulePaths = await readSubmodulePaths(canonicalRoot);
    const lfsPaths = await readLfsPaths(canonicalRoot);
    const nestedRepositoryPaths = await readNestedRepositoryPaths(canonicalRoot, caseSensitive);
    const initialDirty = await readDirty(canonicalRoot);
    const finalDefaultBranch = await readDefaultBranch(canonicalRoot);
    const finalBaseCommit = await readBaseCommit(canonicalRoot, finalDefaultBranch);
    const finalSubmodulePaths = await readSubmodulePaths(canonicalRoot);
    const finalLfsPaths = await readLfsPaths(canonicalRoot);
    const finalNestedRepositoryPaths = await readNestedRepositoryPaths(
      canonicalRoot,
      caseSensitive,
    );
    const finalRemote = await readCanonicalRemote(canonicalRoot);
    const dirty = await readDirty(canonicalRoot);
    const finalIdentity = await readRepositoryIdentity(canonicalRoot);
    if (
      !sameRepositoryIdentity(initialIdentity, finalIdentity) ||
      remote !== finalRemote ||
      defaultBranch !== finalDefaultBranch ||
      baseCommit !== finalBaseCommit ||
      !samePaths(submodulePaths, finalSubmodulePaths) ||
      !samePaths(lfsPaths, finalLfsPaths) ||
      !samePaths(nestedRepositoryPaths, finalNestedRepositoryPaths) ||
      initialDirty !== dirty
    ) {
      throw new RepositoryInspectionError(
        "inspection_failed",
        "Repository changed while it was being inspected",
      );
    }

    return Object.freeze({
      canonicalRoot,
      canonicalRemote: remote,
      defaultBranch,
      baseCommit,
      caseSensitive,
      submodulePaths: freezePaths(submodulePaths),
      lfsPaths: freezePaths(lfsPaths),
      nestedRepositoryPaths: freezePaths(nestedRepositoryPaths),
      dirty,
    });
  } catch (error: unknown) {
    if (error instanceof RepositoryInspectionError) {
      throw error;
    }
    throw new RepositoryInspectionError("inspection_failed", "Repository inspection failed", error);
  }
}

async function resolveRoot(root: string): Promise<string> {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new RepositoryInspectionError(
      "invalid_root",
      "Repository root must be an absolute path",
      new TypeError("root must be an absolute path"),
    );
  }

  let rootStats;
  try {
    rootStats = await stat(root);
  } catch (error: unknown) {
    throw new RepositoryInspectionError(
      "root_unavailable",
      "Repository root is unavailable",
      error,
    );
  }
  if (!rootStats.isDirectory()) {
    throw new RepositoryInspectionError(
      "invalid_root",
      "Repository root must be a directory",
      new TypeError("root must be a directory"),
    );
  }

  try {
    return await realpath(root);
  } catch (error: unknown) {
    throw new RepositoryInspectionError(
      "root_unavailable",
      "Repository root cannot be canonicalized",
      error,
    );
  }
}

async function verifyRepositoryRoot(root: string): Promise<void> {
  const gitPath = join(root, ".git");
  let metadata;
  try {
    metadata = await lstat(gitPath);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      throw new RepositoryInspectionError(
        "not_repository_root",
        "Repository root has no .git directory",
        error,
      );
    }
    throw new RepositoryInspectionError(
      "root_unavailable",
      "Repository metadata is unavailable",
      error,
    );
  }

  if (metadata.isFile()) {
    throw new RepositoryInspectionError(
      "linked_worktree",
      "Linked worktrees are not admissible repository roots",
    );
  }
  if (!metadata.isDirectory()) {
    throw new RepositoryInspectionError(
      "not_repository_root",
      "Repository root .git entry is not a directory",
    );
  }
}
type RepositoryIdentity = Readonly<{
  rootDevice: number;
  rootInode: number;
  gitDevice: number;
  gitInode: number;
  configDevice: number;
  configInode: number;
  configDigest: string;
}>;

async function readRepositoryIdentity(root: string): Promise<RepositoryIdentity> {
  try {
    const [rootMetadata, gitMetadata] = await Promise.all([stat(root), lstat(join(root, ".git"))]);
    const configPath = join(root, ".git", "config");
    const configMetadata = await lstat(configPath);
    if (
      !rootMetadata.isDirectory() ||
      !gitMetadata.isDirectory() ||
      !configMetadata.isFile() ||
      configMetadata.isSymbolicLink()
    ) {
      throw new TypeError("repository identity no longer names regular metadata");
    }
    const config = await readFile(configPath);
    const verifiedConfigMetadata = await lstat(configPath);
    if (
      configMetadata.dev !== verifiedConfigMetadata.dev ||
      configMetadata.ino !== verifiedConfigMetadata.ino
    ) {
      throw new TypeError("repository config changed while its identity was read");
    }
    return {
      rootDevice: rootMetadata.dev,
      rootInode: rootMetadata.ino,
      gitDevice: gitMetadata.dev,
      gitInode: gitMetadata.ino,
      configDevice: configMetadata.dev,
      configInode: configMetadata.ino,
      configDigest: createHash("sha256").update(config).digest("hex"),
    };
  } catch (error: unknown) {
    throw new RepositoryInspectionError(
      "inspection_failed",
      "Repository identity changed while it was being inspected",
      error,
    );
  }
}

function sameRepositoryIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.rootDevice === right.rootDevice &&
    left.rootInode === right.rootInode &&
    left.gitDevice === right.gitDevice &&
    left.gitInode === right.gitInode &&
    left.configDevice === right.configDevice &&
    left.configInode === right.configInode &&
    left.configDigest === right.configDigest
  );
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

async function readTopLevel(root: string): Promise<string> {
  let output: string;
  try {
    output = await runGit(root, ["rev-parse", "--show-toplevel"]);
  } catch (error: unknown) {
    if (isNotRepositoryFailure(error)) {
      throw new RepositoryInspectionError(
        "not_repository_root",
        "Git does not recognize the repository root",
        error,
      );
    }
    throw new RepositoryInspectionError("inspection_failed", "Git top-level probe failed", error);
  }
  const reported = parseSingleLine(
    output,
    "Git returned an invalid repository top-level path",
    "inspection_failed",
  );
  if (!isAbsolute(reported)) {
    throw new RepositoryInspectionError(
      "inspection_failed",
      "Git returned a non-absolute repository top-level path",
    );
  }
  try {
    return await realpath(reported);
  } catch (error: unknown) {
    throw new RepositoryInspectionError(
      "inspection_failed",
      "Git repository top-level path is unavailable",
      error,
    );
  }
}

async function readCanonicalRemote(root: string): Promise<string> {
  let output: string;
  try {
    output = await runGit(root, ["remote", "get-url", "--all", "origin"]);
  } catch (error: unknown) {
    if (
      error instanceof GitCommandFailure &&
      ((error.exitCode === 1 && error.stderr.length === 0) ||
        (error.exitCode === 2 && /no such remote/i.test(error.stderr)))
    ) {
      throw new RepositoryInspectionError("remote_missing", "Git origin remote is missing", error);
    }
    throw new RepositoryInspectionError(
      "inspection_failed",
      "Git origin remote probe failed",
      error,
    );
  }
  const remote = parseSingleLine(output, "Git origin remote is malformed", "remote_unsafe");
  return canonicalizeRemote(remote);
}

async function readDefaultBranch(root: string): Promise<string> {
  let output: string;
  try {
    output = await runGit(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  } catch (error: unknown) {
    if (error instanceof GitCommandFailure && error.exitCode === 1 && error.stderr.length === 0) {
      throw new RepositoryInspectionError(
        "default_branch_missing",
        "Origin default branch is missing",
        error,
      );
    }
    throw new RepositoryInspectionError(
      "inspection_failed",
      "Git origin default branch probe failed",
      error,
    );
  }

  const reference = parseSingleLine(
    output,
    "Origin default branch reference is malformed",
    "default_branch_missing",
  );
  if (!reference.startsWith(REMOTE_HEAD_PREFIX)) {
    throw new RepositoryInspectionError(
      "default_branch_missing",
      "Origin default branch reference is unsafe",
    );
  }
  const branch = reference.slice(REMOTE_HEAD_PREFIX.length);
  if (!isValidBranchName(branch)) {
    throw new RepositoryInspectionError(
      "default_branch_missing",
      "Origin default branch name is invalid",
    );
  }
  return branch;
}

async function readBaseCommit(root: string, branch: string): Promise<string> {
  const reference = `${REMOTE_HEAD_PREFIX}${branch}^{commit}`;
  let output: string;
  try {
    output = await runGit(root, ["rev-parse", "--verify", "--quiet", reference]);
  } catch (error: unknown) {
    throw new RepositoryInspectionError(
      "base_commit_invalid",
      "Origin default branch commit is unavailable",
      error,
    );
  }
  const commit = parseSingleLine(
    output,
    "Origin default branch commit is malformed",
    "base_commit_invalid",
  );
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new RepositoryInspectionError(
      "base_commit_invalid",
      "Origin default branch did not resolve to a commit",
    );
  }
  return commit;
}

async function probeCaseSensitivity(root: string): Promise<boolean> {
  let probeDirectory: string | undefined;
  let probeFailure: unknown;
  let caseSensitive = false;
  try {
    probeDirectory = await mkdtemp(join(root, ".minions-case-probe-"));
    const upperName = join(probeDirectory, "Aa");
    const lowerName = join(probeDirectory, "aa");
    await writeFile(upperName, "", { flag: "wx" });
    try {
      await stat(lowerName);
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      caseSensitive = true;
    }
  } catch (error: unknown) {
    probeFailure = error;
  } finally {
    if (probeDirectory !== undefined) {
      try {
        await rm(probeDirectory, { force: false, recursive: true });
      } catch (error: unknown) {
        probeFailure ??= error;
      }
    }
  }
  if (probeFailure !== undefined) {
    throw new RepositoryInspectionError(
      "case_probe_failed",
      "Filesystem case-sensitivity probe failed",
      probeFailure,
    );
  }
  return caseSensitive;
}

async function readSubmodulePaths(root: string): Promise<string[]> {
  const output = await requiredGit(
    root,
    ["ls-files", "--stage", "-z"],
    "Git submodule probe failed",
  );
  const paths: string[] = [];
  for (const record of splitNullRecords(output)) {
    const separator = record.indexOf("\t");
    if (separator <= 0) {
      throw new RepositoryInspectionError(
        "inspection_failed",
        "Git submodule probe returned malformed output",
      );
    }
    const mode = record.slice(0, separator).split(" ", 1)[0];
    const path = record.slice(separator + 1);
    if (path.length === 0) {
      throw new RepositoryInspectionError(
        "inspection_failed",
        "Git submodule probe returned an empty path",
      );
    }
    if (mode === "160000") {
      paths.push(path);
    }
  }
  return paths;
}

async function readLfsPaths(root: string): Promise<string[]> {
  const trackedOutput = await requiredGit(
    root,
    ["ls-files", "-z"],
    "Git tracked-file probe failed",
  );
  const trackedPaths = splitNullRecords(trackedOutput);
  const lfsPaths: string[] = [];
  for (let offset = 0; offset < trackedPaths.length; offset += 512) {
    const paths = trackedPaths.slice(offset, offset + 512);
    const output = await requiredGit(
      root,
      ["check-attr", "--cached", "--all", "-z", "--", ...paths],
      "Git LFS attribute probe failed",
    );
    const records = splitNullRecords(output);
    if (records.length % 3 !== 0) {
      throw new RepositoryInspectionError(
        "inspection_failed",
        "Git LFS attribute probe returned malformed output",
      );
    }
    for (let index = 0; index < records.length; index += 3) {
      const path = records[index];
      const attribute = records[index + 1];
      const value = records[index + 2];
      if (path === undefined || attribute === undefined || value === undefined) {
        throw new RepositoryInspectionError(
          "inspection_failed",
          "Git LFS attribute probe returned malformed output",
        );
      }
      if (attribute === "filter" && value === "lfs") {
        lfsPaths.push(path);
      }
    }
  }
  return lfsPaths;
}

async function readNestedRepositoryPaths(root: string, caseSensitive: boolean): Promise<string[]> {
  const nested: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      throw new RepositoryInspectionError(
        "inspection_failed",
        "Nested repository probe failed",
        error,
      );
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (
      directory !== root &&
      hasBareRepositoryShape(entries, caseSensitive) &&
      (await isBareRepositoryDirectory(directory))
    ) {
      nested.push(toRepositoryRelativePath(root, directory));
      return;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      let metadata;
      try {
        metadata = await lstat(entryPath);
      } catch (error: unknown) {
        throw new RepositoryInspectionError(
          "inspection_failed",
          "Nested repository metadata probe failed",
          error,
        );
      }
      if (isGitMetadataName(entry.name, caseSensitive)) {
        if (
          directory !== root &&
          (metadata.isFile() || metadata.isDirectory() || metadata.isSymbolicLink())
        ) {
          nested.push(toRepositoryRelativePath(root, directory));
        }
        continue;
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        continue;
      }
      await visit(entryPath);
    }
  };

  await visit(root);
  return nested;
}
function isGitMetadataName(name: string, caseSensitive: boolean): boolean {
  return name === ".git" || (!caseSensitive && name.toLowerCase() === ".git");
}

function hasBareRepositoryShape(
  entries: readonly {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }[],
  caseSensitive: boolean,
): boolean {
  const named = (expected: string) =>
    entries.find((entry) =>
      caseSensitive ? entry.name === expected : entry.name.toLowerCase() === expected.toLowerCase(),
    );
  return (
    named("HEAD")?.isFile() === true &&
    named("config")?.isFile() === true &&
    named("objects")?.isDirectory() === true &&
    named("refs")?.isDirectory() === true
  );
}

async function isBareRepositoryDirectory(directory: string): Promise<boolean> {
  try {
    return (await runGit(directory, ["rev-parse", "--is-bare-repository"])).trim() === "true";
  } catch (error: unknown) {
    if (error instanceof GitCommandFailure) {
      return false;
    }
    throw error;
  }
}

async function readDirty(root: string): Promise<boolean> {
  const output = await requiredGit(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    "Git dirty-state probe failed",
  );
  return output.length > 0;
}

async function requiredGit(
  root: string,
  args: readonly string[],
  message: string,
): Promise<string> {
  try {
    return await runGit(root, args);
  } catch (error: unknown) {
    throw new RepositoryInspectionError("inspection_failed", message, error);
  }
}

export function canonicalizeRemote(remote: string): string {
  if (
    remote.length === 0 ||
    remote !== remote.trim() ||
    /^[A-Za-z]:[\\/]/.test(remote) ||
    /[\r\n\\?#]/.test(remote)
  ) {
    throw new RepositoryInspectionError(
      "remote_unsafe",
      "Git origin remote is unsafe",
      new TypeError("remote is malformed"),
    );
  }

  const scp = remote.includes("://")
    ? undefined
    : /^(?:(?<username>[^@/:\s]+)@)?(?<host>\[[^\]]+\]|[^:/\s]+):(?<path>.+)$/.exec(remote);
  if (scp?.groups !== undefined) {
    const username = scp.groups["username"];
    const host = scp.groups["host"];
    const rawPath = scp.groups["path"];
    if (
      host === undefined ||
      rawPath === undefined ||
      rawPath.length === 0 ||
      /[\s]/.test(rawPath)
    ) {
      throw new RepositoryInspectionError(
        "remote_unsafe",
        "Git origin remote is unsafe",
        new TypeError("remote is malformed"),
      );
    }
    try {
      const normalizedPath = normalizeRemotePath(rawPath);
      const normalizedHost = normalizeSshHost(host);
      const prefix = username === undefined ? "" : `${username}@`;
      return `ssh://${prefix}${normalizedHost}${normalizedPath}`;
    } catch (error: unknown) {
      throw new RepositoryInspectionError("remote_unsafe", "Git origin remote is unsafe", error);
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch (error: unknown) {
    throw new RepositoryInspectionError("remote_unsafe", "Git origin remote is unsafe", error);
  }

  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "https" && scheme !== "ssh") {
    throw new RepositoryInspectionError("remote_unsafe", "Git origin remote scheme is unsafe");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.password.length > 0) {
    throw new RepositoryInspectionError(
      "remote_unsafe",
      "Git origin remote credentials or suffix are unsafe",
    );
  }
  if (scheme === "https" && parsed.username.length > 0) {
    throw new RepositoryInspectionError("remote_unsafe", "HTTPS origin credentials are unsafe");
  }
  if (parsed.hostname.length === 0 || parsed.host.length === 0) {
    throw new RepositoryInspectionError("remote_unsafe", "Git origin remote host is missing");
  }

  let normalizedPath: string;
  try {
    normalizedPath = normalizeRemotePath(parsed.pathname);
  } catch (error: unknown) {
    throw new RepositoryInspectionError("remote_unsafe", "Git origin remote path is unsafe", error);
  }
  const username = parsed.username.length === 0 ? "" : `${parsed.username}@`;
  return `${scheme}://${username}${parsed.host.toLowerCase()}${normalizedPath}`;
}

function normalizeRemotePath(path: string): string {
  let normalized = path;
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.length === 0 || normalized === "/" || !normalized.startsWith("/")) {
    if (normalized.length === 0) {
      throw new TypeError("remote path is empty");
    }
    normalized = `/${normalized}`;
  }
  if (normalized === "/" || normalized.endsWith("/") || /[\r\n\s]/.test(normalized)) {
    throw new TypeError("remote path is malformed");
  }
  const components = normalized.slice(1).split("/");
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw new TypeError("remote path contains ambiguous components");
  }
  return normalized;
}

function normalizeSshHost(host: string): string {
  if (host.startsWith("[")) {
    if (!host.endsWith("]")) {
      throw new TypeError("SSH host is malformed");
    }
    new URL(`ssh://${host}/repository`);
    return host.toLowerCase();
  }
  if (host.length === 0 || host === "." || host === ".." || /[\s@]/.test(host)) {
    throw new TypeError("SSH host is malformed");
  }
  return host.toLowerCase();
}

export function isValidBranchName(branch: string): boolean {
  if (
    branch.length === 0 ||
    branch === "HEAD" ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    /[~^:?*[\]\\]/.test(branch) ||
    branch === "@" ||
    branch.startsWith("-") ||
    Array.from(branch).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    return false;
  }
  const components = branch.split("/");
  return components.every(
    (component) =>
      component !== "." &&
      component !== ".." &&
      !component.startsWith(".") &&
      !component.endsWith(".") &&
      !component.endsWith(".lock"),
  );
}

function parseSingleLine(
  output: string,
  message: string,
  code: RepositoryInspectionErrorCode,
): string {
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (value.length === 0 || /[\r\n]/.test(value) || value !== value.trim()) {
    throw new RepositoryInspectionError(code, message, new TypeError("Git output is not one line"));
  }
  return value;
}

function splitNullRecords(output: string): string[] {
  const records = output.split("\0");
  if (records.at(-1) === "") {
    records.pop();
  }
  return records;
}

function freezePaths(paths: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(paths)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function toRepositoryRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isNotRepositoryFailure(error: unknown): boolean {
  return (
    error instanceof GitCommandFailure &&
    /not a git repository/i.test(error.stderr) &&
    error.exitCode === 128
  );
}

function runGit(root: string, args: readonly string[]): Promise<string> {
  const command = [...args];
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...command],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        maxBuffer: GIT_MAX_BUFFER,
        killSignal: "SIGKILL",
        shell: false,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = stdout;
        const diagnostics = stderr;
        if (error !== null) {
          const processError = error as NodeJS.ErrnoException & { status?: number | null };
          reject(
            new GitCommandFailure({
              command,
              cause: error,
              stdout: output,
              stderr: diagnostics,
              exitCode:
                typeof processError.status === "number"
                  ? processError.status
                  : typeof processError.code === "number" || typeof processError.code === "string"
                    ? processError.code
                    : undefined,
            }),
          );
          return;
        }
        resolve(output);
      },
    );
  });
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
