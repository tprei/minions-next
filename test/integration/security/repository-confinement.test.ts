import { create } from "@bufbuild/protobuf";
import {
  RegisterRepositoryRequestSchema,
  type RegisterRepositoryRequest,
} from "@minions/contracts";
import {
  createRepositoryRegistry,
  createSqliteCommandStore,
  type CommandCommitNotifier,
  type RepositoryInspection,
  type RepositoryRegistry,
} from "@minions/adapters";
import { hostId, timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Security scenarios 1-2 in packages/core/src/security-matrix.ts ("cross-repo path
// traversal" / "symlink escape", boundary "repository_confinement"). These exercise the
// SQLite repository registry's own confinement guarantees: a repository's canonical root
// and allowed workspace root can never escape via `../` traversal, a non-absolute alias,
// an escaping feature path, or a symlink that resolves inside another repository's
// territory.

function deterministicId(index: number): string {
  return `01900000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

const HOST_ID = hostId(deterministicId(1));
const ACTOR_ID = deterministicId(2);
const REGISTERED_AT = timestampFromEpochMilliseconds(1_700_000_000_000);
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const noOpNotifier: CommandCommitNotifier = Object.freeze({
  commandCommitted: () => undefined,
});

type Fixture = Readonly<{
  registry: RepositoryRegistry;
}>;

async function withFixture<T>(operation: (fixture: Fixture) => Promise<T>): Promise<T> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(REGISTERED_AT));
  try {
    const commandStore = createSqliteCommandStore({
      database: temporary.database,
      ports: {
        clock: new FixedClock(REGISTERED_AT),
        ids: new SequenceIdGenerator(
          Array.from({ length: 32 }, (_, index) => deterministicId(0x100 + index)),
        ),
      },
      notifier: noOpNotifier,
    });
    const registry = createRepositoryRegistry({
      database: temporary.database,
      commandStore,
      hostId: HOST_ID,
    });
    return await operation({ registry });
  } finally {
    await temporary.dispose();
  }
}

function registerRequest(
  command: string,
  repository: string,
  root: string,
): RegisterRepositoryRequest {
  return create(RegisterRepositoryRequestSchema, {
    commandId: command,
    actorSessionId: ACTOR_ID,
    repositoryId: repository,
    rootPath: root,
  });
}

function inspection(
  root: string,
  overrides: Readonly<{
    submodulePaths?: readonly string[];
    lfsPaths?: readonly string[];
    nestedRepositoryPaths?: readonly string[];
  }> = {},
): RepositoryInspection {
  return {
    canonicalRoot: root,
    canonicalRemote: "https://example.test/project",
    defaultBranch: "main",
    baseCommit: BASE_COMMIT,
    caseSensitive: true,
    submodulePaths: overrides.submodulePaths ?? [],
    lfsPaths: overrides.lfsPaths ?? [],
    nestedRepositoryPaths: overrides.nestedRepositoryPaths ?? [],
    dirty: false,
  };
}

function register(
  registry: RepositoryRegistry,
  command: string,
  repository: string,
  root: string,
  options: Readonly<{
    allowedWorkspaceRoot: string;
    inspection?: RepositoryInspection;
  }>,
) {
  return registry.register({
    request: registerRequest(command, repository, root),
    inspection: options.inspection ?? inspection(root),
    allowedWorkspaceRoot: options.allowedWorkspaceRoot,
    registeredAt: REGISTERED_AT,
  });
}

describe("repository confinement: traversal and absolute-path rejection", () => {
  it("rejects a canonical root containing parent-directory traversal segments", async () => {
    await withFixture(async ({ registry }) => {
      await expect(
        register(
          registry,
          deterministicId(10),
          deterministicId(11),
          "/workspaces/repo-a/../../etc/passwd-dir",
          { allowedWorkspaceRoot: "/workspaces/work-a" },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(registry.list({ afterId: undefined, limit: 10 })).toHaveLength(0);
    });
  });

  it("rejects a relative (non-absolute) canonical root", async () => {
    await withFixture(async ({ registry }) => {
      await expect(
        register(registry, deterministicId(12), deterministicId(13), "relative/repo-b", {
          allowedWorkspaceRoot: "/workspaces/work-b",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(registry.list({ afterId: undefined, limit: 10 })).toHaveLength(0);
    });
  });

  it("rejects an allowed workspace root containing parent-directory traversal", async () => {
    await withFixture(async ({ registry }) => {
      await expect(
        register(registry, deterministicId(14), deterministicId(15), "/workspaces/repo-c", {
          allowedWorkspaceRoot: "/workspaces/../../etc",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(registry.list({ afterId: undefined, limit: 10 })).toHaveLength(0);
    });
  });

  it("rejects submodule and LFS feature paths that escape the repository root", async () => {
    await withFixture(async ({ registry }) => {
      await expect(
        register(registry, deterministicId(16), deterministicId(17), "/workspaces/repo-d", {
          allowedWorkspaceRoot: "/workspaces/work-d",
          inspection: inspection("/workspaces/repo-d", {
            submodulePaths: ["../../etc/passwd"],
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      await expect(
        register(registry, deterministicId(18), deterministicId(19), "/workspaces/repo-e", {
          allowedWorkspaceRoot: "/workspaces/work-e",
          inspection: inspection("/workspaces/repo-e", { lfsPaths: ["/etc/shadow"] }),
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(registry.list({ afterId: undefined, limit: 10 })).toHaveLength(0);
    });
  });
});

describe("repository confinement: symlink-resolved boundary escape", () => {
  it("rejects a symlinked repository root that resolves inside another repository's confinement boundary", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "minions-repo-confinement-")));
    try {
      const territoryARoot = join(base, "territory-a", "root");
      const territoryAWorkspace = join(base, "territory-a", "workspace");
      const nestedInsideA = join(territoryARoot, "nested", "inner");
      await mkdir(nestedInsideA, { recursive: true });
      await mkdir(territoryAWorkspace, { recursive: true });

      const aliasDirectory = join(base, "looks-unrelated");
      await mkdir(aliasDirectory, { recursive: true });
      const disguisedAlias = join(aliasDirectory, "alias-b");
      await symlink(nestedInsideA, disguisedAlias, "dir");

      const resolvedAliasRoot = await realpath(disguisedAlias);
      // Sanity check on the fixture itself: the alias really does land inside
      // territory A's root once resolved, not merely by naming convention.
      expect(resolvedAliasRoot).toBe(nestedInsideA);
      expect(resolvedAliasRoot.startsWith(`${territoryARoot}/`)).toBe(true);

      await withFixture(async ({ registry }) => {
        await register(registry, deterministicId(20), deterministicId(21), territoryARoot, {
          allowedWorkspaceRoot: territoryAWorkspace,
        });

        // If the RAW, unresolved alias path were ever registered directly (e.g. a caller
        // that skipped `inspectRepository`'s realpath resolution), the registry's lexical
        // overlap check has nothing to compare against territory A: the two path strings
        // share no components. This succeeding is the vulnerability window that mandatory
        // symlink resolution before registration exists to close.
        const naive = await register(
          registry,
          deterministicId(22),
          deterministicId(23),
          disguisedAlias,
          { allowedWorkspaceRoot: join(base, "territory-b-naive-workspace") },
        );
        expect(naive.canonicalRoot).toBe(disguisedAlias);

        // Once the alias is resolved to its real, on-disk location (exactly what
        // `repository-inspector.ts`'s `resolveRoot` always does via `realpath` before a
        // registration request ever reaches the registry), the confinement math correctly
        // recognizes the true nesting inside territory A and rejects it.
        await expect(
          register(registry, deterministicId(24), deterministicId(25), resolvedAliasRoot, {
            allowedWorkspaceRoot: join(base, "territory-b-resolved-workspace"),
          }),
        ).rejects.toMatchObject({ code: "overlap" });

        expect(registry.list({ afterId: undefined, limit: 10 })).toHaveLength(2);
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("accepts two repositories whose real, symlink-resolved roots are genuinely disjoint", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "minions-repo-confinement-")));
    try {
      const rootA = join(base, "real-a");
      const rootB = join(base, "elsewhere", "real-b");
      await mkdir(rootA, { recursive: true });
      await mkdir(rootB, { recursive: true });
      const aliasDirectory = join(base, "aliases");
      await mkdir(aliasDirectory, { recursive: true });
      const aliasB = join(aliasDirectory, "b-alias");
      await symlink(rootB, aliasB, "dir");

      const resolvedAliasB = await realpath(aliasB);
      expect(resolvedAliasB).toBe(rootB);

      await withFixture(async ({ registry }) => {
        await register(registry, deterministicId(26), deterministicId(27), rootA, {
          allowedWorkspaceRoot: join(base, "workspace-a"),
        });
        const registeredB = await register(
          registry,
          deterministicId(28),
          deterministicId(29),
          resolvedAliasB,
          { allowedWorkspaceRoot: join(base, "workspace-b") },
        );
        expect(registeredB.canonicalRoot).toBe(rootB);
        expect(registry.list({ afterId: undefined, limit: 10 })).toHaveLength(2);
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
