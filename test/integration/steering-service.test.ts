import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { WireType } from "@bufbuild/protobuf/wire";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  AnswerNodeCommandSchema,
  ApprovePlanRequestSchema,
  CreateTreeRequestSchema,
  DaemonMode,
  DoctorCheckKind,
  DoctorCheckSchema,
  DoctorCheckStatus,
  DoctorStatus,
  ErrorDetailSchema,
  GetHealthResponseSchema,
  ImplementationOutputContractSchema,
  ListNodeCommandsRequestSchema,
  NodeAttentionKind,
  NodeAttentionState,
  NodeCommandDeliveryState,
  NodeCommandPayloadSchema,
  PlanNodeMode,
  ProposePlanRequestSchema,
  ProposedNodeSchema,
  QueueNodeCommandRequestSchema,
  RegisterRepositoryRequestSchema,
  RunDoctorResponseSchema,
  SteeringService,
  TextNodeCommandSchema,
  TreeBudgetSchema,
} from "@minions/contracts";
import {
  actorSessionId,
  artifactId,
  commandId,
  hostId,
  nodeAttentionId,
  nodeCommandDeliveryToken,
  planRevisionId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type DomainPorts,
  type NodeCommandRecord,
  type SteeringCommandStore,
  type RecoveryGateProfile,
} from "@minions/core";
import {
  createEventCommitWaiter,
  createFileContentBlobStore,
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteArtifactRegistry,
  createSqliteCommandStore,
  createSqliteSteeringCommandStore,
  createSqliteVcsChangeBindingStore,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
  type RepositoryInspection,
  type SqliteCommandStore,
  createSqliteRecoveryStore,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";

import { startDaemonServer, type RunningDaemonServer } from "@minions/daemon";

const at = timestampFromEpochMilliseconds(1_700_000_000_000);
const queueAt = at;
const sentAt = timestampFromEpochMilliseconds(1_700_001_001_000);
const acknowledgedAt = timestampFromEpochMilliseconds(1_700_001_002_000);
const appliedAt = timestampFromEpochMilliseconds(1_700_001_003_000);
const failedQueueAt = timestampFromEpochMilliseconds(1_700_001_004_000);
const failedSentAt = timestampFromEpochMilliseconds(1_700_001_005_000);
const failedAckAt = timestampFromEpochMilliseconds(1_700_001_006_000);
const failedAt = timestampFromEpochMilliseconds(1_700_001_007_000);
const reviewQueueAt = timestampFromEpochMilliseconds(1_700_001_008_000);
const reviewSentAt = timestampFromEpochMilliseconds(1_700_001_009_000);
const reviewFailedAt = timestampFromEpochMilliseconds(1_700_001_010_000);
const hostIdentifier = hostId("01900000-0000-7000-8000-000000000001");
const repositoryIdentifier = repositoryId("01900000-0000-7000-8000-000000000002");
const actorIdentifier = actorSessionId("01900000-0000-7000-8000-000000000003");
const treeIdentifier = taskTreeId("01900000-0000-7000-8000-000000000004");
const initialRevisionIdentifier = planRevisionId("01900000-0000-7000-8000-000000000005");
const rootNodeIdentifier = taskNodeId("01900000-0000-7000-8000-000000000006");
const childNodeIdentifier = taskNodeId("01900000-0000-7000-8000-00000000000f");
const rootArtifactIdentifier = artifactId("01900000-0000-7000-8000-000000000007");
const planAttentionIdentifier = "01900000-0000-7000-8000-000000000008";
const proposedRevisionIdentifier = planRevisionId("01900000-0000-7000-8000-000000000009");
const commandRegistrationIdentifier = commandId("01900000-0000-7000-8000-00000000000a");
const commandCreateIdentifier = commandId("01900000-0000-7000-8000-00000000000b");
const commandProposeIdentifier = commandId("01900000-0000-7000-8000-00000000000c");
const commandApproveIdentifier = commandId("01900000-0000-7000-8000-00000000000d");
const attentionIdentifier = nodeAttentionId("01900000-0000-7000-8000-00000000000e");
const RECOVERY_TEST_GATE_PROFILE: RecoveryGateProfile = {
  allowedKinds: ["restart"],
  requiredApprovals: 1,
  maxGrantDurationMs: 900_000,
};

function deterministicId(index: number): string {
  return `01900000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function generatedIds(start: number, count = 512): readonly string[] {
  return Array.from({ length: count }, (_, index) => deterministicId(start + index));
}

function queueCommandId(index: number) {
  return commandId(deterministicId(0x100 + index));
}

function deliveryToken(index: number) {
  return nodeCommandDeliveryToken(deterministicId(0x400 + index));
}

const health = create(GetHealthResponseSchema, {
  instanceId: deterministicId(0x10),
  mode: DaemonMode.HOST,
  hostId: hostIdentifier,
  startedAt: create(TimestampSchema, { seconds: 1_700_000_000n }),
});

const doctor = create(RunDoctorResponseSchema, {
  status: DoctorStatus.HEALTHY,
  checks: [
    create(DoctorCheckSchema, {
      kind: DoctorCheckKind.LIFECYCLE_LOCK,
      status: DoctorCheckStatus.PASSED,
    }),
  ],
});

const noOpNotifier = Object.freeze({ commandCommitted: () => undefined });

type SteeringServiceFixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  database: ManagedSqliteDatabase;
  eventWaiter: EventCommitWaiter;
  commandStore: SqliteCommandStore;
  steeringStore: SteeringCommandStore;
  server: RunningDaemonServer;
  client: Client<typeof SteeringService>;
}>;

const fixtures: SteeringServiceFixture[] = [];

async function createFixture(): Promise<SteeringServiceFixture> {
  const clock = new FixedClock(at);
  const temporary = await TemporarySqliteDatabase.create("host", clock);
  const database = temporary.database;
  const eventWaiter = createEventCommitWaiter();
  const ports: DomainPorts = Object.freeze({
    clock,
    ids: new SequenceIdGenerator(generatedIds(0x1000)),
  });
  const commandStore = createSqliteCommandStore({
    database,
    ports,
    notifier: noOpNotifier,
  });
  const repositories = createRepositoryRegistry({
    database,
    commandStore,
    hostId: hostIdentifier,
  });
  const inspection: RepositoryInspection = {
    canonicalRoot: "/workspace/minions",
    canonicalRemote: "https://example.test/minions",
    defaultBranch: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    caseSensitive: true,
    submodulePaths: [],
    lfsPaths: [],
    nestedRepositoryPaths: [],
    dirty: false,
  };
  await repositories.register({
    request: create(RegisterRepositoryRequestSchema, {
      commandId: commandRegistrationIdentifier,
      actorSessionId: actorIdentifier,
      repositoryId: repositoryIdentifier,
      rootPath: "/workspace/minions",
    }),
    inspection,
    allowedWorkspaceRoot: "/workspaces",
    registeredAt: at,
  });
  const planRegistry = createPlanRegistry({
    database,
    commandStore,
    hostId: hostIdentifier,
  });
  await planRegistry.create({
    request: create(CreateTreeRequestSchema, {
      commandId: commandCreateIdentifier,
      actorSessionId: actorIdentifier,
      repositoryId: repositoryIdentifier,
      treeId: treeIdentifier,
      planRevisionId: initialRevisionIdentifier,
      rootNodeId: rootNodeIdentifier,
      rootArtifactId: rootArtifactIdentifier,
      goal: "exercise steering service",
      baseCommit: inspection.baseCommit,
      budget: create(TreeBudgetSchema, {
        maxDepth: 4,
        maxFanOut: 4,
        maxNodes: 8,
        maxConcurrency: 4,
        maxAttemptsPerNode: 2,
      }),
      attentionId: planAttentionIdentifier,
      rootAllowedRepositoryPaths: ["."],
      rootCheckProfile: "root-checks",
    }),
    at,
  });
  await planRegistry.propose({
    request: create(ProposePlanRequestSchema, {
      commandId: commandProposeIdentifier,
      actorSessionId: actorIdentifier,
      treeId: treeIdentifier,
      planRevisionId: proposedRevisionIdentifier,
      goal: "exercise steering service",
      nodes: [
        create(ProposedNodeSchema, {
          nodeId: childNodeIdentifier,
          parentNodeId: rootNodeIdentifier,
          mode: PlanNodeMode.IMPLEMENTATION,
          objective: "receive durable steering commands",
          acceptanceCriteria: ["commands are visible through Connect"],
          inputs: [],
          outputContract: {
            case: "implementation",
            value: create(ImplementationOutputContractSchema, {}),
          },
          allowedRepositoryPaths: ["."],
          checkProfile: "implementation-checks",
        }),
      ],
    }),
    at,
  });
  await planRegistry.approve({
    request: create(ApprovePlanRequestSchema, {
      commandId: commandApproveIdentifier,
      actorSessionId: actorIdentifier,
      treeId: treeIdentifier,
      planRevisionId: proposedRevisionIdentifier,
    }),
    at,
  });
  const steeringStore = createSqliteSteeringCommandStore({ database, commandStore, ports });
  await steeringStore.createAttention({
    commandId: commandId(deterministicId(0x20)),
    actorSessionId: actorIdentifier,
    id: attentionIdentifier,
    nodeId: childNodeIdentifier,
    kind: "question",
    prompt: "Choose a path",
    choices: ["yes", "no"],
    at: queueAt,
  });
  const artifactRegistry = createSqliteArtifactRegistry({
    database,
    commandStore,
    hostId: hostIdentifier,
  });
  const blobStore = createFileContentBlobStore({
    rootPath: join(dirname(database.path), "blobs"),
    clock,
    ids: ports.ids,
  });
  const server = await startDaemonServer({
    mode: "host",
    port: 0,
    database,
    eventWaiter,
    eventPollIntervalMs: 10,
    planRegistry,
    clock,
    vcsChangeBindingStore: createSqliteVcsChangeBindingStore({ database }),
    steeringStore,
    artifactRegistry,
    blobStore,
    recoveryStore: createSqliteRecoveryStore({ database }),
    recoveryGateProfile: RECOVERY_TEST_GATE_PROFILE,
    recoveryIds: new SequenceIdGenerator(["01900000-0000-7000-8000-0000000000f0"]),
    recoveryRestart: { restart: () => Promise.reject(new Error("not used")) },
    system: {
      serverVersion: "0.0.0",
      health,
      runDoctor: () => Promise.resolve(doctor),
    },
  });
  const client = createClient(
    SteeringService,
    createConnectTransport({
      baseUrl: server.baseUrl,
      httpVersion: "1.1",
      useBinaryFormat: true,
    }),
  );
  const fixture = {
    temporary,
    database,
    eventWaiter,
    commandStore,
    steeringStore,
    server,
    client,
  };
  fixtures.push(fixture);
  return fixture;
}

async function expectConnectError(call: () => Promise<unknown>): Promise<ConnectError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ConnectError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the request to fail");
}

function expectValidationError(error: ConnectError): void {
  expect(error.code).toBe(Code.InvalidArgument);
  const details = error.findDetails(ErrorDetailSchema);
  expect(details).toHaveLength(1);
  expect(details[0]?.detail.case).toBe("validation");
}

function messagePayload(text: string) {
  return create(NodeCommandPayloadSchema, {
    command: {
      case: "message",
      value: create(TextNodeCommandSchema, { text }),
    },
  });
}

function queueRequest(command: string, payload = messagePayload("hello")) {
  return create(QueueNodeCommandRequestSchema, {
    commandId: command,
    actorSessionId: actorIdentifier,
    nodeId: childNodeIdentifier,
    payload,
  });
}

function commandDelivery(command: NodeCommandRecord, token = command.deliveryToken) {
  if (token === undefined) {
    throw new Error("command has no delivery token");
  }
  return { commandId: command.commandId, deliveryToken: token };
}

async function queueDirect(
  fixture: SteeringServiceFixture,
  index: number,
  payload = { kind: "message" as const, text: "direct" },
  timestamp = queueAt,
) {
  return fixture.steeringStore.queue({
    commandId: queueCommandId(index),
    actorSessionId: actorIdentifier,
    nodeId: childNodeIdentifier,
    expectedNodeVersion: undefined,
    payload,
    at: timestamp,
  });
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.server.close();
    await fixture.temporary.dispose();
  }
});

describe("SteeringService integration", () => {
  it("queues, gets, lists commands, and lists node attention through Connect", async () => {
    const fixture = await createFixture();

    const queued = await fixture.client.queueNodeCommand(
      queueRequest(deterministicId(0x100), messagePayload("through Connect")),
    );
    expect(queued.command).toEqual(
      expect.objectContaining({
        commandId: deterministicId(0x100),
        actorSessionId: actorIdentifier,
        nodeId: childNodeIdentifier,
        ordinal: 1n,
        deliveryState: NodeCommandDeliveryState.QUEUED,
      }),
    );
    expect(queued.command?.payload?.command.case).toBe("message");

    const fetched = await fixture.client.getNodeCommand({ commandId: deterministicId(0x100) });
    expect(fetched.command).toEqual(queued.command);

    const listed = await fixture.client.listNodeCommands({
      nodeId: childNodeIdentifier,
      afterOrdinal: 0n,
      pageSize: 10,
    });
    expect(listed.commands).toEqual([queued.command]);
    expect(listed.nextOrdinal).toBeUndefined();

    const attention = await fixture.client.listNodeAttention({
      nodeId: childNodeIdentifier,
      openOnly: true,
    });
    expect(attention.attention).toEqual([
      expect.objectContaining({
        id: attentionIdentifier,
        nodeId: childNodeIdentifier,
        kind: NodeAttentionKind.QUESTION,
        prompt: "Choose a path",
        choices: ["yes", "no"],
        state: NodeAttentionState.OPEN,
      }),
    ]);
  });

  it("returns generated validation details for invalid and unknown payload requests", async () => {
    const fixture = await createFixture();

    const invalid = await expectConnectError(() =>
      fixture.client.queueNodeCommand(
        create(QueueNodeCommandRequestSchema, {
          commandId: "not-a-uuid",
          actorSessionId: actorIdentifier,
          nodeId: childNodeIdentifier,
          payload: messagePayload("invalid identity"),
        }),
      ),
    );
    expectValidationError(invalid);

    const missingPayload = await expectConnectError(() =>
      fixture.client.queueNodeCommand(
        create(QueueNodeCommandRequestSchema, {
          commandId: deterministicId(0x101),
          actorSessionId: actorIdentifier,
          nodeId: childNodeIdentifier,
          payload: create(NodeCommandPayloadSchema, {}),
        }),
      ),
    );
    expectValidationError(missingPayload);

    const unknownPayload = messagePayload("unknown field");
    unknownPayload.$unknown = [
      {
        no: 99,
        wireType: WireType.Varint,
        data: new Uint8Array([1]),
      },
    ];
    const unknown = await expectConnectError(() =>
      fixture.client.queueNodeCommand(queueRequest(deterministicId(0x102), unknownPayload)),
    );
    expectValidationError(unknown);
  });

  it("maps exact store errors and exposes receipt state enums", async () => {
    const fixture = await createFixture();

    const missingNode = await expectConnectError(() =>
      fixture.client.queueNodeCommand(
        create(QueueNodeCommandRequestSchema, {
          commandId: deterministicId(0x103),
          actorSessionId: actorIdentifier,
          nodeId: deterministicId(0x999),
          payload: messagePayload("missing node"),
        }),
      ),
    );
    expect(missingNode.code).toBe(Code.NotFound);

    const missingAttention = await expectConnectError(() =>
      fixture.client.queueNodeCommand(
        queueRequest(
          deterministicId(0x104),
          create(NodeCommandPayloadSchema, {
            command: {
              case: "answer",
              value: create(AnswerNodeCommandSchema, {
                attentionId: deterministicId(0x998),
                answer: "yes",
              }),
            },
          }),
        ),
      ),
    );
    expect(missingAttention.code).toBe(Code.NotFound);

    const staleVersion = await expectConnectError(() =>
      fixture.client.queueNodeCommand(
        create(QueueNodeCommandRequestSchema, {
          commandId: deterministicId(0x105),
          actorSessionId: actorIdentifier,
          nodeId: childNodeIdentifier,
          expectedNodeVersion: 0n,
          payload: messagePayload("stale version"),
        }),
      ),
    );
    expect(staleVersion.code).toBe(Code.FailedPrecondition);

    const first = await queueDirect(fixture, 1, { kind: "message", text: "receipt" });
    const queued = await fixture.client.getNodeCommand({ commandId: first.commandId });
    expect(queued.command?.deliveryState).toBe(NodeCommandDeliveryState.QUEUED);

    const sent = await fixture.steeringStore.claimNext({
      nodeId: childNodeIdentifier,
      afterOrdinal: 0n,
      at: sentAt,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(1),
    });
    if (sent === undefined) {
      throw new Error("expected sent command");
    }
    expect(
      (await fixture.client.getNodeCommand({ commandId: first.commandId })).command?.deliveryState,
    ).toBe(NodeCommandDeliveryState.SENT);

    const acknowledged = await fixture.steeringStore.acknowledge({
      delivery: commandDelivery(sent),
      at: acknowledgedAt,
    });
    expect(acknowledged.state).toBe("acknowledged");
    expect(
      (await fixture.client.getNodeCommand({ commandId: first.commandId })).command?.deliveryState,
    ).toBe(NodeCommandDeliveryState.ACKNOWLEDGED);

    const applied = await fixture.steeringStore.apply({
      delivery: commandDelivery(acknowledged),
      at: appliedAt,
    });
    expect(applied.state).toBe("applied");
    expect(
      (await fixture.client.getNodeCommand({ commandId: first.commandId })).command?.deliveryState,
    ).toBe(NodeCommandDeliveryState.APPLIED);

    const failed = await queueDirect(
      fixture,
      2,
      { kind: "message", text: "failed" },
      failedQueueAt,
    );
    const failedSent = await fixture.steeringStore.claimNext({
      nodeId: childNodeIdentifier,
      afterOrdinal: first.ordinal,
      at: failedSentAt,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(2),
    });
    if (failedSent === undefined) {
      throw new Error("expected failed command to be sent");
    }
    const failedAcknowledged = await fixture.steeringStore.acknowledge({
      delivery: commandDelivery(failedSent),
      at: failedAckAt,
    });
    await fixture.steeringStore.fail({
      delivery: commandDelivery(failedAcknowledged),
      at: failedAt,
      failure: "worker stopped",
      ambiguous: false,
    });
    const failedResponse = await fixture.client.getNodeCommand({ commandId: failed.commandId });
    expect(failedResponse.command?.deliveryState).toBe(NodeCommandDeliveryState.FAILED);
    expect(failedResponse.command?.failure).toBe("worker stopped");

    const review = await queueDirect(
      fixture,
      3,
      { kind: "message", text: "ambiguous" },
      reviewQueueAt,
    );
    const reviewSent = await fixture.steeringStore.claimNext({
      nodeId: childNodeIdentifier,
      afterOrdinal: failed.ordinal,
      at: reviewSentAt,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(3),
    });
    if (reviewSent === undefined) {
      throw new Error("expected review command to be sent");
    }
    const reviewRecord = await fixture.steeringStore.fail({
      delivery: commandDelivery(reviewSent),
      at: reviewFailedAt,
      failure: "delivery outcome is ambiguous",
      ambiguous: true,
    });
    expect(reviewRecord.state).toBe("review_required");
    const reviewResponse = await fixture.client.getNodeCommand({ commandId: review.commandId });
    expect(reviewResponse.command?.deliveryState).toBe(NodeCommandDeliveryState.REVIEW_REQUIRED);
  });

  it("validates page sizes and preserves 64-bit ordinal pagination", async () => {
    const fixture = await createFixture();

    const zeroPage = await expectConnectError(() =>
      fixture.client.listNodeCommands(
        create(ListNodeCommandsRequestSchema, {
          nodeId: childNodeIdentifier,
          afterOrdinal: 0n,
          pageSize: 0,
        }),
      ),
    );
    expectValidationError(zeroPage);

    for (let index = 0; index < 201; index += 1) {
      await queueDirect(fixture, index + 10, {
        kind: "message",
        text: `command ${String(index)}`,
      });
    }

    const firstPage = await fixture.client.listNodeCommands({
      nodeId: childNodeIdentifier,
      afterOrdinal: 0n,
      pageSize: 200,
    });
    expect(firstPage.commands).toHaveLength(200);
    expect(firstPage.commands[0]?.ordinal).toBe(1n);
    expect(firstPage.commands.at(-1)?.ordinal).toBe(200n);
    expect(firstPage.nextOrdinal).toBe(200n);

    if (firstPage.nextOrdinal === undefined) {
      throw new Error("first page did not return a next ordinal");
    }
    const secondPage = await fixture.client.listNodeCommands({
      nodeId: childNodeIdentifier,
      afterOrdinal: firstPage.nextOrdinal,
      pageSize: 200,
    });
    expect(secondPage.commands.map((command) => command.ordinal)).toEqual([201n]);
    expect(secondPage.nextOrdinal).toBeUndefined();

    const beyondSigned = await fixture.client.listNodeCommands({
      nodeId: childNodeIdentifier,
      afterOrdinal: 9_223_372_036_854_775_808n,
      pageSize: 200,
    });
    expect(beyondSigned.commands).toEqual([]);
    expect(beyondSigned.nextOrdinal).toBeUndefined();
  }, 20_000);
});
