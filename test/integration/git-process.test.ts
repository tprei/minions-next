import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createNodeGitProcess } from "../../packages/adapters/src/git-process.js";
import { GitProcessError, type GitProcess, type GitProcessRequest } from "@minions/core";
import { describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 1_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly workingDirectoryDevice: bigint;
  readonly workingDirectoryInode: bigint;
  readonly wrapperDirectory: string;
  readonly invocationPath: string;
  readonly realGit: string;
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  workingDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await execFileAsync(command, [...arguments_], { cwd: workingDirectory, env: environment });
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "minions-git-process-")));
  const repository = join(root, "repository");
  const wrapperDirectory = join(root, "bin");
  const invocationPath = join(root, "invocation");
  await mkdir(repository);
  await mkdir(wrapperDirectory);
  const { stdout } = await execFileAsync("which", ["git"]);
  const realGit = stdout.trim();
  await runCommand(realGit, ["init", "--initial-branch=main"], repository);
  await writeFile(join(repository, "README"), "fixture\n");
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture-author",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture-committer",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  await runCommand(realGit, ["add", "README"], repository, identity);
  await runCommand(realGit, ["commit", "-m", "fixture"], repository, identity);
  const workingDirectoryMetadata = await lstat(repository, { bigint: true });
  const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
  const quotedInvocation = `'${invocationPath.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(wrapperDirectory, "git"),
    `#!/bin/sh\nprintf '%s\\0' "$PWD" "$@" > ${quotedInvocation}\nexec ${quotedGit} "$@"\n`,
  );
  await chmod(join(wrapperDirectory, "git"), 0o755);
  return {
    root,
    repository,
    workingDirectoryDevice: workingDirectoryMetadata.dev,
    workingDirectoryInode: workingDirectoryMetadata.ino,
    wrapperDirectory,
    invocationPath,
    realGit,
  };
}

async function withFixture(
  test: (fixture: Fixture, git: GitProcess) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  const originalPath = process.env["PATH"];
  if (originalPath === undefined) {
    throw new Error("PATH is unavailable");
  }
  vi.stubEnv("PATH", `${fixture.wrapperDirectory}:${originalPath}`);
  try {
    await test(fixture, createNodeGitProcess());
  } finally {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function request(
  fixture: Fixture,
  arguments_: readonly string[],
  options: Partial<Pick<GitProcessRequest, "timeoutMs" | "maxOutputBytes">> = {},
): GitProcessRequest {
  return {
    workingDirectory: fixture.repository,
    workingDirectoryDevice: fixture.workingDirectoryDevice,
    workingDirectoryInode: fixture.workingDirectoryInode,
    arguments: arguments_,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? OUTPUT_LIMIT,
  };
}

async function expectGitError(operation: () => Promise<unknown>): Promise<GitProcessError> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof GitProcessError) {
      return error;
    }
    throw error;
  }
  throw new Error("Git process unexpectedly succeeded");
}

describe("createNodeGitProcess", () => {
  it("passes the exact cwd and argv while preserving byte output", async () => {
    await withFixture(async (fixture, git) => {
      const result = await git.run(request(fixture, ["rev-parse", "--show-toplevel"]));
      expect(Buffer.from(result.stdout).toString("utf8")).toBe(`${fixture.repository}\n`);
      expect(result.stderr).toHaveLength(0);
      const invocation = (await readFile(fixture.invocationPath)).toString("utf8").split("\0");
      expect(invocation.slice(0, -1)).toEqual([
        fixture.repository,
        "-c",
        "protocol.file.allow=always",
        "rev-parse",
        "--show-toplevel",
      ]);
    });
  });

  it("reports a nonzero Git exit as a typed error without diagnostics or credentials", async () => {
    await withFixture(async (fixture, git) => {
      const secret = "ambient-exit-secret";
      const error = await expectGitError(() =>
        git.run(request(fixture, ["rev-parse", "--verify", "refs/heads/missing"])),
      );
      expect(error.kind).toBe("exit");
      expect(error.exitCode).toBe(128);
      expect(error.message).not.toContain(secret);
    });
  });

  it("terminates a timed-out process group and settles promptly", async () => {
    await withFixture(async (fixture, git) => {
      const startedAt = Date.now();
      const error = await expectGitError(() =>
        git.run(
          request(fixture, ["-c", "alias.wait=!sleep 30", "wait"], {
            timeoutMs: 100,
          }),
        ),
      );
      expect(error.kind).toBe("timeout");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
  });

  it("terminates a process that exceeds the combined output limit", async () => {
    await withFixture(async (fixture, git) => {
      const error = await expectGitError(() =>
        git.run(
          request(fixture, ["-c", "alias.emit=!printf 1234567890", "emit"], {
            maxOutputBytes: 4,
          }),
        ),
      );
      expect(error.kind).toBe("output_limit");
    });
  });

  it("rejects a symlink working directory before spawning Git", async () => {
    await withFixture(async (fixture, git) => {
      const linkedDirectory = join(fixture.root, "linked");
      await symlink(fixture.repository, linkedDirectory, "dir");
      const error = await expectGitError(() =>
        git.run({
          ...request(fixture, ["rev-parse", "--show-toplevel"]),
          workingDirectory: linkedDirectory,
        }),
      );
      expect(error.kind).toBe("spawn");
      await expect(access(fixture.invocationPath)).rejects.toThrow();
    });
  });

  it("does not mutate the index while refreshing a same-content tracked file", async () => {
    await withFixture(async (fixture, git) => {
      const indexPath = join(fixture.repository, ".git", "index");
      const beforeMetadata = await lstat(indexPath, { bigint: true });
      const beforeContent = await readFile(indexPath);
      await writeFile(join(fixture.repository, "README"), "fixture\n");
      await git.run(request(fixture, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]));
      const afterMetadata = await lstat(indexPath, { bigint: true });
      const afterContent = await readFile(indexPath);
      expect(afterMetadata.dev).toBe(beforeMetadata.dev);
      expect(afterMetadata.ino).toBe(beforeMetadata.ino);
      expect(afterMetadata.size).toBe(beforeMetadata.size);
      expect(afterMetadata.mtimeNs).toBe(beforeMetadata.mtimeNs);
      expect(afterMetadata.ctimeNs).toBe(beforeMetadata.ctimeNs);
      expect(afterContent).toEqual(beforeContent);
    });
  });

  it("does not inherit ambient author, config, or credential helper settings", async () => {
    await withFixture(async (fixture, git) => {
      const ambientConfig = join(fixture.root, "ambient.gitconfig");
      const secret = "ambient-git-secret";
      await writeFile(
        ambientConfig,
        `[user]\n\tname = ${secret}\n\temail = ${secret}@example.invalid\n[credential]\n\thelper = !printf ${secret}\n`,
      );
      vi.stubEnv("GIT_CONFIG_GLOBAL", ambientConfig);
      vi.stubEnv("GIT_AUTHOR_NAME", secret);
      vi.stubEnv("GIT_AUTHOR_EMAIL", `${secret}@example.invalid`);
      vi.stubEnv("GIT_COMMITTER_NAME", secret);
      vi.stubEnv("GIT_COMMITTER_EMAIL", `${secret}@example.invalid`);
      const configError = await expectGitError(() =>
        git.run(request(fixture, ["config", "--get", "user.name"])),
      );
      expect(configError.kind).toBe("exit");
      const commitError = await expectGitError(() =>
        git.run(request(fixture, ["commit", "--allow-empty", "-m", "ambient"])),
      );
      expect(commitError.kind).toBe("exit");
      expect(commitError.message).not.toContain(secret);
    });
  });

  it.each([
    ["timeoutMs", { timeoutMs: 0, maxOutputBytes: OUTPUT_LIMIT }],
    ["maxOutputBytes", { timeoutMs: TIMEOUT_MS, maxOutputBytes: 0 }],
  ])("rejects non-positive %s before spawning", async (_name, options) => {
    await withFixture(async (fixture, git) => {
      await expect(git.run(request(fixture, ["--version"], options))).rejects.toThrow(RangeError);
    });
  });
});
