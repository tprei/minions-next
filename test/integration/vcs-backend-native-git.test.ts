import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
import { RegisterRepositoryRequestSchema } from "@minions/contracts";
import {
  createEventCommitWaiter,
  createNativeGitVcsBackend,
  createNodeGitProcess,
  createRepositoryRegistry,
  createSqliteCommandStore,
  createSqliteGitMutationLeaseStore,
  createSqliteWorkspaceRegistry,
  inspectRepository,
} from "@minions/adapters";
import {
  attemptId,
  hostId,
  nonEmptyText,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type AttemptId,
  type TaskNodeId,
  type VcsBackend,
  type WorkspaceReceipt,
} from "@minions/core";
import { createGitFixture, FixedClock, SequenceIdGenerator } from "@minions/testkit";
import type { GitFixture } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);

const CLOCK = new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000));
const HOST_ID = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY_ID = repositoryId("01900000-0000-7000-8000-000000000002");
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000003");
const PARENT_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000004");
const PLAN_REVISION_ID = "01900000-0000-7000-8000-00000000000b";
const ACTOR_ID = "01900000-0000-7000-8000-000000000008";
const COMMAND_ID = "01900000-0000-7000-8000-000000000009";
const OWNER_ID = "01900000-0000-7000-8000-00000000000a";

const NODE_IDS: readonly TaskNodeId[] = [
  taskNodeId("01900000-0000-7000-8000-000000000011"),
  taskNodeId("01900000-0000-7000-8000-000000000012"),
  taskNodeId("01900000-0000-7000-8000-000000000013"),
  taskNodeId("01900000-0000-7000-8000-000000000014"),
  taskNodeId("01900000-0000-7000-8000-000000000015"),
  taskNodeId("01900000-0000-7000-8000-000000000016"),
  taskNodeId("01900000-0000-7000-8000-000000000017"),
];
const ATTEMPT_IDS: readonly AttemptId[] = [
  attemptId("01900000-0000-7000-8000-000000000021"),
  attemptId("01900000-0000-7000-8000-000000000022"),
  attemptId("01900000-0000-7000-8000-000000000023"),
  attemptId("01900000-0000-7000-8000-000000000024"),
  attemptId("01900000-0000-7000-8000-000000000025"),
  attemptId("01900000-0000-7000-8000-000000000026"),
  attemptId("01900000-0000-7000-8000-000000000027"),
];

interface Environment {
  readonly fixture: GitFixture;
  readonly database: TemporarySqliteDatabase;
  readonly backend: VcsBackend;
  createWorkspace(index: number): Promise<WorkspaceReceipt>;
}

let fixture: GitFixture | undefined;
let database: TemporarySqliteDatabase | undefined;

afterEach(async () => {
  await database?.dispose();
  database = undefined;
  await fixture?.dispose();
  fixture = undefined;
});

async function rawGit(workingDirectory: string, args: readonly string[]): Promise<string> {
  const result = await executeFile(
    "git",
    ["-c", "user.name=Minions Test", "-c", "user.email=minions-test@example.invalid", ...args],
    { cwd: workingDirectory, maxBuffer: 16 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

async function setupEnvironment(): Promise<Environment> {
  const gitFixture = await createGitFixture();
  fixture = gitFixture;
  const db = await TemporarySqliteDatabase.create("host", CLOCK);
  database = db;
  const notifier = createEventCommitWaiter();
  const commandStore = createSqliteCommandStore({
    database: db.database,
    ports: { clock: CLOCK, ids: new SequenceIdGenerator([COMMAND_ID]) },
    notifier,
  });
  const inspection = await inspectRepository(gitFixture.root);
  const repositoryRegistry = createRepositoryRegistry({
    database: db.database,
    commandStore,
    hostId: HOST_ID,
  });
  const allowedWorkspaceRoot = join(gitFixture.directory, "workspaces");
  const registered = await repositoryRegistry.register({
    request: create(RegisterRepositoryRequestSchema, {
      commandId: COMMAND_ID,
      actorSessionId: ACTOR_ID,
      repositoryId: REPOSITORY_ID,
      rootPath: gitFixture.root,
    }),
    inspection,
    allowedWorkspaceRoot,
    registeredAt: CLOCK.now(),
  });
  await db.database.write((transaction) => {
    transaction.run(
      `INSERT INTO trees (
         id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
         root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      [
        TREE_ID,
        REPOSITORY_ID,
        HOST_ID,
        registered.baseCommit,
        "vcs backend test",
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
      [PLAN_REVISION_ID, TREE_ID, "vcs backend test", CLOCK.now(), CLOCK.now()],
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
        REPOSITORY_ID,
        HOST_ID,
        PLAN_REVISION_ID,
        "root",
        CLOCK.now(),
        CLOCK.now(),
      ],
    );
    for (const [index, nodeId] of NODE_IDS.entries()) {
      const attemptId = ATTEMPT_IDS[index];
      if (attemptId === undefined) {
        throw new Error(`missing attempt fixture for index ${String(index)}`);
      }
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
          nodeId,
          TREE_ID,
          REPOSITORY_ID,
          HOST_ID,
          PARENT_NODE_ID,
          PLAN_REVISION_ID,
          `vcs node ${String(index)}`,
          CLOCK.now(),
          CLOCK.now(),
        ],
      );
      transaction.run(
        `INSERT INTO attempts (
           id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
           state_kind, version, started_at_ms, finished_at_ms, evidence_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL, NULL)`,
        [
          attemptId,
          nodeId,
          TREE_ID,
          REPOSITORY_ID,
          HOST_ID,
          PLAN_REVISION_ID,
          index + 1,
          CLOCK.now(),
        ],
      );
    }
  });
  const workspaceRegistry = createSqliteWorkspaceRegistry({ database: db.database });
  const leaseStore = createSqliteGitMutationLeaseStore({ database: db.database });
  const backend = createNativeGitVcsBackend({
    git: createNodeGitProcess(),
    workspaceRegistry,
    repositoryRegistry,
    gitMutationLeaseStore: leaseStore,
    clock: CLOCK,
    ownerId: OWNER_ID,
  });
  const createWorkspace = async (index: number): Promise<WorkspaceReceipt> => {
    const nodeId = NODE_IDS[index];
    const attemptId = ATTEMPT_IDS[index];
    if (nodeId === undefined || attemptId === undefined) {
      throw new Error(`missing workspace fixture for index ${String(index)}`);
    }
    return backend.createWorkingCopyAtCommit({
      attemptId,
      nodeId,
      treeId: TREE_ID,
      hostId: HOST_ID,
      repositoryId: REPOSITORY_ID,
      ordinal: index + 1,
    });
  };
  return { fixture: gitFixture, database: db, backend, createWorkspace };
}

describe("native-git VcsBackend", () => {
  let env: Environment;

  beforeEach(async () => {
    env = await setupEnvironment();
  });

  it("createNativeGitVcsBackend satisfies the VcsBackend port", () => {
    const backend: VcsBackend = env.backend;
    const methods: readonly (keyof VcsBackend)[] = [
      "createWorkingCopyAtCommit",
      "captureStatus",
      "captureDiff",
      "commit",
      "resolveHead",
      "enumerateDescendants",
      "restack",
      "conflictState",
      "pushBookmark",
      "cleanup",
      "recover",
    ];
    for (const method of methods) {
      expect(typeof backend[method]).toBe("function");
    }
  });

  it("resolves the head of a freshly created working copy", async () => {
    const receipt = await env.createWorkspace(0);
    await expect(env.backend.resolveHead({ attemptId: receipt.attemptId })).resolves.toBe(
      receipt.headCommit,
    );
  });

  it("captures the diff of uncommitted changes", async () => {
    const receipt = await env.createWorkspace(0);
    await writeFile(join(receipt.workspacePath, "README.md"), "changed\n");
    const diff = await env.backend.captureDiff({ attemptId: receipt.attemptId });
    expect(diff.headCommit).toBe(receipt.headCommit);
    expect(diff.attemptId).toBe(receipt.attemptId);
    expect(new TextDecoder().decode(diff.diff)).toContain("-base");
    expect(new TextDecoder().decode(diff.diff)).toContain("+changed");
  });

  it("commits staged changes and advances the head", async () => {
    const receipt = await env.createWorkspace(0);
    await writeFile(join(receipt.workspacePath, "feature.txt"), "new\n");
    const result = await env.backend.commit({
      attemptId: receipt.attemptId,
      message: nonEmptyText("add feature", "commit message"),
      authorName: nonEmptyText("Minions Vcs", "author name"),
      authorEmail: nonEmptyText("vcs@minions.local", "author email"),
    });
    expect(result.parentCommit).toBe(receipt.headCommit);
    expect(result.headCommit).not.toBe(receipt.headCommit);
    expect(result.receipt.operation).toBe("commit");
    expect(result.receipt.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(env.backend.resolveHead({ attemptId: receipt.attemptId })).resolves.toBe(
      result.headCommit,
    );
    const author = await rawGit(receipt.workspacePath, ["log", "-1", "--pretty=%an <%ae>"]);
    expect(author).toBe("Minions Vcs <vcs@minions.local>");
  });

  it("enumerates descendants of a change, newest first", async () => {
    const receipt = await env.createWorkspace(0);
    const base = receipt.headCommit;
    await expect(
      env.backend.enumerateDescendants({ attemptId: receipt.attemptId, change: base }),
    ).resolves.toMatchObject({ change: base, descendants: [] });
    await writeFile(join(receipt.workspacePath, "a.txt"), "a\n");
    const first = await env.backend.commit({
      attemptId: receipt.attemptId,
      message: nonEmptyText("a", "commit message"),
    });
    await writeFile(join(receipt.workspacePath, "b.txt"), "b\n");
    const second = await env.backend.commit({
      attemptId: receipt.attemptId,
      message: nonEmptyText("b", "commit message"),
    });
    const descendants = await env.backend.enumerateDescendants({
      attemptId: receipt.attemptId,
      change: base,
    });
    expect(descendants.descendants).toStrictEqual([second.headCommit, first.headCommit]);
    const limited = await env.backend.enumerateDescendants({
      attemptId: receipt.attemptId,
      change: base,
      limit: 1,
    });
    expect(limited.descendants).toStrictEqual([second.headCommit]);
  });

  it("restacks descendants onto a new parent without conflicts", async () => {
    const receipt = await env.createWorkspace(0);
    const base = receipt.headCommit;
    await writeFile(join(receipt.workspacePath, "a.txt"), "a\n");
    await env.backend.commit({
      attemptId: receipt.attemptId,
      message: nonEmptyText("a", "commit message"),
    });
    await writeFile(join(receipt.workspacePath, "b.txt"), "b\n");
    const before = await env.backend.commit({
      attemptId: receipt.attemptId,
      message: nonEmptyText("b", "commit message"),
    });
    // history: base -> A -> B(HEAD). Descendants of base (newest first): [B, A].
    // Restack from the oldest descendant (A): rebase --onto base A replays B onto base.
    const descendants = await env.backend.enumerateDescendants({
      attemptId: receipt.attemptId,
      change: base,
    });
    const oldestChange = descendants.descendants.at(-1);
    if (oldestChange === undefined)
      throw new Error("expected at least one descendant before restack");
    const restack = await env.backend.restack({
      attemptId: receipt.attemptId,
      change: oldestChange,
      ontoParent: base,
    });
    expect(restack.conflicts).toBe(false);
    expect(restack.rebasedHead).not.toBe(before.headCommit);
    await expect(env.backend.resolveHead({ attemptId: receipt.attemptId })).resolves.toBe(
      restack.rebasedHead,
    );
    expect(
      (await env.backend.enumerateDescendants({ attemptId: receipt.attemptId, change: base }))
        .descendants,
    ).toStrictEqual([restack.rebasedHead]);
    await expect(readFile(join(receipt.workspacePath, "b.txt"), "utf8")).resolves.toBe("b\n");
  });

  it("reports no conflict on a clean working copy and detects unmerged paths", async () => {
    const receipt = await env.createWorkspace(0);
    await expect(
      env.backend.conflictState({ attemptId: receipt.attemptId }),
    ).resolves.toMatchObject({
      inConflict: false,
      unmergedPaths: [],
    });
    const base = receipt.headCommit;
    // commit "ours" on the current branch
    await writeFile(join(receipt.workspacePath, "README.md"), "ours\n");
    await rawGit(receipt.workspacePath, ["add", "-A"]);
    await rawGit(receipt.workspacePath, ["commit", "--no-gpg-sign", "-m", "ours"]);
    const ours = await rawGit(receipt.workspacePath, ["rev-parse", "HEAD"]);
    // diverge from base with "theirs"
    await rawGit(receipt.workspacePath, ["checkout", "--quiet", base]);
    await writeFile(join(receipt.workspacePath, "README.md"), "theirs\n");
    await rawGit(receipt.workspacePath, ["add", "-A"]);
    await rawGit(receipt.workspacePath, ["commit", "--no-gpg-sign", "-m", "theirs"]);
    const theirs = await rawGit(receipt.workspacePath, ["rev-parse", "HEAD"]);
    // merge theirs into ours -> conflicting README
    await rawGit(receipt.workspacePath, ["checkout", "--quiet", ours]);
    await expect(rawGit(receipt.workspacePath, ["merge", "--no-commit", theirs])).rejects.toThrow();
    const state = await env.backend.conflictState({ attemptId: receipt.attemptId });
    expect(state.inConflict).toBe(true);
    expect(state.unmergedPaths).toContain("README.md");
  });

  it("pushes a bookmark to a remote and records the pushed commit", async () => {
    const receipt = await env.createWorkspace(0);
    const bareRoot = await realpath(await mkdtemp(join(tmpdir(), "vcs-push-")));
    await rawGit(bareRoot, ["init", "--bare"]);
    await rawGit(receipt.workspacePath, ["remote", "add", "origin", bareRoot]);
    const result = await env.backend.pushBookmark({
      attemptId: receipt.attemptId,
      bookmark: nonEmptyText(receipt.branchName, "bookmark"),
      remote: "origin",
    });
    expect(result.bookmark).toBe(receipt.branchName);
    expect(result.remote).toBe("origin");
    expect(result.pushedCommit).toBe(receipt.headCommit);
    expect(result.receipt.operation).toBe("push_bookmark");
    const remoteHead = await rawGit(bareRoot, ["rev-parse", `refs/heads/${receipt.branchName}`]);
    expect(remoteHead).toBe(receipt.headCommit);
  });
});
