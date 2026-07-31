import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { repositoryId, timestampFromEpochMilliseconds } from "@minions/core";

import { ensureJjCapability } from "../../packages/adapters/src/jj-capability.js";
import { checkJjCompatibility } from "../../packages/adapters/src/jj-capability-gates.js";
import {
  createJjCentralRepoManager,
  JjCentralRepoError,
} from "../../packages/adapters/src/jj-central-repo.js";
import type { JjCompatibilityReport } from "../../packages/adapters/src/jj-capability-gates.js";

/**
 * PR 27 — host-owned colocated jj repo + capability gates.
 *
 * Runs against the REAL pinned jj v0.43.0 binary (downloaded + digest-verified by
 * ensureJjCapability) and REAL git repos created in temp dirs. Every jj-incompatible
 * feature (submodules, LFS, .gitattributes, partial clone, linked worktree, dirty
 * checkout, symlink alias) must produce a typed denial; a clean repository must
 * bootstrap a host-owned colocated jj repo with a durable operation-log id and an
 * owner-only `.jj`. The pre-snapshot scan must surface credential files + secrets.
 */

const downloadTimeoutMs = 180_000;
const opIdPattern = /^[0-9a-f]{64,}$/u;

const temporaryDirectories: string[] = [];
let jjBinaryPath: string;

beforeAll(async () => {
  const toolsDirectory = await makeDirectory("jj-registration-tools-");
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

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

interface CleanRepo {
  readonly directory: string;
  readonly root: string;
}

/** A minimal clean git repo: `git init`, configured author, one committed file, clean tree. */
async function initCleanRepo(prefix: string): Promise<CleanRepo> {
  const directory = await makeDirectory(prefix);
  const root = join(directory, "repo");
  await runGit(directory, ["init", root]);
  await runGit(root, ["config", "user.name", "Jj Registration"]);
  await runGit(root, ["config", "user.email", "jj@example.test"]);
  await runGit(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await writeFile(join(root, "README.md"), "initial\n", "utf8");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "initial"]);
  return { directory, root };
}

function denialCodes(report: JjCompatibilityReport): readonly string[] {
  return report.denials.map((denial) => denial.code);
}

function freshManager(hostRoot: string) {
  const clock = new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000));
  const ids = new SequenceIdGenerator([
    "01900000-0000-7000-8000-000000000001",
    "01900000-0000-7000-8000-000000000002",
    "01900000-0000-7000-8000-000000000003",
  ]);
  return createJjCentralRepoManager({ jjBinaryPath, hostRoot, clock, ids });
}

// -------------------------------------------------------------------------------------------------
// Capability gates — every incompatible feature produces a typed denial.
// -------------------------------------------------------------------------------------------------

describe("checkJjCompatibility — typed denials", () => {
  it("reports a clean repository compatible with hooks absent", async () => {
    const { root } = await initCleanRepo("jj-clean-");
    const report = await checkJjCompatibility(root);
    expect(report.compatible).toBe(true);
    expect(report.denials).toEqual([]);
    expect(report.hooksAbsent).toBe(true);
  });

  it("denies a repository with submodules (submodules_present)", async () => {
    const { directory, root } = await initCleanRepo("jj-sub-");
    const subRoot = join(directory, "sub-repo");
    await runGit(directory, ["init", subRoot]);
    await runGit(subRoot, ["config", "user.name", "Sub"]);
    await runGit(subRoot, ["config", "user.email", "sub@example.test"]);
    await runGit(subRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await writeFile(join(subRoot, "sub.txt"), "submodule\n", "utf8");
    await runGit(subRoot, ["add", "sub.txt"]);
    await runGit(subRoot, ["commit", "-m", "submodule"]);
    await runGit(root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      subRoot,
      "vendor/sub",
    ]);
    await runGit(root, ["add", ".gitmodules", "vendor/sub"]);
    await runGit(root, ["commit", "-m", "submodule link"]);

    const report = await checkJjCompatibility(root);
    expect(report.compatible).toBe(false);
    expect(denialCodes(report)).toContain("submodules_present");
    const denial = report.denials.find((value) => value.code === "submodules_present");
    expect(denial?.evidence).toContain("vendor/sub");
  });

  it("denies a repository declaring Git LFS (lfs_required)", async () => {
    const { root } = await initCleanRepo("jj-lfs-");
    await writeFile(
      join(root, ".gitattributes"),
      "assets/*.bin filter=lfs diff=lfs merge=lfs -text\n",
      "utf8",
    );
    await runGit(root, ["add", ".gitattributes"]);
    await runGit(root, ["commit", "-m", "lfs attributes"]);

    const report = await checkJjCompatibility(root);
    expect(report.compatible).toBe(false);
    expect(denialCodes(report)).toContain("lfs_required");
    expect(denialCodes(report)).not.toContain("gitattributes_required");
  });

  it("denies a repository with non-LFS .gitattributes rules (gitattributes_required)", async () => {
    const { root } = await initCleanRepo("jj-attr-");
    await writeFile(join(root, ".gitattributes"), "* text=auto\n*.sh text eol=lf\n", "utf8");
    await runGit(root, ["add", ".gitattributes"]);
    await runGit(root, ["commit", "-m", "gitattributes"]);

    const report = await checkJjCompatibility(root);
    expect(report.compatible).toBe(false);
    expect(denialCodes(report)).toContain("gitattributes_required");
    expect(denialCodes(report)).not.toContain("lfs_required");
  });

  it("denies a shallow / partial clone (partial_clone)", async () => {
    const directory = await makeDirectory("jj-partial-");
    const origin = join(directory, "origin.git");
    const full = join(directory, "full");
    await runGit(directory, ["init", "--bare", origin]);
    await runGit(directory, ["clone", origin, full]);
    await runGit(full, ["config", "user.name", "Origin"]);
    await runGit(full, ["config", "user.email", "origin@example.test"]);
    await runGit(full, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await writeFile(join(full, "README.md"), "initial\n", "utf8");
    await runGit(full, ["add", "README.md"]);
    await runGit(full, ["commit", "-m", "initial"]);
    await runGit(full, ["push", "origin", "main"]);
    await runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    const shallow = join(directory, "shallow");
    await runGit(directory, ["clone", "--depth", "1", `file://${origin}`, shallow]);

    const report = await checkJjCompatibility(shallow);
    expect(report.compatible).toBe(false);
    expect(denialCodes(report)).toContain("partial_clone");
  });

  it("denies a linked worktree (linked_worktree)", async () => {
    const { directory, root } = await initCleanRepo("jj-worktree-");
    const linked = join(directory, "linked");
    await runGit(root, ["worktree", "add", "--detach", linked]);

    const report = await checkJjCompatibility(linked);
    expect(report.compatible).toBe(false);
    expect(denialCodes(report)).toContain("linked_worktree");
  });

  it("denies a dirty checkout (dirty_checkout)", async () => {
    const { root } = await initCleanRepo("jj-dirty-");
    await writeFile(join(root, "README.md"), "changed but uncommitted\n", "utf8");

    const report = await checkJjCompatibility(root);
    expect(report.compatible).toBe(false);
    expect(denialCodes(report)).toContain("dirty_checkout");
  });

  it("denies a symlinked repository root (symlink_alias)", async () => {
    const { directory, root } = await initCleanRepo("jj-symlink-");
    const alias = join(directory, "alias");
    await symlink(root, alias);

    const report = await checkJjCompatibility(alias);
    expect(report.compatible).toBe(false);
    expect(denialCodes(report)).toContain("symlink_alias");
  });

  it("detects live git hooks (hooksAbsent === false)", async () => {
    const { root } = await initCleanRepo("jj-hooks-");
    await writeFile(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook\n", {
      mode: 0o755,
    });

    const report = await checkJjCompatibility(root);
    expect(report.hooksAbsent).toBe(false);
    // Hooks presence alone is recorded, not a registration denial.
    expect(denialCodes(report)).not.toContain("hooks_present");
  });
});

// -------------------------------------------------------------------------------------------------
// Central repo lifecycle — bootstrap + pre-snapshot scan.
// -------------------------------------------------------------------------------------------------

describe("createJjCentralRepoManager — bootstrap", () => {
  it("bootstraps a host-owned colocated jj repo with a durable operation id", async () => {
    const hostRoot = await makeDirectory("jj-host-");
    const manager = freshManager(hostRoot);
    const { root } = await initCleanRepo("jj-bootstrap-");
    const id = repositoryId("01900000-0000-7000-8000-0000000000a1");

    const repo = await manager.bootstrap(root, id);

    expect(repo.repositoryId).toBe(id);
    expect(repo.jjRepoPath).toBe(join(hostRoot, id));
    expect(repo.operationLogId).toMatch(opIdPattern);
    expect(repo.snapshotTrackingLocked).toBe(true);
    expect(repo.hooksAbsent).toBe(true);

    // `.jj` is host-owned + owner-only (GIT-15): never traversable by a sandbox.
    const mode = (await stat(join(repo.jjRepoPath, ".jj"))).mode & 0o777;
    expect(mode).toBe(0o700);
    // The colocate produced both a git dir and a jj dir.
    await expect(stat(join(repo.jjRepoPath, ".git"))).resolves.toBeDefined();
  });

  it("is idempotent: re-bootstrapping returns the stored operation-log id", async () => {
    const hostRoot = await makeDirectory("jj-host-idem-");
    const manager = freshManager(hostRoot);
    const { root } = await initCleanRepo("jj-idem-");
    const id = repositoryId("01900000-0000-7000-8000-0000000000b2");

    const first = await manager.bootstrap(root, id);
    const second = await manager.bootstrap(root, id);

    expect(second.operationLogId).toBe(first.operationLogId);
    expect(second.jjRepoPath).toBe(first.jjRepoPath);
    // The receipt enforces owner-only `.jj` across the idempotent fast-path too.
    const mode = (await stat(join(first.jjRepoPath, ".jj"))).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("fails closed with jj_unavailable when the binary path does not exist", async () => {
    const hostRoot = await makeDirectory("jj-host-nojj-");
    const manager = createJjCentralRepoManager({
      jjBinaryPath: join(hostRoot, "missing-jj"),
      hostRoot,
      clock: new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000)),
      ids: new SequenceIdGenerator(["01900000-0000-7000-8000-0000000000c3"]),
    });
    const { root } = await initCleanRepo("jj-nojj-");

    await expect(
      manager.bootstrap(root, repositoryId("01900000-0000-7000-8000-0000000000c3")),
    ).rejects.toMatchObject({ name: "JjCentralRepoError", code: "jj_unavailable" });
    expect(JjCentralRepoError).toBeDefined();
  });
});

describe("createJjCentralRepoManager — pre-snapshot scan (SEC-07)", () => {
  it("detects credential files and known secret shapes before snapshotting", async () => {
    const hostRoot = await makeDirectory("jj-host-scan-");
    const manager = freshManager(hostRoot);
    const { root } = await initCleanRepo("jj-scan-");
    // A credential file (suspicious path) carrying a real secret shape (SEC-07).
    await writeFile(
      join(root, ".env"),
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n",
      "utf8",
    );
    // An SSH-style key path (suspicious path, no secret shape).
    await writeFile(join(root, "id_rsa"), "not-a-real-key\n", "utf8");

    const report = await manager.preSnapshotScan(root);

    expect(report.repositoryRoot).toBe(root);
    expect(report.scanId.length).toBeGreaterThan(0);
    expect(report.suspiciousPaths).toContain(".env");
    expect(report.suspiciousPaths).toContain("id_rsa");
    expect(report.secretHits.length).toBeGreaterThan(0);
    expect(report.secretHits.some((hit) => hit.patternName === "openai_api_key")).toBe(true);
  });

  it("returns an empty report for a clean repository", async () => {
    const hostRoot = await makeDirectory("jj-host-clean-scan-");
    const manager = freshManager(hostRoot);
    const { root } = await initCleanRepo("jj-clean-scan-");

    const report = await manager.preSnapshotScan(root);

    expect(report.secretHits).toEqual([]);
    expect(report.suspiciousPaths).toEqual([]);
  });
});
