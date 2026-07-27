import { realpath } from "node:fs/promises";
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
  contentHash,
  SandboxDeniedError,
  type CreateSandboxRequest,
  type ExecuteSandboxRequest,
  type SandboxDenialCode,
  type SandboxCapabilityProbe,
  type SandboxExecutionResult,
  type SandboxInstance,
  type SandboxLifecycle,
  type SandboxMount,
  type SandboxNetworkProfile,
  type SandboxPolicy,
  type SandboxPolicyFingerprint,
  type SandboxPolicyFingerprinter,
  type SandboxResourceProfile,
} from "@minions/core";

export type SensitivePathDenialCode =
  "symlink_escape" | "sibling_workspace" | "home_credentials" | "control_socket" | "device";

export type SandboxSensitivePath = Readonly<{
  path: string;
  code: SensitivePathDenialCode;
}>;

export interface TestSandboxLifecycleOptions {
  readonly fingerprinter: SandboxPolicyFingerprinter;
  readonly probe?: SandboxCapabilityProbe;
  readonly sensitivePaths?: readonly SandboxSensitivePath[];
}

interface StoredSandbox {
  readonly instanceId: string;
  readonly context: SandboxInstance["context"];
  readonly policy: SandboxPolicy;
  readonly policyFingerprint: SandboxPolicyFingerprint;
  state: SandboxInstance["state"];
}

const defaultProbe: SandboxCapabilityProbe = Object.freeze({
  available: true,
  backendKind: "test",
  backendVersion: "testkit-deterministic-1",
  templateFingerprint: contentHash("b".repeat(64)),
  capabilities: Object.freeze({
    readOnlyMounts: true,
    processIsolation: true,
    privateNetworkBlocking: true,
    toolFiltering: true,
    nestedContainers: true,
    supportedNetworkProfiles: [
      "explore",
      "research",
      "implementation",
      "gate",
      "maintenance",
    ] as readonly SandboxNetworkProfile[],
  }),
});

const gitDenialCodes: Readonly<Record<string, SandboxDenialCode>> = Object.freeze({
  commit: "git_commit_blocked",
  branch: "git_branch_blocked",
  remote: "git_remote_blocked",
  push: "git_push_blocked",
  fetch: "git_fetch_blocked",
  worktree: "git_worktree_blocked",
});

const writeExecutables = new Set([
  "chmod",
  "cp",
  "dd",
  "mkdir",
  "mkfile",
  "mv",
  "rm",
  "rmdir",
  "tee",
  "touch",
  "truncate",
]);

const processEscapeTokens = [
  "child_process",
  "exec(",
  "execfile(",
  "fork(",
  "spawn(",
  "subprocess",
  "/proc/",
  "--fork",
  "--spawn",
];

export class TestSandboxLifecycle implements SandboxLifecycle {
  readonly backendKind = "test" as const;

  private readonly fingerprinter: SandboxPolicyFingerprinter;
  private readonly probeResult: SandboxCapabilityProbe;
  private readonly sensitivePaths: readonly SandboxSensitivePath[];
  private readonly instances = new Map<string, StoredSandbox>();
  private readonly idempotency = new Map<string, string>();
  private readonly destroyed = new Map<string, SandboxPolicyFingerprint>();
  private nextInstance = 1;

  constructor(options: TestSandboxLifecycleOptions) {
    this.fingerprinter = options.fingerprinter;
    this.probeResult = options.probe ?? defaultProbe;
    this.sensitivePaths = Object.freeze([...(options.sensitivePaths ?? [])]);
    if (this.probeResult.backendKind !== "test") {
      throw new TypeError("test sandbox lifecycle requires a test capability probe");
    }
  }

  probe(): Promise<SandboxCapabilityProbe> {
    return Promise.resolve(this.probeResult);
  }

  async create(request: CreateSandboxRequest): Promise<SandboxInstance> {
    await this.ensureBackendUsable(request.policy.network.profile);
    this.validatePolicy(request.policy);
    const computedFingerprint = this.fingerprinter.fingerprint(request.policy);
    this.requireFingerprint(request.policyFingerprint, computedFingerprint, "create");

    const previousId = this.idempotency.get(request.idempotencyKey);
    if (previousId !== undefined) {
      const previous = this.instances.get(previousId);
      if (previous === undefined) {
        throw new SandboxDeniedError(
          "idempotency_conflict",
          "create",
          "idempotency key points to a destroyed sandbox",
        );
      }
      if (
        !sameContext(previous.context, request.context) ||
        !sameFingerprint(previous.policyFingerprint, computedFingerprint)
      ) {
        throw new SandboxDeniedError(
          "idempotency_conflict",
          "create",
          "idempotency key was reused with different request facts",
        );
      }
      return this.toInstance(previous);
    }

    const stored: StoredSandbox = {
      instanceId: `test-sandbox-${String(this.nextInstance)}`,
      context: Object.freeze({ ...request.context }),
      policy: freezePolicy(request.policy),
      policyFingerprint: Object.freeze({ ...computedFingerprint }),
      state: "created",
    };
    this.nextInstance += 1;
    this.instances.set(stored.instanceId, stored);
    this.idempotency.set(request.idempotencyKey, stored.instanceId);
    return this.toInstance(stored);
  }

  async execute(request: ExecuteSandboxRequest): Promise<SandboxExecutionResult> {
    const sandbox = this.instances.get(request.instanceId);
    if (sandbox === undefined) {
      throw new SandboxDeniedError(
        "instance_not_found",
        "execute",
        "sandbox instance does not exist",
      );
    }
    this.requireFingerprint(
      request.expectedPolicyFingerprint,
      sandbox.policyFingerprint,
      "execute",
    );
    await this.ensureBackendUsable(sandbox.policy.network.profile);
    if (sandbox.state === "stopped") {
      throw new SandboxDeniedError("invalid_state", "execute", "sandbox instance is stopped");
    }
    await this.validateExecution(sandbox.policy, request);
    sandbox.state = "running";
    return Object.freeze({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
  }

  stop(instanceId: string, expectedPolicyFingerprint: SandboxPolicyFingerprint): Promise<void> {
    const sandbox = this.instances.get(instanceId);
    const destroyedFingerprint = this.destroyed.get(instanceId);
    if (sandbox === undefined) {
      if (destroyedFingerprint !== undefined) {
        this.requireFingerprint(expectedPolicyFingerprint, destroyedFingerprint, "stop");
        return Promise.resolve();
      }
      throw new SandboxDeniedError("instance_not_found", "stop", "sandbox instance does not exist");
    }
    this.requireFingerprint(expectedPolicyFingerprint, sandbox.policyFingerprint, "stop");
    if (sandbox.state === "created" || sandbox.state === "running") {
      sandbox.state = "stopped";
    }
    return Promise.resolve();
  }

  destroy(instanceId: string, expectedPolicyFingerprint: SandboxPolicyFingerprint): Promise<void> {
    const sandbox = this.instances.get(instanceId);
    const destroyedFingerprint = this.destroyed.get(instanceId);
    if (sandbox === undefined) {
      if (destroyedFingerprint !== undefined) {
        this.requireFingerprint(expectedPolicyFingerprint, destroyedFingerprint, "destroy");
        return Promise.resolve();
      }
      throw new SandboxDeniedError(
        "instance_not_found",
        "destroy",
        "sandbox instance does not exist",
      );
    }
    this.requireFingerprint(expectedPolicyFingerprint, sandbox.policyFingerprint, "destroy");
    this.instances.delete(instanceId);
    this.destroyed.set(instanceId, sandbox.policyFingerprint);
    return Promise.resolve();
  }

  private async ensureBackendUsable(profile: SandboxNetworkProfile): Promise<void> {
    const probe = await this.probe();
    if (!probe.available) {
      throw new SandboxDeniedError("backend_unavailable", "probe", probe.message, {
        failureCode: probe.failureCode,
      });
    }
    const capabilities = probe.capabilities;
    if (
      !capabilities.readOnlyMounts ||
      !capabilities.processIsolation ||
      !capabilities.privateNetworkBlocking ||
      !capabilities.toolFiltering ||
      !capabilities.nestedContainers ||
      !capabilities.supportedNetworkProfiles.includes(profile)
    ) {
      throw new SandboxDeniedError(
        "backend_unconfined",
        "probe",
        "test sandbox capability probe is missing a mandatory capability",
      );
    }
  }

  private validatePolicy(policy: SandboxPolicy): void {
    if (policy.mounts.length === 0) {
      throw new SandboxDeniedError("invalid_policy", "create", "sandbox policy has no mounts");
    }
    this.validateResources(policy.resources);
    if (policy.tools.allowedExecutables.length === 0) {
      throw new SandboxDeniedError(
        "invalid_policy",
        "create",
        "sandbox policy allows no executables",
      );
    }
    if (
      policy.tools.allowedExecutables.includes("git") &&
      !policy.tools.allowedGitSubcommands.length
    ) {
      throw new SandboxDeniedError(
        "invalid_policy",
        "create",
        "Git requires an explicit non-empty subcommand allowlist",
      );
    }
    if (!policy.tools.blockedGitSubcommands.length) {
      throw new SandboxDeniedError(
        "invalid_policy",
        "create",
        "sandbox policy has no Git tool restrictions",
      );
    }
    const workspaceMount = policy.mounts.find((mount) => mount.kind === "workspace");
    if (workspaceMount === undefined) {
      throw new SandboxDeniedError(
        "invalid_policy",
        "create",
        "sandbox policy has no workspace mount",
      );
    }
    for (const mount of policy.mounts) {
      if (!isAbsolute(mount.sourcePath) || !isAbsolute(mount.targetPath)) {
        throw new SandboxDeniedError(
          "invalid_policy",
          "create",
          "sandbox mount paths must be absolute",
        );
      }
      // GIT-15: jj metadata (`.jj`) must never be mounted into any sandbox. The test
      // sandbox enforces the same exclusion as the production policy validator so the
      // masked jj working copy (PR 28) is isolated in the test environment too.
      if (mountContainsDotJj(mount.sourcePath) || mountContainsDotJj(mount.targetPath)) {
        throw new SandboxDeniedError(
          "invalid_policy",
          "create",
          "sandbox mount path traverses '.jj' metadata which is denied (GIT-15)",
        );
      }
    }
    if (policy.network.allowedHosts.some((host) => host.trim().length === 0)) {
      throw new SandboxDeniedError("invalid_policy", "create", "sandbox network policy is invalid");
    }
  }

  private validateResources(resources: SandboxResourceProfile): void {
    const values = [
      resources.cpuCount,
      resources.memoryMiB,
      resources.processLimit,
      resources.storageMiB,
      resources.executionTimeoutMs,
      resources.maxOutputBytes,
    ];
    if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new SandboxDeniedError(
        "invalid_policy",
        "create",
        "sandbox resource limits must be positive safe integers",
      );
    }
  }

  private async validateExecution(
    policy: SandboxPolicy,
    request: ExecuteSandboxRequest,
  ): Promise<void> {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new SandboxDeniedError(
        "timeout_limit",
        "execute",
        "execution timeout must be a positive safe integer",
      );
    }
    if (request.timeoutMs > policy.resources.executionTimeoutMs) {
      throw new SandboxDeniedError(
        "timeout_limit",
        "execute",
        "execution timeout exceeds the policy limit",
      );
    }
    if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
      throw new SandboxDeniedError(
        "output_limit",
        "execute",
        "output limit must be a positive safe integer",
      );
    }
    if (request.maxOutputBytes > policy.resources.maxOutputBytes) {
      throw new SandboxDeniedError(
        "output_limit",
        "execute",
        "output limit exceeds the policy limit",
      );
    }

    const executable = basename(request.executable);
    if (isAbsolute(request.executable) && !isWithinAnyMount(request.executable, policy.mounts)) {
      throw new SandboxDeniedError(
        "absolute_host_path",
        "execute",
        "absolute executable path is outside the sandbox mounts",
      );
    }
    if (
      !policy.tools.allowedExecutables.includes(request.executable) &&
      !policy.tools.allowedExecutables.includes(executable)
    ) {
      throw new SandboxDeniedError(
        "executable_not_allowed",
        "execute",
        "executable is not declared by the tool policy",
      );
    }

    const argumentText = request.arguments.join(" ").toLowerCase();
    const requestedProcessCount = /array\.from\(\{\s*length:\s*(\d+)/u.exec(argumentText)?.[1];
    if (
      requestedProcessCount !== undefined &&
      Number(requestedProcessCount) > policy.resources.processLimit
    ) {
      throw new SandboxDeniedError(
        "resource_limit",
        "execute",
        "requested process count exceeds the policy limit",
      );
    }
    const requestedOutputBytes = /\.repeat\((\d+)\)/u.exec(argumentText)?.[1];
    if (
      requestedOutputBytes !== undefined &&
      Number(requestedOutputBytes) > request.maxOutputBytes
    ) {
      throw new SandboxDeniedError(
        "output_limit",
        "execute",
        "requested output exceeds the policy limit",
      );
    }
    if (processEscapeTokens.some((token) => argumentText.includes(token))) {
      throw new SandboxDeniedError(
        "process_escape",
        "execute",
        "child process and host process escape are denied",
      );
    }
    const requestedDelayMs = /settimeout\(\(\)=>\{\},(\d+)\)/u.exec(argumentText)?.[1];
    if (requestedDelayMs !== undefined && Number(requestedDelayMs) > request.timeoutMs) {
      throw new SandboxDeniedError(
        "timeout_limit",
        "execute",
        "sandbox execution exceeded the requested timeout",
      );
    }

    this.validateGit(policy, executable, request.arguments);
    this.validateNetwork(policy, request.arguments);
    await this.validatePaths(policy, request);
  }

  private validateGit(
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
    const blocked = arguments_.find((argument) =>
      policy.tools.blockedGitSubcommands.includes(argument.toLowerCase()),
    );
    if (blocked !== undefined) {
      const denialCode = gitDenialCodes[blocked.toLowerCase()];
      if (denialCode !== undefined) {
        throw new SandboxDeniedError(denialCode, "execute", `Git ${blocked} is denied`);
      }
    }
    const subcommand = parseGitSubcommand(arguments_);
    if (
      subcommand === undefined ||
      !policy.tools.allowedGitSubcommands.includes(subcommand.toLowerCase())
    ) {
      throw new SandboxDeniedError(
        "executable_not_allowed",
        "execute",
        "Git subcommand is not declared by the tool policy",
      );
    }
  }

  private validateNetwork(policy: SandboxPolicy, arguments_: readonly string[]): void {
    for (const argument of arguments_) {
      if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(argument)) continue;
      let url: URL;
      try {
        url = new URL(argument);
      } catch {
        throw new SandboxDeniedError("network_host_denied", "execute", "network URL is invalid");
      }
      const host = url.hostname.toLowerCase();
      const metadata =
        host === "169.254.169.254" || host === "metadata.google.internal" || host === "metadata";
      if (metadata) {
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
      const allowedHosts = policy.network.allowedHosts.map((allowedHost) =>
        allowedHost.toLowerCase(),
      );
      if (
        !allowedHosts.includes(host) &&
        !(policy.network.allowProviderGateway && host === "host.docker.internal")
      ) {
        throw new SandboxDeniedError(
          "network_host_denied",
          "execute",
          "network host is not declared by the policy",
        );
      }
    }
  }

  private async validatePaths(
    policy: SandboxPolicy,
    request: ExecuteSandboxRequest,
  ): Promise<void> {
    const paths = [request.workingDirectory, ...request.arguments.filter(isPathCandidate)];
    for (const rawPath of paths) {
      if (rawPath.startsWith("~")) {
        throw new SandboxDeniedError(
          "home_credentials",
          "execute",
          "home and credential paths are denied",
        );
      }
      if (hasParentTraversal(rawPath)) {
        throw new SandboxDeniedError("path_traversal", "execute", "parent traversal is denied");
      }
      const sensitive = this.sensitivePathFor(rawPath);
      if (sensitive !== undefined) {
        throw new SandboxDeniedError(sensitive.code, "execute", "sensitive host path is denied");
      }
      if (rawPath.startsWith("/dev/")) {
        throw new SandboxDeniedError("device", "execute", "device paths are denied");
      }
      if (rawPath.endsWith(".sock") || rawPath.includes("/socket/")) {
        throw new SandboxDeniedError(
          "control_socket",
          "execute",
          "daemon and control sockets are denied",
        );
      }
      if (!isAbsolute(rawPath)) continue;
      const mount = findMount(rawPath, policy.mounts);
      if (mount === undefined) {
        throw new SandboxDeniedError(
          "absolute_host_path",
          "execute",
          "absolute host paths are denied",
        );
      }
      const real = await resolvedPath(rawPath);
      if (real !== undefined && !isWithinAnyMount(real, policy.mounts)) {
        throw new SandboxDeniedError(
          "symlink_escape",
          "execute",
          "symlink paths escaping the sandbox are denied",
        );
      }
      if (mount.access === "read_only" && isWriteRequest(request.executable)) {
        throw new SandboxDeniedError(
          "read_only_mount",
          "execute",
          "writes to the read-only workspace are denied",
        );
      }
    }
  }

  private sensitivePathFor(rawPath: string): SandboxSensitivePath | undefined {
    const requested = resolve(rawPath);
    const configured = this.sensitivePaths.find((sensitive) =>
      isSameOrWithin(requested, resolve(sensitive.path)),
    );
    if (configured !== undefined) return configured;
    const normalized = normalize(rawPath);
    if (
      normalized.includes(`${sep}sibling-workspace${sep}`) ||
      normalized.endsWith(`${sep}sibling-workspace`)
    ) {
      return { path: rawPath, code: "sibling_workspace" };
    }
    if (normalized.includes(`${sep}home${sep}`) || normalized.endsWith(`${sep}home`)) {
      return { path: rawPath, code: "home_credentials" };
    }
    if (normalized.includes(`${sep}devices${sep}`) || normalized.includes(`${sep}device${sep}`)) {
      return { path: rawPath, code: "device" };
    }
    if (normalized.includes(`${sep}sockets${sep}`) || normalized.endsWith(".sock")) {
      return { path: rawPath, code: "control_socket" };
    }
    return undefined;
  }

  private requireFingerprint(
    expected: SandboxPolicyFingerprint,
    actual: SandboxPolicyFingerprint,
    operation: string,
  ): void {
    if (!sameFingerprint(expected, actual)) {
      throw new SandboxDeniedError(
        "policy_fingerprint_mismatch",
        operation,
        "sandbox policy fingerprint does not match the created policy",
      );
    }
  }

  private toInstance(sandbox: StoredSandbox): SandboxInstance {
    return Object.freeze({
      instanceId: sandbox.instanceId,
      context: sandbox.context,
      backendKind: this.backendKind,
      policyFingerprint: sandbox.policyFingerprint,
      state: sandbox.state,
    });
  }
}

export function createTestSandboxLifecycle(
  options: TestSandboxLifecycleOptions,
): TestSandboxLifecycle {
  return new TestSandboxLifecycle(options);
}

function freezePolicy(policy: SandboxPolicy): SandboxPolicy {
  return Object.freeze({
    ...policy,
    mounts: Object.freeze(policy.mounts.map((mount) => Object.freeze({ ...mount }))),
    network: Object.freeze({
      ...policy.network,
      allowedHosts: Object.freeze([...policy.network.allowedHosts]),
    }),
    tools: Object.freeze({
      ...policy.tools,
      allowedExecutables: Object.freeze([...policy.tools.allowedExecutables]),
      allowedGitSubcommands: Object.freeze([...policy.tools.allowedGitSubcommands]),
      blockedGitSubcommands: Object.freeze([...policy.tools.blockedGitSubcommands]),
    }),
    resources: Object.freeze({ ...policy.resources }),
  });
}

function sameContext(left: SandboxInstance["context"], right: SandboxInstance["context"]): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.nodeId === right.nodeId &&
    left.repositoryId === right.repositoryId &&
    left.hostId === right.hostId
  );
}

function sameFingerprint(left: SandboxPolicyFingerprint, right: SandboxPolicyFingerprint): boolean {
  return Object.is(left.policyVersion, right.policyVersion) && left.digest === right.digest;
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

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]/u).some((part) => part === "..");
}

function mountContainsDotJj(path: string): boolean {
  return path.split(/[\\/]/u).some((part) => part === ".jj");
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

function isWithinAnyMount(path: string, mounts: readonly SandboxMount[]): boolean {
  return mounts.some((mount) => isSameOrWithin(resolve(path), resolve(mount.sourcePath)));
}

function findMount(path: string, mounts: readonly SandboxMount[]): SandboxMount | undefined {
  const resolved = resolve(path);
  return mounts
    .filter((mount) => isSameOrWithin(resolved, resolve(mount.sourcePath)))
    .sort((left, right) => resolve(right.sourcePath).length - resolve(left.sourcePath).length)[0];
}

function isSameOrWithin(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return (
    remainder === "" ||
    (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
  );
}

async function resolvedPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isWriteRequest(executable: string): boolean {
  return writeExecutables.has(basename(executable));
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    ipv4InRange(host, [127, 0, 0, 0], 8)
  );
}

function isLinkLocalHost(host: string): boolean {
  return (
    ipv4InRange(host, [169, 254, 0, 0], 16) ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  );
}

function isPrivateHost(host: string): boolean {
  return (
    ipv4InRange(host, [10, 0, 0, 0], 8) ||
    ipv4InRange(host, [172, 16, 0, 0], 12) ||
    ipv4InRange(host, [192, 168, 0, 0], 16)
  );
}

function ipv4InRange(
  host: string,
  base: readonly [number, number, number, number],
  prefix: number,
): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [part0, part1, part2, part3] = parts;
  if (part0 === undefined || part1 === undefined || part2 === undefined || part3 === undefined)
    return false;
  const value = part0 * 0x1000000 + part1 * 0x10000 + part2 * 0x100 + part3;
  const baseValue = base[0] * 0x1000000 + base[1] * 0x10000 + base[2] * 0x100 + base[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value >>> 0) & mask) === ((baseValue >>> 0) & mask);
}
