import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitFixtureRepo {
  readonly directory: string;
  readonly root: string;
  readonly baseCommit: string;
}

export interface NonRepositoryFixture {
  readonly root: string;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
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

export async function createGitFixtureRepo(
  namePrefix = "minions-e2e-repo-",
): Promise<GitFixtureRepo> {
  const directory = await mkdtemp(join(tmpdir(), namePrefix));
  const origin = join(directory, "origin.git");
  const root = join(directory, "working");
  try {
    await runGit(directory, ["init", "--bare", origin]);
    await runGit(directory, ["clone", origin, root]);
    await runGit(root, ["config", "user.name", "Minions E2E Test"]);
    await runGit(root, ["config", "user.email", "e2e@example.test"]);
    await runGit(root, ["checkout", "-b", "main"]);
    await mkdir(join(root, ".minions"), { recursive: true });
    await writeFile(
      join(root, ".minions", "gates.yaml"),
      'required_categories:\n  - lint\ngates:\n  lint:\n    executable: "true"\n',
      "utf8",
    );
    await writeFile(join(root, "README.md"), "minions e2e fixture\n", "utf8");
    await runGit(root, ["add", "README.md", ".minions/gates.yaml"]);
    await runGit(root, ["commit", "-m", "initial"]);
    await runGit(root, ["push", "--set-upstream", "origin", "main"]);
    await runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await runGit(root, ["fetch", "origin"]);
    await runGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const baseCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    await runGit(root, ["remote", "set-url", "origin", "https://github.com/Minions/e2e-fixture"]);
    return { directory, root, baseCommit };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

export async function createNonRepositoryFixture(
  namePrefix = "minions-e2e-nonrepo-",
): Promise<NonRepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), namePrefix));
  return { root };
}

export async function removeFixture(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
