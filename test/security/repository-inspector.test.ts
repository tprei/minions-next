import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  access,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectRepository,
  RepositoryInspectionError,
} from "../../packages/adapters/src/repository-inspector.js";
import type { RepositoryInspection } from "../../packages/adapters/src/repository-inspector.js";

interface RepositoryFixture {
  readonly directory: string;
  readonly origin: string;
  readonly root: string;
  readonly baseCommit: string;
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        const output = stdout;
        const diagnostics = stderr;
        if (error !== null) {
          reject(new Error(`git ${args.join(" ")} failed: ${diagnostics}`, { cause: error }));
          return;
        }
        resolve(output);
      },
    );
  });
}

async function createFixture(): Promise<RepositoryFixture> {
  const directory = await mkdtemp(join(tmpdir(), "minions-repository-inspector-"));
  const origin = join(directory, "origin.git");
  const root = join(directory, "working");
  await runGit(directory, ["init", "--bare", origin]);
  await runGit(directory, ["clone", origin, root]);
  await runGit(root, ["config", "user.name", "Repository Inspector"]);
  await runGit(root, ["config", "user.email", "inspector@example.test"]);
  await runGit(root, ["checkout", "-b", "main"]);
  await writeFile(join(root, "README.md"), "initial\n", "utf8");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "initial"]);
  await runGit(root, ["push", "--set-upstream", "origin", "main"]);
  await runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await runGit(root, ["fetch", "origin"]);
  await runGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const baseCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
  return { directory, origin, root, baseCommit };
}

async function withFixture(
  operation: (fixture: RepositoryFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  try {
    await operation(fixture);
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
}

async function setOrigin(root: string, remote: string): Promise<void> {
  await runGit(root, ["remote", "set-url", "origin", remote]);
}

async function expectInspectionError(
  action: () => Promise<unknown>,
  code: RepositoryInspectionError["code"],
): Promise<RepositoryInspectionError> {
  let thrown: unknown;
  try {
    await action();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RepositoryInspectionError);
  if (!(thrown instanceof RepositoryInspectionError)) {
    throw new Error("Expected RepositoryInspectionError");
  }
  expect(thrown.code).toBe(code);
  return thrown;
}

describe("repository inspection", () => {
  it("canonicalizes HTTPS origins and freezes deterministic inspection collections", async () => {
    await withFixture(async ({ root, baseCommit }) => {
      await setOrigin(root, "HTTPS://GITHUB.COM/Org/Repo.git/");
      const canonicalRoot = await realpath(root);

      const inspection = await inspectRepository(root);

      expect(inspection).toMatchObject<Partial<RepositoryInspection>>({
        canonicalRoot,
        canonicalRemote: "https://github.com/Org/Repo",
        defaultBranch: "main",
        baseCommit,
        dirty: false,
      });
      expect(typeof inspection.caseSensitive).toBe("boolean");
      expect(inspection.submodulePaths).toEqual([]);
      expect(inspection.lfsPaths).toEqual([]);
      expect(inspection.nestedRepositoryPaths).toEqual([]);
      expect(Object.isFrozen(inspection)).toBe(true);
      expect(Object.isFrozen(inspection.submodulePaths)).toBe(true);
      expect(Object.isFrozen(inspection.lfsPaths)).toBe(true);
      expect(Object.isFrozen(inspection.nestedRepositoryPaths)).toBe(true);
    });
  });

  it("normalizes scp-style SSH origins and symlink aliases", async () => {
    await withFixture(async ({ directory, root }) => {
      await setOrigin(root, "Git@GITHUB.COM:Org/Repo.git/");
      const alias = join(directory, "working-alias");
      await symlink(root, alias, "dir");

      const inspection = await inspectRepository(alias);
      expect(inspection.canonicalRoot).toBe(await realpath(root));
      expect(inspection.canonicalRemote).toBe("ssh://Git@github.com/Org/Repo");
      expect(inspection.defaultBranch).toBe("main");
    });
  });

  it("rejects relative roots, wrong subdirectories, and linked worktrees", async () => {
    await withFixture(async ({ directory, root }) => {
      const relativeError = await expectInspectionError(
        () => inspectRepository("relative/repository"),
        "invalid_root",
      );
      expect(relativeError.cause).toBeInstanceOf(TypeError);

      const subdirectory = join(root, "src");
      await mkdir(subdirectory);
      await expectInspectionError(() => inspectRepository(subdirectory), "not_repository_root");
      await expectInspectionError(
        () => inspectRepository(join(directory, "missing")),
        "root_unavailable",
      );

      const worktree = join(directory, "linked");
      await runGit(root, ["worktree", "add", "--detach", worktree]);
      await expectInspectionError(() => inspectRepository(worktree), "linked_worktree");
    });
  });

  it("reports untracked and modified files as dirty", async () => {
    await withFixture(async ({ root }) => {
      await setOrigin(root, "https://github.com/Org/Repo");
      await writeFile(join(root, "README.md"), "changed\n", "utf8");
      await writeFile(join(root, "untracked.txt"), "untracked\n", "utf8");

      const inspection = await inspectRepository(root);

      expect(inspection.dirty).toBe(true);
    });
  });

  it("uses the commit at the explicitly changed origin default branch", async () => {
    await withFixture(async ({ root }) => {
      await runGit(root, ["checkout", "-b", "develop"]);
      await writeFile(join(root, "develop.txt"), "develop\n", "utf8");
      await runGit(root, ["add", "develop.txt"]);
      await runGit(root, ["commit", "-m", "develop"]);
      const developCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
      await runGit(root, ["push", "origin", "develop"]);
      await runGit(root, ["fetch", "origin", "develop"]);
      await runGit(root, ["update-ref", "refs/remotes/origin/develop", developCommit]);
      await runGit(root, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/develop",
      ]);
      await setOrigin(root, "https://github.com/Org/Repo");

      const inspection = await inspectRepository(root);

      expect(inspection.defaultBranch).toBe("develop");
      expect(inspection.baseCommit).toBe(developCommit);
    });
  });

  it("classifies Gitlink submodules", async () => {
    await withFixture(async ({ directory, root }) => {
      const subOrigin = join(directory, "sub-origin.git");
      const subRoot = join(directory, "sub-working");
      await runGit(directory, ["init", "--bare", subOrigin]);
      await runGit(directory, ["clone", subOrigin, subRoot]);
      await runGit(subRoot, ["config", "user.name", "Repository Inspector"]);
      await runGit(subRoot, ["config", "user.email", "inspector@example.test"]);
      await runGit(subRoot, ["checkout", "-b", "main"]);
      await writeFile(join(subRoot, "sub.txt"), "submodule\n", "utf8");
      await runGit(subRoot, ["add", "sub.txt"]);
      await runGit(subRoot, ["commit", "-m", "submodule"]);
      await runGit(subRoot, ["push", "origin", "main"]);
      await runGit(subOrigin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

      await runGit(root, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        subOrigin,
        "vendor/sub",
      ]);
      await runGit(root, ["add", ".gitmodules", "vendor/sub"]);
      await runGit(root, ["commit", "-m", "submodule link"]);
      await runGit(root, ["push", "origin", "main"]);
      await setOrigin(root, "https://github.com/Org/Repo");

      const inspection = await inspectRepository(root);

      expect(inspection.submodulePaths).toEqual(["vendor/sub"]);
      expect(inspection.nestedRepositoryPaths).toEqual(["vendor/sub"]);
    });
  });

  it("discovers LFS attributes without invoking git-lfs", async () => {
    await withFixture(async ({ root }) => {
      await mkdir(join(root, "assets"));
      await writeFile(
        join(root, ".gitattributes"),
        "assets/*.bin filter=lfs diff=lfs merge=lfs -text\n",
        "utf8",
      );
      await writeFile(join(root, "assets", "data.bin"), "large\n", "utf8");
      await runGit(root, ["add", ".gitattributes", "assets/data.bin"]);
      await runGit(root, ["commit", "-m", "lfs attributes"]);
      await runGit(root, ["push", "origin", "main"]);
      await setOrigin(root, "https://github.com/Org/Repo");

      const inspection = await inspectRepository(root);

      expect(inspection.lfsPaths).toEqual(["assets/data.bin"]);
    });
  });

  it("ignores inherited Git process state", async () => {
    await withFixture(async ({ root, baseCommit }) => {
      await setOrigin(root, "https://github.com/Org/Repo.git");
      const previousGitDirectory = process.env["GIT_DIR"];
      process.env["GIT_DIR"] = join(root, "missing-git-directory");
      try {
        const inspection = await inspectRepository(root);
        expect(inspection.baseCommit).toBe(baseCommit);
      } finally {
        if (previousGitDirectory === undefined) {
          delete process.env["GIT_DIR"];
        } else {
          process.env["GIT_DIR"] = previousGitDirectory;
        }
      }
    });
  });
  it("rejects a remote changed after the final Git probe captures its output", async () => {
    await withFixture(async ({ directory, root }) => {
      await setOrigin(root, "https://github.com/Org/Repo");
      const executable = "/usr/bin/git";
      await access(executable, constants.X_OK);
      const shimDirectory = join(directory, "shim");
      const shimPath = join(shimDirectory, "git");
      const counterPath = join(directory, "remote-probe-count");
      await mkdir(shimDirectory);
      await writeFile(
        shimPath,
        `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const result = spawnSync(process.env["MINIONS_REAL_GIT"], args);
if (args.includes("remote") && args.includes("get-url")) {
  let count = 0;
  try { count = Number(readFileSync(process.env["MINIONS_GIT_COUNTER"], "utf8")); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  count += 1;
  writeFileSync(process.env["MINIONS_GIT_COUNTER"], String(count));
  if (count === 2) {
    const changed = spawnSync(process.env["MINIONS_REAL_GIT"], ["-C", process.env["MINIONS_GIT_ROOT"], "remote", "set-url", "origin", "file:///tmp/unsafe"]);
    if (changed.status !== 0) process.exit(changed.status ?? 1);
  }
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
        "utf8",
      );
      await chmod(shimPath, 0o755);
      const previousPath = process.env["PATH"];
      process.env["PATH"] = `${shimDirectory}${delimiter}${previousPath ?? ""}`;
      process.env["MINIONS_REAL_GIT"] = executable;
      process.env["MINIONS_GIT_COUNTER"] = counterPath;
      process.env["MINIONS_GIT_ROOT"] = root;
      try {
        await expectInspectionError(() => inspectRepository(root), "inspection_failed");
      } finally {
        if (previousPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = previousPath;
        }
        delete process.env["MINIONS_REAL_GIT"];
        delete process.env["MINIONS_GIT_COUNTER"];
        delete process.env["MINIONS_GIT_ROOT"];
      }
    });
  });

  it("classifies nested git metadata without following symlink directories and cleans probes", async () => {
    await withFixture(async ({ root }) => {
      await setOrigin(root, "https://github.com/Org/Repo");
      await mkdir(join(root, "nested-file"));
      await writeFile(
        join(root, "nested-file", ".git"),
        "gitdir: ../.git/modules/nested-file\n",
        "utf8",
      );
      await mkdir(join(root, "nested-directory", ".git"), { recursive: true });
      const outside = await mkdtemp(join(tmpdir(), "minions-repository-inspector-outside-"));
      try {
        await mkdir(join(outside, "hidden", ".git"), { recursive: true });
        await symlink(join(outside, "hidden"), join(root, "linked-directory"), "dir");
        await mkdir(join(root, "nested-symlink"));
        await symlink(join(outside, "hidden", ".git"), join(root, "nested-symlink", ".git"), "dir");

        const inspection = await inspectRepository(root);

        expect(inspection.nestedRepositoryPaths).toEqual([
          "nested-directory",
          "nested-file",
          "nested-symlink",
        ]);
        const entries = await readdir(root);
        expect(entries.some((entry) => entry.startsWith(".minions-case-probe-"))).toBe(false);
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });
  });
  it("detects clean ignored bare repositories and case-folded Git metadata", async () => {
    await withFixture(async ({ root }) => {
      await setOrigin(root, "https://github.com/Org/Repo");
      await writeFile(join(root, ".gitignore"), "ignored-bare.git/\nnested-uppercase/\n", "utf8");
      await runGit(root, ["add", ".gitignore"]);
      await runGit(root, ["commit", "-m", "ignore nested repositories"]);
      await runGit(root, ["init", "--bare", "ignored-bare.git"]);
      await mkdir(join(root, "nested-uppercase", ".GIT"), { recursive: true });

      const inspection = await inspectRepository(root);

      expect(inspection.dirty).toBe(false);
      expect(inspection.nestedRepositoryPaths).toEqual([
        "ignored-bare.git",
        ...(inspection.caseSensitive ? [] : ["nested-uppercase"]),
      ]);
    });
  });

  it("rejects missing origins and unsafe origin identities", async () => {
    await withFixture(async ({ root }) => {
      await runGit(root, ["remote", "remove", "origin"]);
      const missingError = await expectInspectionError(
        () => inspectRepository(root),
        "remote_missing",
      );
      expect(missingError.cause).toBeDefined();
    });

    const unsafeRemotes = [
      "/tmp/local-origin",
      "file:///tmp/local-origin",
      "http://github.com/Org/Repo.git",
      "https://user:password@github.com/Org/Repo.git",
      "https://github.com/Org/Repo.git?token=secret",
      "ssh://user:password@github.com/Org/Repo.git",
      "git@github.com:Org/../Repo.git",
      "git@github.com:Org//Repo.git",
      "not-a-remote",
    ];
    for (const remote of unsafeRemotes) {
      await withFixture(async ({ root }) => {
        await setOrigin(root, remote);
        await expectInspectionError(() => inspectRepository(root), "remote_unsafe");
      });
    }
  });

  it("distinguishes missing default branches and invalid base commits", async () => {
    await withFixture(async ({ root }) => {
      await setOrigin(root, "https://github.com/Org/Repo");
      await runGit(root, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
      await expectInspectionError(() => inspectRepository(root), "default_branch_missing");
    });

    await withFixture(async ({ root }) => {
      await setOrigin(root, "https://github.com/Org/Repo");
      await runGit(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
      await expectInspectionError(() => inspectRepository(root), "base_commit_invalid");
    });
  });

  it("reports a failed Git probe as inspection_failed with its cause", async () => {
    await withFixture(async ({ root }) => {
      await setOrigin(root, "https://github.com/Org/Repo");
      const indexPath = join(root, ".git", "index");
      const backupPath = join(root, ".git", "index.backup");
      await rename(indexPath, backupPath);
      await mkdir(indexPath);
      try {
        const error = await expectInspectionError(
          () => inspectRepository(root),
          "inspection_failed",
        );
        expect(error.cause).toBeDefined();
      } finally {
        await rm(indexPath, { force: true, recursive: true });
        await rename(backupPath, indexPath);
      }
    });
  });
});
