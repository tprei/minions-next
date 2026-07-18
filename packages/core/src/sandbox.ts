import type { AttemptId, ContentHash, HostId, RepositoryId, TaskNodeId } from "./value-objects.js";

export const sandboxBackendKinds = ["macos_lima", "linux_podman", "wsl2_podman", "test"] as const;
export type SandboxBackendKind = (typeof sandboxBackendKinds)[number];

export const productionSandboxBackendKinds = ["macos_lima", "linux_podman", "wsl2_podman"] as const;
export type ProductionSandboxBackendKind = (typeof productionSandboxBackendKinds)[number];

export const sandboxNetworkProfiles = [
  "explore",
  "research",
  "implementation",
  "gate",
  "maintenance",
] as const;
export type SandboxNetworkProfile = (typeof sandboxNetworkProfiles)[number];

export type SandboxMountAccess = "read_only" | "read_write";
export type SandboxMountKind = "workspace" | "scratch" | "cache";

export type SandboxMount = Readonly<{
  kind: SandboxMountKind;
  sourcePath: string;
  targetPath: string;
  access: SandboxMountAccess;
}>;

export type SandboxResourceProfile = Readonly<{
  cpuCount: number;
  memoryMiB: number;
  processLimit: number;
  storageMiB: number;
  executionTimeoutMs: number;
  maxOutputBytes: number;
}>;

export type SandboxToolPolicy = Readonly<{
  allowedExecutables: readonly string[];
  allowedGitSubcommands: readonly string[];
  blockedGitSubcommands: readonly string[];
}>;

export type SandboxNetworkPolicy = Readonly<{
  profile: SandboxNetworkProfile;
  allowedHosts: readonly string[];
  allowProviderGateway: boolean;
}>;

export type SandboxPolicy = Readonly<{
  version: 1;
  rootFilesystemDigest: ContentHash;
  templateDigest: ContentHash;
  mounts: readonly SandboxMount[];
  network: SandboxNetworkPolicy;
  tools: SandboxToolPolicy;
  resources: SandboxResourceProfile;
}>;

export type SandboxPolicyFingerprint = Readonly<{
  policyVersion: 1;
  digest: ContentHash;
}>;

export type SandboxCapabilitySet = Readonly<{
  readOnlyMounts: boolean;
  processIsolation: boolean;
  privateNetworkBlocking: boolean;
  toolFiltering: boolean;
  nestedContainers: boolean;
  supportedNetworkProfiles: readonly SandboxNetworkProfile[];
}>;

export type SandboxCapabilityProbe =
  | Readonly<{
      available: true;
      backendKind: SandboxBackendKind;
      backendVersion: string;
      templateFingerprint: ContentHash;
      capabilities: SandboxCapabilitySet;
    }>
  | Readonly<{
      available: false;
      backendKind: SandboxBackendKind;
      failureCode: string;
      message: string;
    }>;

export type SandboxAttemptContext = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  repositoryId: RepositoryId;
  hostId: HostId;
}>;

export type SandboxInstance = Readonly<{
  instanceId: string;
  context: SandboxAttemptContext;
  backendKind: SandboxBackendKind;
  policyFingerprint: SandboxPolicyFingerprint;
  state: "created" | "running" | "stopped";
}>;

export type CreateSandboxRequest = Readonly<{
  context: SandboxAttemptContext;
  idempotencyKey: string;
  policy: SandboxPolicy;
  policyFingerprint: SandboxPolicyFingerprint;
}>;

export type ExecuteSandboxRequest = Readonly<{
  instanceId: string;
  expectedPolicyFingerprint: SandboxPolicyFingerprint;
  executable: string;
  arguments: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}>;

export type SandboxExecutionResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export interface SandboxPolicyFingerprinter {
  fingerprint(policy: SandboxPolicy): SandboxPolicyFingerprint;
}

export interface SandboxLifecycle {
  readonly backendKind: SandboxBackendKind;
  probe(): Promise<SandboxCapabilityProbe>;
  create(request: CreateSandboxRequest): Promise<SandboxInstance>;
  execute(request: ExecuteSandboxRequest): Promise<SandboxExecutionResult>;
  stop(instanceId: string, expectedPolicyFingerprint: SandboxPolicyFingerprint): Promise<void>;
  destroy(instanceId: string, expectedPolicyFingerprint: SandboxPolicyFingerprint): Promise<void>;
}
