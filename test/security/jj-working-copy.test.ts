import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  attemptId,
  contentHash,
  gitSha,
  hostId,
  nonEmptyText,
  repositoryId,
  taskNodeId,
  timestampFromEpochMilliseconds,
  SandboxDeniedError,
  type SandboxPolicy,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";

import { ensureJjCapability } from "../../packages/adapters/src/jj-capability.js";
import {
  createJjCentralRepoManager,
  type JjCentralRepo,
} from "../../packages/adapters/src/jj-central-repo.js";
import {
  SandboxPolicyError,
  createSandboxPolicyFingerprinter,
  validateSandboxPolicy,
} from "../../packages/adapters/src/sandbox-policy.js";
import { createTestSandboxLifecycle } from "../../packages/testkit/src/sandbox.js";
import {
  JJ_METADATA_DIR,
  JjWorkingCopyError,
  createJjWorkingCopyManager,
  pathContainsDotJj,
  type JjWorkingCopyManager,
} from "../../packages/adapters/src/jj-working-copy.js";

/**
 * PR 28 — masked jj working copy per node.
 *
 * Runs against the REAL pinned jj v0.43.0 binary (downloaded + digest-verified by
 * ensureJjCapability) and REAL central jj repos bootstrapped via PR 27. Verifies:
 *   - The working copy's file tree IS the node workspace.
 *   - `.jj` is host-owned + owner-only (GIT-15) and excluded from every sandbox mount.
 *   - The harness cannot reach `.jj`, the central store, sibling working copies, or
 *     operation history (all paths under `.jj` are denied by the policy validators).
 *   - diff / status / commit flow through the serialized host broker.
 *   - Isolation is at least as strong as the independent-clone model (sibling wcs
 *     are at disjoint host paths and never mounted into one another's sandbox).
 */

const downloadTimeoutMs = 180_000;
const changeIdPattern = /^[0-9a-z]{32}$/u;
const commitIdPattern = /^[0-9a-f]{40}$/u;

const temporaryDirectories: string[] = [];
let jjBinaryPath: string;

beforeAll(async () => {
  const toolsDirectory = await makeDirectory("jj-wc-tools-");
  const probe = await ensureJjCapability({ toolsDirectory });
  expect(probe.available).toBe(true);
  if (!probe.available) {
    throw new Error(`jj capability unavailable: ${probe.message}`);
  }
  jjBinaryPath = probe.binaryPath;
}, downloadTimeoutMs);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function runJj(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      jjBinaryPath,
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`jj ${args.join(" ")} failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function firstNonEmptyLine(value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

interface CentralRepo {
  readonly centralRepoPath: string;
  readonly baseCommit: string;
  readonly baseChangeId: string;
  readonly jjRepo: JjCentralRepo;
}

/**
 * Bootstrap a real central jj repo (via PR 27 manager) seeded with content + a `main`
 * bookmark at the base commit. The host-side seeding (write file, jj commit, bookmark)
 * is permitted: only the SANDBOXED harness is barred from jj; the host broker owns it.
 */
async function bootstrapCentralRepo(prefix: string): Promise<CentralRepo> {
  const hostRoot = await makeDirectory(`${prefix}-central-host-`);
  const clock = new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000));
  const ids = new SequenceIdGenerator(["01900000-0000-7000-8000-0000000000a1"]);
  const manager = createJjCentralRepoManager({ jjBinaryPath, hostRoot, clock, ids });
  // bootstrap creates an empty colocated repo under <hostRoot>/<repositoryId>.
  const repoRoot = await makeDirectory(`${prefix}-central-source-`);
  const id = repositoryId("01900000-0000-7000-8000-000000000001");
  const jjRepo = await manager.bootstrap(repoRoot, id);
  const centralRepoPath = jjRepo.jjRepoPath;

  // Seed content + a base commit directly through jj (host-side).
  await writeFile(join(centralRepoPath, "README.md"), "central workspace\n", "utf8");
  await mkdir(join(centralRepoPath, "src"), { recursive: true });
  await writeFile(join(centralRepoPath, "src", "lib.ts"), "export const v = 1;\n", "utf8");
  await runJj(centralRepoPath, ["file", "track", "README.md", "src/lib.ts"]);
  await runJj(centralRepoPath, ["commit", "-m", "base commit"]);
  const baseChangeId = firstNonEmptyLine(
    await runJj(centralRepoPath, ["log", "--no-graph", "-r", "@-", "-T", 'change_id ++ "\n"']),
  );
  const baseCommit = firstNonEmptyLine(
    await runJj(centralRepoPath, ["log", "--no-graph", "-r", "@-", "-T", 'commit_id ++ "\n"']),
  );
  await runJj(centralRepoPath, ["bookmark", "create", "main", "-r", baseChangeId]);
  return { centralRepoPath, baseCommit, baseChangeId, jjRepo };
}

function freshManager(centralRepoPath: string, hostRoot: string): JjWorkingCopyManager {
  const clock = new FixedClock(timestampFromEpochMilliseconds(1_700_000_001_000));
  const ids = new SequenceIdGenerator([
    "01900000-0000-7000-8000-000000000010",
    "01900000-0000-7000-8000-000000000011",
    "01900000-0000-7000-8000-000000000012",
  ]);
  return createJjWorkingCopyManager({
    jjBinaryPath,
    centralRepoPath,
    hostRoot,
    clock,
    ids,
  });
}

/** A minimal valid sandbox policy with the given mounts. */
function policyWithMounts(mounts: SandboxPolicy["mounts"]): SandboxPolicy {
  return Object.freeze({
    version: 1,
    rootFilesystemDigest: contentHash("a".repeat(64)),
    templateDigest: contentHash("b".repeat(64)),
    mounts,
    network: Object.freeze({
      profile: "implementation",
      allowedHosts: Object.freeze(["github.com"]),
      allowProviderGateway: false,
    }),
    tools: Object.freeze({
      allowedExecutables: Object.freeze(["cat", "git", "node", "touch"]),
      allowedGitSubcommands: Object.freeze(["status"]),
      blockedGitSubcommands: Object.freeze(["branch", "commit", "fetch", "push", "remote"]),
    }),
    resources: Object.freeze({
      cpuCount: 2,
      memoryMiB: 2_048,
      processLimit: 16,
      storageMiB: 20_480,
      executionTimeoutMs: 120_000,
      maxOutputBytes: 1_048_576,
    }),
  });
}

// -------------------------------------------------------------------------------------------------
// Working copy lifecycle — the file tree IS the workspace, .jj is host-owned.
// -------------------------------------------------------------------------------------------------

describe("createJjWorkingCopyManager — createWorkingCopy", () => {
  it("creates a jj working copy whose file tree is the node workspace", async () => {
    const central = await bootstrapCentralRepo("jj-wc-create-");
    const hostRoot = await makeDirectory("jj-wc-host-");
    const manager = freshManager(central.centralRepoPath, hostRoot);

    const wc = await manager.createWorkingCopy(
      taskNodeId("01900000-0000-7000-8000-000000000aa1"),
      gitSha(central.baseCommit),
    );

    // The receipt records the working-copy change id, parent (base) change id, base commit.
    expect(wc.workingCopyId).toMatch(changeIdPattern);
    expect(wc.parentChangeId).toBe(central.baseChangeId);
    expect(wc.baseCommit).toBe(central.baseCommit);
    expect(wc.workingCopyPath).toBe(join(hostRoot, "wc-01900000-0000-7000-8000-000000000aa1"));
    // The working copy's file tree IS the workspace (files are present, not the metadata).
    await expect(readFile(join(wc.workingCopyPath, "README.md"), "utf8")).resolves.toBe(
      "central workspace\n",
    );
    await expect(readFile(join(wc.workingCopyPath, "src", "lib.ts"), "utf8")).resolves.toBe(
      "export const v = 1;\n",
    );
    // `.jj` is present on the host (the broker owns it) and is owner-only (GIT-15).
    const dotJjStat = await stat(join(wc.workingCopyPath, JJ_METADATA_DIR));
    expect(dotJjStat.isDirectory()).toBe(true);
    expect(dotJjStat.mode & 0o777).toBe(0o700);
  }, 60_000);

  it("fails closed with working_copy_exists when the node already has a working copy", async () => {
    const central = await bootstrapCentralRepo("jj-wc-exists-");
    const hostRoot = await makeDirectory("jj-wc-host-exists-");
    const manager = freshManager(central.centralRepoPath, hostRoot);
    const nodeId = taskNodeId("01900000-0000-7000-8000-000000000bb2");

    await manager.createWorkingCopy(nodeId, gitSha(central.baseCommit));
    await expect(
      manager.createWorkingCopy(nodeId, gitSha(central.baseCommit)),
    ).rejects.toMatchObject({ name: "JjWorkingCopyError", code: "working_copy_exists" });
  }, 60_000);

  it("fails closed and cleans up when the base commit is unreachable", async () => {
    const central = await bootstrapCentralRepo("jj-wc-badbase-");
    const hostRoot = await makeDirectory("jj-wc-host-badbase-");
    const manager = freshManager(central.centralRepoPath, hostRoot);
    // A syntactically valid but nonexistent commit SHA (not all-zeros, which jj treats
    // as the root commit). `jj new` on this must fail with checkout_failed.
    const bogus = gitSha("deadbeef".repeat(5));

    await expect(
      manager.createWorkingCopy(taskNodeId("01900000-0000-7000-8000-000000000cc3"), bogus),
    ).rejects.toBeInstanceOf(JjWorkingCopyError);
    // The half-created working copy must be cleaned up (fail-closed).
    await expect(stat(join(hostRoot, "wc-01900000-0000-7000-8000-000000000cc3"))).rejects.toThrow();
  }, 60_000);
});

// -------------------------------------------------------------------------------------------------
// GIT-15 — .jj never inside a sandbox. All paths under .jj are denied.
// -------------------------------------------------------------------------------------------------

describe("GIT-15 — .jj metadata is never reachable inside a sandbox", () => {
  it("pathContainsDotJj detects .jj path segments", () => {
    expect(pathContainsDotJj("/host/wc-node/.jj")).toBe(true);
    expect(pathContainsDotJj("/host/wc-node/.jj/op_log")).toBe(true);
    expect(pathContainsDotJj("/host/.jj/store")).toBe(true);
    expect(pathContainsDotJj("/host/wc-node/README.md")).toBe(false);
    expect(pathContainsDotJj("/host/wc-node/src/lib.ts")).toBe(false);
    expect(pathContainsDotJj("")).toBe(false);
    // A directory literally named `.jjbook` is NOT `.jj`.
    expect(pathContainsDotJj("/host/wc-node/.jjbook")).toBe(false);
  });

  it("validateSandboxPolicy rejects any mount whose source or target touches .jj", async () => {
    const central = await bootstrapCentralRepo("jj-wc-policy-");
    const hostRoot = await makeDirectory("jj-wc-host-policy-");
    const manager = freshManager(central.centralRepoPath, hostRoot);
    const wc = await manager.createWorkingCopy(
      taskNodeId("01900000-0000-7000-8000-000000000dd4"),
      gitSha(central.baseCommit),
    );

    // Mounting the .jj metadata as a sandbox path is rejected (source).
    const sourceDotJj = policyWithMounts(
      Object.freeze([
        Object.freeze({
          kind: "workspace",
          sourcePath: wc.workingCopyPath,
          targetPath: "/workspace",
          access: "read_only" as const,
        }),
        Object.freeze({
          kind: "cache",
          sourcePath: join(wc.workingCopyPath, JJ_METADATA_DIR),
          targetPath: "/workspace/.jj",
          access: "read_write" as const,
        }),
      ]),
    );
    expect(() => validateSandboxPolicy(sourceDotJj)).toThrow(SandboxPolicyError);
    expect(() => validateSandboxPolicy(sourceDotJj)).toThrow(/\.jj/u);

    // Mounting to a .jj target path is rejected (target).
    const targetDotJj = policyWithMounts(
      Object.freeze([
        Object.freeze({
          kind: "workspace",
          sourcePath: wc.workingCopyPath,
          targetPath: join("/sandbox", JJ_METADATA_DIR),
          access: "read_only" as const,
        }),
      ]),
    );
    expect(() => validateSandboxPolicy(targetDotJj)).toThrow(SandboxPolicyError);

    // A policy that mounts ONLY the working-copy file tree (no .jj) is accepted.
    const safe = policyWithMounts(
      Object.freeze([
        Object.freeze({
          kind: "workspace",
          sourcePath: wc.workingCopyPath,
          targetPath: "/workspace",
          access: "read_write" as const,
        }),
      ]),
    );
    expect(() => validateSandboxPolicy(safe)).not.toThrow();
  }, 60_000);

  it("the test sandbox lifecycle rejects a policy that mounts .jj (invalid_policy)", async () => {
    const central = await bootstrapCentralRepo("jj-wc-lifecycle-");
    const hostRoot = await makeDirectory("jj-wc-host-lifecycle-");
    const manager = freshManager(central.centralRepoPath, hostRoot);
    const wc = await manager.createWorkingCopy(
      taskNodeId("01900000-0000-7000-8000-000000000ee5"),
      gitSha(central.baseCommit),
    );
    const fingerprinter = createSandboxPolicyFingerprinter();

    const dotJjPolicy = policyWithMounts(
      Object.freeze([
        Object.freeze({
          kind: "workspace",
          sourcePath: wc.workingCopyPath,
          targetPath: "/workspace",
          access: "read_write" as const,
        }),
        Object.freeze({
          kind: "cache",
          sourcePath: join(wc.workingCopyPath, JJ_METADATA_DIR),
          targetPath: join("/workspace", JJ_METADATA_DIR),
          access: "read_write" as const,
        }),
      ]),
    );
    // The fingerprinter itself rejects a .jj policy (production path).
    expect(() => fingerprinter.fingerprint(dotJjPolicy)).toThrow(SandboxPolicyError);
    // The test sandbox lifecycle's validatePolicy runs BEFORE the fingerprint is checked,
    // so a .jj policy is rejected with invalid_policy even though no valid fingerprint
    // can be computed for it. Pass a dummy fingerprint to exercise that path.
    const dummyFingerprint = Object.freeze({
      policyVersion: 1,
      digest: contentHash("c".repeat(64)),
    });
    const lifecycle = createTestSandboxLifecycle({ fingerprinter });
    await expect(
      lifecycle.create({
        idempotencyKey: "jj-dotJj-mount",
        context: {
          attemptId: attemptId("01900000-0000-7000-8000-000000000ee5"),
          nodeId: taskNodeId("01900000-0000-7000-8000-000000000ee5"),
          repositoryId: repositoryId("01900000-0000-7000-8000-0000000000e1"),
          hostId: hostId("01900000-0000-7000-8000-0000000000e2"),
        },
        policy: dotJjPolicy,
        policyFingerprint: dummyFingerprint,
      }),
    ).rejects.toMatchObject({ name: "SandboxDeniedError", code: "invalid_policy" });
    expect(SandboxDeniedError).toBeDefined();
  }, 60_000);
});

// -------------------------------------------------------------------------------------------------
// Isolation — the harness cannot reach the central store, siblings, or operation history.
// -------------------------------------------------------------------------------------------------

describe("isolation — central store, siblings, and operation history are unreachable", () => {
  it("places each working copy at a disjoint host path under hostRoot", async () => {
    const central = await bootstrapCentralRepo("jj-wc-siblings-");
    const hostRoot = await makeDirectory("jj-wc-host-siblings-");
    const manager = freshManager(central.centralRepoPath, hostRoot);

    const nodeA = taskNodeId("01900000-0000-7000-8000-0000000000f1");
    const nodeB = taskNodeId("01900000-0000-7000-8000-0000000000f2");
    const wcA = await manager.createWorkingCopy(nodeA, gitSha(central.baseCommit));
    const wcB = await manager.createWorkingCopy(nodeB, gitSha(central.baseCommit));

    // Sibling working copies live at disjoint paths; neither contains the other.
    expect(wcA.workingCopyPath).not.toBe(wcB.workingCopyPath);
    expect(wcA.workingCopyPath.startsWith(wcB.workingCopyPath)).toBe(false);
    expect(wcB.workingCopyPath.startsWith(wcA.workingCopyPath)).toBe(false);
    // Node A's working copy does not contain node B's files (siblings are isolated).
    await writeFile(join(wcA.workingCopyPath, "only-a.txt"), "a\n", "utf8");
    await writeFile(join(wcB.workingCopyPath, "only-b.txt"), "b\n", "utf8");
    await expect(readFile(join(wcB.workingCopyPath, "only-a.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(wcA.workingCopyPath, "only-b.txt"), "utf8")).rejects.toThrow();
    // The central store lives OUTSIDE the working-copy host root (validated by the manager).
    expect(central.centralRepoPath.startsWith(hostRoot)).toBe(false);
    expect(relative(hostRoot, central.centralRepoPath).startsWith("..")).toBe(true);
    // Operation history is under .jj of the CENTRAL repo, which is outside hostRoot and
    // under a .jj path (double denial: outside the mount + .jj is rejected).
    const centralOpHistory = join(central.centralRepoPath, JJ_METADATA_DIR);
    expect(pathContainsDotJj(centralOpHistory)).toBe(true);
    expect(centralOpHistory.startsWith(hostRoot)).toBe(false);
  }, 90_000);

  it("rejects a centralRepoPath that lives under hostRoot (siblings must be unreachable)", async () => {
    const central = await bootstrapCentralRepo("jj-wc-contain-");
    const hostRoot = await makeDirectory("jj-wc-host-contain-");
    // Place a central repo dir UNDER hostRoot to trip the containment guard.
    const nestedCentral = join(hostRoot, "nested-central");
    await mkdir(nestedCentral, { recursive: true });
    await runJj(nestedCentral, ["git", "init", "--colocate", "."]);

    expect(() => freshManager(nestedCentral, hostRoot)).toThrow(JjWorkingCopyError);
    // The central repo from bootstrap is unaffected (its path is outside hostRoot).
    expect(central.centralRepoPath.startsWith(hostRoot)).toBe(false);
  }, 60_000);
});

// -------------------------------------------------------------------------------------------------
// Host broker — diff / status / commit flow through the serialized manager.
// -------------------------------------------------------------------------------------------------

describe("host broker — diff, status, commit through the manager", () => {
  it("reports a clean working copy immediately after creation", async () => {
    const central = await bootstrapCentralRepo("jj-wc-clean-");
    const hostRoot = await makeDirectory("jj-wc-host-clean-");
    const manager = freshManager(central.centralRepoPath, hostRoot);
    const wc = await manager.createWorkingCopy(
      taskNodeId("01900000-0000-7000-8000-000000000a01"),
      gitSha(central.baseCommit),
    );

    const status = await manager.status(wc.workingCopyId);
    expect(status.clean).toBe(true);
    expect(status.changedPaths).toEqual([]);
    expect(status.parentChangeId).toBe(central.baseChangeId);
    expect(status.baseCommit).toBe(central.baseCommit);

    const diff = await manager.diff(wc.workingCopyId);
    expect(diff.diff.length).toBe(0);
    expect(diff.parentChangeId).toBe(central.baseChangeId);
  }, 60_000);

  it("flows diff and status through the broker after a workspace edit", async () => {
    const central = await bootstrapCentralRepo("jj-wc-edit-");
    const hostRoot = await makeDirectory("jj-wc-host-edit-");
    const manager = freshManager(central.centralRepoPath, hostRoot);
    const wc = await manager.createWorkingCopy(
      taskNodeId("01900000-0000-7000-8000-000000000a02"),
      gitSha(central.baseCommit),
    );

    // The harness edits the file tree (the workspace); it never calls jj.
    await writeFile(join(wc.workingCopyPath, "src", "lib.ts"), "export const v = 2;\n", "utf8");
    await writeFile(join(wc.workingCopyPath, "new.txt"), "added\n", "utf8");

    const status = await manager.status(wc.workingCopyId);
    expect(status.clean).toBe(false);
    expect(status.changedPaths).toContain("new.txt");
    expect(status.changedPaths).toContain("src/lib.ts");

    const diff = await manager.diff(wc.workingCopyId);
    expect(diff.diff.length).toBeGreaterThan(0);
    const diffText = new TextDecoder().decode(diff.diff);
    expect(diffText).toContain("src/lib.ts");
    expect(diffText).toContain("new.txt");
  }, 60_000);

  it("commits through the broker and returns a receipt with a fresh working-copy id", async () => {
    const central = await bootstrapCentralRepo("jj-wc-commit-");
    const hostRoot = await makeDirectory("jj-wc-host-commit-");
    const manager = freshManager(central.centralRepoPath, hostRoot);
    const wc = await manager.createWorkingCopy(
      taskNodeId("01900000-0000-7000-8000-000000000a03"),
      gitSha(central.baseCommit),
    );

    await writeFile(join(wc.workingCopyPath, "committed.txt"), "payload\n", "utf8");
    const receipt = await manager.commit(
      wc.workingCopyId,
      nonEmptyText("broker commit", "message"),
    );

    // The committed change gets a git commit SHA; a new empty working-copy change appears.
    expect(receipt.commitSha).toMatch(commitIdPattern);
    expect(receipt.workingCopyId).toBe(wc.workingCopyId);
    expect(receipt.newWorkingCopyId).toMatch(changeIdPattern);
    expect(receipt.newWorkingCopyId).not.toBe(wc.workingCopyId);
    expect(receipt.message).toBe("broker commit");
    // The old working-copy id is retired; the new one is now @.
    await expect(manager.status(wc.workingCopyId)).rejects.toMatchObject({
      name: "JjWorkingCopyError",
      code: "not_found",
    });
    const status = await manager.status(receipt.newWorkingCopyId);
    expect(status.clean).toBe(true);
  }, 60_000);
});

// -------------------------------------------------------------------------------------------------
// destroyWorkingCopy — clean teardown.
// -------------------------------------------------------------------------------------------------

describe("createJjWorkingCopyManager — destroyWorkingCopy", () => {
  it("removes the working copy directory and retires the id", async () => {
    const central = await bootstrapCentralRepo("jj-wc-destroy-");
    const hostRoot = await makeDirectory("jj-wc-host-destroy-");
    const manager = freshManager(central.centralRepoPath, hostRoot);
    const wc = await manager.createWorkingCopy(
      taskNodeId("01900000-0000-7000-8000-000000000a04"),
      gitSha(central.baseCommit),
    );
    await expect(stat(wc.workingCopyPath)).resolves.toBeDefined();

    await manager.destroyWorkingCopy(wc.workingCopyId);

    await expect(stat(wc.workingCopyPath)).rejects.toThrow();
    await expect(manager.status(wc.workingCopyId)).rejects.toMatchObject({
      name: "JjWorkingCopyError",
      code: "not_found",
    });
    // Destroying an unknown id is idempotent (no-op).
    await expect(manager.destroyWorkingCopy("unknown-id")).resolves.toBeUndefined();
  }, 60_000);

  it("is serialized: concurrent operations do not interleave on the op log", async () => {
    const central = await bootstrapCentralRepo("jj-wc-serial-");
    const hostRoot = await makeDirectory("jj-wc-host-serial-");
    const manager = freshManager(central.centralRepoPath, hostRoot);

    // Fan out concurrent status probes on a fresh working copy; serialization means they
    // all resolve without tripping jj's concurrent-op-log contention.
    const wc = await manager.createWorkingCopy(
      taskNodeId("01900000-0000-7000-8000-000000000a05"),
      gitSha(central.baseCommit),
    );
    const probes = await Promise.all(
      Array.from({ length: 8 }, () => manager.status(wc.workingCopyId)),
    );
    expect(probes.every((probe) => probe.clean)).toBe(true);
  }, 60_000);
});
