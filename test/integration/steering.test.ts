import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ApprovePlanRequestSchema,
  CreateTreeRequestSchema,
  ImplementationOutputContractSchema,
  NodeAttentionState,
  NodeCommandDeliveryState,
  NodeCommandPayloadSchema,
  PlanNodeMode,
  ProjectionChangeSchema,
  ProposedNodeSchema,
  ProposePlanRequestSchema,
  RegisterRepositoryRequestSchema,
  TreeBudgetSchema,
  type NodeCommand as NodeCommandMessage,
  type ProjectionChange,
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
  type NodeAttentionRecord,
  type NodeCommandDeliveryToken,
  type NodeCommandPayload,
  type NodeCommandRecord,
  type QueueNodeCommandRequest,
  type SteeringCommandStore,
  type TaskNodeId,
  type Timestamp,
} from "@minions/core";
import {
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteCommandStore,
  createSqliteSteeringCommandStore,
  type CommandCommitNotifier,
  type ManagedSqliteDatabase,
  type PlanRegistry,
  type RepositoryInspection,
  type SqliteCommandStore,
  type SqliteRow,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";

const at = timestampFromEpochMilliseconds(1_700_000_000_000);
const beforeQueue = timestampFromEpochMilliseconds(1_700_000_000_099);
const afterQueue = timestampFromEpochMilliseconds(1_700_000_000_100);
const afterAck = timestampFromEpochMilliseconds(1_700_000_000_200);
const afterApply = timestampFromEpochMilliseconds(1_700_000_000_300);
const afterReplay = timestampFromEpochMilliseconds(1_700_000_000_400);
const host = hostId("01900000-0000-7000-8000-000000000001");
const repository = repositoryId("01900000-0000-7000-8000-000000000002");
const actor = actorSessionId("01900000-0000-7000-8000-000000000003");
const tree = taskTreeId("01900000-0000-7000-8000-000000000004");
const initialRevision = planRevisionId("01900000-0000-7000-8000-000000000005");
const rootNode = taskNodeId("01900000-0000-7000-8000-000000000006");
const rootArtifact = artifactId("01900000-0000-7000-8000-000000000007");
const planAttention = "01900000-0000-7000-8000-000000000008";
const proposalRevision = planRevisionId("01900000-0000-7000-8000-000000000009");
const firstChild = taskNodeId("01900000-0000-7000-8000-00000000000a");
const secondChild = taskNodeId("01900000-0000-7000-8000-00000000000b");
const createCommand = commandId("01900000-0000-7000-8000-00000000000c");
const proposeCommand = commandId("01900000-0000-7000-8000-00000000000d");
const approveCommand = commandId("01900000-0000-7000-8000-00000000000e");
const registerCommand = commandId("01900000-0000-7000-8000-000000000012");
const questionAttention = nodeAttentionId("01900000-0000-7000-8000-00000000000f");
const approvalAttention = nodeAttentionId("01900000-0000-7000-8000-000000000010");
const rejectApprovalAttention = nodeAttentionId("01900000-0000-7000-8000-000000000013");
const siblingAttention = nodeAttentionId("01900000-0000-7000-8000-000000000011");

function deterministicId(index: number): string {
  return `01900000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function generatedIds(start: number, count = 256): readonly string[] {
  return Array.from({ length: count }, (_, index) => deterministicId(start + index));
}

const queueCommandId = (index: number) => commandId(deterministicId(0x100 + index));
const deliveryToken = (index: number) => nodeCommandDeliveryToken(deterministicId(0x400 + index));
const attentionCommandId = (index: number) => commandId(deterministicId(0x200 + index));

const noOpNotifier: CommandCommitNotifier = Object.freeze({
  commandCommitted: () => undefined,
});

type SteeringFixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  database: ManagedSqliteDatabase;
  planRegistry: PlanRegistry;
  commandStore: SqliteCommandStore;
  steering: SteeringCommandStore;
  firstNode: TaskNodeId;
  secondNode: TaskNodeId;
  ports: DomainPorts;
}>;

const fixtures: TemporarySqliteDatabase[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose();
  }
});

async function createFixture(): Promise<SteeringFixture> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(at));
  fixtures.push(temporary);
  const database = temporary.database;
  const commandStore = createSqliteCommandStore({
    database,
    ports: {
      clock: new FixedClock(at),
      ids: new SequenceIdGenerator(generatedIds(0x800)),
    },
    notifier: noOpNotifier,
  });
  const repositories = createRepositoryRegistry({
    database,
    commandStore,
    hostId: host,
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
      commandId: registerCommand,
      actorSessionId: actor,
      repositoryId: repository,
      rootPath: "/workspace/minions",
    }),
    inspection,
    allowedWorkspaceRoot: "/workspaces",
    registeredAt: at,
  });
  const planRegistry = createPlanRegistry({ database, commandStore, hostId: host });
  await planRegistry.create({
    request: create(CreateTreeRequestSchema, {
      commandId: createCommand,
      actorSessionId: actor,
      repositoryId: repository,
      treeId: tree,
      planRevisionId: initialRevision,
      rootNodeId: rootNode,
      rootArtifactId: rootArtifact,
      goal: "steer a durable node",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      budget: create(TreeBudgetSchema, {
        maxDepth: 4,
        maxFanOut: 4,
        maxNodes: 8,
        maxConcurrency: 4,
        maxAttemptsPerNode: 2,
      }),
      attentionId: planAttention,
      rootAllowedRepositoryPaths: ["."],
    }),
    at,
  });
  await planRegistry.propose({
    request: create(ProposePlanRequestSchema, {
      commandId: proposeCommand,
      actorSessionId: actor,
      treeId: tree,
      planRevisionId: proposalRevision,
      goal: "steer a durable node",
      nodes: [
        create(ProposedNodeSchema, {
          nodeId: firstChild,
          parentNodeId: rootNode,
          mode: PlanNodeMode.IMPLEMENTATION,
          objective: "first durable child",
          acceptanceCriteria: ["first child receives commands"],
          inputs: [],
          outputContract: {
            case: "implementation",
            value: create(ImplementationOutputContractSchema, {}),
          },
          allowedRepositoryPaths: ["."],
        }),
        create(ProposedNodeSchema, {
          nodeId: secondChild,
          parentNodeId: rootNode,
          mode: PlanNodeMode.IMPLEMENTATION,
          objective: "second durable child",
          acceptanceCriteria: ["second child remains isolated"],
          inputs: [],
          outputContract: {
            case: "implementation",
            value: create(ImplementationOutputContractSchema, {}),
          },
          allowedRepositoryPaths: ["."],
        }),
      ],
    }),
    at,
  });
  await planRegistry.approve({
    request: create(ApprovePlanRequestSchema, {
      commandId: approveCommand,
      actorSessionId: actor,
      treeId: tree,
      planRevisionId: proposalRevision,
    }),
    at,
  });
  const ports: DomainPorts = Object.freeze({
    clock: new FixedClock(at),
    ids: new SequenceIdGenerator(generatedIds(0x600)),
  });
  const steering = createSqliteSteeringCommandStore({ database, commandStore, ports });
  return {
    temporary,
    database,
    planRegistry,
    commandStore,
    steering,
    firstNode: firstChild,
    secondNode: secondChild,
    ports,
  };
}

function request(
  fixture: SteeringFixture,
  index: number,
  payload: NodeCommandPayload,
  options: Readonly<{
    nodeId?: TaskNodeId;
    expectedNodeVersion?: number;
    at?: Timestamp;
  }> = {},
): QueueNodeCommandRequest {
  return Object.freeze({
    commandId: queueCommandId(index),
    actorSessionId: actor,
    nodeId: options.nodeId ?? fixture.firstNode,
    expectedNodeVersion: options.expectedNodeVersion,
    payload,
    at: options.at ?? afterQueue,
  });
}

const commandPayloads: readonly NodeCommandPayload[] = [
  { kind: "message", text: "message before the turn" },
  { kind: "steer_after_current_tool", text: "steer during the turn" },
  { kind: "interrupt_now" },
  { kind: "follow_up_after_turn", text: "follow up after the turn" },
  { kind: "pause" },
  { kind: "resume" },
  { kind: "answer", attentionId: questionAttention, answer: "yes" },
  { kind: "approve", attentionId: approvalAttention, reason: "approved" },
  { kind: "reject", attentionId: rejectApprovalAttention, reason: "rejected" },
  { kind: "retry" },
  { kind: "cancel_node" },
  { kind: "cancel_subtree" },
  { kind: "replan_unstarted_subtree", objective: "replan the remaining work" },
];

async function createQuestionAndApproval(
  steering: SteeringCommandStore,
  nodeId: TaskNodeId,
): Promise<readonly [NodeAttentionRecord, NodeAttentionRecord]> {
  const question = await steering.createAttention({
    commandId: attentionCommandId(1),
    actorSessionId: actor,
    id: questionAttention,
    nodeId,
    kind: "question",
    prompt: "Choose a path",
    choices: ["yes", "no"],
    at,
  });
  const approval = await steering.createAttention({
    commandId: attentionCommandId(2),
    actorSessionId: actor,
    id: approvalAttention,
    nodeId,
    kind: "approval",
    prompt: "Approve this action",
    choices: [],
    at,
  });
  return [question, approval];
}
function tokenFor(command: NodeCommandRecord): NodeCommandDeliveryToken {
  if (command.deliveryToken === undefined) {
    throw new Error(`command ${command.commandId} has no delivery token`);
  }
  return command.deliveryToken;
}

function delivery(command: NodeCommandRecord, token = tokenFor(command)) {
  return { commandId: command.commandId, deliveryToken: token };
}

function row(
  database: ManagedSqliteDatabase,
  sql: string,
  parameters: readonly (string | number | bigint | null)[] = [],
): SqliteRow | undefined {
  return database.read((reader) => reader.get(sql, parameters));
}

function count(database: ManagedSqliteDatabase, table: string, where = ""): bigint {
  const value = row(database, `SELECT count(*) AS count FROM ${table}${where}`)?.["count"];
  if (typeof value !== "bigint") {
    throw new TypeError(`expected bigint count for ${table}`);
  }
  return value;
}

function projectionChangeForCommand(
  database: ManagedSqliteDatabase,
  commandIdValue: string,
): Readonly<{ bytes: Uint8Array; change: ProjectionChange["change"] }> {
  const event = row(
    database,
    `SELECT event_type, event_payload
       FROM events
      WHERE command_id = ?
      ORDER BY sequence DESC
      LIMIT 1`,
    [commandIdValue],
  );
  if (event?.["event_type"] !== ProjectionChangeSchema.typeName) {
    throw new Error(`command ${commandIdValue} has no projection event`);
  }
  const raw = event["event_payload"];
  if (!(raw instanceof Uint8Array)) {
    throw new TypeError("projection event payload is not bytes");
  }
  const bytes = new Uint8Array(raw);
  return { bytes, change: fromBinary(ProjectionChangeSchema, bytes).change };
}

function projectionForCommand(
  database: ManagedSqliteDatabase,
  commandIdValue: string,
): Readonly<{ bytes: Uint8Array; command: NodeCommandMessage }> {
  const projection = projectionChangeForCommand(database, commandIdValue);
  if (projection.change.case !== "nodeCommandUpserted") {
    throw new Error("projection event is not a node command upsert");
  }
  return { bytes: projection.bytes, command: projection.change.value };
}

function assertProjectionCommand(database: ManagedSqliteDatabase, record: NodeCommandRecord): void {
  const projection = projectionForCommand(database, record.commandId);
  expect(projection.command.commandId).toBe(record.commandId);
  expect(projection.command.actorSessionId).toBe(record.actorSessionId);
  expect(projection.command.nodeId).toBe(record.nodeId);
  expect(projection.command.ordinal).toBe(record.ordinal);
  expect(projection.command.deliveryAttempts).toBe(record.deliveryAttempts);
  expect(
    toBinary(
      ProjectionChangeSchema,
      create(ProjectionChangeSchema, {
        change: { case: "nodeCommandUpserted", value: projection.command },
      }),
    ),
  ).toEqual(projection.bytes);
  if (projection.command.payload === undefined) {
    throw new Error(`command ${record.commandId} projection has no payload`);
  }
  expect(toBinary(NodeCommandPayloadSchema, projection.command.payload)).toEqual(
    toBinary(NodeCommandPayloadSchema, recordPayloadMessage(record)),
  );
}

function recordPayloadMessage(record: NodeCommandRecord) {
  switch (record.payload.kind) {
    case "message":
      return create(NodeCommandPayloadSchema, {
        command: { case: "message", value: { text: record.payload.text } },
      });
    case "steer_after_current_tool":
      return create(NodeCommandPayloadSchema, {
        command: { case: "steerAfterCurrentTool", value: { text: record.payload.text } },
      });
    case "interrupt_now":
      return create(NodeCommandPayloadSchema, {
        command: { case: "interruptNow", value: {} },
      });
    case "follow_up_after_turn":
      return create(NodeCommandPayloadSchema, {
        command: { case: "followUpAfterTurn", value: { text: record.payload.text } },
      });
    case "pause":
      return create(NodeCommandPayloadSchema, {
        command: { case: "pause", value: {} },
      });
    case "resume":
      return create(NodeCommandPayloadSchema, {
        command: { case: "resume", value: {} },
      });
    case "answer":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "answer",
          value: { attentionId: record.payload.attentionId, answer: record.payload.answer },
        },
      });
    case "approve":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "approve",
          value: { attentionId: record.payload.attentionId, reason: record.payload.reason },
        },
      });
    case "reject":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "reject",
          value: { attentionId: record.payload.attentionId, reason: record.payload.reason },
        },
      });
    case "retry":
      return create(NodeCommandPayloadSchema, {
        command: { case: "retry", value: {} },
      });
    case "cancel_node":
      return create(NodeCommandPayloadSchema, {
        command: { case: "cancelNode", value: {} },
      });
    case "cancel_subtree":
      return create(NodeCommandPayloadSchema, {
        command: { case: "cancelSubtree", value: {} },
      });
    case "replan_unstarted_subtree":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "replanUnstartedSubtree",
          value: { objective: record.payload.objective },
        },
      });
  }
}

describe("durable steering command store", () => {
  it("queues all thirteen payloads with durable per-node ordinals and projection bytes", async () => {
    const fixture = await createFixture();
    await createQuestionAndApproval(fixture.steering, fixture.firstNode);
    await fixture.steering.createAttention({
      commandId: attentionCommandId(3),
      actorSessionId: actor,
      id: rejectApprovalAttention,
      nodeId: fixture.firstNode,
      kind: "approval",
      prompt: "Reject this action",
      choices: [],
      at,
    });

    const queued: NodeCommandRecord[] = [];
    for (const [index, payload] of commandPayloads.entries()) {
      const command = await fixture.steering.queue(request(fixture, index, payload));
      queued.push(command);
    }

    expect(queued).toHaveLength(13);
    expect(queued.map((command) => command.ordinal)).toEqual(
      Array.from({ length: 13 }, (_, index) => BigInt(index + 1)),
    );
    expect(queued.every((command) => command.state === "queued")).toBe(true);
    expect(queued.every((command) => command.deliveryAttempts === 0)).toBe(true);
    expect(queued.every((command) => command.deliveryToken === undefined)).toBe(true);
    expect(
      fixture.steering.list({ nodeId: fixture.firstNode, afterOrdinal: 0n, limit: 20 }),
    ).toEqual(queued);
    expect(
      fixture.steering.list({ nodeId: fixture.secondNode, afterOrdinal: 0n, limit: 20 }),
    ).toEqual([]);
    expect(
      row(fixture.database, "SELECT next_ordinal FROM node_command_sequences WHERE node_id = ?", [
        fixture.firstNode,
      ]),
    ).toEqual({ next_ordinal: 14n });
    expect(count(fixture.database, "node_command_deliveries")).toBe(13n);

    for (const record of queued) {
      assertProjectionCommand(fixture.database, record);
    }
  });
  it("returns stable idempotent receipts across command and attention lifecycles", async () => {
    const fixture = await createFixture();
    const attentionRequest = {
      commandId: attentionCommandId(20),
      actorSessionId: actor,
      id: questionAttention,
      nodeId: fixture.firstNode,
      kind: "question" as const,
      prompt: "Choose a path",
      choices: ["yes", "no"],
      at,
    };
    const originalAttention = await fixture.steering.createAttention(attentionRequest);
    const firstRequest = request(fixture, 50, { kind: "message", text: "same request" });
    const first = await fixture.steering.queue(firstRequest);
    const sent = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(50),
    });
    if (sent === undefined) {
      throw new Error("idempotent command was not claimed");
    }
    const acknowledged = await fixture.steering.acknowledge({
      delivery: delivery(sent),
      at: afterAck,
    });
    const applied = await fixture.steering.apply({
      delivery: delivery(acknowledged),
      at: afterApply,
    });
    expect(applied.state).toBe("applied");
    const eventCountAfterApply = count(fixture.database, "events");
    const replay = await fixture.steering.queue(firstRequest);
    expect(replay).toEqual(first);
    expect(count(fixture.database, "events")).toBe(eventCountAfterApply);

    const answerRequest = request(
      fixture,
      51,
      { kind: "answer", attentionId: questionAttention, answer: "yes" },
      { at: afterReplay },
    );
    const queuedAnswer = await fixture.steering.queue(answerRequest);
    const sentAnswer = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: first.ordinal,
      at: afterReplay,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(51),
    });
    if (sentAnswer === undefined) {
      throw new Error("idempotent attention command was not claimed");
    }
    const acknowledgedAnswer = await fixture.steering.acknowledge({
      delivery: delivery(sentAnswer),
      at: afterReplay,
    });
    const appliedAnswer = await fixture.steering.apply({
      delivery: delivery(acknowledgedAnswer),
      at: afterReplay,
    });
    expect(appliedAnswer.state).toBe("applied");
    const eventCountAfterAttentionResolution = count(fixture.database, "events");
    const replayAttention = await fixture.steering.createAttention(attentionRequest);
    expect(replayAttention).toEqual(originalAttention);
    expect(count(fixture.database, "events")).toBe(eventCountAfterAttentionResolution);
    expect(queuedAnswer.commandId).toBe(answerRequest.commandId);

    await expect(
      fixture.steering.queue(
        request(fixture, 50, { kind: "message", text: "different" }, { at: afterReplay }),
      ),
    ).rejects.toMatchObject({ code: "invalid_command" });
    expect(count(fixture.database, "node_command_deliveries")).toBe(2n);
  });

  it("rejects stale queue timestamps and handles bounded cursors and pages", async () => {
    const fixture = await createFixture();
    const queued = await fixture.steering.queue(
      request(fixture, 140, { kind: "message", text: "timestamp baseline" }),
    );
    const eventCount = count(fixture.database, "events");
    await expect(
      fixture.steering.queue(
        request(fixture, 141, { kind: "message", text: "stale timestamp" }, { at: beforeQueue }),
      ),
    ).rejects.toMatchObject({ code: "invalid_command" });
    expect(
      row(fixture.database, "SELECT next_ordinal FROM node_command_sequences WHERE node_id = ?", [
        fixture.firstNode,
      ]),
    ).toEqual({ next_ordinal: 2n });
    expect(count(fixture.database, "node_command_deliveries")).toBe(1n);
    expect(count(fixture.database, "events")).toBe(eventCount);

    const maximumOrdinal = (1n << 64n) - 1n;
    expect(
      fixture.steering.list({
        nodeId: fixture.firstNode,
        afterOrdinal: maximumOrdinal,
        limit: 201,
      }),
    ).toEqual([]);
    expect(
      await fixture.steering.claimNext({
        nodeId: fixture.firstNode,
        afterOrdinal: maximumOrdinal,
        at: afterQueue,
        acknowledgementTimeoutMs: 1_000,
        deliveryToken: deliveryToken(141),
      }),
    ).toBeUndefined();
    expect(
      fixture.steering.list({ nodeId: fixture.firstNode, afterOrdinal: 0n, limit: 201 }),
    ).toEqual([queued]);
  });

  it("keeps sibling delivery rows isolated and preserves each ordinal cursor", async () => {
    const fixture = await createFixture();
    const firstA = await fixture.steering.queue(
      request(fixture, 60, { kind: "message", text: "first A" }),
    );
    const firstB = await fixture.steering.queue(
      request(fixture, 61, { kind: "message", text: "first B" }, { nodeId: fixture.secondNode }),
    );
    const secondA = await fixture.steering.queue(request(fixture, 62, { kind: "pause" }));
    const secondB = await fixture.steering.queue(
      request(fixture, 63, { kind: "resume" }, { nodeId: fixture.secondNode }),
    );

    expect(firstA.ordinal).toBe(1n);
    expect(secondA.ordinal).toBe(2n);
    expect(firstB.ordinal).toBe(1n);
    expect(secondB.ordinal).toBe(2n);
    expect(
      fixture.steering.list({ nodeId: fixture.firstNode, afterOrdinal: 0n, limit: 1 }),
    ).toEqual([firstA]);
    expect(
      fixture.steering.list({ nodeId: fixture.firstNode, afterOrdinal: firstA.ordinal, limit: 1 }),
    ).toEqual([secondA]);
    expect(
      fixture.steering.list({ nodeId: fixture.secondNode, afterOrdinal: 0n, limit: 20 }),
    ).toEqual([firstB, secondB]);
    expect(
      row(fixture.database, "SELECT next_ordinal FROM node_command_sequences WHERE node_id = ?", [
        fixture.firstNode,
      ]),
    ).toEqual({ next_ordinal: 3n });
    expect(
      row(fixture.database, "SELECT next_ordinal FROM node_command_sequences WHERE node_id = ?", [
        fixture.secondNode,
      ]),
    ).toEqual({ next_ordinal: 3n });

    const claimedA = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(60),
    });
    expect(claimedA?.commandId).toBe(firstA.commandId);
    expect(fixture.steering.get(firstB.commandId)?.state).toBe("queued");
  });

  it("serializes concurrent claims to the earliest queued ordinal", async () => {
    const fixture = await createFixture();
    const first = await fixture.steering.queue(
      request(fixture, 64, { kind: "message", text: "first concurrent command" }),
    );
    const second = await fixture.steering.queue(
      request(fixture, 65, { kind: "message", text: "second concurrent command" }),
    );
    const claims = await Promise.all([
      fixture.steering.claimNext({
        nodeId: fixture.firstNode,
        afterOrdinal: 0n,
        at: afterQueue,
        acknowledgementTimeoutMs: 1_000,
        deliveryToken: deliveryToken(64),
      }),
      fixture.steering.claimNext({
        nodeId: fixture.firstNode,
        afterOrdinal: 0n,
        at: afterQueue,
        acknowledgementTimeoutMs: 1_000,
        deliveryToken: deliveryToken(65),
      }),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(claims.find((claim) => claim?.commandId === first.commandId)?.state).toBe("sent");
    expect(claims.find((claim) => claim?.commandId === second.commandId)).toBeUndefined();
    expect(fixture.steering.get(first.commandId)?.state).toBe("sent");
    expect(fixture.steering.get(second.commandId)?.state).toBe("queued");
    const advanced = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: first.ordinal,
      at: afterQueue,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(66),
    });
    expect(advanced?.commandId).toBe(second.commandId);
  });

  it("retains before-turn, during-turn, and after-turn queue order", async () => {
    const fixture = await createFixture();
    const before = await fixture.steering.queue(
      request(fixture, 70, { kind: "message", text: "before turn" }, { at: afterQueue }),
    );
    const during = await fixture.steering.queue(
      request(
        fixture,
        71,
        { kind: "steer_after_current_tool", text: "during turn" },
        {
          at: afterAck,
        },
      ),
    );
    const after = await fixture.steering.queue(
      request(
        fixture,
        72,
        { kind: "follow_up_after_turn", text: "after turn" },
        {
          at: afterApply,
        },
      ),
    );

    expect([before, during, after].map((command) => command.ordinal)).toEqual([1n, 2n, 3n]);
    expect(
      fixture.steering
        .list({ nodeId: fixture.firstNode, afterOrdinal: 0n, limit: 10 })
        .map((command) => command.payload),
    ).toEqual([
      { kind: "message", text: "before turn" },
      { kind: "steer_after_current_tool", text: "during turn" },
      { kind: "follow_up_after_turn", text: "after turn" },
    ]);
  });

  it("replays safe delivery after a crash before acknowledgement and gates stale tokens", async () => {
    const fixture = await createFixture();
    const queued = await fixture.steering.queue(
      request(fixture, 80, { kind: "message", text: "safe replay" }),
    );
    const firstSent = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 10,
      deliveryToken: deliveryToken(80),
    });
    expect(firstSent?.state).toBe("sent");
    if (firstSent === undefined) {
      throw new Error("first safe claim is missing");
    }
    const replayed = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterReplay,
      acknowledgementTimeoutMs: 10,
      deliveryToken: deliveryToken(81),
    });
    expect(replayed?.commandId).toBe(queued.commandId);
    expect(replayed?.state).toBe("sent");
    expect(replayed?.deliveryAttempts).toBe(2);
    expect(replayed?.deliveryToken).toBe(deliveryToken(81));
    await expect(
      fixture.steering.acknowledge({
        delivery: delivery(firstSent, deliveryToken(80)),
        at: afterReplay,
      }),
    ).rejects.toMatchObject({ code: "stale_delivery" });

    if (replayed === undefined) {
      throw new Error("safe replay is missing");
    }
    const acknowledged = await fixture.steering.acknowledge({
      delivery: delivery(replayed),
      at: afterReplay,
    });
    expect(acknowledged.state).toBe("acknowledged");
    const applied = await fixture.steering.apply({
      delivery: delivery(acknowledged),
      at: afterReplay,
    });
    expect(applied.state).toBe("applied");
    expect(applied.appliedAt).toBe(afterReplay);
  });

  it("resumes an acknowledged command after reconnecting with a new store instance", async () => {
    const fixture = await createFixture();
    const queued = await fixture.steering.queue(
      request(fixture, 90, { kind: "follow_up_after_turn", text: "resume after reconnect" }),
    );
    const nextQueued = await fixture.steering.queue(
      request(fixture, 91, { kind: "message", text: "next after reconnect" }),
    );
    const sent = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(90),
    });
    if (sent === undefined) {
      throw new Error("reconnect command was not claimed");
    }
    const acknowledged = await fixture.steering.acknowledge({
      delivery: delivery(sent),
      at: afterAck,
    });
    const reconnected = createSqliteSteeringCommandStore({
      database: fixture.database,
      commandStore: fixture.commandStore,
      ports: fixture.ports,
    });
    const persisted = reconnected.get(queued.commandId);
    expect(persisted).toEqual(acknowledged);
    await expect(
      reconnected.claimNext({
        nodeId: fixture.firstNode,
        afterOrdinal: 0n,
        at: afterApply,
        acknowledgementTimeoutMs: 1_000,
        deliveryToken: deliveryToken(91),
      }),
    ).rejects.toMatchObject({ code: "stale_delivery" });
    expect(reconnected.get(queued.commandId)?.state).toBe("acknowledged");
    const recovered = await reconnected.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterApply,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(90),
    });
    expect(recovered?.commandId).toBe(queued.commandId);
    expect(recovered?.state).toBe("applied");
    expect(recovered?.appliedAt).toBe(afterApply);
    expect(reconnected.get(queued.commandId)?.state).toBe("applied");
    const next = await reconnected.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: queued.ordinal,
      at: afterReplay,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(91),
    });
    expect(next?.commandId).toBe(nextQueued.commandId);
  });

  it("moves an unsafe stale delivery to review and requires an explicit cursor", async () => {
    const fixture = await createFixture();
    const unsafe = await fixture.steering.queue(request(fixture, 100, { kind: "retry" }));
    const safe = await fixture.steering.queue(
      request(fixture, 101, { kind: "message", text: "after unsafe" }),
    );
    const first = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 10,
      deliveryToken: deliveryToken(100),
    });
    expect(first?.commandId).toBe(unsafe.commandId);
    const blocked = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterReplay,
      acknowledgementTimeoutMs: 10,
      deliveryToken: deliveryToken(101),
    });
    expect(blocked).toBeUndefined();
    const reviewed = fixture.steering.get(unsafe.commandId);
    if (reviewed === undefined) {
      throw new Error("unsafe stale command disappeared");
    }
    expect(reviewed.state).toBe("review_required");
    expect(reviewed.recoveryDisposition).toBe("requires_review");
    expect(typeof reviewed.failure).toBe("string");
    const next = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: unsafe.ordinal,
      at: afterReplay,
      acknowledgementTimeoutMs: 10,
      deliveryToken: deliveryToken(101),
    });
    expect(next?.commandId).toBe(safe.commandId);
    expect(next?.deliveryAttempts).toBe(1);
  });

  it("blocks later ordinals behind a failed delivery until the cursor advances", async () => {
    const fixture = await createFixture();
    const failedCommand = await fixture.steering.queue(
      request(fixture, 102, { kind: "message", text: "failed command" }),
    );
    const nextCommand = await fixture.steering.queue(
      request(fixture, 103, { kind: "message", text: "after failed command" }),
    );
    const sent = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(102),
    });
    if (sent === undefined) {
      throw new Error("failed command was not claimed");
    }
    const acknowledged = await fixture.steering.acknowledge({
      delivery: delivery(sent),
      at: afterAck,
    });
    const failed = await fixture.steering.fail({
      delivery: delivery(acknowledged),
      at: afterApply,
      failure: "worker stopped",
      ambiguous: false,
    });
    expect(failed.state).toBe("failed");
    expect(
      await fixture.steering.claimNext({
        nodeId: fixture.firstNode,
        afterOrdinal: 0n,
        at: afterReplay,
        acknowledgementTimeoutMs: 1_000,
        deliveryToken: deliveryToken(103),
      }),
    ).toBeUndefined();
    const next = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: failedCommand.ordinal,
      at: afterReplay,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(103),
    });
    expect(next?.commandId).toBe(nextCommand.commandId);
  });

  it("exposes acknowledgement, application, failure, and invalid transition receipts", async () => {
    const fixture = await createFixture();
    const queued = await fixture.steering.queue(
      request(fixture, 110, { kind: "message", text: "receipt path" }),
    );
    const sent = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(110),
    });
    if (sent === undefined) {
      throw new Error("receipt command was not claimed");
    }
    await expect(
      fixture.steering.apply({
        delivery: delivery(sent),
        at: afterAck,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    const acknowledged = await fixture.steering.acknowledge({
      delivery: delivery(sent),
      at: afterAck,
    });
    expect(acknowledged.state).toBe("acknowledged");
    await expect(
      fixture.steering.fail({
        delivery: delivery(acknowledged),
        at: afterApply,
        failure: "ambiguous after acknowledgement",
        ambiguous: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(fixture.steering.get(queued.commandId)?.state).toBe("acknowledged");
    const failed = await fixture.steering.fail({
      delivery: delivery(acknowledged),
      at: afterApply,
      failure: "worker stopped",
      ambiguous: false,
    });
    expect(failed).toMatchObject({ state: "failed", failure: "worker stopped" });
    expect(fixture.steering.get(queued.commandId)?.failedAt).toBe(afterApply);
  });

  it("rejects a second unresolved resolution command for one attention", async () => {
    const fixture = await createFixture();
    await createQuestionAndApproval(fixture.steering, fixture.firstNode);
    await fixture.steering.queue(
      request(fixture, 126, {
        kind: "answer",
        attentionId: questionAttention,
        answer: "yes",
      }),
    );
    await expect(
      fixture.steering.queue(
        request(fixture, 127, {
          kind: "answer",
          attentionId: questionAttention,
          answer: "no",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_command" });
  });

  it("a review_required resolver still blocks a second resolution command", async () => {
    // The pending-resolver query previously only blocked 'queued'/'sent'/
    // 'acknowledged' deliveries, not 'review_required'. A stale/unsafe
    // redelivery of an answer/approve/reject command (unsafe to redeliver,
    // like the retry case above) moves it to 'review_required' - open but no
    // longer in the blocked-state list - so a second resolver for the SAME
    // attention was wrongly accepted while the first might still be applied
    // externally, risking conflicting/double resolution.
    const fixture = await createFixture();
    await createQuestionAndApproval(fixture.steering, fixture.firstNode);
    const first = await fixture.steering.queue(
      request(fixture, 140, { kind: "answer", attentionId: questionAttention, answer: "yes" }),
    );
    await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 10,
      deliveryToken: deliveryToken(140),
    });
    // Reclaiming after the short ack timeout expires moves the unsafe-to-
    // redeliver answer to review_required (same mechanism as the existing
    // "moves an unsafe stale delivery to review" test above).
    await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterReplay,
      acknowledgementTimeoutMs: 10,
      deliveryToken: deliveryToken(141),
    });
    expect(fixture.steering.get(first.commandId)?.state).toBe("review_required");
    await expect(
      fixture.steering.queue(
        request(fixture, 142, { kind: "answer", attentionId: questionAttention, answer: "no" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_command" });
  });

  it("validates typed attentions and resolves them transactionally on apply", async () => {
    const fixture = await createFixture();
    const [question, approval] = await createQuestionAndApproval(
      fixture.steering,
      fixture.firstNode,
    );
    expect(question.state).toBe("open");
    expect(approval.state).toBe("open");
    expect(fixture.steering.listAttention(fixture.firstNode, true)).toEqual([question, approval]);

    await expect(
      fixture.steering.queue(
        request(fixture, 120, {
          kind: "answer",
          attentionId: questionAttention,
          answer: "not-a-choice",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_command" });
    await expect(
      fixture.steering.queue(
        request(fixture, 121, {
          kind: "answer",
          attentionId: approvalAttention,
          answer: "approved",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_command" });
    await expect(
      fixture.steering.queue(
        request(fixture, 122, {
          kind: "approve",
          attentionId: questionAttention,
          reason: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_command" });

    const queuedAnswer = await fixture.steering.queue(
      request(fixture, 123, {
        kind: "answer",
        attentionId: questionAttention,
        answer: "yes",
      }),
    );
    const sentAnswer = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: 0n,
      at: afterQueue,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(123),
    });
    if (sentAnswer === undefined) {
      throw new Error("answer command was not claimed");
    }
    const acknowledgedAnswer = await fixture.steering.acknowledge({
      delivery: delivery(sentAnswer),
      at: afterAck,
    });
    const appliedAnswer = await fixture.steering.apply({
      delivery: delivery(acknowledgedAnswer),
      at: afterApply,
    });
    expect(appliedAnswer.state).toBe("applied");
    const appliedProjection = projectionChangeForCommand(fixture.database, queuedAnswer.commandId);
    expect(appliedProjection.change.case).toBe("batch");
    if (appliedProjection.change.case !== "batch") {
      throw new Error("applied attention resolution did not emit a projection batch");
    }
    const appliedCommandChange = appliedProjection.change.value.changes.find(
      (change) =>
        change.change.case === "nodeCommandUpserted" &&
        change.change.value.commandId === queuedAnswer.commandId,
    );
    expect(appliedCommandChange?.change.case).toBe("nodeCommandUpserted");
    if (appliedCommandChange?.change.case !== "nodeCommandUpserted") {
      throw new Error("applied projection batch omitted the node command");
    }
    expect(appliedCommandChange.change.value.deliveryState).toBe(NodeCommandDeliveryState.APPLIED);
    const resolvedAttentionChange = appliedProjection.change.value.changes.find(
      (change) =>
        change.change.case === "nodeAttentionUpserted" &&
        change.change.value.id === questionAttention,
    );
    expect(resolvedAttentionChange?.change.case).toBe("nodeAttentionUpserted");
    if (resolvedAttentionChange?.change.case !== "nodeAttentionUpserted") {
      throw new Error("applied projection batch omitted the resolved attention");
    }
    expect(resolvedAttentionChange.change.value.state).toBe(NodeAttentionState.RESOLVED);
    expect(fixture.steering.listAttention(fixture.firstNode, true)).toEqual([approval]);
    expect(fixture.steering.listAttention(fixture.firstNode, false)).toEqual([
      expect.objectContaining({
        id: questionAttention,
        state: "resolved",
        resolutionCommandId: queuedAnswer.commandId,
        resolution: "yes",
      }),
      approval,
    ]);
    expect(
      row(
        fixture.database,
        "SELECT state_kind, resolution_command_id, resolution FROM node_attention_records WHERE id = ?",
        [questionAttention],
      ),
    ).toEqual({
      state_kind: "resolved",
      resolution_command_id: queuedAnswer.commandId,
      resolution: "yes",
    });

    const queuedApproval = await fixture.steering.queue(
      request(
        fixture,
        124,
        {
          kind: "approve",
          attentionId: approvalAttention,
          reason: "ship it",
        },
        { at: afterReplay },
      ),
    );
    const sentApproval = await fixture.steering.claimNext({
      nodeId: fixture.firstNode,
      afterOrdinal: queuedAnswer.ordinal,
      at: afterReplay,
      acknowledgementTimeoutMs: 1_000,
      deliveryToken: deliveryToken(124),
    });
    if (sentApproval === undefined) {
      throw new Error("approval command was not claimed");
    }
    const acknowledgedApproval = await fixture.steering.acknowledge({
      delivery: delivery(sentApproval),
      at: afterReplay,
    });
    await fixture.steering.apply({
      delivery: delivery(acknowledgedApproval),
      at: afterReplay,
    });
    expect(fixture.steering.listAttention(fixture.firstNode, true)).toEqual([]);
    expect(
      row(
        fixture.database,
        "SELECT state_kind, resolution_command_id, resolution FROM node_attention_records WHERE id = ?",
        [approvalAttention],
      ),
    ).toEqual({
      state_kind: "resolved",
      resolution_command_id: queuedApproval.commandId,
      resolution: "ship it",
    });

    await expect(
      fixture.steering.queue(
        request(
          fixture,
          125,
          {
            kind: "reject",
            attentionId: approvalAttention,
            reason: "too late",
          },
          { at: afterReplay },
        ),
      ),
    ).rejects.toMatchObject({ code: "attention_closed" });
    expect(fixture.steering.get(queueCommandId(125))).toBeUndefined();
  });

  it("rejects missing or foreign attentions without affecting sibling rows", async () => {
    const fixture = await createFixture();
    await fixture.steering.createAttention({
      commandId: attentionCommandId(3),
      actorSessionId: actor,
      id: siblingAttention,
      nodeId: fixture.secondNode,
      kind: "question",
      prompt: "Sibling question",
      choices: ["yes"],
      at,
    });
    await expect(
      fixture.steering.queue(
        request(fixture, 130, {
          kind: "answer",
          attentionId: nodeAttentionId("01900000-0000-7000-8000-000000000099"),
          answer: "yes",
        }),
      ),
    ).rejects.toMatchObject({ code: "attention_not_found" });
    await expect(
      fixture.steering.queue(
        request(fixture, 131, {
          kind: "answer",
          attentionId: siblingAttention,
          answer: "yes",
        }),
      ),
    ).rejects.toMatchObject({ code: "attention_not_found" });
    expect(
      fixture.steering.list({ nodeId: fixture.firstNode, afterOrdinal: 0n, limit: 20 }),
    ).toEqual([]);
    expect(
      fixture.steering.list({ nodeId: fixture.secondNode, afterOrdinal: 0n, limit: 20 }),
    ).toEqual([]);
  });

  it("assigns fork-session recovery to a follow-up queued for a terminal node", async () => {
    const fixture = await createFixture();
    await fixture.temporary.database.write((transaction) => {
      transaction.run(
        `UPDATE nodes
            SET state_kind = 'failed',
                outcome_kind = NULL,
                outcome_evidence_id = NULL,
                outcome_explanation = NULL,
                terminal_evidence_id = ?,
                version = version + 1,
                updated_at_ms = ?
          WHERE id = ?`,
        [deterministicId(0x501), afterApply, fixture.firstNode],
      );
    });
    const queued = await fixture.steering.queue(
      request(
        fixture,
        140,
        {
          kind: "follow_up_after_turn",
          text: "continue from the terminal node",
        },
        { at: afterApply },
      ),
    );
    expect(queued.state).toBe("queued");
    expect(queued.recoveryDisposition).toBe("fork_session");
  });

  it("rejects stale expected node versions before allocating an ordinal", async () => {
    const fixture = await createFixture();
    const node = fixture.planRegistry
      .get(tree)
      .nodes.find((candidate) => candidate.id === firstChild);
    if (node === undefined) {
      throw new Error("first child is missing from plan registry");
    }
    await expect(
      fixture.steering.queue(
        request(
          fixture,
          150,
          { kind: "message", text: "stale version" },
          {
            expectedNodeVersion: node.version - 1,
          },
        ),
      ),
    ).rejects.toBeTruthy();
    expect(
      fixture.steering.list({ nodeId: fixture.firstNode, afterOrdinal: 0n, limit: 20 }),
    ).toEqual([]);
    expect(
      row(fixture.database, "SELECT next_ordinal FROM node_command_sequences WHERE node_id = ?", [
        fixture.firstNode,
      ]),
    ).toBeUndefined();
  });

  it("returns not-found for unknown commands and attentions", async () => {
    const fixture = await createFixture();
    const unknown = queueCommandId(160);
    expect(fixture.steering.get(unknown)).toBeUndefined();
    await expect(
      fixture.steering.acknowledge({
        delivery: {
          commandId: unknown,
          deliveryToken: deliveryToken(160),
        },
        at: afterAck,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      fixture.steering.apply({
        delivery: {
          commandId: unknown,
          deliveryToken: deliveryToken(161),
        },
        at: afterApply,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      fixture.steering.fail({
        delivery: {
          commandId: unknown,
          deliveryToken: deliveryToken(162),
        },
        at: afterApply,
        failure: "missing",
        ambiguous: false,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
