/**
 * Engine-managed Jujutsu (jj) capability probe (PR 21 / GIT-14).
 *
 * The product VCS engine MUST run on a pinned, per-host `jj` binary that the engine itself
 * downloads, digest-verifies, and capability-probes. This module is the single source of truth
 * for that lifecycle: it selects the release asset for the host platform/arch, downloads the
 * archive with a streaming sha256 (honouring an AbortSignal), verifies the digest against a
 * pinned value (fail-closed on mismatch — a tampered archive is never extracted or run),
 * extracts the `jj` binary owner-only into a host-local tools directory, probes `--version`
 * (must equal the pin) plus a real capability handshake in a throwaway repo, and re-verifies
 * the on-disk binary digest on every probe so that a tampered binary is rejected before it can
 * execute. There is NO fallback to a system `jj` on PATH: the engine only ever runs the binary
 * it installed and verified. Mirrors the PR-18 OMP pinning pattern (bounded subprocess runner,
 * strict validation, typed remediation) with an added download + digest layer.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { contentHash, type ContentHash } from "@minions/core";

export const PINNED_JJ_VERSION = "0.43.0";

/**
 * Pinned sha256 digests of the official `jj` release archives (the compressed `.tar.gz` assets,
 * NOT the extracted binary). Fetched verbatim from the jj-vcs/jj v0.43.0 release manifest. The
 * archive digest is verified before extraction; the extracted binary gets its own recorded
 * digest that is re-verified on every probe.
 */
const JJ_RELEASE_BASE_URL = `https://github.com/jj-vcs/jj/releases/download/v${PINNED_JJ_VERSION}`;

interface JjReleaseAsset {
  readonly asset: string;
  readonly digest: string;
}

const JJ_RELEASE_ASSETS: Readonly<Record<string, JjReleaseAsset>> = {
  // key = `${platform}-${arch}` (Node values: platform in {linux,darwin}, arch in {x64,arm64})
  "linux-x64": {
    asset: "jj-v0.43.0-x86_64-unknown-linux-musl.tar.gz",
    digest: "59e5588583ac82b623239929368c65b90735931c0f26b5a16c1f04d5bb97643d",
  },
  "linux-arm64": {
    asset: "jj-v0.43.0-aarch64-unknown-linux-musl.tar.gz",
    digest: "289197b6bec60b4e57d47260624b617716f737eb02cdfd9155791b2576aa5862",
  },
  "darwin-x64": {
    asset: "jj-v0.43.0-x86_64-apple-darwin.tar.gz",
    digest: "f1a7fec046b816132318c07a9c096680f7aae78b008709c7166a57efd9c579ec",
  },
  "darwin-arm64": {
    asset: "jj-v0.43.0-aarch64-apple-darwin.tar.gz",
    digest: "84336bbe5673a36ccc6395c494021ba632794da078eb8c8c513a60f8e1cc3083",
  },
};

export type JjCapabilityErrorCode =
  | "invalid_options"
  | "download_failed"
  | "digest_mismatch"
  | "extract_failed"
  | "version_mismatch"
  | "capability_missing"
  | "probe_failed"
  | "filesystem_error"
  | "corrupt_binary";

export class JjCapabilityError extends Error {
  readonly code: JjCapabilityErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: JjCapabilityErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JjCapabilityError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

export type JjCapabilities = Readonly<{
  /** `jj git init --colocate` created a working copy in a throwaway repo (git backend + work). */
  workingCopy: boolean;
  /** `jj op log` produced the operation log (the op-log subsystem is present and functional). */
  oplog: boolean;
  /** `jj absorb --help` exited 0 (the absorb command ships in this build). */
  absorb: boolean;
  /** Conflict markers are supported (working copy + op log functional; markers are intrinsic). */
  conflictMarker: boolean;
}>;

export type JjCapabilityProbe =
  | Readonly<{
      available: true;
      version: string;
      binaryPath: string;
      digest: ContentHash;
      capabilities: JjCapabilities;
    }>
  | Readonly<{
      available: false;
      failureCode: JjCapabilityErrorCode;
      message: string;
      remediation: string;
    }>;

export type JjCapabilityOptions = Readonly<{
  /** Absolute host-local directory the engine owns; the binary lands in `<dir>/jj-<version>/jj`. */
  toolsDirectory: string;
  /** Override the pinned version (default {@link PINNED_JJ_VERSION}); the probe compares to this. */
  expectedVersion?: string;
  /** Override the pinned archive digest (the .tar.gz sha256 verified before extraction). */
  expectedDigest?: string;
  /** Override `process.platform` for asset selection / diagnostics. */
  platformOverride?: string;
  /** Override `process.arch` for asset selection / diagnostics. */
  archOverride?: string;
  /** Aborts an in-flight download (streamed into the underlying fetch). */
  signal?: AbortSignal;
}>;

const versionPattern = /^\d+\.\d+\.\d+$/u;
const contentHashPattern = /^[0-9a-f]{64}$/u;
const jjVersionLinePattern = /^jj\s+(\d+\.\d+\.\d+)(?:-[0-9a-fA-F]+)?\s*$/u;
const toolsDirectoryMode = 0o700;
const binaryMode = 0o500;
const manifestMode = 0o600;
const manifestSchemaVersion = 1;
const probeTimeoutMs = 15_000;
const maxProbeOutputBytes = 1_048_576;
const readChunkBytes = 64 * 1024;

interface ValidatedOptions {
  readonly toolsDirectory: string;
  readonly version: string;
  readonly expectedArchiveDigest: string;
  readonly downloadUrl: string;
  readonly signal: AbortSignal | undefined;
}

interface JjInstallManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly archiveDigest: string;
  readonly binaryDigest: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorToString(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

function jjError(
  code: JjCapabilityErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): JjCapabilityError {
  return new JjCapabilityError(code, message, remediation, cause);
}

// -------------------------------------------------------------------------------------------------
// Options validation + asset selection.
// -------------------------------------------------------------------------------------------------

function validateOptions(options: JjCapabilityOptions): ValidatedOptions {
  if (
    typeof options.toolsDirectory !== "string" ||
    !isAbsolute(options.toolsDirectory) ||
    basename(options.toolsDirectory).length === 0
  ) {
    throw jjError(
      "invalid_options",
      "toolsDirectory must be an absolute path",
      "Configure an absolute host-local tools directory owned by the engine.",
    );
  }
  const version = options.expectedVersion ?? PINNED_JJ_VERSION;
  if (!versionPattern.test(version)) {
    throw jjError(
      "invalid_options",
      "expectedVersion must be a semantic version (x.y.z)",
      "Configure the exact pinned jj version.",
    );
  }
  const platform = options.platformOverride ?? process.platform;
  const arch = options.archOverride ?? process.arch;
  const asset = JJ_RELEASE_ASSETS[`${platform}-${arch}`];
  if (asset === undefined) {
    throw jjError(
      "invalid_options",
      `no jj release asset is pinned for platform '${platform}' / arch '${arch}'`,
      "Run on a supported platform (linux/darwin x64/arm64) or supply platformOverride/archOverride.",
    );
  }
  const expectedArchiveDigest = options.expectedDigest ?? asset.digest;
  if (!contentHashPattern.test(expectedArchiveDigest)) {
    throw jjError(
      "invalid_options",
      "expectedDigest must be a 64-character lowercase-hex sha256",
      "Provide a valid pinned archive sha256 or omit it to use the shipped pin.",
    );
  }
  return {
    toolsDirectory: options.toolsDirectory,
    version,
    expectedArchiveDigest,
    downloadUrl: `${JJ_RELEASE_BASE_URL}/${asset.asset}`,
    signal: options.signal,
  };
}

// -------------------------------------------------------------------------------------------------
// Streaming download + digest verification.
// -------------------------------------------------------------------------------------------------

async function downloadArchive(
  url: string,
  expectedDigest: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: signal ?? null, redirect: "follow" });
  } catch (error) {
    throw jjError(
      "download_failed",
      `jj archive download failed: ${errorToString(error)}`,
      "Check host network access to GitHub and rerun host setup.",
      error,
    );
  }
  if (!response.ok || response.body === null) {
    throw jjError(
      "download_failed",
      `jj archive download returned HTTP ${String(response.status)}`,
      "Verify the pinned jj release asset exists and rerun host setup.",
    );
  }
  const hasher = createHash("sha256");
  const chunks: Uint8Array[] = [];
  try {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        hasher.update(value);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    throw jjError(
      "download_failed",
      `jj archive download stream failed: ${errorToString(error)}`,
      "Check host network stability and rerun host setup.",
      error,
    );
  }
  const archive = Buffer.concat(chunks);
  const digest = hasher.digest("hex");
  if (digest !== expectedDigest) {
    throw jjError(
      "digest_mismatch",
      `jj archive sha256 ${digest} does not match the pinned digest ${expectedDigest}`,
      "The downloaded jj release does not match the pinned digest; rerun host setup or update the pin.",
    );
  }
  return archive;
}

// -------------------------------------------------------------------------------------------------
// Strict USTAR extraction of the single `jj` binary.
//
// The adapters package has zero runtime tar dependencies by design, and the jj release archive is
// a plain GNU tar containing one regular `jj` member (plus README/LICENSE). A minimal, strict
// parser is owner-controlled and avoids pulling in a dependency for a single-file extraction.
// Security: only regular files are considered, the output path is fixed by the engine (the tar's
// name is never used to choose the destination), and symlinks/directories are skipped.
// -------------------------------------------------------------------------------------------------

function readTarString(buffer: Buffer, start: number, length: number): string {
  return buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/u, "");
}

function readTarOctal(buffer: Buffer, start: number, length: number): number {
  const text = readTarString(buffer, start, length).trim();
  if (text.length === 0) {
    return 0;
  }
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function extractJjBinary(archive: Buffer): Buffer {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch (error) {
    throw jjError(
      "extract_failed",
      `jj archive is not valid gzip: ${errorToString(error)}`,
      "Re-download the pinned jj release; the archive is malformed.",
      error,
    );
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = readTarOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0x30);
    offset += 512;
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const member = fullName.split("/").pop() ?? "";
    const dataLength = Math.ceil(size / 512) * 512;
    if ((typeflag === "0" || typeflag === "\0") && member === "jj") {
      return Buffer.from(tar.subarray(offset, offset + size));
    }
    offset += dataLength;
  }
  throw jjError(
    "extract_failed",
    "jj release archive contains no regular 'jj' member",
    "Re-download the pinned jj release; the archive is malformed.",
  );
}

// -------------------------------------------------------------------------------------------------
// Install manifest (records version + archive digest + the extracted binary digest).
// -------------------------------------------------------------------------------------------------

function parseManifest(raw: string): JjInstallManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["schemaVersion"] !== manifestSchemaVersion) {
    return undefined;
  }
  const version = value["version"];
  const archiveDigest = value["archiveDigest"];
  const binaryDigest = value["binaryDigest"];
  if (typeof version !== "string" || !versionPattern.test(version)) {
    return undefined;
  }
  if (typeof archiveDigest !== "string" || !contentHashPattern.test(archiveDigest)) {
    return undefined;
  }
  if (typeof binaryDigest !== "string" || !contentHashPattern.test(binaryDigest)) {
    return undefined;
  }
  return { schemaVersion: manifestSchemaVersion, version, archiveDigest, binaryDigest };
}

async function readManifestOptional(path: string): Promise<JjInstallManifest | undefined> {
  try {
    return parseManifest(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeManifest(path: string, manifest: JjInstallManifest): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest), { mode: manifestMode });
  await chmod(temporary, manifestMode);
  await rename(temporary, path);
}

// -------------------------------------------------------------------------------------------------
// Bounded subprocess runner (mirrors the PR-18 OMP runner: bounded output, timeout, AbortSignal).
// -------------------------------------------------------------------------------------------------

interface BoundedRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runBounded(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<BoundedRunResult> {
  return new Promise<BoundedRunResult>((resolve, reject) => {
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
      if (stdoutLength < maxProbeOutputBytes) {
        stdoutChunks.push(chunk);
        stdoutLength += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrLength < maxProbeOutputBytes) {
        stderrChunks.push(chunk);
        stderrLength += chunk.length;
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, probeTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

// -------------------------------------------------------------------------------------------------
// Version probe + capability handshake.
// -------------------------------------------------------------------------------------------------

function parseJjVersion(stdout: string, expectedVersion: string): string {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) {
    throw jjError(
      "version_mismatch",
      "jj --version produced no output",
      "Reinstall the pinned jj runtime into the host tools directory.",
    );
  }
  const match = jjVersionLinePattern.exec(line);
  const version = match?.[1];
  if (version === undefined) {
    throw jjError(
      "version_mismatch",
      `jj --version output is unparseable: ${JSON.stringify(line)}`,
      "Reinstall the pinned jj runtime into the host tools directory.",
    );
  }
  if (version !== expectedVersion) {
    throw jjError(
      "version_mismatch",
      `jj --version reports ${version}, expected ${expectedVersion}`,
      `Install the pinned jj ${expectedVersion} runtime before starting any node.`,
    );
  }
  return version;
}

async function probeVersion(
  binaryPath: string,
  cwd: string,
  expectedVersion: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let result: BoundedRunResult;
  try {
    result = await runBounded(binaryPath, ["--version"], cwd, signal);
  } catch (error) {
    throw jjError(
      "probe_failed",
      `jj --version failed to execute: ${errorToString(error)}`,
      "Reinstall the pinned jj runtime into the host tools directory.",
      error,
    );
  }
  if (result.exitCode !== 0) {
    throw jjError(
      "probe_failed",
      `jj --version exited with code ${String(result.exitCode ?? "null")}${result.stderr.length > 0 ? `: ${result.stderr.trim()}` : ""}`,
      "Reinstall the pinned jj runtime into the host tools directory.",
    );
  }
  return parseJjVersion(result.stdout, expectedVersion);
}

async function probeCapabilities(
  binaryPath: string,
  signal: AbortSignal | undefined,
): Promise<JjCapabilities> {
  let workingCopy: boolean;
  let oplog = false;
  let absorb: boolean;
  const scratch = await mkdtemp(join(tmpdir(), "jj-capability-"));
  try {
    let init: BoundedRunResult;
    try {
      init = await runBounded(binaryPath, ["git", "init", "--colocate"], scratch, signal);
    } catch {
      init = { exitCode: null, stdout: "", stderr: "" };
    }
    workingCopy = init.exitCode === 0;
    if (workingCopy) {
      let op: BoundedRunResult;
      try {
        op = await runBounded(binaryPath, ["op", "log"], scratch, signal);
      } catch {
        op = { exitCode: null, stdout: "", stderr: "" };
      }
      oplog = op.exitCode === 0;
    }
    let absorbHelp: BoundedRunResult;
    try {
      absorbHelp = await runBounded(binaryPath, ["absorb", "--help"], scratch, signal);
    } catch {
      absorbHelp = { exitCode: null, stdout: "", stderr: "" };
    }
    absorb = absorbHelp.exitCode === 0;
    const conflictMarker = workingCopy && oplog;
    return Object.freeze({ workingCopy, oplog, absorb, conflictMarker });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------------
// On-disk digest helpers.
// -------------------------------------------------------------------------------------------------

async function hashFile(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hasher = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: readChunkBytes });
    stream.on("data", (chunk) => {
      hasher.update(chunk);
    });
    stream.once("end", () => {
      resolve(hasher.digest("hex"));
    });
    stream.once("error", reject);
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// Capability acquisition.
// -------------------------------------------------------------------------------------------------

async function acquireFreshInstall(
  validated: ValidatedOptions,
  versionDir: string,
  binaryPath: string,
  manifestPath: string,
): Promise<JjInstallManifest> {
  const archive = await downloadArchive(
    validated.downloadUrl,
    validated.expectedArchiveDigest,
    validated.signal,
  );
  const binary = extractJjBinary(archive);
  const temporaryBinary = join(versionDir, ".jj.download.tmp");
  await writeFile(temporaryBinary, binary, { mode: binaryMode });
  await chmod(temporaryBinary, binaryMode);
  await rename(temporaryBinary, binaryPath);
  await chmod(binaryPath, binaryMode);
  const manifest: JjInstallManifest = {
    schemaVersion: manifestSchemaVersion,
    version: validated.version,
    archiveDigest: validated.expectedArchiveDigest,
    binaryDigest: createHash("sha256").update(binary).digest("hex"),
  };
  await writeManifest(manifestPath, manifest);
  return manifest;
}

async function runEnsure(validated: ValidatedOptions): Promise<JjCapabilityProbe> {
  const versionDir = join(validated.toolsDirectory, `jj-${validated.version}`);
  const binaryPath = join(versionDir, "jj");
  const manifestPath = join(versionDir, "manifest.json");

  await mkdir(validated.toolsDirectory, { recursive: true, mode: toolsDirectoryMode });
  await chmod(validated.toolsDirectory, toolsDirectoryMode);
  await mkdir(versionDir, { recursive: true, mode: toolsDirectoryMode });
  await chmod(versionDir, toolsDirectoryMode);

  let manifest = await readManifestOptional(manifestPath);
  let cacheHit = false;
  if (manifest !== undefined) {
    const manifestMatchesPin =
      manifest.version === validated.version &&
      manifest.archiveDigest === validated.expectedArchiveDigest;
    if (manifestMatchesPin && (await fileExists(binaryPath))) {
      // Cached install for the exact pinned version+digest. Verify the on-disk binary has not
      // been tampered with: its current digest must equal the digest recorded at extraction.
      // A mismatch is corruption, never a silent re-download.
      const onDisk = await hashFile(binaryPath);
      if (onDisk !== manifest.binaryDigest) {
        throw jjError(
          "corrupt_binary",
          `jj binary at ${binaryPath} has digest ${onDisk} but the install recorded ${manifest.binaryDigest}`,
          "The installed jj binary was modified or is corrupt; remove it and rerun host setup.",
        );
      }
      cacheHit = true;
    }
  }
  if (!cacheHit) {
    manifest = await acquireFreshInstall(validated, versionDir, binaryPath, manifestPath);
  }
  if (manifest === undefined) {
    throw jjError(
      "filesystem_error",
      "jj install manifest is missing after acquisition",
      "Remove the host tools directory and rerun host setup.",
    );
  }

  // Re-verify the on-disk binary digest on every probe (tamper detection immediately before the
  // binary is allowed to execute). A modified binary is never run.
  const onDiskDigest = await hashFile(binaryPath);
  if (onDiskDigest !== manifest.binaryDigest) {
    throw jjError(
      "corrupt_binary",
      `jj binary at ${binaryPath} has digest ${onDiskDigest} but the install recorded ${manifest.binaryDigest}`,
      "The installed jj binary was modified or is corrupt; remove it and rerun host setup.",
    );
  }

  const version = await probeVersion(
    binaryPath,
    validated.toolsDirectory,
    validated.version,
    validated.signal,
  );
  const capabilities = await probeCapabilities(binaryPath, validated.signal);
  if (
    !capabilities.workingCopy ||
    !capabilities.oplog ||
    !capabilities.absorb ||
    !capabilities.conflictMarker
  ) {
    throw jjError(
      "capability_missing",
      `pinned jj ${version} is missing required capabilities: ${JSON.stringify(capabilities)}`,
      "The pinned jj build lacks a required VCS capability; reinstall or update the pin.",
    );
  }

  return Object.freeze({
    available: true,
    version,
    binaryPath,
    digest: contentHash(onDiskDigest),
    capabilities,
  });
}

function unavailable(error: JjCapabilityError): JjCapabilityProbe {
  return Object.freeze({
    available: false,
    failureCode: error.code,
    message: error.message,
    remediation: error.remediation,
  });
}

/**
 * Ensure the engine-managed, pinned `jj` binary is installed, digest-verified, and
 * capability-probed. Returns an `available:true` probe on success, or an `available:false` probe
 * carrying a typed `failureCode` + `remediation` for every fail-closed path (used by the host
 * doctor). Never falls back to a system `jj` on PATH.
 */
export async function ensureJjCapability(options: JjCapabilityOptions): Promise<JjCapabilityProbe> {
  let validated: ValidatedOptions;
  try {
    validated = validateOptions(options);
  } catch (error) {
    if (error instanceof JjCapabilityError) {
      return unavailable(error);
    }
    throw error;
  }
  try {
    return await runEnsure(validated);
  } catch (error) {
    if (error instanceof JjCapabilityError) {
      return unavailable(error);
    }
    return unavailable(
      jjError(
        "probe_failed",
        `unexpected jj capability failure: ${errorToString(error)}`,
        "Rerun host setup; if it persists, inspect the daemon log.",
        error,
      ),
    );
  }
}
