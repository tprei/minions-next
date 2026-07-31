import { randomBytes, createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { contentHash, type ContentHash, type SandboxPolicyFingerprint } from "@minions/core";

export type LimaRuntimeArtifact = Readonly<{
  url: string;
  digest: ContentHash;
  version: string;
}>;

export type LimaTemplateBuildOptions = Readonly<{
  limactlPath: string;
  limaHome: string;
  sourceTemplatePath: string;
  templateInstanceName: string;
  templateDiskGiB: number;
  runtime: LimaRuntimeArtifact;
}>;

export type LimaTemplateReceipt = Readonly<{
  schemaVersion: 1;
  instanceName: string;
  architecture: "aarch64";
  limaVersion: string;
  runtimeVersion: string;
  sourceTemplateDigest: ContentHash;
  configDigest: ContentHash;
  diskDigest: ContentHash;
  diskGiB: number;
  fingerprint: SandboxPolicyFingerprint;
}>;

export type LimaTemplateErrorCode =
  | "invalid_options"
  | "invalid_path"
  | "invalid_runtime"
  | "limactl_invalid"
  | "instance_exists"
  | "receipt_exists"
  | "receipt_missing"
  | "receipt_invalid"
  | "source_template_invalid"
  | "template_invalid"
  | "disk_invalid"
  | "source_digest_mismatch"
  | "config_digest_mismatch"
  | "disk_digest_mismatch"
  | "lima_version_mismatch"
  | "runtime_version_mismatch"
  | "fingerprint_mismatch"
  | "instance_state_invalid"
  | "command_failed"
  | "command_timeout"
  | "command_output_limit"
  | "command_spawn_failed"
  | "filesystem_error"
  | "receipt_write_failed"
  | "cleanup_failed";

type LimaTemplateErrorDetails = Readonly<{
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
}>;

export class LimaTemplateError extends Error {
  readonly code: LimaTemplateErrorCode;
  readonly remediation: string;
  readonly command: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | undefined;

  constructor(
    code: LimaTemplateErrorCode,
    message: string,
    details: LimaTemplateErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LimaTemplateError";
    this.code = code;
    this.remediation = templateRemediation(code);
    this.command = details.command;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode;
    this.signal = details.signal;
  }
}

function templateRemediation(code: LimaTemplateErrorCode): string {
  switch (code) {
    case "limactl_invalid":
    case "command_spawn_failed":
      return "Install the configured Lima version and rerun host doctor.";
    case "receipt_missing":
      return "Run the explicit Lima template preparation command.";
    case "fingerprint_mismatch":
    case "source_digest_mismatch":
    case "config_digest_mismatch":
    case "disk_digest_mismatch":
    case "lima_version_mismatch":
    case "runtime_version_mismatch":
    case "instance_state_invalid":
      return "Stop execution, inspect the template, and explicitly rebuild and repin it.";
    case "command_timeout":
    case "command_output_limit":
    case "command_failed":
      return "Inspect the template VM operation and resolve the reported Lima failure.";
    case "cleanup_failed":
      return "Inspect and explicitly remove the named template builder VM.";
    case "receipt_invalid":
    case "invalid_options":
    case "invalid_path":
    case "invalid_runtime":
    case "instance_exists":
    case "receipt_exists":
    case "source_template_invalid":
    case "template_invalid":
    case "disk_invalid":
    case "filesystem_error":
    case "receipt_write_failed":
      return "Correct the Lima template configuration before retrying.";
  }
}

type ValidatedOptions = Readonly<{
  limactlPath: string;
  limaHome: string;
  sourceTemplatePath: string;
  templateInstanceName: string;
  templateDiskGiB: number;
  runtime: LimaRuntimeArtifact;
  instancePath: string;
  receiptPath: string;
  receiptDirectory: string;
}>;

type TemplateArtifacts = Readonly<{
  instancePath: string;
  configPath: string;
  diskPath: string;
}>;
type InstanceIdentity = Readonly<{
  device: number;
  inode: number;
}>;

type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

type TemplateConfig = Readonly<{
  value: YamlValue;
}>;

type YamlValue =
  null | boolean | number | string | YamlValue[] | { readonly [key: string]: YamlValue };

type YamlLine = Readonly<{
  indent: number;
  content: string;
  raw: string;
  line: number;
}>;

type PendingFailure = Readonly<{
  code: "command_timeout" | "command_output_limit" | "command_spawn_failed";
  message: string;
}>;

type UnknownRecord = Record<string, unknown>;

type LimaListRecord = Readonly<{
  name: string;
  status: string;
  vmType: string;
  dir: string | undefined;
}>;

const digestPattern = /^[0-9a-f]{64}$/u;
const instanceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINATION_GRACE_MS = 250;
const TERMINATION_SETTLE_MS = 1_000;
const O_NOFOLLOW = constants.O_NOFOLLOW;
const receiptKeys = [
  "architecture",
  "configDigest",
  "diskDigest",
  "diskGiB",
  "fingerprint",
  "instanceName",
  "limaVersion",
  "runtimeVersion",
  "schemaVersion",
  "sourceTemplateDigest",
] as const;
const fingerprintKeys = ["digest", "policyVersion"] as const;

export async function prepareLimaTemplate(
  options: LimaTemplateBuildOptions,
): Promise<LimaTemplateReceipt> {
  const validated = validateOptions(options);
  await ensureDirectoryNoSymlink(validated.limaHome);
  await ensureDirectoryNoSymlink(validated.receiptDirectory);
  const existingInstance = await existingPath(validated.instancePath);
  if (existingInstance !== undefined) {
    throw new LimaTemplateError(
      "instance_exists",
      "the Lima template instance already exists and will not be replaced",
    );
  }
  const existingReceipt = await existingPath(validated.receiptPath);
  if (existingReceipt !== undefined) {
    throw new LimaTemplateError(
      "receipt_exists",
      "the Lima template receipt already exists and will not be replaced",
    );
  }

  const sourceDigest = await hashRegularFile(
    validated.sourceTemplatePath,
    "source template",
    "source_template_invalid",
  );
  const sourceConfig = await readTemplateConfig(
    validated.sourceTemplatePath,
    validated.templateDiskGiB,
  );
  const limaVersion = await queryLimaVersion(validated);
  const createArgs = [
    "create",
    "--tty=false",
    `--name=${validated.templateInstanceName}`,
    "--arch=aarch64",
    "--vm-type=vz",
    "--mount-type=virtiofs",
    "--mount-none",
    `--disk=${String(validated.templateDiskGiB)}`,
    validated.sourceTemplatePath,
  ];
  let builderIdentity: InstanceIdentity | undefined;
  try {
    await runLimactl(validated, createArgs);
    builderIdentity = await instanceIdentity(validated.instancePath);
    await runLimactl(validated, ["start", "--tty=false", validated.templateInstanceName]);
    await runLimactl(validated, [
      "shell",
      "--tty=false",
      validated.templateInstanceName,
      "sudo",
      "-n",
      "sh",
      "-ceu",
      runtimeInstallScript,
      "--",
      validated.runtime.url,
      validated.runtime.digest,
    ]);
    await runLimactl(validated, [
      "shell",
      "--tty=false",
      validated.templateInstanceName,
      "docker",
      "version",
    ]);
    const runtimeVersionOutput = await runLimactl(validated, [
      "shell",
      "--tty=false",
      validated.templateInstanceName,
      "omp",
      "--version",
    ]);
    assertRuntimeVersion(runtimeVersionOutput.stdout, validated.runtime.version);
    await runLimactl(validated, ["stop", "--tty=false", validated.templateInstanceName]);
    await assertInstanceStoppedVz(validated);

    const artifacts = await discoverTemplateArtifacts(validated);
    const activeConfig = await readTemplateConfig(artifacts.configPath, validated.templateDiskGiB);
    assertTemplateConfigCompatible(sourceConfig, activeConfig, validated.templateDiskGiB);
    const currentSourceDigest = await hashRegularFile(
      validated.sourceTemplatePath,
      "source template",
      "source_template_invalid",
    );
    if (currentSourceDigest !== sourceDigest) {
      throw new LimaTemplateError(
        "source_digest_mismatch",
        "the source template changed while the Lima template was being built",
      );
    }
    const configDigest = await hashRegularFile(
      artifacts.configPath,
      "template config",
      "template_invalid",
    );
    const diskDigest = await hashRegularFile(artifacts.diskPath, "template disk", "disk_invalid");
    await makeReadOnly(validated.sourceTemplatePath, "source template");
    await makeReadOnly(artifacts.configPath, "template config");
    await makeReadOnly(artifacts.diskPath, "template disk");
    const receiptWithoutFingerprint = {
      schemaVersion: 1 as const,
      instanceName: validated.templateInstanceName,
      architecture: "aarch64" as const,
      limaVersion,
      runtimeVersion: validated.runtime.version,
      sourceTemplateDigest: sourceDigest,
      configDigest,
      diskDigest,
      diskGiB: validated.templateDiskGiB,
    };
    const receipt: LimaTemplateReceipt = Object.freeze({
      ...receiptWithoutFingerprint,
      fingerprint: fingerprintFor(receiptWithoutFingerprint),
    });
    await writeReceiptAtomically(validated.receiptPath, receipt);
    await makeDirectoryReadOnly(validated.instancePath, "template instance directory");
    return receipt;
  } catch (error: unknown) {
    const primary = asTemplateError(error, "template_invalid", "Lima template build failed");
    if (builderIdentity !== undefined) {
      try {
        await cleanupBuilderInstance(validated, builderIdentity);
      } catch (cleanupError: unknown) {
        const cleanup = asTemplateError(
          cleanupError,
          "cleanup_failed",
          "failed to clean the Lima template builder instance",
        );
        throw new LimaTemplateError(
          primary.code,
          `${primary.message}; cleanup failed: ${cleanup.message}`,
          {
            ...(primary.command === undefined ? {} : { command: primary.command }),
            stdout: primary.stdout,
            stderr: [primary.stderr, cleanup.stderr].filter((value) => value.length > 0).join("\n"),
            ...(primary.exitCode === undefined ? {} : { exitCode: primary.exitCode }),
            ...(primary.signal === undefined ? {} : { signal: primary.signal }),
          },
          { cause: primary },
        );
      }
    }
    throw primary;
  }
}

export async function verifyLimaTemplate(
  options: LimaTemplateBuildOptions,
  expectedFingerprint: SandboxPolicyFingerprint,
): Promise<LimaTemplateReceipt> {
  const validated = validateOptions(options);
  const expected = validateFingerprint(expectedFingerprint, "expected fingerprint");
  const limaHomeMetadata = await existingPath(validated.limaHome);
  const receiptDirectoryMetadata = await existingPath(validated.receiptDirectory);
  if (!limaHomeMetadata?.isDirectory() || !receiptDirectoryMetadata?.isDirectory()) {
    throw new LimaTemplateError(
      "receipt_missing",
      "the configured Lima home or receipt directory is unavailable",
    );
  }
  const receipt = await readReceipt(validated.receiptPath);
  if (receipt.instanceName !== validated.templateInstanceName) {
    throw new LimaTemplateError(
      "receipt_invalid",
      "the Lima template receipt instance name does not match the requested instance",
    );
  }
  if (receipt.diskGiB !== validated.templateDiskGiB) {
    throw new LimaTemplateError(
      "receipt_invalid",
      "the Lima template receipt disk size does not match the requested disk size",
    );
  }
  const limaVersion = await queryLimaVersion(validated);
  if (receipt.limaVersion !== limaVersion) {
    throw new LimaTemplateError(
      "lima_version_mismatch",
      "the installed Lima version does not match the template receipt",
    );
  }
  await assertInstanceStoppedVz(validated);
  const artifacts = await discoverTemplateArtifacts(validated);
  await assertDirectoryReadOnly(validated.instancePath, "template instance directory");
  const sourceDigest = await hashRegularFile(
    validated.sourceTemplatePath,
    "source template",
    "source_template_invalid",
  );
  if (sourceDigest !== receipt.sourceTemplateDigest) {
    throw new LimaTemplateError(
      "source_digest_mismatch",
      "the source template digest does not match the Lima template receipt",
    );
  }
  await assertReadOnly(validated.sourceTemplatePath, "source template");
  const sourceConfig = await readTemplateConfig(
    validated.sourceTemplatePath,
    validated.templateDiskGiB,
  );
  const activeConfig = await readTemplateConfig(artifacts.configPath, validated.templateDiskGiB);
  assertTemplateConfigCompatible(sourceConfig, activeConfig, validated.templateDiskGiB);
  await assertReadOnly(artifacts.configPath, "template config");
  await assertReadOnly(artifacts.diskPath, "template disk");
  const configDigest = await hashRegularFile(
    artifacts.configPath,
    "template config",
    "template_invalid",
  );
  if (configDigest !== receipt.configDigest) {
    throw new LimaTemplateError(
      "config_digest_mismatch",
      "the active Lima template config digest does not match the receipt",
    );
  }
  const diskDigest = await hashRegularFile(artifacts.diskPath, "template disk", "disk_invalid");
  if (diskDigest !== receipt.diskDigest) {
    throw new LimaTemplateError(
      "disk_digest_mismatch",
      "the Lima template disk digest does not match the receipt",
    );
  }
  const recomputedFingerprint = fingerprintFor({
    schemaVersion: receipt.schemaVersion,
    instanceName: receipt.instanceName,
    architecture: receipt.architecture,
    limaVersion: receipt.limaVersion,
    runtimeVersion: receipt.runtimeVersion,
    sourceTemplateDigest: receipt.sourceTemplateDigest,
    configDigest: receipt.configDigest,
    diskDigest: receipt.diskDigest,
    diskGiB: receipt.diskGiB,
  });
  if (receipt.fingerprint.digest !== recomputedFingerprint.digest) {
    throw new LimaTemplateError(
      "fingerprint_mismatch",
      "the Lima template receipt fingerprint is invalid",
    );
  }
  if (expected.digest !== receipt.fingerprint.digest) {
    throw new LimaTemplateError(
      "fingerprint_mismatch",
      "the Lima template fingerprint does not match the expected fingerprint",
    );
  }
  return receipt;
}

const runtimeInstallScript = [
  "set -eu",
  "tmp=$(mktemp)",
  "trap 'rm -f \"$tmp\"' EXIT",
  'curl --fail --silent --show-error --location --proto \'=https\' --tlsv1.2 "$1" --output "$tmp"',
  'actual=$(sha256sum "$tmp")',
  "actual=${actual%% *}",
  'test "$actual" = "$2"',
  'sudo -n install -m 0755 "$tmp" /usr/local/bin/omp',
].join("\n");

function validateOptions(options: LimaTemplateBuildOptions): ValidatedOptions {
  const record = asRecord(options, "Lima template options");
  const limactlPath = validateAbsolutePath(record["limactlPath"], "limactl path");
  const limaHome = validateAbsolutePath(record["limaHome"], "Lima home");
  const sourceTemplatePath = validateAbsolutePath(
    record["sourceTemplatePath"],
    "source template path",
  );
  const templateInstanceName = validateInstanceName(record["templateInstanceName"]);
  const templateDiskGiB = record["templateDiskGiB"];
  if (
    typeof templateDiskGiB !== "number" ||
    !Number.isSafeInteger(templateDiskGiB) ||
    templateDiskGiB < 16
  ) {
    throw new LimaTemplateError(
      "invalid_options",
      "templateDiskGiB must be a safe integer of at least 16 GiB",
    );
  }
  const runtime = validateRuntime(record["runtime"]);
  const instancePath = join(limaHome, templateInstanceName);
  const receiptDirectory = join(limaHome, "_minions", "templates");
  const receiptPath = join(receiptDirectory, `${templateInstanceName}.json`);
  assertContained(limaHome, instancePath, "template instance path");
  assertContained(limaHome, receiptPath, "template receipt path");
  return Object.freeze({
    limactlPath,
    limaHome,
    sourceTemplatePath,
    templateInstanceName,
    templateDiskGiB,
    runtime,
    instancePath,
    receiptPath,
    receiptDirectory,
  });
}

function validateRuntime(value: unknown): LimaRuntimeArtifact {
  const record = asRecord(value, "runtime artifact");
  const urlValue = record["url"];
  if (typeof urlValue !== "string" || urlValue.length === 0 || urlValue.length > 2048) {
    throw new LimaTemplateError("invalid_runtime", "runtime URL must be non-empty text");
  }
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch (error: unknown) {
    throw new LimaTemplateError("invalid_runtime", "runtime URL is invalid", {}, { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.search.length > 0 ||
    /(?:^|[^A-Za-z])latest(?:[^A-Za-z]|$)/iu.test(url.pathname)
  ) {
    throw new LimaTemplateError(
      "invalid_runtime",
      "runtime URL must be an immutable HTTPS URL without credentials, query, fragment, or latest path",
    );
  }
  const digest = validateDigest(record["digest"], "runtime digest", "invalid_runtime");
  const version = validateVersion(record["version"], "runtime version", "invalid_runtime");
  return Object.freeze({ url: urlValue, digest, version });
}

function validateAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) {
    throw new LimaTemplateError("invalid_path", `${field} must be a normalized absolute path`);
  }
  if (value.includes("\0")) {
    throw new LimaTemplateError("invalid_path", `${field} contains a NUL byte`);
  }
  return value;
}

function validateInstanceName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instanceNamePattern.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new LimaTemplateError("invalid_options", "template instance name is invalid");
  }
  return value;
}

function validateDigest(value: unknown, field: string, code: LimaTemplateErrorCode): ContentHash {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new LimaTemplateError(code, `${field} must be a lowercase SHA-256 digest`);
  }
  return contentHash(value);
}

function validateVersion(value: unknown, field: string, code: LimaTemplateErrorCode): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new LimaTemplateError(code, `${field} is invalid`);
  }
  return value;
}

function asRecord(
  value: unknown,
  field: string,
  code: LimaTemplateErrorCode = "invalid_options",
): UnknownRecord {
  if (!isRecord(value)) {
    throw new LimaTemplateError(code, `${field} must be an object`);
  }
  return value;
}

function assertContained(root: string, target: string, field: string): void {
  const suffix = relative(root, target);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new LimaTemplateError("invalid_path", `${field} escapes the configured Lima home`);
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
        throw new LimaTemplateError(
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
          throw new LimaTemplateError(
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
      throw new LimaTemplateError(
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
    throw new LimaTemplateError("filesystem_error", `cannot inspect ${path}`, {}, { cause: error });
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
      throw new LimaTemplateError(
        "filesystem_error",
        `cannot inspect path component ${current}`,
        {},
        { cause: error },
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new LimaTemplateError("invalid_path", `path component ${current} is a symbolic link`);
    }
  }
}

async function assertRegularFile(
  path: string,
  field: string,
  code: LimaTemplateErrorCode,
): Promise<void> {
  await assertNoSymlinkComponents(path);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new LimaTemplateError(code, `${field} is unavailable`, {}, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new LimaTemplateError(code, `${field} must be a regular file`);
  }
}

async function hashRegularFile(
  path: string,
  field: string,
  code: LimaTemplateErrorCode,
): Promise<ContentHash> {
  await assertRegularFile(path, field, code);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new LimaTemplateError(code, `${field} is not a regular file`);
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      if (typeof chunk === "string") {
        hash.update(chunk, "utf8");
      } else if (chunk instanceof Uint8Array) {
        hash.update(chunk);
      } else {
        throw new LimaTemplateError(code, `${field} produced a non-byte stream chunk`);
      }
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new LimaTemplateError(code, `${field} changed while it was being hashed`);
    }
    return contentHash(hash.digest("hex"));
  } catch (error: unknown) {
    if (error instanceof LimaTemplateError) throw error;
    throw new LimaTemplateError(code, `cannot hash ${field}`, {}, { cause: error });
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

async function queryLimaVersion(options: ValidatedOptions): Promise<string> {
  const result = await runLimactl(options, ["--tty=false", "--version"]);
  const output = result.stdout.trim();
  const match = /^(?:limactl\s+)?version\s*:?\s*(\S+)$/iu.exec(output);
  const version = match?.[1] ?? /^v?([0-9][0-9A-Za-z._+-]*)$/u.exec(output)?.[1];
  if (version === undefined || !versionPattern.test(version)) {
    throw new LimaTemplateError(
      "limactl_invalid",
      "limactl --version returned an invalid Lima version",
      { stdout: result.stdout, stderr: result.stderr },
    );
  }
  return version;
}

async function runLimactl(
  options: ValidatedOptions,
  args: readonly string[],
): Promise<CommandResult> {
  await assertLimactlExecutable(options.limactlPath);
  return spawnBounded(options.limactlPath, args, {
    HOME: dirname(options.limaHome),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    LANG: "C",
    LC_ALL: "C",
    LIMA_HOME: options.limaHome,
    TMPDIR: "/tmp",
  });
}

async function assertLimactlExecutable(path: string): Promise<void> {
  await assertNoSymlinkComponents(path);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new LimaTemplateError(
      "limactl_invalid",
      "limactl executable is unavailable",
      {},
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new LimaTemplateError(
      "limactl_invalid",
      "limactl path must be a real executable regular file",
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
        new LimaTemplateError(
          "command_spawn_failed",
          "limactl process could not be started",
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
        new LimaTemplateError("command_spawn_failed", "limactl output streams could not be opened"),
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
        fail("command_spawn_failed", "limactl emitted a non-byte output chunk");
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
          fail("command_output_limit", "limactl stdout exceeded the configured output limit");
        }
      } else {
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        if (remaining > 0) {
          const retained = Buffer.from(bytes.subarray(0, remaining));
          stderrChunks.push(retained);
          stderrBytes += retained.byteLength;
        }
        if (bytes.byteLength > remaining) {
          fail("command_output_limit", "limactl stderr exceeded the configured output limit");
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
      } satisfies LimaTemplateErrorDetails;
      if (failure !== undefined) {
        reject(new LimaTemplateError(failure.code, failure.message, details));
        return;
      }
      if (exitCode !== 0) {
        reject(
          new LimaTemplateError(
            "command_failed",
            `limactl command exited unsuccessfully${exitCode === null ? "" : ` with status ${String(exitCode)}`}`,
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
      fail("command_timeout", "limactl command exceeded the configured timeout");
    }, COMMAND_TIMEOUT_MS);
    stdout.on("data", (chunk: unknown) => {
      collect("stdout", chunk);
    });
    stderr.on("data", (chunk: unknown) => {
      collect("stderr", chunk);
    });
    stdout.once("error", () => {
      stdoutEnded = true;
      fail("command_spawn_failed", "limactl stdout stream failed");
      finishIfReady();
    });
    stderr.once("error", () => {
      stderrEnded = true;
      fail("command_spawn_failed", "limactl stderr stream failed");
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
      fail("command_spawn_failed", "limactl process could not be started");
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

async function assertInstanceStoppedVz(options: ValidatedOptions): Promise<void> {
  const result = await runLimactl(options, [
    "list",
    "--tty=false",
    "--format=json",
    options.templateInstanceName,
  ]);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error: unknown) {
    throw new LimaTemplateError(
      "instance_state_invalid",
      "limactl list returned invalid JSON",
      { stdout: result.stdout, stderr: result.stderr },
      { cause: error },
    );
  }
  const record = findLimaListRecord(value, options.templateInstanceName);
  if (record === undefined) {
    throw new LimaTemplateError(
      "instance_state_invalid",
      "the Lima template instance is missing from limactl list",
      { stdout: result.stdout, stderr: result.stderr },
    );
  }
  if (record.status.toLowerCase() !== "stopped" || record.vmType.toLowerCase() !== "vz") {
    throw new LimaTemplateError(
      "instance_state_invalid",
      "the Lima template instance must be stopped and use the VZ driver",
      { stdout: result.stdout, stderr: result.stderr },
    );
  }
  if (record.dir !== undefined) {
    const normalizedDir = normalize(record.dir);
    if (
      !isAbsolute(record.dir) ||
      normalizedDir !== record.dir ||
      normalizedDir !== options.instancePath
    ) {
      throw new LimaTemplateError(
        "instance_state_invalid",
        "limactl reported an instance directory outside the configured Lima home",
        { stdout: result.stdout, stderr: result.stderr },
      );
    }
  }
}

function findLimaListRecord(value: unknown, name: string): LimaListRecord | undefined {
  const candidates: unknown[] = [];
  if (isUnknownArray(value)) candidates.push(...value);
  else if (isRecord(value) && isUnknownArray(value["instances"]))
    candidates.push(...value["instances"]);
  else candidates.push(value);
  for (const candidate of candidates) {
    if (!isRecord(candidate) || candidate["name"] !== name) continue;
    const status = candidate["status"];
    const vmType = candidate["vmType"];
    if (typeof status !== "string" || typeof vmType !== "string") return undefined;
    const dir = candidate["dir"];
    if (dir !== undefined && typeof dir !== "string") return undefined;
    return Object.freeze({ name, status, vmType, dir });
  }
  return undefined;
}

async function discoverTemplateArtifacts(options: ValidatedOptions): Promise<TemplateArtifacts> {
  await assertNoSymlinkComponents(options.instancePath);
  let instanceMetadata: Stats;
  try {
    instanceMetadata = await lstat(options.instancePath);
  } catch (error: unknown) {
    throw new LimaTemplateError(
      "template_invalid",
      "the Lima template instance directory is missing",
      {},
      { cause: error },
    );
  }
  if (instanceMetadata.isSymbolicLink() || !instanceMetadata.isDirectory()) {
    throw new LimaTemplateError(
      "template_invalid",
      "the Lima template instance path is not a real directory",
    );
  }
  const configPath = join(options.instancePath, "lima.yaml");
  await assertRegularFile(configPath, "template config", "template_invalid");
  const entries = await readdir(options.instancePath, { withFileTypes: true });
  let foundDiskPath: string | undefined;
  for (const name of ["disk", "diffdisk"] as const) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined) continue;
    const candidatePath = join(options.instancePath, name);
    if (entry.isSymbolicLink()) {
      throw new LimaTemplateError("disk_invalid", "the Lima template disk path is a symbolic link");
    }
    if (!entry.isFile()) {
      throw new LimaTemplateError(
        "disk_invalid",
        "the Lima template disk path is not a regular file",
      );
    }
    foundDiskPath ??= candidatePath;
  }
  if (foundDiskPath === undefined) {
    throw new LimaTemplateError("disk_invalid", "the Lima template disk file is missing");
  }
  await assertRegularFile(foundDiskPath, "template disk", "disk_invalid");
  return Object.freeze({ instancePath: options.instancePath, configPath, diskPath: foundDiskPath });
}

async function readTemplateConfig(path: string, diskGiB: number): Promise<TemplateConfig> {
  const text = await readTextFile(path, "template config", "template_invalid");
  let value: YamlValue;
  try {
    value = parseTemplateYaml(text);
  } catch (error: unknown) {
    if (error instanceof LimaTemplateError) throw error;
    throw new LimaTemplateError(
      "template_invalid",
      "the Lima template config is not valid YAML",
      {},
      { cause: error },
    );
  }
  validateTemplateConfigValue(value, diskGiB);
  return Object.freeze({ value });
}

function validateTemplateConfigValue(value: YamlValue, diskGiB: number): void {
  const record = requireYamlObject(value, "template config");
  assertYamlKeys(
    record,
    [
      "minimumLimaVersion",
      "vmType",
      "arch",
      "images",
      "cpus",
      "memory",
      "disk",
      "mounts",
      "mountType",
      "containerd",
      "provision",
      "probes",
      "hostResolver",
      "ssh",
      "networks",
      "portForwards",
    ],
    "template config",
  );
  const minimumLimaVersion = requireYamlString(
    record,
    "minimumLimaVersion",
    "template minimumLimaVersion",
  );
  validateVersion(minimumLimaVersion, "template minimumLimaVersion", "template_invalid");
  if (requireYamlString(record, "vmType", "template vmType").toLowerCase() !== "vz") {
    throw new LimaTemplateError("template_invalid", "the Lima template config is not VZ-backed");
  }
  if (requireYamlString(record, "mountType", "template mountType").toLowerCase() !== "virtiofs") {
    throw new LimaTemplateError(
      "template_invalid",
      "the Lima template config does not use virtiofs mounts",
    );
  }
  const architecture = optionalYamlString(record, "arch", "template arch");
  if (architecture !== undefined && architecture !== "aarch64") {
    throw new LimaTemplateError(
      "template_invalid",
      "the Lima template config architecture is invalid",
    );
  }
  const images = requireYamlArray(record["images"], "template images");
  if (images.length !== 1) {
    throw new LimaTemplateError("template_invalid", "the Lima template config must pin one image");
  }
  const image = requireYamlObject(images[0], "template image");
  assertYamlKeys(image, ["location", "arch", "digest"], "template image");
  const imageLocation = requireYamlString(image, "location", "template image location");
  let imageUrl: URL;
  try {
    imageUrl = new URL(imageLocation);
  } catch (error: unknown) {
    throw new LimaTemplateError(
      "template_invalid",
      "template image location is invalid",
      {},
      { cause: error },
    );
  }
  if (
    imageUrl.protocol !== "https:" ||
    imageUrl.username.length > 0 ||
    imageUrl.password.length > 0 ||
    imageUrl.search.length > 0 ||
    imageUrl.hash.length > 0
  ) {
    throw new LimaTemplateError(
      "template_invalid",
      "template image location must be an immutable HTTPS URL",
    );
  }
  if (requireYamlString(image, "arch", "template image architecture") !== "aarch64") {
    throw new LimaTemplateError("template_invalid", "template image architecture must be aarch64");
  }
  const imageDigest = requireYamlString(image, "digest", "template image digest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) {
    throw new LimaTemplateError("template_invalid", "template image digest is invalid");
  }
  const containerd = requireYamlObject(record["containerd"], "template containerd");
  assertYamlKeys(containerd, ["system", "user"], "template containerd");
  if (
    requireYamlBoolean(containerd, "system", "template containerd system") ||
    requireYamlBoolean(containerd, "user", "template containerd user")
  ) {
    throw new LimaTemplateError(
      "template_invalid",
      "template containerd services must be disabled",
    );
  }
  if (!isEmptyMounts(record["mounts"])) {
    throw new LimaTemplateError("template_invalid", "the Lima template config contains mounts");
  }
  if (requireYamlArray(record["portForwards"], "template portForwards").length !== 0) {
    throw new LimaTemplateError(
      "template_invalid",
      "the Lima template config contains port forwards",
    );
  }
  const hostResolver = requireYamlObject(record["hostResolver"], "template hostResolver");
  assertYamlKeys(hostResolver, ["enabled"], "template hostResolver");
  if (requireYamlBoolean(hostResolver, "enabled", "template hostResolver enabled")) {
    throw new LimaTemplateError("template_invalid", "template host resolver must be disabled");
  }
  const ssh = requireYamlObject(record["ssh"], "template ssh");
  assertYamlKeys(ssh, ["overVsock"], "template ssh");
  if (requireYamlBoolean(ssh, "overVsock", "template ssh overVsock")) {
    throw new LimaTemplateError("template_invalid", "template SSH over vsock must be disabled");
  }
  const networks = requireYamlArray(record["networks"], "template networks");
  if (networks.length !== 1) {
    throw new LimaTemplateError("template_invalid", "the Lima template must use direct VZ NAT");
  }
  const network = requireYamlObject(networks[0], "template network");
  assertYamlKeys(network, ["vzNAT"], "template network");
  if (!requireYamlBoolean(network, "vzNAT", "template network vzNAT")) {
    throw new LimaTemplateError("template_invalid", "the Lima template must use direct VZ NAT");
  }
  validateProvision(record["provision"]);
  validateProbes(record["probes"]);
  const cpus = record["cpus"];
  if (cpus !== undefined && (typeof cpus !== "number" || !Number.isSafeInteger(cpus) || cpus < 1)) {
    throw new LimaTemplateError("template_invalid", "template CPU resources are invalid");
  }
  const memory = record["memory"];
  if (memory !== undefined) parseSizeGiB(memory, "template memory");
  const disk = record["disk"];
  if (disk !== undefined && parseSizeGiB(disk, "template disk") !== diskGiB) {
    throw new LimaTemplateError(
      "template_invalid",
      "template disk configuration does not match the requested disk",
    );
  }
}

function isEmptyMounts(value: YamlValue | undefined): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

function scriptEntries(value: YamlValue | undefined, field: "provision" | "probes"): unknown {
  return requireYamlArray(value, `template ${field}`).map((entry) => {
    const record = requireYamlObject(entry, `template ${field} entry`);
    return field === "provision"
      ? Object.freeze({
          mode: requireYamlString(record, "mode", "template provision mode"),
          script: requireYamlString(record, "script", "template provision script").trim(),
        })
      : Object.freeze({
          script: requireYamlString(record, "script", "template probe script").trim(),
        });
  });
}

function assertTemplateConfigCompatible(
  source: TemplateConfig,
  active: TemplateConfig,
  diskGiB: number,
): void {
  const sourceRecord = requireYamlObject(source.value, "source template config");
  const activeRecord = requireYamlObject(active.value, "active template config");
  for (const key of [
    "minimumLimaVersion",
    "vmType",
    "mountType",
    "images",
    "containerd",
    "mounts",
    "portForwards",
    "hostResolver",
    "ssh",
    "networks",
    "provision",
    "probes",
  ] as const) {
    if (key === "mounts" && isEmptyMounts(sourceRecord[key]) && isEmptyMounts(activeRecord[key])) {
      continue;
    }
    if (
      (key === "provision" || key === "probes") &&
      canonicalJson(scriptEntries(sourceRecord[key], key)) ===
        canonicalJson(scriptEntries(activeRecord[key], key))
    ) {
      continue;
    }
    if (canonicalJson(sourceRecord[key]) !== canonicalJson(activeRecord[key])) {
      throw new LimaTemplateError("template_invalid", `active Lima template config changed ${key}`);
    }
  }
  const sourceArchitecture = sourceRecord["arch"];
  const activeArchitecture = activeRecord["arch"];
  if (
    sourceArchitecture !== undefined &&
    (activeArchitecture === undefined ||
      canonicalJson(sourceArchitecture) !== canonicalJson(activeArchitecture))
  ) {
    throw new LimaTemplateError("template_invalid", "active Lima template architecture changed");
  }
  if (
    sourceArchitecture === undefined &&
    activeArchitecture !== undefined &&
    activeArchitecture !== "aarch64"
  ) {
    throw new LimaTemplateError("template_invalid", "active Lima template architecture is invalid");
  }
  const sourceDisk = sourceRecord["disk"];
  const activeDisk = activeRecord["disk"];
  if (
    sourceDisk !== undefined &&
    (activeDisk === undefined || canonicalJson(sourceDisk) !== canonicalJson(activeDisk))
  ) {
    throw new LimaTemplateError(
      "template_invalid",
      "active Lima template disk configuration changed",
    );
  }
  if (
    sourceDisk === undefined &&
    activeDisk !== undefined &&
    parseSizeGiB(activeDisk, "active template disk") !== diskGiB
  ) {
    throw new LimaTemplateError(
      "template_invalid",
      "active Lima template disk configuration changed",
    );
  }
  for (const key of ["cpus", "memory"] as const) {
    const sourceValue = sourceRecord[key];
    const activeValue = activeRecord[key];
    if (
      (sourceValue === undefined) !== (activeValue === undefined) ||
      (sourceValue !== undefined &&
        activeValue !== undefined &&
        canonicalJson(sourceValue) !== canonicalJson(activeValue))
    ) {
      throw new LimaTemplateError(
        "template_invalid",
        `active Lima template ${key} configuration changed`,
      );
    }
  }
}

function validateProvision(value: YamlValue | undefined): void {
  if (value === undefined)
    throw new LimaTemplateError("template_invalid", "template provisioning is required");
  const entries = requireYamlArray(value, "template provision");
  if (entries.length === 0)
    throw new LimaTemplateError("template_invalid", "template provisioning is empty");
  for (const entry of entries) {
    const record = requireYamlObject(entry, "template provision entry");
    assertYamlKeys(record, ["mode", "script"], "template provision entry");
    const mode = requireYamlString(record, "mode", "template provision mode");
    if (mode !== "system" && mode !== "user") {
      throw new LimaTemplateError("template_invalid", "template provision mode is invalid");
    }
    if (requireYamlString(record, "script", "template provision script").trim().length === 0) {
      throw new LimaTemplateError("template_invalid", "template provision script is empty");
    }
  }
}

function validateProbes(value: YamlValue | undefined): void {
  if (value === undefined)
    throw new LimaTemplateError("template_invalid", "template probes are required");
  const entries = requireYamlArray(value, "template probes");
  if (entries.length === 0)
    throw new LimaTemplateError("template_invalid", "template probes are empty");
  for (const entry of entries) {
    const record = requireYamlObject(entry, "template probe entry");
    assertYamlKeys(record, ["script"], "template probe entry");
    if (requireYamlString(record, "script", "template probe script").trim().length === 0) {
      throw new LimaTemplateError("template_invalid", "template probe script is empty");
    }
  }
}

function parseTemplateYaml(text: string): YamlValue {
  if (text.includes("\0")) {
    throw new LimaTemplateError("template_invalid", "the Lima template config contains a NUL byte");
  }
  const rawLines = text.replace(/\r\n?/gu, "\n").split("\n");
  const lines: YamlLine[] = [];
  for (const [index, raw] of rawLines.entries()) {
    const leading = /^ */u.exec(raw)?.[0].length ?? 0;
    if (raw.slice(0, leading).includes("\t")) {
      throw new LimaTemplateError(
        "template_invalid",
        `template config line ${String(index + 1)} uses tabs`,
      );
    }
    const content = stripYamlComment(raw.slice(leading)).trimEnd();
    lines.push(Object.freeze({ indent: leading, content, raw, line: index + 1 }));
  }
  const state: YamlParseState = { index: 0, lines };
  const first = nextYamlLine(state);
  if (first === undefined) return null;
  const value = parseYamlBlock(state, first.indent);
  const trailing = nextYamlLine(state);
  if (trailing !== undefined) {
    throw new LimaTemplateError(
      "template_invalid",
      `template config has unexpected content on line ${String(trailing.line)}`,
    );
  }
  return value;
}

interface YamlParseState {
  index: number;
  readonly lines: readonly YamlLine[];
}

function nextYamlLine(state: YamlParseState): YamlLine | undefined {
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined) return undefined;
    if (line.content.length > 0) return line;
    state.index += 1;
  }
  return undefined;
}

function parseYamlBlock(state: YamlParseState, indent: number): YamlValue {
  const first = nextYamlLine(state);
  if (first?.indent !== indent) {
    throw new LimaTemplateError("template_invalid", "template config has invalid indentation");
  }
  if (first.content === "-" || first.content.startsWith("- ")) {
    return parseYamlSequence(state, indent);
  }
  return parseYamlMap(state, indent);
}

function parseYamlMap(state: YamlParseState, indent: number): YamlValue {
  const result: Record<string, YamlValue> = {};
  for (;;) {
    const line = nextYamlLine(state);
    if (line?.indent !== indent) break;
    if (line.content === "-" || line.content.startsWith("- ")) {
      throw new LimaTemplateError(
        "template_invalid",
        `template config sequence is not nested on line ${String(line.line)}`,
      );
    }
    const colon = findYamlColon(line.content);
    if (colon < 1) {
      throw new LimaTemplateError(
        "template_invalid",
        `template config mapping is invalid on line ${String(line.line)}`,
      );
    }
    const key = parseYamlKey(line.content.slice(0, colon), line.line);
    if (Object.hasOwn(result, key)) {
      throw new LimaTemplateError(
        "template_invalid",
        `template config contains duplicate key ${key}`,
      );
    }
    const valueText = line.content.slice(colon + 1).trim();
    state.index += 1;
    result[key] = parseYamlValue(state, indent, valueText, line.line);
  }
  return result;
}

function parseYamlSequence(state: YamlParseState, indent: number): YamlValue {
  const result: YamlValue[] = [];
  for (;;) {
    const line = nextYamlLine(state);
    if (line?.indent !== indent) break;
    if (line.content !== "-" && !line.content.startsWith("- ")) break;
    const remainder = line.content.slice(1).trim();
    state.index += 1;
    if (remainder.length === 0) {
      const nested = nextYamlLine(state);
      result.push(
        nested === undefined || nested.indent <= indent
          ? null
          : parseYamlBlock(state, nested.indent),
      );
      continue;
    }
    const colon = findYamlColon(remainder);
    if (colon < 1) {
      result.push(parseYamlScalar(remainder, line.line));
      continue;
    }
    const key = parseYamlKey(remainder.slice(0, colon), line.line);
    const map: Record<string, YamlValue> = {};
    const valueText = remainder.slice(colon + 1).trim();
    map[key] = parseYamlValue(state, indent, valueText, line.line);
    const continuation = nextYamlLine(state);
    if (continuation !== undefined && continuation.indent > indent) {
      const continuationValue = parseYamlBlock(state, continuation.indent);
      const continuationRecord = requireYamlObject(continuationValue, "template sequence mapping");
      for (const [continuationKey, continuationItem] of Object.entries(continuationRecord)) {
        if (Object.hasOwn(map, continuationKey)) {
          throw new LimaTemplateError(
            "template_invalid",
            `template config contains duplicate key ${continuationKey}`,
          );
        }
        map[continuationKey] = continuationItem;
      }
    }
    result.push(map);
  }
  return result;
}

function parseYamlValue(
  state: YamlParseState,
  parentIndent: number,
  valueText: string,
  line: number,
): YamlValue {
  if (valueText === "") {
    const nested = nextYamlLine(state);
    if (nested === undefined || nested.indent < parentIndent) return null;
    if (
      nested.indent === parentIndent &&
      nested.content !== "-" &&
      !nested.content.startsWith("- ")
    ) {
      return null;
    }
    return parseYamlBlock(state, nested.indent);
  }
  if (/^[|>][-+]?$/u.test(valueText)) {
    return parseYamlBlockScalar(state, parentIndent, valueText);
  }
  return parseYamlScalar(valueText, line);
}

function parseYamlBlockScalar(
  state: YamlParseState,
  parentIndent: number,
  indicator: string,
): string {
  const block: YamlLine[] = [];
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined) break;
    if (line.raw.trim().length > 0 && line.indent <= parentIndent) break;
    block.push(line);
    state.index += 1;
  }
  const nonEmpty = block.filter((line) => line.raw.trim().length > 0);
  const baseIndent =
    nonEmpty.length === 0 ? parentIndent + 1 : Math.min(...nonEmpty.map((line) => line.indent));
  const content = block.map((line) => {
    if (line.raw.trim().length === 0) return "";
    if (line.raw.length < baseIndent) {
      throw new LimaTemplateError(
        "template_invalid",
        "template config block scalar indentation is invalid",
      );
    }
    return line.raw.slice(baseIndent);
  });
  let result = content.join("\n");
  if (!indicator.endsWith("-")) result += "\n";
  if (indicator.endsWith("+")) {
    const trailing = block.filter((line) => line.raw.trim().length === 0).length;
    result += "\n".repeat(trailing);
  }
  return result;
}

function parseYamlScalar(valueText: string, line: number): YamlValue {
  const value = valueText.trim();
  if (value === "[]" || value === "{}") return value === "[]" ? [] : {};
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitYamlFlow(inner, line).map((part) => parseYamlScalar(part, line));
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim();
    const result: Record<string, YamlValue> = {};
    if (inner.length === 0) return result;
    for (const part of splitYamlFlow(inner, line)) {
      const colon = findYamlColon(part);
      if (colon < 1)
        throw new LimaTemplateError(
          "template_invalid",
          `template flow mapping is invalid on line ${String(line)}`,
        );
      const key = parseYamlKey(part.slice(0, colon), line);
      if (Object.hasOwn(result, key))
        throw new LimaTemplateError(
          "template_invalid",
          `template config contains duplicate key ${key}`,
        );
      result[key] = parseYamlScalar(part.slice(colon + 1), line);
    }
    return result;
  }
  if (value.startsWith("&") || value.startsWith("*") || value.startsWith("!")) {
    throw new LimaTemplateError(
      "template_invalid",
      `template config aliases and tags are forbidden on line ${String(line)}`,
    );
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return unquoteYaml(value, line);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number))
      throw new LimaTemplateError(
        "template_invalid",
        `template number is invalid on line ${String(line)}`,
      );
    return number;
  }
  return value;
}

function unquoteYaml(value: string, line: number): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch (error: unknown) {
      throw new LimaTemplateError(
        "template_invalid",
        `template string is invalid on line ${String(line)}`,
        {},
        { cause: error },
      );
    }
  } else {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  throw new LimaTemplateError(
    "template_invalid",
    `template string is invalid on line ${String(line)}`,
  );
}

function splitYamlFlow(value: string, line: number): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (character === quote && value[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") depth -= 1;
    if (depth < 0)
      throw new LimaTemplateError(
        "template_invalid",
        `template flow value is invalid on line ${String(line)}`,
      );
    if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote !== undefined || depth !== 0)
    throw new LimaTemplateError(
      "template_invalid",
      `template flow value is invalid on line ${String(line)}`,
    );
  parts.push(value.slice(start).trim());
  if (parts.some((part) => part.length === 0))
    throw new LimaTemplateError(
      "template_invalid",
      `template flow value is invalid on line ${String(line)}`,
    );
  return parts;
}

function parseYamlKey(value: string, line: number): string {
  const parsed = parseYamlScalar(value.trim(), line);
  if (typeof parsed !== "string" || parsed.length === 0) {
    throw new LimaTemplateError(
      "template_invalid",
      `template mapping key is invalid on line ${String(line)}`,
    );
  }
  return parsed;
}

function findYamlColon(value: string): number {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (character === quote && value[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ":" && (index + 1 === value.length || /\s/u.test(value[index + 1] ?? ""))) {
      return index;
    }
  }
  return -1;
}

function stripYamlComment(value: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (character === quote && value[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function requireYamlObject(
  value: YamlValue | undefined,
  field: string,
): Readonly<Record<string, YamlValue>> {
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LimaTemplateError("template_invalid", `${field} must be an object`);
  }
  return value;
}

function requireYamlArray(value: YamlValue | undefined, field: string): readonly YamlValue[] {
  if (!Array.isArray(value))
    throw new LimaTemplateError("template_invalid", `${field} must be an array`);
  return value;
}

function requireYamlString(
  record: Readonly<Record<string, YamlValue>>,
  key: string,
  field: string,
): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new LimaTemplateError("template_invalid", `${field} must be text`);
  return value;
}

function optionalYamlString(
  record: Readonly<Record<string, YamlValue>>,
  key: string,
  field: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return requireYamlString(record, key, field);
}

function requireYamlBoolean(
  record: Readonly<Record<string, YamlValue>>,
  key: string,
  field: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean")
    throw new LimaTemplateError("template_invalid", `${field} must be boolean`);
  return value;
}

function assertYamlKeys(
  record: Readonly<Record<string, YamlValue>>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new LimaTemplateError(
      "template_invalid",
      `${field} contains unsupported field ${unknown}`,
    );
  }
}

function parseSizeGiB(value: YamlValue, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const match = /^([1-9][0-9]*)(?:GiB|G)?$/u.exec(value.trim());
    if (match !== null) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  throw new LimaTemplateError("template_invalid", `${field} must be a positive GiB value`);
}
async function readTextFile(
  path: string,
  field: string,
  code: LimaTemplateErrorCode,
): Promise<string> {
  await assertRegularFile(path, field, code);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new LimaTemplateError(code, `${field} is unavailable`, {}, { cause: error });
  }
  if (metadata.size > MAX_RECEIPT_BYTES) {
    throw new LimaTemplateError(code, `${field} exceeds the configured size limit`);
  }
  try {
    const bytes = await readFile(path);
    return bytes.toString("utf8");
  } catch (error: unknown) {
    throw new LimaTemplateError(code, `cannot read ${field}`, {}, { cause: error });
  }
}

async function makeReadOnly(path: string, field: string): Promise<void> {
  await assertRegularFile(path, field, "filesystem_error");
  try {
    await chmod(path, 0o444);
  } catch (error: unknown) {
    throw new LimaTemplateError(
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
    throw new LimaTemplateError(
      "filesystem_error",
      `cannot inspect ${field}`,
      {},
      { cause: error },
    );
  }
  if ((metadata.mode & 0o222) !== 0) {
    throw new LimaTemplateError("filesystem_error", `${field} is writable`);
  }
}

async function makeDirectoryReadOnly(path: string, field: string): Promise<void> {
  await assertDirectory(path, field);
  try {
    await chmod(path, 0o555);
  } catch (error: unknown) {
    throw new LimaTemplateError(
      "filesystem_error",
      `cannot make ${field} read-only`,
      {},
      { cause: error },
    );
  }
  await assertDirectoryReadOnly(path, field);
}

async function assertDirectory(path: string, field: string): Promise<void> {
  await assertNoSymlinkComponents(path);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new LimaTemplateError(
      "filesystem_error",
      `cannot inspect ${field}`,
      {},
      { cause: error },
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LimaTemplateError("filesystem_error", `${field} must be a real directory`);
  }
}

async function assertDirectoryReadOnly(path: string, field: string): Promise<void> {
  await assertDirectory(path, field);
  const metadata = await lstat(path);
  if ((metadata.mode & 0o222) !== 0) {
    throw new LimaTemplateError("filesystem_error", `${field} is writable`);
  }
}

async function writeReceiptAtomically(path: string, receipt: LimaTemplateReceipt): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    if ((await existingPath(path)) !== undefined) {
      throw new LimaTemplateError("receipt_exists", "the Lima template receipt already exists");
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
    if (error instanceof LimaTemplateError) throw error;
    throw new LimaTemplateError(
      "receipt_write_failed",
      "cannot atomically write the Lima template receipt",
      {},
      { cause: error },
    );
  } finally {
    if (handle !== undefined) await handle.close();
    if (!renamed) await rm(temporaryPath, { force: true });
  }
}

async function readReceipt(path: string): Promise<LimaTemplateReceipt> {
  await assertRegularFile(path, "template receipt", "receipt_missing");
  await assertReadOnly(path, "template receipt");
  const text = await readTextFile(path, "template receipt", "receipt_invalid");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new LimaTemplateError(
      "receipt_invalid",
      "the Lima template receipt is not valid JSON",
      {},
      { cause: error },
    );
  }
  return validateReceipt(value);
}

function validateReceipt(value: unknown): LimaTemplateReceipt {
  const record = asRecord(value, "template receipt", "receipt_invalid");
  assertExactKeys(record, receiptKeys, "template receipt");
  if (record["schemaVersion"] !== 1) {
    throw new LimaTemplateError("receipt_invalid", "template receipt schemaVersion must be 1");
  }
  if (record["architecture"] !== "aarch64") {
    throw new LimaTemplateError("receipt_invalid", "template receipt architecture must be aarch64");
  }
  const instanceName = validateInstanceName(record["instanceName"]);
  const limaVersion = validateVersion(
    record["limaVersion"],
    "receipt Lima version",
    "receipt_invalid",
  );
  const runtimeVersion = validateVersion(
    record["runtimeVersion"],
    "receipt runtime version",
    "receipt_invalid",
  );
  const sourceTemplateDigest = validateDigest(
    record["sourceTemplateDigest"],
    "receipt source template digest",
    "receipt_invalid",
  );
  const configDigest = validateDigest(
    record["configDigest"],
    "receipt config digest",
    "receipt_invalid",
  );
  const diskDigest = validateDigest(record["diskDigest"], "receipt disk digest", "receipt_invalid");
  const diskGiB = record["diskGiB"];
  if (typeof diskGiB !== "number" || !Number.isSafeInteger(diskGiB) || diskGiB < 16) {
    throw new LimaTemplateError("receipt_invalid", "template receipt diskGiB is invalid");
  }
  const fingerprint = validateFingerprint(record["fingerprint"], "template receipt fingerprint");
  return Object.freeze({
    schemaVersion: 1,
    instanceName,
    architecture: "aarch64",
    limaVersion,
    runtimeVersion,
    sourceTemplateDigest,
    configDigest,
    diskDigest,
    diskGiB,
    fingerprint,
  });
}

function validateFingerprint(value: unknown, field: string): SandboxPolicyFingerprint {
  const record = asRecord(value, field, "receipt_invalid");
  assertExactKeys(record, fingerprintKeys, field);
  if (record["policyVersion"] !== 1) {
    throw new LimaTemplateError("receipt_invalid", `${field} policyVersion must be 1`);
  }
  const digest = validateDigest(record["digest"], `${field} digest`, "receipt_invalid");
  return Object.freeze({ policyVersion: 1, digest });
}

function assertExactKeys(record: UnknownRecord, expected: readonly string[], field: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new LimaTemplateError("receipt_invalid", `${field} contains unknown or missing fields`);
  }
}

function fingerprintFor(
  receipt: Readonly<{
    schemaVersion: 1;
    instanceName: string;
    architecture: "aarch64";
    limaVersion: string;
    runtimeVersion: string;
    sourceTemplateDigest: ContentHash;
    configDigest: ContentHash;
    diskDigest: ContentHash;
    diskGiB: number;
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
  throw new LimaTemplateError(
    "receipt_invalid",
    "template receipt contains an unserializable value",
  );
}

function assertRuntimeVersion(output: string, expected: string): void {
  const normalized = output.trim();
  if (
    normalized !== expected &&
    normalized !== `omp ${expected}` &&
    normalized !== `omp/${expected}` &&
    normalized !== `omp version ${expected}` &&
    normalized !== `version ${expected}`
  ) {
    throw new LimaTemplateError(
      "runtime_version_mismatch",
      "omp --version did not match the pinned runtime version",
      { stdout: output },
    );
  }
}

async function instanceIdentity(path: string): Promise<InstanceIdentity> {
  await assertNoSymlinkComponents(path);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new LimaTemplateError(
        "template_invalid",
        "the created Lima instance path is not a real directory",
      );
    }
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } catch (error: unknown) {
    if (error instanceof LimaTemplateError) throw error;
    throw new LimaTemplateError(
      "template_invalid",
      "the created Lima instance directory is unavailable",
      {},
      { cause: error },
    );
  }
}

async function cleanupBuilderInstance(
  options: ValidatedOptions,
  expectedIdentity: InstanceIdentity,
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(options.instancePath);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return;
    throw new LimaTemplateError(
      "cleanup_failed",
      "cannot inspect the failed builder instance",
      {},
      { cause: error },
    );
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== expectedIdentity.device ||
    metadata.ino !== expectedIdentity.inode
  ) {
    return;
  }
  let stopError: unknown;
  try {
    await runLimactl(options, ["stop", "--tty=false", options.templateInstanceName]);
  } catch (error: unknown) {
    stopError = error;
  }
  try {
    await runLimactl(options, ["delete", "--tty=false", "--force", options.templateInstanceName]);
  } catch (error: unknown) {
    if (stopError !== undefined) {
      throw new LimaTemplateError(
        "cleanup_failed",
        "failed to stop and delete the failed Lima template builder instance",
        {},
        { cause: error },
      );
    }
    throw error;
  }
}

function asTemplateError(
  error: unknown,
  code: LimaTemplateErrorCode,
  message: string,
): LimaTemplateError {
  if (error instanceof LimaTemplateError) return error;
  return new LimaTemplateError(code, message, {}, { cause: error });
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
