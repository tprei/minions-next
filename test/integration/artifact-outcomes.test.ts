import { create, fromBinary } from "@bufbuild/protobuf";
import {
  ApprovePlanRequestSchema,
  ArtifactOutputContractSchema,
  CreateTreeRequestSchema,
  ImplementationOutputContractSchema,
  PlanNodeMode,
  ProposedNodeSchema,
  ProposePlanRequestSchema,
  ProjectionChangeSchema,
  RegisterRepositoryRequestSchema,
  TreeBudgetSchema,
} from "@minions/contracts";
import {
  actorSessionId,
  artifactId,
  commandId,
  contentHash,
  evidenceId,
  gitSha,
  hostId,
  nonEmptyText,
  repositoryId,
  schedulerOwnerId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type ArtifactId,
  type ArtifactRegistry,
  type DomainPorts,
  type SchedulerLease,
  type SchedulerStore,
  type TaskNodeId,
  type Timestamp,
} from "@minions/core";
import {
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteArtifactRegistry,
  createSqliteCommandStore,
  createSqliteSchedulerStore,
  type RepositoryInspection,
} from "@minions/adapters";
import { executeTestSqliteWrite } from "@minions/adapters/sqlite-test-support";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";

const BASE_TIME = 1_700_000_000_000;
const BASE_COMMIT = gitSha("0123456789abcdef0123456789abcdef01234567");
const HOST_ID = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY_ID = repositoryId("01900000-0000-7000-8000-000000000002");
const ACTOR_ID = actorSessionId("01900000-0000-7000-8000-000000000003");
const OWNER_ID = schedulerOwnerId("01900000-0000-7000-8000-000000000004");

function id(value: number): string {
  return `01900000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function at(offset: number): Timestamp {
  return timestampFromEpochMilliseconds(BASE_TIME + offset);
}

function generatedIds(start: number, count = 512): readonly string[] {
  return Array.from({ length: count }, (_, index) => id(start + index));
}

type Fixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  registry: ArtifactRegistry;
  scheduler: SchedulerStore;
  rootNodeId: TaskNodeId;
  parentNodeId: TaskNodeId;
  childNodeId: TaskNodeId;
  childArtifactId: ArtifactId;
  secondChildNodeId: TaskNodeId | undefined;
  secondChildArtifactId: ArtifactId | undefined;
}>;
const fixtures: Fixture[] = [];

async function createFixture(
  childKind: "artifact" | "implementation",
  includeSecondArtifact = false,
): Promise<Fixture> {
  const clock = new FixedClock(at(0));
  const temporary = await TemporarySqliteDatabase.create("host", clock);
  const ports: DomainPorts = Object.freeze({
    clock,
    ids: new SequenceIdGenerator(generatedIds(0x1000)),
  });
  const commandStore = createSqliteCommandStore({
    database: temporary.database,
    ports,
    notifier: Object.freeze({ commandCommitted: () => undefined }),
  });
  const repositories = createRepositoryRegistry({
    database: temporary.database,
    commandStore,
    hostId: HOST_ID,
  });
  const inspection: RepositoryInspection = {
    canonicalRoot: "/workspace/minions",
    canonicalRemote: "https://example.test/minions",
    defaultBranch: "main",
    baseCommit: BASE_COMMIT,
    caseSensitive: true,
    submodulePaths: [],
    lfsPaths: [],
    nestedRepositoryPaths: [],
    dirty: false,
  };
  await repositories.register({
    request: create(RegisterRepositoryRequestSchema, {
      commandId: id(0x100),
      actorSessionId: ACTOR_ID,
      repositoryId: REPOSITORY_ID,
      rootPath: inspection.canonicalRoot,
    }),
    inspection,
    allowedWorkspaceRoot: "/workspaces",
    registeredAt: at(0),
  });
  const treeId = taskTreeId(id(0x110));
  const revisionId = id(0x111);
  const rootNodeId = taskNodeId(id(0x112));
  const rootArtifactId = artifactId(id(0x113));
  const parentNodeId = taskNodeId(id(0x114));
  const childNodeId = taskNodeId(id(0x115));
  const childArtifactId = artifactId(id(0x116));
  const secondChildNodeId = taskNodeId(id(0x119));
  const secondChildArtifactId = artifactId(id(0x11a));
  const planRevisionId = id(0x117);
  const plan = createPlanRegistry({ database: temporary.database, commandStore, hostId: HOST_ID });
  await plan.create({
    request: create(CreateTreeRequestSchema, {
      commandId: id(0x120),
      actorSessionId: ACTOR_ID,
      repositoryId: REPOSITORY_ID,
      treeId,
      planRevisionId: revisionId,
      rootNodeId,
      rootArtifactId,
      goal: "artifact outcome integration",
      baseCommit: BASE_COMMIT,
      budget: create(TreeBudgetSchema, {
        maxDepth: 5,
        maxFanOut: 4,
        maxNodes: 8,
        maxConcurrency: 4,
        maxAttemptsPerNode: 2,
      }),
      attentionId: id(0x118),
      rootAllowedRepositoryPaths: ["."],
    }),
    at: at(0),
  });
  await plan.propose({
    request: create(ProposePlanRequestSchema, {
      commandId: id(0x121),
      actorSessionId: ACTOR_ID,
      treeId,
      planRevisionId,
      goal: "artifact outcome integration",
      nodes: [
        create(ProposedNodeSchema, {
          nodeId: parentNodeId,
          parentNodeId: rootNodeId,
          mode: PlanNodeMode.IMPLEMENTATION,
          objective: "produce a parent revision",
          acceptanceCriteria: ["parent work is complete"],
          inputs: [],
          outputContract: {
            case: "implementation",
            value: create(ImplementationOutputContractSchema, {}),
          },
          allowedRepositoryPaths: ["."],
        }),
        create(ProposedNodeSchema, {
          nodeId: childNodeId,
          parentNodeId: parentNodeId,
          mode: childKind === "artifact" ? PlanNodeMode.EXPLORE : PlanNodeMode.IMPLEMENTATION,
          objective: "record a child outcome",
          acceptanceCriteria: ["child work is complete"],
          inputs: [],
          outputContract:
            childKind === "artifact"
              ? {
                  case: "artifact",
                  value: create(ArtifactOutputContractSchema, {
                    artifactId: childArtifactId,
                    artifactType: "report",
                  }),
                }
              : {
                  case: "implementation",
                  value: create(ImplementationOutputContractSchema, {}),
                },
          allowedRepositoryPaths: ["."],
        }),
        ...(includeSecondArtifact
          ? [
              create(ProposedNodeSchema, {
                nodeId: secondChildNodeId,
                parentNodeId,
                mode: PlanNodeMode.EXPLORE,
                objective: "record a second child artifact",
                acceptanceCriteria: ["second child artifact is complete"],
                inputs: [],
                outputContract: {
                  case: "artifact",
                  value: create(ArtifactOutputContractSchema, {
                    artifactId: secondChildArtifactId,
                    artifactType: "report",
                  }),
                },
                allowedRepositoryPaths: ["."],
              }),
            ]
          : []),
      ],
    }),
    at: at(1),
  });
  await plan.approve({
    request: create(ApprovePlanRequestSchema, {
      commandId: id(0x122),
      actorSessionId: ACTOR_ID,
      treeId,
      planRevisionId,
    }),
    at: at(2),
  });
  const scheduler = createSqliteSchedulerStore({
    database: temporary.database,
    ids: new SequenceIdGenerator(generatedIds(0x2000)),
  });
  const parentLease = await scheduler.claimNext({
    ownerId: OWNER_ID,
    at: at(3),
    leaseDurationMs: 10_000,
    capacity: { maxActiveGlobal: 4, maxActivePerTree: 4 },
  });
  if (parentLease?.nodeId !== parentNodeId) {
    throw new Error("parent node was not scheduled");
  }
  const registry = createSqliteArtifactRegistry({
    database: temporary.database,
    commandStore,
    hostId: HOST_ID,
  });
  const fixture: Fixture = {
    temporary,
    registry,
    scheduler,
    rootNodeId,
    parentNodeId,
    childNodeId,
    childArtifactId,
    secondChildNodeId: includeSecondArtifact ? secondChildNodeId : undefined,
    secondChildArtifactId: includeSecondArtifact ? secondChildArtifactId : undefined,
  };
  fixtures.push(fixture);
  return fixture;
}

async function completeParent(fixture: Fixture, revision = BASE_COMMIT): Promise<SchedulerLease> {
  const parentOutcome = await fixture.registry.recordOutcome({
    commandId: commandId(id(0x300)),
    actorSessionId: ACTOR_ID,
    nodeId: fixture.parentNodeId,
    expectedNodeVersion: 2,
    outcome: {
      kind: "commit",
      revision,
      evidenceId: evidenceId(id(0x301)),
    },
    at: at(4),
  });
  expect(parentOutcome.outcome.kind).toBe("commit");
  const childLease = await fixture.scheduler.claimNext({
    ownerId: OWNER_ID,
    at: at(5),
    leaseDurationMs: 10_000,
    capacity: { maxActiveGlobal: 4, maxActivePerTree: 4 },
  });
  if (childLease?.nodeId !== fixture.childNodeId) {
    throw new Error("child node was not scheduled");
  }
  return childLease;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture !== undefined) await fixture.temporary.dispose();
  }
});

describe("artifact registry outcomes", () => {
  it("allows a first-level implementation child to record tree-base no-change", async () => {
    const fixture = await createFixture("implementation");
    const outcome = await fixture.registry.recordOutcome({
      commandId: commandId(id(0x301)),
      actorSessionId: ACTOR_ID,
      nodeId: fixture.parentNodeId,
      expectedNodeVersion: 2,
      outcome: {
        kind: "no_change",
        revision: BASE_COMMIT,
        evidenceId: evidenceId(id(0x302)),
        explanation: nonEmptyText("the root tree is unchanged", "no-change explanation"),
      },
      at: at(4),
    });
    expect(outcome.outcome).toEqual({
      kind: "no_change",
      revision: BASE_COMMIT,
      evidenceId: evidenceId(id(0x302)),
      explanation: "the root tree is unchanged",
    });
    expect(
      fixture.temporary.database.read((reader) =>
        reader.get("SELECT state_kind FROM nodes WHERE id = ?", [fixture.parentNodeId]),
      ),
    ).toEqual({ state_kind: "succeeded" });
    expect(
      fixture.temporary.database.read((reader) =>
        reader.get("SELECT state_kind FROM nodes WHERE id = ?", [fixture.childNodeId]),
      ),
    ).toEqual({ state_kind: "ready" });
    expect(
      fixture.temporary.database.read((reader) =>
        reader.get("SELECT state_kind FROM nodes WHERE id = ?", [fixture.rootNodeId]),
      ),
    ).toEqual({ state_kind: "planned" });
    const event = fixture.temporary.database.read((reader) =>
      reader.get("SELECT event_type, event_payload FROM events ORDER BY sequence DESC LIMIT 1"),
    );
    expect(event?.["event_type"]).toBe(ProjectionChangeSchema.typeName);
    const projection = fromBinary(ProjectionChangeSchema, event?.["event_payload"] as Uint8Array);
    expect(projection.change.case).toBe("batch");
    if (projection.change.case === "batch") {
      expect(projection.change.value.changes.map((change) => change.change.case)).toEqual([
        "nodeOutcomeUpserted",
        "nodeUpserted",
        "nodeUpserted",
      ]);
      const changedNodes = projection.change.value.changes
        .map((change) =>
          change.change.case === "nodeUpserted" ? change.change.value.id : undefined,
        )
        .filter((nodeId): nodeId is string => nodeId !== undefined);
      expect(changedNodes).toEqual([fixture.parentNodeId, fixture.childNodeId]);
    }
  });
  it("records commit and no-change outcomes with inherited revisions", async () => {
    const fixture = await createFixture("implementation");
    const childLease = await completeParent(fixture, BASE_COMMIT);
    const outcome = await fixture.registry.recordOutcome({
      commandId: commandId(id(0x302)),
      actorSessionId: ACTOR_ID,
      nodeId: fixture.childNodeId,
      expectedNodeVersion: 2,
      outcome: {
        kind: "no_change",
        revision: BASE_COMMIT,
        evidenceId: evidenceId(id(0x303)),
        explanation: nonEmptyText("the inherited revision is unchanged", "no-change explanation"),
      },
      at: at(6),
    });
    expect(outcome.outcome).toEqual({
      kind: "no_change",
      revision: BASE_COMMIT,
      evidenceId: evidenceId(id(0x303)),
      explanation: "the inherited revision is unchanged",
    });
    expect(childLease.attemptId).toBeDefined();
    expect(fixture.registry.getOutcome(fixture.childNodeId)).toEqual(outcome);
  });

  it("rejects an unexplained empty no-change outcome and preserves state", async () => {
    const fixture = await createFixture("implementation");
    await completeParent(fixture);
    await expect(
      Promise.resolve().then(() =>
        fixture.registry.recordOutcome({
          commandId: commandId(id(0x304)),
          actorSessionId: ACTOR_ID,
          nodeId: fixture.childNodeId,
          expectedNodeVersion: 2,
          outcome: {
            kind: "no_change",
            revision: BASE_COMMIT,
            evidenceId: evidenceId(id(0x305)),
            explanation: nonEmptyText("", "no-change explanation"),
          },
          at: at(6),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_value" });
    expect(fixture.registry.getOutcome(fixture.childNodeId)).toBeUndefined();
  });

  it("rolls back outcome state, event, and idempotency when metadata commit fails", async () => {
    const fixture = await createFixture("implementation");
    const command = commandId(id(0x30b));
    const eventCount = fixture.temporary.database.read(
      (reader) => reader.get("SELECT count(*) AS count FROM events")?.["count"],
    );
    await executeTestSqliteWrite(fixture.temporary.database, (transaction) => {
      transaction.run("UPDATE nodes SET version = ? WHERE id = ?", [
        9_223_372_036_854_775_807n,
        fixture.childNodeId,
      ]);
    });
    const request = {
      commandId: command,
      actorSessionId: ACTOR_ID,
      nodeId: fixture.parentNodeId,
      expectedNodeVersion: 2,
      outcome: {
        kind: "commit" as const,
        revision: BASE_COMMIT,
        evidenceId: evidenceId(id(0x30c)),
      },
      at: at(4),
    };

    await expect(fixture.registry.recordOutcome(request)).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(fixture.registry.getOutcome(fixture.parentNodeId)).toBeUndefined();
    expect(
      fixture.temporary.database.read((reader) =>
        reader.get("SELECT state_kind, version FROM nodes WHERE id = ?", [fixture.parentNodeId]),
      ),
    ).toEqual({ state_kind: "active", version: 2n });
    expect(
      fixture.temporary.database.read((reader) =>
        reader.get("SELECT id FROM operator_commands WHERE id = ?", [command]),
      ),
    ).toBeUndefined();
    expect(
      fixture.temporary.database.read(
        (reader) => reader.get("SELECT count(*) AS count FROM events")?.["count"],
      ),
    ).toBe(eventCount);

    await executeTestSqliteWrite(fixture.temporary.database, (transaction) => {
      transaction.run("UPDATE nodes SET version = 0 WHERE id = ?", [fixture.childNodeId]);
    });
    await expect(fixture.registry.recordOutcome(request)).resolves.toMatchObject({
      nodeId: fixture.parentNodeId,
      outcome: request.outcome,
    });
  });

  it("stores an artifact, validates its immutable metadata, and projects its outcome", async () => {
    const fixture = await createFixture("artifact");
    const childLease = await completeParent(fixture);
    const digest = contentHash("a".repeat(64));
    const blob = {
      digest,
      sizeBytes: 3n,
      relativePath: nonEmptyText(
        `sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
        "blob relative path",
      ),
      verifiedAt: at(6),
      created: true,
    } as const;
    const artifact = await fixture.registry.create({
      commandId: commandId(id(0x306)),
      actorSessionId: ACTOR_ID,
      artifactId: fixture.childArtifactId,
      nodeId: fixture.childNodeId,
      attemptId: childLease.attemptId,
      expectedNodeVersion: 2,
      mediaType: nonEmptyText("application/json", "artifact media type"),
      artifactType: nonEmptyText("report", "artifact type"),
      evidenceId: evidenceId(id(0x307)),
      retention: "active",
      blob,
      at: at(6),
    });
    expect(artifact.contentDigest).toBe(digest);
    const createEvent = fixture.temporary.database.read((reader) =>
      reader.get("SELECT event_type, event_payload FROM events ORDER BY sequence DESC LIMIT 1"),
    );
    expect(createEvent?.["event_type"]).toBe(ProjectionChangeSchema.typeName);
    const createProjection = fromBinary(
      ProjectionChangeSchema,
      createEvent?.["event_payload"] as Uint8Array,
    );
    expect(createProjection.change.case).toBe("batch");
    if (createProjection.change.case === "batch") {
      expect(createProjection.change.value.changes.map((change) => change.change.case)).toEqual([
        "artifactUpserted",
        "nodeUpserted",
      ]);
      const nodeChange = createProjection.change.value.changes[1];
      if (nodeChange?.change.case === "nodeUpserted") {
        expect(nodeChange.change.value.id).toBe(fixture.childNodeId);
        expect(nodeChange.change.value.version).toBe(3n);
      }
    }
    const outcome = await fixture.registry.recordOutcome({
      commandId: commandId(id(0x308)),
      actorSessionId: ACTOR_ID,
      nodeId: fixture.childNodeId,
      expectedNodeVersion: 3,
      outcome: { kind: "artifact", artifactId: fixture.childArtifactId },
      at: at(7),
    });
    expect(outcome.outcome).toEqual({ kind: "artifact", artifactId: fixture.childArtifactId });
    const events = fixture.temporary.database.read((reader) =>
      reader.all("SELECT event_type, event_payload FROM events ORDER BY sequence"),
    );
    const outcomeEvent = events.at(-1);
    expect(outcomeEvent?.["event_type"]).toBe(ProjectionChangeSchema.typeName);
    const projection = fromBinary(
      ProjectionChangeSchema,
      outcomeEvent?.["event_payload"] as Uint8Array,
    );
    expect(projection.change.case).toBe("batch");
    if (projection.change.case === "batch") {
      expect(projection.change.value.changes.map((change) => change.change.case)).toEqual([
        "nodeOutcomeUpserted",
        "nodeUpserted",
      ]);
    }
  });

  it("reads older artifacts after shared blob verification advances", async () => {
    const fixture = await createFixture("artifact", true);
    const firstLease = await completeParent(fixture);
    const secondNodeId = fixture.secondChildNodeId;
    const secondArtifactId = fixture.secondChildArtifactId;
    if (secondNodeId === undefined || secondArtifactId === undefined) {
      throw new Error("second artifact fixture node is missing");
    }
    const digest = contentHash("b".repeat(64));
    const relativePath = nonEmptyText(
      `sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
      "blob relative path",
    );
    const first = await fixture.registry.create({
      commandId: commandId(id(0x30d)),
      actorSessionId: ACTOR_ID,
      artifactId: fixture.childArtifactId,
      nodeId: fixture.childNodeId,
      attemptId: firstLease.attemptId,
      expectedNodeVersion: 2,
      mediaType: nonEmptyText("application/json", "artifact media type"),
      artifactType: nonEmptyText("report", "artifact type"),
      evidenceId: evidenceId(id(0x30e)),
      retention: "active",
      blob: {
        digest,
        sizeBytes: 3n,
        relativePath,
        verifiedAt: at(6),
        created: true,
      },
      at: at(6),
    });
    const secondLease = await fixture.scheduler.claimNext({
      ownerId: OWNER_ID,
      at: at(7),
      leaseDurationMs: 10_000,
      capacity: { maxActiveGlobal: 4, maxActivePerTree: 4 },
    });
    expect(secondLease?.nodeId).toBe(secondNodeId);
    if (secondLease === undefined) {
      throw new Error("second artifact fixture node was not scheduled");
    }
    const second = await fixture.registry.create({
      commandId: commandId(id(0x30f)),
      actorSessionId: ACTOR_ID,
      artifactId: secondArtifactId,
      nodeId: secondNodeId,
      attemptId: secondLease.attemptId,
      expectedNodeVersion: 2,
      mediaType: nonEmptyText("application/json", "artifact media type"),
      artifactType: nonEmptyText("report", "artifact type"),
      evidenceId: evidenceId(id(0x310)),
      retention: "active",
      blob: {
        digest,
        sizeBytes: 3n,
        relativePath,
        verifiedAt: at(7),
        created: false,
      },
      at: at(7),
    });
    expect(fixture.registry.get(first.id)).toEqual({ ...first, verifiedAt: at(7) });
    expect(fixture.registry.get(second.id)).toEqual(second);
    expect(
      fixture.registry.list({ nodeId: first.nodeId, afterArtifactId: undefined, limit: 1 }),
    ).toEqual([{ ...first, verifiedAt: at(7) }]);
    expect(
      fixture.registry.list({ nodeId: second.nodeId, afterArtifactId: undefined, limit: 1 }),
    ).toEqual([second]);
  });

  it("replays a command stably and rejects a conflicting expected version", async () => {
    const fixture = await createFixture("implementation");
    await completeParent(fixture);
    const request = {
      commandId: commandId(id(0x309)),
      actorSessionId: ACTOR_ID,
      nodeId: fixture.childNodeId,
      expectedNodeVersion: 2,
      outcome: {
        kind: "commit" as const,
        revision: BASE_COMMIT,
        evidenceId: evidenceId(id(0x30a)),
      },
      at: at(6),
    };
    const first = await fixture.registry.recordOutcome(request);
    const second = await fixture.registry.recordOutcome(request);
    expect(second).toEqual(first);
    await expect(
      fixture.registry.recordOutcome({
        ...request,
        expectedNodeVersion: 3,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
  });
});
