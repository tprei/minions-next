import { create } from "@bufbuild/protobuf";
import {
  ApprovePlanRequestSchema,
  CreateTreeRequestSchema,
  ImplementationOutputContractSchema,
  PlanNodeMode,
  ProposedNodeSchema,
  ProposePlanRequestSchema,
  RegisterRepositoryRequestSchema,
  TreeBudgetSchema,
} from "@minions/contracts";
import {
  createEventCommitWaiter,
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteCommandStore,
  createSqliteSchedulerStore,
  SqliteSchedulerError,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
  type PlanRegistry,
  type SchedulerStore,
  type SqliteRow,
  type SqliteValue,
} from "@minions/adapters";
import {
  actorSessionId,
  artifactId,
  commandId,
  evidenceId,
  hostId,
  planRevisionId,
  repositoryId,
  schedulerCapacityPolicy,
  schedulerOwnerId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type ArtifactId,
  type CommandId,
  type PlanRevisionId,
  type SchedulerLease,
  type SchedulerOwnerId,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";

const START = 1_700_000_000_000;
const HOST = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY = repositoryId("01900000-0000-7000-8000-000000000002");
const ACTOR = actorSessionId("01900000-0000-7000-8000-000000000003");
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OWNER_A = schedulerOwnerId("scheduler-a");
const OWNER_B = schedulerOwnerId("scheduler-b");
const temporaries: TemporarySqliteDatabase[] = [];

interface NodeSpec {
  readonly id: TaskNodeId;
  readonly parentNodeId: TaskNodeId;
  readonly objective: string;
}
interface PlanSpec {
  readonly treeId: TaskTreeId;
  readonly revisionId: PlanRevisionId;
  readonly activeRevisionId: PlanRevisionId;
  readonly rootNodeId: TaskNodeId;
  readonly rootArtifactId: ArtifactId;
  readonly attentionId: string;
  readonly children: readonly NodeSpec[];
  readonly maxConcurrency: number;
  readonly maxAttemptsPerNode: number;
  readonly at: Timestamp;
  readonly createCommandId: CommandId;
  readonly proposeCommandId: CommandId;
  readonly approveCommandId: CommandId;
}

interface ApprovedPlan {
  readonly spec: PlanSpec;
  readonly nodeIds: readonly TaskNodeId[];
}

interface Fixture {
  readonly temporary: TemporarySqliteDatabase;
  readonly database: ManagedSqliteDatabase;
  readonly writable: TemporarySqliteDatabase["database"];
  readonly registry: PlanRegistry;
  readonly notifier: EventCommitWaiter;
  addPlan(spec: PlanSpec): Promise<ApprovedPlan>;
}

function uuid(seed: number): string {
  return `01900000-0000-7000-8000-${seed.toString(16).padStart(12, "0")}`;
}

function planSpec(
  seed: number,
  children: readonly Readonly<{ offset: number; parentOffset?: number; objective?: string }>[],
  options: Readonly<{
    maxConcurrency?: number;
    maxAttemptsPerNode?: number;
    at?: number;
  }> = {},
): PlanSpec {
  const rootNodeId = taskNodeId(uuid(seed + 2));
  return {
    treeId: taskTreeId(uuid(seed)),
    revisionId: planRevisionId(uuid(seed + 1)),
    activeRevisionId: planRevisionId(uuid(seed + 3)),
    rootNodeId,
    rootArtifactId: artifactId(uuid(seed + 7)),
    attentionId: uuid(seed + 8),
    children: children.map((child) => ({
      id: taskNodeId(uuid(seed + child.offset)),
      parentNodeId: taskNodeId(uuid(seed + (child.parentOffset ?? 2))),
      objective: child.objective ?? `execute node ${String(child.offset)}`,
    })),
    maxConcurrency: options.maxConcurrency ?? 8,
    maxAttemptsPerNode: options.maxAttemptsPerNode ?? 2,
    at: timestampFromEpochMilliseconds(options.at ?? START),
    createCommandId: commandId(uuid(seed + 4)),
    proposeCommandId: commandId(uuid(seed + 5)),
    approveCommandId: commandId(uuid(seed + 6)),
  };
}

function nodeId(plan: ApprovedPlan, index: number): TaskNodeId {
  const id = plan.nodeIds[index];
  if (id === undefined) {
    throw new Error(`scheduler fixture node index ${String(index)} is out of range`);
  }
  return id;
}

function generatedIds(seed: number): readonly string[] {
  return Array.from({ length: 512 }, (_, index) => uuid(seed + 0x1000 + index));
}

async function createFixture(): Promise<Fixture> {
  const temporary = await TemporarySqliteDatabase.create(
    "host",
    new FixedClock(timestampFromEpochMilliseconds(START)),
  );
  temporaries.push(temporary);
  const notifier = createEventCommitWaiter();
  const commandStore = createSqliteCommandStore({
    database: temporary.database,
    ports: {
      clock: new FixedClock(timestampFromEpochMilliseconds(START)),
      ids: new SequenceIdGenerator(generatedIds(0x100000)),
    },
    notifier,
  });
  const repositories = createRepositoryRegistry({
    database: temporary.database,
    commandStore,
    hostId: HOST,
  });
  await repositories.register({
    request: create(RegisterRepositoryRequestSchema, {
      commandId: commandId(uuid(0x100)),
      actorSessionId: ACTOR,
      repositoryId: REPOSITORY,
      rootPath: "/repos/scheduler",
    }),
    inspection: {
      canonicalRoot: "/repos/scheduler",
      canonicalRemote: "https://example.test/scheduler",
      defaultBranch: "main",
      baseCommit: BASE_COMMIT,
      caseSensitive: true,
      submodulePaths: [],
      lfsPaths: [],
      nestedRepositoryPaths: [],
      dirty: false,
    },
    allowedWorkspaceRoot: "/workspaces",
    registeredAt: timestampFromEpochMilliseconds(START),
  });
  const registry = createPlanRegistry({
    database: temporary.database,
    commandStore,
    hostId: HOST,
  });
  return {
    temporary,
    database: temporary.applicationDatabase,
    writable: temporary.database,
    registry,
    notifier,
    async addPlan(spec: PlanSpec): Promise<ApprovedPlan> {
      await registry.create({
        request: create(CreateTreeRequestSchema, {
          commandId: spec.createCommandId,
          actorSessionId: ACTOR,
          repositoryId: REPOSITORY,
          treeId: spec.treeId,
          planRevisionId: spec.revisionId,
          rootNodeId: spec.rootNodeId,
          rootArtifactId: spec.rootArtifactId,
          goal: "run scheduler integration plan",
          baseCommit: BASE_COMMIT,
          budget: create(TreeBudgetSchema, {
            maxDepth: 8,
            maxFanOut: 16,
            maxNodes: Math.max(spec.children.length + 1, spec.maxConcurrency),
            maxConcurrency: spec.maxConcurrency,
            maxAttemptsPerNode: spec.maxAttemptsPerNode,
          }),
          attentionId: spec.attentionId,
          rootAllowedRepositoryPaths: ["."],
          rootCheckProfile: "scheduler-root",
        }),
        at: spec.at,
      });
      await registry.propose({
        request: create(ProposePlanRequestSchema, {
          commandId: spec.proposeCommandId,
          actorSessionId: ACTOR,
          treeId: spec.treeId,
          planRevisionId: spec.activeRevisionId,
          goal: "run scheduler integration plan",
          nodes: spec.children.map((node) =>
            create(ProposedNodeSchema, {
              nodeId: node.id,
              parentNodeId: node.parentNodeId,
              mode: PlanNodeMode.IMPLEMENTATION,
              objective: node.objective,
              acceptanceCriteria: [`${node.objective} succeeds`],
              inputs: [],
              outputContract: {
                case: "implementation",
                value: create(ImplementationOutputContractSchema, {}),
              },
              allowedRepositoryPaths: ["."],
              checkProfile: "scheduler-node",
            }),
          ),
        }),
        at: timestampFromEpochMilliseconds(Number(spec.at) + 1),
      });
      await registry.approve({
        request: create(ApprovePlanRequestSchema, {
          commandId: spec.approveCommandId,
          actorSessionId: ACTOR,
          treeId: spec.treeId,
          planRevisionId: spec.activeRevisionId,
        }),
        at: timestampFromEpochMilliseconds(Number(spec.at) + 2),
      });
      return { spec, nodeIds: spec.children.map((node) => node.id) };
    },
  };
}

async function createDraftPlan(fixture: Fixture, spec: PlanSpec): Promise<void> {
  await fixture.registry.create({
    request: create(CreateTreeRequestSchema, {
      commandId: spec.createCommandId,
      actorSessionId: ACTOR,
      repositoryId: REPOSITORY,
      treeId: spec.treeId,
      planRevisionId: spec.revisionId,
      rootNodeId: spec.rootNodeId,
      rootArtifactId: spec.rootArtifactId,
      goal: "run scheduler integration plan",
      baseCommit: BASE_COMMIT,
      budget: create(TreeBudgetSchema, {
        maxDepth: 8,
        maxFanOut: 16,
        maxNodes: Math.max(spec.children.length + 1, spec.maxConcurrency),
        maxConcurrency: spec.maxConcurrency,
        maxAttemptsPerNode: spec.maxAttemptsPerNode,
      }),
      attentionId: spec.attentionId,
      rootAllowedRepositoryPaths: ["."],
      rootCheckProfile: "scheduler-root",
    }),
    at: spec.at,
  });
  await fixture.registry.propose({
    request: create(ProposePlanRequestSchema, {
      commandId: spec.proposeCommandId,
      actorSessionId: ACTOR,
      treeId: spec.treeId,
      planRevisionId: spec.activeRevisionId,
      goal: "run scheduler integration plan",
      nodes: spec.children.map((node) =>
        create(ProposedNodeSchema, {
          nodeId: node.id,
          parentNodeId: node.parentNodeId,
          mode: PlanNodeMode.IMPLEMENTATION,
          objective: node.objective,
          acceptanceCriteria: [`${node.objective} succeeds`],
          inputs: [],
          outputContract: {
            case: "implementation",
            value: create(ImplementationOutputContractSchema, {}),
          },
          allowedRepositoryPaths: ["."],
          checkProfile: "scheduler-node",
        }),
      ),
    }),
    at: timestampFromEpochMilliseconds(Number(spec.at) + 2),
  });
}

function row(
  database: ManagedSqliteDatabase,
  sql: string,
  parameters: readonly SqliteValue[] = [],
): SqliteRow | undefined {
  return database.read((reader) => reader.get(sql, parameters));
}

function rows(
  database: ManagedSqliteDatabase,
  sql: string,
  parameters: readonly SqliteValue[] = [],
): readonly SqliteRow[] {
  return database.read((reader) => reader.all(sql, parameters));
}

function scheduler(fixture: Fixture, idsSeed: number): SchedulerStore {
  return createSqliteSchedulerStore({
    database: fixture.database,
    ids: new SequenceIdGenerator(generatedIds(idsSeed)),
  });
}

function claimRequest(ownerId: SchedulerOwnerId, at: number, duration = 100, global = 8, tree = 8) {
  return {
    ownerId,
    at: timestampFromEpochMilliseconds(at),
    leaseDurationMs: duration,
    capacity: schedulerCapacityPolicy(global, tree),
  };
}

function leaseRef(lease: SchedulerLease, ownerId = lease.ownerId, fence = lease.fencingToken) {
  return { id: lease.id, ownerId, fencingToken: fence };
}

function requireLease(lease: SchedulerLease | undefined): SchedulerLease {
  if (lease === undefined) {
    throw new Error("scheduler did not return an expected lease");
  }
  return lease;
}

async function finishAttempt(
  fixture: Fixture,
  lease: SchedulerLease,
  state: "succeeded" | "failed",
  at: number,
): Promise<void> {
  const evidence = evidenceId(uuid(0x200000 + Number(lease.fencingToken)));
  await fixture.writable.write((transaction) => {
    transaction.run(
      "UPDATE attempts SET state_kind = ?, finished_at_ms = ?, evidence_id = ?, version = version + 1 WHERE id = ?",
      [state, at, evidence, lease.attemptId],
    );
    if (state === "succeeded") {
      transaction.run(
        `UPDATE nodes
            SET state_kind = 'succeeded', outcome_kind = 'no_change', outcome_evidence_id = ?,
                outcome_explanation = 'completed by integration fixture', version = version + 1,
                updated_at_ms = ?
          WHERE id = ?`,
        [evidence, at, lease.nodeId],
      );
    } else {
      transaction.run(
        `UPDATE nodes
            SET state_kind = 'failed', terminal_evidence_id = ?, version = version + 1,
                updated_at_ms = ?
          WHERE id = ?`,
        [evidence, at, lease.nodeId],
      );
    }
  });
}

async function expectSchedulerError(
  operation: Promise<unknown>,
  code: SqliteSchedulerError["code"],
): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(SqliteSchedulerError);
  expect(error).toMatchObject({ code });
}

afterEach(async () => {
  for (const temporary of temporaries.splice(0)) {
    await temporary.dispose();
  }
});

describe("SQLite scheduler leases", () => {
  it("lets two independent owners race to one durable lease", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(planSpec(0x1000, [{ offset: 10 }]));
    const first = scheduler(fixture, 0x300000);
    const second = scheduler(fixture, 0x310000);

    const [a, b] = await Promise.all([
      first.claimNext(claimRequest(OWNER_A, START + 10)),
      second.claimNext(claimRequest(OWNER_B, START + 10)),
    ]);
    const claimed = [a, b].filter((lease): lease is SchedulerLease => lease !== undefined);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.nodeId).toBe(nodeId(plan, 0));
    expect(
      rows(fixture.database, "SELECT id FROM scheduler_leases WHERE state_kind = 'active'"),
    ).toHaveLength(1);
    expect(
      rows(fixture.database, "SELECT id FROM attempts WHERE state_kind = 'active'"),
    ).toHaveLength(1);
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 0)]),
    ).toEqual({
      state_kind: "active",
    });
  });

  it("orders eligible siblings deterministically and enforces global, per-tree, and persisted capacity", async () => {
    const fixture = await createFixture();
    const firstPlan = await fixture.addPlan(
      planSpec(0x2000, [{ offset: 12 }, { offset: 11 }, { offset: 10 }], { maxConcurrency: 2 }),
    );
    const secondPlan = await fixture.addPlan(
      planSpec(0x3000, [{ offset: 10 }, { offset: 11 }], { maxConcurrency: 8 }),
    );
    const store = scheduler(fixture, 0x320000);
    const capacity = (owner: SchedulerOwnerId) => claimRequest(owner, START + 20, 100, 3, 3);

    const first = await store.claimNext(capacity(OWNER_A));
    const second = await store.claimNext(capacity(OWNER_A));
    const third = await store.claimNext(capacity(OWNER_A));
    const fourth = await store.claimNext(capacity(OWNER_A));

    expect(first?.nodeId).toBe(nodeId(firstPlan, 2));
    expect(second?.nodeId).toBe(nodeId(firstPlan, 1));
    expect(third?.nodeId).toBe(nodeId(secondPlan, 0));
    expect(fourth).toBeUndefined();
    expect(
      rows(fixture.database, "SELECT id FROM scheduler_leases WHERE state_kind = 'active'"),
    ).toHaveLength(3);
    expect(
      row(
        fixture.database,
        "SELECT count(*) AS count FROM scheduler_leases WHERE state_kind = 'active' AND tree_id = ?",
        [firstPlan.spec.treeId],
      ),
    ).toEqual({ count: 2n });
    expect(
      row(
        fixture.database,
        "SELECT count(*) AS count FROM scheduler_leases WHERE state_kind = 'active' AND tree_id = ?",
        [secondPlan.spec.treeId],
      ),
    ).toEqual({ count: 1n });
  });

  it("does not claim a child until its parent succeeds", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(
      planSpec(0x4000, [{ offset: 10 }, { offset: 11, parentOffset: 10 }]),
    );
    const store = scheduler(fixture, 0x330000);
    const parent = await store.claimNext(claimRequest(OWNER_A, START + 30));
    expect(parent?.nodeId).toBe(nodeId(plan, 0));
    expect(await store.claimNext(claimRequest(OWNER_A, START + 31))).toBeUndefined();
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 1)]),
    ).toEqual({
      state_kind: "planned",
    });

    await finishAttempt(fixture, requireLease(parent), "succeeded", START + 40);
    const child = await store.claimNext(claimRequest(OWNER_A, START + 41));
    expect(child?.nodeId).toBe(nodeId(plan, 1));
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 1)]),
    ).toEqual({
      state_kind: "active",
    });
  });

  it("blocks descendants after parent expiry failure while an unrelated sibling continues", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(
      planSpec(0x5000, [{ offset: 10 }, { offset: 11, parentOffset: 10 }, { offset: 12 }], {
        maxAttemptsPerNode: 1,
      }),
    );
    const store = scheduler(fixture, 0x340000);
    const parent = await store.claimNext(claimRequest(OWNER_A, START + 50, 20));
    expect(parent?.nodeId).toBe(nodeId(plan, 0));
    const recovery = await store.recoverExpired(timestampFromEpochMilliseconds(START + 70));

    expect(recovery).toEqual([
      expect.objectContaining({
        leaseId: parent?.id,
        attemptId: parent?.attemptId,
        nodeId: parent?.nodeId,
        recovered: true,
        retryScheduled: false,
      }),
    ]);
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 0)]),
    ).toEqual({
      state_kind: "failed",
    });
    expect(
      row(
        fixture.database,
        "SELECT state_kind, blocker_kind, blocker_parent_node_id FROM nodes WHERE id = ?",
        [nodeId(plan, 1)],
      ),
    ).toEqual({
      state_kind: "blocked",
      blocker_kind: "parent",
      blocker_parent_node_id: nodeId(plan, 0),
    });
    const sibling = await store.claimNext(claimRequest(OWNER_B, START + 71));
    expect(sibling?.nodeId).toBe(nodeId(plan, 2));
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 2)]),
    ).toEqual({
      state_kind: "active",
    });
  });

  it("requires an unarchived tree with an approved active revision", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(planSpec(0x5800, [{ offset: 10 }]));
    const store = scheduler(fixture, 0x345000);
    await fixture.writable.write((transaction) => {
      transaction.run("UPDATE trees SET archived_at_ms = ? WHERE id = ?", [
        START + 1,
        plan.spec.treeId,
      ]);
      transaction.run(
        "UPDATE plan_revisions SET state_kind = 'draft', approved_at_ms = NULL WHERE id = ?",
        [plan.spec.activeRevisionId],
      );
    });
    expect(await store.claimNext(claimRequest(OWNER_A, START + 72))).toBeUndefined();
    expect(
      row(fixture.database, "SELECT archived_at_ms FROM trees WHERE id = ?", [plan.spec.treeId]),
    ).toEqual({
      archived_at_ms: BigInt(START + 1),
    });
    expect(
      row(fixture.database, "SELECT state_kind FROM plan_revisions WHERE id = ?", [
        plan.spec.activeRevisionId,
      ]),
    ).toEqual({
      state_kind: "draft",
    });
    await fixture.writable.write((transaction) => {
      transaction.run("UPDATE trees SET archived_at_ms = NULL WHERE id = ?", [plan.spec.treeId]);
      transaction.run(
        "UPDATE plan_revisions SET state_kind = 'approved', approved_at_ms = ? WHERE id = ?",
        [START + 2, plan.spec.activeRevisionId],
      );
    });
    const lease = await store.claimNext(claimRequest(OWNER_A, START + 73));
    expect(lease?.nodeId).toBe(nodeId(plan, 0));
    if (lease === undefined) {
      throw new Error("scheduler eligibility claim did not return a lease");
    }
    expect(
      row(fixture.database, "SELECT state_kind FROM scheduler_leases WHERE id = ?", [lease.id]),
    ).toEqual({
      state_kind: "active",
    });
  });

  it("keeps proposed children planned until their revision is approved", async () => {
    const fixture = await createFixture();
    const spec = planSpec(0xc000, [{ offset: 10 }]);
    await createDraftPlan(fixture, spec);
    const plan: ApprovedPlan = { spec, nodeIds: spec.children.map((node) => node.id) };
    const rootEvidence = evidenceId(uuid(0xc010));
    await fixture.writable.write((transaction) => {
      transaction.run(
        `UPDATE nodes
            SET state_kind = 'succeeded', outcome_kind = 'artifact',
                outcome_artifact_id = ?, outcome_content_hash = ?, outcome_artifact_type = 'plan',
                outcome_evidence_id = ?, version = version + 1, updated_at_ms = ?
          WHERE id = ?`,
        [spec.rootArtifactId, "a".repeat(64), rootEvidence, START + 1, spec.rootNodeId],
      );
    });
    const store = scheduler(fixture, 0x3a0000);
    expect(await store.claimNext(claimRequest(OWNER_A, START + 3))).toBeUndefined();
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 0)]),
    ).toEqual({
      state_kind: "planned",
    });
    await fixture.writable.write((transaction) => {
      transaction.run(
        `UPDATE nodes
            SET state_kind = 'planned', outcome_kind = NULL, outcome_artifact_id = NULL,
                outcome_content_hash = NULL, outcome_artifact_type = NULL, outcome_commit = NULL,
                outcome_evidence_id = NULL, outcome_explanation = NULL, terminal_evidence_id = NULL,
                version = version + 1, updated_at_ms = ?
          WHERE id = ?`,
        [START + 2, spec.rootNodeId],
      );
    });
    await fixture.registry.approve({
      request: create(ApprovePlanRequestSchema, {
        commandId: spec.approveCommandId,
        actorSessionId: ACTOR,
        treeId: spec.treeId,
        planRevisionId: spec.activeRevisionId,
      }),
      at: timestampFromEpochMilliseconds(START + 4),
    });
    const lease = await store.claimNext(claimRequest(OWNER_A, START + 5));
    expect(lease?.nodeId).toBe(nodeId(plan, 0));
    if (lease === undefined) {
      throw new Error("approved scheduler child was not claimed");
    }
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [lease.nodeId]),
    ).toEqual({
      state_kind: "active",
    });
  });

  it("supports polling-equivalent repeated claims without notifications", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(
      planSpec(0x6000, [{ offset: 10 }, { offset: 11 }], { maxAttemptsPerNode: 3 }),
    );
    const store = scheduler(fixture, 0x350000);

    const first = await store.claimNext(claimRequest(OWNER_A, START + 80));
    expect(first?.nodeId).toBe(nodeId(plan, 0));
    await store.release({
      lease: leaseRef(requireLease(first)),
      at: timestampFromEpochMilliseconds(START + 81),
    });
    const second = await store.claimNext(claimRequest(OWNER_A, START + 82));
    expect(second?.nodeId).toBe(nodeId(plan, 0));
    await store.release({
      lease: leaseRef(requireLease(second)),
      at: timestampFromEpochMilliseconds(START + 83),
    });
    const third = await store.claimNext(claimRequest(OWNER_A, START + 84));
    expect(third?.nodeId).toBe(nodeId(plan, 0));
    expect(
      rows(fixture.database, "SELECT state_kind FROM scheduler_leases ORDER BY fencing_token"),
    ).toEqual([{ state_kind: "released" }, { state_kind: "released" }, { state_kind: "active" }]);
  });

  it("heartbeats, rejects pre-expiry recovery, then recovers an expired lease for retry", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(
      planSpec(0x7000, [{ offset: 10 }], { maxAttemptsPerNode: 2 }),
    );
    const store = scheduler(fixture, 0x360000);
    const lease = requireLease(await store.claimNext(claimRequest(OWNER_A, START + 90, 100)));
    const heartbeat = await store.heartbeat({
      lease: leaseRef(lease),
      at: timestampFromEpochMilliseconds(START + 120),
      leaseDurationMs: 100,
    });

    expect(heartbeat.heartbeatAt).toBe(timestampFromEpochMilliseconds(START + 120));
    expect(heartbeat.expiresAt).toBe(timestampFromEpochMilliseconds(START + 220));
    expect(await store.recoverExpired(timestampFromEpochMilliseconds(START + 219))).toEqual([]);
    const recovered = await store.recoverExpired(timestampFromEpochMilliseconds(START + 220));
    expect(recovered).toEqual([
      expect.objectContaining({
        leaseId: lease.id,
        attemptId: lease.attemptId,
        recovered: true,
        retryScheduled: true,
      }),
    ]);
    expect(
      row(fixture.database, "SELECT state_kind, ordinal, evidence_id FROM attempts WHERE id = ?", [
        lease.attemptId,
      ]),
    ).toMatchObject({
      state_kind: "failed",
      ordinal: 1n,
    });
    expect(
      row(fixture.database, "SELECT state_kind FROM scheduler_leases WHERE id = ?", [lease.id]),
    ).toEqual({
      state_kind: "expired",
    });
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 0)]),
    ).toEqual({
      state_kind: "ready",
    });
    const retry = await store.claimNext(claimRequest(OWNER_B, START + 221));
    expect(retry?.nodeId).toBe(nodeId(plan, 0));
    expect(retry?.fencingToken).toBe(2n);
    expect(
      rows(
        fixture.database,
        "SELECT ordinal, state_kind FROM attempts WHERE node_id = ? ORDER BY ordinal",
        [nodeId(plan, 0)],
      ),
    ).toEqual([
      { ordinal: 1n, state_kind: "failed" },
      { ordinal: 2n, state_kind: "active" },
    ]);
  });

  it("recoverExpired releases an active harness process lease instead of rolling back", async () => {
    // The 0005 trigger attempt_terminal_state_requires_released_harness_lease
    // rejects any UPDATE that moves attempts.state_kind off 'active' while an
    // active harness_process_leases row still references it. Every running
    // attempt owns one; without releasing it first, finishActiveAttempt threw,
    // the whole recovery transaction rolled back, and the lease/attempt/node
    // stayed active forever (capacity permanently blocked, no retry
    // scheduled).
    const fixture = await createFixture();
    const plan = await fixture.addPlan(planSpec(0x7100, [{ offset: 10 }]));
    const store = scheduler(fixture, 0x361000);
    const lease = requireLease(await store.claimNext(claimRequest(OWNER_A, START + 90, 100)));

    const harnessKind = "codex";
    const providerKind = "openai";
    const model = "gpt-5";
    const policyDigest = "a".repeat(64);
    const durableHarnessId = "dh-0000000000000000000000000000000001";
    const sessionId = "sess-0000000000000000000000000000000001";
    const harnessLeaseId = "01900000-0000-7000-8000-0000000f0001";
    await fixture.writable.write((transaction) => {
      transaction.run(
        `INSERT INTO harness_bindings
           (attempt_id, harness_kind, provider_kind, model, session_id, policy_digest, established_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [lease.attemptId, harnessKind, providerKind, model, sessionId, policyDigest, START],
      );
      transaction.run(
        `INSERT INTO node_harness_bindings
           (node_id, harness_kind, provider_kind, durable_harness_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
        [lease.nodeId, harnessKind, providerKind, durableHarnessId, START],
      );
      transaction.run(
        `INSERT INTO harness_attempt_snapshots
           (attempt_id, node_id, durable_harness_id, harness_version, model, reasoning_level,
            capabilities_json, tools_json, security_policy_digest, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)`,
        [
          lease.attemptId,
          lease.nodeId,
          durableHarnessId,
          "1.0.0",
          model,
          "high",
          policyDigest,
          START,
        ],
      );
      transaction.run(
        `INSERT INTO harness_process_leases
           (id, attempt_id, node_id, session_id, process_id, state_kind, acquired_at_ms)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [harnessLeaseId, lease.attemptId, lease.nodeId, sessionId, "proc-1", START],
      );
    });

    // Without the fix, this call throws (the transaction aborts on the
    // 'harness process lease identity is immutable'-adjacent terminal-state
    // trigger) instead of returning a recovered result.
    const recovered = await store.recoverExpired(timestampFromEpochMilliseconds(START + 220));
    expect(recovered).toEqual([
      expect.objectContaining({ leaseId: lease.id, recovered: true, retryScheduled: true }),
    ]);
    expect(
      row(
        fixture.database,
        "SELECT state_kind, released_at_ms FROM harness_process_leases WHERE id = ?",
        [harnessLeaseId],
      ),
    ).toEqual({ state_kind: "released", released_at_ms: BigInt(START + 220) });
    expect(
      row(fixture.database, "SELECT state_kind FROM attempts WHERE id = ?", [lease.attemptId]),
    ).toEqual({ state_kind: "failed" });
  });

  it("cancelNode releases an active harness process lease instead of rolling back", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(planSpec(0x7200, [{ offset: 10 }]));
    const store = scheduler(fixture, 0x362000);
    const lease = requireLease(await store.claimNext(claimRequest(OWNER_A, START + 90, 100)));

    const harnessKind = "codex";
    const providerKind = "openai";
    const model = "gpt-5";
    const policyDigest = "b".repeat(64);
    const durableHarnessId = "dh-0000000000000000000000000000000002";
    const sessionId = "sess-0000000000000000000000000000000002";
    const harnessLeaseId = "01900000-0000-7000-8000-0000000f0002";
    await fixture.writable.write((transaction) => {
      transaction.run(
        `INSERT INTO harness_bindings
           (attempt_id, harness_kind, provider_kind, model, session_id, policy_digest, established_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [lease.attemptId, harnessKind, providerKind, model, sessionId, policyDigest, START],
      );
      transaction.run(
        `INSERT INTO node_harness_bindings
           (node_id, harness_kind, provider_kind, durable_harness_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
        [lease.nodeId, harnessKind, providerKind, durableHarnessId, START],
      );
      transaction.run(
        `INSERT INTO harness_attempt_snapshots
           (attempt_id, node_id, durable_harness_id, harness_version, model, reasoning_level,
            capabilities_json, tools_json, security_policy_digest, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)`,
        [
          lease.attemptId,
          lease.nodeId,
          durableHarnessId,
          "1.0.0",
          model,
          "high",
          policyDigest,
          START,
        ],
      );
      transaction.run(
        `INSERT INTO harness_process_leases
           (id, attempt_id, node_id, session_id, process_id, state_kind, acquired_at_ms)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [harnessLeaseId, lease.attemptId, lease.nodeId, sessionId, "proc-2", START],
      );
    });

    // Without the fix, this throws instead of cancelling.
    await store.cancelNode({
      nodeId: lease.nodeId,
      at: timestampFromEpochMilliseconds(START + 150),
      evidenceId: evidenceId(uuid(0xc020)),
    });
    expect(
      row(
        fixture.database,
        "SELECT state_kind, released_at_ms FROM harness_process_leases WHERE id = ?",
        [harnessLeaseId],
      ),
    ).toEqual({ state_kind: "released", released_at_ms: BigInt(START + 150) });
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [lease.nodeId]),
    ).toEqual({ state_kind: "cancelled" });
  });

  it("rejects stale owner and fencing references for heartbeat and release", async () => {
    const fixture = await createFixture();
    await fixture.addPlan(planSpec(0x8000, [{ offset: 10 }]));
    const store = scheduler(fixture, 0x370000);
    const lease = requireLease(await store.claimNext(claimRequest(OWNER_A, START + 230)));

    await expectSchedulerError(
      store.heartbeat({
        lease: leaseRef(lease, OWNER_B),
        at: timestampFromEpochMilliseconds(START + 231),
        leaseDurationMs: 100,
      }),
      "stale_lease",
    );
    await expectSchedulerError(
      store.release({
        lease: leaseRef(lease, OWNER_A, 99n as SchedulerLease["fencingToken"]),
        at: timestampFromEpochMilliseconds(START + 232),
      }),
      "stale_lease",
    );
    await store.release({
      lease: leaseRef(lease),
      at: timestampFromEpochMilliseconds(START + 233),
    });
    await expectSchedulerError(
      store.heartbeat({
        lease: leaseRef(lease),
        at: timestampFromEpochMilliseconds(START + 234),
        leaseDurationMs: 100,
      }),
      "expired_lease",
    );
    expect(
      row(fixture.database, "SELECT state_kind FROM scheduler_leases WHERE id = ?", [lease.id]),
    ).toEqual({
      state_kind: "released",
    });
  });

  it("exhausts node retry budget and leaves both attempts and node terminal", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(
      planSpec(0x9000, [{ offset: 10 }], { maxAttemptsPerNode: 2 }),
    );
    const store = scheduler(fixture, 0x380000);
    const first = requireLease(await store.claimNext(claimRequest(OWNER_A, START + 240, 10)));
    expect(await store.recoverExpired(timestampFromEpochMilliseconds(START + 250))).toEqual([
      expect.objectContaining({ leaseId: first.id, recovered: true, retryScheduled: true }),
    ]);
    const second = requireLease(await store.claimNext(claimRequest(OWNER_A, START + 251, 10)));
    expect(second.fencingToken).toBe(2n);
    expect(await store.recoverExpired(timestampFromEpochMilliseconds(START + 261))).toEqual([
      expect.objectContaining({ leaseId: second.id, recovered: true, retryScheduled: false }),
    ]);
    expect(await store.claimNext(claimRequest(OWNER_B, START + 262))).toBeUndefined();
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 0)]),
    ).toEqual({
      state_kind: "failed",
    });
    expect(
      rows(
        fixture.database,
        "SELECT ordinal, state_kind FROM attempts WHERE node_id = ? ORDER BY ordinal",
        [nodeId(plan, 0)],
      ),
    ).toEqual([
      { ordinal: 1n, state_kind: "failed" },
      { ordinal: 2n, state_kind: "failed" },
    ]);
  });

  it("cancels a lease, attempt, node, and descendants atomically", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(
      planSpec(0xa000, [{ offset: 10 }, { offset: 11, parentOffset: 10 }]),
    );
    const store = scheduler(fixture, 0x390000);
    const lease = requireLease(await store.claimNext(claimRequest(OWNER_A, START + 270)));
    const evidence = evidenceId(uuid(0x3a0000));
    await store.cancelNode({
      nodeId: lease.nodeId,
      evidenceId: evidence,
      at: timestampFromEpochMilliseconds(START + 271),
    });

    expect(
      row(
        fixture.database,
        "SELECT state_kind, released_at_ms FROM scheduler_leases WHERE id = ?",
        [lease.id],
      ),
    ).toEqual({
      state_kind: "cancelled",
      released_at_ms: BigInt(START + 271),
    });
    expect(
      row(fixture.database, "SELECT state_kind, evidence_id FROM attempts WHERE id = ?", [
        lease.attemptId,
      ]),
    ).toEqual({
      state_kind: "cancelled",
      evidence_id: evidence,
    });
    expect(
      row(fixture.database, "SELECT state_kind, terminal_evidence_id FROM nodes WHERE id = ?", [
        lease.nodeId,
      ]),
    ).toEqual({
      state_kind: "cancelled",
      terminal_evidence_id: evidence,
    });
    expect(
      row(
        fixture.database,
        "SELECT state_kind, blocker_kind, blocker_parent_node_id FROM nodes WHERE id = ?",
        [nodeId(plan, 1)],
      ),
    ).toEqual({
      state_kind: "blocked",
      blocker_kind: "parent",
      blocker_parent_node_id: lease.nodeId,
    });
  });

  it("isolates one failed recovery from a second lease recovery", async () => {
    const fixture = await createFixture();
    const plan = await fixture.addPlan(
      planSpec(0xb000, [{ offset: 10 }, { offset: 11 }], { maxAttemptsPerNode: 2 }),
    );
    const store = scheduler(fixture, 0x3b0000);
    const first = requireLease(await store.claimNext(claimRequest(OWNER_A, START + 280, 10)));
    const second = requireLease(await store.claimNext(claimRequest(OWNER_B, START + 280, 10)));
    await fixture.writable.write((transaction) => {
      transaction.run(
        `UPDATE attempts
            SET state_kind = 'succeeded', finished_at_ms = ?, evidence_id = ?
          WHERE id = ?`,
        [START + 281, evidenceId(uuid(0x3c0000)), first.attemptId],
      );
    });

    const recovery = await store.recoverExpired(timestampFromEpochMilliseconds(START + 290));
    expect(recovery).toHaveLength(2);
    expect(recovery.find((result) => result.leaseId === first.id)).toMatchObject({
      recovered: false,
    });
    expect(recovery.find((result) => result.leaseId === second.id)).toMatchObject({
      recovered: true,
    });
    expect(
      row(fixture.database, "SELECT state_kind FROM scheduler_leases WHERE id = ?", [first.id]),
    ).toEqual({
      state_kind: "expired",
    });
    expect(
      row(fixture.database, "SELECT state_kind FROM scheduler_leases WHERE id = ?", [second.id]),
    ).toEqual({
      state_kind: "expired",
    });
    expect(
      row(fixture.database, "SELECT state_kind FROM nodes WHERE id = ?", [nodeId(plan, 1)]),
    ).toEqual({
      state_kind: "ready",
    });
  });
});
