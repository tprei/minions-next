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
  GitMutationLeaseError,
  inspectRepository,
  type EventCommitWaiter,
  type GitMutationLease,
  type GitMutationLeaseAcquireInput,
  type GitMutationLeaseAssertHeldInput,
  type GitMutationLeaseReleaseInput,
  type GitMutationLeaseRenewInput,
  type GitMutationLeaseStore,
  type RepositoryRegistration,
  type RepositoryRegistry,
  type WorkspaceCreateInput,
  type WorkspaceRegistry,
} from "@minions/adapters";
import {
  attemptId,
  gitSha,
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
  type TaskTreeId,
  type WorkspaceReceipt,
} from "@minions/core";
import { AdvancingClock, createGitFixture, SequenceIdGenerator } from "@minions/testkit";
import type { GitFixture } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const INITIAL_TIME = timestampFromEpochMilliseconds(1_700_000_000_000);
const LEASE_DURATION_MS = 32_000;
const COMMAND_TIMEOUT_MS = 1_000;
const HOST = hostId("01900000-0000-7000-8000-000000000001");
const ACTOR = "01900000-0000-7000-8000-000000000002";
const OWNER_INITIAL = "01900000-0000-7000-8000-000000000003";
const OWNER_A = "01900000-0000-7000-8000-000000000004";
const OWNER_B = "01900000-0000-7000-8000-000000000005";
const OWNER_RECOVERY = "01900000-0000-7000-8000-000000000006";

const realGit = createNodeGitProcess();

type AttemptSeed = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  planRevisionId: string;
  ordinal: number;
  repositoryId: RepositoryId;
  baseCommit: string;
}>;

type RepositorySeed = Readonly<{
  fixture: GitFixture;
  repositoryId: RepositoryId;
  commandId: string;
  attempts: readonly AttemptSeed[];
}>;

type TestEnvironment = Readonly<{
  clock: AdvancingClock;
  temporary: TemporarySqliteDatabase;
  notifier: EventCommitWaiter;
  repositoryRegistry: RepositoryRegistry;
  workspaceRegistry: WorkspaceRegistry;
  leaseStore: GitMutationLeaseStore;
  registrations: ReadonlyMap<RepositoryId, RepositoryRegistration>;
}>;

type Deferred = Readonly<{
  promise: Promise<undefined>;
  resolve(value?: undefined): void;
}>;

type LeaseHooks = Readonly<{
  onUnavailable?: (input: GitMutationLeaseAcquireInput) => void;
  onAssertHeld?: (input: GitMutationLeaseAssertHeldInput) => Promise<void>;
}>;

class BarrierLeaseStore implements GitMutationLeaseStore {
  readonly #inner: GitMutationLeaseStore;
  readonly #onUnavailable: ((input: GitMutationLeaseAcquireInput) => void) | undefined;
  readonly #onAssertHeld: ((input: GitMutationLeaseAssertHeldInput) => Promise<void>) | undefined;

  constructor(inner: GitMutationLeaseStore, hooks: LeaseHooks = {}) {
    this.#inner = inner;
    this.#onUnavailable = hooks.onUnavailable;
    this.#onAssertHeld = hooks.onAssertHeld;
  }

  async acquire(input: GitMutationLeaseAcquireInput): Promise<GitMutationLease> {
    try {
      return await this.#inner.acquire(input);
    } catch (error: unknown) {
      if (error instanceof GitMutationLeaseError && error.code === "unavailable") {
        this.#onUnavailable?.(input);
      }
      throw error;
    }
  }

  renew(input: GitMutationLeaseRenewInput): Promise<GitMutationLease> {
    return this.#inner.renew(input);
  }

  async assertHeld(input: GitMutationLeaseAssertHeldInput): Promise<void> {
    if (this.#onAssertHeld !== undefined) await this.#onAssertHeld(input);
    await this.#inner.assertHeld(input);
  }

  release(input: GitMutationLeaseReleaseInput): Promise<void> {
    return this.#inner.release(input);
  }
}

describe("workspace mutation fencing and recovery", () => {
  it("waits same-repository managers behind one lease and completes both without Git overlap", async () => {
    const fixture = await createGitFixture({ prefix: "minions-workspace-fence-contention-" });
    let environment: TestEnvironment | undefined;
    try {
      const repository = repositoryId("01900000-0000-7000-8000-000000000010");
      environment = await createEnvironment([
        repositorySeed(fixture, repository, 0x20, [
          attemptSeed(repository, fixture, 0x30, 0x32, 0x31, 0x33, 1),
          attemptSeed(repository, fixture, 0x34, 0x36, 0x35, 0x37, 1),
        ]),
      ]);
      const registration = requireRegistration(environment, repository);
      const unavailable = createDeferred();
      const firstFetchEntered = createDeferred();
      const releaseFirstFetch = createDeferred();
      let firstFetch = true;
      let activeGit = 0;
      let maxActiveGit = 0;
      const git: GitProcess = {
        run: async (request: GitProcessRequest) => {
          activeGit += 1;
          maxActiveGit = Math.max(maxActiveGit, activeGit);
          try {
            if (gitCommandName(request) === "fetch" && firstFetch) {
              firstFetch = false;
              firstFetchEntered.resolve();
              await releaseFirstFetch.promise;
            }
            return await realGit.run(request);
          } finally {
            activeGit -= 1;
          }
        },
      };
      const leaseStore = new BarrierLeaseStore(environment.leaseStore, {
        onUnavailable: () => {
          unavailable.resolve();
        },
      });
      const managerA = createManager(git, environment, leaseStore, OWNER_A);
      const managerB = createManager(git, environment, leaseStore, OWNER_B);
      const inputA = workspaceInput(
        repository,
        attemptId("01900000-0000-7000-8000-000000000030"),
        0x31,
        0x32,
      );
      const inputB = workspaceInput(
        repository,
        attemptId("01900000-0000-7000-8000-000000000034"),
        0x35,
        0x36,
      );
      const createA = managerA.create(inputA);
      await Promise.race([firstFetchEntered.promise, rejectBeforeBarrier(createA)]);
      const createB = managerB.create(inputB);
      await Promise.race([unavailable.promise, rejectBeforeBarrier(createB)]);
      expect(activeGit).toBe(1);
      expect(maxActiveGit).toBe(1);
      releaseFirstFetch.resolve();
      const [workspaceA, workspaceB] = await Promise.all([createA, createB]);
      expect(workspaceA.state).toBe("ready");
      expect(workspaceB.state).toBe("ready");
      expect(workspaceA.workspacePath).not.toBe(workspaceB.workspacePath);
      expect(maxActiveGit).toBe(1);
      expect(activeGit).toBe(0);
      await expect(managerA.cleanup({ attemptId: workspaceA.attemptId })).resolves.toMatchObject({
        state: "cleaned",
      });
      await expect(managerB.cleanup({ attemptId: workspaceB.attemptId })).resolves.toMatchObject({
        state: "cleaned",
      });
      expect(registration.id).toBe(repository);
    } finally {
      await disposeEnvironment(environment);
      await fixture.dispose();
    }
  }, 15_000);

  it("lets fencing token N+1 finish takeover while stale token N cannot rename or publish", async () => {
    const fixture = await createGitFixture({ prefix: "minions-workspace-fence-takeover-" });
    let environment: TestEnvironment | undefined;
    try {
      const repository = repositoryId("01900000-0000-7000-8000-000000000040");
      const attempt = attemptId("01900000-0000-7000-8000-000000000041");
      environment = await createEnvironment([
        repositorySeed(fixture, repository, 0x42, [
          attemptSeed(repository, fixture, 0x41, 0x45, 0x44, 0x46, 1),
        ]),
      ]);
      const registration = requireRegistration(environment, repository);
      const firstFetchEntered = createDeferred();
      const releaseFirstFetch = createDeferred();
      const secondFetchEntered = createDeferred();
      const releaseSecondFetch = createDeferred();
      let fetchCount = 0;
      const git: GitProcess = {
        run: async (request: GitProcessRequest) => {
          if (gitCommandName(request) === "fetch") {
            fetchCount += 1;
            if (fetchCount === 1) {
              firstFetchEntered.resolve();
              await releaseFirstFetch.promise;
            }
            if (fetchCount === 2) {
              secondFetchEntered.resolve();
              await releaseSecondFetch.promise;
            }
          }
          return realGit.run(request);
        },
      };
      const managerA = createManager(git, environment, environment.leaseStore, OWNER_A);
      const managerB = createManager(git, environment, environment.leaseStore, OWNER_B);
      const input = workspaceInput(repository, attempt, 0x44, 0x45);
      const createA = managerA.create(input);
      await Promise.race([firstFetchEntered.promise, rejectBeforeBarrier(createA)]);
      environment.clock.advance(LEASE_DURATION_MS);
      const createB = managerB.create(input);
      await Promise.race([secondFetchEntered.promise, rejectBeforeBarrier(createB)]);
      releaseSecondFetch.resolve();
      const takeover = await createB;
      expect(takeover.state).toBe("ready");
      expect(takeover.mutationFencingToken).toBe(2n);
      releaseFirstFetch.resolve();
      await expect(createA).rejects.toMatchObject({ code: "lease_failed" });
      expect(environment.workspaceRegistry.get(attempt)).toMatchObject({
        state: "ready",
        mutationFencingToken: 2n,
      });
      const takeoverMetadata = await lstat(takeover.workspacePath);
      expect(takeoverMetadata.isDirectory()).toBe(true);
      const entries = await readdir(registration.allowedWorkspaceRoot);
      expect(entries).not.toContain(`${attempt}.creating.1`);
      expect(entries).not.toContain(`${attempt}.creating.2`);
      expect(fetchCount).toBe(2);
    } finally {
      await disposeEnvironment(environment);
      await fixture.dispose();
    }
  }, 15_000);

  it("keeps a newer final workspace when an expired cleanup owner resumes after staging", async () => {
    const fixture = await createGitFixture({ prefix: "minions-workspace-fence-cleanup-" });
    let environment: TestEnvironment | undefined;
    let takeover: GitMutationLease | undefined;
    try {
      const repository = repositoryId("01900000-0000-7000-8000-000000000050");
      const attempt = attemptId("01900000-0000-7000-8000-000000000051");
      environment = await createEnvironment([
        repositorySeed(fixture, repository, 0x52, [
          attemptSeed(repository, fixture, 0x51, 0x55, 0x54, 0x56, 1),
        ]),
      ]);
      const cleanupEnvironment = environment;
      const initialManager = createManager(
        realGit,
        cleanupEnvironment,
        cleanupEnvironment.leaseStore,
        OWNER_INITIAL,
      );
      const ready = await initialManager.create(workspaceInput(repository, attempt, 0x54, 0x55));
      const stagingEntered = createDeferred();
      const releaseStaging = createDeferred();
      const finalPath = ready.workspacePath;
      let assertCount = 0;
      const cleanupManager = createManager(
        realGit,
        cleanupEnvironment,
        new BarrierLeaseStore(cleanupEnvironment.leaseStore, {
          onAssertHeld: async (input) => {
            if (input.ownerId !== OWNER_A) return;
            assertCount += 1;
            if (assertCount !== 3) return;
            const stagingPath = join(
              requireRegistration(cleanupEnvironment, repository).allowedWorkspaceRoot,
              `${attempt}.cleanup.${input.fencingToken.toString()}`,
            );
            if ((await pathExists(finalPath)) || !(await pathExists(stagingPath))) return;
            stagingEntered.resolve();
            await releaseStaging.promise;
          },
        }),
        OWNER_A,
      );
      const cleanup = cleanupManager.cleanup({ attemptId: attempt });
      await Promise.race([stagingEntered.promise, rejectBeforeBarrier(cleanup)]);
      const current = environment.workspaceRegistry.get(attempt);
      const stagingPath = join(
        requireRegistration(environment, repository).allowedWorkspaceRoot,
        `${attempt}.cleanup.${current.mutationFencingToken.toString()}`,
      );
      await cp(stagingPath, finalPath, { recursive: true });
      environment.clock.advance(LEASE_DURATION_MS);
      takeover = await environment.leaseStore.acquire({
        repositoryId: repository,
        ownerId: OWNER_B,
        acquiredAt: environment.clock.now(),
        leaseDurationMs: LEASE_DURATION_MS,
      });
      expect(takeover.fencingToken).toBe(current.mutationFencingToken + 1n);
      releaseStaging.resolve();
      await expect(cleanup).rejects.toMatchObject({ code: "lease_failed" });
      const finalMetadata = await lstat(finalPath);
      expect(finalMetadata.isDirectory()).toBe(true);
      expect(await readFile(join(finalPath, "README.md"), "utf8")).toBe("base\n");
      expect(await pathExists(stagingPath)).toBe(true);
    } finally {
      if (takeover !== undefined && environment !== undefined) {
        await environment.leaseStore.release({
          repositoryId: takeover.repositoryId,
          ownerId: takeover.ownerId,
          fencingToken: takeover.fencingToken,
          releasedAt: environment.clock.now(),
        });
      }
      await disposeEnvironment(environment);
      await fixture.dispose();
    }
  }, 15_000);

  it("recovers repositories concurrently and reaches cleaned for one after the other fails", async () => {
    const fixtureA = await createGitFixture({ prefix: "minions-workspace-recover-a-" });
    const fixtureB = await createGitFixture({ prefix: "minions-workspace-recover-b-" });
    let environment: TestEnvironment | undefined;
    try {
      const repositoryA = repositoryId("01900000-0000-7000-8000-000000000060");
      const repositoryB = repositoryId("01900000-0000-7000-8000-000000000061");
      const attemptA = attemptId("01900000-0000-7000-8000-000000000062");
      const attemptB = attemptId("01900000-0000-7000-8000-000000000063");
      environment = await createEnvironment([
        repositorySeed(fixtureA, repositoryA, 0x64, [
          attemptSeed(repositoryA, fixtureA, 0x62, 0x67, 0x66, 0x68, 1),
        ]),
        repositorySeed(fixtureB, repositoryB, 0x69, [
          attemptSeed(repositoryB, fixtureB, 0x63, 0x6c, 0x6b, 0x6d, 1),
        ]),
      ]);
      const manager = createManager(realGit, environment, environment.leaseStore, OWNER_INITIAL);
      const [readyA, readyB] = await Promise.all([
        manager.create(workspaceInput(repositoryA, attemptA, 0x66, 0x67)),
        manager.create(workspaceInput(repositoryB, attemptB, 0x6b, 0x6c)),
      ]);
      await requestCleanup(environment, readyA, OWNER_INITIAL);
      await requestCleanup(environment, readyB, OWNER_INITIAL);
      const enteredA = createDeferred();
      const enteredB = createDeferred();
      const releaseA = createDeferred();
      const releaseB = createDeferred();
      const recoveryLease = new BarrierLeaseStore(environment.leaseStore, {
        onAssertHeld: async (input) => {
          if (input.ownerId !== OWNER_RECOVERY) return;
          if (input.repositoryId === repositoryA) {
            enteredA.resolve();
            await releaseA.promise;
            throw new Error("injected repository A recovery failure");
          }
          if (input.repositoryId === repositoryB) {
            enteredB.resolve();
            await releaseB.promise;
          }
        },
      });
      const recovery = createManager(realGit, environment, recoveryLease, OWNER_RECOVERY).recover();
      await Promise.race([
        Promise.all([enteredA.promise, enteredB.promise]),
        rejectBeforeBarrier(recovery),
      ]);
      releaseA.resolve();
      releaseB.resolve();
      await expect(recovery).rejects.toBeInstanceOf(AggregateError);
      expect(environment.workspaceRegistry.get(attemptA).state).toBe("cleanup_pending");
      expect(environment.workspaceRegistry.get(attemptB).state).toBe("cleaned");
      await expect(pathExists(readyA.workspacePath)).resolves.toBe(true);
      await expect(pathExists(readyB.workspacePath)).resolves.toBe(false);
    } finally {
      await disposeEnvironment(environment);
      await fixtureA.dispose();
      await fixtureB.dispose();
    }
  }, 15_000);

  it("finalizes a creating receipt with a valid final clone without recloning", async () => {
    const fixture = await createGitFixture({ prefix: "minions-workspace-final-receipt-" });
    let environment: TestEnvironment | undefined;
    let lease: GitMutationLease | undefined;
    try {
      const repository = repositoryId("01900000-0000-7000-8000-000000000070");
      const attempt = attemptId("01900000-0000-7000-8000-000000000071");
      const seed = attemptSeed(repository, fixture, 0x71, 0x73, 0x72, 0x75, 1);
      environment = await createEnvironment([repositorySeed(fixture, repository, 0x76, [seed])]);
      const registration = requireRegistration(environment, repository);
      const branch = `minions/${seed.treeId}/${seed.nodeId}/1`;
      const workspacePath = join(registration.allowedWorkspaceRoot, attempt);
      await mkdir(registration.allowedWorkspaceRoot, { recursive: true });
      await mkdir(workspacePath);
      await fixture.git(
        ["init", "--object-format=sha1", `--initial-branch=${branch}`],
        workspacePath,
      );
      await fixture.git(
        ["fetch", "--no-tags", "--no-write-fetch-head", fixture.root, fixture.baseCommit],
        workspacePath,
      );
      await fixture.git(["checkout", "--force", "-B", branch, fixture.baseCommit], workspacePath);
      const workspaceRegistry = environment.workspaceRegistry;
      lease = await environment.leaseStore.acquire({
        repositoryId: repository,
        ownerId: OWNER_INITIAL,
        acquiredAt: environment.clock.now(),
        leaseDurationMs: LEASE_DURATION_MS,
      });
      const creating = await workspaceRegistry.begin({
        attemptId: attempt,
        nodeId: seed.nodeId,
        treeId: seed.treeId,
        hostId: HOST,
        repositoryId: repository,
        workspacePath,
        sourcePath: fixture.root,
        branchName: branch,
        baseCommit: gitSha(fixture.baseCommit),
        createdAt: environment.clock.now(),
        ownerId: OWNER_INITIAL,
        fencingToken: lease.fencingToken,
        observedAt: environment.clock.now(),
      });
      await environment.leaseStore.release({
        repositoryId: repository,
        ownerId: OWNER_INITIAL,
        fencingToken: lease.fencingToken,
        releasedAt: environment.clock.now(),
      });
      lease = undefined;
      const noRecloneGit: GitProcess = {
        run: async (request: GitProcessRequest) => {
          if (gitCommandName(request) === "fetch") {
            throw new Error("creating receipt was recloned");
          }
          return realGit.run(request);
        },
      };
      const finalized = await createManager(
        noRecloneGit,
        environment,
        environment.leaseStore,
        OWNER_B,
      ).create(workspaceInput(repository, attempt, seed.treeId, seed.nodeId));
      expect(creating.state).toBe("creating");
      expect(finalized.state).toBe("ready");
      expect(finalized.workspacePath).toBe(workspacePath);
      expect(environment.workspaceRegistry.get(attempt).state).toBe("ready");
    } finally {
      if (lease !== undefined && environment !== undefined) {
        await environment.leaseStore.release({
          repositoryId: lease.repositoryId,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          releasedAt: environment.clock.now(),
        });
      }
      await disposeEnvironment(environment);
      await fixture.dispose();
    }
  }, 15_000);

  it("retries a between-read status mutation and rejects continuously changing captures", async () => {
    const fixture = await createGitFixture({ prefix: "minions-workspace-status-fence-" });
    let environment: TestEnvironment | undefined;
    try {
      const repository = repositoryId("01900000-0000-7000-8000-000000000080");
      const attempt = attemptId("01900000-0000-7000-8000-000000000081");
      environment = await createEnvironment([
        repositorySeed(fixture, repository, 0x82, [
          attemptSeed(repository, fixture, 0x81, 0x85, 0x84, 0x86, 1),
        ]),
      ]);
      let mode: "off" | "once" | "continuous" = "off";
      let mutationCount = 0;
      const captureTarget: { path: string | undefined } = { path: undefined };
      const git: GitProcess = {
        run: async (request: GitProcessRequest) => {
          const result = await realGit.run(request);
          const isCaptureDiff =
            gitCommandName(request) === "diff" &&
            request.arguments.includes("--binary") &&
            request.arguments.includes("HEAD") &&
            request.workingDirectory === captureTarget.path;
          if (isCaptureDiff && mode !== "off" && (mode === "continuous" || mutationCount === 0)) {
            mutationCount += 1;
            if (mode === "once") {
              await writeFile(join(request.workingDirectory, "between-read.txt"), "changed\n");
            } else {
              await writeFile(
                join(request.workingDirectory, "README.md"),
                `change-${String(mutationCount)}\n`,
              );
            }
          }
          return result;
        },
      };
      const manager = createManager(git, environment, environment.leaseStore, OWNER_INITIAL);
      const ready = await manager.create(workspaceInput(repository, attempt, 0x84, 0x85));
      captureTarget.path = ready.workspacePath;
      mode = "once";
      const stable = await manager.captureStatus({ attemptId: attempt });
      expect(new TextDecoder().decode(stable.porcelainV2)).toContain("between-read.txt");
      expect(mutationCount).toBe(1);
      mode = "continuous";
      mutationCount = 0;
      await expect(manager.captureStatus({ attemptId: attempt })).rejects.toMatchObject({
        code: "workspace_changed",
      });
      expect(mutationCount).toBe(6);
    } finally {
      await disposeEnvironment(environment);
      await fixture.dispose();
    }
  }, 15_000);
});

function createManager(
  git: GitProcess,
  environment: TestEnvironment,
  leaseStore: GitMutationLeaseStore,
  ownerId: string,
) {
  return createWorkspaceManager({
    git,
    workspaceRegistry: environment.workspaceRegistry,
    repositoryRegistry: environment.repositoryRegistry,
    gitMutationLeaseStore: leaseStore,
    clock: environment.clock,
    ownerId,
    leaseDurationMs: LEASE_DURATION_MS,
    leasePollIntervalMs: 1,
    leaseWaitTimeoutMs: 1_000,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

function workspaceInput(
  repository: RepositoryId,
  attempt: AttemptId,
  treeNumber: number | TaskTreeId,
  nodeNumber: number | TaskNodeId,
): WorkspaceCreateInput {
  const tree = typeof treeNumber === "number" ? taskTreeId(uuid(treeNumber)) : treeNumber;
  const node = typeof nodeNumber === "number" ? taskNodeId(uuid(nodeNumber)) : nodeNumber;
  return {
    attemptId: attempt,
    nodeId: node,
    treeId: tree,
    hostId: HOST,
    repositoryId: repository,
    ordinal: 1,
  };
}

function repositorySeed(
  fixture: GitFixture,
  repository: RepositoryId,
  commandNumber: number,
  attempts: readonly AttemptSeed[],
): RepositorySeed {
  return { fixture, repositoryId: repository, commandId: uuid(commandNumber), attempts };
}

function attemptSeed(
  repository: RepositoryId,
  fixture: GitFixture,
  attemptNumber: number,
  nodeNumber: number,
  treeNumber: number,
  revisionNumber: number,
  ordinal: number,
): AttemptSeed {
  return {
    attemptId: attemptId(uuid(attemptNumber)),
    nodeId: taskNodeId(uuid(nodeNumber)),
    treeId: taskTreeId(uuid(treeNumber)),
    planRevisionId: uuid(revisionNumber),
    ordinal,
    repositoryId: repository,
    baseCommit: fixture.baseCommit,
  };
}

async function createEnvironment(seeds: readonly RepositorySeed[]): Promise<TestEnvironment> {
  const clock = new AdvancingClock(INITIAL_TIME);
  const temporary = await TemporarySqliteDatabase.create("host", clock);
  const notifier = createEventCommitWaiter();
  try {
    const commandStore = createSqliteCommandStore({
      database: temporary.database,
      ports: {
        clock,
        ids: new SequenceIdGenerator(
          Array.from({ length: 128 }, (_, index) => uuid(0x100 + index)),
        ),
      },
      notifier,
    });
    const repositoryRegistry = createRepositoryRegistry({
      database: temporary.database,
      commandStore,
      hostId: HOST,
    });
    const registrations = new Map<RepositoryId, RepositoryRegistration>();
    for (const seed of seeds) {
      const registration = await repositoryRegistry.register({
        request: create(RegisterRepositoryRequestSchema, {
          commandId: seed.commandId,
          actorSessionId: ACTOR,
          repositoryId: seed.repositoryId,
          rootPath: seed.fixture.root,
        }),
        inspection: await inspectRepository(seed.fixture.root),
        allowedWorkspaceRoot: join(seed.fixture.directory, "workspaces"),
        registeredAt: clock.now(),
      });
      registrations.set(seed.repositoryId, registration);
    }
    await temporary.database.write((transaction) => {
      for (const seed of seeds) {
        for (const attempt of seed.attempts) {
          transaction.run(
            `INSERT INTO trees (
               id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
               root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
            [
              attempt.treeId,
              attempt.repositoryId,
              HOST,
              attempt.baseCommit,
              "workspace fencing regression",
              attempt.planRevisionId,
              attempt.nodeId,
              clock.now(),
              clock.now(),
            ],
          );
          transaction.run(
            `INSERT INTO plan_revisions (
               id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
               approved_at_ms, superseded_at_ms
             ) VALUES (?, ?, 1, ?, 'approved', 0, ?, ?, NULL)`,
            [
              attempt.planRevisionId,
              attempt.treeId,
              "workspace fencing regression",
              clock.now(),
              clock.now(),
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
              attempt.nodeId,
              attempt.treeId,
              attempt.repositoryId,
              HOST,
              attempt.planRevisionId,
              "workspace fencing node",
              clock.now(),
              clock.now(),
            ],
          );
          transaction.run(
            `INSERT INTO attempts (
               id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
               state_kind, version, started_at_ms, finished_at_ms, evidence_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL, NULL)`,
            [
              attempt.attemptId,
              attempt.nodeId,
              attempt.treeId,
              attempt.repositoryId,
              HOST,
              attempt.planRevisionId,
              attempt.ordinal,
              clock.now(),
            ],
          );
        }
      }
    });
    return {
      clock,
      temporary,
      notifier,
      repositoryRegistry,
      workspaceRegistry: createSqliteWorkspaceRegistry({ database: temporary.database }),
      leaseStore: createSqliteGitMutationLeaseStore({ database: temporary.database }),
      registrations,
    };
  } catch (error: unknown) {
    notifier.close();
    await temporary.dispose();
    throw error;
  }
}

async function requestCleanup(
  environment: TestEnvironment,
  receipt: WorkspaceReceipt,
  ownerId: string,
): Promise<void> {
  const lease = await environment.leaseStore.acquire({
    repositoryId: receipt.repositoryId,
    ownerId,
    acquiredAt: environment.clock.now(),
    leaseDurationMs: LEASE_DURATION_MS,
  });
  try {
    await environment.workspaceRegistry.requestCleanup({
      attemptId: receipt.attemptId,
      expectedVersion: receipt.version,
      cleanupRequestedAt: environment.clock.now(),
      ownerId,
      fencingToken: lease.fencingToken,
      observedAt: environment.clock.now(),
    });
  } finally {
    await environment.leaseStore.release({
      repositoryId: receipt.repositoryId,
      ownerId,
      fencingToken: lease.fencingToken,
      releasedAt: environment.clock.now(),
    });
  }
}

function requireRegistration(
  environment: TestEnvironment,
  repository: RepositoryId,
): RepositoryRegistration {
  const registration = environment.registrations.get(repository);
  if (registration === undefined) throw new Error(`missing repository registration ${repository}`);
  return registration;
}

async function disposeEnvironment(environment: TestEnvironment | undefined): Promise<void> {
  if (environment === undefined) return;
  environment.notifier.close();
  await environment.temporary.dispose();
}

function createDeferred(): Deferred {
  let resolvePromise: (value?: undefined) => void = () => {
    throw new Error("deferred resolver was not initialized");
  };
  const promise = new Promise<undefined>((resolve) => {
    resolvePromise = (value?: undefined) => {
      resolve(value);
    };
  });
  return { promise, resolve: resolvePromise };
}

function rejectBeforeBarrier(operation: Promise<unknown>): Promise<never> {
  return operation.then(
    () => {
      throw new Error("operation completed before its barrier");
    },
    (error: unknown) => {
      throw error;
    },
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === code
  );
}

function gitCommandName(request: GitProcessRequest): string | undefined {
  let index = 0;
  while (
    request.arguments[index] === "-c" &&
    request.arguments[index + 1]?.includes("=") === true
  ) {
    index += 2;
  }
  return request.arguments[index];
}

function uuid(number: number): string {
  return `01900000-0000-7000-8000-${number.toString(16).padStart(12, "0")}`;
}
