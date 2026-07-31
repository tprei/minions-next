import { randomBytes, createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { contentHash, type ContentHash, type SandboxPolicyFingerprint } from "@minions/core";

export type PodmanRuntimeArtifact = Readonly<{
  podmanPath: string;
  version: string;
}>;

export type PodmanImageBuildOptions = Readonly<{
  podmanPath: string;
  imageReference: string;
  expectedImageDigest: ContentHash;
  storageRoot: string;
  stateRoot: string;
  runtime: PodmanRuntimeArtifact;
}>;

export type PodmanImageReceipt = Readonly<{
  schemaVersion: 1;
  imageReference: string;
  imageDigest: ContentHash;
  configDigest: ContentHash;
  rootfsDigest: ContentHash;
  fingerprint: SandboxPolicyFingerprint;
  preparedAt: string;
}>;

export type PodmanImageErrorCode =
  | "invalid_options"
  | "invalid_path"
  | "invalid_runtime"
  | "podman_invalid"
  | "receipt_exists"
  | "receipt_missing"
  | "receipt_invalid"
  | "image_reference_invalid"
  | "image_digest_mismatch"
  | "config_digest_mismatch"
  | "rootfs_digest_mismatch"
  | "podman_version_mismatch"
  | "fingerprint_mismatch"
  | "command_failed"
  | "command_timeout"
  | "command_output_limit"
  | "command_spawn_failed"
  | "filesystem_error"
  | "receipt_write_failed"
  | "cleanup_failed";

type PodmanImageErrorDetails = Readonly<{
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
}>;

export class PodmanImageError extends Error {
  readonly code: PodmanImageErrorCode;
  readonly remediation: string;
  readonly command: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | undefined;

  constructor(
    code: PodmanImageErrorCode,
    message: string,
    details: PodmanImageErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PodmanImageError";
    this.code = code;
    this.remediation = imageRemediation(code);
    this.command = details.command;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode;
    this.signal = details.signal;
  }
}

function imageRemediation(code: PodmanImageErrorCode): string {
  switch (code) {
    case "podman_invalid":
    case "command_spawn_failed":
      return "Install the configured rootless Podman version and rerun host doctor.";
    case "receipt_missing":
      return "Run the explicit Podman image preparation command.";
    case "fingerprint_mismatch":
    case "image_digest_mismatch":
    case "config_digest_mismatch":
    case "rootfs_digest_mismatch":
    case "podman_version_mismatch":
      return "Stop execution, inspect the pinned image, and explicitly rebuild and repin it.";
    case "command_timeout":
    case "command_output_limit":
    case "command_failed":
      return "Inspect the Podman operation and resolve the reported image failure.";
    case "receipt_invalid":
    case "invalid_options":
    case "invalid_path":
    case "invalid_runtime":
    case "image_reference_invalid":
    case "receipt_exists":
    case "filesystem_error":
    case "receipt_write_failed":
    case "cleanup_failed":
      return "Correct the Podman image configuration before retrying.";
  }
}

type ValidatedOptions = Readonly<{
  podmanPath: string;
  imageReference: string;
  expectedImageDigest: ContentHash;
  storageRoot: string;
  stateRoot: string;
  runtime: PodmanRuntimeArtifact;
  receiptDirectory: string;
  receiptPath: string;
}>;

type InspectedImage = Readonly<{
  imageDigest: ContentHash;
  configDigest: ContentHash;
  rootfsDigest: ContentHash;
}>;

type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

type PendingFailure = Readonly<{
  code: "command_timeout" | "command_output_limit" | "command_spawn_failed";
  message: string;
}>;

type UnknownRecord = Record<string, unknown>;

const digestPattern = /^[0-9a-f]{64}$/u;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;
const digestRefPattern = /^sha256:[0-9a-f]{64}$/u;
const imageReferencePattern =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}@sha256:[0-9a-f]{64}$/u;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATION_GRACE_MS = 250;
const TERMINATION_SETTLE_MS = 1_000;
const receiptKeys = [
  "schemaVersion",
  "imageReference",
  "imageDigest",
  "configDigest",
  "rootfsDigest",
  "fingerprint",
  "preparedAt",
] as const;
const fingerprintKeys = ["digest", "policyVersion"] as const;

export async function preparePodmanImage(
  options: PodmanImageBuildOptions,
): Promise<PodmanImageReceipt> {
  const validated = validateOptions(options);
  await ensureDirectoryNoSymlink(validated.storageRoot);
  await ensureDirectoryNoSymlink(validated.receiptDirectory);
  const existingReceipt = await existingPath(validated.receiptPath);
  if (existingReceipt !== undefined) {
    throw new PodmanImageError(
      "receipt_exists",
      "the Podman image receipt already exists and will not be replaced",
    );
  }
  try {
    const podmanVersion = await queryPodmanVersion(validated);
    if (podmanVersion !== validated.runtime.version) {
      throw new PodmanImageError(
        "podman_version_mismatch",
        "the installed Podman version does not match the configured runtime version",
      );
    }
    await runPodman(validated, ["pull", "--quiet", validated.imageReference]);
    const inspected = await inspectImage(validated);
    assertExpectedDigest(inspected, validated);
    const preparedAt = new Date().toISOString();
    const receiptWithoutFingerprint = {
      schemaVersion: 1 as const,
      imageReference: validated.imageReference,
      imageDigest: inspected.imageDigest,
      configDigest: inspected.configDigest,
      rootfsDigest: inspected.rootfsDigest,
      preparedAt,
    };
    const receipt: PodmanImageReceipt = Object.freeze({
      ...receiptWithoutFingerprint,
      fingerprint: fingerprintFor(receiptWithoutFingerprint),
    });
    await writeReceiptAtomically(validated.receiptPath, receipt);
    return receipt;
  } catch (error: unknown) {
    const primary = asImageError(error, "command_failed", "Podman image preparation failed");
    if (primary.code !== "receipt_exists") {
      await cleanupReceipt(validated.receiptPath);
    }
    throw primary;
  }
}

export async function verifyPodmanImage(
  options: PodmanImageBuildOptions,
  expectedFingerprint: SandboxPolicyFingerprint,
): Promise<PodmanImageReceipt> {
  const validated = validateOptions(options);
  const expected = validateFingerprint(expectedFingerprint, "expected fingerprint");
  const storageMetadata = await existingPath(validated.storageRoot);
  const receiptDirectoryMetadata = await existingPath(validated.receiptDirectory);
  if (!storageMetadata?.isDirectory() || !receiptDirectoryMetadata?.isDirectory()) {
    throw new PodmanImageError(
      "receipt_missing",
      "the configured Podman storage or receipt directory is unavailable",
    );
  }
  const receipt = await readReceipt(validated.receiptPath);
  if (receipt.imageReference !== validated.imageReference) {
    throw new PodmanImageError(
      "receipt_invalid",
      "the Podman image receipt reference does not match the requested image",
    );
  }
  const podmanVersion = await queryPodmanVersion(validated);
  if (podmanVersion !== validated.runtime.version) {
    throw new PodmanImageError(
      "podman_version_mismatch",
      "the installed Podman version does not match the image receipt",
    );
  }
  const inspected = await inspectImage(validated);
  if (inspected.imageDigest !== receipt.imageDigest) {
    throw new PodmanImageError(
      "image_digest_mismatch",
      "the active Podman image manifest digest does not match the receipt",
    );
  }
  if (inspected.configDigest !== receipt.configDigest) {
    throw new PodmanImageError(
      "config_digest_mismatch",
      "the active Podman image config digest does not match the receipt",
    );
  }
  if (inspected.rootfsDigest !== receipt.rootfsDigest) {
    throw new PodmanImageError(
      "rootfs_digest_mismatch",
      "the active Podman image rootfs digest does not match the receipt",
    );
  }
  assertExpectedDigest(inspected, validated);
  const recomputedFingerprint = fingerprintFor({
    schemaVersion: receipt.schemaVersion,
    imageReference: receipt.imageReference,
    imageDigest: receipt.imageDigest,
    configDigest: receipt.configDigest,
    rootfsDigest: receipt.rootfsDigest,
    preparedAt: receipt.preparedAt,
  });
  if (receipt.fingerprint.digest !== recomputedFingerprint.digest) {
    throw new PodmanImageError(
      "fingerprint_mismatch",
      "the Podman image receipt fingerprint is invalid",
    );
  }
  if (expected.digest !== receipt.fingerprint.digest) {
    throw new PodmanImageError(
      "fingerprint_mismatch",
      "the Podman image fingerprint does not match the expected fingerprint",
    );
  }
  return receipt;
}

function validateOptions(options: PodmanImageBuildOptions): ValidatedOptions {
  const record = asRecord(options, "Podman image options");
  const podmanPath = validateAbsolutePath(record["podmanPath"], "Podman path");
  const imageReference = validateImageReference(record["imageReference"]);
  const expectedImageDigest = validateDigest(
    record["expectedImageDigest"],
    "expected image digest",
    "invalid_options",
  );
  const storageRoot = validateAbsolutePath(record["storageRoot"], "Podman storage root");
  const stateRoot = validateAbsolutePath(record["stateRoot"], "Podman state root");
  const runtime = validateRuntime(record["runtime"]);
  if (runtime.podmanPath !== podmanPath) {
    throw new PodmanImageError(
      "invalid_options",
      "runtime podmanPath must match the options podmanPath",
    );
  }
  const receiptDirectory = join(stateRoot, "_minions", "images");
  const sanitized = imageReference.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 200);
  const receiptPath = join(receiptDirectory, `${sanitized}.json`);
  assertContained(stateRoot, receiptPath, "Podman image receipt path");
  return Object.freeze({
    podmanPath,
    imageReference,
    expectedImageDigest,
    storageRoot,
    stateRoot,
    runtime,
    receiptDirectory,
    receiptPath,
  });
}

function validateRuntime(value: unknown): PodmanRuntimeArtifact {
  const record = asRecord(value, "runtime artifact");
  const podmanPath = validateAbsolutePath(record["podmanPath"], "runtime Podman path");
  const version = validateVersion(record["version"], "runtime version", "invalid_runtime");
  return Object.freeze({ podmanPath, version });
}

function validateImageReference(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    /(?:^|[:/])latest(?:[:/]|$)/iu.test(value) ||
    !imageReferencePattern.test(value)
  ) {
    throw new PodmanImageError(
      "image_reference_invalid",
      "image reference must pin a registry path, tag, and sha256 digest without a mutable tag",
    );
  }
  return value;
}

function validateAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) {
    throw new PodmanImageError("invalid_path", `${field} must be a normalized absolute path`);
  }
  if (value.includes("\0")) {
    throw new PodmanImageError("invalid_path", `${field} contains a NUL byte`);
  }
  return value;
}

function validateDigest(value: unknown, field: string, code: PodmanImageErrorCode): ContentHash {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new PodmanImageError(code, `${field} must be a lowercase SHA-256 digest`);
  }
  return contentHash(value);
}

function validateVersion(value: unknown, field: string, code: PodmanImageErrorCode): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new PodmanImageError(code, `${field} is invalid`);
  }
  return value;
}

function asRecord(
  value: unknown,
  field: string,
  code: PodmanImageErrorCode = "invalid_options",
): UnknownRecord {
  if (!isRecord(value)) {
    throw new PodmanImageError(code, `${field} must be an object`);
  }
  return value;
}

function assertContained(root: string, target: string, field: string): void {
  const suffix = relative(root, target);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new PodmanImageError("invalid_path", `${field} escapes the configured Podman state root`);
  }
}

async function ensureDirectoryNoSymlink(path: string): Promise<void> {
  const segments = pathSegments(path);
  let current = segments.root;
  for (const segment of segments.parts) {
    current = join(current, segment);
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) {
        throw new PodmanImageError(
          "filesystem_error",
          `cannot inspect directory ${current}`,
          {},
          { cause: error },
        );
      }
      try {
        await mkdir(current);
      } catch (mkdirError: unknown) {
        if (!isErrno(mkdirError, "EEXIST")) {
          throw new PodmanImageError(
            "filesystem_error",
            `cannot create directory ${current}`,
            {},
            { cause: mkdirError },
          );
        }
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new PodmanImageError(
        "invalid_path",
        `directory component ${current} is not a real directory`,
      );
    }
  }
}

function pathSegments(path: string): Readonly<{ root: string; parts: readonly string[] }> {
  const parsed = parse(path);
  return Object.freeze({
    root: parsed.root,
    parts: Object.freeze(
      path
        .slice(parsed.root.length)
        .split(sep)
        .filter((segment) => segment.length > 0),
    ),
  });
}

async function existingPath(path: string): Promise<Stats | undefined> {
  await assertNoSymlinkComponents(path);
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new PodmanImageError("filesystem_error", `cannot inspect ${path}`, {}, { cause: error });
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const segments = pathSegments(path);
  let current = segments.root;
  for (const segment of segments.parts) {
    current = join(current, segment);
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return;
      throw new PodmanImageError(
        "filesystem_error",
        `cannot inspect path component ${current}`,
        {},
        { cause: error },
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new PodmanImageError("invalid_path", `path component ${current} is a symbolic link`);
    }
  }
}

async function assertRegularFile(
  path: string,
  field: string,
  code: PodmanImageErrorCode,
): Promise<void> {
  await assertNoSymlinkComponents(path);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new PodmanImageError(code, `${field} is unavailable`, {}, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PodmanImageError(code, `${field} must be a regular file`);
  }
}

async function queryPodmanVersion(options: ValidatedOptions): Promise<string> {
  const result = await runPodman(options, ["--version"]);
  const output = result.stdout.trim();
  const match = /^podman\s+version\s+(\S+)$/iu.exec(output);
  const shortMatch = /^(\S+)$/u.exec(output);
  const version = match?.[1] ?? shortMatch?.[1];
  if (version === undefined || !versionPattern.test(version)) {
    throw new PodmanImageError(
      "podman_invalid",
      "podman --version returned an invalid Podman version",
      { stdout: result.stdout, stderr: result.stderr },
    );
  }
  return version;
}

async function inspectImage(options: ValidatedOptions): Promise<InspectedImage> {
  const result = await runPodman(options, ["inspect", "--format", "json", options.imageReference]);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error: unknown) {
    throw new PodmanImageError(
      "podman_invalid",
      "podman inspect returned invalid JSON",
      { stdout: result.stdout, stderr: result.stderr },
      { cause: error },
    );
  }
  const record = extractInspectRecord(value);
  const imageDigest = extractDigest(record["Digest"], "image manifest digest");
  const configDigest = extractDigest(record["Id"], "image config digest");
  const rootfs = record["RootFS"];
  if (!isRecord(rootfs)) {
    throw new PodmanImageError("podman_invalid", "podman inspect image RootFS is not an object", {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  const layers = rootfs["Layers"];
  if (!isUnknownArray(layers) || layers.length === 0) {
    throw new PodmanImageError("podman_invalid", "podman inspect image RootFS layers are missing", {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  const topLayer = layers[layers.length - 1];
  if (typeof topLayer !== "string") {
    throw new PodmanImageError(
      "podman_invalid",
      "podman inspect image RootFS top layer is not text",
      { stdout: result.stdout, stderr: result.stderr },
    );
  }
  const rootfsDigest = extractDigest(topLayer, "image rootfs digest");
  return Object.freeze({ imageDigest, configDigest, rootfsDigest });
}

function extractInspectRecord(value: unknown): UnknownRecord {
  if (!isUnknownArray(value) || value.length !== 1) {
    throw new PodmanImageError(
      "podman_invalid",
      "podman inspect did not return a single image record",
    );
  }
  const record = value[0];
  if (!isRecord(record)) {
    throw new PodmanImageError("podman_invalid", "podman inspect image record is not an object");
  }
  return record;
}

function extractDigest(value: unknown, field: string): ContentHash {
  if (typeof value !== "string" || !digestRefPattern.test(value)) {
    throw new PodmanImageError("podman_invalid", `podman inspect ${field} is not a sha256 digest`);
  }
  return contentHash(value.slice("sha256:".length));
}

function assertExpectedDigest(inspected: InspectedImage, options: ValidatedOptions): void {
  if (inspected.imageDigest !== options.expectedImageDigest) {
    throw new PodmanImageError(
      "image_digest_mismatch",
      "the pulled Podman image manifest digest does not match the pinned expected digest",
    );
  }
}

async function runPodman(
  options: ValidatedOptions,
  args: readonly string[],
): Promise<CommandResult> {
  await assertPodmanExecutable(options.podmanPath);
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  return spawnBounded(
    options.podmanPath,
    args,
    Object.freeze({
      HOME: dirname(options.storageRoot),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
      LANG: "C",
      LC_ALL: "C",
      ...(runtimeDir === undefined ? {} : { XDG_RUNTIME_DIR: runtimeDir }),
      MINIONS_PODMAN_STORAGE: options.storageRoot,
      TMPDIR: "/tmp",
    }),
  );
}

async function assertPodmanExecutable(path: string): Promise<void> {
  await assertNoSymlinkComponents(path);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new PodmanImageError(
      "podman_invalid",
      "podman executable is unavailable",
      {},
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new PodmanImageError(
      "podman_invalid",
      "podman path must be a real executable regular file",
    );
  }
}

function spawnBounded(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: "/",
        detached: true,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error: unknown) {
      reject(
        new PodmanImageError(
          "command_spawn_failed",
          "podman process could not be started",
          {},
          { cause: error },
        ),
      );
      return;
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      terminateProcessGroup(child);
      reject(
        new PodmanImageError("command_spawn_failed", "podman output streams could not be opened"),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutEnded = false;
    let stderrEnded = false;
    let childClosed = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let failure: PendingFailure | undefined;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    const command = [executable, ...args].map((part) => JSON.stringify(part)).join(" ");
    const collect = (target: "stdout" | "stderr", chunk: unknown): void => {
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : undefined;
      if (bytes === undefined) {
        fail("command_spawn_failed", "podman emitted a non-byte output chunk");
        return;
      }
      if (target === "stdout") {
        const remaining = MAX_STDOUT_BYTES - stdoutBytes;
        if (remaining > 0) {
          const retained = Buffer.from(bytes.subarray(0, remaining));
          stdoutChunks.push(retained);
          stdoutBytes += retained.byteLength;
        }
        if (bytes.byteLength > remaining) {
          fail("command_output_limit", "podman stdout exceeded the configured output limit");
        }
      } else {
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        if (remaining > 0) {
          const retained = Buffer.from(bytes.subarray(0, remaining));
          stderrChunks.push(retained);
          stderrBytes += retained.byteLength;
        }
        if (bytes.byteLength > remaining) {
          fail("command_output_limit", "podman stderr exceeded the configured output limit");
        }
      }
    };
    const finishIfReady = (): void => {
      if (settled || !childClosed || !stdoutEnded || !stderrEnded) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(settleTimer);
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      const details = {
        command,
        stdout: stdoutText,
        stderr: stderrText,
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
      } satisfies PodmanImageErrorDetails;
      if (failure !== undefined) {
        reject(new PodmanImageError(failure.code, failure.message, details));
        return;
      }
      if (exitCode !== 0) {
        reject(
          new PodmanImageError(
            "command_failed",
            `podman command exited unsuccessfully${exitCode === null ? "" : ` with status ${String(exitCode)}`}`,
            details,
          ),
        );
        return;
      }
      resolve(Object.freeze({ stdout: stdoutText, stderr: stderrText }));
    };
    function fail(code: PendingFailure["code"], message: string): void {
      if (settled || failure !== undefined) return;
      failure = Object.freeze({ code, message });
      forceKillTimer = terminateProcessGroup(child);
      settleTimer = setTimeout(() => {
        if (settled) return;
        childClosed = true;
        stdoutEnded = true;
        stderrEnded = true;
        finishIfReady();
      }, TERMINATION_SETTLE_MS);
    }

    const timeoutTimer = setTimeout(() => {
      fail("command_timeout", "podman command exceeded the configured timeout");
    }, COMMAND_TIMEOUT_MS);
    stdout.on("data", (chunk: unknown) => {
      collect("stdout", chunk);
    });
    stderr.on("data", (chunk: unknown) => {
      collect("stderr", chunk);
    });
    stdout.once("error", () => {
      stdoutEnded = true;
      fail("command_spawn_failed", "podman stdout stream failed");
      finishIfReady();
    });
    stderr.once("error", () => {
      stderrEnded = true;
      fail("command_spawn_failed", "podman stderr stream failed");
      finishIfReady();
    });
    stdout.once("end", () => {
      stdoutEnded = true;
      finishIfReady();
    });
    stderr.once("end", () => {
      stderrEnded = true;
      finishIfReady();
    });
    child.once("error", () => {
      fail("command_spawn_failed", "podman process could not be started");
      childClosed = true;
      finishIfReady();
    });
    child.once("close", (code: number | null, childSignal: NodeJS.Signals | null) => {
      childClosed = true;
      exitCode = code;
      signal = childSignal;
      finishIfReady();
    });
  });
}

function terminateProcessGroup(child: ChildProcess): NodeJS.Timeout | undefined {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    child.kill("SIGTERM");
    return undefined;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error: unknown) {
    if (!isErrno(error, "ESRCH")) child.kill("SIGTERM");
  }
  return setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error: unknown) {
      if (isErrno(error, "ESRCH")) return;
      child.kill("SIGKILL");
    }
  }, TERMINATION_GRACE_MS);
}

async function readTextFile(
  path: string,
  field: string,
  code: PodmanImageErrorCode,
): Promise<string> {
  await assertRegularFile(path, field, code);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new PodmanImageError(code, `${field} is unavailable`, {}, { cause: error });
  }
  if (metadata.size > MAX_RECEIPT_BYTES) {
    throw new PodmanImageError(code, `${field} exceeds the configured size limit`);
  }
  try {
    const bytes = await readFile(path);
    return bytes.toString("utf8");
  } catch (error: unknown) {
    throw new PodmanImageError(code, `cannot read ${field}`, {}, { cause: error });
  }
}

async function makeReadOnly(path: string, field: string): Promise<void> {
  await assertRegularFile(path, field, "filesystem_error");
  try {
    await chmod(path, 0o444);
  } catch (error: unknown) {
    throw new PodmanImageError(
      "filesystem_error",
      `cannot make ${field} read-only`,
      {},
      { cause: error },
    );
  }
  await assertReadOnly(path, field);
}

async function assertReadOnly(path: string, field: string): Promise<void> {
  await assertRegularFile(path, field, "filesystem_error");
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new PodmanImageError("filesystem_error", `cannot inspect ${field}`, {}, { cause: error });
  }
  if ((metadata.mode & 0o222) !== 0) {
    throw new PodmanImageError("filesystem_error", `${field} is writable`);
  }
}

async function writeReceiptAtomically(path: string, receipt: PodmanImageReceipt): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    if ((await existingPath(path)) !== undefined) {
      throw new PodmanImageError("receipt_exists", "the Podman image receipt already exists");
    }
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
    await chmod(temporaryPath, 0o444);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    renamed = true;
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error: unknown) {
    if (error instanceof PodmanImageError) throw error;
    throw new PodmanImageError(
      "receipt_write_failed",
      "cannot atomically write the Podman image receipt",
      {},
      { cause: error },
    );
  } finally {
    if (handle !== undefined) await handle.close();
    if (!renamed) await rm(temporaryPath, { force: true });
  }
}

async function cleanupReceipt(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Receipt cleanup is best-effort; the caller already owns the primary failure.
  }
}

async function readReceipt(path: string): Promise<PodmanImageReceipt> {
  await assertRegularFile(path, "Podman image receipt", "receipt_missing");
  let crashMetadata: Stats | undefined;
  try {
    crashMetadata = await lstat(path);
  } catch {
    crashMetadata = undefined;
  }
  if (crashMetadata !== undefined && (crashMetadata.mode & 0o222) !== 0) {
    await makeReadOnly(path, "Podman image receipt");
  }
  await assertReadOnly(path, "Podman image receipt");
  const text = await readTextFile(path, "Podman image receipt", "receipt_invalid");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new PodmanImageError(
      "receipt_invalid",
      "the Podman image receipt is not valid JSON",
      {},
      { cause: error },
    );
  }
  return validateReceipt(value);
}

function validateReceipt(value: unknown): PodmanImageReceipt {
  const record = asRecord(value, "Podman image receipt", "receipt_invalid");
  assertExactKeys(record, receiptKeys, "Podman image receipt");
  if (record["schemaVersion"] !== 1) {
    throw new PodmanImageError("receipt_invalid", "Podman image receipt schemaVersion must be 1");
  }
  const imageReference = validateImageReference(record["imageReference"]);
  const imageDigest = validateDigest(
    record["imageDigest"],
    "receipt image digest",
    "receipt_invalid",
  );
  const configDigest = validateDigest(
    record["configDigest"],
    "receipt config digest",
    "receipt_invalid",
  );
  const rootfsDigest = validateDigest(
    record["rootfsDigest"],
    "receipt rootfs digest",
    "receipt_invalid",
  );
  const preparedAt = record["preparedAt"];
  if (typeof preparedAt !== "string" || preparedAt.length === 0 || preparedAt.length > 64) {
    throw new PodmanImageError("receipt_invalid", "Podman image receipt preparedAt is invalid");
  }
  const fingerprint = validateFingerprint(
    record["fingerprint"],
    "Podman image receipt fingerprint",
  );
  return Object.freeze({
    schemaVersion: 1,
    imageReference,
    imageDigest,
    configDigest,
    rootfsDigest,
    fingerprint,
    preparedAt,
  });
}

function validateFingerprint(value: unknown, field: string): SandboxPolicyFingerprint {
  const record = asRecord(value, field, "receipt_invalid");
  assertExactKeys(record, fingerprintKeys, field);
  if (record["policyVersion"] !== 1) {
    throw new PodmanImageError("receipt_invalid", `${field} policyVersion must be 1`);
  }
  const digest = validateDigest(record["digest"], `${field} digest`, "receipt_invalid");
  return Object.freeze({ policyVersion: 1, digest });
}

function assertExactKeys(record: UnknownRecord, expected: readonly string[], field: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new PodmanImageError("receipt_invalid", `${field} contains unknown or missing fields`);
  }
}

function fingerprintFor(
  receipt: Readonly<{
    schemaVersion: 1;
    imageReference: string;
    imageDigest: ContentHash;
    configDigest: ContentHash;
    rootfsDigest: ContentHash;
    preparedAt: string;
  }>,
): SandboxPolicyFingerprint {
  const serialized = canonicalJson(receipt);
  const digest = contentHash(createHash("sha256").update(serialized, "utf8").digest("hex"));
  return Object.freeze({ policyVersion: 1, digest });
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new PodmanImageError(
    "receipt_invalid",
    "Podman image receipt contains an unserializable value",
  );
}

function asImageError(
  error: unknown,
  code: PodmanImageErrorCode,
  message: string,
): PodmanImageError {
  if (error instanceof PodmanImageError) return error;
  return new PodmanImageError(code, message, {}, { cause: error });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
