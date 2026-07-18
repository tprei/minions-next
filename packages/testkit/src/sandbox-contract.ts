import type {
  CreateSandboxRequest,
  ExecuteSandboxRequest,
  SandboxExecutionResult,
  SandboxInstance,
  SandboxLifecycle,
  SandboxPolicy,
  SandboxPolicyFingerprint,
  SandboxPolicyFingerprinter,
} from "@minions/core";
import { SandboxDeniedError, type SandboxDenialCode } from "./sandbox.js";
import type { SandboxContractFixture } from "./sandbox-contract-fixture.js";

export type SandboxContractScenarioId =
  | "absolute-host-path"
  | "parent-traversal"
  | "symlink-escape"
  | "sibling-workspace"
  | "home-credentials"
  | "daemon-socket"
  | "control-socket"
  | "device-path"
  | "child-process-escape"
  | "git-commit"
  | "git-branch"
  | "git-remote"
  | "git-push"
  | "git-fetch"
  | "git-worktree"
  | "git-credential"
  | "network-private"
  | "network-loopback"
  | "network-link-local"
  | "network-metadata"
  | "read-only-workspace-write"
  | "undeclared-executable"
  | "output-limit"
  | "timeout-limit"
  | "resource-limit"
  | "policy-mutation";

export type SandboxContractScenario = Readonly<{
  id: SandboxContractScenarioId;
  expectedCode: SandboxDenialCode;
  description: string;
}>;

export const sandboxContractScenarios: readonly SandboxContractScenario[] = Object.freeze([
  {
    id: "absolute-host-path",
    expectedCode: "absolute_host_path",
    description: "absolute host path",
  },
  { id: "parent-traversal", expectedCode: "path_traversal", description: "parent traversal" },
  { id: "symlink-escape", expectedCode: "symlink_escape", description: "symlink escape" },
  { id: "sibling-workspace", expectedCode: "sibling_workspace", description: "sibling workspace" },
  { id: "home-credentials", expectedCode: "home_credentials", description: "home credentials" },
  { id: "daemon-socket", expectedCode: "control_socket", description: "daemon socket" },
  { id: "control-socket", expectedCode: "control_socket", description: "control socket" },
  { id: "device-path", expectedCode: "device", description: "device path" },
  {
    id: "child-process-escape",
    expectedCode: "process_escape",
    description: "child process escape",
  },
  { id: "git-commit", expectedCode: "git_commit_blocked", description: "Git commit" },
  { id: "git-branch", expectedCode: "git_branch_blocked", description: "Git branch" },
  { id: "git-remote", expectedCode: "git_remote_blocked", description: "Git remote" },
  { id: "git-push", expectedCode: "git_push_blocked", description: "Git push" },
  { id: "git-fetch", expectedCode: "git_fetch_blocked", description: "Git fetch" },
  { id: "git-worktree", expectedCode: "git_worktree_blocked", description: "Git worktree" },
  { id: "git-credential", expectedCode: "git_credential_blocked", description: "Git credential" },
  { id: "network-private", expectedCode: "network_private", description: "private network" },
  { id: "network-loopback", expectedCode: "network_loopback", description: "loopback network" },
  {
    id: "network-link-local",
    expectedCode: "network_link_local",
    description: "link-local network",
  },
  { id: "network-metadata", expectedCode: "network_metadata", description: "metadata network" },
  {
    id: "read-only-workspace-write",
    expectedCode: "read_only_mount",
    description: "read-only workspace write",
  },
  {
    id: "undeclared-executable",
    expectedCode: "executable_not_allowed",
    description: "undeclared executable",
  },
  { id: "output-limit", expectedCode: "output_limit", description: "output limit" },
  { id: "timeout-limit", expectedCode: "timeout_limit", description: "timeout limit" },
  { id: "resource-limit", expectedCode: "resource_limit", description: "resource limit" },
  {
    id: "policy-mutation",
    expectedCode: "policy_fingerprint_mismatch",
    description: "policy mutation",
  },
]);

export type SandboxContractScenarioResult = Readonly<{
  id: SandboxContractScenarioId;
  expectedCode: SandboxDenialCode;
  observedCode: SandboxDenialCode | undefined;
  passed: boolean;
  detail: string;
}>;

export type SandboxContractReport = Readonly<{
  scenarioCount: number;
  passed: boolean;
  results: readonly SandboxContractScenarioResult[];
  baselineInstanceId: string;
  sentinelsUnchanged: boolean;
  sentinelsBefore: Readonly<Record<string, string>>;
  sentinelsAfter: Readonly<Record<string, string>>;
}>;

export async function executeSandboxContract(
  lifecycle: SandboxLifecycle,
  fixture: SandboxContractFixture,
  fingerprinter: SandboxPolicyFingerprinter,
): Promise<SandboxContractReport> {
  const policyFingerprint = fingerprinter.fingerprint(fixture.policy);
  const baselineRequest: CreateSandboxRequest = {
    context: fixture.context,
    idempotencyKey: "sandbox-contract-baseline",
    policy: fixture.policy,
    policyFingerprint,
  };
  const baseline = await lifecycle.create(baselineRequest);
  const replay = await lifecycle.create(baselineRequest);
  if (
    replay.instanceId !== baseline.instanceId ||
    replay.policyFingerprint.digest !== baseline.policyFingerprint.digest
  ) {
    throw new Error("sandbox create is not idempotent");
  }
  const baselineExecution = await executeBaseline(
    lifecycle,
    baseline,
    policyFingerprint,
    fixture.workspace,
  );
  if (baselineExecution.exitCode !== 0) {
    throw new Error("sandbox baseline execution did not succeed");
  }

  const sentinelsBefore = await fixture.snapshotSentinels();
  const results: SandboxContractScenarioResult[] = [];
  for (const scenario of sandboxContractScenarios) {
    let observedCode: SandboxDenialCode | undefined;
    let detail: string;
    try {
      await executeScenario(scenario.id, lifecycle, baseline, fixture, policyFingerprint);
      detail = "scenario was allowed";
    } catch (error: unknown) {
      observedCode = denialCodeOf(error);
      detail = error instanceof Error ? error.message : "scenario raised a non-Error denial";
    }
    results.push(
      Object.freeze({
        id: scenario.id,
        expectedCode: scenario.expectedCode,
        observedCode,
        passed: observedCode === scenario.expectedCode,
        detail,
      }),
    );
  }

  await lifecycle.stop(baseline.instanceId, policyFingerprint);
  await lifecycle.stop(baseline.instanceId, policyFingerprint);
  await lifecycle.destroy(baseline.instanceId, policyFingerprint);
  await lifecycle.destroy(baseline.instanceId, policyFingerprint);
  const sentinelsAfter = await fixture.snapshotSentinels();
  const sentinelsUnchanged = recordsEqual(sentinelsBefore, sentinelsAfter);
  const frozenResults = Object.freeze(results);
  return Object.freeze({
    scenarioCount: frozenResults.length,
    passed: frozenResults.every((result) => result.passed) && sentinelsUnchanged,
    results: frozenResults,
    baselineInstanceId: baseline.instanceId,
    sentinelsUnchanged,
    sentinelsBefore,
    sentinelsAfter,
  });
}

async function executeBaseline(
  lifecycle: SandboxLifecycle,
  instance: SandboxInstance,
  policyFingerprint: SandboxPolicyFingerprint,
  workspace: string,
): Promise<SandboxExecutionResult> {
  return lifecycle.execute({
    instanceId: instance.instanceId,
    expectedPolicyFingerprint: policyFingerprint,
    executable: "node",
    arguments: ["-e", ""],
    workingDirectory: workspace,
    environment: Object.freeze({}),
    timeoutMs: 100,
    maxOutputBytes: 256,
  });
}

async function executeScenario(
  id: SandboxContractScenarioId,
  lifecycle: SandboxLifecycle,
  instance: SandboxInstance,
  fixture: SandboxContractFixture,
  policyFingerprint: SandboxPolicyFingerprint,
): Promise<void> {
  if (id === "policy-mutation") {
    const mutatedPolicy: SandboxPolicy = Object.freeze({
      ...fixture.policy,
      resources: Object.freeze({
        ...fixture.policy.resources,
        maxOutputBytes: fixture.policy.resources.maxOutputBytes + 1,
      }),
    });
    await lifecycle.create({
      context: fixture.context,
      idempotencyKey: "sandbox-contract-policy-mutation",
      policy: mutatedPolicy,
      policyFingerprint,
    });
    return;
  }
  const request = scenarioRequest(id, instance, fixture, policyFingerprint);
  await lifecycle.execute(request);
}

function scenarioRequest(
  id: Exclude<SandboxContractScenarioId, "policy-mutation">,
  instance: SandboxInstance,
  fixture: SandboxContractFixture,
  policyFingerprint: SandboxPolicyFingerprint,
): ExecuteSandboxRequest {
  const base = {
    instanceId: instance.instanceId,
    expectedPolicyFingerprint: policyFingerprint,
    workingDirectory: fixture.workspace,
    environment: Object.freeze({}),
    timeoutMs: 100,
    maxOutputBytes: 4_096,
  } satisfies Omit<ExecuteSandboxRequest, "executable" | "arguments">;
  const requests: Record<
    Exclude<SandboxContractScenarioId, "policy-mutation">,
    ExecuteSandboxRequest
  > = {
    "absolute-host-path": { ...base, executable: "cat", arguments: [fixture.directory] },
    "parent-traversal": {
      ...base,
      executable: "cat",
      arguments: ["../sibling-workspace/sibling-sentinel.txt"],
    },
    "symlink-escape": { ...base, executable: "cat", arguments: [fixture.symlinkEscape] },
    "sibling-workspace": { ...base, executable: "cat", arguments: [fixture.siblingSentinel] },
    "home-credentials": { ...base, executable: "cat", arguments: [fixture.credentialsSentinel] },
    "daemon-socket": { ...base, executable: "cat", arguments: [fixture.daemonSocket] },
    "control-socket": { ...base, executable: "cat", arguments: [fixture.controlSocket] },
    "device-path": { ...base, executable: "cat", arguments: [fixture.device] },
    "child-process-escape": {
      ...base,
      executable: "node",
      arguments: [
        "-e",
        "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref()",
      ],
    },
    "git-commit": { ...base, executable: "git", arguments: ["commit", "-m", "attack"] },
    "git-branch": { ...base, executable: "git", arguments: ["branch", "attack"] },
    "git-remote": {
      ...base,
      executable: "git",
      arguments: ["remote", "set-url", "origin", "https://github.com/owner/repo"],
    },
    "git-push": { ...base, executable: "git", arguments: ["push", "origin", "HEAD"] },
    "git-fetch": { ...base, executable: "git", arguments: ["fetch", "origin"] },
    "git-worktree": { ...base, executable: "git", arguments: ["worktree", "add", "/tmp/linked"] },
    "git-credential": {
      ...base,
      executable: "git",
      arguments: ["config", "credential.helper=store"],
    },
    "network-private": { ...base, executable: "curl", arguments: ["http://10.0.0.1/"] },
    "network-loopback": { ...base, executable: "curl", arguments: ["http://127.0.0.1/"] },
    "network-link-local": { ...base, executable: "curl", arguments: ["http://169.254.1.1/"] },
    "network-metadata": {
      ...base,
      executable: "curl",
      arguments: ["http://169.254.169.254/latest/meta-data/"],
    },
    "read-only-workspace-write": {
      ...base,
      executable: "touch",
      arguments: [fixture.workspaceSentinel],
    },
    "undeclared-executable": { ...base, executable: "uname", arguments: [] },
    "output-limit": {
      ...base,
      executable: "node",
      arguments: ["-e", "process.stdout.write('x'.repeat(4097))"],
    },
    "timeout-limit": {
      ...base,
      executable: "node",
      arguments: ["-e", "setTimeout(()=>{},1000)"],
    },
    "resource-limit": {
      ...base,
      executable: "node",
      arguments: [
        "-e",
        "const {spawn}=require('node:child_process');const children=Array.from({length:17},()=>spawn(process.execPath,['-e','setTimeout(()=>{},1000)']));Promise.all(children.map(child=>new Promise(resolve=>child.on('exit',resolve))))",
      ],
    },
  };
  return requests[id];
}

function denialCodeOf(error: unknown): SandboxDenialCode | undefined {
  if (error instanceof SandboxDeniedError) return error.code;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const candidate = error.code;
  return typeof candidate === "string" && isSandboxDenialCode(candidate) ? candidate : undefined;
}

function isSandboxDenialCode(value: string): value is SandboxDenialCode {
  return Object.prototype.hasOwnProperty.call(knownDenialCodes, value);
}

const knownDenialCodes: Record<SandboxDenialCode, true> = {
  backend_unavailable: true,
  backend_unconfined: true,
  policy_fingerprint_mismatch: true,
  idempotency_conflict: true,
  instance_not_found: true,
  invalid_state: true,
  invalid_policy: true,
  absolute_host_path: true,
  path_traversal: true,
  symlink_escape: true,
  sibling_workspace: true,
  home_credentials: true,
  control_socket: true,
  device: true,
  process_escape: true,
  git_commit_blocked: true,
  git_branch_blocked: true,
  git_remote_blocked: true,
  git_push_blocked: true,
  git_fetch_blocked: true,
  git_worktree_blocked: true,
  git_credential_blocked: true,
  network_private: true,
  network_loopback: true,
  network_link_local: true,
  network_metadata: true,
  network_host_denied: true,
  read_only_mount: true,
  mount_not_allowed: true,
  executable_not_allowed: true,
  output_limit: true,
  timeout_limit: true,
  resource_limit: true,
};

function recordsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([name, value]) => right[name] === value);
}
