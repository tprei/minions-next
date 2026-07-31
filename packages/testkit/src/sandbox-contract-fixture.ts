import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attemptId,
  contentHash,
  hostId,
  repositoryId,
  taskNodeId,
  type SandboxMount,
  type SandboxPolicy,
  type SandboxAttemptContext,
} from "@minions/core";
import { createGitFixture } from "./git-fixture.js";
import type { SandboxSensitivePath as TestSandboxSensitivePath } from "./sandbox.js";

export type SandboxContractFixtureOptions = Readonly<{
  prefix?: string;
}>;

export type SandboxContractFixture = Readonly<{
  directory: string;
  workspace: string;
  siblingWorkspace: string;
  home: string;
  credentials: string;
  daemonSocket: string;
  controlSocket: string;
  device: string;
  symlinkEscape: string;
  scratch: string;
  workspaceSentinel: string;
  siblingSentinel: string;
  credentialsSentinel: string;
  daemonSentinel: string;
  controlSentinel: string;
  deviceSentinel: string;
  sentinelPaths: Readonly<Record<string, string>>;
  sentinelContents: Readonly<Record<string, string>>;
  sensitivePaths: readonly TestSandboxSensitivePath[];
  context: SandboxAttemptContext;
  policy: SandboxPolicy;
  snapshotSentinels(): Promise<Readonly<Record<string, string>>>;
  dispose(): Promise<void>;
}>;

const blockedGitSubcommands = ["branch", "commit", "fetch", "push", "remote", "worktree"] as const;

export async function createSandboxContractFixture(
  options: SandboxContractFixtureOptions = {},
): Promise<SandboxContractFixture> {
  const git = await createGitFixture({ prefix: options.prefix ?? "minions-sandbox-contract-" });
  const directory = git.directory;
  const workspace = git.root;
  const siblingWorkspace = join(directory, "sibling-workspace");
  const home = join(directory, "home");
  const credentialsDirectory = join(home, ".config", "credentials");
  const sockets = join(directory, "sockets");
  const devices = join(directory, "devices");
  const scratch = join(directory, "scratch");
  const siblingSentinel = join(siblingWorkspace, "sibling-sentinel.txt");
  const workspaceSentinel = join(workspace, "workspace-sentinel.txt");
  const credentialsSentinel = join(credentialsDirectory, "token");
  const daemonSocket = join(sockets, "daemon.sock");
  const controlSocket = join(sockets, "control.sock");
  const device = join(devices, "host-device");
  const symlinkEscape = join(workspace, "symlink-escape.txt");
  const daemonSentinel = daemonSocket;
  const controlSentinel = controlSocket;
  const deviceSentinel = device;
  const sentinelContents = Object.freeze({
    workspace: "workspace sentinel\n",
    sibling: "sibling sentinel\n",
    credentials: "credential sentinel\n",
    daemon: "daemon sentinel\n",
    control: "control sentinel\n",
    device: "device sentinel\n",
  });
  let disposed = false;
  try {
    await mkdir(siblingWorkspace, { recursive: true });
    await mkdir(credentialsDirectory, { recursive: true });
    await mkdir(sockets, { recursive: true });
    await mkdir(devices, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await writeFile(workspaceSentinel, sentinelContents.workspace, "utf8");
    await writeFile(siblingSentinel, sentinelContents.sibling, "utf8");
    await writeFile(credentialsSentinel, sentinelContents.credentials, "utf8");
    await writeFile(daemonSocket, sentinelContents.daemon, "utf8");
    await writeFile(controlSocket, sentinelContents.control, "utf8");
    await writeFile(device, sentinelContents.device, "utf8");
    await symlink(siblingSentinel, symlinkEscape, "file");

    const workspaceMount: SandboxMount = Object.freeze({
      kind: "workspace",
      sourcePath: workspace,
      targetPath: workspace,
      access: "read_only",
    });
    const scratchMount: SandboxMount = Object.freeze({
      kind: "scratch",
      sourcePath: scratch,
      targetPath: scratch,
      access: "read_write",
    });
    const policy: SandboxPolicy = Object.freeze({
      version: 1,
      rootFilesystemDigest: contentHash("a".repeat(64)),
      templateDigest: contentHash("b".repeat(64)),
      mounts: Object.freeze([workspaceMount, scratchMount]),
      network: Object.freeze({
        profile: "implementation",
        allowedHosts: Object.freeze(["github.com"]),
        allowProviderGateway: false,
      }),
      tools: Object.freeze({
        allowedExecutables: Object.freeze(["cat", "curl", "git", "node", "touch"]),
        allowedGitSubcommands: Object.freeze(["status"]),
        blockedGitSubcommands: Object.freeze([...blockedGitSubcommands]),
      }),
      resources: Object.freeze({
        cpuCount: 2,
        memoryMiB: 512,
        processLimit: 16,
        storageMiB: 256,
        executionTimeoutMs: 1_000,
        maxOutputBytes: 4_096,
      }),
    });
    const sentinelPaths = Object.freeze({
      workspace: workspaceSentinel,
      sibling: siblingSentinel,
      credentials: credentialsSentinel,
      daemon: daemonSentinel,
      control: controlSentinel,
      device: deviceSentinel,
    });
    const sensitivePaths: readonly TestSandboxSensitivePath[] = Object.freeze([
      Object.freeze({ path: symlinkEscape, code: "symlink_escape" }),
      Object.freeze({ path: siblingWorkspace, code: "sibling_workspace" }),
      Object.freeze({ path: home, code: "home_credentials" }),
      Object.freeze({ path: daemonSocket, code: "control_socket" }),
      Object.freeze({ path: controlSocket, code: "control_socket" }),
      Object.freeze({ path: device, code: "device" }),
    ]);
    const context: SandboxAttemptContext = Object.freeze({
      attemptId: attemptId("01900000-0000-7000-8000-000000000001"),
      nodeId: taskNodeId("01900000-0000-7000-8000-000000000002"),
      repositoryId: repositoryId("01900000-0000-7000-8000-000000000003"),
      hostId: hostId("01900000-0000-7000-8000-000000000004"),
    });
    const fixture: SandboxContractFixture = {
      directory,
      workspace,
      siblingWorkspace,
      home,
      credentials: credentialsDirectory,
      daemonSocket,
      controlSocket,
      device,
      symlinkEscape,
      scratch,
      workspaceSentinel,
      siblingSentinel,
      credentialsSentinel,
      daemonSentinel,
      controlSentinel,
      deviceSentinel,
      sentinelPaths,
      sentinelContents,
      sensitivePaths,
      context,
      policy,
      snapshotSentinels: async () => {
        const entries = await Promise.all(
          Object.entries(sentinelPaths).map(
            async ([name, path]) => [name, await readFile(path, "utf8")] as const,
          ),
        );
        return Object.freeze(Object.fromEntries(entries));
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await git.dispose();
      },
    };
    return Object.freeze(fixture);
  } catch (error: unknown) {
    disposed = true;
    await git.dispose();
    throw error;
  }
}
