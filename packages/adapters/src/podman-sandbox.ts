import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  contentHash,
  attemptId,
  hostId,
  repositoryId,
  taskNodeId,
  type CreateSandboxRequest,
  type ExecuteSandboxRequest,
  type SandboxAttemptContext,
  type SandboxBackendKind,
  type SandboxCapabilityProbe,
  type SandboxExecutionResult,
  type SandboxInstance,
  type SandboxLifecycle,
  type SandboxPolicy,
  type SandboxPolicyFingerprint,
  SandboxDeniedError,
  type SandboxDenialCode,
} from "@minions/core";
import {
  createSandboxPolicyFingerprinter,
  validateSandboxCommand,
  validateSandboxPolicy,
} from "./sandbox-policy.js";
import {
  PodmanImageError,
  verifyPodmanImage,
  type PodmanImageBuildOptions,
  type PodmanImageReceipt,
} from "./podman-image.js";

export type PodmanSandboxErrorCode =
  | "invalid_configuration"
  | "capability_unavailable"
  | "template_mismatch"
  | "policy_mismatch"
  | "instance_conflict"
  | "instance_not_found"
  | "instance_state_invalid"
  | "command_failed"
  | "command_timeout"
  | "output_limit"
  | "receipt_invalid"
  | "network_policy_invalid"
  | "filesystem_error"
  | "wsl_context_invalid";

export class PodmanSandboxError extends Error {
  readonly code: PodmanSandboxErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: PodmanSandboxErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PodmanSandboxError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

export type PodmanSandboxOptions = Readonly<{
  storageRoot: string;
  stateRoot: string;
  podmanPath: string;
  seccompProfilePath: string;
  template: PodmanImageBuildOptions;
  expectedTemplateFingerprint: SandboxPolicyFingerprint;
  wslDistroName?: string;
}>;

type PodmanContainerState = "created" | "running" | "stopped" | "destroyed";

type PodmanContainerInspection = Readonly<{
  name: string;
  state: "configured" | "created" | "running" | "stopped" | "exited";
}>;

type SandboxReceipt = Readonly<{
  schemaVersion: 1;
  instanceId: string;
  containerName: string;
  backendKind: "linux_podman" | "wsl2_podman";
  context: SandboxAttemptContext;
  idempotencyKey: string;
  policy: SandboxPolicy;
  policyFingerprint: SandboxPolicyFingerprint;
  templateFingerprint: SandboxPolicyFingerprint;
  guestHome: string;
  state: PodmanContainerState;
}>;

type CommandRequest = Readonly<{
  arguments: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}>;

type CommandResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

type UnknownRecord = Record<string, unknown>;

const receiptSchemaVersion = 1;
const lifecycleCommandTimeoutMs = 120_000;
const lifecycleStartTimeoutMs = 600_000;
const lifecycleOutputLimit = 1_048_576;
const guestHomePath = "/home/minions";
const instanceNamePattern = /^minions-[a-f0-9]{24}$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const windowsMountPrefixes = ["/mnt/"] as const;
const windowsInteropMarkers = [
  "/init",
  "/run/WSL",
  "/proc/sys/fs/binfmt_misc",
  "/usr/bin/wslpath",
  "/mnt/c/Windows/System32",
  "/mnt/wslg",
] as const;

export function createLinuxPodmanSandboxLifecycle(options: PodmanSandboxOptions): SandboxLifecycle {
  return new PodmanSandboxLifecycle(validateOptions(options, "linux_podman"));
}

export function createWsl2PodmanSandboxLifecycle(options: PodmanSandboxOptions): SandboxLifecycle {
  return new PodmanSandboxLifecycle(validateOptions(options, "wsl2_podman"));
}

class PodmanSandboxLifecycle implements SandboxLifecycle {
  readonly backendKind: SandboxBackendKind;
  readonly #options: PodmanSandboxOptions;
  readonly #wslDistroName: string | undefined;
  readonly #fingerprinter = createSandboxPolicyFingerprinter();

  constructor(options: PodmanSandboxOptions) {
    this.#options = options;
    this.backendKind = options.wslDistroName === undefined ? "linux_podman" : "wsl2_podman";
    this.#wslDistroName = options.wslDistroName;
  }

  async probe(): Promise<SandboxCapabilityProbe> {
    try {
      const template = await this.#requireImage();
      if (this.backendKind === "wsl2_podman") {
        await this.#assertWslContext();
      } else {
        this.#assertLinuxContext();
      }
      const version = await this.#runHost([this.#options.podmanPath, "--version"], 10_000, 16_384);
      if (version.exitCode !== 0) {
        throw new PodmanSandboxError(
          "capability_unavailable",
          "podman --version failed during capability probe",
          "Install the configured rootless Podman version and rerun host doctor.",
          version.stderr,
        );
      }
      const nestedContainers = await this.#probeNestedContainerSupport();
      return Object.freeze({
        available: true,
        backendKind: this.backendKind,
        backendVersion: decode(version.stdout).trim(),
        templateFingerprint: template.fingerprint.digest,
        capabilities: Object.freeze({
          readOnlyMounts: true,
          processIsolation: true,
          privateNetworkBlocking: true,
          toolFiltering: true,
          nestedContainers,
          supportedNetworkProfiles: [
            "explore",
            "implementation",
            "research",
            "gate",
            "maintenance",
          ] as const,
        }),
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "unknown Podman capability failure";
      const remediation =
        error instanceof PodmanSandboxError || error instanceof PodmanImageError
          ? error.remediation
          : "Run host doctor and inspect the rootless Podman installation.";
      return Object.freeze({
        available: false,
        backendKind: this.backendKind,
        failureCode: errorCode(error),
        message: `${detail} Remediation: ${remediation}`,
      });
    }
  }

  async create(request: CreateSandboxRequest): Promise<SandboxInstance> {
    const template = await this.#requireImage();
    const policy = validateSandboxPolicy(request.policy);
    const actualFingerprint = this.#fingerprinter.fingerprint(policy);
    assertFingerprint(
      this.#options.expectedTemplateFingerprint,
      template.fingerprint,
      "Podman image",
    );
    if (policy.templateDigest !== template.fingerprint.digest) {
      throw new PodmanSandboxError(
        "template_mismatch",
        "sandbox policy template digest does not match the verified Podman image",
        "Create the policy from the currently verified Podman image.",
      );
    }
    if (!sameFingerprint(request.policyFingerprint, actualFingerprint)) {
      throw new SandboxDeniedError(
        "policy_fingerprint_mismatch",
        "create",
        "sandbox policy fingerprint does not match the canonical policy",
      );
    }
    await assertHostMounts(policy, this.backendKind, this.#options);

    const instanceId = deterministicInstanceId(request);
    const prior = await this.#readReceipt(instanceId);
    if (prior !== undefined) {
      if (prior.state === "destroyed") {
        throw new SandboxDeniedError(
          "idempotency_conflict",
          "create",
          "idempotency key points to a destroyed Podman sandbox",
        );
      }
      assertReplay(prior, request, template.fingerprint, actualFingerprint);
      const inspection = await this.#inspect(instanceId);
      if (inspection === undefined) {
        throw new PodmanSandboxError(
          "instance_not_found",
          "durable sandbox receipt points to a missing Podman container",
          "Restore or explicitly purge the failed node before retrying.",
        );
      }
      return receiptInstance(prior, inspection.state);
    }
    const unknown = await this.#inspect(instanceId);
    if (unknown !== undefined) {
      await this.#reconcileOrphan(instanceId, unknown);
    }

    await mkdir(this.#receiptDirectory(), { recursive: true, mode: 0o700 });
    const containerName = instanceId;
    const flagSet = containerFlagSet(policy, this.#options, containerName);
    try {
      await this.#runChecked(
        [this.#options.podmanPath, "create", ...flagSet.createArguments],
        lifecycleStartTimeoutMs,
        lifecycleOutputLimit,
      );
      await this.#runChecked(
        [this.#options.podmanPath, "start", containerName],
        lifecycleStartTimeoutMs,
        lifecycleOutputLimit,
      );
      await this.#probeGuest(containerName, policy);
      const receipt: SandboxReceipt = Object.freeze({
        schemaVersion: receiptSchemaVersion,
        instanceId,
        containerName,
        backendKind: this.backendKind as SandboxReceipt["backendKind"],
        context: request.context,
        idempotencyKey: request.idempotencyKey,
        policy,
        policyFingerprint: actualFingerprint,
        templateFingerprint: template.fingerprint,
        guestHome: guestHomePath,
        state: "created",
      });
      await this.#writeReceipt(receipt);
      return receiptInstance(receipt, "running");
    } catch (error: unknown) {
      await this.#deleteFailedContainer(containerName, error);
      throw error;
    }
  }

  async execute(request: ExecuteSandboxRequest): Promise<SandboxExecutionResult> {
    const receipt = await this.#requireReceipt(request.instanceId);
    if (receipt.state === "destroyed") {
      throw new SandboxDeniedError("instance_not_found", "execute", "sandbox was destroyed");
    }
    assertFingerprint(receipt.policyFingerprint, request.expectedPolicyFingerprint, "execute");
    const inspection = await this.#requireInspection(request.instanceId);
    if (inspection.state !== "running") {
      throw new PodmanSandboxError(
        "instance_state_invalid",
        "sandbox execution requires a running Podman container",
        "Start a new attempt or explicitly reconcile the stopped container.",
      );
    }
    await enforceExecutionPolicy(receipt.policy, request, this.backendKind);
    const environment = executionEnvironment(request.environment);
    const command = [
      this.#options.podmanPath,
      "exec",
      "--user",
      "minions",
      "--workdir",
      request.workingDirectory,
      "--env",
      `HOME=${receipt.guestHome}`,
      ...environment.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      receipt.containerName,
      "--",
      request.executable,
      ...request.arguments,
    ];
    const result = await this.#runHost(
      command,
      request.timeoutMs + 5_000,
      Math.min(lifecycleOutputLimit, request.maxOutputBytes + 65_536),
    );
    if (result.stdout.byteLength + result.stderr.byteLength > request.maxOutputBytes) {
      throw new PodmanSandboxError(
        "output_limit",
        "Podman exec exceeded its bounded output limit",
        "Inspect the container logs directly and resolve the noisy operation.",
      );
    }
    await this.#writeReceipt(Object.freeze({ ...receipt, state: "running" }));
    return Object.freeze({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  async stop(
    instanceId: string,
    expectedPolicyFingerprint: SandboxPolicyFingerprint,
  ): Promise<void> {
    const receipt = await this.#requireReceipt(instanceId);
    if (receipt.state === "destroyed") {
      throw new SandboxDeniedError("instance_not_found", "stop", "sandbox was destroyed");
    }
    assertFingerprint(receipt.policyFingerprint, expectedPolicyFingerprint, "stop");
    const inspection = await this.#requireInspection(instanceId);
    if (inspection.state === "running") {
      await this.#runChecked(
        [this.#options.podmanPath, "stop", "--time=10", instanceId],
        lifecycleCommandTimeoutMs,
        lifecycleOutputLimit,
      );
    }
    await this.#writeReceipt(Object.freeze({ ...receipt, state: "stopped" }));
  }

  async destroy(
    instanceId: string,
    expectedPolicyFingerprint: SandboxPolicyFingerprint,
  ): Promise<void> {
    const receipt = await this.#readReceipt(instanceId);
    if (receipt === undefined) {
      const unknown = await this.#inspect(instanceId);
      if (unknown !== undefined) {
        throw new PodmanSandboxError(
          "receipt_invalid",
          "cannot destroy an unbound Podman sandbox without its durable receipt",
          "Restore the receipt or explicitly remove the verified orphan through host maintenance.",
        );
      }
      return;
    }
    assertFingerprint(receipt.policyFingerprint, expectedPolicyFingerprint, "destroy");
    if (receipt.state === "destroyed") return;
    const inspection = await this.#inspect(instanceId);
    if (inspection !== undefined) {
      await this.#runChecked(
        [this.#options.podmanPath, "rm", "--force", "--time=10", instanceId],
        lifecycleCommandTimeoutMs,
        lifecycleOutputLimit,
      );
    }
    await this.#writeReceipt(Object.freeze({ ...receipt, state: "destroyed" }));
  }

  async #requireImage(): Promise<PodmanImageReceipt> {
    if (this.backendKind === "wsl2_podman") {
      await this.#assertWslContext();
    } else {
      this.#assertLinuxContext();
    }
    return verifyPodmanImage(this.#options.template, this.#options.expectedTemplateFingerprint);
  }

  #assertLinuxContext(): void {
    if (platform() !== "linux") {
      throw new PodmanSandboxError(
        "capability_unavailable",
        "the Linux Podman backend requires a Linux host",
        "Select the WSL2 Podman backend on Windows or attach a Linux execution host.",
      );
    }
  }

  async #assertWslContext(): Promise<void> {
    if (platform() !== "linux") {
      throw new PodmanSandboxError(
        "capability_unavailable",
        "the WSL2 Podman backend requires a Linux WSL2 distribution",
        "Select the Linux Podman backend on bare Linux or attach a WSL2 execution host.",
      );
    }
    const distroName = this.#wslDistroName;
    if (distroName === undefined) {
      throw new PodmanSandboxError(
        "wsl_context_invalid",
        "the WSL2 Podman backend requires a named distribution",
        "Configure the expected WSL2 distribution name before registering the host.",
      );
    }
    const activeDistro = process.env["WSL_DISTRO_NAME"];
    if (typeof activeDistro !== "string" || activeDistro !== distroName) {
      throw new PodmanSandboxError(
        "wsl_context_invalid",
        "the WSL2 Podman backend is not running inside the configured named distribution",
        `Run inside the WSL2 distribution ${distroName} or reconfigure the host.`,
      );
    }
    const result = await this.#runHost(["systemctl", "is-system-running"], 10_000, 4_096);
    const state = decode(result.stdout).trim();
    if (result.exitCode !== 0 || (state !== "running" && state !== "degraded")) {
      throw new PodmanSandboxError(
        "wsl_context_invalid",
        "the WSL2 distribution does not have systemd active",
        "Enable systemd in the WSL2 distribution and rerun host doctor.",
      );
    }
  }

  async #probeNestedContainerSupport(): Promise<boolean> {
    const result = await this.#runHost(
      [this.#options.podmanPath, "info", "--format", "json"],
      lifecycleCommandTimeoutMs,
      lifecycleOutputLimit,
    );
    if (result.exitCode !== 0) return false;
    let value: unknown;
    try {
      value = JSON.parse(decode(result.stdout));
    } catch {
      return false;
    }
    if (!isRecord(value)) return false;
    const host = value["host"];
    if (!isRecord(host)) return false;
    const security = host["security"];
    if (!isRecord(security)) return false;
    return Boolean(security["rootless"]);
  }

  async #probeGuest(containerName: string, policy: SandboxPolicy): Promise<void> {
    await this.#runChecked(
      [
        this.#options.podmanPath,
        "exec",
        "--user",
        "minions",
        containerName,
        "--",
        "node",
        "--version",
      ],
      lifecycleCommandTimeoutMs,
      4_096,
    );
    if (policy.tools.allowedExecutables.includes("git")) {
      await this.#runChecked(
        [
          this.#options.podmanPath,
          "exec",
          "--user",
          "minions",
          containerName,
          "--",
          "git",
          "--version",
        ],
        lifecycleCommandTimeoutMs,
        4_096,
      );
    }
  }

  async #inspect(instanceId: string): Promise<PodmanContainerInspection | undefined> {
    if (!instanceNamePattern.test(instanceId)) {
      throw new PodmanSandboxError(
        "receipt_invalid",
        "Podman container name is invalid",
        "Inspect the durable sandbox registry before retrying.",
      );
    }
    const result = await this.#runHost(
      [this.#options.podmanPath, "container", "inspect", "--format", "json", instanceId],
      lifecycleCommandTimeoutMs,
      lifecycleOutputLimit,
    );
    if (result.exitCode !== 0) {
      const stderrText = decode(result.stderr).trim();
      if (/no such container|not found|does not exist/iu.test(stderrText)) return undefined;
      throw commandError("podman container inspect failed", result);
    }
    let value: unknown;
    try {
      value = JSON.parse(decode(result.stdout));
    } catch (error: unknown) {
      throw new PodmanSandboxError(
        "receipt_invalid",
        "podman container inspect returned invalid JSON",
        "Upgrade Podman to the supported version and rerun host doctor.",
        error,
      );
    }
    if (!isUnknownArray(value) || value.length !== 1) {
      throw new PodmanSandboxError(
        "receipt_invalid",
        "podman container inspect did not return a single record",
        "Upgrade Podman to the supported version and rerun host doctor.",
      );
    }
    const record = value[0];
    if (!isRecord(record)) {
      throw new PodmanSandboxError(
        "receipt_invalid",
        "podman container inspect record is not an object",
        "Upgrade Podman to the supported version and rerun host doctor.",
      );
    }
    const name = record["Name"];
    const stateRecord = record["State"];
    if (typeof name !== "string" || !isRecord(stateRecord)) {
      throw new PodmanSandboxError(
        "receipt_invalid",
        "podman container inspect returned a malformed record",
        "Upgrade Podman to the supported version and rerun host doctor.",
      );
    }
    const status = stateRecord["Status"];
    if (
      typeof status !== "string" ||
      (status !== "created" &&
        status !== "configured" &&
        status !== "running" &&
        status !== "stopped" &&
        status !== "exited")
    ) {
      throw new PodmanSandboxError(
        "receipt_invalid",
        "podman container inspect returned an invalid state",
        "Upgrade Podman to the supported version and rerun host doctor.",
      );
    }
    return Object.freeze({ name, state: status });
  }

  async #requireInspection(instanceId: string): Promise<PodmanContainerInspection> {
    const inspection = await this.#inspect(instanceId);
    if (inspection === undefined) {
      throw new PodmanSandboxError(
        "instance_not_found",
        "Podman sandbox container is missing",
        "Reconcile the node and create a new attempt.",
      );
    }
    return inspection;
  }

  async #reconcileOrphan(instanceId: string, inspection: PodmanContainerInspection): Promise<void> {
    if (inspection.name !== instanceId) {
      throw new PodmanSandboxError(
        "instance_conflict",
        "orphaned Podman container name does not match the requested sandbox",
        "Inspect and explicitly remove the conflicting Podman container.",
      );
    }
    await this.#runChecked(
      [this.#options.podmanPath, "rm", "--force", "--time=10", instanceId],
      lifecycleCommandTimeoutMs,
      lifecycleOutputLimit,
    );
    const remaining = await this.#inspect(instanceId);
    if (remaining !== undefined) {
      throw new PodmanSandboxError(
        "instance_conflict",
        "orphaned Podman container could not be reconciled",
        "Inspect and explicitly remove the orphaned Podman container before retrying.",
      );
    }
  }

  async #runChecked(
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<CommandResult> {
    const result = await this.#runHost(arguments_, timeoutMs, maxOutputBytes);
    if (result.exitCode !== 0) throw commandError("Podman command failed", result);
    return result;
  }

  #runHost(
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<CommandResult> {
    const executable = arguments_[0];
    if (executable === undefined) {
      return Promise.reject(
        new PodmanSandboxError(
          "command_failed",
          "Podman command is empty",
          "Inspect the sandbox lifecycle configuration before retrying.",
        ),
      );
    }
    const rest = arguments_.slice(1);
    return runHostCommand(executable, rest, podmanHostEnvironment(this.#options.storageRoot), {
      arguments: arguments_,
      timeoutMs,
      maxOutputBytes,
    });
  }

  async #deleteFailedContainer(containerName: string, original: unknown): Promise<void> {
    try {
      const inspection = await this.#inspect(containerName);
      if (inspection !== undefined) {
        await this.#runHost(
          [this.#options.podmanPath, "rm", "--force", "--time=10", containerName],
          lifecycleCommandTimeoutMs,
          lifecycleOutputLimit,
        );
      }
      await rm(this.#receiptPath(containerName), { force: true });
    } catch (cleanupError: unknown) {
      const originalMessage =
        original instanceof Error ? original.message : "unknown creation failure";
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : "unknown cleanup failure";
      throw new AggregateError(
        [original, cleanupError],
        `sandbox creation failed: ${originalMessage}; cleanup failed: ${cleanupMessage}`,
        { cause: cleanupError },
      );
    }
  }

  async #requireReceipt(instanceId: string): Promise<SandboxReceipt> {
    const receipt = await this.#readReceipt(instanceId);
    if (receipt === undefined) {
      throw new PodmanSandboxError(
        "instance_not_found",
        "sandbox receipt is missing",
        "Reconcile the node and create a new attempt.",
      );
    }
    return receipt;
  }

  async #readReceipt(instanceId: string): Promise<SandboxReceipt | undefined> {
    if (!instanceNamePattern.test(instanceId)) {
      throw new PodmanSandboxError(
        "receipt_invalid",
        "sandbox instance ID is invalid",
        "Inspect the durable sandbox registry.",
      );
    }
    const path = this.#receiptPath(instanceId);
    let bytes: string;
    try {
      bytes = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    const receipt = parseReceipt(bytes, instanceId, this.backendKind);
    if (!sameFingerprint(receipt.templateFingerprint, this.#options.expectedTemplateFingerprint)) {
      throw new PodmanSandboxError(
        "template_mismatch",
        "sandbox receipt template fingerprint does not match the configured Podman image",
        "Rebuild the sandbox from the verified Podman image.",
      );
    }
    return receipt;
  }

  async #writeReceipt(receipt: SandboxReceipt): Promise<void> {
    const directory = this.#receiptDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertSecureDirectory(directory);
    await chmod(directory, 0o700);
    const target = this.#receiptPath(receipt.instanceId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      await writeFile(temporary, `${JSON.stringify(receipt)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const descriptor = openSync(temporary, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      renamed = true;
      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error: unknown) {
      throw new PodmanSandboxError(
        "filesystem_error",
        "cannot durably write the Podman sandbox receipt",
        "Inspect the dedicated sandbox state directory before retrying.",
        { cause: error },
      );
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  #receiptDirectory(): string {
    return join(this.#options.stateRoot, "podman-sandboxes", this.backendKind);
  }

  #receiptPath(instanceId: string): string {
    return join(this.#receiptDirectory(), `${instanceId}.json`);
  }
}

function podmanHostEnvironment(storageRoot: string): NodeJS.ProcessEnv {
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  return Object.freeze({
    HOME: dirname(storageRoot),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
    LANG: "C",
    LC_ALL: "C",
    ...(runtimeDir === undefined ? {} : { XDG_RUNTIME_DIR: runtimeDir }),
    ...(process.env["DBUS_SESSION_BUS_ADDRESS"] === undefined
      ? {}
      : { DBUS_SESSION_BUS_ADDRESS: process.env["DBUS_SESSION_BUS_ADDRESS"] }),
    MINIONS_PODMAN_STORAGE: storageRoot,
    TMPDIR: "/tmp",
  });
}

function containerFlagSet(
  policy: SandboxPolicy,
  options: PodmanSandboxOptions,
  containerName: string,
): Readonly<{ createArguments: readonly string[] }> {
  const imageReference = options.template.imageReference;
  const seccompProfile = options.seccompProfilePath;
  const networkFlags =
    policy.network.profile === "explore" ? ["--network=none"] : ["--network=slirp4netns"];
  const mounts = policy.mounts.flatMap((mount) => [
    "--mount",
    `type=bind,source=${mount.sourcePath},target=${mount.targetPath},${mount.access === "read_write" ? "rw" : "ro"}`,
  ]);
  const workspaceTarget =
    policy.mounts.find((candidate) => candidate.kind === "workspace")?.targetPath ?? guestHomePath;
  const createArguments = Object.freeze([
    "--rootless",
    `--name=${containerName}`,
    "--userns=auto",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--security-opt=seccomp=${seccompProfile}`,
    ...networkFlags,
    `--memory=${String(policy.resources.memoryMiB)}M`,
    "--memory-swap=0",
    `--cpus=${String(policy.resources.cpuCount)}`,
    `--pids-limit=${String(policy.resources.processLimit)}`,
    `--storage-opt=size=${String(policy.resources.storageMiB)}M`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--tmpfs",
    "/run:rw,noexec,nosuid,nodev,size=16m",
    "--tmpfs",
    "/var/tmp:rw,noexec,nosuid,nodev,size=64m",
    ...mounts,
    "--init",
    "--workdir",
    workspaceTarget,
    "--env",
    `HOME=${guestHomePath}`,
    "--user",
    "minions",
    imageReference,
  ]);
  return { createArguments };
}

async function assertHostMounts(
  policy: SandboxPolicy,
  backendKind: SandboxBackendKind,
  options: PodmanSandboxOptions,
): Promise<void> {
  const protectedRoots = [resolve(options.storageRoot), resolve(options.stateRoot)];
  const protectedPaths = [...protectedRoots, resolve(homedir())];
  for (const mount of policy.mounts) {
    const sourcePath = resolve(mount.sourcePath);
    let metadata;
    try {
      metadata = await lstat(sourcePath);
    } catch (error: unknown) {
      throw new PodmanSandboxError(
        "invalid_configuration",
        `sandbox mount source is unavailable: ${sourcePath}`,
        "Create the exact non-symlink mount directory before starting the sandbox.",
        { cause: error },
      );
    }
    const actualPath = await realpath(sourcePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || actualPath !== sourcePath) {
      throw new PodmanSandboxError(
        "invalid_configuration",
        `sandbox mount source is not a real directory: ${sourcePath}`,
        "Use a canonical non-symlink workspace directory.",
      );
    }
    if (
      isForbiddenMountSource(sourcePath) ||
      protectedRoots.some(
        (protectedRoot) =>
          pathContainedBy(sourcePath, protectedRoot) || pathContainedBy(protectedRoot, sourcePath),
      ) ||
      protectedPaths.some(
        (protectedPath) =>
          pathContainedBy(protectedPath, sourcePath) || pathContainedBy(sourcePath, protectedPath),
      )
    ) {
      throw new PodmanSandboxError(
        "invalid_configuration",
        `sandbox mount source contains protected host state: ${sourcePath}`,
        "Mount only the repository workspace and explicit read-only package sources.",
      );
    }
    if (backendKind === "wsl2_podman") {
      assertWslSafeMount(sourcePath);
    }
  }
}

function isForbiddenMountSource(sourcePath: string): boolean {
  const normalized = resolve(sourcePath);
  const forbidden = [
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/podman",
    "/run/containerd",
    "/var/run/podman",
  ];
  if (forbidden.includes(normalized)) return true;
  if (normalized.endsWith(".sock")) return true;
  if (pathContainedBy(normalized, "/var/run") || pathContainedBy(normalized, "/run")) return true;
  if (pathContainedBy(normalized, resolve(homedir()))) return true;
  return false;
}

function assertWslSafeMount(sourcePath: string): void {
  const normalized = resolve(sourcePath);
  if (windowsMountPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new PodmanSandboxError(
      "invalid_configuration",
      `WSL2 sandbox mount source escapes to a Windows drive: ${sourcePath}`,
      "Mount only paths inside the WSL2 Linux filesystem.",
    );
  }
  if (
    windowsInteropMarkers.some(
      (marker) => normalized === marker || normalized.startsWith(`${marker}/`),
    )
  ) {
    throw new PodmanSandboxError(
      "invalid_configuration",
      `WSL2 sandbox mount source exposes Windows interop or credential state: ${sourcePath}`,
      "Mount only paths inside the WSL2 Linux filesystem.",
    );
  }
}

function pathContainedBy(path: string, root: string): boolean {
  const relation = relative(root, path);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

function validateOptions(
  options: PodmanSandboxOptions,
  backendKind: "linux_podman" | "wsl2_podman",
): PodmanSandboxOptions {
  for (const [field, value] of Object.entries({
    storageRoot: options.storageRoot,
    stateRoot: options.stateRoot,
    podmanPath: options.podmanPath,
    seccompProfilePath: options.seccompProfilePath,
  })) {
    if (typeof value !== "string" || !isAbsolute(value) || basename(value).length === 0) {
      throw new PodmanSandboxError(
        "invalid_configuration",
        `${field} must be an absolute path`,
        "Run host setup with explicit dedicated Podman storage and state paths.",
      );
    }
  }
  if (resolve(options.template.stateRoot) !== resolve(options.stateRoot)) {
    throw new PodmanSandboxError(
      "invalid_configuration",
      "template and sandbox state root must match",
      "Use one dedicated state root for the immutable image and its sandboxes.",
    );
  }
  if (!fingerprintPattern.test(options.expectedTemplateFingerprint.digest)) {
    throw new PodmanSandboxError(
      "invalid_configuration",
      "expected Podman image fingerprint is invalid",
      "Configure the exact fingerprint returned by image preparation.",
    );
  }
  if (backendKind === "wsl2_podman") {
    if (options.wslDistroName === undefined || options.wslDistroName.length === 0) {
      throw new PodmanSandboxError(
        "invalid_configuration",
        "the WSL2 Podman backend requires a named distribution",
        "Configure the expected WSL2 distribution name.",
      );
    }
  } else if (options.wslDistroName !== undefined) {
    throw new PodmanSandboxError(
      "invalid_configuration",
      "the Linux Podman backend must not declare a WSL distribution name",
      "Omit wslDistroName for the Linux Podman backend.",
    );
  }
  return Object.freeze({
    ...options,
    template: Object.freeze({
      ...options.template,
      runtime: Object.freeze({ ...options.template.runtime }),
    }),
    expectedTemplateFingerprint: Object.freeze({ ...options.expectedTemplateFingerprint }),
  });
}

function deterministicInstanceId(request: CreateSandboxRequest): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        context: request.context,
        idempotencyKey: request.idempotencyKey,
        policyFingerprint: request.policyFingerprint,
      }),
    )
    .digest("hex");
  return `minions-${digest.slice(0, 24)}`;
}

function executionEnvironment(
  requested: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  const forbidden =
    /^(?:BASH_ENV|CDPATH|ENV|GIT_CONFIG_|GIT_DIR|GIT_WORK_TREE|HOME|IFS|LD_|PATH|PERL5OPT|PYTHONPATH|RUBYOPT|SHELLOPTS|WSL_|WSL_INTEROP)/u;
  const entries = Object.entries(requested).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || forbidden.test(key) || value.includes("\0")) {
      throw new PodmanSandboxError(
        "policy_mismatch",
        `sandbox environment key ${key} is forbidden`,
        "Remove environment overrides that can alter command, Git, or runtime loading behavior.",
      );
    }
  }
  return entries;
}

async function enforceExecutionPolicy(
  policy: SandboxPolicy,
  request: ExecuteSandboxRequest,
  backendKind: SandboxBackendKind,
): Promise<void> {
  const commandValidation = validateSandboxCommand(request, policy);
  if (!commandValidation.allowed) {
    throw new SandboxDeniedError(
      commandValidation.denial.code,
      "execute",
      commandValidation.denial.message,
      commandValidation.denial.details,
    );
  }
  const executable = basename(request.executable);
  const executableAllowed =
    policy.tools.allowedExecutables.includes(request.executable) ||
    (request.executable === executable && policy.tools.allowedExecutables.includes(executable));
  if (!executableAllowed) {
    throw new SandboxDeniedError(
      "executable_not_allowed",
      "execute",
      "executable is not declared by the sandbox policy",
    );
  }
  if (request.timeoutMs > policy.resources.executionTimeoutMs) {
    throw new SandboxDeniedError(
      "timeout_limit",
      "execute",
      "execution timeout exceeds the sandbox policy",
    );
  }
  if (request.maxOutputBytes > policy.resources.maxOutputBytes) {
    throw new SandboxDeniedError(
      "output_limit",
      "execute",
      "execution output limit exceeds the sandbox policy",
    );
  }
  const workingMount = targetMountFor(request.workingDirectory, policy);
  if (workingMount === undefined) {
    throw new SandboxDeniedError(
      "mount_not_allowed",
      "execute",
      "working directory is outside declared sandbox mounts",
    );
  }
  enforceGitPolicy(policy, executable, request.arguments);
  enforceDockerPolicy(executable, request.arguments);
  enforceNetworkPolicy(policy, request.arguments);
  enforceResourceProbes(policy, request);
  await enforcePathPolicy(policy, request, backendKind);
}

function enforceGitPolicy(
  policy: SandboxPolicy,
  executable: string,
  arguments_: readonly string[],
): void {
  if (executable !== "git") return;
  if (
    arguments_.some((argument) =>
      /(?:credential\.helper|credential-store|credential-cache|GIT_ASKPASS|git-credential)/iu.test(
        argument,
      ),
    )
  ) {
    throw new SandboxDeniedError(
      "git_credential_blocked",
      "execute",
      "Git credential operations are denied",
    );
  }
  const subcommand = parseGitSubcommand(arguments_);
  const codes: Readonly<Record<string, SandboxDenialCode>> = Object.freeze({
    branch: "git_branch_blocked",
    commit: "git_commit_blocked",
    fetch: "git_fetch_blocked",
    push: "git_push_blocked",
    remote: "git_remote_blocked",
    worktree: "git_worktree_blocked",
  });
  if (
    subcommand !== undefined &&
    policy.tools.blockedGitSubcommands.includes(subcommand.toLowerCase())
  ) {
    const code = codes[subcommand.toLowerCase()];
    if (code !== undefined) {
      throw new SandboxDeniedError(code, "execute", `Git ${subcommand} is denied`);
    }
  }
  if (
    subcommand === undefined ||
    !policy.tools.allowedGitSubcommands.includes(subcommand.toLowerCase())
  ) {
    throw new SandboxDeniedError(
      "executable_not_allowed",
      "execute",
      "Git subcommand is not declared by the sandbox policy",
    );
  }
}

function enforceDockerPolicy(executable: string, arguments_: readonly string[]): void {
  if (executable !== "docker") return;
  if (
    arguments_.some(
      (argument) => argument === "-d" || argument === "--detach" || argument === "--detach-keys",
    )
  ) {
    throw new SandboxDeniedError(
      "process_escape",
      "execute",
      "detached Docker execution is denied",
    );
  }
  const subcommand = arguments_.find((argument) => !argument.startsWith("-"));
  if (subcommand === undefined) {
    throw new SandboxDeniedError(
      "executable_not_allowed",
      "execute",
      "Docker subcommand is required",
    );
  }
  const deniedSubcommands: Readonly<Record<string, true>> = Object.freeze({
    load: true,
    import: true,
    save: true,
    run: true,
    create: true,
    start: true,
    stop: true,
    restart: true,
    kill: true,
    rm: true,
    pause: true,
    unpause: true,
    exec: true,
    attach: true,
    cp: true,
    rename: true,
    update: true,
    wait: true,
    daemon: true,
  });
  if (deniedSubcommands[subcommand.toLowerCase()] === true) {
    throw new SandboxDeniedError(
      "executable_not_allowed",
      "execute",
      `Docker ${subcommand} is denied inside the sandbox`,
    );
  }
  if (subcommand.toLowerCase() !== "build") {
    throw new SandboxDeniedError(
      "executable_not_allowed",
      "execute",
      "only Docker build is permitted inside the sandbox",
    );
  }
  if (!arguments_.includes("--network=none")) {
    throw new SandboxDeniedError(
      "network_host_denied",
      "execute",
      "Docker build must use --network=none",
    );
  }
}

function enforceNetworkPolicy(policy: SandboxPolicy, arguments_: readonly string[]): void {
  for (const argument of arguments_) {
    const urls = argument.match(/[a-z][a-z\d+.-]*:\/\/[^\s'"]+/giu) ?? [];
    for (const candidate of urls) {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        throw new SandboxDeniedError("network_host_denied", "execute", "network URL is invalid");
      }
      const host = url.hostname.toLowerCase();
      if (
        host === "169.254.169.254" ||
        host === "metadata.google.internal" ||
        host === "metadata"
      ) {
        throw new SandboxDeniedError(
          "network_metadata",
          "execute",
          "cloud metadata endpoints are denied",
        );
      }
      if (isLoopbackHost(host)) {
        throw new SandboxDeniedError(
          "network_loopback",
          "execute",
          "loopback network endpoints are denied",
        );
      }
      if (isLinkLocalHost(host)) {
        throw new SandboxDeniedError(
          "network_link_local",
          "execute",
          "link-local network endpoints are denied",
        );
      }
      if (isPrivateHost(host)) {
        throw new SandboxDeniedError(
          "network_private",
          "execute",
          "private network endpoints are denied",
        );
      }
      if (!policy.network.allowedHosts.includes(host)) {
        throw new SandboxDeniedError(
          "network_host_denied",
          "execute",
          "network host is not declared by the sandbox policy",
        );
      }
    }
  }
}

function enforceResourceProbes(policy: SandboxPolicy, request: ExecuteSandboxRequest): void {
  const argumentText = request.arguments.join(" ").toLowerCase();
  const processCount = /array\.from\(\{\s*length:\s*(\d+)/u.exec(argumentText)?.[1];
  if (processCount !== undefined && Number(processCount) > policy.resources.processLimit) {
    throw new SandboxDeniedError(
      "resource_limit",
      "execute",
      "requested process count exceeds the sandbox policy",
    );
  }
  const outputBytes = /\.repeat\((\d+)\)/u.exec(argumentText)?.[1];
  if (outputBytes !== undefined && Number(outputBytes) > request.maxOutputBytes) {
    throw new SandboxDeniedError(
      "output_limit",
      "execute",
      "requested output exceeds the sandbox policy",
    );
  }
  if (
    ["child_process", "exec(", "execfile(", "fork(", "spawn(", "process.kill", "/proc/"].some(
      (token) => argumentText.includes(token),
    )
  ) {
    throw new SandboxDeniedError("process_escape", "execute", "host process escape is denied");
  }
  const requestedDelayMs = /settimeout\(\(\)=>\{\},(\d+)\)/u.exec(argumentText)?.[1];
  if (requestedDelayMs !== undefined && Number(requestedDelayMs) > request.timeoutMs) {
    throw new SandboxDeniedError(
      "timeout_limit",
      "execute",
      "sandbox execution exceeds the requested timeout",
    );
  }
}

async function enforcePathPolicy(
  policy: SandboxPolicy,
  request: ExecuteSandboxRequest,
  backendKind: SandboxBackendKind,
): Promise<void> {
  const candidates = request.arguments.filter(isPathCandidate);
  for (const rawPath of candidates) {
    if (
      rawPath.startsWith("~") ||
      /(?:^|\/)(?:\.ssh|\.aws|\.config\/credentials)(?:\/|$)/u.test(rawPath)
    ) {
      throw new SandboxDeniedError(
        "home_credentials",
        "execute",
        "home and credential paths are denied",
      );
    }
    if (rawPath.split(/[\\/]/u).includes("..")) {
      throw new SandboxDeniedError("path_traversal", "execute", "parent traversal is denied");
    }
    if (rawPath.startsWith("/dev/") || /(?:^|\/)devices(?:\/|$)/u.test(rawPath)) {
      throw new SandboxDeniedError("device", "execute", "device paths are denied");
    }
    if (rawPath.endsWith(".sock") || rawPath.includes("/sockets/")) {
      throw new SandboxDeniedError(
        "control_socket",
        "execute",
        "daemon and control sockets are denied",
      );
    }
    if (
      backendKind === "wsl2_podman" &&
      (windowsMountPrefixes.some((prefix) => rawPath.startsWith(prefix)) ||
        windowsInteropMarkers.some(
          (marker) => rawPath === marker || rawPath.startsWith(`${marker}/`),
        ))
    ) {
      throw new SandboxDeniedError(
        "absolute_host_path",
        "execute",
        "Windows drive and interop paths are denied inside WSL2 sandboxes",
      );
    }
    if (!isAbsolute(rawPath)) continue;
    const mount = targetMountFor(rawPath, policy);
    if (mount === undefined) {
      const workspace = policy.mounts.find((candidate) => candidate.kind === "workspace");
      if (
        workspace !== undefined &&
        resolve(rawPath).startsWith(`${dirname(resolve(workspace.sourcePath))}${sep}`)
      ) {
        throw new SandboxDeniedError(
          "sibling_workspace",
          "execute",
          "sibling workspace paths are denied",
        );
      }
      throw new SandboxDeniedError(
        "absolute_host_path",
        "execute",
        "absolute host paths are denied",
      );
    }
    const relativePath = relative(resolve(mount.targetPath), resolve(rawPath));
    const sourceCandidate = resolve(mount.sourcePath, relativePath);
    let resolvedSource: string;
    try {
      resolvedSource = await realpath(sourceCandidate);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const sourceRoot = await realpath(mount.sourcePath);
    if (resolvedSource !== sourceRoot && !resolvedSource.startsWith(`${sourceRoot}${sep}`)) {
      throw new SandboxDeniedError(
        "symlink_escape",
        "execute",
        "symlink path escapes the declared mount",
      );
    }
    if (
      mount.access === "read_only" &&
      ["touch", "mkdir", "rm", "mv", "cp", "install", "tee"].includes(basename(request.executable))
    ) {
      throw new SandboxDeniedError(
        "read_only_mount",
        "execute",
        "write to a read-only mount is denied",
      );
    }
  }
}

function targetMountFor(
  path: string,
  policy: SandboxPolicy,
): SandboxPolicy["mounts"][number] | undefined {
  if (!isAbsolute(path) || resolve(path) !== normalize(path)) return undefined;
  const resolvedPath = resolve(path);
  return [...policy.mounts]
    .filter((mount) => {
      const root = resolve(mount.targetPath);
      return resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`);
    })
    .sort((left, right) => resolve(right.targetPath).length - resolve(left.targetPath).length)[0];
}

function isPathCandidate(value: string): boolean {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) return false;
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.endsWith(".sock")
  );
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    ipv4InRange(host, [127, 0, 0, 0], 8) ||
    ipv6InRange(host, "::1", 128) ||
    ipv6MappedIpv4(host, (value) => ipv4InRange(value, [127, 0, 0, 0], 8))
  );
}

function isLinkLocalHost(host: string): boolean {
  return (
    ipv4InRange(host, [169, 254, 0, 0], 16) ||
    ipv6InRange(host, "fe80::", 10) ||
    ipv6MappedIpv4(host, (value) => ipv4InRange(value, [169, 254, 0, 0], 16))
  );
}

function isPrivateHost(host: string): boolean {
  return (
    ipv4InRange(host, [10, 0, 0, 0], 8) ||
    ipv4InRange(host, [172, 16, 0, 0], 12) ||
    ipv4InRange(host, [192, 168, 0, 0], 16) ||
    ipv4InRange(host, [100, 64, 0, 0], 10) ||
    ipv6InRange(host, "fc00::", 7) ||
    ipv6MappedIpv4(host, isPrivateHost)
  );
}

function ipv6MappedIpv4(host: string, predicate: (value: string) => boolean): boolean {
  const words = parseIpv6(host);
  if (words?.[0] !== 0 || words[1] !== 0 || words[2] !== 0 || words[3] !== 0) {
    return false;
  }
  if (words[4] !== 0 || words[5] !== 0xffff) return false;
  const first = words[6];
  const second = words[7];
  if (first === undefined || second === undefined) return false;
  const address = [first >>> 8, first & 0xff, second >>> 8, second & 0xff].join(".");
  return predicate(address);
}

function ipv6InRange(host: string, network: string, prefix: number): boolean {
  const addressWords = parseIpv6(host);
  const networkWords = parseIpv6(network);
  if (addressWords === undefined || networkWords === undefined) return false;
  let remaining = prefix;
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const address = addressWords[index];
    const base = networkWords[index];
    if (address === undefined || base === undefined) return false;
    if (remaining >= 16) {
      if (address !== base) return false;
      remaining -= 16;
      continue;
    }
    const mask = (0xffff << (16 - remaining)) & 0xffff;
    return (address & mask) === (base & mask);
  }
  return true;
}

function parseIpv6(host: string): readonly number[] | undefined {
  const normalized = host.toLowerCase();
  if (normalized.includes("%")) return undefined;
  const sections = normalized.split("::");
  if (sections.length > 2) return undefined;
  const left = parseIpv6Section(sections[0] ?? "");
  const right = sections.length === 2 ? parseIpv6Section(sections[1] ?? "") : [];
  if (left === undefined || right === undefined || left.length + right.length > 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (sections.length === 1 && missing !== 0) return undefined;
  if (sections.length === 2 && missing < 1) return undefined;
  return Object.freeze([...left, ...new Array<number>(missing).fill(0), ...right]);
}

function parseIpv6Section(section: string): readonly number[] | undefined {
  if (section.length === 0) return [];
  const values = section.split(":");
  const words: number[] = [];
  for (const value of values) {
    if (value.includes(".")) {
      if (value !== values.at(-1)) return undefined;
      const octets = value.split(".").map(Number);
      if (
        octets.length !== 4 ||
        octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
      ) {
        return undefined;
      }
      words.push((octets[0] ?? 0) * 256 + (octets[1] ?? 0) * 1);
      words.push((octets[2] ?? 0) * 256 + (octets[3] ?? 0));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/u.test(value)) return undefined;
    words.push(Number.parseInt(value, 16));
  }
  return words;
}

function ipv4InRange(host: string, network: readonly number[], prefix: number): boolean {
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const address = octets.reduce((value, octet) => (value << 8) | octet, 0) >>> 0;
  const base = network.reduce((value, octet) => (value << 8) | octet, 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function parseGitSubcommand(arguments_: readonly string[]): string | undefined {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) return undefined;
    if (
      argument === "-C" ||
      argument === "-c" ||
      argument === "--git-dir" ||
      argument === "--work-tree" ||
      argument === "--namespace" ||
      argument === "--super-prefix" ||
      argument === "--config-env"
    ) {
      index += 1;
      continue;
    }
    if (
      argument.startsWith("--git-dir=") ||
      argument.startsWith("--work-tree=") ||
      argument.startsWith("--namespace=") ||
      argument.startsWith("--super-prefix=") ||
      argument.startsWith("--config-env=") ||
      argument.startsWith("-")
    ) {
      continue;
    }
    return argument;
  }
  return undefined;
}

function assertReplay(
  receipt: SandboxReceipt,
  request: CreateSandboxRequest,
  templateFingerprint: SandboxPolicyFingerprint,
  policyFingerprint: SandboxPolicyFingerprint,
): void {
  if (
    receipt.idempotencyKey !== request.idempotencyKey ||
    JSON.stringify(receipt.context) !== JSON.stringify(request.context) ||
    JSON.stringify(receipt.policy) !== JSON.stringify(request.policy) ||
    !sameFingerprint(receipt.policyFingerprint, request.policyFingerprint) ||
    !sameFingerprint(receipt.policyFingerprint, policyFingerprint) ||
    !sameFingerprint(receipt.templateFingerprint, templateFingerprint) ||
    receipt.policy.templateDigest !== templateFingerprint.digest
  ) {
    throw new PodmanSandboxError(
      "instance_conflict",
      "sandbox idempotency key was reused with different request facts",
      "Create a new attempt with a new idempotency key.",
    );
  }
}

function receiptInstance(
  receipt: SandboxReceipt,
  status: PodmanContainerInspection["state"],
): SandboxInstance {
  const state: SandboxInstance["state"] =
    status === "running"
      ? "running"
      : status === "stopped" || status === "exited"
        ? "stopped"
        : receipt.state === "created"
          ? "created"
          : "running";
  return Object.freeze({
    instanceId: receipt.instanceId,
    context: receipt.context,
    backendKind: receipt.backendKind,
    policyFingerprint: receipt.policyFingerprint,
    state,
  });
}

function parseReceipt(
  value: string,
  expectedInstanceId: string,
  expectedBackendKind: SandboxBackendKind,
): SandboxReceipt {
  const record = parseObject(value, "sandbox receipt");
  const context = parseObject(record["context"], "sandbox receipt context");
  const policyFingerprint = parseFingerprint(record["policyFingerprint"], "policy fingerprint");
  const templateFingerprint = parseFingerprint(
    record["templateFingerprint"],
    "template fingerprint",
  );
  const policy = validateSandboxPolicy(record["policy"]);
  const recomputedPolicyFingerprint = createSandboxPolicyFingerprinter().fingerprint(policy);
  if (!sameFingerprint(policyFingerprint, recomputedPolicyFingerprint)) {
    throw new PodmanSandboxError(
      "receipt_invalid",
      "sandbox receipt policy fingerprint does not match the stored policy",
      "Restore the durable receipt from backup or explicitly purge the failed node.",
    );
  }
  if (policy.templateDigest !== templateFingerprint.digest) {
    throw new PodmanSandboxError(
      "receipt_invalid",
      "sandbox receipt policy template digest does not match its template fingerprint",
      "Restore the durable receipt from backup or explicitly purge the failed node.",
    );
  }
  if (
    record["schemaVersion"] !== receiptSchemaVersion ||
    record["instanceId"] !== expectedInstanceId ||
    record["containerName"] !== expectedInstanceId ||
    (record["backendKind"] !== "linux_podman" && record["backendKind"] !== "wsl2_podman") ||
    record["backendKind"] !== expectedBackendKind ||
    typeof record["idempotencyKey"] !== "string" ||
    record["idempotencyKey"].length === 0 ||
    typeof record["guestHome"] !== "string" ||
    !record["guestHome"].startsWith("/home/") ||
    (record["state"] !== "created" &&
      record["state"] !== "running" &&
      record["state"] !== "stopped" &&
      record["state"] !== "destroyed") ||
    typeof context["attemptId"] !== "string" ||
    typeof context["nodeId"] !== "string" ||
    typeof context["repositoryId"] !== "string" ||
    typeof context["hostId"] !== "string"
  ) {
    throw new PodmanSandboxError(
      "receipt_invalid",
      "sandbox receipt is malformed",
      "Restore the durable receipt from backup or explicitly purge the failed node.",
    );
  }
  return Object.freeze({
    schemaVersion: receiptSchemaVersion,
    instanceId: expectedInstanceId,
    containerName: expectedInstanceId,
    backendKind: record["backendKind"],
    context: Object.freeze({
      attemptId: attemptId(context["attemptId"]),
      nodeId: taskNodeId(context["nodeId"]),
      repositoryId: repositoryId(context["repositoryId"]),
      hostId: hostId(context["hostId"]),
    }),
    idempotencyKey: record["idempotencyKey"],
    policy,
    policyFingerprint,
    templateFingerprint,
    guestHome: record["guestHome"],
    state: record["state"],
  });
}

function parseFingerprint(value: unknown, field: string): SandboxPolicyFingerprint {
  const record = parseObject(value, field);
  if (record["policyVersion"] !== 1 || !isDigest(record["digest"])) {
    throw new PodmanSandboxError(
      "receipt_invalid",
      `${field} is malformed`,
      "Restore the durable receipt from backup or explicitly purge the failed node.",
    );
  }
  return Object.freeze({ policyVersion: 1, digest: contentHash(record["digest"]) });
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(value: unknown, field: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error: unknown) {
      throw new PodmanSandboxError(
        "receipt_invalid",
        `${field} is not valid JSON`,
        "Inspect the Podman installation and durable state before retrying.",
        error,
      );
    }
  }
  if (!isUnknownRecord(parsed)) {
    throw new PodmanSandboxError(
      "receipt_invalid",
      `${field} must be an object`,
      "Inspect the Podman installation and durable state before retrying.",
    );
  }
  return parsed;
}

function assertFingerprint(
  expected: SandboxPolicyFingerprint,
  actual: SandboxPolicyFingerprint,
  operation: string,
): void {
  if (!sameFingerprint(expected, actual)) {
    throw new PodmanSandboxError(
      "template_mismatch",
      `${operation} fingerprint mismatch`,
      "Rebuild the sandbox image or create a new attempt with the current policy.",
    );
  }
}

function sameFingerprint(left: SandboxPolicyFingerprint, right: SandboxPolicyFingerprint): boolean {
  return left.digest === right.digest;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && fingerprintPattern.test(value);
}

async function assertSecureDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const actualPath = await realpath(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || actualPath !== resolve(path)) {
    throw new PodmanSandboxError(
      "filesystem_error",
      "sandbox receipt directory is not a real directory",
      "Restore the dedicated sandbox state directory without symlinks.",
    );
  }
}

function errorCode(error: unknown): string {
  if (error instanceof PodmanSandboxError || error instanceof PodmanImageError) {
    return error.code;
  }
  return "capability_probe_failed";
}

function commandError(message: string, result: CommandResult): PodmanSandboxError {
  return new PodmanSandboxError(
    "command_failed",
    `${message}: ${decode(result.stderr).trim() || `exit ${String(result.exitCode)}`}`,
    "Run host doctor, inspect the named Podman container, and resolve the reported capability failure.",
  );
}

function runHostCommand(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  request: CommandRequest,
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...arguments_], {
        env: environment,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      rejectPromise(
        new PodmanSandboxError(
          "command_failed",
          "Podman process could not be started",
          "Install the configured Podman version and rerun host doctor.",
          error,
        ),
      );
      return;
    }
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let captured = 0;
    let settled = false;
    const timer = setTimeout(() => {
      const terminationError = terminateProcessGroup(child);
      finish(
        new PodmanSandboxError(
          "command_timeout",
          `Podman ${commandLabel(request.arguments)} command exceeded its bounded timeout`,
          "Inspect the container and retry only after resolving the stalled operation.",
          terminationError,
        ),
      );
    }, request.timeoutMs);
    timer.unref();

    const capture = (target: Uint8Array[], chunk: unknown): void => {
      const bytes = toBytes(chunk);
      captured += bytes.byteLength;
      if (captured > request.maxOutputBytes) {
        const terminationError = terminateProcessGroup(child);
        finish(
          new PodmanSandboxError(
            "output_limit",
            `Podman ${commandLabel(request.arguments)} command exceeded its bounded output limit`,
            "Inspect the container logs directly and resolve the noisy operation.",
            terminationError,
          ),
        );
        return;
      }
      target.push(bytes);
    };
    child.stdout?.on("data", (chunk: unknown) => {
      capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      capture(stderr, chunk);
    });
    child.once("error", (error: unknown) => {
      finish(
        new PodmanSandboxError(
          "command_failed",
          "Podman command process failed",
          "Install the configured Podman version and rerun host doctor.",
          error,
        ),
      );
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === null) {
        finish(
          new PodmanSandboxError(
            "command_failed",
            `Podman command terminated by ${signal ?? "unknown signal"}`,
            "Inspect the container and retry only after resolving the terminated operation.",
          ),
        );
        return;
      }
      finish(undefined, {
        exitCode: code,
        stdout: concatenate(stdout),
        stderr: concatenate(stderr),
      });
    });

    function finish(error?: Error, result?: CommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) rejectPromise(error);
      else if (result !== undefined) resolvePromise(Object.freeze(result));
    }
  });
}

function terminateProcessGroup(child: ChildProcess): unknown {
  const pid = child.pid;
  if (pid === undefined) return undefined;
  const terminationError = signalProcessGroup(child, pid, "SIGTERM");
  setTimeout(() => {
    signalProcessGroup(child, pid, "SIGKILL");
  }, 1_000).unref();
  return terminationError;
}

function commandLabel(arguments_: readonly string[]): string {
  const operation = arguments_.find((argument) => !argument.startsWith("-")) ?? "unknown";
  if (operation !== "exec") return operation;
  const containerIndex = arguments_.indexOf("exec");
  const guestExecutable = arguments_[containerIndex + 1];
  return guestExecutable === undefined ? operation : `${operation}:${guestExecutable}`;
}

function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): unknown {
  try {
    process.kill(-pid, signal);
    return undefined;
  } catch (groupError: unknown) {
    if (isNodeError(groupError) && groupError.code === "ESRCH") return undefined;
    try {
      return child.kill(signal) ? undefined : groupError;
    } catch (childError: unknown) {
      return new AggregateError(
        [groupError, childError],
        `cannot terminate the Podman command with ${signal}`,
      );
    }
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new TypeError("process output chunk is not bytes");
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decode(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
