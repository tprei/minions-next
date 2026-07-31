import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { RegisterRepositoryRequestSchema } from "@minions/contracts";
import {
  createEventCommitWaiter,
  createNodeGitProcess,
  createRepositoryRegistry,
  createSqliteCommandStore,
  createSqliteGitMutationLeaseStore,
  createSqliteWorkspaceRegistry,
  createWorkspaceManager,
  inspectRepository,
  type EventCommitWaiter,
  type RepositoryRegistration,
  type WorkspaceCreateInput,
  type WorkspaceManager,
} from "@minions/adapters";
import {
  attemptId,
  hostId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type GitProcess,
  type GitProcessRequest,
} from "@minions/core";
import { createGitFixture, FixedClock, SequenceIdGenerator } from "@minions/testkit";
import type { GitFixture } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLOCK = new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000));
const HOST_ID = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY_ID = repositoryId("01900000-0000-7000-8000-000000000002");
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000003");
const PLAN_REVISION_ID = "01900000-0000-7000-8000-000000000004";
const PARENT_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000005");
const CHILD_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000006");
const PARENT_ATTEMPT_ID = attemptId("01900000-0000-7000-8000-000000000007");
const CHILD_ATTEMPT_ID = attemptId("01900000-0000-7000-8000-000000000008");
const COMMAND_ID = "01900000-0000-7000-8000-000000000009";
const ACTOR_SESSION_ID = "01900000-0000-7000-8000-00000000000a";
const OWNER_ID = "01900000-0000-7000-8000-00000000000b";

let activeContext: WorkspaceSecurityContext | undefined;

afterEach(async () => {
  await activeContext?.dispose();
  activeContext = undefined;
});

describe("workspace security regressions", () => {
  it("creates a SHA-256 source clone with the matching object format", async () => {
    const context = await createWorkspaceSecurityContext({ objectFormat: "sha256" });
    const receipt = await context.manager.create(context.parentInput);

    expect(context.fixture.baseCommit).toHaveLength(64);
    expect(receipt.baseCommit).toHaveLength(64);
    expect(receipt.headCommit).toBe(context.fixture.baseCommit);
    await expect(
      context.fixture.git(["rev-parse", "--show-object-format"], receipt.workspacePath),
    ).resolves.toBe("sha256");
    await expect(
      readFile(join(receipt.workspacePath, ".git", "config"), "utf8"),
    ).resolves.not.toContain("remote");
  }, 30_000);

  it("preserves the final collision sentinel on first create", async () => {
    const context = await createWorkspaceSecurityContext();
    await mkdir(context.allowedWorkspaceRoot, { recursive: true });
    const finalPath = join(context.allowedWorkspaceRoot, context.parentInput.attemptId);
    const sentinelPath = join(finalPath, "sentinel.txt");
    await mkdir(finalPath);
    await writeFile(sentinelPath, "final sentinel\n");

    await expect(context.manager.create(context.parentInput)).rejects.toMatchObject({
      code: "workspace_exists",
    });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("final sentinel\n");
    await expect(
      lstat(join(context.allowedWorkspaceRoot, `${context.parentInput.attemptId}.creating`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("preserves the staging collision sentinel on first create", async () => {
    const context = await createWorkspaceSecurityContext();
    await mkdir(context.allowedWorkspaceRoot, { recursive: true });
    const stagingPath = join(
      context.allowedWorkspaceRoot,
      `${context.parentInput.attemptId}.creating`,
    );
    const sentinelPath = join(stagingPath, "sentinel.txt");
    await mkdir(stagingPath);
    await writeFile(sentinelPath, "staging sentinel\n");

    await expect(context.manager.create(context.parentInput)).rejects.toMatchObject({
      code: "workspace_exists",
    });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("staging sentinel\n");
    await expect(
      lstat(join(context.allowedWorkspaceRoot, context.parentInput.attemptId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("rejects an allowed workspace root symlink without mutating its target", async () => {
    const context = await createWorkspaceSecurityContext();
    const externalRoot = join(context.fixture.directory, "external-root");
    const sentinelPath = join(externalRoot, "sentinel.txt");
    await mkdir(externalRoot);
    await writeFile(sentinelPath, "root sentinel\n");
    await symlink(externalRoot, context.allowedWorkspaceRoot);

    await expect(context.manager.create(context.parentInput)).rejects.toMatchObject({
      code: "path_invalid",
    });
    expect((await lstat(context.allowedWorkspaceRoot)).isSymbolicLink()).toBe(true);
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("root sentinel\n");
  }, 20_000);

  it("rejects a final workspace symlink without mutating its target", async () => {
    const context = await createWorkspaceSecurityContext();
    const externalRoot = join(context.fixture.directory, "external-final");
    const sentinelPath = join(externalRoot, "sentinel.txt");
    const finalPath = join(context.allowedWorkspaceRoot, context.parentInput.attemptId);
    await mkdir(externalRoot);
    await writeFile(sentinelPath, "final symlink sentinel\n");
    await mkdir(context.allowedWorkspaceRoot, { recursive: true });
    await symlink(externalRoot, finalPath);

    await expect(context.manager.create(context.parentInput)).rejects.toMatchObject({
      code: "workspace_exists",
    });
    expect((await lstat(finalPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("final symlink sentinel\n");
  }, 20_000);

  it("rejects a staging workspace symlink without mutating its target", async () => {
    const context = await createWorkspaceSecurityContext();
    const externalRoot = join(context.fixture.directory, "external-staging");
    const sentinelPath = join(externalRoot, "sentinel.txt");
    const stagingPath = join(
      context.allowedWorkspaceRoot,
      `${context.parentInput.attemptId}.creating`,
    );
    await mkdir(externalRoot);
    await writeFile(sentinelPath, "staging symlink sentinel\n");
    await mkdir(context.allowedWorkspaceRoot, { recursive: true });
    await symlink(externalRoot, stagingPath);

    await expect(context.manager.create(context.parentInput)).rejects.toMatchObject({
      code: "workspace_exists",
    });
    expect((await lstat(stagingPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("staging symlink sentinel\n");
  }, 20_000);

  for (const tamper of [
    "objects",
    "refs",
    "branch",
    "HEAD",
    "index",
    "config.worktree",
    "packed-refs",
  ] as const) {
    it(`rejects post-create ${tamper} symlink tampering for capture and replay`, async () => {
      const context = await createWorkspaceSecurityContext();
      const receipt = await context.manager.create(context.parentInput);
      const externalRoot = join(context.fixture.directory, `external-${tamper}`);
      const sentinelPath = join(externalRoot, "sentinel.txt");
      await mkdir(externalRoot);
      await writeFile(sentinelPath, `${tamper} sentinel\n`);

      if (tamper === "objects" || tamper === "refs") {
        const metadataPath = join(receipt.workspacePath, ".git", tamper);
        await rename(metadataPath, `${metadataPath}.original`);
        await symlink(externalRoot, metadataPath);
      } else {
        const metadataPath =
          tamper === "branch"
            ? join(receipt.workspacePath, ".git", "refs", "heads", ...receipt.branchName.split("/"))
            : join(receipt.workspacePath, ".git", tamper);
        await rm(metadataPath, { force: true });
        await symlink(sentinelPath, metadataPath);
      }

      await expect(
        context.manager.captureStatus({ attemptId: receipt.attemptId }),
      ).rejects.toMatchObject({ code: "workspace_invalid" });
      await expect(context.manager.create(context.parentInput)).rejects.toMatchObject({
        code: "workspace_invalid",
      });
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe(`${tamper} sentinel\n`);
    }, 30_000);
  }

  it("does not execute a hostile core.fsmonitor configuration", async () => {
    const context = await createWorkspaceSecurityContext();
    const receipt = await context.manager.create(context.parentInput);
    const externalRoot = join(context.fixture.directory, "external-fsmonitor");
    const markerPath = join(externalRoot, "marker");
    const scriptPath = join(externalRoot, "fsmonitor.sh");
    await mkdir(externalRoot);
    await writeFile(scriptPath, `#!/bin/sh\nprintf executed > ${markerPath}\nprintf 0\n`, {
      mode: 0o755,
    });
    await chmod(scriptPath, 0o755);
    await appendGitConfig(
      join(receipt.workspacePath, ".git", "config"),
      `[core]\n\tfsmonitor = !${scriptPath}\n`,
    );

    await expect(
      context.manager.captureStatus({ attemptId: receipt.attemptId }),
    ).resolves.toMatchObject({ attemptId: receipt.attemptId });
    await expect(context.manager.create(context.parentInput)).resolves.toEqual(receipt);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("does not execute a hostile textconv configuration", async () => {
    const context = await createWorkspaceSecurityContext();
    const receipt = await context.manager.create(context.parentInput);
    const externalRoot = join(context.fixture.directory, "external-textconv");
    const markerPath = join(externalRoot, "marker");
    const scriptPath = join(externalRoot, "textconv.sh");
    await mkdir(externalRoot);
    await writeFile(scriptPath, `#!/bin/sh\nprintf executed > ${markerPath}\ncat\n`, {
      mode: 0o755,
    });
    await chmod(scriptPath, 0o755);
    await appendGitConfig(
      join(receipt.workspacePath, ".git", "config"),
      `[diff "hostile"]\n\ttextconv = !${scriptPath}\n`,
    );
    await writeFile(join(receipt.workspacePath, ".gitattributes"), "README.md diff=hostile\n");
    await writeFile(join(receipt.workspacePath, "README.md"), "hostile change\n");

    await expect(
      context.manager.captureStatus({ attemptId: receipt.attemptId }),
    ).resolves.toMatchObject({ attemptId: receipt.attemptId });
    await expect(context.manager.create(context.parentInput)).resolves.toEqual(receipt);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("does not execute a hostile clean filter during status capture", async () => {
    const context = await createWorkspaceSecurityContext();
    const receipt = await context.manager.create(context.parentInput);
    const externalRoot = join(context.fixture.directory, "external-clean-filter");
    const markerPath = join(externalRoot, "marker");
    const scriptPath = join(externalRoot, "clean.sh");
    await mkdir(externalRoot);
    await writeFile(scriptPath, `#!/bin/sh\nprintf executed > ${markerPath}\ncat\n`, {
      mode: 0o755,
    });
    await chmod(scriptPath, 0o755);
    await appendGitConfig(
      join(receipt.workspacePath, ".git", "config"),
      "[extensions]\n\tworktreeConfig = true\n",
    );
    await writeFile(
      join(receipt.workspacePath, ".git", "config.worktree"),
      `[filter "hostile"]\n\tclean = ${scriptPath}\n`,
    );
    await writeFile(join(receipt.workspacePath, ".gitattributes"), "README.md filter=hostile\n");
    await writeFile(join(receipt.workspacePath, "README.md"), "hostile change\n");

    await expect(
      context.manager.captureStatus({ attemptId: receipt.attemptId }),
    ).resolves.toMatchObject({ attemptId: receipt.attemptId });
    await expect(context.manager.create(context.parentInput)).resolves.toEqual(receipt);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("does not execute a hostile clean filter while snapshotting the source", async () => {
    const context = await createWorkspaceSecurityContext();
    const externalRoot = join(context.fixture.directory, "external-source-clean-filter");
    const markerPath = join(externalRoot, "marker");
    const scriptPath = join(externalRoot, "clean.sh");
    await mkdir(externalRoot);
    await writeFile(scriptPath, `#!/bin/sh\nprintf executed > ${markerPath}\ncat\n`, {
      mode: 0o755,
    });
    await chmod(scriptPath, 0o755);
    await appendGitConfig(
      join(context.fixture.root, ".git", "config"),
      `[filter "hostile"]\n\tclean = ${scriptPath}\n`,
    );
    await writeFile(join(context.fixture.root, ".gitattributes"), "README.md filter=hostile\n");
    await writeFile(join(context.fixture.root, "README.md"), "hostile source change\n");

    // captureSourceSnapshot's status call is what previously ran the filter -
    // create() invokes it while inspecting the source before cloning.
    await context.manager.create(context.parentInput);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects a source with objects/info/alternates instead of importing external objects", async () => {
    const context = await createWorkspaceSecurityContext();
    await mkdir(join(context.fixture.root, ".git", "objects", "info"), { recursive: true });
    await writeFile(
      join(context.fixture.root, ".git", "objects", "info", "alternates"),
      "/tmp/some-external-object-database\n",
    );

    await expect(context.manager.create(context.parentInput)).rejects.toMatchObject({
      code: "source_invalid",
    });
  }, 30_000);

  it("rejects a hostile core.worktree configuration without writing outside", async () => {
    const context = await createWorkspaceSecurityContext();
    const receipt = await context.manager.create(context.parentInput);
    const externalRoot = join(context.fixture.directory, "external-worktree");
    await mkdir(externalRoot);
    await appendGitConfig(
      join(receipt.workspacePath, ".git", "config"),
      `[core]\n\tworktree = ${externalRoot}\n`,
    );

    await expect(
      context.manager.captureStatus({ attemptId: receipt.attemptId }),
    ).rejects.toMatchObject({ code: "workspace_invalid" });
    await expect(context.manager.create(context.parentInput)).rejects.toMatchObject({
      code: "workspace_invalid",
    });
    await expect(lstat(join(externalRoot, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("keeps a ready child usable after its parent is cleaned", async () => {
    const context = await createWorkspaceSecurityContext();
    const parent = await context.manager.create(context.parentInput);
    const childInput: WorkspaceCreateInput = {
      ...context.childInput,
      baseCommit: parent.headCommit,
      sourcePath: parent.workspacePath,
      sourceAttemptId: parent.attemptId,
    };
    const child = await context.manager.create(childInput);

    await expect(context.manager.cleanup({ attemptId: parent.attemptId })).resolves.toMatchObject({
      state: "cleaned",
    });
    await expect(lstat(parent.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      context.manager.captureStatus({ attemptId: child.attemptId }),
    ).resolves.toMatchObject({ attemptId: child.attemptId, headCommit: child.headCommit });
    await expect(context.manager.create(childInput)).resolves.toEqual(child);
  }, 30_000);

  it("replays a ready workspace after the source HEAD advances", async () => {
    const context = await createWorkspaceSecurityContext();
    const receipt = await context.manager.create(context.parentInput);
    const advancedHead = await context.fixture.commit(
      { "README.md": "source advanced\n" },
      "advance source",
    );

    expect(advancedHead).not.toBe(receipt.headCommit);
    await expect(context.manager.create(context.parentInput)).resolves.toEqual(receipt);
    await expect(context.fixture.git(["rev-parse", "HEAD"], context.fixture.root)).resolves.toBe(
      advancedHead,
    );
  }, 30_000);

  it("preserves source index identity and content plus status, refs, and object counts", async () => {
    const trace: GitTraceEntry[] = [];
    const context = await createWorkspaceSecurityContext({
      observeGit: (entry) => {
        trace.push(entry);
      },
    });
    const beforeFacts = await captureSourceFacts(context.fixture);
    const beforeIndex = await captureSourceIndexByRoot(context.fixture.root);
    expect(trace).toHaveLength(0);

    await context.manager.create(context.parentInput);
    const afterIndex = await captureSourceIndexByRoot(context.fixture.root);
    const afterFacts = await captureSourceFacts(context.fixture);
    const firstManagerChange = trace.find((entry) => !sameIndex(entry.before, entry.after));
    expect(firstManagerChange?.arguments ?? []).toEqual([]);
    expect(afterIndex.identity).toEqual(beforeIndex.identity);
    expect(afterIndex.digest).toBe(beforeIndex.digest);
    expect(afterIndex.bytes).toEqual(beforeIndex.bytes);
    expect(afterFacts.status).toBe(beforeFacts.status);
    expect(afterFacts.refs).toBe(beforeFacts.refs);
    expect(afterFacts.count).toBe(beforeFacts.count);
  }, 30_000);
});

type WorkspaceSecurityContext = Readonly<{
  fixture: GitFixture;
  database: TemporarySqliteDatabase;
  manager: WorkspaceManager;
  repository: RepositoryRegistration;
  allowedWorkspaceRoot: string;
  parentInput: WorkspaceCreateInput;
  childInput: WorkspaceCreateInput;
  dispose(): Promise<void>;
}>;

async function createWorkspaceSecurityContext(
  options: {
    readonly objectFormat?: "sha1" | "sha256";
    readonly observeGit?: (entry: GitTraceEntry) => void;
  } = {},
): Promise<WorkspaceSecurityContext> {
  let fixture: GitFixture | undefined;
  let database: TemporarySqliteDatabase | undefined;
  let notifier: EventCommitWaiter | undefined;
  try {
    fixture = await createGitFixture({
      ...(options.objectFormat === undefined ? {} : { objectFormat: options.objectFormat }),
    });
    const sourceRoot = fixture.root;
    database = await TemporarySqliteDatabase.create("host", CLOCK);
    notifier = createEventCommitWaiter();
    const commandStore = createSqliteCommandStore({
      database: database.database,
      ports: {
        clock: CLOCK,
        ids: new SequenceIdGenerator([COMMAND_ID]),
      },
      notifier,
    });
    const repositoryRegistry = createRepositoryRegistry({
      database: database.database,
      commandStore,
      hostId: HOST_ID,
    });
    const allowedWorkspaceRoot = join(fixture.directory, "workspaces");
    const repository = await repositoryRegistry.register({
      request: create(RegisterRepositoryRequestSchema, {
        commandId: COMMAND_ID,
        actorSessionId: ACTOR_SESSION_ID,
        repositoryId: REPOSITORY_ID,
        rootPath: fixture.root,
      }),
      inspection: await inspectRepository(fixture.root),
      allowedWorkspaceRoot,
      registeredAt: CLOCK.now(),
    });
    await seedWorkspaceDomain(database, repository);
    const workspaceRegistry = createSqliteWorkspaceRegistry({ database: database.database });
    const leaseStore = createSqliteGitMutationLeaseStore({ database: database.database });
    const realGit = createNodeGitProcess();
    const git: GitProcess =
      options.observeGit === undefined
        ? realGit
        : {
            run: async (request: GitProcessRequest) => {
              const before = await captureSourceIndexByRoot(sourceRoot);
              const result = await realGit.run(request);
              const after = await captureSourceIndexByRoot(sourceRoot);
              options.observeGit?.({
                arguments: [...request.arguments],
                before,
                after,
              });
              return result;
            },
          };
    const manager = createWorkspaceManager({
      git,
      workspaceRegistry,
      repositoryRegistry,
      gitMutationLeaseStore: leaseStore,
      clock: CLOCK,
      ownerId: OWNER_ID,
      timeoutMs: 5_000,
      leaseDurationMs: 160_000,
      leaseWaitTimeoutMs: 5_000,
      leasePollIntervalMs: 1,
    });
    const parentInput: WorkspaceCreateInput = {
      attemptId: PARENT_ATTEMPT_ID,
      nodeId: PARENT_NODE_ID,
      treeId: TREE_ID,
      hostId: HOST_ID,
      repositoryId: REPOSITORY_ID,
      ordinal: 1,
      baseCommit: repository.baseCommit,
    };
    const childInput: WorkspaceCreateInput = {
      attemptId: CHILD_ATTEMPT_ID,
      nodeId: CHILD_NODE_ID,
      treeId: TREE_ID,
      hostId: HOST_ID,
      repositoryId: REPOSITORY_ID,
      ordinal: 1,
      baseCommit: repository.baseCommit,
    };
    const context: WorkspaceSecurityContext = {
      fixture,
      database,
      manager,
      repository,
      allowedWorkspaceRoot,
      parentInput,
      childInput,
      dispose: async () => {
        notifier?.close();
        notifier = undefined;
        await database?.dispose();
        database = undefined;
        await fixture?.dispose();
        fixture = undefined;
      },
    };
    activeContext = context;
    return context;
  } catch (error: unknown) {
    notifier?.close();
    await database?.dispose();
    await fixture?.dispose();
    throw error;
  }
}

async function seedWorkspaceDomain(
  database: TemporarySqliteDatabase,
  repository: RepositoryRegistration,
): Promise<void> {
  await database.database.write((transaction) => {
    transaction.run(
      `INSERT INTO trees (
         id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
         root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      [
        TREE_ID,
        repository.id,
        repository.hostId,
        repository.baseCommit,
        "workspace security regressions",
        PLAN_REVISION_ID,
        PARENT_NODE_ID,
        CLOCK.now(),
        CLOCK.now(),
      ],
    );
    transaction.run(
      `INSERT INTO plan_revisions (
         id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
         approved_at_ms, superseded_at_ms
       ) VALUES (?, ?, 1, ?, 'approved', 0, ?, ?, NULL)`,
      [PLAN_REVISION_ID, TREE_ID, "workspace security regressions", CLOCK.now(), CLOCK.now()],
    );
    transaction.run(
      `INSERT INTO nodes (
         id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
         mode, objective, output_kind, output_artifact_id, output_artifact_type,
         state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
         blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
         outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
         outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
         version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, NULL, ?, 'implementation', ?, 'implementation', NULL, NULL,
         'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, 0, ?, ?)`,
      [
        PARENT_NODE_ID,
        TREE_ID,
        repository.id,
        repository.hostId,
        PLAN_REVISION_ID,
        "workspace security parent",
        CLOCK.now(),
        CLOCK.now(),
      ],
    );
    transaction.run(
      `INSERT INTO nodes (
         id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
         mode, objective, output_kind, output_artifact_id, output_artifact_type,
         state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
         blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
         outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
         outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
         version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 'implementation', ?, 'implementation', NULL, NULL,
         'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, 0, ?, ?)`,
      [
        CHILD_NODE_ID,
        TREE_ID,
        repository.id,
        repository.hostId,
        PARENT_NODE_ID,
        PLAN_REVISION_ID,
        "workspace security child",
        CLOCK.now(),
        CLOCK.now(),
      ],
    );
    transaction.run(
      `INSERT INTO attempts (
         id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
         state_kind, version, started_at_ms, finished_at_ms, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 0, ?, NULL, NULL)`,
      [
        PARENT_ATTEMPT_ID,
        PARENT_NODE_ID,
        TREE_ID,
        repository.id,
        repository.hostId,
        PLAN_REVISION_ID,
        CLOCK.now(),
      ],
    );
    transaction.run(
      `INSERT INTO attempts (
         id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
         state_kind, version, started_at_ms, finished_at_ms, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 0, ?, NULL, NULL)`,
      [
        CHILD_ATTEMPT_ID,
        CHILD_NODE_ID,
        TREE_ID,
        repository.id,
        repository.hostId,
        PLAN_REVISION_ID,
        CLOCK.now(),
      ],
    );
  });
}

type SourceFacts = Readonly<{
  status: string;
  refs: string;
  count: string;
}>;

type SourceIndex = Readonly<{
  identity: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  }>;
  bytes: Uint8Array;
  digest: string;
}>;

type GitTraceEntry = Readonly<{
  arguments: readonly string[];
  before: SourceIndex;
  after: SourceIndex;
}>;

async function captureSourceFacts(fixture: GitFixture): Promise<SourceFacts> {
  return {
    status: await fixture.git([
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
    ]),
    refs: await fixture.git([
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname)%00%(objectname)%00",
    ]),
    count: await fixture.git(["count-objects", "-v"]),
  };
}

async function captureSourceIndexByRoot(root: string): Promise<SourceIndex> {
  const indexPath = join(root, ".git", "index");
  const indexMetadata = await lstat(indexPath);
  const bytes = new Uint8Array(await readFile(indexPath));
  return {
    identity: {
      dev: indexMetadata.dev,
      ino: indexMetadata.ino,
      size: indexMetadata.size,
      mtimeMs: indexMetadata.mtimeMs,
    },
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sameIndex(left: SourceIndex, right: SourceIndex): boolean {
  return (
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.identity.size === right.identity.size &&
    left.identity.mtimeMs === right.identity.mtimeMs &&
    left.digest === right.digest
  );
}

async function appendGitConfig(path: string, section: string): Promise<void> {
  const current = await readFile(path, "utf8");
  await writeFile(path, `${current}\n${section}`);
}
