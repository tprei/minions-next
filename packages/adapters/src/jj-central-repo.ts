/**
 * Host-owned central colocated jj repository manager (PR 27 / GIT-14, GIT-15).
 *
 * For every registered repository the engine stands up a colocated jj repo in a
 * host-local path it fully owns (`<hostRoot>/<repositoryId>/`). The `.jj` directory
 * is forced owner-only (0o700) so it is never traversable by a node sandbox (GIT-15).
 * `snapshot.auto-track` is locked to `none` (the engine decides what enters the op
 * log — never ambient working-copy drift), the registration operation-log id is
 * recorded (a durable, stable id), and git hooks are asserted absent. A pre-snapshot
 * scan walks the registered checkout for suspicious credential paths and known/shape
 * secrets before any snapshot is taken (SEC-07). The pinned, digest-verified jj binary
 * from PR 21's {@link ensureJjCapability} is the ONLY binary this manager runs.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { Clock, IdGenerator, NonEmptyText, RepositoryId, Timestamp } from "@minions/core";
import { nonEmptyText } from "@minions/core";

import type { Dirent, Stats } from "node:fs";
import { scanForSecrets, type SecretScanHit } from "./secret-redaction.js";

export type JjCentralRepoErrorCode =
  | "invalid_options"
  | "jj_unavailable"
  | "init_failed"
  | "not_colocated"
  | "operation_log_missing"
  | "snapshot_lock_failed"
  | "dirty_checkout"
  | "symlink_alias"
  | "hooks_present"
  | "scan_failed"
  | "filesystem_error";

export class JjCentralRepoError extends Error {
  readonly code: JjCentralRepoErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: JjCentralRepoErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JjCentralRepoError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

export type JjCentralRepo = Readonly<{
  readonly repositoryId: RepositoryId;
  readonly jjRepoPath: string;
  readonly operationLogId: string;
  readonly snapshotTrackingLocked: true;
  readonly hooksAbsent: true;
  readonly bootstrappedAt: Timestamp;
}>;

export type JjPreSnapshotReport = Readonly<{
  readonly scanId: NonEmptyText;
  readonly scannedAt: Timestamp;
  readonly repositoryRoot: string;
  readonly secretHits: readonly SecretScanHit[];
  readonly suspiciousPaths: readonly string[];
}>;

export type JjCentralRepoManagerOptions = Readonly<{
  /** Absolute path to the pinned, digest-verified jj binary (from `ensureJjCapability`). */
  readonly jjBinaryPath: string;
  /** Absolute host-local root under which per-repository jj repos are created. */
  readonly hostRoot: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly signal?: AbortSignal;
}>;

export interface JjCentralRepoManager {
  bootstrap(repositoryRoot: string, repositoryId: RepositoryId): Promise<JjCentralRepo>;
  preSnapshotScan(repositoryRoot: string): Promise<JjPreSnapshotReport>;
}

// -------------------------------------------------------------------------------------------------
// Constants.
// -------------------------------------------------------------------------------------------------

const jjRunTimeoutMs = 30_000;
const maxJjOutputBytes = 1_048_576;
const dotJjMode = 0o700;
const jjRepoMode = 0o700;
const receiptMode = 0o600;
const receiptName = "minions-bootstrap.json";
const receiptSchemaVersion = 1;
const opIdPattern = /^[0-9a-f]{64,}$/u;
const snapshotAutoTrackLockedValue = "none";

const scanMaxFiles = 8_192;
const scanMaxFileBytes = 262_144;

const credentialFileNames: Record<string, true> = {
  ".env": true,
  ".env.local": true,
  ".env.production": true,
  ".env.staging": true,
  ".npmrc": true,
  ".pypirc": true,
  ".netrc": true,
  ".htpasswd": true,
  id_rsa: true,
  id_dsa: true,
  id_ecdsa: true,
  id_ed25519: true,
  credentials: true,
};

const credentialPathFragments = [
  ".aws/credentials",
  ".ssh/",
  ".kube/config",
  ".docker/config.json",
  ".config/gcloud/credentials.db",
];

const credentialSuffixes = [".pem", ".key", ".keystore", ".jks", ".pfx", ".p12"];

interface JjRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface BootstrapReceipt {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly operationLogId: string;
  readonly bootstrappedAt: number;
}

// -------------------------------------------------------------------------------------------------
// Bounded jj subprocess runner (mirrors the PR-21 bounded runner: bounded output, timeout,
// AbortSignal; resolves with exitCode null only when the binary could not be spawned).
// -------------------------------------------------------------------------------------------------

function runJj(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
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
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutLength < maxJjOutputBytes) {
        stdoutChunks.push(chunk);
        stdoutLength += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrLength < maxJjOutputBytes) {
        stderrChunks.push(chunk);
        stderrLength += chunk.length;
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, jjRunTimeoutMs);
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

function centralError(
  code: JjCentralRepoErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): JjCentralRepoError {
  return new JjCentralRepoError(code, message, remediation, cause);
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

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// -------------------------------------------------------------------------------------------------
// Bootstrap internals.
// -------------------------------------------------------------------------------------------------

async function enforceDotJjPermissions(dotJjPath: string): Promise<void> {
  try {
    await chmod(dotJjPath, dotJjMode);
    const mode = (await stat(dotJjPath)).mode & 0o777;
    if (mode !== dotJjMode) {
      throw centralError(
        "filesystem_error",
        `.jj directory at '${dotJjPath}' has mode ${mode.toString(8)} (expected ${dotJjMode.toString(8)})`,
        "Ensure the host tools directory is owned by the engine and not group/other-writable.",
      );
    }
  } catch (error: unknown) {
    if (error instanceof JjCentralRepoError) {
      throw error;
    }
    throw centralError(
      "filesystem_error",
      `could not enforce owner-only permissions on '${dotJjPath}': ${errorToString(error)}`,
      "Ensure the host tools directory is writable by the engine and rerun registration.",
      error,
    );
  }
}

async function lockSnapshotAutoTrack(
  jjBinaryPath: string,
  jjRepoPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const set = await runJj(
    jjBinaryPath,
    ["config", "set", "--repo", "snapshot.auto-track", snapshotAutoTrackLockedValue],
    jjRepoPath,
    signal,
  );
  if (set.exitCode !== 0) {
    throw centralError(
      "snapshot_lock_failed",
      `jj config set snapshot.auto-track failed in '${jjRepoPath}': ${set.stderr.trim() || "unknown error"}`,
      "Inspect the host-owned jj repo; remove it and rerun registration if it is corrupt.",
    );
  }
  const get = await runJj(
    jjBinaryPath,
    ["config", "get", "--repository", ".", "snapshot.auto-track"],
    jjRepoPath,
    signal,
  );
  if (get.exitCode !== 0 || get.stdout.trim() !== snapshotAutoTrackLockedValue) {
    throw centralError(
      "snapshot_lock_failed",
      `snapshot.auto-track lock verification failed in '${jjRepoPath}' (got '${get.stdout.trim()}')`,
      "Inspect the host-owned jj repo; remove it and rerun registration if it is corrupt.",
    );
  }
}

async function readOperationLogId(
  jjBinaryPath: string,
  jjRepoPath: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const op = await runJj(
    jjBinaryPath,
    ["op", "log", "--no-graph", "--limit", "1", "-T", 'id ++ "\n"'],
    jjRepoPath,
    signal,
  );
  if (op.exitCode !== 0) {
    throw centralError(
      "operation_log_missing",
      `jj op log failed in '${jjRepoPath}': ${op.stderr.trim() || "unknown error"}`,
      "Inspect the host-owned jj repo; remove it and rerun registration if it is corrupt.",
    );
  }
  const id = op.stdout.split("\n", 1)[0]?.trim() ?? "";
  if (!opIdPattern.test(id)) {
    throw centralError(
      "operation_log_missing",
      `could not parse a durable operation-log id in '${jjRepoPath}'`,
      "Inspect the host-owned jj repo; remove it and rerun registration if it is corrupt.",
    );
  }
  return id;
}

async function assertHooksAbsent(jjRepoPath: string): Promise<void> {
  const hooksDirectory = join(jjRepoPath, ".git", "hooks");
  let entries: string[];
  try {
    entries = await readdir(hooksDirectory);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw centralError(
      "filesystem_error",
      `could not read hooks directory '${hooksDirectory}': ${errorToString(error)}`,
      "Inspect the host-owned jj repo; remove it and rerun registration if it is corrupt.",
      error,
    );
  }
  // Git ships *.sample stubs and (with jj colocate) a docs.url pointer — neither is a live hook.
  const live = entries.filter((name) => !name.endsWith(".sample") && name !== "docs.url");
  if (live.length > 0) {
    throw centralError(
      "hooks_present",
      `host-owned jj repo at '${jjRepoPath}' has live git hooks: ${live.join(", ")}`,
      "Remove the unexpected hooks from the host-owned jj repo before registering.",
    );
  }
}

async function readReceiptOptional(path: string): Promise<BootstrapReceipt | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== receiptSchemaVersion ||
    typeof (parsed as { operationLogId?: unknown }).operationLogId !== "string" ||
    typeof (parsed as { repositoryId?: unknown }).repositoryId !== "string" ||
    typeof (parsed as { bootstrappedAt?: unknown }).bootstrappedAt !== "number"
  ) {
    return undefined;
  }
  const receipt = parsed as BootstrapReceipt;
  if (!opIdPattern.test(receipt.operationLogId)) {
    return undefined;
  }
  return receipt;
}

async function writeReceipt(path: string, receipt: BootstrapReceipt): Promise<void> {
  await writeFile(path, JSON.stringify(receipt), { mode: receiptMode });
  await chmod(path, receiptMode);
}

async function finalizeBootstrap(
  context: BootstrapContext,
  repositoryId: RepositoryId,
  jjRepoPath: string,
): Promise<JjCentralRepo> {
  const dotJjPath = join(jjRepoPath, ".jj");
  await enforceDotJjPermissions(dotJjPath);
  await lockSnapshotAutoTrack(context.jjBinaryPath, jjRepoPath, context.signal);
  const operationLogId = await readOperationLogId(context.jjBinaryPath, jjRepoPath, context.signal);
  await assertHooksAbsent(jjRepoPath);
  const bootstrappedAt = context.clock.now();
  const receipt: BootstrapReceipt = {
    schemaVersion: receiptSchemaVersion,
    repositoryId,
    operationLogId,
    bootstrappedAt,
  };
  await writeReceipt(join(dotJjPath, receiptName), receipt);
  return Object.freeze({
    repositoryId,
    jjRepoPath,
    operationLogId,
    snapshotTrackingLocked: true as const,
    hooksAbsent: true as const,
    bootstrappedAt,
  });
}

interface BootstrapContext {
  readonly jjBinaryPath: string;
  readonly clock: Clock;
  readonly signal: AbortSignal | undefined;
}

// -------------------------------------------------------------------------------------------------
// Pre-snapshot scan internals.
// -------------------------------------------------------------------------------------------------

interface ScannedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

function toRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function isSuspiciousCredentialPath(relativePath: string): boolean {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  if (credentialFileNames[base] === true) {
    return true;
  }
  if (credentialSuffixes.some((suffix) => base.endsWith(suffix))) {
    return true;
  }
  return credentialPathFragments.some((fragment) => relativePath.includes(fragment));
}

async function walkFiles(root: string): Promise<readonly ScannedFile[]> {
  const collected: ScannedFile[] = [];
  async function recurse(directory: string): Promise<void> {
    if (collected.length >= scanMaxFiles) {
      return;
    }
    let entries: readonly Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= scanMaxFiles) {
        return;
      }
      // Never descend into the registered checkout's git metadata.
      if (entry.name === ".git") {
        continue;
      }
      const absolutePath = join(directory, entry.name);
      const isSymlink = entry.isSymbolicLink();
      if (entry.isDirectory() && !isSymlink) {
        await recurse(absolutePath);
        continue;
      }
      if (entry.isFile() && !isSymlink) {
        collected.push({
          relativePath: toRelativePath(root, absolutePath),
          absolutePath,
        });
      }
    }
  }
  await recurse(root);
  return Object.freeze(collected);
}

async function readBoundedContent(path: string): Promise<string | undefined> {
  let handleStats: Stats;
  try {
    handleStats = await stat(path);
  } catch {
    return undefined;
  }
  if (!handleStats.isFile() || handleStats.size > scanMaxFileBytes) {
    return undefined;
  }
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------------------------------------
// Factory.
// -------------------------------------------------------------------------------------------------

/**
 * Create a host-owned central colocated jj repository manager. The manager creates
 * (idempotently) a colocated jj repo per registered repository under `hostRoot`, keeps
 * `.jj` owner-only, locks `snapshot.auto-track`, records the durable operation-log id,
 * and runs a pre-snapshot credential + secret scan.
 */
export function createJjCentralRepoManager(
  options: JjCentralRepoManagerOptions,
): JjCentralRepoManager {
  if (
    typeof options.jjBinaryPath !== "string" ||
    !isAbsolute(options.jjBinaryPath) ||
    options.jjBinaryPath.length === 0
  ) {
    throw centralError(
      "invalid_options",
      "jjBinaryPath must be an absolute path",
      "Pass the binaryPath from an available ensureJjCapability probe.",
    );
  }
  if (
    typeof options.hostRoot !== "string" ||
    !isAbsolute(options.hostRoot) ||
    options.hostRoot.length === 0
  ) {
    throw centralError(
      "invalid_options",
      "hostRoot must be an absolute path",
      "Configure an absolute host-local root owned by the engine.",
    );
  }
  const jjBinaryPath = options.jjBinaryPath;
  const hostRoot = options.hostRoot;
  const clock = options.clock;
  const ids = options.ids;
  const signal = options.signal;

  const context: BootstrapContext = { jjBinaryPath, clock, signal };

  return {
    async bootstrap(repositoryRoot: string, repositoryId: RepositoryId): Promise<JjCentralRepo> {
      if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
        throw centralError(
          "invalid_options",
          "repositoryRoot must be an absolute path",
          "Register the canonical repository path.",
        );
      }
      const jjRepoPath = join(hostRoot, repositoryId);
      const dotJjPath = join(jjRepoPath, ".jj");
      const receiptPath = join(dotJjPath, receiptName);

      const binaryReady = await pathExists(jjBinaryPath);
      if (!binaryReady) {
        throw centralError(
          "jj_unavailable",
          `jj binary not found at '${jjBinaryPath}'`,
          "Run host setup (ensureJjCapability) before registering repositories.",
        );
      }

      if (await pathExists(dotJjPath)) {
        const stored = await readReceiptOptional(receiptPath);
        if (stored !== undefined) {
          if (stored.repositoryId !== repositoryId) {
            throw centralError(
              "filesystem_error",
              `host jj repo at '${jjRepoPath}' is receipted for a different repository`,
              "Remove the stale host-owned jj repo and rerun registration.",
            );
          }
          await enforceDotJjPermissions(dotJjPath);
          return Object.freeze({
            repositoryId,
            jjRepoPath,
            operationLogId: stored.operationLogId,
            snapshotTrackingLocked: true as const,
            hooksAbsent: true as const,
            bootstrappedAt: stored.bootstrappedAt as Timestamp,
          });
        }
        // Partial bootstrap: the colocated repo exists but no receipt was recorded.
        return finalizeBootstrap(context, repositoryId, jjRepoPath);
      }

      try {
        await mkdir(jjRepoPath, { recursive: true, mode: jjRepoMode });
        await chmod(jjRepoPath, jjRepoMode);
      } catch (error: unknown) {
        throw centralError(
          "filesystem_error",
          `could not create host jj repo directory '${jjRepoPath}': ${errorToString(error)}`,
          "Ensure the host root is writable by the engine and rerun registration.",
          error,
        );
      }

      const init = await runJj(jjBinaryPath, ["git", "init", "--colocate"], jjRepoPath, signal);
      if (init.exitCode !== 0) {
        throw centralError(
          "init_failed",
          `jj git init --colocate failed in '${jjRepoPath}': ${init.stderr.trim() || "unknown error"}`,
          "Inspect the host-owned jj repo; remove it and rerun registration if it is corrupt.",
        );
      }
      const colocated =
        (await pathExists(dotJjPath)) && (await pathExists(join(jjRepoPath, ".git")));
      if (!colocated) {
        throw centralError(
          "not_colocated",
          `jj git init --colocate did not produce both .jj and .git in '${jjRepoPath}'`,
          "Inspect the host-owned jj repo; remove it and rerun registration if it is corrupt.",
        );
      }
      return finalizeBootstrap(context, repositoryId, jjRepoPath);
    },

    async preSnapshotScan(repositoryRoot: string): Promise<JjPreSnapshotReport> {
      if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
        throw centralError(
          "invalid_options",
          "repositoryRoot must be an absolute path",
          "Scan the canonical repository path.",
        );
      }
      let exists: boolean;
      try {
        exists = (await stat(repositoryRoot)).isDirectory();
      } catch (error: unknown) {
        throw centralError(
          "scan_failed",
          `repository root '${repositoryRoot}' is not accessible: ${errorToString(error)}`,
          "Ensure the registered checkout exists and is readable.",
          error,
        );
      }
      if (!exists) {
        throw centralError(
          "scan_failed",
          `repository root '${repositoryRoot}' is not a directory`,
          "Ensure the registered checkout exists and is readable.",
        );
      }
      const files = await walkFiles(repositoryRoot);
      const suspiciousPaths: string[] = [];
      for (const file of files) {
        if (isSuspiciousCredentialPath(file.relativePath)) {
          suspiciousPaths.push(file.relativePath);
        }
      }
      const secretHits: SecretScanHit[] = [];
      for (const file of files) {
        const content = await readBoundedContent(file.absolutePath);
        if (content === undefined) {
          continue;
        }
        const hits = scanForSecrets([{ kind: "workspace", label: file.relativePath, content }]);
        for (const hit of hits) {
          secretHits.push(hit);
        }
      }
      return Object.freeze({
        scanId: nonEmptyText(ids.nextId(), "pre-snapshot scan id"),
        scannedAt: clock.now(),
        repositoryRoot,
        secretHits: Object.freeze(secretHits),
        suspiciousPaths: Object.freeze([...new Set(suspiciousPaths)].sort()),
      });
    },
  };
}
