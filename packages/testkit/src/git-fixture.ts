import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export type GitFixtureOptions = Readonly<{
  prefix?: string;
  branch?: string;
  objectFormat?: "sha1" | "sha256";
}>;

export interface GitFixture {
  readonly directory: string;
  readonly root: string;
  readonly origin: string;
  readonly branch: string;
  readonly baseCommit: string;
  git(arguments_: readonly string[], workingDirectory?: string): Promise<string>;
  write(relativePath: string, content: string | Uint8Array): Promise<void>;
  commit(files: Readonly<Record<string, string>>, message?: string): Promise<string>;
  checkout(branch: string, create?: boolean): Promise<void>;
  read(relativePath: string): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export async function createGitFixture(options: GitFixtureOptions = {}): Promise<GitFixture> {
  const branch = options.branch ?? "main";
  const objectFormat = options.objectFormat ?? "sha1";
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), options.prefix ?? "minions-git-fixture-")),
  );
  const root = join(directory, "source");
  const origin = join(directory, "origin.git");
  let disposed = false;
  try {
    await gitCommand(["init", `--object-format=${objectFormat}`, "--bare", origin], directory);
    await gitCommand(
      ["init", `--object-format=${objectFormat}`, `--initial-branch=${branch}`, root],
      directory,
    );
    await gitCommand(["config", "user.name", "Minions Test"], root);
    await gitCommand(["config", "user.email", "minions-test@example.invalid"], root);
    await writeFile(join(root, "README.md"), "base\n");
    await gitCommand(["add", "--", "README.md"], root);
    await gitCommand(["commit", "--no-gpg-sign", "-m", "base"], root);
    await gitCommand(["remote", "add", "origin", origin], root);
    await gitCommand(["push", "--no-verify", "origin", `HEAD:refs/heads/${branch}`], root);
    await gitCommand(["symbolic-ref", "HEAD", `refs/heads/${branch}`], origin);
    await gitCommand(["remote", "set-head", "origin", "-a"], root);
    await gitCommand(["remote", "set-url", "origin", "https://example.invalid/minions.git"], root);
    const baseCommit = await gitCommand(["rev-parse", "HEAD"], root);

    const fixture: GitFixture = {
      directory,
      root,
      origin,
      branch,
      baseCommit,
      git: (arguments_, workingDirectory = root) => gitCommand(arguments_, workingDirectory),
      write: async (relativePath, content) => {
        await writeFile(join(root, relativePath), content);
      },
      commit: async (files, message = "change") => {
        for (const [relativePath, content] of Object.entries(files)) {
          await writeFile(join(root, relativePath), content);
        }
        await gitCommand(["add", "--all", "--", ...Object.keys(files)], root);
        await gitCommand(["commit", "--no-gpg-sign", "-m", message], root);
        return gitCommand(["rev-parse", "HEAD"], root);
      },
      checkout: async (requestedBranch, create = false) => {
        await gitCommand(
          create
            ? ["checkout", "--force", "-b", requestedBranch]
            : ["checkout", "--force", requestedBranch],
          root,
        );
      },
      read: async (relativePath) => new Uint8Array(await readFile(join(root, relativePath))),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
    return Object.freeze(fixture);
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function gitCommand(
  arguments_: readonly string[],
  workingDirectory: string,
): Promise<string> {
  const result = await executeFile("git", [...arguments_], {
    cwd: workingDirectory,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Minions Test",
      GIT_AUTHOR_EMAIL: "minions-test@example.invalid",
      GIT_COMMITTER_NAME: "Minions Test",
      GIT_COMMITTER_EMAIL: "minions-test@example.invalid",
    },
  });
  return result.stdout.trim();
}
