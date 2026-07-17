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
} from "@minions/adapters";
import {
  attemptId,
  hostId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type AttemptId,
  type GitProcess,
  type GitProcessRequest,
  type RepositoryId,
  type TaskNodeId,
} from "@minions/core";
import { createGitFixture, FixedClock, SequenceIdGenerator } from "@minions/testkit";
import type { GitFixture } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import type { EventCommitWaiter } from "@minions/adapters";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLOCK = new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000));
const HOST_ID = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY_ID = repositoryId("01900000-0000-7000-8000-000000000002");
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000003");
const PARENT_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000004");
const CHILD_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000005");
const SYMLINK_NODE_ID = taskNodeId("01900000-0000-7000-8000-00000000000f");
const SIBLING_NODE_ID = taskNodeId("01900000-0000-7000-8000-00000000000d");
const PLAN_REVISION_ID = "01900000-0000-7000-8000-00000000000b";
const PARENT_ATTEMPT_ID = attemptId("01900000-0000-7000-8000-000000000006");
const CHILD_ATTEMPT_ID = attemptId("01900000-0000-7000-8000-000000000007");
const SIBLING_ATTEMPT_ID = attemptId("01900000-0000-7000-8000-00000000000e");
const ACTOR_ID = "01900000-0000-7000-8000-000000000008";
const SYMLINK_ATTEMPT_ID = attemptId("01900000-0000-7000-8000-000000000010");
const COMMAND_ID = "01900000-0000-7000-8000-000000000009";

let fixture: GitFixture | undefined;
let database: TemporarySqliteDatabase | undefined;
let notifier: EventCommitWaiter | undefined;

afterEach(async () => {
  notifier?.close();
  notifier = undefined;
  await database?.dispose();
  database = undefined;
  await fixture?.dispose();
  fixture = undefined;
});

describe("independent Git workspaces", () => {
  it("creates independent parent and child clones, captures bytes, and cleans deterministically", async () => {
    fixture = await createGitFixture();
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
    const inspection = await inspectRepository(fixture.root);
    const repositoryRegistry = createRepositoryRegistry({
      database: database.database,
      commandStore,
      hostId: HOST_ID,
    });
    const allowedWorkspaceRoot = join(fixture.directory, "workspaces");
    const registered = await repositoryRegistry.register({
      request: create(RegisterRepositoryRequestSchema, {
        commandId: COMMAND_ID,
        actorSessionId: ACTOR_ID,
        repositoryId: REPOSITORY_ID,
        rootPath: fixture.root,
      }),
      inspection,
      allowedWorkspaceRoot,
      registeredAt: CLOCK.now(),
    });
    expect(registered.canonicalRoot).toBe(fixture.root);
    await database.database.write((transaction) => {
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
          "workspace test",
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
        [PLAN_REVISION_ID, TREE_ID, "workspace test", CLOCK.now(), CLOCK.now()],
      );
      const insertNode = (nodeId: string, parentNodeId: string | null): void => {
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
            parentNodeId,
            PLAN_REVISION_ID,
            "workspace node",
            CLOCK.now(),
            CLOCK.now(),
          ],
        );
      };
      insertNode(PARENT_NODE_ID, null);
      insertNode(CHILD_NODE_ID, PARENT_NODE_ID);
      insertNode(SIBLING_NODE_ID, PARENT_NODE_ID);
      insertNode(SYMLINK_NODE_ID, PARENT_NODE_ID);
      const insertAttempt = (attempt: string, node: string, ordinal: number): void => {
        transaction.run(
          `INSERT INTO attempts (
             id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
             state_kind, version, started_at_ms, finished_at_ms, evidence_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL, NULL)`,
          [attempt, node, TREE_ID, REPOSITORY_ID, HOST_ID, PLAN_REVISION_ID, ordinal, CLOCK.now()],
        );
      };
      insertAttempt(PARENT_ATTEMPT_ID, PARENT_NODE_ID, 1);
      insertAttempt(CHILD_ATTEMPT_ID, CHILD_NODE_ID, 1);
      insertAttempt(SIBLING_ATTEMPT_ID, SIBLING_NODE_ID, 1);
      insertAttempt(SYMLINK_ATTEMPT_ID, SYMLINK_NODE_ID, 1);
    });
    const workspaceRegistry = createSqliteWorkspaceRegistry({ database: database.database });
    const leaseStore = createSqliteGitMutationLeaseStore({ database: database.database });
    const manager = createWorkspaceManager({
      git: createNodeGitProcess(),
      workspaceRegistry,
      repositoryRegistry,
      gitMutationLeaseStore: leaseStore,
      clock: CLOCK,
      ownerId: "01900000-0000-7000-8000-00000000000a",
    });
    expect(() =>
      createWorkspaceManager({
        git: createNodeGitProcess(),
        workspaceRegistry,
        repositoryRegistry,
        gitMutationLeaseStore: leaseStore,
        clock: CLOCK,
        ownerId: "01900000-0000-7000-8000-00000000000c",
        timeoutMs: 1_000,
        leaseDurationMs: 31_999,
      }),
    ).toThrow("32 command timeouts");
    const sourceLink = join(fixture.directory, "source-link");
    await symlink(fixture.root, sourceLink);
    await expect(
      manager.create({
        attemptId: SYMLINK_ATTEMPT_ID,
        nodeId: SYMLINK_NODE_ID,
        treeId: TREE_ID,
        hostId: HOST_ID,
        repositoryId: REPOSITORY_ID,
        ordinal: 1,
        baseCommit: registered.baseCommit,
        sourcePath: sourceLink,
      }),
    ).rejects.toMatchObject({ code: "path_invalid" });
    expect((await lstat(sourceLink)).isSymbolicLink()).toBe(true);
    await expect(
      manager.create({
        attemptId: SYMLINK_ATTEMPT_ID,
        nodeId: SYMLINK_NODE_ID,
        treeId: TREE_ID,
        hostId: HOST_ID,
        repositoryId: REPOSITORY_ID,
        ordinal: 1,
        baseCommit: registered.baseCommit,
        sourcePath: fixture.origin,
      }),
    ).rejects.toMatchObject({ code: "source_invalid" });
    const parentWorkspacePath = join(allowedWorkspaceRoot, PARENT_ATTEMPT_ID);
    const seedOwner = "01900000-0000-7000-8000-000000000018";
    const seedLease = await leaseStore.acquire({
      repositoryId: REPOSITORY_ID,
      ownerId: seedOwner,
      acquiredAt: CLOCK.now(),
      leaseDurationMs: 31_999,
    });
    const parentCreatingPath = join(
      allowedWorkspaceRoot,
      `${PARENT_ATTEMPT_ID}.creating.${seedLease.fencingToken.toString()}`,
    );
    await workspaceRegistry.begin({
      attemptId: PARENT_ATTEMPT_ID,
      nodeId: PARENT_NODE_ID,
      treeId: TREE_ID,
      hostId: HOST_ID,
      repositoryId: REPOSITORY_ID,
      workspacePath: parentWorkspacePath,
      sourcePath: fixture.root,
      branchName: `minions/${TREE_ID}/${PARENT_NODE_ID}/1`,
      baseCommit: registered.baseCommit,
      createdAt: CLOCK.now(),
      ownerId: seedOwner,
      fencingToken: seedLease.fencingToken,
      observedAt: CLOCK.now(),
    });
    await leaseStore.release({
      repositoryId: REPOSITORY_ID,
      ownerId: seedOwner,
      fencingToken: seedLease.fencingToken,
      releasedAt: CLOCK.now(),
    });
    await mkdir(parentWorkspacePath, { recursive: true });
    await mkdir(parentCreatingPath, { recursive: true });
    await writeFile(join(parentWorkspacePath, "debris"), "final");
    await writeFile(join(parentCreatingPath, "debris"), "temporary");
    const recoveredCreating = await manager.recover();
    expect(recoveredCreating.some((receipt) => receipt.attemptId === PARENT_ATTEMPT_ID)).toBe(true);
    expect(workspaceRegistry.get(PARENT_ATTEMPT_ID)).toMatchObject({ state: "creating" });
    await expect(lstat(parentWorkspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(parentCreatingPath)).rejects.toMatchObject({ code: "ENOENT" });

    const parent = await manager.create({
      attemptId: PARENT_ATTEMPT_ID,
      nodeId: PARENT_NODE_ID,
      treeId: TREE_ID,
      hostId: HOST_ID,
      repositoryId: REPOSITORY_ID,
      ordinal: 1,
      baseCommit: registered.baseCommit,
    });
    expect(parent.state).toBe("ready");
    expect(parent.headCommit).toBe(fixture.baseCommit);
    expect(parent.branchName).toBe(`minions/${TREE_ID}/${PARENT_NODE_ID}/1`);
    expect(await readFile(join(parent.workspacePath, ".git", "config"), "utf8")).not.toContain(
      "remote",
    );
    expect(await manager.captureStatus({ attemptId: PARENT_ATTEMPT_ID })).toMatchObject({
      attemptId: PARENT_ATTEMPT_ID,
      headCommit: fixture.baseCommit,
    });

    await writeFile(join(parent.workspacePath, "change.txt"), "child source\n");
    const parentStatus = await manager.captureStatus({ attemptId: PARENT_ATTEMPT_ID });
    expect(new TextDecoder().decode(parentStatus.porcelainV2)).toContain("? change.txt");
    expect(parentStatus.diff.byteLength).toBe(0);

    const unpublishedObject = await fixture.git(
      ["hash-object", "-w", "change.txt"],
      parent.workspacePath,
    );
    const createChild = (attempt: AttemptId, node: TaskNodeId) =>
      manager.create({
        attemptId: attempt,
        nodeId: node,
        treeId: TREE_ID,
        hostId: HOST_ID,
        repositoryId: REPOSITORY_ID,
        ordinal: 1,
        baseCommit: parent.headCommit,
        sourcePath: parent.workspacePath,
        sourceAttemptId: parent.attemptId,
      });
    const [child, sibling] = await Promise.all([
      createChild(CHILD_ATTEMPT_ID, CHILD_NODE_ID),
      createChild(SIBLING_ATTEMPT_ID, SIBLING_NODE_ID),
    ]);
    expect(child.state).toBe("ready");
    expect(sibling.state).toBe("ready");
    expect(child.headCommit).toBe(parent.headCommit);
    expect(sibling.headCommit).toBe(parent.headCommit);
    expect(child.branchName).toBe(`minions/${TREE_ID}/${CHILD_NODE_ID}/1`);
    expect(sibling.branchName).toBe(`minions/${TREE_ID}/${SIBLING_NODE_ID}/1`);
    expect(child.workspacePath).not.toBe(sibling.workspacePath);
    expect(await readFile(join(child.workspacePath, "README.md"), "utf8")).toBe("base\n");
    await expect(readFile(join(child.workspacePath, "change.txt"))).rejects.toThrow();
    await expect(
      fixture.git(["cat-file", "-e", unpublishedObject], child.workspacePath),
    ).rejects.toThrow();
    await expect(
      fixture.git(["cat-file", "-e", unpublishedObject], sibling.workspacePath),
    ).rejects.toThrow();
    expect(await fixture.git(["symbolic-ref", "--short", "HEAD"], parent.workspacePath)).toBe(
      `minions/${TREE_ID}/${PARENT_NODE_ID}/1`,
    );
    expect(await fixture.git(["rev-parse", "HEAD"], fixture.root)).toBe(fixture.baseCommit);

    const childStatus = await manager.captureStatus({ attemptId: child.attemptId });
    expect(childStatus.diff.byteLength).toBe(0);
    const childAgain = await manager.create({
      attemptId: CHILD_ATTEMPT_ID,
      nodeId: CHILD_NODE_ID,
      treeId: TREE_ID,
      repositoryId: REPOSITORY_ID,
      ordinal: 1,
      hostId: HOST_ID,
      baseCommit: parent.headCommit,
      sourcePath: parent.workspacePath,
      sourceAttemptId: parent.attemptId,
    });
    expect(childAgain).toEqual(child);

    const cleanedChild = await manager.cleanup({ attemptId: child.attemptId });
    expect(cleanedChild.state).toBe("cleaned");
    const cleanedChildAgain = await manager.cleanup({ attemptId: child.attemptId });
    expect(cleanedChildAgain).toEqual(cleanedChild);
    const cleanupOwner = "01900000-0000-7000-8000-000000000019";
    const cleanupLease = await leaseStore.acquire({
      repositoryId: REPOSITORY_ID,
      ownerId: cleanupOwner,
      acquiredAt: CLOCK.now(),
      leaseDurationMs: 31_999,
    });
    const pendingSibling = await workspaceRegistry.requestCleanup({
      attemptId: sibling.attemptId,
      expectedVersion: sibling.version,
      cleanupRequestedAt: CLOCK.now(),
      ownerId: cleanupOwner,
      fencingToken: cleanupLease.fencingToken,
      observedAt: CLOCK.now(),
    });
    await leaseStore.release({
      repositoryId: REPOSITORY_ID,
      ownerId: cleanupOwner,
      fencingToken: cleanupLease.fencingToken,
      releasedAt: CLOCK.now(),
    });
    expect(pendingSibling.state).toBe("cleanup_pending");
    await manager.recover();
    expect(workspaceRegistry.get(sibling.attemptId)).toMatchObject({ state: "cleaned" });
    const cleanedSibling = await manager.cleanup({ attemptId: sibling.attemptId });
    expect(cleanedSibling.state).toBe("cleaned");
    const cleanedParent = await manager.cleanup({ attemptId: parent.attemptId });
    expect(cleanedParent.state).toBe("cleaned");
    await expect(lstat(parent.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});

describe("cross-repository Git workspace concurrency", () => {
  it("runs independent repository creates concurrently through their first fetch", async () => {
    fixture = await createGitFixture({ prefix: "minions-workspaces-concurrency-a-" });
    const fixtureB = await createGitFixture({ prefix: "minions-workspaces-concurrency-b-" });
    try {
      database = await TemporarySqliteDatabase.create("host", CLOCK);
      notifier = createEventCommitWaiter();
      const commandStore = createSqliteCommandStore({
        database: database.database,
        ports: {
          clock: CLOCK,
          ids: new SequenceIdGenerator([
            "01900000-0000-7000-8000-00000000001b",
            "01900000-0000-7000-8000-00000000001c",
          ]),
        },
        notifier,
      });
      const repositoryRegistry = createRepositoryRegistry({
        database: database.database,
        commandStore,
        hostId: HOST_ID,
      });
      const repositoryAId = repositoryId("01900000-0000-7000-8000-000000000011");
      const repositoryBId = repositoryId("01900000-0000-7000-8000-000000000012");
      const registrationA = await repositoryRegistry.register({
        request: create(RegisterRepositoryRequestSchema, {
          commandId: "01900000-0000-7000-8000-00000000001b",
          actorSessionId: ACTOR_ID,
          repositoryId: repositoryAId,
          rootPath: fixture.root,
        }),
        inspection: await inspectRepository(fixture.root),
        allowedWorkspaceRoot: join(fixture.directory, "workspaces"),
        registeredAt: CLOCK.now(),
      });
      const registrationB = await repositoryRegistry.register({
        request: create(RegisterRepositoryRequestSchema, {
          commandId: "01900000-0000-7000-8000-00000000001c",
          actorSessionId: ACTOR_ID,
          repositoryId: repositoryBId,
          rootPath: fixtureB.root,
        }),
        inspection: await inspectRepository(fixtureB.root),
        allowedWorkspaceRoot: join(fixtureB.directory, "workspaces"),
        registeredAt: CLOCK.now(),
      });
      await mkdir(registrationA.allowedWorkspaceRoot, { recursive: true });
      await mkdir(registrationB.allowedWorkspaceRoot, { recursive: true });
      const treeAId = taskTreeId("01900000-0000-7000-8000-000000000013");
      const treeBId = taskTreeId("01900000-0000-7000-8000-000000000014");
      const nodeAId = taskNodeId("01900000-0000-7000-8000-000000000015");
      const nodeBId = taskNodeId("01900000-0000-7000-8000-000000000016");
      const attemptAId = attemptId("01900000-0000-7000-8000-000000000017");
      const attemptBId = attemptId("01900000-0000-7000-8000-000000000018");
      const planRevisionAId = "01900000-0000-7000-8000-000000000019";
      const planRevisionBId = "01900000-0000-7000-8000-00000000001a";
      const records = [
        {
          attemptId: attemptAId,
          nodeId: nodeAId,
          treeId: treeAId,
          repositoryId: repositoryAId,
          planRevisionId: planRevisionAId,
          baseCommit: registrationA.baseCommit,
        },
        {
          attemptId: attemptBId,
          nodeId: nodeBId,
          treeId: treeBId,
          repositoryId: repositoryBId,
          planRevisionId: planRevisionBId,
          baseCommit: registrationB.baseCommit,
        },
      ];
      await database.database.write((transaction) => {
        for (const record of records) {
          transaction.run(
            `INSERT INTO trees (
               id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
               root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
            [
              record.treeId,
              record.repositoryId,
              HOST_ID,
              record.baseCommit,
              "workspace concurrency test",
              record.planRevisionId,
              record.nodeId,
              CLOCK.now(),
              CLOCK.now(),
            ],
          );
          transaction.run(
            `INSERT INTO plan_revisions (
               id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
               approved_at_ms, superseded_at_ms
             ) VALUES (?, ?, 1, ?, 'approved', 0, ?, ?, NULL)`,
            [
              record.planRevisionId,
              record.treeId,
              "workspace concurrency test",
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
             ) VALUES (?, ?, ?, ?, NULL, ?, 'implementation', ?, 'implementation', NULL, NULL,
               'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               NULL, NULL, NULL, 0, ?, ?)`,
            [
              record.nodeId,
              record.treeId,
              record.repositoryId,
              HOST_ID,
              record.planRevisionId,
              "workspace concurrency node",
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
              record.attemptId,
              record.nodeId,
              record.treeId,
              record.repositoryId,
              HOST_ID,
              record.planRevisionId,
              CLOCK.now(),
            ],
          );
        }
      });
      const workspaceRegistry = createSqliteWorkspaceRegistry({ database: database.database });
      const leaseStore = createSqliteGitMutationLeaseStore({ database: database.database });
      const repositoryRoots = [
        {
          id: registrationA.id,
          roots: [registrationA.canonicalRoot, registrationA.allowedWorkspaceRoot],
        },
        {
          id: registrationB.id,
          roots: [registrationB.canonicalRoot, registrationB.allowedWorkspaceRoot],
        },
      ];
      const repositoryForWorkingDirectory = (workingDirectory: string): RepositoryId => {
        const match = repositoryRoots.find(({ roots }) =>
          roots.some((root) => {
            const relativePath = relative(root, workingDirectory);
            return (
              relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
            );
          }),
        );
        if (match === undefined) {
          throw new Error(
            `Git working directory is not owned by a test repository: ${workingDirectory}`,
          );
        }
        return match.id;
      };
      const barrierA = { entered: createDeferred(), release: createDeferred() };
      const barrierB = { entered: createDeferred(), release: createDeferred() };
      const barriers = new Map([
        [registrationA.id, barrierA],
        [registrationB.id, barrierB],
      ]);
      const fetchSeen = new Set<RepositoryId>();
      const activeByRepository = new Map<RepositoryId, number>();
      const maxByRepository = new Map<RepositoryId, number>();
      let activeGlobal = 0;
      let maxGlobal = 0;
      const realGit = createNodeGitProcess();
      const instrumentedGit: GitProcess = {
        run: async (request: GitProcessRequest) => {
          const repository = repositoryForWorkingDirectory(request.workingDirectory);
          const active = (activeByRepository.get(repository) ?? 0) + 1;
          activeByRepository.set(repository, active);
          maxByRepository.set(repository, Math.max(maxByRepository.get(repository) ?? 0, active));
          activeGlobal += 1;
          maxGlobal = Math.max(maxGlobal, activeGlobal);
          try {
            let commandIndex = 0;
            while (
              request.arguments[commandIndex] === "-c" &&
              request.arguments[commandIndex + 1]?.includes("=") === true
            ) {
              commandIndex += 2;
            }
            if (request.arguments[commandIndex] === "fetch" && !fetchSeen.has(repository)) {
              fetchSeen.add(repository);
              const barrier = barriers.get(repository);
              if (barrier === undefined) {
                throw new Error(`Missing fetch barrier for repository ${repository}`);
              }
              barrier.entered.resolve();
              await barrier.release.promise;
            }
            return await realGit.run(request);
          } finally {
            activeByRepository.set(repository, active - 1);
            activeGlobal -= 1;
          }
        },
      };
      const manager = createWorkspaceManager({
        git: instrumentedGit,
        workspaceRegistry,
        repositoryRegistry,
        gitMutationLeaseStore: leaseStore,
        clock: CLOCK,
        ownerId: "01900000-0000-7000-8000-00000000001d",
      });
      const creates = Promise.all([
        manager.create({
          attemptId: attemptAId,
          nodeId: nodeAId,
          treeId: treeAId,
          hostId: HOST_ID,
          repositoryId: repositoryAId,
          ordinal: 1,
          baseCommit: registrationA.baseCommit,
        }),
        manager.create({
          attemptId: attemptBId,
          nodeId: nodeBId,
          treeId: treeBId,
          hostId: HOST_ID,
          repositoryId: repositoryBId,
          ordinal: 1,
          baseCommit: registrationB.baseCommit,
        }),
      ]);
      const createFailure = new Promise<never>((_resolve, reject) => {
        void creates.catch(reject);
      });
      try {
        await Promise.race([
          Promise.all([barrierA.entered.promise, barrierB.entered.promise]),
          createFailure,
        ]);
        expect(fetchSeen).toEqual(new Set([registrationA.id, registrationB.id]));
        expect(maxGlobal).toBeGreaterThanOrEqual(2);
        barrierA.release.resolve();
        barrierB.release.resolve();
        const [workspaceA, workspaceB] = await creates;
        expect(workspaceA.state).toBe("ready");
        expect(workspaceB.state).toBe("ready");
        expect(workspaceA.headCommit).toBe(fixture.baseCommit);
        expect(workspaceB.headCommit).toBe(fixtureB.baseCommit);
        expect(workspaceA.workspacePath).not.toBe(workspaceB.workspacePath);
        expect(maxByRepository.get(registrationA.id)).toBe(1);
        expect(maxByRepository.get(registrationB.id)).toBe(1);
        expect(activeGlobal).toBe(0);
        await expect(manager.cleanup({ attemptId: workspaceA.attemptId })).resolves.toMatchObject({
          state: "cleaned",
        });
        await expect(manager.cleanup({ attemptId: workspaceB.attemptId })).resolves.toMatchObject({
          state: "cleaned",
        });
        await expect(lstat(workspaceA.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(workspaceB.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        barrierA.release.resolve();
        barrierB.release.resolve();
      }
    } finally {
      await fixtureB.dispose();
    }
  }, 15_000);
});

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

function createDeferred(): Deferred {
  let resolvePromise: () => void = () => {
    throw new Error("Deferred promise resolver was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
