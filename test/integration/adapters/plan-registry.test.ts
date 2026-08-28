import { DatabaseSync } from "node:sqlite";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ApprovePlanRequestSchema,
  ApprovePlanResponseSchema,
  CreateTemplatedTreeRequestSchema,
  CreateTreeRequestSchema,
  CreateTreeResponseSchema,
  ImplementationOutputContractSchema,
  NodeState,
  PlanNodeMode,
  PlanRevisionSchema,
  PlanRevisionState,
  PlanAttentionSchema,
  ProposedNodeSchema,
  ProposePlanRequestSchema,
  ProposePlanResponseSchema,
  RegisterRepositoryRequestSchema,
  RepairPlanRequestSchema,
  RepairPlanResponseSchema,
  TaskNodeSchema,
  TaskTreeSchema,
  TaskTemplate,
  TreeBudgetSchema,
  TreeState,
} from "@minions/contracts";
import type { PlanRegistry, RepositoryInspection, SqliteRow } from "@minions/adapters";
import {
  createEventCommitWaiter,
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteCommandStore,
  PlanRegistryError,
} from "@minions/adapters";
import {
  artifactId,
  gitSha,
  hostId,
  resolveTaskTemplate,
  taskNodeId,
  timestampFromEpochMilliseconds,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { FaultInjectingSqliteDatabase, TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

const AT = timestampFromEpochMilliseconds(1_700_000_000_000);
const NEXT = timestampFromEpochMilliseconds(1_700_000_000_100);
const APPROVED = timestampFromEpochMilliseconds(1_700_000_000_200);
const AFTER_APPROVED = timestampFromEpochMilliseconds(1_700_000_000_300);
const FINAL_APPROVED = timestampFromEpochMilliseconds(1_700_000_000_400);
const HOST_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef123456");
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CHANGED_BASE_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const IDS = [
  "018f3a2e-4a20-7b90-8123-abcdef123457",
  "018f3a2e-4a20-7b90-8123-abcdef123458",
  "018f3a2e-4a20-7b90-8123-abcdef123459",
  "018f3a2e-4a20-7b90-8123-abcdef12345a",
  "018f3a2e-4a20-7b90-8123-abcdef12345b",
  "018f3a2e-4a20-7b90-8123-abcdef12345c",
  "018f3a2e-4a20-7b90-8123-abcdef12345d",
  "018f3a2e-4a20-7b90-8123-abcdef12345e",
  "018f3a2e-4a20-7b90-8123-abcdef12345f",
  "018f3a2e-4a20-7b90-8123-abcdef123460",
  "018f3a2e-4a20-7b90-8123-abcdef123461",
  "018f3a2e-4a20-7b90-8123-abcdef123462",
  "018f3a2e-4a20-7b90-8123-abcdef123463",
  "018f3a2e-4a20-7b90-8123-abcdef123464",
  "018f3a2e-4a20-7b90-8123-abcdef123465",
  "018f3a2e-4a20-7b90-8123-abcdef123466",
] as const;
const ACTOR_ID = IDS[0];
const REPOSITORY_ID = IDS[1];
const TREE_ID = IDS[2];
const REVISION_ID = IDS[3];
const ROOT_NODE_ID = IDS[4];
const ROOT_ARTIFACT_ID = IDS[5];
const ATTENTION_ID = IDS[6];
const CREATE_COMMAND_ID = IDS[7];
const PLAN_COMMAND_ID = IDS[8];
const APPROVE_COMMAND_ID = IDS[9];
const CHILD_NODE_ID = IDS[10];
const GENERATED_ID_BASE = 0xabcdef124000;
const DURABLE_TABLES = [
  "schema_migrations",
  "repositories",
  "repository_registrations",
  "repository_features",
  "trees",
  "plan_revisions",
  "nodes",
  "node_acceptance_criteria",
  "node_artifact_inputs",
  "tree_budgets",
  "plan_attentions",
  "node_repository_scope",
  "node_plan_policies",
  "attempts",
  "content_blobs",
  "artifacts",
  "harness_bindings",
  "workspace_bindings",
  "gate_runs",
  "pull_request_observations",
  "restack_runs",
  "operator_commands",
  "external_operations",
  "idempotency_records",
  "events",
  "outbox",
] as const;

type MatrixOperation = "create" | "propose" | "repair" | "approve";

type MatrixFixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  faultDatabase: FaultInjectingSqliteDatabase;
  faultRegistry: PlanRegistry;
  cleanRegistry: PlanRegistry;
}>;

function generatedIds(offset: number): string[] {
  return Array.from(
    { length: 64 },
    (_, index) =>
      `018f3a2e-4a20-7b90-8123-${(GENERATED_ID_BASE + offset + index)
        .toString(16)
        .padStart(12, "0")}`,
  );
}

function inspection(): RepositoryInspection {
  return {
    canonicalRoot: "/repos/alpha",
    canonicalRemote: "https://example.test/project",
    defaultBranch: "main",
    baseCommit: BASE_COMMIT,
    caseSensitive: true,
    submodulePaths: [],
    lfsPaths: [],
    nestedRepositoryPaths: [],
    dirty: false,
  };
}

async function fixture<T>(
  operation: (temporary: TemporarySqliteDatabase, registry: PlanRegistry) => Promise<T>,
): Promise<T> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(AT));
  const notifier = createEventCommitWaiter();
  const commandStore = createSqliteCommandStore({
    database: temporary.database,
    ports: {
      clock: new FixedClock(AT),
      ids: new SequenceIdGenerator([...IDS.slice(12), ...generatedIds(0)]),
    },
    notifier,
  });
  const repositories = createRepositoryRegistry({
    database: temporary.database,
    commandStore,
    hostId: HOST_ID,
  });
  await repositories.register({
    request: create(RegisterRepositoryRequestSchema, {
      commandId: IDS[12],
      actorSessionId: ACTOR_ID,
      repositoryId: REPOSITORY_ID,
      rootPath: "/repos/alpha",
    }),
    inspection: inspection(),
    allowedWorkspaceRoot: "/workspaces/alpha",
    registeredAt: AT,
  });
  const registry = createPlanRegistry({
    database: temporary.database,
    commandStore,
    hostId: HOST_ID,
  });
  try {
    return await operation(temporary, registry);
  } finally {
    notifier.close();
    await temporary.dispose();
  }
}

function budget() {
  return create(TreeBudgetSchema, {
    maxDepth: 4,
    maxFanOut: 4,
    maxNodes: 8,
    maxConcurrency: 4,
    maxAttemptsPerNode: 2,
  });
}

function createRequest() {
  return create(CreateTreeRequestSchema, {
    commandId: CREATE_COMMAND_ID,
    actorSessionId: ACTOR_ID,
    repositoryId: REPOSITORY_ID,
    treeId: TREE_ID,
    planRevisionId: REVISION_ID,
    rootNodeId: ROOT_NODE_ID,
    rootArtifactId: ROOT_ARTIFACT_ID,
    goal: "ship the feature",
    baseCommit: BASE_COMMIT,
    budget: budget(),
    attentionId: ATTENTION_ID,
    rootAllowedRepositoryPaths: [".", "src"],
  });
}

function proposedNode() {
  return create(ProposedNodeSchema, {
    nodeId: CHILD_NODE_ID,
    parentNodeId: ROOT_NODE_ID,
    mode: PlanNodeMode.IMPLEMENTATION,
    objective: "implement the feature",
    acceptanceCriteria: ["the feature works"],
    inputs: [],
    outputContract: {
      case: "implementation",
      value: create(ImplementationOutputContractSchema, {}),
    },
    allowedRepositoryPaths: [".", "src"],
  });
}

function proposeRequest() {
  return create(ProposePlanRequestSchema, {
    commandId: PLAN_COMMAND_ID,
    actorSessionId: ACTOR_ID,
    treeId: TREE_ID,
    planRevisionId: IDS[13],
    goal: "ship the feature",
    nodes: [proposedNode()],
  });
}

function repairRequest() {
  return create(RepairPlanRequestSchema, {
    commandId: PLAN_COMMAND_ID,
    actorSessionId: ACTOR_ID,
    treeId: TREE_ID,
    planRevisionId: IDS[13],
    attentionId: ATTENTION_ID,
    goal: "ship the feature",
    nodes: [proposedNode()],
  });
}

function approveRequest() {
  return create(ApprovePlanRequestSchema, {
    commandId: APPROVE_COMMAND_ID,
    actorSessionId: ACTOR_ID,
    treeId: TREE_ID,
    planRevisionId: IDS[13],
  });
}

async function runMatrixOperation(
  registry: PlanRegistry,
  operation: MatrixOperation,
): Promise<unknown> {
  if (operation === "create") {
    return registry.create({ request: createRequest(), at: AT });
  }
  if (operation === "propose") {
    return registry.propose({ request: proposeRequest(), at: NEXT });
  }
  if (operation === "repair") {
    return registry.repair({ request: repairRequest(), at: NEXT });
  }
  return registry.approve({ request: approveRequest(), at: APPROVED });
}

async function withMatrixFixture<T>(
  operation: MatrixOperation,
  failAtWrite: number,
  callback: (fixture: MatrixFixture) => Promise<T>,
): Promise<T> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(AT));
  const notifier = createEventCommitWaiter();
  try {
    const setupCommandStore = createSqliteCommandStore({
      database: temporary.database,
      ports: { clock: new FixedClock(AT), ids: new SequenceIdGenerator(generatedIds(0)) },
      notifier,
    });
    const repositories = createRepositoryRegistry({
      database: temporary.database,
      commandStore: setupCommandStore,
      hostId: HOST_ID,
    });
    await repositories.register({
      request: create(RegisterRepositoryRequestSchema, {
        commandId: IDS[12],
        actorSessionId: ACTOR_ID,
        repositoryId: REPOSITORY_ID,
        rootPath: "/repos/alpha",
      }),
      inspection: inspection(),
      allowedWorkspaceRoot: "/workspaces/alpha",
      registeredAt: AT,
    });
    const setupRegistry = createPlanRegistry({
      database: temporary.database,
      commandStore: setupCommandStore,
      hostId: HOST_ID,
    });
    if (operation !== "create") {
      await setupRegistry.create({ request: createRequest(), at: AT });
    }
    if (operation === "approve") {
      await setupRegistry.propose({ request: proposeRequest(), at: NEXT });
    }
    const faultDatabase = new FaultInjectingSqliteDatabase(temporary.applicationDatabase, {
      failAtWrite,
      timing: "after",
    });
    const faultCommandStore = createSqliteCommandStore({
      database: faultDatabase,
      ports: { clock: new FixedClock(AT), ids: new SequenceIdGenerator(generatedIds(128)) },
      notifier,
    });
    const cleanCommandStore = createSqliteCommandStore({
      database: temporary.applicationDatabase,
      ports: { clock: new FixedClock(AT), ids: new SequenceIdGenerator(generatedIds(128)) },
      notifier,
    });
    return await callback({
      temporary,
      faultDatabase,
      faultRegistry: createPlanRegistry({
        database: faultDatabase,
        commandStore: faultCommandStore,
        hostId: HOST_ID,
      }),
      cleanRegistry: createPlanRegistry({
        database: temporary.applicationDatabase,
        commandStore: cleanCommandStore,
        hostId: HOST_ID,
      }),
    });
  } finally {
    notifier.close();
    await temporary.dispose();
  }
}

type DurableState = Readonly<Record<string, readonly SqliteRow[]>>;

function durableState(temporary: TemporarySqliteDatabase): DurableState {
  return temporary.database.read((reader) => {
    const state: Record<string, readonly SqliteRow[]> = {};
    for (const table of DURABLE_TABLES) {
      state[table] = reader.all(`SELECT * FROM ${table} ORDER BY rowid`);
    }
    return state;
  });
}

function durableRowCounts(state: DurableState): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(state)) {
    counts[table] = rows.length;
  }
  return counts;
}
function persistedResultPayload(temporary: TemporarySqliteDatabase, commandId: string): Uint8Array {
  const row = temporary.database.read((reader) =>
    reader.get("SELECT result_payload FROM idempotency_records WHERE command_id = ?", [commandId]),
  );
  const payload = row?.["result_payload"];
  if (!(payload instanceof Uint8Array)) {
    throw new Error("replay payload is not binary");
  }
  return payload;
}

function overwriteResultPayload(
  temporary: TemporarySqliteDatabase,
  commandId: string,
  payload: Uint8Array,
): void {
  const database = new DatabaseSync(temporary.path);
  try {
    database.exec("DROP TRIGGER IF EXISTS idempotency_record_is_immutable");
    database
      .prepare("UPDATE idempotency_records SET result_payload = ? WHERE command_id = ?")
      .run(payload, commandId);
  } finally {
    database.close();
  }
}

async function expectReplayFailure(
  promise: Promise<unknown>,
  code: "facts_changed" | "corrupt",
  message: string,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PlanRegistryError);
  if (!(error instanceof PlanRegistryError)) {
    throw new Error("expected a typed plan registry failure");
  }
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
}

async function expectInjectedFailure(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PlanRegistryError);
  if (!(error instanceof PlanRegistryError)) {
    throw new Error("expected a typed plan registry failure");
  }
  expect(error.code).toBe("corrupt");
  expect(error.message).toBe("tree command failed");
}

async function observedWriteCount(operation: MatrixOperation): Promise<number> {
  return withMatrixFixture(operation, Number.MAX_SAFE_INTEGER, async (fixture) => {
    await runMatrixOperation(fixture.faultRegistry, operation);
    expect(fixture.faultDatabase.observedWriteCount).toBeGreaterThan(0);
    return fixture.faultDatabase.observedWriteCount;
  });
}

async function runWriteMatrix(operation: MatrixOperation): Promise<number> {
  const count = await observedWriteCount(operation);
  for (let failAtWrite = 1; failAtWrite <= count; failAtWrite += 1) {
    await withMatrixFixture(operation, failAtWrite, async (fixture) => {
      const before = durableState(fixture.temporary);
      const beforeCounts = durableRowCounts(before);
      await expectInjectedFailure(runMatrixOperation(fixture.faultRegistry, operation));
      expect(fixture.faultDatabase.observedWriteCount).toBe(failAtWrite);
      const afterFailure = durableState(fixture.temporary);
      expect(afterFailure).toEqual(before);
      expect(durableRowCounts(afterFailure)).toEqual(beforeCounts);
      const retried = await runMatrixOperation(fixture.cleanRegistry, operation);
      const replayed = await runMatrixOperation(fixture.cleanRegistry, operation);
      expect(replayed).toEqual(retried);
    });
  }
  return count;
}
describe("SQLite plan registry", () => {
  it("persists create, proposes and approves with durable replay and pagination", async () => {
    await fixture(async (temporary, registry) => {
      const created = await registry.create({ request: createRequest(), at: AT });
      expect(created.state).toBe(1);
      expect(created.nodes).toHaveLength(1);
      expect(created.attention?.id).toBe(ATTENTION_ID);
      const proposedRequest = create(ProposePlanRequestSchema, {
        commandId: PLAN_COMMAND_ID,
        actorSessionId: ACTOR_ID,
        treeId: TREE_ID,
        planRevisionId: IDS[13],
        goal: "ship the feature",
        nodes: [proposedNode()],
      });
      const proposed = await registry.propose({ request: proposedRequest, at: NEXT });
      expect(proposed.revisions).toHaveLength(2);
      expect(proposed.nodes[1]?.id).toBe(CHILD_NODE_ID);
      expect(proposed.attention).toBeUndefined();
      const approvedRequest = create(ApprovePlanRequestSchema, {
        commandId: APPROVE_COMMAND_ID,
        actorSessionId: ACTOR_ID,
        treeId: TREE_ID,
        planRevisionId: IDS[13],
      });
      const approved = await registry.approve({ request: approvedRequest, at: APPROVED });
      const replayProposed = await registry.propose({ request: proposedRequest, at: APPROVED });
      expect(replayProposed).toEqual(proposed);
      const replayApproved = await registry.approve({ request: approvedRequest, at: APPROVED });
      expect(replayApproved).toEqual(approved);
      await expect(registry.create({ request: createRequest(), at: APPROVED })).resolves.toEqual(
        created,
      );
      expect(registry.list({ afterId: undefined, limit: 10 }).map((summary) => summary.id)).toEqual(
        [TREE_ID],
      );
      const rows = temporary.database.read((reader) => ({
        trees: reader.all("SELECT id, version FROM trees"),
        revisions: reader.all("SELECT id, state_kind FROM plan_revisions ORDER BY ordinal"),
        scopes: reader.all(
          "SELECT node_id, ordinal, repository_path FROM node_repository_scope ORDER BY node_id, ordinal",
        ),
        policies: reader.all(
          "SELECT node_id, max_attempts FROM node_plan_policies ORDER BY node_id",
        ),
        commands: reader.all("SELECT * FROM operator_commands"),
        idempotency: reader.all("SELECT * FROM idempotency_records"),
        events: reader.all("SELECT * FROM events"),
      }));
      expect(rows.trees).toHaveLength(1);
      expect(rows.revisions).toHaveLength(2);
      expect(rows.scopes).toEqual([
        { node_id: ROOT_NODE_ID, ordinal: 0n, repository_path: "." },
        { node_id: ROOT_NODE_ID, ordinal: 1n, repository_path: "src" },
        { node_id: CHILD_NODE_ID, ordinal: 0n, repository_path: "." },
        { node_id: CHILD_NODE_ID, ordinal: 1n, repository_path: "src" },
      ]);
      expect(rows.policies).toEqual([
        { node_id: ROOT_NODE_ID, max_attempts: 2n },
        { node_id: CHILD_NODE_ID, max_attempts: 2n },
      ]);
      expect(rows.commands).toHaveLength(4);
      expect(rows.idempotency).toHaveLength(4);
      expect(rows.events).toHaveLength(4);
      expect(registry.get(created.id)).toEqual(approved);
    });
  });
  it("rejects replay payloads with changed root and proposed scope facts", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      const proposedRequest = create(ProposePlanRequestSchema, {
        commandId: PLAN_COMMAND_ID,
        actorSessionId: ACTOR_ID,
        treeId: TREE_ID,
        planRevisionId: IDS[13],
        goal: "ship the feature",
        nodes: [proposedNode()],
      });
      await registry.propose({ request: proposedRequest, at: NEXT });
      const proposedPayload = temporary.database.read((reader) =>
        reader.get("SELECT result_payload FROM idempotency_records WHERE command_id = ?", [
          PLAN_COMMAND_ID,
        ]),
      );
      if (!(proposedPayload?.["result_payload"] instanceof Uint8Array)) {
        throw new Error("proposed replay payload is not binary");
      }
      const proposedResult = fromBinary(
        ProposePlanResponseSchema,
        proposedPayload["result_payload"],
      );
      const proposedNodeMessage = proposedResult.tree?.nodes[1];
      const proposedRootMessage = proposedResult.tree?.nodes[0];
      if (
        proposedResult.tree === undefined ||
        proposedNodeMessage === undefined ||
        proposedRootMessage === undefined
      ) {
        throw new Error("proposed replay tree is incomplete");
      }
      const changedNode = create(TaskNodeSchema, {
        ...proposedNodeMessage,
        allowedRepositoryPaths: ["changed"],
      });
      const changedTree = create(TaskTreeSchema, {
        ...proposedResult.tree,
        nodes: [proposedRootMessage, changedNode],
      });
      const changedResult = create(ProposePlanResponseSchema, {
        ...proposedResult,
        tree: changedTree,
      });
      const changedResultBytes = toBinary(ProposePlanResponseSchema, changedResult);
      expect(
        fromBinary(ProposePlanResponseSchema, changedResultBytes).tree?.nodes[1]
          ?.allowedRepositoryPaths,
      ).toEqual(["changed"]);
      const corruptProposedDatabase = new DatabaseSync(temporary.path);
      try {
        corruptProposedDatabase.exec("DROP TRIGGER IF EXISTS idempotency_record_is_immutable");
        corruptProposedDatabase
          .prepare("UPDATE idempotency_records SET result_payload = ? WHERE command_id = ?")
          .run(changedResultBytes, PLAN_COMMAND_ID);
      } finally {
        corruptProposedDatabase.close();
      }
      const storedProposedPayload = temporary.database.read((reader) =>
        reader.get("SELECT result_payload FROM idempotency_records WHERE command_id = ?", [
          PLAN_COMMAND_ID,
        ]),
      );
      if (!(storedProposedPayload?.["result_payload"] instanceof Uint8Array)) {
        throw new Error("stored proposed replay payload is not binary");
      }
      expect(
        fromBinary(ProposePlanResponseSchema, storedProposedPayload["result_payload"]).tree
          ?.nodes[1]?.allowedRepositoryPaths,
      ).toEqual(["changed"]);
      await expect(registry.propose({ request: proposedRequest, at: NEXT })).rejects.toMatchObject({
        code: "facts_changed",
        message: "replayed plan nodes differ from request",
      });
      const createPayload = temporary.database.read((reader) =>
        reader.get("SELECT result_payload FROM idempotency_records WHERE command_id = ?", [
          CREATE_COMMAND_ID,
        ]),
      );
      if (!(createPayload?.["result_payload"] instanceof Uint8Array)) {
        throw new Error("create replay payload is not binary");
      }
      const createResult = fromBinary(CreateTreeResponseSchema, createPayload["result_payload"]);
      const root = createResult.tree?.nodes[0];
      if (createResult.tree === undefined || root === undefined) {
        throw new Error("create replay tree is incomplete");
      }
      const changedRoot = create(TaskNodeSchema, {
        ...root,
        objective: "changed",
      });
      const changedCreateTree = create(TaskTreeSchema, {
        ...createResult.tree,
        nodes: [changedRoot],
      });
      const changedCreateResult = create(CreateTreeResponseSchema, {
        ...createResult,
        tree: changedCreateTree,
      });
      const changedCreateBytes = toBinary(CreateTreeResponseSchema, changedCreateResult);
      expect(
        fromBinary(CreateTreeResponseSchema, changedCreateBytes).tree?.nodes[0]?.objective,
      ).toBe("changed");
      const corruptCreateDatabase = new DatabaseSync(temporary.path);
      try {
        corruptCreateDatabase.exec("DROP TRIGGER IF EXISTS idempotency_record_is_immutable");
        corruptCreateDatabase
          .prepare("UPDATE idempotency_records SET result_payload = ? WHERE command_id = ?")
          .run(changedCreateBytes, CREATE_COMMAND_ID);
      } finally {
        corruptCreateDatabase.close();
      }
      await expect(registry.create({ request: createRequest(), at: AT })).rejects.toMatchObject({
        code: "facts_changed",
        message: "replayed structural root facts differ from create request",
      });
    });
  });

  it("rejects historical propose replay with a forged child lifecycle", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      const request = proposeRequest();
      const proposed = await registry.propose({ request, at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });
      await expect(registry.propose({ request, at: NEXT })).resolves.toEqual(proposed);

      const result = fromBinary(
        ProposePlanResponseSchema,
        persistedResultPayload(temporary, PLAN_COMMAND_ID),
      );
      const tree = result.tree;
      const child = tree?.nodes.find((node) => node.id === CHILD_NODE_ID);
      if (tree === undefined || child === undefined) {
        throw new Error("proposed replay tree is incomplete");
      }
      const revision = tree.revisions.find(
        (candidate) => candidate.id === tree.activePlanRevisionId,
      );
      if (revision === undefined) {
        throw new Error("proposed replay revision is incomplete");
      }
      const changedRevision = create(PlanRevisionSchema, {
        ...revision,
        state: PlanRevisionState.APPROVED,
        version: revision.version + 1n,
        approvedAt: tree.updatedAt,
      });
      const changedNode = create(TaskNodeSchema, {
        ...child,
        state: NodeState.READY,
        version: child.version + 1n,
        updatedAt: tree.updatedAt,
      });
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        state: TreeState.APPROVED,
        revisions: tree.revisions.map((value) =>
          value.id === revision.id ? changedRevision : value,
        ),
        nodes: tree.nodes.map((node) => (node.id === CHILD_NODE_ID ? changedNode : node)),
      });
      const changedResult = create(ProposePlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(ProposePlanResponseSchema, changedResult);
      const changedTreeMessage = fromBinary(ProposePlanResponseSchema, changedBytes).tree;
      expect(changedTreeMessage?.state).toBe(TreeState.APPROVED);
      expect(changedTreeMessage?.nodes.find((node) => node.id === CHILD_NODE_ID)?.state).toBe(
        NodeState.READY,
      );
      overwriteResultPayload(temporary, PLAN_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.propose({ request, at: NEXT }),
        "facts_changed",
        "replayed plan lifecycle differs from request",
      );
    });
  });

  it("rejects historical propose replay after changing the immutable base commit", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      const request = proposeRequest();
      const proposed = await registry.propose({ request, at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });
      await expect(registry.propose({ request, at: NEXT })).resolves.toEqual(proposed);

      const result = fromBinary(
        ProposePlanResponseSchema,
        persistedResultPayload(temporary, PLAN_COMMAND_ID),
      );
      const tree = result.tree;
      if (tree === undefined) {
        throw new Error("proposed replay tree is incomplete");
      }
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        baseCommit: CHANGED_BASE_COMMIT,
      });
      const changedResult = create(ProposePlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(ProposePlanResponseSchema, changedResult);
      expect(fromBinary(ProposePlanResponseSchema, changedBytes).tree?.baseCommit).toBe(
        CHANGED_BASE_COMMIT,
      );
      overwriteResultPayload(temporary, PLAN_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.propose({ request, at: NEXT }),
        "corrupt",
        "historical plan result changes immutable tree facts",
      );
    });
  });

  it("rejects historical plan replay with a forged superseded child lifecycle", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      await registry.propose({ request: proposeRequest(), at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });

      const generated = generatedIds(192);
      const planTwoCommandId = generated[0];
      const planTwoRevisionId = generated[1];
      const planTwoNodeId = generated[2];
      const planTwoApproveCommandId = generated[3];
      if (
        planTwoCommandId === undefined ||
        planTwoRevisionId === undefined ||
        planTwoNodeId === undefined ||
        planTwoApproveCommandId === undefined
      ) {
        throw new Error("plan two IDs are unavailable");
      }
      const planTwoRequest = create(ProposePlanRequestSchema, {
        ...proposeRequest(),
        commandId: planTwoCommandId,
        planRevisionId: planTwoRevisionId,
        nodes: [
          create(ProposedNodeSchema, {
            ...proposedNode(),
            nodeId: planTwoNodeId,
            objective: "implement the second feature",
          }),
        ],
      });
      const proposed = await registry.propose({ request: planTwoRequest, at: AFTER_APPROVED });
      const planTwoApproveRequest = create(ApprovePlanRequestSchema, {
        ...approveRequest(),
        commandId: planTwoApproveCommandId,
        planRevisionId: planTwoRevisionId,
      });
      await registry.approve({ request: planTwoApproveRequest, at: FINAL_APPROVED });
      await expect(
        registry.propose({ request: planTwoRequest, at: AFTER_APPROVED }),
      ).resolves.toEqual(proposed);

      const result = fromBinary(
        ProposePlanResponseSchema,
        persistedResultPayload(temporary, planTwoCommandId),
      );
      const tree = result.tree;
      const child = tree?.nodes.find((node) => node.id === CHILD_NODE_ID);
      if (tree === undefined || child === undefined) {
        throw new Error("plan two replay tree is incomplete");
      }
      expect(child.state).toBe(NodeState.SUPERSEDED);
      const changedChild = create(TaskNodeSchema, {
        ...child,
        state: NodeState.PLANNED,
      });
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        nodes: tree.nodes.map((node) => (node.id === CHILD_NODE_ID ? changedChild : node)),
      });
      const changedResult = create(ProposePlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(ProposePlanResponseSchema, changedResult);
      const changedChildMessage = fromBinary(
        ProposePlanResponseSchema,
        changedBytes,
      ).tree?.nodes.find((node) => node.id === CHILD_NODE_ID);
      expect(changedChildMessage?.state).toBe(NodeState.PLANNED);
      overwriteResultPayload(temporary, planTwoCommandId, changedBytes);

      await expectReplayFailure(
        registry.propose({ request: planTwoRequest, at: AFTER_APPROVED }),
        "corrupt",
        "historical plan result changes immutable node facts",
      );
    });
  });

  it("rejects historical repair replay with a forged child lifecycle", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      const request = repairRequest();
      const repaired = await registry.repair({ request, at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });
      await expect(registry.repair({ request, at: NEXT })).resolves.toEqual(repaired);

      const result = fromBinary(
        RepairPlanResponseSchema,
        persistedResultPayload(temporary, PLAN_COMMAND_ID),
      );
      const tree = result.tree;
      const child = tree?.nodes.find((node) => node.id === CHILD_NODE_ID);
      if (tree === undefined || child === undefined) {
        throw new Error("repaired replay tree is incomplete");
      }
      const revision = tree.revisions.find(
        (candidate) => candidate.id === tree.activePlanRevisionId,
      );
      if (revision === undefined) {
        throw new Error("repaired replay revision is incomplete");
      }
      const changedRevision = create(PlanRevisionSchema, {
        ...revision,
        state: PlanRevisionState.APPROVED,
        version: revision.version + 1n,
        approvedAt: tree.updatedAt,
      });
      const changedNode = create(TaskNodeSchema, {
        ...child,
        state: NodeState.READY,
        version: child.version + 1n,
        updatedAt: tree.updatedAt,
      });
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        state: TreeState.APPROVED,
        revisions: tree.revisions.map((value) =>
          value.id === revision.id ? changedRevision : value,
        ),
        nodes: tree.nodes.map((node) => (node.id === CHILD_NODE_ID ? changedNode : node)),
      });
      const changedResult = create(RepairPlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(RepairPlanResponseSchema, changedResult);
      const changedTreeMessage = fromBinary(RepairPlanResponseSchema, changedBytes).tree;
      expect(changedTreeMessage?.state).toBe(TreeState.APPROVED);
      expect(changedTreeMessage?.nodes.find((node) => node.id === CHILD_NODE_ID)?.state).toBe(
        NodeState.READY,
      );
      overwriteResultPayload(temporary, PLAN_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.repair({ request, at: NEXT }),
        "facts_changed",
        "replayed plan lifecycle differs from request",
      );
    });
  });

  it("rejects historical repair replay after changing the immutable base commit", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      const request = repairRequest();
      const repaired = await registry.repair({ request, at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });
      await expect(registry.repair({ request, at: NEXT })).resolves.toEqual(repaired);

      const result = fromBinary(
        RepairPlanResponseSchema,
        persistedResultPayload(temporary, PLAN_COMMAND_ID),
      );
      const tree = result.tree;
      if (tree === undefined) {
        throw new Error("repaired replay tree is incomplete");
      }
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        baseCommit: CHANGED_BASE_COMMIT,
      });
      const changedResult = create(RepairPlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(RepairPlanResponseSchema, changedResult);
      expect(fromBinary(RepairPlanResponseSchema, changedBytes).tree?.baseCommit).toBe(
        CHANGED_BASE_COMMIT,
      );
      overwriteResultPayload(temporary, PLAN_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.repair({ request, at: NEXT }),
        "corrupt",
        "historical plan result changes immutable tree facts",
      );
    });
  });

  it("rejects historical repair replay with a forged older revision lifecycle", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      const request = repairRequest();
      const repaired = await registry.repair({ request, at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });
      await expect(registry.repair({ request, at: NEXT })).resolves.toEqual(repaired);

      const result = fromBinary(
        RepairPlanResponseSchema,
        persistedResultPayload(temporary, PLAN_COMMAND_ID),
      );
      const tree = result.tree;
      const revision = tree?.revisions.find((candidate) => candidate.id === REVISION_ID);
      if (tree === undefined || revision === undefined) {
        throw new Error("repaired replay revision is incomplete");
      }
      const changedRevision = create(PlanRevisionSchema, {
        ...revision,
        state: PlanRevisionState.APPROVED,
        version: revision.version + 1n,
        approvedAt: tree.updatedAt,
      });
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        revisions: tree.revisions.map((value) =>
          value.id === REVISION_ID ? changedRevision : value,
        ),
      });
      const changedResult = create(RepairPlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(RepairPlanResponseSchema, changedResult);
      const changedRevisionMessage = fromBinary(
        RepairPlanResponseSchema,
        changedBytes,
      ).tree?.revisions.find((candidate) => candidate.id === REVISION_ID);
      expect(changedRevisionMessage?.state).toBe(PlanRevisionState.APPROVED);
      expect(changedRevisionMessage?.version).toBe(1n);
      expect(changedRevisionMessage?.approvedAt).toEqual(tree.updatedAt);
      overwriteResultPayload(temporary, PLAN_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.repair({ request, at: NEXT }),
        "corrupt",
        "historical plan result changes immutable revision facts",
      );
    });
  });

  it("rejects historical approval replay after removing an approved child", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      await registry.propose({ request: proposeRequest(), at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });

      const advancedRequest = create(ProposePlanRequestSchema, {
        ...proposeRequest(),
        commandId: IDS[14],
        planRevisionId: IDS[15],
        nodes: [
          create(ProposedNodeSchema, {
            ...proposedNode(),
            nodeId: IDS[11],
          }),
        ],
      });
      await registry.propose({ request: advancedRequest, at: AFTER_APPROVED });

      const result = fromBinary(
        ApprovePlanResponseSchema,
        persistedResultPayload(temporary, APPROVE_COMMAND_ID),
      );
      const tree = result.tree;
      if (tree?.nodes.find((node) => node.id === CHILD_NODE_ID) === undefined) {
        throw new Error("approved replay tree is incomplete");
      }
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        nodes: tree.nodes.filter((node) => node.id !== CHILD_NODE_ID),
      });
      const changedResult = create(ApprovePlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(ApprovePlanResponseSchema, changedResult);
      expect(
        fromBinary(ApprovePlanResponseSchema, changedBytes).tree?.nodes.some(
          (node) => node.id === CHILD_NODE_ID,
        ),
      ).toBe(false);
      overwriteResultPayload(temporary, APPROVE_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.approve({ request: approveRequest(), at: APPROVED }),
        "facts_changed",
        "replayed approval facts differ from request",
      );
    });
  });

  it("rejects historical approval replay when an approved child is omitted", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      const secondNode = create(ProposedNodeSchema, {
        ...proposedNode(),
        nodeId: IDS[11],
        objective: "implement another feature",
      });
      const request = create(ProposePlanRequestSchema, {
        ...proposeRequest(),
        nodes: [proposedNode(), secondNode],
      });
      await registry.propose({ request, at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });

      const [advancedNodeId] = generatedIds(192);
      if (advancedNodeId === undefined) {
        throw new Error("advanced node ID is unavailable");
      }
      const advancedRequest = create(ProposePlanRequestSchema, {
        ...proposeRequest(),
        commandId: IDS[14],
        planRevisionId: IDS[15],
        nodes: [
          create(ProposedNodeSchema, {
            ...proposedNode(),
            nodeId: advancedNodeId,
          }),
        ],
      });
      await registry.propose({ request: advancedRequest, at: AFTER_APPROVED });

      const result = fromBinary(
        ApprovePlanResponseSchema,
        persistedResultPayload(temporary, APPROVE_COMMAND_ID),
      );
      const tree = result.tree;
      if (tree === undefined) {
        throw new Error("approved replay tree is incomplete");
      }
      expect(tree.nodes.filter((node) => node.mode === PlanNodeMode.IMPLEMENTATION)).toHaveLength(
        2,
      );
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        nodes: tree.nodes.filter((node) => node.id !== CHILD_NODE_ID),
      });
      const changedResult = create(ApprovePlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(ApprovePlanResponseSchema, changedResult);
      const changedTreeMessage = fromBinary(ApprovePlanResponseSchema, changedBytes).tree;
      expect(
        changedTreeMessage?.nodes.filter((node) => node.mode === PlanNodeMode.IMPLEMENTATION),
      ).toHaveLength(1);
      overwriteResultPayload(temporary, APPROVE_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.approve({ request: approveRequest(), at: APPROVED }),
        "corrupt",
        "historical plan result omits persisted nodes",
      );
    });
  });

  it("rejects historical approval replay after changing the immutable base commit", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      await registry.propose({ request: proposeRequest(), at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });

      const advancedRequest = create(ProposePlanRequestSchema, {
        ...proposeRequest(),
        commandId: IDS[14],
        planRevisionId: IDS[15],
        nodes: [
          create(ProposedNodeSchema, {
            ...proposedNode(),
            nodeId: IDS[11],
          }),
        ],
      });
      await registry.propose({ request: advancedRequest, at: AFTER_APPROVED });

      const result = fromBinary(
        ApprovePlanResponseSchema,
        persistedResultPayload(temporary, APPROVE_COMMAND_ID),
      );
      const tree = result.tree;
      if (tree === undefined) {
        throw new Error("approved replay tree is incomplete");
      }
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        baseCommit: CHANGED_BASE_COMMIT,
      });
      const changedResult = create(ApprovePlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(ApprovePlanResponseSchema, changedResult);
      expect(fromBinary(ApprovePlanResponseSchema, changedBytes).tree?.baseCommit).toBe(
        CHANGED_BASE_COMMIT,
      );
      overwriteResultPayload(temporary, APPROVE_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.approve({ request: approveRequest(), at: APPROVED }),
        "corrupt",
        "historical plan result changes immutable tree facts",
      );
    });
  });

  it("rejects historical approval replay with a forged ready child version", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      await registry.propose({ request: proposeRequest(), at: NEXT });
      const approved = await registry.approve({ request: approveRequest(), at: APPROVED });

      const advancedRequest = create(ProposePlanRequestSchema, {
        ...proposeRequest(),
        commandId: IDS[14],
        planRevisionId: IDS[15],
        nodes: [
          create(ProposedNodeSchema, {
            ...proposedNode(),
            nodeId: IDS[11],
          }),
        ],
      });
      await registry.propose({ request: advancedRequest, at: AFTER_APPROVED });
      await expect(registry.approve({ request: approveRequest(), at: APPROVED })).resolves.toEqual(
        approved,
      );

      const result = fromBinary(
        ApprovePlanResponseSchema,
        persistedResultPayload(temporary, APPROVE_COMMAND_ID),
      );
      const tree = result.tree;
      const child = tree?.nodes.find((node) => node.id === CHILD_NODE_ID);
      if (tree === undefined || child === undefined) {
        throw new Error("approved replay tree is incomplete");
      }
      expect(child.state).toBe(NodeState.READY);
      expect(child.version).toBe(1n);
      expect(child.updatedAt).toEqual(tree.updatedAt);
      const changedChild = create(TaskNodeSchema, {
        ...child,
        version: 0n,
        updatedAt: child.createdAt,
      });
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        nodes: tree.nodes.map((node) => (node.id === CHILD_NODE_ID ? changedChild : node)),
      });
      const changedResult = create(ApprovePlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(ApprovePlanResponseSchema, changedResult);
      const changedChildMessage = fromBinary(
        ApprovePlanResponseSchema,
        changedBytes,
      ).tree?.nodes.find((node) => node.id === CHILD_NODE_ID);
      expect(changedChildMessage?.state).toBe(NodeState.READY);
      expect(changedChildMessage?.version).toBe(0n);
      expect(changedChildMessage?.updatedAt).toEqual(child.createdAt);
      overwriteResultPayload(temporary, APPROVE_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.approve({ request: approveRequest(), at: APPROVED }),
        "facts_changed",
        "replayed approval facts differ from request",
      );
    });
  });

  it("rejects historical propose replay with a forged original revision version", async () => {
    await fixture(async (temporary, registry) => {
      await registry.create({ request: createRequest(), at: AT });
      const request = proposeRequest();
      const proposed = await registry.propose({ request, at: NEXT });
      await registry.approve({ request: approveRequest(), at: APPROVED });
      await expect(registry.propose({ request, at: NEXT })).resolves.toEqual(proposed);

      const result = fromBinary(
        ProposePlanResponseSchema,
        persistedResultPayload(temporary, PLAN_COMMAND_ID),
      );
      const tree = result.tree;
      const revision = tree?.revisions.find((candidate) => candidate.id === REVISION_ID);
      if (tree === undefined || revision === undefined) {
        throw new Error("proposed replay revision is incomplete");
      }
      expect(revision.state).toBe(PlanRevisionState.DRAFT);
      expect(revision.version).toBe(0n);
      const changedRevision = create(PlanRevisionSchema, {
        ...revision,
        version: 99n,
      });
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        revisions: tree.revisions.map((value) =>
          value.id === REVISION_ID ? changedRevision : value,
        ),
      });
      const changedResult = create(ProposePlanResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(ProposePlanResponseSchema, changedResult);
      const changedRevisionMessage = fromBinary(
        ProposePlanResponseSchema,
        changedBytes,
      ).tree?.revisions.find((candidate) => candidate.id === REVISION_ID);
      expect(changedRevisionMessage?.state).toBe(PlanRevisionState.DRAFT);
      expect(changedRevisionMessage?.version).toBe(99n);
      overwriteResultPayload(temporary, PLAN_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.propose({ request, at: NEXT }),
        "corrupt",
        "historical plan result changes immutable revision facts",
      );
    });
  });

  it("rejects historical create replay with a forged attention revision binding", async () => {
    await fixture(async (temporary, registry) => {
      const created = await registry.create({ request: createRequest(), at: AT });
      await registry.propose({ request: proposeRequest(), at: NEXT });
      await expect(registry.create({ request: createRequest(), at: AT })).resolves.toEqual(created);

      const result = fromBinary(
        CreateTreeResponseSchema,
        persistedResultPayload(temporary, CREATE_COMMAND_ID),
      );
      const tree = result.tree;
      const attention = tree?.attention;
      if (tree === undefined || attention === undefined) {
        throw new Error("created replay attention is incomplete");
      }
      expect(attention.planRevisionId).toBe(REVISION_ID);
      const changedAttention = create(PlanAttentionSchema, {
        ...attention,
        planRevisionId: undefined,
      });
      const changedTree = create(TaskTreeSchema, {
        ...tree,
        attention: changedAttention,
      });
      const changedResult = create(CreateTreeResponseSchema, {
        ...result,
        tree: changedTree,
      });
      const changedBytes = toBinary(CreateTreeResponseSchema, changedResult);
      const changedAttentionMessage = fromBinary(CreateTreeResponseSchema, changedBytes).tree
        ?.attention;
      expect(changedAttentionMessage?.planRevisionId).toBeUndefined();
      overwriteResultPayload(temporary, CREATE_COMMAND_ID, changedBytes);

      await expectReplayFailure(
        registry.create({ request: createRequest(), at: AT }),
        "facts_changed",
        "replayed structural root facts differ from create request",
      );
    });
  });

  it("rolls back every create write boundary and replays the retry", async () => {
    const count = await runWriteMatrix("create");
    expect(count).toBeGreaterThan(0);
  }, 30_000);

  it("rolls back every propose write boundary and replays the retry", async () => {
    const count = await runWriteMatrix("propose");
    expect(count).toBeGreaterThan(0);
  }, 30_000);

  it("rolls back every repair write boundary and replays the retry", async () => {
    const count = await runWriteMatrix("repair");
    expect(count).toBeGreaterThan(0);
  }, 30_000);

  it("rolls back every approve write boundary and replays the retry", async () => {
    const count = await runWriteMatrix("approve");
    expect(count).toBeGreaterThan(0);
  }, 30_000);

  it("rejects a missing repository before opening a tree transaction", async () => {
    await fixture(async (_temporary, registry) => {
      const request = createRequest();
      request.repositoryId = IDS[14];
      await expect(registry.create({ request, at: AT })).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });

  it("creates an approved EXPLAIN tree with a ready research child and replays identically", async () => {
    await fixture(async (_temporary, registry) => {
      const prompt = "explain the cache subsystem";
      const resolved = resolveTaskTemplate("explain", prompt);
      const request = create(CreateTemplatedTreeRequestSchema, {
        commandId: CREATE_COMMAND_ID,
        actorSessionId: ACTOR_ID,
        repositoryId: REPOSITORY_ID,
        treeId: TREE_ID,
        planRevisionId: REVISION_ID,
        rootNodeId: ROOT_NODE_ID,
        rootArtifactId: ROOT_ARTIFACT_ID,
        attentionId: ATTENTION_ID,
        template: TaskTemplate.EXPLAIN,
        prompt,
      });
      const mintedNodes = [
        {
          nodeId: taskNodeId(CHILD_NODE_ID),
          artifactId: artifactId(IDS[11]),
        },
      ];
      const tree = await registry.createTemplated({
        request,
        resolved,
        baseCommit: gitSha(BASE_COMMIT),
        mintedNodes,
        at: AT,
      });
      expect(tree.id).toBe(TREE_ID);
      expect(tree.state).toBe(TreeState.APPROVED);
      expect(tree.version).toBe(0);
      expect(tree.attention).toBeUndefined();
      expect(tree.revisions).toHaveLength(1);
      expect(tree.revisions[0]?.state).toBe(PlanRevisionState.APPROVED);
      expect(tree.revisions[0]?.version).toBe(1);
      expect(tree.nodes).toHaveLength(2);
      const child = tree.nodes.find((node) => node.id === CHILD_NODE_ID);
      expect(child).toBeDefined();
      expect(child?.mode).toBe(PlanNodeMode.RESEARCH);
      expect(child?.state).toBe(NodeState.READY);
      expect(child?.version).toBe(1);
      expect(child?.parentNodeId).toBe(ROOT_NODE_ID);

      const replayed = await registry.createTemplated({
        request,
        resolved,
        baseCommit: gitSha(BASE_COMMIT),
        mintedNodes,
        at: AT,
      });
      expect(replayed).toEqual(tree);
    });
  });

  it("creates a draft FIX tree with chained research child and implementation grandchild", async () => {
    await fixture(async (_temporary, registry) => {
      const prompt = "fix memory leak in stream processor";
      const resolved = resolveTaskTemplate("fix", prompt);
      const request = create(CreateTemplatedTreeRequestSchema, {
        commandId: CREATE_COMMAND_ID,
        actorSessionId: ACTOR_ID,
        repositoryId: REPOSITORY_ID,
        treeId: TREE_ID,
        planRevisionId: REVISION_ID,
        rootNodeId: ROOT_NODE_ID,
        rootArtifactId: ROOT_ARTIFACT_ID,
        attentionId: ATTENTION_ID,
        template: TaskTemplate.FIX,
        prompt,
      });
      const researchChildId = CHILD_NODE_ID;
      const implementationGrandchildId = IDS[11];
      const mintedNodes = [
        {
          nodeId: taskNodeId(researchChildId),
          artifactId: artifactId(IDS[13]),
        },
        {
          nodeId: taskNodeId(implementationGrandchildId),
        },
      ];
      const tree = await registry.createTemplated({
        request,
        resolved,
        baseCommit: gitSha(BASE_COMMIT),
        mintedNodes,
        at: AT,
      });
      expect(tree.id).toBe(TREE_ID);
      expect(tree.state).toBe(TreeState.DRAFT);
      expect(tree.version).toBe(0);
      expect(tree.attention).toBeUndefined();
      expect(tree.revisions).toHaveLength(1);
      expect(tree.revisions[0]?.state).toBe(PlanRevisionState.DRAFT);
      expect(tree.revisions[0]?.version).toBe(0);
      expect(tree.nodes).toHaveLength(3);

      const researchNode = tree.nodes.find((node) => node.id === researchChildId);
      expect(researchNode).toBeDefined();
      expect(researchNode?.mode).toBe(PlanNodeMode.RESEARCH);
      expect(researchNode?.state).toBe(NodeState.PLANNED);
      expect(researchNode?.version).toBe(0);
      expect(researchNode?.parentNodeId).toBe(ROOT_NODE_ID);

      const implementationNode = tree.nodes.find((node) => node.id === implementationGrandchildId);
      expect(implementationNode).toBeDefined();
      expect(implementationNode?.mode).toBe(PlanNodeMode.IMPLEMENTATION);
      expect(implementationNode?.state).toBe(NodeState.PLANNED);
      expect(implementationNode?.version).toBe(0);
      expect(implementationNode?.parentNodeId).toBe(researchChildId);
      expect(implementationNode?.parentNodeId).not.toBe(ROOT_NODE_ID);
    });
  });
});
