import { createHash, randomUUID } from "node:crypto";
import { lookup as lookupHost } from "node:dns/promises";
import { closeSync, fsyncSync, openSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { arch, platform } from "node:os";
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
  type SandboxCapabilityProbe,
  type SandboxExecutionResult,
  type SandboxInstance,
  type SandboxLifecycle,
  type SandboxPolicy,
  SandboxDeniedError,
  type SandboxDenialCode,
  type SandboxPolicyFingerprint,
} from "@minions/core";
import {
  createSandboxPolicyFingerprinter,
  validateSandboxCommand,
  validateSandboxPolicy,
} from "./sandbox-policy.js";
import {
  LimaTemplateError,
  verifyLimaTemplate,
  type LimaTemplateBuildOptions,
  type LimaTemplateReceipt,
} from "./lima-template.js";

export type MacOsLimaSandboxErrorCode =
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
  | "filesystem_error";

export class MacOsLimaSandboxError extends Error {
  readonly code: MacOsLimaSandboxErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(
    code: MacOsLimaSandboxErrorCode,
    message: string,
    remediation: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MacOsLimaSandboxError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

export type MacOsLimaSandboxOptions = Readonly<{
  limactlPath: string;
  limaHome: string;
  stateDirectory: string;
  template: LimaTemplateBuildOptions;
  expectedTemplateFingerprint: SandboxPolicyFingerprint;
}>;

type LimaInstanceState = "Running" | "Stopped";

type LimaInstanceInspection = Readonly<{
  name: string;
  status: LimaInstanceState;
  vmType: string;
  dir: string;
}>;

type SandboxReceipt = Readonly<{
  schemaVersion: 1;
  instanceId: string;
  limaInstanceName: string;
  context: CreateSandboxRequest["context"];
  idempotencyKey: string;
  policy: SandboxPolicy;
  policyFingerprint: SandboxPolicyFingerprint;
  templateFingerprint: SandboxPolicyFingerprint;
  guestHome: string;
  state: SandboxInstance["state"] | "destroyed";
}>;

type CommandRequest = Readonly<{
  arguments: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  input?: Uint8Array;
}>;

type CommandResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

type ResolvedNetworkHost = Readonly<{
  hostname: string;
  address: string;
  family: 4 | 6;
}>;

const receiptSchemaVersion = 1;
const lifecycleCommandTimeoutMs = 120_000;
const lifecycleStartTimeoutMs = 600_000;
const lifecycleOutputLimit = 1_048_576;
const environmentPath = "/usr/local/bin:/usr/bin:/bin";
const instanceNamePattern = /^minions-[a-f0-9]{24}$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;

export function createMacOsLimaSandboxLifecycle(
  options: MacOsLimaSandboxOptions,
): SandboxLifecycle {
  return new MacOsLimaSandboxLifecycle(validateOptions(options));
}

class MacOsLimaSandboxLifecycle implements SandboxLifecycle {
  readonly backendKind = "macos_lima" as const;
  readonly #options: MacOsLimaSandboxOptions;
  readonly #fingerprinter = createSandboxPolicyFingerprinter();

  constructor(options: MacOsLimaSandboxOptions) {
    this.#options = options;
  }

  async probe(): Promise<SandboxCapabilityProbe> {
    try {
      const template = await this.#requireTemplate();
      const version = await this.#runChecked(["--version"], 10_000, 16_384);
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
          nestedContainers: true,
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
      const detail = error instanceof Error ? error.message : "unknown Lima capability failure";
      const remediation =
        error instanceof MacOsLimaSandboxError || error instanceof LimaTemplateError
          ? error.remediation
          : "Run host doctor and inspect the Lima installation.";
      const message = `${detail} Remediation: ${remediation}`;
      return Object.freeze({
        available: false,
        backendKind: this.backendKind,
        failureCode: errorCode(error),
        message,
      });
    }
  }

  async create(request: CreateSandboxRequest): Promise<SandboxInstance> {
    const template = await this.#requireTemplate();
    const policy = validateSandboxPolicy(request.policy);
    const actualFingerprint = this.#fingerprinter.fingerprint(policy);
    assertFingerprint(
      this.#options.expectedTemplateFingerprint,
      template.fingerprint,
      "Lima template",
    );
    if (policy.templateDigest !== template.fingerprint.digest) {
      throw new MacOsLimaSandboxError(
        "template_mismatch",
        "sandbox policy template digest does not match the verified Lima template",
        "Create the policy from the currently verified Lima template.",
      );
    }
    if (!sameFingerprint(request.policyFingerprint, actualFingerprint)) {
      throw new SandboxDeniedError(
        "policy_fingerprint_mismatch",
        "create",
        "sandbox policy fingerprint does not match the canonical policy",
      );
    }
    if (policy.resources.storageMiB < template.diskGiB * 1024) {
      throw new MacOsLimaSandboxError(
        "policy_mismatch",
        "sandbox storage limit is smaller than the immutable Lima template disk",
        `Raise storageMiB to at least ${String(template.diskGiB * 1024)}.`,
      );
    }
    await assertHostMounts(policy, this.#options);

    const instanceId = deterministicInstanceId(request);
    const prior = await this.#readReceipt(instanceId);
    if (prior !== undefined) {
      if (prior.state === "destroyed") {
        throw new SandboxDeniedError(
          "idempotency_conflict",
          "create",
          "idempotency key points to a destroyed Lima sandbox",
        );
      }
      assertReplay(prior, request, template.fingerprint, actualFingerprint);
      const inspection = await this.#inspect(instanceId);
      if (inspection === undefined) {
        throw new MacOsLimaSandboxError(
          "instance_not_found",
          "durable sandbox receipt points to a missing Lima VM",
          "Restore or explicitly purge the failed node before retrying.",
        );
      }
      return receiptInstance(prior, inspection.status);
    }
    const unknown = await this.#inspect(instanceId);
    if (unknown !== undefined) {
      await this.#reconcileOrphan(instanceId, unknown, template, policy);
    }

    await mkdir(this.#receiptDirectory(), { recursive: true, mode: 0o700 });
    const mountsExpression = mountExpression(policy);
    const diskGiB = Math.ceil(policy.resources.storageMiB / 1024);
    const memoryGiB = policy.resources.memoryMiB / 1024;
    try {
      const templateConfigPath = join(this.#options.limaHome, template.instanceName, "lima.yaml");
      await chmod(templateConfigPath, 0o600);
      try {
        await this.#runChecked(
          [
            "clone",
            template.instanceName,
            instanceId,
            `--cpus=${String(policy.resources.cpuCount)}`,
            `--memory=${String(memoryGiB)}`,
            `--disk=${String(diskGiB)}`,
            "--mount-none",
            "--mount-type=virtiofs",
            "--vm-type=vz",
            "--set=.ssh.overVsock = false",
            "--set=.portForwards = []",
            "--set=.hostResolver.enabled = false",
            `--set=${mountsExpression}`,
            "--tty=false",
          ],
          lifecycleCommandTimeoutMs,
          lifecycleOutputLimit,
        );
      } finally {
        await chmod(templateConfigPath, 0o400);
      }
      await this.#requireTemplate();

      await makeCloneWritable(join(this.#options.limaHome, instanceId));
      await assertOwnerWritable(
        join(this.#options.limaHome, instanceId, "lima.yaml"),
        "clone config",
      );
      await this.#runChecked(
        ["start", instanceId, "--tty=false"],
        lifecycleStartTimeoutMs,
        lifecycleOutputLimit,
      );
      await this.#installNetworkPolicy(instanceId, policy);
      const guestHomeResult = await this.#shell(
        instanceId,
        ["printenv", "HOME"],
        lifecycleCommandTimeoutMs,
        16_384,
      );
      const guestHome = decode(guestHomeResult.stdout).trim();
      if (!guestHome.startsWith("/home/") || guestHome.includes("..")) {
        throw new MacOsLimaSandboxError(
          "receipt_invalid",
          "Lima guest returned an invalid home directory",
          "Rebuild the immutable Lima template.",
        );
      }
      await this.#shell(
        instanceId,
        ["docker", "version", "--format", "{{.Server.Version}}"],
        lifecycleCommandTimeoutMs,
        16_384,
      );
      await this.#shell(instanceId, ["omp", "--version"], 30_000, 16_384);
      const receipt: SandboxReceipt = Object.freeze({
        schemaVersion: receiptSchemaVersion,
        instanceId,
        limaInstanceName: instanceId,
        context: request.context,
        idempotencyKey: request.idempotencyKey,
        policy,
        policyFingerprint: actualFingerprint,
        templateFingerprint: template.fingerprint,
        guestHome,
        state: "created",
      });
      await this.#writeReceipt(receipt);
      return receiptInstance(receipt, "Running");
    } catch (error: unknown) {
      await this.#deleteFailedClone(instanceId, error);
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
    if (inspection.status !== "Running") {
      throw new MacOsLimaSandboxError(
        "instance_state_invalid",
        "sandbox execution requires a running Lima VM",
        "Start a new attempt or explicitly reconcile the stopped VM.",
      );
    }
    await enforceExecutionPolicy(receipt.policy, request);
    const environment = executionEnvironment(receipt, request.environment);
    const runtimeSeconds = Math.max(1, Math.ceil(request.timeoutMs / 1000));
    const unitName = `minions-exec-${randomUUID()}.service`;
    const addressFamilies =
      basename(request.executable) === "docker" ? "AF_UNIX AF_INET AF_INET6" : "AF_INET AF_INET6";
    const command = [
      "systemd-run",
      "--user",
      `--unit=${unitName}`,
      "--pipe",
      `--working-directory=${request.workingDirectory}`,
      "--wait",
      "--quiet",
      "--collect",
      `--property=CPUQuota=${String(receipt.policy.resources.cpuCount * 100)}%`,
      `--property=TasksMax=${String(receipt.policy.resources.processLimit)}`,
      `--property=MemoryMax=${String(receipt.policy.resources.memoryMiB)}M`,
      "--property=MemorySwapMax=0",
      `--property=RuntimeMaxSec=${String(runtimeSeconds)}s`,
      `--property=LimitFSIZE=${String(receipt.policy.resources.maxOutputBytes)}`,
      "--property=KillMode=control-group",
      "--property=Delegate=no",
      "--property=NoNewPrivileges=yes",
      ...(basename(request.executable) === "docker"
        ? []
        : ["--property=InaccessiblePaths=/run/user"]),
      ...(basename(request.executable) === "docker"
        ? []
        : [
            "--property=NoExecPaths=/",
            `--property=ExecPaths=${executionUnitPaths(request.executable).join(" ")}`,
          ]),
      `--property=RestrictAddressFamilies=${addressFamilies}`,
      "--property=SystemCallArchitectures=native",
      "--property=SystemCallFilter=~@mount @raw-io @reboot @swap @module",
      "--property=TasksAccounting=yes",
      "--property=MemoryAccounting=yes",
      "--property=LogRateLimitIntervalSec=0",
      "--property=OOMPolicy=kill",
      "--property=TimeoutStopSec=5s",
      "--",
      "env",
      "-i",
      ...environment,
      request.executable,
      ...request.arguments,
    ];
    let result: CommandResult;
    try {
      result = await this.#shell(
        request.instanceId,
        command,
        request.timeoutMs + 5_000,
        Math.min(lifecycleOutputLimit, request.maxOutputBytes + 65_536),
        request.workingDirectory,
        false,
      );
    } catch (error: unknown) {
      if (
        error instanceof MacOsLimaSandboxError &&
        (error.code === "command_timeout" || error.code === "output_limit")
      ) {
        try {
          await this.#terminateExecutionUnit(request.instanceId, unitName);
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            "sandbox command termination and cgroup cleanup failed",
            { cause: cleanupError },
          );
        }
      }
      throw error;
    }
    if (result.stdout.byteLength + result.stderr.byteLength > request.maxOutputBytes) {
      throw new MacOsLimaSandboxError(
        "output_limit",
        "Lima command exceeded its bounded output limit",
        "Inspect the VM logs directly and resolve the noisy operation.",
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
    if (inspection.status === "Running") {
      await this.#runChecked(
        ["stop", instanceId, "--tty=false"],
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
        throw new MacOsLimaSandboxError(
          "receipt_invalid",
          "cannot destroy an unbound Lima sandbox without its durable receipt",
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
        ["delete", "--force", instanceId, "--tty=false"],
        lifecycleCommandTimeoutMs,
        lifecycleOutputLimit,
      );
    }
    await this.#writeReceipt(Object.freeze({ ...receipt, state: "destroyed" }));
  }

  async #assertHostCapability(): Promise<void> {
    if (platform() !== "darwin" || arch() !== "arm64") {
      throw new MacOsLimaSandboxError(
        "capability_unavailable",
        "the macOS Lima backend requires Apple Silicon macOS",
        "Select the Podman backend on Linux/WSL or attach an Apple Silicon Mac host.",
      );
    }
    const result = await runHostCommand(
      "/usr/sbin/sysctl",
      ["-n", "kern.hv_support"],
      Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }),
      { arguments: [], timeoutMs: 10_000, maxOutputBytes: 16_384 },
    );
    if (result.exitCode !== 0 || decode(result.stdout).trim() !== "1") {
      throw new MacOsLimaSandboxError(
        "capability_unavailable",
        "Apple Virtualization.framework is unavailable",
        "Enable hardware virtualization on the execution host.",
      );
    }
  }

  async #requireTemplate(): Promise<LimaTemplateReceipt> {
    await this.#assertHostCapability();
    const templateConfigPath = join(
      this.#options.limaHome,
      this.#options.template.templateInstanceName,
      "lima.yaml",
    );
    const templateConfig = await lstat(templateConfigPath);
    if (!templateConfig.isFile() || templateConfig.isSymbolicLink()) {
      throw new MacOsLimaSandboxError(
        "template_mismatch",
        "immutable Lima template config is not a regular file",
        "Rebuild the immutable Lima template.",
      );
    }
    await chmod(templateConfigPath, 0o400);
    const receipt = await verifyLimaTemplate(
      this.#options.template,
      this.#options.expectedTemplateFingerprint,
    );
    return receipt;
  }

  async #inspect(instanceName: string): Promise<LimaInstanceInspection | undefined> {
    if (
      !instanceNamePattern.test(instanceName) &&
      instanceName !== this.#options.template.templateInstanceName
    ) {
      throw new MacOsLimaSandboxError(
        "receipt_invalid",
        "Lima instance name is invalid",
        "Inspect the durable sandbox registry before retrying.",
      );
    }
    const result = await this.#run(
      ["list", "--json"],
      lifecycleCommandTimeoutMs,
      lifecycleOutputLimit,
    );
    if (result.exitCode !== 0) {
      throw commandError("limactl list failed", result);
    }
    const lines = decode(result.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const record = parseObject(line, "Lima instance list record");
      if (record["name"] !== instanceName) continue;
      const status = record["status"];
      const vmType = record["vmType"] ?? record["vmtype"];
      const dir = record["dir"];
      if (
        (status !== "Running" && status !== "Stopped") ||
        typeof vmType !== "string" ||
        typeof dir !== "string"
      ) {
        throw new MacOsLimaSandboxError(
          "receipt_invalid",
          "Lima returned malformed instance state",
          "Upgrade Lima to the supported version and rerun host doctor.",
        );
      }
      const expectedDirectory = join(this.#options.limaHome, instanceName);
      if (resolve(dir) !== resolve(expectedDirectory)) {
        throw new MacOsLimaSandboxError(
          "instance_conflict",
          "Lima instance directory escaped the dedicated LIMA_HOME",
          "Remove the conflicting Lima configuration and rerun setup.",
        );
      }
      return Object.freeze({ name: instanceName, status, vmType, dir });
    }
    return undefined;
  }

  async #requireInspection(instanceName: string): Promise<LimaInstanceInspection> {
    const inspection = await this.#inspect(instanceName);
    if (inspection === undefined) {
      throw new MacOsLimaSandboxError(
        "instance_not_found",
        "Lima sandbox instance is missing",
        "Reconcile the node and create a new attempt.",
      );
    }
    if (inspection.vmType !== "vz") {
      throw new MacOsLimaSandboxError(
        "instance_state_invalid",
        "Lima sandbox instance is not using the VZ backend",
        "Delete the invalid instance explicitly and rebuild from the VZ template.",
      );
    }
    return inspection;
  }

  async #installNetworkPolicy(instanceName: string, policy: SandboxPolicy): Promise<void> {
    const hosts = await resolveNetworkHosts(policy);
    const script = networkPolicyScript(policy, hosts);
    await this.#shell(
      instanceName,
      ["sudo", "/bin/bash", "-c", script],
      lifecycleCommandTimeoutMs,
      lifecycleOutputLimit,
    );
    await this.#shell(instanceName, ["/bin/sleep", "2"], 5_000, 16_384);
    const privilegeProbe = await this.#shell(
      instanceName,
      ["sudo", "-n", "true"],
      5_000,
      16_384,
      undefined,
      false,
    );
    if (privilegeProbe.exitCode === 0) {
      throw new MacOsLimaSandboxError(
        "network_policy_invalid",
        "sandbox guest retained host-admin privileges",
        "Rebuild the immutable Lima template and verify privilege removal.",
      );
    }
  }

  async #terminateExecutionUnit(instanceName: string, unitName: string): Promise<void> {
    const stop = await this.#shell(
      instanceName,
      ["systemctl", "--user", "stop", "--no-block", unitName],
      lifecycleCommandTimeoutMs,
      16_384,
      undefined,
      false,
    );
    if (stop.exitCode !== 0 && !/not loaded|not found/iu.test(decode(stop.stderr))) {
      throw commandError("guest execution unit stop failed", stop);
    }
    const deadline = Date.now() + lifecycleCommandTimeoutMs;
    while (Date.now() < deadline) {
      const active = await this.#shell(
        instanceName,
        ["systemctl", "--user", "is-active", unitName],
        lifecycleCommandTimeoutMs,
        16_384,
        undefined,
        false,
      );
      if (active.exitCode !== 0) return;
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 50).unref();
      });
    }
    throw new MacOsLimaSandboxError(
      "command_timeout",
      "guest execution unit still has live processes after cgroup termination",
      "Inspect the guest cgroup and resolve the stalled process tree before retrying.",
    );
  }

  async #reconcileOrphan(
    instanceId: string,
    inspection: LimaInstanceInspection,
    template: LimaTemplateReceipt,
    policy: SandboxPolicy | undefined,
  ): Promise<void> {
    if (inspection.name !== instanceId || inspection.vmType !== "vz") {
      throw new MacOsLimaSandboxError(
        "instance_conflict",
        "orphaned Lima VM provenance does not match the requested sandbox",
        "Inspect and explicitly remove the conflicting Lima VM.",
      );
    }
    await assertOrphanConfiguration(inspection.dir, this.#options, template, policy);
    await this.#runChecked(
      ["delete", "--force", instanceId, "--tty=false"],
      lifecycleCommandTimeoutMs,
      lifecycleOutputLimit,
    );
    const remaining = await this.#inspect(instanceId);
    if (remaining !== undefined) {
      throw new MacOsLimaSandboxError(
        "instance_conflict",
        "orphaned Lima VM could not be reconciled",
        "Inspect and explicitly remove the orphaned Lima VM before retrying.",
      );
    }
  }
  async #shell(
    instanceName: string,
    command: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
    workingDirectory?: string,
    checked = true,
    input?: Uint8Array,
  ): Promise<CommandResult> {
    const arguments_ = ["shell"];
    if (workingDirectory !== undefined) arguments_.push(`--workdir=${workingDirectory}`);
    arguments_.push(instanceName, "--", ...command);
    const result = await this.#run(arguments_, timeoutMs, maxOutputBytes, input);
    if (checked && result.exitCode !== 0) throw commandError("Lima guest command failed", result);
    return result;
  }

  async #runChecked(
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<CommandResult> {
    const result = await this.#run(arguments_, timeoutMs, maxOutputBytes);
    if (result.exitCode !== 0) throw commandError("limactl command failed", result);
    return result;
  }

  #run(
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
    input?: Uint8Array,
  ): Promise<CommandResult> {
    const commandArguments = ["--log-level=fatal", ...arguments_];
    return runHostCommand(
      this.#options.limactlPath,
      commandArguments,
      Object.freeze({
        HOME: dirname(this.#options.limaHome),
        LANG: "C",
        LC_ALL: "C",
        LIMA_HOME: this.#options.limaHome,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      }),
      {
        arguments: commandArguments,
        timeoutMs,
        maxOutputBytes,
        ...(input === undefined ? {} : { input }),
      },
    );
  }

  async #deleteFailedClone(instanceId: string, original: unknown): Promise<void> {
    try {
      const inspection = await this.#inspect(instanceId);
      if (inspection !== undefined) {
        await makeCloneWritable(join(this.#options.limaHome, instanceId));
        await this.#runChecked(
          ["delete", "--force", instanceId, "--tty=false"],
          lifecycleCommandTimeoutMs,
          lifecycleOutputLimit,
        );
      }
      await rm(this.#receiptPath(instanceId), { force: true });
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
      throw new MacOsLimaSandboxError(
        "instance_not_found",
        "sandbox receipt is missing",
        "Reconcile the node and create a new attempt.",
      );
    }
    return receipt;
  }

  async #readReceipt(instanceId: string): Promise<SandboxReceipt | undefined> {
    if (!instanceNamePattern.test(instanceId)) {
      throw new MacOsLimaSandboxError(
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
    const receipt = parseReceipt(bytes, instanceId);
    if (!sameFingerprint(receipt.templateFingerprint, this.#options.expectedTemplateFingerprint)) {
      throw new MacOsLimaSandboxError(
        "template_mismatch",
        "sandbox receipt template fingerprint does not match the configured Lima template",
        "Rebuild the sandbox from the verified Lima template.",
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
      throw new MacOsLimaSandboxError(
        "filesystem_error",
        "cannot durably write the Lima sandbox receipt",
        "Inspect the dedicated sandbox state directory before retrying.",
        { cause: error },
      );
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  #receiptDirectory(): string {
    return join(this.#options.stateDirectory, "lima-sandboxes");
  }

  #receiptPath(instanceId: string): string {
    return join(this.#receiptDirectory(), `${instanceId}.json`);
  }
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

async function enforceExecutionPolicy(
  policy: SandboxPolicy,
  request: ExecuteSandboxRequest,
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
  enforceNetworkPolicy(policy, request.arguments);
  enforceResourceProbes(policy, request);
  await enforcePathPolicy(policy, request);
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
      if (
        !policy.network.allowedHosts.includes(host) &&
        !(policy.network.allowProviderGateway && host === "host.lima.internal")
      ) {
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

function isForbiddenNetworkAddress(host: string, allowProviderGateway: boolean): boolean {
  if (isLoopbackHost(host) || isLinkLocalHost(host)) return true;
  if (allowProviderGateway && isPrivateHost(host)) return false;
  return isPrivateHost(host) || ipv4InRange(host, [0, 0, 0, 0], 8) || ipv6InRange(host, "::", 128);
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

async function assertOwnerWritable(path: string, field: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o200) === 0) {
    throw new MacOsLimaSandboxError(
      "filesystem_error",
      `${field} is not an owner-writable regular file`,
      "Inspect and explicitly remove the named clone before retrying.",
    );
  }
}

async function makeCloneWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    const entries = await readdir(path);
    for (const entry of entries) await makeCloneWritable(join(path, entry));
    return;
  }
  if (metadata.isSocket()) return;
  if (!metadata.isFile()) {
    throw new MacOsLimaSandboxError(
      "filesystem_error",
      `Lima clone contains an unsupported filesystem entry: ${path}`,
      "Inspect and explicitly remove the named clone before retrying.",
    );
  }
  await chmod(path, 0o600);
}

/**
 * P1 (review #17) + Codex inline comment on this function: the previous
 * check rejected any mount source CONTAINED WITHIN homedir() at all - which
 * rejects every ordinary `/Users/<user>/repo` workspace (the backend was
 * unusable for real repos) - while accepting anything OUTSIDE limaHome/
 * stateDirectory/homedir entirely, so `/Library`, `/private/etc`, `/dev`,
 * `/var`, etc. passed through unchecked and could be mounted (read-only or
 * read-write) against host secrets/system files. Fixed to an explicit
 * denylist of EXACT sensitive macOS roots (never a valid mount source,
 * regardless of caller intent) instead of a homedir-containment blacklist -
 * a real workspace living somewhere under homedir (the normal case) is no
 * longer rejected, while these categorically-sensitive roots now are.
 */
const SENSITIVE_MACOS_MOUNT_SOURCE_ROOTS = new Set([
  "/",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/etc",
  "/private",
  "/private/etc",
  "/private/var",
  "/var",
  "/dev",
  "/Volumes",
]);

export async function assertHostMounts(
  policy: SandboxPolicy,
  options: MacOsLimaSandboxOptions,
): Promise<void> {
  const protectedRoots = [resolve(options.limaHome), resolve(options.stateDirectory)];
  for (const mount of policy.mounts) {
    const sourcePath = resolve(mount.sourcePath);
    let metadata;
    try {
      metadata = await lstat(sourcePath);
    } catch (error: unknown) {
      throw new MacOsLimaSandboxError(
        "invalid_configuration",
        `sandbox mount source is unavailable: ${sourcePath}`,
        "Create the exact non-symlink mount directory before starting the sandbox.",
        { cause: error },
      );
    }
    const actualPath = await realpath(sourcePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || actualPath !== sourcePath) {
      throw new MacOsLimaSandboxError(
        "invalid_configuration",
        `sandbox mount source is not a real directory: ${sourcePath}`,
        "Use a canonical non-symlink workspace directory.",
      );
    }
    if (
      protectedRoots.some(
        (protectedRoot) =>
          pathContainedBy(sourcePath, protectedRoot) || pathContainedBy(protectedRoot, sourcePath),
      ) ||
      SENSITIVE_MACOS_MOUNT_SOURCE_ROOTS.has(sourcePath)
    ) {
      throw new MacOsLimaSandboxError(
        "invalid_configuration",
        `sandbox mount source contains protected host state: ${sourcePath}`,
        "Mount only the repository workspace and explicit read-only package sources.",
      );
    }
  }
}

async function assertOrphanConfiguration(
  instancePath: string,
  options: MacOsLimaSandboxOptions,
  template: LimaTemplateReceipt,
  policy: SandboxPolicy | undefined,
): Promise<void> {
  await assertSecureDirectory(instancePath);
  const configPath = join(instancePath, "lima.yaml");
  await assertRegularConfinedFile(configPath, instancePath);
  const templatePath = join(options.limaHome, template.instanceName);
  await assertSecureDirectory(templatePath);
  const templateConfigPath = join(templatePath, "lima.yaml");
  await assertRegularConfinedFile(templateConfigPath, templatePath);
  const [configText, templateConfigText] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(templateConfigPath, "utf8"),
  ]);
  const requiredScalars: readonly (readonly [string, string])[] = [
    ["vmType", "vz"],
    ["mountType", "virtiofs"],
    ["portForwards", "[]"],
  ];
  for (const [key, expected] of requiredScalars) {
    if (yamlTopLevelScalar(configText, key) !== expected) {
      throw new MacOsLimaSandboxError(
        "instance_conflict",
        `orphaned Lima VM has an unexpected ${key} configuration`,
        "Inspect and explicitly remove the conflicting Lima VM.",
      );
    }
  }
  if (
    yamlNestedScalar(configText, "hostResolver", "enabled") !== "false" ||
    yamlNestedScalar(configText, "ssh", "overVsock") !== "false"
  ) {
    throw new MacOsLimaSandboxError(
      "instance_conflict",
      "orphaned Lima VM has unsafe host integration settings",
      "Inspect and explicitly remove the conflicting Lima VM.",
    );
  }
  if (policy !== undefined) {
    const expectedCpu = String(policy.resources.cpuCount);
    const expectedMemory = `${String(policy.resources.memoryMiB / 1024)}GiB`;
    const expectedDisk = `${String(Math.ceil(policy.resources.storageMiB / 1024))}GiB`;
    if (
      yamlTopLevelScalar(configText, "cpus") !== expectedCpu ||
      normalizeQuantity(yamlTopLevelScalar(configText, "memory")) !== expectedMemory ||
      normalizeQuantity(yamlTopLevelScalar(configText, "disk")) !== expectedDisk
    ) {
      throw new MacOsLimaSandboxError(
        "instance_conflict",
        "orphaned Lima VM resources do not match the requested policy",
        "Inspect and explicitly remove the conflicting Lima VM.",
      );
    }
    const expectedMounts = policy.mounts.map((mount) => ({
      location: mount.sourcePath,
      mountPoint: mount.targetPath,
      writable: mount.access === "read_write",
    }));
    const actualMounts = parseMountEntries(configText);
    if (
      actualMounts.length !== expectedMounts.length ||
      expectedMounts.some(
        (expected) =>
          !actualMounts.some(
            (actual) =>
              actual.location === expected.location &&
              actual.mountPoint === expected.mountPoint &&
              actual.writable === expected.writable,
          ),
      )
    ) {
      throw new MacOsLimaSandboxError(
        "instance_conflict",
        "orphaned Lima VM mounts do not match the requested policy",
        "Inspect and explicitly remove the conflicting Lima VM.",
      );
    }
  }
  for (const key of ["images", "provision", "containerd", "networks"]) {
    if (canonicalYamlSection(configText, key) !== canonicalYamlSection(templateConfigText, key)) {
      throw new MacOsLimaSandboxError(
        "instance_conflict",
        `orphaned Lima VM ${key} configuration is not inherited from the verified template`,
        "Inspect and explicitly remove the conflicting Lima VM.",
      );
    }
  }
}

function yamlTopLevelScalar(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*:\\s*(.*?)\\s*(?:#.*)?$`, "mu").exec(text);
  const value = match?.[1]?.trim();
  if (value === undefined) return undefined;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function yamlNestedScalar(text: string, section: string, key: string): string | undefined {
  const sectionText = yamlSectionText(text, section);
  const match = new RegExp(`^\\s+${key}\\s*:\\s*(.*?)\\s*(?:#.*)?$`, "mu").exec(sectionText);
  return match?.[1]?.trim();
}

function yamlSectionText(text: string, key: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:\\s*$`, "u").test(line));
  if (start < 0) return "";
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    section.push(line);
  }
  return section.join("\n");
}

function normalizeQuantity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+(?:\.\d+)?)(?:GiB|G|g)?$/u.exec(value);
  if (match?.[1] === undefined) return undefined;
  return `${String(Number(match[1]))}GiB`;
}

function parseMountEntries(
  text: string,
): readonly Readonly<{ location: string; mountPoint: string; writable: boolean }>[] {
  const lines = text.split("\n");
  const entries: { location: string; mountPoint: string; writable: boolean }[] = [];
  let inMounts = false;
  let current: { location: string; mountPoint: string; writable: boolean } | undefined;
  const finish = (): void => {
    if (current !== undefined) entries.push(current);
    current = undefined;
  };
  for (const line of lines) {
    if (/^mounts\s*:\s*$/u.test(line)) {
      finish();
      inMounts = true;
      continue;
    }
    if (inMounts && /^\S/u.test(line)) {
      finish();
      inMounts = false;
      continue;
    }
    if (!inMounts) continue;
    const locationMatch = /^\s*-\s+location\s*:\s*(.*?)\s*$/u.exec(line);
    if (locationMatch?.[1] !== undefined) {
      finish();
      current = {
        location: unquoteYamlScalar(locationMatch[1]),
        mountPoint: "",
        writable: false,
      };
      continue;
    }
    if (current === undefined) continue;
    const mountPointMatch = /^\s+mountPoint\s*:\s*(.*?)\s*$/u.exec(line);
    if (mountPointMatch?.[1] !== undefined)
      current.mountPoint = unquoteYamlScalar(mountPointMatch[1]);
    const writableMatch = /^\s+writable\s*:\s*(true|false)\s*$/u.exec(line);
    if (writableMatch?.[1] !== undefined) current.writable = writableMatch[1] === "true";
  }
  finish();
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function canonicalYamlSection(text: string, key: string): string {
  const sectionText = yamlSectionText(text, key);
  if (sectionText.length === 0) return yamlTopLevelScalar(text, key) ?? "";
  return sectionText
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim().replace(/\s+/gu, " "))
    .filter((line) => line.length > 0)
    .join("\n");
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function executionUnitPaths(executable: string): readonly string[] {
  const executablePaths = isAbsolute(executable)
    ? [resolve(executable)]
    : environmentPath.split(":").map((directory) => join(directory, executable));
  return Object.freeze([
    ...new Set([
      ...environmentPath.split(":").map((directory) => join(directory, "env")),
      ...executablePaths,
    ]),
  ]);
}

function pathContainedBy(path: string, root: string): boolean {
  const relation = relative(root, path);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

function validateOptions(options: MacOsLimaSandboxOptions): MacOsLimaSandboxOptions {
  for (const [field, value] of Object.entries({
    limactlPath: options.limactlPath,
    limaHome: options.limaHome,
    stateDirectory: options.stateDirectory,
  })) {
    if (typeof value !== "string" || !isAbsolute(value) || basename(value).length === 0) {
      throw new MacOsLimaSandboxError(
        "invalid_configuration",
        `${field} must be an absolute path`,
        "Run host setup with explicit dedicated Lima and state paths.",
      );
    }
  }
  if (resolve(options.template.limaHome) !== resolve(options.limaHome)) {
    throw new MacOsLimaSandboxError(
      "invalid_configuration",
      "template and sandbox LIMA_HOME must match",
      "Use one dedicated LIMA_HOME for the immutable template and its clones.",
    );
  }
  if (!fingerprintPattern.test(options.expectedTemplateFingerprint.digest)) {
    throw new MacOsLimaSandboxError(
      "invalid_configuration",
      "expected Lima template fingerprint is invalid",
      "Configure the exact fingerprint returned by template preparation.",
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

function mountExpression(policy: SandboxPolicy): string {
  const mounts = policy.mounts.map((mount) => ({
    location: mount.sourcePath,
    mountPoint: mount.targetPath,
    writable: mount.access === "read_write",
  }));
  return `.mounts = ${JSON.stringify(mounts)}`;
}

function executionEnvironment(
  receipt: SandboxReceipt,
  requested: Readonly<Record<string, string>>,
): string[] {
  const forbidden =
    /^(?:BASH_ENV|CDPATH|ENV|GIT_CONFIG_|GIT_DIR|GIT_WORK_TREE|HOME|IFS|LD_|PATH|PERL5OPT|PYTHONPATH|RUBYOPT|SHELLOPTS)/u;
  const entries = Object.entries(requested).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || forbidden.test(key) || value.includes("\0")) {
      throw new MacOsLimaSandboxError(
        "policy_mismatch",
        `sandbox environment key ${key} is forbidden`,
        "Remove environment overrides that can alter command, Git, or runtime loading behavior.",
      );
    }
  }
  return [
    `HOME=${receipt.guestHome}`,
    `PATH=${environmentPath}`,
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    ...entries.map(([key, value]) => `${key}=${value}`),
  ];
}

async function resolveNetworkHosts(policy: SandboxPolicy): Promise<readonly ResolvedNetworkHost[]> {
  const requestedHosts = [
    ...policy.network.allowedHosts,
    ...(policy.network.allowProviderGateway ? ["host.lima.internal"] : []),
  ];
  const resolved: ResolvedNetworkHost[] = [];
  const seen = new Set<string>();
  for (const rawHost of requestedHosts) {
    const hostname =
      rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    if (seen.has(hostname)) continue;
    seen.add(hostname);
    if (
      hostname === "metadata" ||
      hostname === "metadata.google.internal" ||
      hostname === "instance-data.ec2.internal"
    ) {
      throw new MacOsLimaSandboxError(
        "network_policy_invalid",
        `network allowlist contains a metadata host: ${hostname}`,
        "Remove metadata and local hosts from the sandbox network allowlist.",
      );
    }
    let records;
    try {
      records = await lookupHost(hostname, { all: true, verbatim: true });
    } catch (error: unknown) {
      throw new MacOsLimaSandboxError(
        "network_policy_invalid",
        `network allowlist host could not be resolved: ${hostname}`,
        "Use a stable host with one trusted DNS result before starting the sandbox.",
        { cause: error },
      );
    }
    const addresses = [...new Set(records.map((record) => record.address))];
    if (addresses.length !== 1) {
      throw new MacOsLimaSandboxError(
        "network_policy_invalid",
        `network allowlist host has an ambiguous resolution: ${hostname}`,
        "Use a host with exactly one trusted address for the sandbox operation.",
      );
    }
    const address = addresses[0];
    if (address === undefined) {
      throw new MacOsLimaSandboxError(
        "network_policy_invalid",
        `network allowlist host has no address: ${hostname}`,
        "Use a resolvable host before starting the sandbox.",
      );
    }
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      throw new MacOsLimaSandboxError(
        "network_policy_invalid",
        `network allowlist host returned an invalid address: ${hostname}`,
        "Use a host that resolves to one IPv4 or IPv6 address.",
      );
    }
    const providerGateway =
      policy.network.allowProviderGateway && hostname === "host.lima.internal";
    if (isForbiddenNetworkAddress(address, providerGateway)) {
      throw new MacOsLimaSandboxError(
        "network_policy_invalid",
        `network allowlist host resolves to a protected address: ${hostname}`,
        "Remove private, link-local, loopback, and metadata destinations from the sandbox network allowlist.",
      );
    }
    resolved.push(Object.freeze({ hostname, address, family }));
  }
  return Object.freeze(resolved);
}

function networkPolicyScript(policy: SandboxPolicy, hosts: readonly ResolvedNetworkHost[]): string {
  const expectedHostCount = new Set(
    [
      ...policy.network.allowedHosts,
      ...(policy.network.allowProviderGateway ? ["host.lima.internal"] : []),
    ].map((host) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)),
  ).size;
  if (hosts.length !== expectedHostCount) {
    throw new MacOsLimaSandboxError(
      "network_policy_invalid",
      "network allowlist resolution does not match the requested policy",
      "Resolve every allowed host exactly once before installing the guest firewall.",
    );
  }
  const hostEntries = hosts.map(({ hostname, address }) =>
    shellQuote(`${address}\t${hostname} # minions sandbox pinned host`),
  );
  const ipv4Rules = hosts
    .filter((host) => host.family === 4)
    .map(({ address }) => `-A MINIONS_EGRESS -d ${address} -p tcp --dport 443 -j ACCEPT`);
  const ipv6Rules = hosts
    .filter((host) => host.family === 6)
    .map(({ address }) => `-A MINIONS_V6_EGRESS -d ${address} -p tcp --dport 443 -j ACCEPT`);
  return `set -euo pipefail
pinned_hosts=$(mktemp /etc/hosts.minions.XXXXXX)
awk '!/# minions sandbox pinned host$/' /etc/hosts > "$pinned_hosts"
${hostEntries.map((entry) => `printf '%s\\n' ${entry} >> "$pinned_hosts"`).join("\n")}
install -m 0644 "$pinned_hosts" /etc/hosts
rm -f "$pinned_hosts"
iptables-restore <<'MINIONS_IPV4_RULES'
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:MINIONS_EGRESS - [0:0]
-A OUTPUT -p tcp --sport 22 -j ACCEPT
-A OUTPUT -o lo -j REJECT
-A OUTPUT -j MINIONS_EGRESS
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A INPUT -p tcp --dport 22 -j ACCEPT
-A INPUT -j REJECT
${ipv4Rules.join("\n")}
-A MINIONS_EGRESS -d 127.0.0.0/8 -j REJECT
-A MINIONS_EGRESS -d 10.0.0.0/8 -j REJECT
-A MINIONS_EGRESS -d 100.64.0.0/10 -j REJECT
-A MINIONS_EGRESS -d 169.254.0.0/16 -j REJECT
-A MINIONS_EGRESS -d 172.16.0.0/12 -j REJECT
-A MINIONS_EGRESS -d 192.168.0.0/16 -j REJECT
-A MINIONS_EGRESS -j REJECT
COMMIT
MINIONS_IPV4_RULES
ip6tables-restore <<'MINIONS_IPV6_RULES'
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:MINIONS_V6_EGRESS - [0:0]
-A OUTPUT -p tcp --sport 22 -j ACCEPT
-A OUTPUT -o lo -j REJECT
-A OUTPUT -j MINIONS_V6_EGRESS
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A INPUT -p tcp --dport 22 -j ACCEPT
-A INPUT -j REJECT
${ipv6Rules.join("\n")}
-A MINIONS_V6_EGRESS -d ::1/128 -j REJECT
-A MINIONS_V6_EGRESS -d fc00::/7 -j REJECT
-A MINIONS_V6_EGRESS -d fe80::/10 -j REJECT
-A MINIONS_V6_EGRESS -j REJECT
COMMIT
MINIONS_IPV6_RULES
nohup /bin/bash -c 'sleep 1; rm -f /etc/sudoers.d/90-lima-users /etc/sudoers.d/lima; chmod 0750 /usr/bin/sudo' </dev/null >/dev/null 2>&1 &
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
    throw new MacOsLimaSandboxError(
      "instance_conflict",
      "sandbox idempotency key was reused with different request facts",
      "Create a new attempt with a new idempotency key.",
    );
  }
}

function receiptInstance(receipt: SandboxReceipt, status: LimaInstanceState): SandboxInstance {
  const state: SandboxInstance["state"] =
    status === "Stopped" ? "stopped" : receipt.state === "created" ? "created" : "running";
  return Object.freeze({
    instanceId: receipt.instanceId,
    context: receipt.context,
    backendKind: "macos_lima",
    policyFingerprint: receipt.policyFingerprint,
    state,
  });
}

function parseReceipt(value: string, expectedInstanceId: string): SandboxReceipt {
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
    throw new MacOsLimaSandboxError(
      "receipt_invalid",
      "sandbox receipt policy fingerprint does not match the stored policy",
      "Restore the durable receipt from backup or explicitly purge the failed node.",
    );
  }
  if (policy.templateDigest !== templateFingerprint.digest) {
    throw new MacOsLimaSandboxError(
      "receipt_invalid",
      "sandbox receipt policy template digest does not match its template fingerprint",
      "Restore the durable receipt from backup or explicitly purge the failed node.",
    );
  }
  if (
    record["schemaVersion"] !== receiptSchemaVersion ||
    record["instanceId"] !== expectedInstanceId ||
    record["limaInstanceName"] !== expectedInstanceId ||
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
    throw new MacOsLimaSandboxError(
      "receipt_invalid",
      "sandbox receipt is malformed",
      "Restore the durable receipt from backup or explicitly purge the failed node.",
    );
  }
  return Object.freeze({
    schemaVersion: receiptSchemaVersion,
    instanceId: expectedInstanceId,
    limaInstanceName: expectedInstanceId,
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
    throw new MacOsLimaSandboxError(
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
      throw new MacOsLimaSandboxError(
        "receipt_invalid",
        `${field} is not valid JSON`,
        "Inspect the Lima installation and durable state before retrying.",
        error,
      );
    }
  }
  if (!isUnknownRecord(parsed)) {
    throw new MacOsLimaSandboxError(
      "receipt_invalid",
      `${field} must be an object`,
      "Inspect the Lima installation and durable state before retrying.",
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
    throw new MacOsLimaSandboxError(
      "template_mismatch",
      `${operation} fingerprint mismatch`,
      "Rebuild the sandbox template or create a new attempt with the current policy.",
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
    throw new MacOsLimaSandboxError(
      "filesystem_error",
      "sandbox receipt directory is not a real directory",
      "Restore the dedicated sandbox state directory without symlinks.",
    );
  }
}

async function assertRegularConfinedFile(path: string, root: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new MacOsLimaSandboxError(
      "receipt_invalid",
      "sandbox receipt is not a regular file",
      "Restore the durable receipt directory with owner-only regular files.",
    );
  }
  const [actualPath, actualRoot] = await Promise.all([realpath(path), realpath(root)]);
  if (actualPath !== actualRoot && !actualPath.startsWith(`${actualRoot}${sep}`)) {
    throw new MacOsLimaSandboxError(
      "receipt_invalid",
      "sandbox receipt escapes the durable state directory",
      "Restore the durable receipt directory with owner-only regular files.",
    );
  }
  const rootMetadata = await stat(root);
  if ((rootMetadata.mode & 0o077) !== 0) {
    throw new MacOsLimaSandboxError(
      "receipt_invalid",
      "sandbox receipt directory permissions are too broad",
      "Set the durable sandbox receipt directory to mode 0700.",
    );
  }
}

function errorCode(error: unknown): string {
  if (error instanceof MacOsLimaSandboxError || error instanceof LimaTemplateError) {
    return error.code;
  }
  return "capability_probe_failed";
}

function commandError(message: string, result: CommandResult): MacOsLimaSandboxError {
  return new MacOsLimaSandboxError(
    "command_failed",
    `${message}: ${decode(result.stderr).trim() || `exit ${String(result.exitCode)}`}`,
    "Run host doctor, inspect the named Lima VM, and resolve the reported capability failure.",
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
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      rejectPromise(
        new MacOsLimaSandboxError(
          "command_failed",
          "Lima process could not be started",
          "Install the configured Lima version and rerun host doctor.",
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
        new MacOsLimaSandboxError(
          "command_timeout",
          `Lima ${commandLabel(request.arguments)} command exceeded its bounded timeout`,
          "Inspect the VM and retry only after resolving the stalled operation.",
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
          new MacOsLimaSandboxError(
            "output_limit",
            `Lima ${commandLabel(request.arguments)} command exceeded its bounded output limit`,
            "Inspect the VM logs directly and resolve the noisy operation.",
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
        new MacOsLimaSandboxError(
          "command_failed",
          "Lima command process failed",
          "Install the configured Lima version and rerun host doctor.",
          error,
        ),
      );
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === null) {
        finish(
          new MacOsLimaSandboxError(
            "command_failed",
            `Lima command terminated by ${signal ?? "unknown signal"}`,
            "Inspect the VM and retry only after resolving the terminated operation.",
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
    if (request.input === undefined) child.stdin?.end();
    else child.stdin?.end(request.input);

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
  if (operation !== "shell") return operation;
  const separator = arguments_.indexOf("--");
  const guestExecutable = separator >= 0 ? arguments_[separator + 1] : undefined;
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
        `cannot terminate the Lima command with ${signal}`,
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
