import { posix } from "node:path";
import {
  contentHash,
  productionSandboxBackendKinds,
  sandboxNetworkProfiles,
  type ContentHash,
  type CreateSandboxRequest,
  type ExecuteSandboxRequest,
  type ProductionSandboxBackendKind,
  type SandboxAttemptContext,
  type SandboxCapabilityProbe,
  type SandboxExecutionResult,
  type SandboxInstance,
  type SandboxLifecycle,
  type SandboxNetworkProfile,
  type SandboxPolicy,
  type SandboxPolicyFingerprint,
  type SandboxPolicyFingerprinter,
} from "@minions/core";
import { createSandboxPolicyFingerprinter, validateSandboxPolicy } from "./sandbox-policy.js";

export type ProductionSandboxLifecycleErrorCode =
  | "invalid_backend_kind"
  | "backend_kind_mismatch"
  | "probe_failed"
  | "backend_unavailable"
  | "template_fingerprint_mismatch"
  | "capability_missing"
  | "invalid_probe"
  | "network_profile_unsupported"
  | "invalid_request"
  | "policy_fingerprint_mismatch"
  | "idempotency_conflict"
  | "instance_not_found"
  | "instance_stopped"
  | "instance_destroyed"
  | "instance_identity_mismatch"
  | "backend_result_invalid"
  | "output_limit"
  | "policy_violation";

export class ProductionSandboxLifecycleError extends Error {
  readonly code: ProductionSandboxLifecycleErrorCode;

  constructor(code: ProductionSandboxLifecycleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductionSandboxLifecycleError";
    this.code = code;
  }
}

export type CreateProductionSandboxLifecycleOptions = Readonly<{
  lifecycle: SandboxLifecycle;
  backendKind: ProductionSandboxBackendKind;
  templateFingerprint: ContentHash;
  fingerprinter?: SandboxPolicyFingerprinter;
}>;

export interface ProductionSandboxLifecycle extends SandboxLifecycle {
  readonly backendKind: ProductionSandboxBackendKind;
}

type ManagedInstance = Readonly<{
  instance: SandboxInstance;
  policyFingerprint: SandboxPolicyFingerprint;
  context: SandboxAttemptContext;
  idempotencyKey: string;
  policy: SandboxPolicy;
  state: SandboxInstance["state"];
}>;

type IdempotencyRecord = Readonly<{
  instanceId: string;
  context: SandboxAttemptContext;
  policyFingerprint: SandboxPolicyFingerprint;
  destroyed: boolean;
}>;

type UnknownRecord = Record<string, unknown>;

const productionBackendSet = new Set<string>(productionSandboxBackendKinds);
const networkProfileSet = new Set<string>(sandboxNetworkProfiles);
const digestPattern = /^[0-9a-f]{64}$/u;
const requiredCapabilities = [
  ["readOnlyMounts", "read-only mounts"],
  ["processIsolation", "process isolation"],
  ["privateNetworkBlocking", "private-network blocking"],
  ["toolFiltering", "tool filtering"],
] as const;
const contextKeys = ["attemptId", "nodeId", "repositoryId", "hostId"] as const;

export async function createProductionSandboxLifecycle(
  options: CreateProductionSandboxLifecycleOptions,
): Promise<ProductionSandboxLifecycle> {
  validateBackendKind(options.backendKind, "requested backend kind");
  if (!isProductionBackendKind(options.lifecycle.backendKind)) {
    throw new ProductionSandboxLifecycleError(
      "invalid_backend_kind",
      "the sandbox lifecycle backend kind is unavailable for production",
    );
  }
  if (options.lifecycle.backendKind !== options.backendKind) {
    throw new ProductionSandboxLifecycleError(
      "backend_kind_mismatch",
      "sandbox lifecycle backend kind does not match the requested backend kind",
    );
  }
  const templateFingerprint = validateContentHash(
    options.templateFingerprint,
    "template fingerprint",
  );
  const probe = await probeBackend(options.lifecycle);
  validateProbe(probe, options.backendKind, templateFingerprint);
  return new ProductionLifecycle(
    options.lifecycle,
    probe,
    options.fingerprinter ?? createSandboxPolicyFingerprinter(),
  );
}

class ProductionLifecycle implements ProductionSandboxLifecycle {
  readonly backendKind: ProductionSandboxBackendKind;
  readonly #lifecycle: SandboxLifecycle;
  readonly #probe: Extract<SandboxCapabilityProbe, { available: true }>;
  readonly #fingerprinter: SandboxPolicyFingerprinter;
  readonly #instances = new Map<string, ManagedInstance>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #destroyed = new Set<string>();
  readonly #createOperations = new Map<string, Promise<void>>();
  readonly #instanceOperations = new Map<string, Promise<void>>();

  constructor(
    lifecycle: SandboxLifecycle,
    probe: Extract<SandboxCapabilityProbe, { available: true }>,
    fingerprinter: SandboxPolicyFingerprinter,
  ) {
    this.#lifecycle = lifecycle;
    this.backendKind = probe.backendKind as ProductionSandboxBackendKind;
    this.#probe = probe;
    this.#fingerprinter = fingerprinter;
  }

  probe(): Promise<SandboxCapabilityProbe> {
    return Promise.resolve(this.#probe);
  }

  create(request: CreateSandboxRequest): Promise<SandboxInstance> {
    return this.#serialize(this.#createOperations, request.idempotencyKey, () =>
      this.#createSerialized(request),
    );
  }

  async #createSerialized(request: CreateSandboxRequest): Promise<SandboxInstance> {
    const policy = validateSandboxPolicy(request.policy);
    validateCreateRequest(request);
    if (policy.templateDigest !== this.#probe.templateFingerprint) {
      throw new ProductionSandboxLifecycleError(
        "template_fingerprint_mismatch",
        "sandbox policy template digest does not match the probed template fingerprint",
      );
    }
    if (
      !isSupportedNetworkProfile(
        policy.network.profile,
        this.#probe.capabilities.supportedNetworkProfiles,
      )
    ) {
      throw new ProductionSandboxLifecycleError(
        "network_profile_unsupported",
        `sandbox backend does not support the ${policy.network.profile} network profile`,
      );
    }
    assertMatchingPolicyFingerprint(this.#fingerprinter, request.policy, request.policyFingerprint);

    const replay = this.#idempotency.get(request.idempotencyKey);
    if (replay !== undefined) {
      if (replay.destroyed || this.#destroyed.has(replay.instanceId)) {
        throw new ProductionSandboxLifecycleError(
          "idempotency_conflict",
          "sandbox idempotency key belongs to a destroyed instance",
        );
      }
      if (
        !sameContext(replay.context, request.context) ||
        !sameFingerprint(replay.policyFingerprint, request.policyFingerprint)
      ) {
        throw new ProductionSandboxLifecycleError(
          "idempotency_conflict",
          "sandbox idempotency key was reused with different request facts",
        );
      }
      const managed = this.#instances.get(replay.instanceId);
      if (managed === undefined) {
        throw new ProductionSandboxLifecycleError(
          "idempotency_conflict",
          "sandbox idempotency key has no live instance record",
        );
      }
      return instanceWithState(managed);
    }

    const candidate = await this.#lifecycle.create(request);
    return this.#acceptCreatedInstance(candidate, request, policy);
  }

  execute(request: ExecuteSandboxRequest): Promise<SandboxExecutionResult> {
    return this.#serialize(this.#instanceOperations, request.instanceId, () =>
      this.#executeSerialized(request),
    );
  }

  async #executeSerialized(request: ExecuteSandboxRequest): Promise<SandboxExecutionResult> {
    const managed = this.#managedInstance(request.instanceId);
    if (managed.state === "stopped") {
      throw new ProductionSandboxLifecycleError(
        "instance_stopped",
        "cannot execute a stopped sandbox instance",
      );
    }
    assertExpectedFingerprint(managed.policyFingerprint, request.expectedPolicyFingerprint);
    validateExecuteRequest(request, managed.policy);
    const candidate: unknown = await this.#lifecycle.execute(request);
    const result = validateExecutionResult(candidate, request.maxOutputBytes);
    const running: ManagedInstance = Object.freeze({
      ...managed,
      instance: Object.freeze({ ...managed.instance, state: "running" }),
      state: "running",
    });
    this.#instances.set(request.instanceId, running);
    return result;
  }

  stop(instanceId: string, expectedPolicyFingerprint: SandboxPolicyFingerprint): Promise<void> {
    return this.#serialize(this.#instanceOperations, instanceId, () =>
      this.#stopSerialized(instanceId, expectedPolicyFingerprint),
    );
  }

  async #stopSerialized(
    instanceId: string,
    expectedPolicyFingerprint: SandboxPolicyFingerprint,
  ): Promise<void> {
    const managed = this.#instances.get(instanceId);
    if (managed === undefined) {
      const destroyed = this.#destroyedRecord(instanceId);
      if (destroyed !== undefined) {
        assertExpectedFingerprint(destroyed.policyFingerprint, expectedPolicyFingerprint);
        return;
      }
      this.#managedInstance(instanceId);
      throw new ProductionSandboxLifecycleError(
        "instance_not_found",
        "sandbox instance is unknown",
      );
    }
    assertExpectedFingerprint(managed.policyFingerprint, expectedPolicyFingerprint);
    if (managed.state === "stopped") return;
    await this.#lifecycle.stop(instanceId, expectedPolicyFingerprint);
    const stopped: ManagedInstance = Object.freeze({
      ...managed,
      instance: Object.freeze({ ...managed.instance, state: "stopped" }),
      state: "stopped",
    });
    this.#instances.set(instanceId, stopped);
  }

  destroy(instanceId: string, expectedPolicyFingerprint: SandboxPolicyFingerprint): Promise<void> {
    return this.#serialize(this.#instanceOperations, instanceId, () =>
      this.#destroySerialized(instanceId, expectedPolicyFingerprint),
    );
  }

  async #destroySerialized(
    instanceId: string,
    expectedPolicyFingerprint: SandboxPolicyFingerprint,
  ): Promise<void> {
    const managed = this.#instances.get(instanceId);
    if (managed === undefined) {
      const destroyed = this.#destroyedRecord(instanceId);
      if (destroyed !== undefined) {
        assertExpectedFingerprint(destroyed.policyFingerprint, expectedPolicyFingerprint);
        return;
      }
      this.#managedInstance(instanceId);
      throw new ProductionSandboxLifecycleError(
        "instance_not_found",
        "sandbox instance is unknown",
      );
    }
    assertExpectedFingerprint(managed.policyFingerprint, expectedPolicyFingerprint);
    await this.#lifecycle.destroy(instanceId, expectedPolicyFingerprint);
    this.#instances.delete(instanceId);
    this.#destroyed.add(instanceId);
    this.#idempotency.set(
      managed.idempotencyKey,
      Object.freeze({
        instanceId,
        context: managed.context,
        policyFingerprint: managed.policyFingerprint,
        destroyed: true,
      }),
    );
  }

  async #acceptCreatedInstance(
    candidate: unknown,
    request: CreateSandboxRequest,
    policy: SandboxPolicy,
  ): Promise<SandboxInstance> {
    const candidateRecord = asRecord(candidate);
    const candidateId = candidateRecord?.["instanceId"];
    try {
      if (
        candidateRecord === undefined ||
        !isNonEmptyText(candidateId) ||
        candidateRecord["backendKind"] !== this.backendKind ||
        candidateRecord["state"] !== "created" ||
        !sameContext(candidateRecord["context"], request.context) ||
        !sameFingerprint(candidateRecord["policyFingerprint"], request.policyFingerprint) ||
        this.#instances.has(candidateId) ||
        this.#destroyed.has(candidateId)
      ) {
        throw new ProductionSandboxLifecycleError(
          "instance_identity_mismatch",
          "sandbox backend returned an instance inconsistent with the validated create request",
        );
      }
      const instance = candidate as SandboxInstance;
      const managed: ManagedInstance = Object.freeze({
        instance,
        policyFingerprint: request.policyFingerprint,
        context: request.context,
        idempotencyKey: request.idempotencyKey,
        policy,
        state: "created",
      });
      this.#instances.set(candidateId, managed);
      this.#idempotency.set(
        request.idempotencyKey,
        Object.freeze({
          instanceId: candidateId,
          context: request.context,
          policyFingerprint: request.policyFingerprint,
          destroyed: false,
        }),
      );
      return instance;
    } catch (error: unknown) {
      if (
        !isNonEmptyText(candidateId) ||
        this.#instances.has(candidateId) ||
        this.#destroyed.has(candidateId)
      ) {
        throw error;
      }
      try {
        await this.#lifecycle.destroy(candidateId, request.policyFingerprint);
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "sandbox creation returned a malformed instance and cleanup failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  #destroyedRecord(instanceId: string): IdempotencyRecord | undefined {
    for (const record of this.#idempotency.values()) {
      if (record.instanceId === instanceId && record.destroyed) return record;
    }
    return undefined;
  }

  #managedInstance(instanceId: string): ManagedInstance {
    if (!isNonEmptyText(instanceId)) {
      throw new ProductionSandboxLifecycleError(
        "invalid_request",
        "sandbox instance ID must be non-empty text",
      );
    }
    const managed = this.#instances.get(instanceId);
    if (managed !== undefined) return managed;
    if (this.#destroyed.has(instanceId)) {
      throw new ProductionSandboxLifecycleError(
        "instance_destroyed",
        "sandbox instance has already been destroyed",
      );
    }
    throw new ProductionSandboxLifecycleError("instance_not_found", "sandbox instance is unknown");
  }
  async #serialize<Result>(
    tails: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }
}

async function probeBackend(
  lifecycle: SandboxLifecycle,
): Promise<Extract<SandboxCapabilityProbe, { available: true }>> {
  let probe: SandboxCapabilityProbe;
  try {
    probe = await lifecycle.probe();
  } catch (error: unknown) {
    throw new ProductionSandboxLifecycleError(
      "probe_failed",
      "sandbox backend capability probe failed",
      { cause: error },
    );
  }
  if (!probe.available) {
    throw new ProductionSandboxLifecycleError(
      "backend_unavailable",
      `sandbox backend is unavailable: ${probe.message}`,
    );
  }
  return probe;
}

function validateProbe(
  probe: Extract<SandboxCapabilityProbe, { available: true }>,
  expectedBackendKind: ProductionSandboxBackendKind,
  templateFingerprint: ContentHash,
): void {
  if (!isProductionBackendKind(probe.backendKind) || probe.backendKind !== expectedBackendKind) {
    throw new ProductionSandboxLifecycleError(
      "backend_kind_mismatch",
      "sandbox capability probe backend kind does not match the requested backend kind",
    );
  }
  if (probe.templateFingerprint !== templateFingerprint) {
    throw new ProductionSandboxLifecycleError(
      "template_fingerprint_mismatch",
      "sandbox capability probe template fingerprint does not match the requested template",
    );
  }
  if (!isNonEmptyText(probe.backendVersion) || !digestPattern.test(probe.templateFingerprint)) {
    throw new ProductionSandboxLifecycleError(
      "invalid_probe",
      "sandbox capability probe is malformed",
    );
  }
  for (const [capability, label] of requiredCapabilities) {
    const capabilityValue: unknown = probe.capabilities[capability];
    if (capabilityValue !== true) {
      throw new ProductionSandboxLifecycleError(
        "capability_missing",
        `sandbox backend is missing the ${label} capability`,
      );
    }
  }
  if (
    !Array.isArray(probe.capabilities.supportedNetworkProfiles) ||
    probe.capabilities.supportedNetworkProfiles.some(
      (profile) => typeof profile !== "string" || !networkProfileSet.has(profile),
    )
  ) {
    throw new ProductionSandboxLifecycleError(
      "invalid_probe",
      "sandbox capability probe contains an unknown network profile",
    );
  }
}

function validateCreateRequest(request: CreateSandboxRequest): void {
  if (!isNonEmptyText(request.idempotencyKey) || !isValidContext(request.context)) {
    throw new ProductionSandboxLifecycleError(
      "invalid_request",
      "sandbox create idempotency key and context must be valid",
    );
  }
}

function validateExecuteRequest(request: ExecuteSandboxRequest, policy: SandboxPolicy): void {
  const arguments_: readonly string[] = request.arguments;
  if (!isNonEmptyText(request.executable) || !isNonEmptyText(request.workingDirectory)) {
    throw new ProductionSandboxLifecycleError(
      "invalid_request",
      "sandbox executable and working directory must be non-empty text",
    );
  }
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0
  ) {
    throw new ProductionSandboxLifecycleError(
      "invalid_request",
      "sandbox timeout and output limit must be positive safe integers",
    );
  }
  if (
    !Array.isArray(arguments_) ||
    arguments_.some((argument) => typeof argument !== "string") ||
    !isStringRecord(request.environment)
  ) {
    throw new ProductionSandboxLifecycleError(
      "invalid_request",
      "sandbox arguments must be strings and environment values must be strings",
    );
  }
  const executable = posix.basename(request.executable);
  const executableAllowed =
    policy.tools.allowedExecutables.includes(request.executable) ||
    (request.executable === executable && policy.tools.allowedExecutables.includes(executable));
  if (!executableAllowed) {
    throw new ProductionSandboxLifecycleError(
      "policy_violation",
      "sandbox executable is not allowed by the created policy",
    );
  }
  if (
    request.timeoutMs > policy.resources.executionTimeoutMs ||
    request.maxOutputBytes > policy.resources.maxOutputBytes
  ) {
    throw new ProductionSandboxLifecycleError(
      "policy_violation",
      "sandbox execution limits exceed the created policy",
    );
  }
  if (
    !posix.isAbsolute(request.workingDirectory) ||
    posix.normalize(request.workingDirectory) !== request.workingDirectory ||
    !policy.mounts.some((mount) => pathIsWithin(request.workingDirectory, mount.targetPath))
  ) {
    throw new ProductionSandboxLifecycleError(
      "policy_violation",
      "sandbox working directory is outside the created mount policy",
    );
  }
  if (executable === "git") {
    const subcommand = parseGitSubcommand(arguments_);
    const blocked =
      subcommand !== undefined &&
      policy.tools.blockedGitSubcommands.includes(subcommand.toLowerCase());
    const allowed =
      subcommand !== undefined &&
      policy.tools.allowedGitSubcommands.includes(subcommand.toLowerCase());
    if (blocked || !allowed) {
      throw new ProductionSandboxLifecycleError(
        "policy_violation",
        "Git subcommand is not allowed by the created tool policy",
      );
    }
  }
}

/**
 * Returns the git subcommand token, or `undefined` if none is found OR a
 * config/global option that can redefine command behavior is present.
 *
 * P1 (review #15): this previously SKIPPED `-c`/`--config-env`/`--git-dir`/
 * `--work-tree`/`--namespace`/`--super-prefix` (and every other `-`-prefixed
 * token) to find the first non-option token, then validated ONLY that
 * token against the allow/block lists. `git -c alias.status='!sh -c id'
 * status` was accepted by a policy allowing `status`: the `-c` VALUE
 * redefines what `status` means (an alias executing an arbitrary host
 * command) while `parseGitSubcommand` still reported the harmless-looking
 * literal `status`. `--work-tree=/outside status` similarly escapes
 * confinement while parsing as an allowed `status`. Fail closed instead:
 * `-c`/`--config-env`/`--git-dir`/`--work-tree`/`--namespace`/
 * `--super-prefix` make the whole request unrecognized (undefined), which
 * the caller's `!allowed` check already rejects - these options are never
 * needed by a sandboxed git invocation the tool policy is meant to confine.
 */
function parseGitSubcommand(arguments_: readonly string[]): string | undefined {
  for (const argument of arguments_) {
    if (
      argument === "-c" ||
      argument === "-C" ||
      argument === "--git-dir" ||
      argument === "--work-tree" ||
      argument === "--namespace" ||
      argument === "--super-prefix" ||
      argument === "--config-env" ||
      argument.startsWith("-c=") ||
      argument.startsWith("-C=") ||
      argument.startsWith("--git-dir=") ||
      argument.startsWith("--work-tree=") ||
      argument.startsWith("--namespace=") ||
      argument.startsWith("--super-prefix=") ||
      argument.startsWith("--config-env=")
    ) {
      // -C redirects git's effective repo root the same way --work-tree
      // does, away from the validated workingDirectory - no legitimate
      // sandboxed invocation needs it (the harness already sets the
      // process cwd correctly), so it is rejected here too rather than
      // skipped.
      return undefined;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    return argument;
  }
  return undefined;
}

function pathIsWithin(path: string, root: string): boolean {
  const relative = posix.relative(root, path);
  return relative === "" || (relative !== ".." && !relative.startsWith("../"));
}

function validateExecutionResult(
  candidate: unknown,
  maxOutputBytes: number,
): SandboxExecutionResult {
  const record = asRecord(candidate);
  if (
    record === undefined ||
    typeof record["exitCode"] !== "number" ||
    !Number.isSafeInteger(record["exitCode"]) ||
    !(record["stdout"] instanceof Uint8Array) ||
    !(record["stderr"] instanceof Uint8Array)
  ) {
    throw new ProductionSandboxLifecycleError(
      "backend_result_invalid",
      "sandbox backend returned an invalid execution result",
    );
  }
  const stdout = record["stdout"];
  const stderr = record["stderr"];
  const combinedOutputBytes = stdout.byteLength + stderr.byteLength;
  if (!Number.isSafeInteger(combinedOutputBytes) || combinedOutputBytes > maxOutputBytes) {
    throw new ProductionSandboxLifecycleError(
      "output_limit",
      "sandbox backend execution output exceeds the requested limit",
    );
  }
  return record as unknown as SandboxExecutionResult;
}

function assertMatchingPolicyFingerprint(
  fingerprinter: SandboxPolicyFingerprinter,
  policy: SandboxPolicy,
  expected: SandboxPolicyFingerprint,
): void {
  const actual = fingerprinter.fingerprint(policy);
  assertExpectedFingerprint(actual, expected);
}

function assertExpectedFingerprint(
  actual: SandboxPolicyFingerprint,
  expected: SandboxPolicyFingerprint,
): void {
  if (!sameFingerprint(actual, expected)) {
    throw new ProductionSandboxLifecycleError(
      "policy_fingerprint_mismatch",
      "sandbox policy fingerprint does not match the expected digest",
    );
  }
}

function sameFingerprint(left: unknown, right: unknown): boolean {
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord === undefined || rightRecord === undefined) return false;
  return (
    leftRecord["policyVersion"] === 1 &&
    rightRecord["policyVersion"] === 1 &&
    typeof leftRecord["digest"] === "string" &&
    digestPattern.test(leftRecord["digest"]) &&
    typeof rightRecord["digest"] === "string" &&
    digestPattern.test(rightRecord["digest"]) &&
    leftRecord["digest"] === rightRecord["digest"]
  );
}

function isValidContext(value: unknown): value is SandboxAttemptContext {
  const record = asRecord(value);
  if (record === undefined) return false;
  const keys = Object.keys(record).sort();
  return (
    keys.length === contextKeys.length &&
    contextKeys.every((key) => keys.includes(key) && isNonEmptyText(record[key]))
  );
}

function sameContext(left: unknown, right: unknown): boolean {
  if (!isValidContext(left) || !isValidContext(right)) return false;
  return contextKeys.every((key) => left[key] === right[key]);
}

function validateBackendKind(
  value: unknown,
  field: string,
): asserts value is ProductionSandboxBackendKind {
  if (typeof value !== "string" || !productionBackendSet.has(value)) {
    throw new ProductionSandboxLifecycleError(
      "invalid_backend_kind",
      `${field} is unknown or unsupported`,
    );
  }
}

function isProductionBackendKind(value: unknown): value is ProductionSandboxBackendKind {
  return typeof value === "string" && productionBackendSet.has(value);
}

function validateContentHash(value: unknown, field: string): ContentHash {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new ProductionSandboxLifecycleError(
      "invalid_probe",
      `${field} must be a SHA-256 content hash`,
    );
  }
  return contentHash(value);
}

function isSupportedNetworkProfile(
  profile: SandboxNetworkProfile,
  supported: readonly SandboxNetworkProfile[],
): boolean {
  return supported.includes(profile);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every((entry) => typeof entry === "string");
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function instanceWithState(managed: ManagedInstance): SandboxInstance {
  if (managed.instance.state === managed.state) return managed.instance;
  return Object.freeze({ ...managed.instance, state: managed.state });
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
