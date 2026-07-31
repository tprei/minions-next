import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createNativeGitVcsBackend,
  createNodeGitProcess,
  type GitMutationLeaseStore,
  type RepositoryRegistry,
  type WorkspaceRegistry,
} from "@minions/adapters";
import {
  attemptId,
  fencingToken,
  gitSha,
  hostId,
  nonEmptyText,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  VcsBackendError,
  type AttemptId,
  type Clock,
  type VcsBackend,
  type WorkspaceReceipt,
} from "@minions/core";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const FIXED_TIMESTAMP = timestampFromEpochMilliseconds(1_700_000_000_000);
const CLOCK: Clock = { now: () => FIXED_TIMESTAMP };
const ATTEMPT_ID: AttemptId = attemptId("01900000-0000-7000-8000-000000000021");
const UNUSED_SHA = "0123456789abcdef0123456789abcdef01234567";

interface WorkspaceRepo {
  readonly path: string;
  readonly baseCommit: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Minions Test",
      "-c",
      "user.email=minions-test@example.invalid",
      ...args,
    ],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

/**
 * Stand up a fresh, standalone Git repository (the same shape the workspace
 * manager produces: `git init` + initial commit, never a linked worktree) so the
 * test owns its `.git/config`.
 */
async function createWorkspaceRepo(): Promise<WorkspaceRepo> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "minions-filter-repo-")));
  temporaryDirectories.push(path);
  await runGit(path, ["init", "--quiet"]);
  await writeFile(join(path, "README.md"), "base\n");
  await runGit(path, ["add", "-A"]);
  await runGit(path, ["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);
  const baseCommit = await runGit(path, ["rev-parse", "HEAD"]);
  return { path, baseCommit };
}

function unusedMethod(): never {
  throw new Error("registry method is not exercised by commit()");
}

/**
 * A {@link WorkspaceRegistry} stub whose `get` returns a receipt pointing at the
 * test's workspace. `commit` only reads `workspacePath` from the receipt; the
 * other registry methods and the repository/lease stores are unused by the
 * commit path, so they throw if reached.
 */
function stubWorkspaceRegistry(workspacePath: string): WorkspaceRegistry {
  const receipt: WorkspaceReceipt = Object.freeze({
    attemptId: ATTEMPT_ID,
    nodeId: taskNodeId("01900000-0000-7000-8000-000000000011"),
    treeId: taskTreeId("01900000-0000-7000-8000-000000000003"),
    hostId: hostId("01900000-0000-7000-8000-000000000001"),
    repositoryId: repositoryId("01900000-0000-7000-8000-000000000002"),
    workspacePath,
    sourcePath: workspacePath,
    branchName: "main",
    baseCommit: gitSha(UNUSED_SHA),
    headCommit: gitSha(UNUSED_SHA),
    state: "ready",
    createdAt: FIXED_TIMESTAMP,
    readyAt: FIXED_TIMESTAMP,
    cleanupRequestedAt: undefined,
    cleanedAt: undefined,
    mutationFencingToken: fencingToken(1n),
    failureCode: undefined,
    version: 1,
  });
  return {
    get: () => receipt,
    begin: unusedMethod,
    markReady: unusedMethod,
    requestCleanup: unusedMethod,
    markCleaned: unusedMethod,
    markFailed: unusedMethod,
    listRecoverable: () => [],
  };
}

function unusedRepositoryRegistry(): RepositoryRegistry {
  return { register: unusedMethod, get: unusedMethod, list: unusedMethod };
}

function unusedLeaseStore(): GitMutationLeaseStore {
  return {
    acquire: unusedMethod,
    renew: unusedMethod,
    assertHeld: unusedMethod,
    release: unusedMethod,
  };
}

function createBackend(workspacePath: string): VcsBackend {
  return createNativeGitVcsBackend({
    git: createNodeGitProcess(),
    workspaceRegistry: stubWorkspaceRegistry(workspacePath),
    repositoryRegistry: unusedRepositoryRegistry(),
    gitMutationLeaseStore: unusedLeaseStore(),
    clock: CLOCK,
  });
}

describe("native-git VcsBackend git filter hardening", () => {
  it("rejects a repo-controlled clean filter before staging and never executes it", async () => {
    const { path: workspacePath, baseCommit } = await createWorkspaceRepo();
    // Marker the attacker's clean filter would create outside the repository.
    const marker = join(tmpdir(), `minions-rce-marker-${randomUUID()}`);

    // A workspace author plants an arbitrary-command clean filter in the local
    // `.git/config` and selects it from the repo-local `.gitattributes`. Git runs
    // clean filters through `/bin/sh -c` during `add`, so `shell:false` on the
    // git process does not stop this — on pre-fix code the marker appears and the
    // commit succeeds with daemon privileges.
    await appendFile(
      join(workspacePath, ".git", "config"),
      `\n[filter "evil"]\n\tclean = touch '${marker}'; cat\n`,
    );
    await writeFile(join(workspacePath, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(workspacePath, "README.md"), "dirty\n");

    const backend = createBackend(workspacePath);

    await expect(
      backend.commit({
        attemptId: ATTEMPT_ID,
        message: nonEmptyText("should be rejected before staging", "commit message"),
      }),
    ).rejects.toBeInstanceOf(VcsBackendError);

    // The clean filter command must never have executed.
    await expect(access(marker)).rejects.toThrow();

    // Nothing was staged and HEAD is unchanged — the gate fired before `add`.
    expect(await runGit(workspacePath, ["rev-parse", "HEAD"])).toBe(baseCommit);
    expect(await runGit(workspacePath, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("commits normally when the repo config carries no dangerous keys", async () => {
    const { path: workspacePath, baseCommit } = await createWorkspaceRepo();
    await writeFile(join(workspacePath, "feature.txt"), "new\n");

    const result = await createBackend(workspacePath).commit({
      attemptId: ATTEMPT_ID,
      message: nonEmptyText("safe commit", "commit message"),
    });

    expect(result.parentCommit).toBe(baseCommit);
    expect(result.headCommit).not.toBe(baseCommit);
  });
});
