import { create, fromBinary } from "@bufbuild/protobuf";
import {
  AttentionKind,
  ApprovePlanRequestSchema,
  ArtifactInputSchema,
  ArtifactOutputContractSchema,
  CreateTreeRequestSchema,
  ImplementationOutputContractSchema,
  NodeState,
  PlanNodeMode,
  PlanRevisionState,
  ProjectionChangeSchema,
  ProposedNodeSchema,
  ProposePlanRequestSchema,
  RegisterRepositoryRequestSchema,
  RepairPlanRequestSchema,
  TreeBudgetSchema,
  TreeState,
} from "@minions/contracts";
import type {
  ProjectionChange,
  ProposedNode,
  ProposePlanRequest,
  RepairPlanRequest,
  TreeBudget,
} from "@minions/contracts";
import {
  createEventCommitWaiter,
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteCommandStore,
  PlanRegistryError,
} from "@minions/adapters";
import type { PlanRegistry, PlanRegistryErrorCode, RepositoryInspection } from "@minions/adapters";
import { hostId, taskTreeId, timestampFromEpochMilliseconds } from "@minions/core";
import type { Timestamp } from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { FaultInjectingSqliteDatabase, TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

const id = (offset: number): string =>
  `018f3a2e-4a20-7b90-8123-${(0xabcdef123400 + offset).toString(16).padStart(12, "0")}`;

const AT = timestampFromEpochMilliseconds(1_700_000_000_000);
const BEFORE = timestampFromEpochMilliseconds(1_699_999_999_900);
const NEXT = timestampFromEpochMilliseconds(1_700_000_000_100);
const APPROVED = timestampFromEpochMilliseconds(1_700_000_000_200);
const LATER = timestampFromEpochMilliseconds(1_700_000_000_300);
const HOST_ID = hostId(id(1));
const ACTOR_ID = id(2);
const REPOSITORY_ID = id(3);
const TREE_ID = id(4);
const REVISION_ONE_ID = id(5);
const ROOT_NODE_ID = id(6);
const ROOT_ARTIFACT_ID = id(7);
const ATTENTION_ID = id(8);
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_BASE_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

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

type Fixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  registry: PlanRegistry;
}>;
type FaultFixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  registry: PlanRegistry;
  faultDatabase: FaultInjectingSqliteDatabase;
}>;

type CreateTreeOptions = Readonly<{
  commandId?: string;
  actorSessionId?: string;
  repositoryId?: string;
  treeId?: string;
  planRevisionId?: string;
  rootNodeId?: string;
  rootArtifactId?: string;
  goal?: string;
  baseCommit?: string;
  budget?: TreeBudget;
  attentionId?: string;
  rootAllowedRepositoryPaths?: readonly string[];
}>;

type ProposedNodeOptions = Readonly<{
  nodeId?: string;
  parentNodeId?: string;
  mode?: PlanNodeMode;
  objective?: string;
  acceptanceCriteria?: readonly string[];
  inputs?: readonly Readonly<{ artifactId: string; sourceNodeId: string }>[];
  allowedRepositoryPaths?: readonly string[];
  output?:
    | Readonly<{ kind: "artifact"; artifactId: string; artifactType?: string }>
    | Readonly<{ kind: "implementation" }>;
}>;

type ProposeOptions = Readonly<{
  commandId: string;
  treeId?: string;
  planRevisionId: string;
  goal?: string;
  nodes: ProposedNode[];
  at?: Timestamp;
}>;

type ApproveOptions = Readonly<{
  commandId: string;
  treeId?: string;
  planRevisionId: string;
  at?: Timestamp;
}>;

type InvalidCase = Readonly<{
  name: string;
  expectedCode: "not_found" | "invalid_input" | "invalid_plan" | "identity_conflict";
  prepare?: (fixture: Fixture) => Promise<void>;
  run: (fixture: Fixture) => Promise<unknown>;
}>;

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

async function withFixture<T>(operation: (fixture: Fixture) => Promise<T>): Promise<T> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(AT));
  const notifier = createEventCommitWaiter();
  const commandStore = createSqliteCommandStore({
    database: temporary.database,
    ports: {
      clock: new FixedClock(AT),
      ids: new SequenceIdGenerator(Array.from({ length: 32 }, (_, index) => id(1000 + index))),
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
      commandId: id(10),
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
    return await operation({ temporary, registry });
  } finally {
    notifier.close();
    await temporary.dispose();
  }
}
async function withFaultFixture<T>(operation: (fixture: FaultFixture) => Promise<T>): Promise<T> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(AT));
  const notifier = createEventCommitWaiter();
  const setupCommandStore = createSqliteCommandStore({
    database: temporary.database,
    ports: {
      clock: new FixedClock(AT),
      ids: new SequenceIdGenerator(Array.from({ length: 8 }, (_, index) => id(3000 + index))),
    },
    notifier,
  });
  const repositories = createRepositoryRegistry({
    database: temporary.database,
    commandStore: setupCommandStore,
    hostId: HOST_ID,
  });
  await repositories.register({
    request: create(RegisterRepositoryRequestSchema, {
      commandId: id(3010),
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
  await setupRegistry.create({ request: createTreeRequest(), at: AT });
  const faultDatabase = new FaultInjectingSqliteDatabase(temporary.applicationDatabase, {
    failAtWrite: 10,
    timing: "after",
  });
  const commandStore = createSqliteCommandStore({
    database: faultDatabase,
    ports: {
      clock: new FixedClock(AT),
      ids: new SequenceIdGenerator(Array.from({ length: 8 }, (_, index) => id(3020 + index))),
    },
    notifier,
  });
  const registry = createPlanRegistry({
    database: faultDatabase,
    commandStore,
    hostId: HOST_ID,
  });
  try {
    return await operation({ temporary, registry, faultDatabase });
  } finally {
    notifier.close();
    await temporary.dispose();
  }
}

function budget(overrides: Partial<Record<keyof TreeBudget, number>> = {}): TreeBudget {
  return create(TreeBudgetSchema, {
    maxDepth: overrides.maxDepth ?? 5,
    maxFanOut: overrides.maxFanOut ?? 4,
    maxNodes: overrides.maxNodes ?? 12,
    maxConcurrency: overrides.maxConcurrency ?? 4,
    maxAttemptsPerNode: overrides.maxAttemptsPerNode ?? 2,
  });
}

function createTreeRequest(options: CreateTreeOptions = {}) {
  return create(CreateTreeRequestSchema, {
    commandId: options.commandId ?? id(20),
    actorSessionId: options.actorSessionId ?? ACTOR_ID,
    repositoryId: options.repositoryId ?? REPOSITORY_ID,
    treeId: options.treeId ?? TREE_ID,
    planRevisionId: options.planRevisionId ?? REVISION_ONE_ID,
    rootNodeId: options.rootNodeId ?? ROOT_NODE_ID,
    rootArtifactId: options.rootArtifactId ?? ROOT_ARTIFACT_ID,
    goal: options.goal ?? "ship the feature",
    baseCommit: options.baseCommit ?? BASE_COMMIT,
    budget: options.budget ?? budget(),
    attentionId: options.attentionId ?? ATTENTION_ID,
    rootAllowedRepositoryPaths: [...(options.rootAllowedRepositoryPaths ?? [".", "src"])],
  });
}

function artifactOutput(artifactId: string, artifactType = "report") {
  return {
    case: "artifact" as const,
    value: create(ArtifactOutputContractSchema, { artifactId, artifactType }),
  };
}

function implementationOutput() {
  return {
    case: "implementation" as const,
    value: create(ImplementationOutputContractSchema, {}),
  };
}

function proposedNode(options: ProposedNodeOptions = {}): ProposedNode {
  const output = options.output ?? { kind: "artifact", artifactId: id(100) };
  const inputs = (options.inputs ?? []).map((input) =>
    create(ArtifactInputSchema, {
      artifactId: input.artifactId,
      sourceNodeId: input.sourceNodeId,
    }),
  );
  const value = {
    nodeId: options.nodeId ?? id(101),
    ...(options.parentNodeId === undefined ? {} : { parentNodeId: options.parentNodeId }),
    mode: options.mode ?? PlanNodeMode.RESEARCH,
    objective: options.objective ?? "investigate the feature",
    acceptanceCriteria: [...(options.acceptanceCriteria ?? ["the investigation is complete"])],
    inputs,
    outputContract:
      output.kind === "artifact"
        ? artifactOutput(output.artifactId, output.artifactType)
        : implementationOutput(),
    allowedRepositoryPaths: [...(options.allowedRepositoryPaths ?? [".", "src"])],
  };
  return create(ProposedNodeSchema, value);
}

function proposeRequest(options: ProposeOptions): ProposePlanRequest {
  return create(ProposePlanRequestSchema, {
    commandId: options.commandId,
    actorSessionId: ACTOR_ID,
    treeId: options.treeId ?? TREE_ID,
    planRevisionId: options.planRevisionId,
    goal: options.goal ?? "ship the feature",
    nodes: options.nodes,
  });
}

function repairRequest(
  options: Readonly<{
    commandId: string;
    treeId?: string;
    planRevisionId: string;
    attentionId: string;
    nodes: ProposedNode[];
    goal?: string;
  }>,
): RepairPlanRequest {
  return create(RepairPlanRequestSchema, {
    commandId: options.commandId,
    actorSessionId: ACTOR_ID,
    treeId: options.treeId ?? TREE_ID,
    planRevisionId: options.planRevisionId,
    attentionId: options.attentionId,
    goal: options.goal ?? "ship the feature",
    nodes: options.nodes,
  });
}

function approveRequest(options: ApproveOptions) {
  return create(ApprovePlanRequestSchema, {
    commandId: options.commandId,
    actorSessionId: ACTOR_ID,
    treeId: options.treeId ?? TREE_ID,
    planRevisionId: options.planRevisionId,
  });
}

async function createTree(fixture: Fixture, options: CreateTreeOptions = {}) {
  return fixture.registry.create({ request: createTreeRequest(options), at: AT });
}

async function prepareTree(fixture: Fixture): Promise<void> {
  await createTree(fixture);
}
async function prepareExistingNodeReuse(fixture: Fixture): Promise<void> {
  await createTree(fixture);
  await fixture.registry.propose({
    request: proposeRequest({
      commandId: id(44),
      planRevisionId: id(45),
      nodes: [
        proposedNode({
          nodeId: id(46),
          parentNodeId: ROOT_NODE_ID,
          output: { kind: "artifact", artifactId: id(47) },
        }),
      ],
    }),
    at: NEXT,
  });
}

async function prepareCrossTreeReuse(fixture: Fixture): Promise<void> {
  await createTree(fixture);
  await createTree(fixture, {
    commandId: id(30),
    treeId: id(31),
    planRevisionId: id(32),
    rootNodeId: id(33),
    rootArtifactId: id(34),
    attentionId: id(35),
  });
}

async function markActive(fixture: Fixture, nodeId: string, at = APPROVED): Promise<void> {
  await fixture.temporary.database.write((transaction) => {
    transaction.run(
      `UPDATE nodes
          SET state_kind = 'active', version = version + 1, updated_at_ms = ?
        WHERE id = ?`,
      [at, nodeId],
    );
  });
}

async function prepareStartedNodeReparent(fixture: Fixture): Promise<void> {
  await createTree(fixture);
  await fixture.registry.propose({
    request: proposeRequest({
      commandId: id(40),
      planRevisionId: id(41),
      nodes: [
        proposedNode({
          nodeId: id(42),
          parentNodeId: ROOT_NODE_ID,
          mode: PlanNodeMode.IMPLEMENTATION,
          output: { kind: "implementation" },
        }),
      ],
    }),
    at: NEXT,
  });
  await fixture.registry.approve({
    request: approveRequest({ commandId: id(43), planRevisionId: id(41) }),
    at: APPROVED,
  });
  await markActive(fixture, id(42));
}

async function prepareRetainedNodeBudget(fixture: Fixture): Promise<void> {
  await createTree(fixture, {
    budget: budget({ maxDepth: 4, maxFanOut: 4, maxNodes: 2, maxConcurrency: 2 }),
  });
  await fixture.registry.propose({
    request: proposeRequest({
      commandId: id(50),
      planRevisionId: id(51),
      nodes: [
        proposedNode({
          nodeId: id(52),
          parentNodeId: ROOT_NODE_ID,
          mode: PlanNodeMode.IMPLEMENTATION,
          output: { kind: "implementation" },
        }),
      ],
    }),
    at: NEXT,
  });
  await fixture.registry.approve({
    request: approveRequest({ commandId: id(53), planRevisionId: id(51) }),
    at: APPROVED,
  });
  await markActive(fixture, id(52));
}

function rowCounts(temporary: TemporarySqliteDatabase): Record<string, number> {
  return temporary.database.read((reader) =>
    Object.fromEntries(
      DURABLE_TABLES.map((table) => [table, reader.all(`SELECT * FROM ${table}`).length]),
    ),
  );
}

type ExpectedNodeSummary = Readonly<{
  id: string;
  parentNodeId?: string;
  ordinal: bigint;
  objective: string;
  state: NodeState;
  version: bigint;
}>;

function expectedNodeSummary(
  nodeId: string,
  parentNodeId: string | undefined,
  ordinal: bigint,
  state: NodeState,
  version: bigint,
  objective = nodeId === ROOT_NODE_ID ? "ship the feature" : "investigate the feature",
): ExpectedNodeSummary {
  return {
    id: nodeId,
    ...(parentNodeId === undefined ? {} : { parentNodeId }),
    ordinal,
    objective,
    state,
    version,
  };
}

function expectTreeProjectionBatch(
  change: ProjectionChange,
  expectedTree: Readonly<{
    activePlanRevisionId: string;
    state: TreeState;
    version: bigint;
  }>,
  expectedNodes: readonly ExpectedNodeSummary[],
  expectedAttention: "upserted" | "removed",
): void {
  expect(change.change.case).toBe("batch");
  if (change.change.case !== "batch") {
    throw new Error("tree journal change is not a batch");
  }
  const leaves = change.change.value.changes;
  expect(leaves).toHaveLength(expectedNodes.length + 2);
  expect(leaves.some((leaf) => leaf.change.case === "batch")).toBe(false);
  const treeChange = leaves[0];
  if (treeChange?.change.case !== "treeUpserted") {
    throw new Error("tree batch does not start with a tree upsert");
  }
  expect({
    id: treeChange.change.value.id,
    repositoryId: treeChange.change.value.repositoryId,
    hostId: treeChange.change.value.hostId,
    rootNodeId: treeChange.change.value.rootNodeId,
    activePlanRevisionId: treeChange.change.value.activePlanRevisionId,
    state: treeChange.change.value.state,
    version: treeChange.change.value.version,
  }).toEqual({
    id: TREE_ID,
    repositoryId: REPOSITORY_ID,
    hostId: HOST_ID,
    rootNodeId: ROOT_NODE_ID,
    activePlanRevisionId: expectedTree.activePlanRevisionId,
    state: expectedTree.state,
    version: expectedTree.version,
  });
  const nodeChanges = leaves.slice(1, -1);
  expect(nodeChanges.every((leaf) => leaf.change.case === "nodeUpserted")).toBe(true);
  const nodeSummaries = nodeChanges.map((nodeChange) => {
    if (nodeChange.change.case !== "nodeUpserted") {
      throw new Error("tree batch contains a non-node leaf in the node range");
    }
    return nodeChange.change.value;
  });
  expect(
    nodeSummaries.map((summary) => ({
      id: summary.id,
      treeId: summary.treeId,
      ...(summary.parentNodeId === undefined ? {} : { parentNodeId: summary.parentNodeId }),
      ordinal: summary.ordinal,
      objective: summary.objective,
      state: summary.state,
      version: summary.version,
    })),
  ).toEqual(
    expectedNodes.map((summary) => ({
      id: summary.id,
      treeId: TREE_ID,
      ...(summary.parentNodeId === undefined ? {} : { parentNodeId: summary.parentNodeId }),
      ordinal: summary.ordinal,
      objective: summary.objective,
      state: summary.state,
      version: summary.version,
    })),
  );
  const attentionChange = leaves[leaves.length - 1];
  if (attentionChange === undefined) {
    throw new Error("tree batch does not contain an attention leaf");
  }
  if (expectedAttention === "upserted") {
    expect(attentionChange.change.case).toBe("attentionUpserted");
    if (attentionChange.change.case !== "attentionUpserted") {
      throw new Error("tree batch does not add attention");
    }
    expect({
      nodeId: attentionChange.change.value.nodeId,
      kind: attentionChange.change.value.kind,
    }).toEqual({
      nodeId: ROOT_NODE_ID,
      kind: AttentionKind.HUMAN_INPUT,
    });
  } else {
    expect(attentionChange.change.case).toBe("attentionRemoved");
    if (attentionChange.change.case !== "attentionRemoved") {
      throw new Error("tree batch does not remove attention");
    }
    expect({ nodeId: attentionChange.change.value.nodeId }).toEqual({ nodeId: ROOT_NODE_ID });
  }
}

async function expectPlanError(
  promise: Promise<unknown>,
  code: PlanRegistryErrorCode,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PlanRegistryError);
  if (!(error instanceof PlanRegistryError)) {
    throw new Error("expected a plan registry error");
  }
  expect(error.code).toBe(code);
}

const invalidCases: readonly InvalidCase[] = [
  {
    name: "fan-in-shaped duplicate node IDs",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(60),
          planRevisionId: id(61),
          nodes: [
            proposedNode({
              nodeId: id(62),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(63) },
            }),
            proposedNode({
              nodeId: id(62),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(64) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "null proposed parent",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(65),
          planRevisionId: id(66),
          nodes: [
            proposedNode({ nodeId: id(67), output: { kind: "artifact", artifactId: id(68) } }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "multiple proposed roots",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(69),
          planRevisionId: id(70),
          nodes: [
            proposedNode({ nodeId: id(71), output: { kind: "artifact", artifactId: id(72) } }),
            proposedNode({ nodeId: id(73), output: { kind: "artifact", artifactId: id(74) } }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "self-parent",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(71),
          planRevisionId: id(72),
          nodes: [
            proposedNode({
              nodeId: id(73),
              parentNodeId: id(73),
              output: { kind: "artifact", artifactId: id(74) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "two-node cycle",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(75),
          planRevisionId: id(76),
          nodes: [
            proposedNode({
              nodeId: id(77),
              parentNodeId: id(78),
              output: { kind: "artifact", artifactId: id(79) },
            }),
            proposedNode({
              nodeId: id(78),
              parentNodeId: id(77),
              output: { kind: "artifact", artifactId: id(80) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "missing parent",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(81),
          planRevisionId: id(82),
          nodes: [
            proposedNode({
              nodeId: id(83),
              parentNodeId: id(84),
              output: { kind: "artifact", artifactId: id(85) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "sibling artifact consumption",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(86),
          planRevisionId: id(87),
          nodes: [
            proposedNode({
              nodeId: id(88),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(89) },
            }),
            proposedNode({
              nodeId: id(90),
              parentNodeId: ROOT_NODE_ID,
              inputs: [{ artifactId: id(89), sourceNodeId: id(88) }],
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "descendant artifact consumption",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(91),
          planRevisionId: id(92),
          nodes: [
            proposedNode({
              nodeId: id(93),
              parentNodeId: ROOT_NODE_ID,
              inputs: [{ artifactId: id(95), sourceNodeId: id(94) }],
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
            proposedNode({
              nodeId: id(94),
              parentNodeId: id(93),
              output: { kind: "artifact", artifactId: id(95) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "unknown artifact source node",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(96),
          planRevisionId: id(97),
          nodes: [
            proposedNode({
              nodeId: id(98),
              parentNodeId: ROOT_NODE_ID,
              inputs: [{ artifactId: id(99), sourceNodeId: id(100) }],
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "wrong artifact ID",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(106),
          planRevisionId: id(107),
          nodes: [
            proposedNode({
              nodeId: id(108),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(109) },
            }),
            proposedNode({
              nodeId: id(110),
              parentNodeId: id(108),
              inputs: [{ artifactId: id(111), sourceNodeId: id(108) }],
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "existing node ID reuse",
    expectedCode: "invalid_plan",
    prepare: prepareExistingNodeReuse,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(48),
          planRevisionId: id(49),
          nodes: [
            proposedNode({
              nodeId: id(46),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: LATER,
      }),
  },
  {
    name: "cross-tree node ID reuse",
    expectedCode: "invalid_plan",
    prepare: prepareCrossTreeReuse,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(114),
          planRevisionId: id(115),
          nodes: [
            proposedNode({
              nodeId: id(33),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "started-node reparent attempt",
    expectedCode: "invalid_plan",
    prepare: prepareStartedNodeReparent,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(116),
          planRevisionId: id(117),
          nodes: [
            proposedNode({
              nodeId: id(118),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(119) },
            }),
            proposedNode({
              nodeId: id(42),
              parentNodeId: id(118),
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: LATER,
      }),
  },
  {
    name: "implementation mode with artifact output",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(120),
          planRevisionId: id(121),
          nodes: [
            proposedNode({
              nodeId: id(122),
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.IMPLEMENTATION,
              output: { kind: "artifact", artifactId: id(123) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "non-implementation mode with implementation output",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(124),
          planRevisionId: id(125),
          nodes: [
            proposedNode({
              nodeId: id(126),
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.RESEARCH,
              output: { kind: "implementation" },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "duplicate artifact outputs",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(127),
          planRevisionId: id(128),
          nodes: [
            proposedNode({
              nodeId: id(129),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(130) },
            }),
            proposedNode({
              nodeId: id(131),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(130) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "duplicate artifact inputs",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(165),
          planRevisionId: id(166),
          nodes: [
            proposedNode({
              nodeId: id(167),
              parentNodeId: ROOT_NODE_ID,
              inputs: [
                { artifactId: ROOT_ARTIFACT_ID, sourceNodeId: ROOT_NODE_ID },
                { artifactId: ROOT_ARTIFACT_ID, sourceNodeId: ROOT_NODE_ID },
              ],
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "depth budget overflow",
    expectedCode: "invalid_plan",
    prepare: (fixture) =>
      createTree(fixture, { budget: budget({ maxDepth: 2 }) }).then(() => undefined),
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(132),
          planRevisionId: id(133),
          nodes: [
            proposedNode({
              nodeId: id(134),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(135) },
            }),
            proposedNode({
              nodeId: id(136),
              parentNodeId: id(134),
              output: { kind: "artifact", artifactId: id(137) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "fan-out budget overflow",
    expectedCode: "invalid_plan",
    prepare: (fixture) =>
      createTree(fixture, { budget: budget({ maxFanOut: 1 }) }).then(() => undefined),
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(138),
          planRevisionId: id(139),
          nodes: [
            proposedNode({
              nodeId: id(140),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(141) },
            }),
            proposedNode({
              nodeId: id(142),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(143) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "node budget overflow",
    expectedCode: "invalid_plan",
    prepare: (fixture) =>
      createTree(fixture, { budget: budget({ maxNodes: 2, maxConcurrency: 2 }) }).then(
        () => undefined,
      ),
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(144),
          planRevisionId: id(145),
          nodes: [
            proposedNode({
              nodeId: id(146),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(147) },
            }),
            proposedNode({
              nodeId: id(148),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(149) },
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "retained started node counts toward node budget",
    expectedCode: "invalid_plan",
    prepare: prepareRetainedNodeBudget,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(150),
          planRevisionId: id(151),
          nodes: [
            proposedNode({
              nodeId: id(152),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: LATER,
      }),
  },
  {
    name: "base commit mismatch",
    expectedCode: "identity_conflict",
    run: (fixture) =>
      fixture.registry.create({
        request: createTreeRequest({ commandId: id(153), baseCommit: OTHER_BASE_COMMIT }),
        at: AT,
      }),
  },
  {
    name: "repository prerequisite mismatch",
    expectedCode: "not_found",
    run: (fixture) =>
      fixture.registry.create({
        request: createTreeRequest({ commandId: id(154), repositoryId: id(155) }),
        at: AT,
      }),
  },
  {
    name: "non-monotonic revision time",
    expectedCode: "invalid_input",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(156),
          planRevisionId: id(157),
          nodes: [
            proposedNode({
              nodeId: id(158),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "artifact", artifactId: id(159) },
            }),
          ],
          at: BEFORE,
        }),
        at: BEFORE,
      }),
  },
  {
    name: "repair with wrong attention",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.repair({
        request: repairRequest({
          commandId: id(160),
          planRevisionId: id(161),
          attentionId: id(162),
          nodes: [
            proposedNode({
              nodeId: id(163),
              parentNodeId: ROOT_NODE_ID,
              output: { kind: "implementation" },
              mode: PlanNodeMode.IMPLEMENTATION,
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "root absolute repository path",
    expectedCode: "invalid_input",
    run: (fixture) =>
      fixture.registry.create({
        request: createTreeRequest({
          commandId: id(500),
          rootAllowedRepositoryPaths: ["/absolute"],
        }),
        at: AT,
      }),
  },
  {
    name: "root dot repository path component",
    expectedCode: "invalid_input",
    run: (fixture) =>
      fixture.registry.create({
        request: createTreeRequest({
          commandId: id(501),
          rootAllowedRepositoryPaths: ["src/./feature"],
        }),
        at: AT,
      }),
  },
  {
    name: "root duplicate repository paths",
    expectedCode: "invalid_input",
    run: (fixture) =>
      fixture.registry.create({
        request: createTreeRequest({ commandId: id(502), rootAllowedRepositoryPaths: [".", "."] }),
        at: AT,
      }),
  },
  {
    name: "proposed backslash repository path",
    expectedCode: "invalid_input",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(504),
          planRevisionId: id(505),
          nodes: [
            proposedNode({
              nodeId: id(506),
              parentNodeId: ROOT_NODE_ID,
              allowedRepositoryPaths: ["src\\feature"],
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "proposed duplicate repository paths",
    expectedCode: "invalid_input",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.propose({
        request: proposeRequest({
          commandId: id(507),
          planRevisionId: id(508),
          nodes: [
            proposedNode({
              nodeId: id(509),
              parentNodeId: ROOT_NODE_ID,
              allowedRepositoryPaths: [".", "."],
            }),
          ],
        }),
        at: NEXT,
      }),
  },
  {
    name: "max depth below structural minimum",
    expectedCode: "invalid_input",
    run: (fixture) =>
      fixture.registry.create({
        request: createTreeRequest({ commandId: id(513), budget: budget({ maxDepth: 1 }) }),
        at: AT,
      }),
  },
  {
    name: "max nodes below structural minimum",
    expectedCode: "invalid_input",
    run: (fixture) =>
      fixture.registry.create({
        request: createTreeRequest({ commandId: id(514), budget: budget({ maxNodes: 1 }) }),
        at: AT,
      }),
  },
  {
    name: "global attention ID reuse",
    expectedCode: "invalid_plan",
    prepare: prepareTree,
    run: (fixture) =>
      fixture.registry.create({
        request: createTreeRequest({
          commandId: id(515),
          treeId: id(516),
          planRevisionId: id(517),
          rootNodeId: id(518),
          rootArtifactId: id(519),
          attentionId: ATTENTION_ID,
        }),
        at: AT,
      }),
  },
];

describe("SQLite plan topology validation", () => {
  it.each(invalidCases)("rejects $name without durable writes", async (testCase) => {
    await withFixture(async (fixture) => {
      await (testCase.prepare?.(fixture) ?? Promise.resolve());
      const before = rowCounts(fixture.temporary);
      await expectPlanError(testCase.run(fixture), testCase.expectedCode);
      expect(rowCounts(fixture.temporary)).toEqual(before);
    });
  });
  it("rolls back a late SQLite rejection", async () => {
    await withFaultFixture(async (fixture) => {
      const before = rowCounts(fixture.temporary);
      await expectPlanError(
        fixture.registry.propose({
          request: proposeRequest({
            commandId: id(3025),
            planRevisionId: id(3026),
            nodes: [
              proposedNode({
                nodeId: id(3027),
                parentNodeId: ROOT_NODE_ID,
                output: { kind: "implementation" },
                mode: PlanNodeMode.IMPLEMENTATION,
              }),
            ],
          }),
          at: NEXT,
        }),
        "corrupt",
      );
      expect(fixture.faultDatabase.observedWriteCount).toBe(10);
      expect(rowCounts(fixture.temporary)).toEqual(before);
    });
  });
  it("resolves the named open attention during repair", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture);
      const repaired = await fixture.registry.repair({
        request: repairRequest({
          commandId: id(400),
          planRevisionId: id(401),
          attentionId: ATTENTION_ID,
          nodes: [
            proposedNode({
              nodeId: id(402),
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.IMPLEMENTATION,
              output: { kind: "implementation" },
            }),
          ],
        }),
        at: NEXT,
      });
      expect(repaired.attention).toBeUndefined();
      expect(repaired.revisions.find((revision) => revision.id === id(401))?.state).toBe(
        PlanRevisionState.DRAFT,
      );
      expect(repaired.nodes.find((node) => node.id === id(402))?.state).toBe(NodeState.PLANNED);
      const beforeClosedAttention = rowCounts(fixture.temporary);
      await expectPlanError(
        fixture.registry.repair({
          request: repairRequest({
            commandId: id(403),
            planRevisionId: id(404),
            attentionId: ATTENTION_ID,
            nodes: [
              proposedNode({
                nodeId: id(405),
                parentNodeId: ROOT_NODE_ID,
                mode: PlanNodeMode.IMPLEMENTATION,
                output: { kind: "implementation" },
              }),
            ],
          }),
          at: LATER,
        }),
        "invalid_plan",
      );
      expect(rowCounts(fixture.temporary)).toEqual(beforeClosedAttention);
    });
  });

  it("accepts an artifact ancestry plan and journals approval and superseding", async () => {
    await withFixture(async (fixture) => {
      const created = await createTree(fixture, {
        budget: budget({ maxDepth: 3, maxFanOut: 3, maxNodes: 5 }),
      });
      const firstRevision = id(200);
      const artifactAncestor = id(201);
      const artifactDescendant = id(202);
      const implementationLeaf = id(203);
      const directImplementation = id(204);
      const proposed = await fixture.registry.propose({
        request: proposeRequest({
          commandId: id(205),
          planRevisionId: firstRevision,
          nodes: [
            proposedNode({
              nodeId: id(206),
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.RESEARCH,
              inputs: [{ artifactId: ROOT_ARTIFACT_ID, sourceNodeId: ROOT_NODE_ID }],
              output: { kind: "artifact", artifactId: artifactAncestor, artifactType: "research" },
            }),
            proposedNode({
              nodeId: id(207),
              parentNodeId: id(206),
              mode: PlanNodeMode.EXPLORE,
              inputs: [
                { artifactId: artifactAncestor, sourceNodeId: id(206) },
                { artifactId: ROOT_ARTIFACT_ID, sourceNodeId: ROOT_NODE_ID },
              ],
              output: { kind: "artifact", artifactId: artifactDescendant, artifactType: "design" },
            }),
            proposedNode({
              nodeId: implementationLeaf,
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.IMPLEMENTATION,
              output: { kind: "implementation" },
            }),
            proposedNode({
              nodeId: directImplementation,
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.IMPLEMENTATION,
              output: { kind: "implementation" },
            }),
          ],
        }),
        at: NEXT,
      });
      expect(proposed.revisions.map((revision) => revision.state)).toEqual([
        PlanRevisionState.DRAFT,
        PlanRevisionState.DRAFT,
      ]);
      expect(proposed.nodes.find((node) => node.id === id(206))?.state).toBe(NodeState.PLANNED);
      expect(proposed.nodes.find((node) => node.id === implementationLeaf)?.state).toBe(
        NodeState.PLANNED,
      );
      const approved = await fixture.registry.approve({
        request: approveRequest({ commandId: id(208), planRevisionId: firstRevision }),
        at: APPROVED,
      });
      expect(approved.state).toBe(TreeState.APPROVED);
      expect(created.attention?.id).toBe(ATTENTION_ID);
      const approvedRevision = approved.revisions.find((revision) => revision.id === firstRevision);
      expect(approvedRevision?.approvedAt).toBe(APPROVED);
      expect(approvedRevision?.supersededAt).toBeUndefined();
      expect(approvedRevision?.version).toBe(1);
      expect(approved.attention).toBeUndefined();
      expect(approved.revisions.find((revision) => revision.id === firstRevision)?.state).toBe(
        PlanRevisionState.APPROVED,
      );
      expect(approved.nodes.find((node) => node.id === directImplementation)?.state).toBe(
        NodeState.READY,
      );
      expect(approved.nodes.find((node) => node.id === implementationLeaf)?.state).toBe(
        NodeState.READY,
      );
      expect(approved.nodes.find((node) => node.id === id(206))?.state).toBe(NodeState.READY);
      expect(approved.nodes.find((node) => node.id === ROOT_NODE_ID)?.state).toBe(
        NodeState.PLANNED,
      );

      await markSucceededArtifact(
        fixture,
        id(206),
        artifactAncestor,
        "research",
        id(209),
        APPROVED,
      );
      await markBlocked(fixture, id(207), id(210), APPROVED);
      await markActive(fixture, directImplementation, APPROVED);
      const secondRevision = id(211);
      const superseding = await fixture.registry.propose({
        request: proposeRequest({
          commandId: id(212),
          planRevisionId: secondRevision,
          nodes: [
            proposedNode({
              nodeId: id(213),
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.IMPLEMENTATION,
              output: { kind: "implementation" },
            }),
          ],
        }),
        at: LATER,
      });
      expect(superseding.revisions.find((revision) => revision.id === firstRevision)?.state).toBe(
        PlanRevisionState.SUPERSEDED,
      );
      const supersededRevision = superseding.revisions.find(
        (revision) => revision.id === firstRevision,
      );
      expect(supersededRevision?.approvedAt).toBe(APPROVED);
      expect(supersededRevision?.supersededAt).toBe(LATER);
      expect(supersededRevision?.version).toBe(2);
      expect(superseding.nodes.find((node) => node.id === id(206))?.state).toBe(
        NodeState.SUCCEEDED,
      );
      expect(superseding.nodes.find((node) => node.id === id(207))?.state).toBe(NodeState.BLOCKED);
      expect(superseding.nodes.find((node) => node.id === directImplementation)?.state).toBe(
        NodeState.ACTIVE,
      );
      expect(superseding.nodes.find((node) => node.id === implementationLeaf)?.state).toBe(
        NodeState.SUPERSEDED,
      );
      expect(superseding.nodes.find((node) => node.id === id(213))?.state).toBe(NodeState.PLANNED);
      expect(superseding.nodes.find((node) => node.id === ROOT_NODE_ID)?.state).toBe(
        NodeState.PLANNED,
      );

      const approvedAgain = await fixture.registry.approve({
        request: approveRequest({ commandId: id(214), planRevisionId: secondRevision }),
        at: timestampFromEpochMilliseconds(1_700_000_000_400),
      });
      expect(approvedAgain.nodes.find((node) => node.id === id(213))?.state).toBe(NodeState.READY);
      expect(approvedAgain.nodes.find((node) => node.id === directImplementation)?.state).toBe(
        NodeState.ACTIVE,
      );
      expect(approvedAgain.nodes.find((node) => node.id === id(206))?.state).toBe(
        NodeState.SUCCEEDED,
      );
      expect(approvedAgain.nodes.find((node) => node.id === id(207))?.state).toBe(
        NodeState.BLOCKED,
      );

      const journal = fixture.temporary.database.read((reader) =>
        reader.all(
          `SELECT command_id, event_type, aggregate_version, event_payload
             FROM events
            WHERE aggregate_kind = 'tree' AND aggregate_id = ?
            ORDER BY sequence`,
          [TREE_ID],
        ),
      );
      expect(journal).toHaveLength(5);
      expect(journal.map((row) => row["aggregate_version"])).toEqual([1n, 2n, 3n, 4n, 5n]);
      expect(journal.map((row) => row["command_id"])).toEqual([
        id(20),
        id(205),
        id(208),
        id(212),
        id(214),
      ]);
      expect(journal.map((row) => row["event_type"])).toEqual(
        Array.from({ length: 5 }, () => ProjectionChangeSchema.typeName),
      );
      const changes = journal.map((row) => {
        const payload = row["event_payload"];
        if (!(payload instanceof Uint8Array)) {
          throw new Error("tree event payload is not binary");
        }
        return fromBinary(ProjectionChangeSchema, payload);
      });
      expect(changes.map((change) => change.change.case)).toEqual(
        Array.from({ length: 5 }, () => "batch"),
      );
      const expectedBatches = [
        {
          tree: {
            activePlanRevisionId: REVISION_ONE_ID,
            state: TreeState.DRAFT,
            version: 0n,
          },
          nodes: [expectedNodeSummary(ROOT_NODE_ID, undefined, 0n, NodeState.PLANNED, 0n)],
          attention: "upserted",
        },
        {
          tree: {
            activePlanRevisionId: firstRevision,
            state: TreeState.DRAFT,
            version: 1n,
          },
          nodes: [
            expectedNodeSummary(ROOT_NODE_ID, undefined, 0n, NodeState.PLANNED, 0n),
            expectedNodeSummary(id(206), ROOT_NODE_ID, 2n, NodeState.PLANNED, 0n),
            expectedNodeSummary(id(207), id(206), 0n, NodeState.PLANNED, 0n),
            expectedNodeSummary(implementationLeaf, ROOT_NODE_ID, 0n, NodeState.PLANNED, 0n),
            expectedNodeSummary(directImplementation, ROOT_NODE_ID, 1n, NodeState.PLANNED, 0n),
          ],
          attention: "removed",
        },
        {
          tree: {
            activePlanRevisionId: firstRevision,
            state: TreeState.APPROVED,
            version: 2n,
          },
          nodes: [
            expectedNodeSummary(ROOT_NODE_ID, undefined, 0n, NodeState.PLANNED, 0n),
            expectedNodeSummary(id(206), ROOT_NODE_ID, 2n, NodeState.READY, 1n),
            expectedNodeSummary(id(207), id(206), 0n, NodeState.PLANNED, 0n),
            expectedNodeSummary(implementationLeaf, ROOT_NODE_ID, 0n, NodeState.READY, 1n),
            expectedNodeSummary(directImplementation, ROOT_NODE_ID, 1n, NodeState.READY, 1n),
          ],
          attention: "removed",
        },
        {
          tree: {
            activePlanRevisionId: secondRevision,
            state: TreeState.DRAFT,
            version: 3n,
          },
          nodes: [
            expectedNodeSummary(ROOT_NODE_ID, undefined, 0n, NodeState.PLANNED, 0n),
            expectedNodeSummary(id(206), ROOT_NODE_ID, 2n, NodeState.SUCCEEDED, 2n),
            expectedNodeSummary(id(207), id(206), 0n, NodeState.BLOCKED, 1n),
            expectedNodeSummary(implementationLeaf, ROOT_NODE_ID, 0n, NodeState.SUPERSEDED, 2n),
            expectedNodeSummary(directImplementation, ROOT_NODE_ID, 1n, NodeState.ACTIVE, 2n),
            expectedNodeSummary(id(213), ROOT_NODE_ID, 3n, NodeState.PLANNED, 0n),
          ],
          attention: "removed",
        },
        {
          tree: {
            activePlanRevisionId: secondRevision,
            state: TreeState.APPROVED,
            version: 4n,
          },
          nodes: [
            expectedNodeSummary(ROOT_NODE_ID, undefined, 0n, NodeState.PLANNED, 0n),
            expectedNodeSummary(id(206), ROOT_NODE_ID, 2n, NodeState.SUCCEEDED, 2n),
            expectedNodeSummary(id(207), id(206), 0n, NodeState.BLOCKED, 1n),
            expectedNodeSummary(implementationLeaf, ROOT_NODE_ID, 0n, NodeState.SUPERSEDED, 2n),
            expectedNodeSummary(directImplementation, ROOT_NODE_ID, 1n, NodeState.ACTIVE, 2n),
            expectedNodeSummary(id(213), ROOT_NODE_ID, 3n, NodeState.READY, 1n),
          ],
          attention: "removed",
        },
      ] as const;
      for (let index = 0; index < expectedBatches.length; index += 1) {
        const change = changes[index];
        const expected = expectedBatches[index];
        if (change === undefined || expected === undefined) {
          throw new Error("tree journal batch sequence is incomplete");
        }
        expectTreeProjectionBatch(change, expected.tree, expected.nodes, expected.attention);
      }
      expect(
        fixture.temporary.database.read((reader) => ({
          commands: reader.all(
            "SELECT id FROM operator_commands WHERE aggregate_kind = 'tree' ORDER BY created_at_ms, id",
          ),
          idempotency: reader.all(
            `SELECT command_id
               FROM idempotency_records
              WHERE command_id IN (SELECT id FROM operator_commands WHERE aggregate_kind = 'tree')
              ORDER BY command_id`,
          ),
        })),
      ).toEqual({
        commands: [
          { id: id(20) },
          { id: id(205) },
          { id: id(208) },
          { id: id(212) },
          { id: id(214) },
        ],
        idempotency: [
          { command_id: id(20) },
          { command_id: id(205) },
          { command_id: id(208) },
          { command_id: id(212) },
          { command_id: id(214) },
        ],
      });
      expect(created.nodes.find((node) => node.id === ROOT_NODE_ID)?.outputContract.case).toBe(
        "artifact",
      );
    });
  });
  it("accepts an own-node artifact input", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture);
      const nodeId = id(600);
      const artifact = id(601);
      const proposed = await fixture.registry.propose({
        request: proposeRequest({
          commandId: id(602),
          planRevisionId: id(603),
          nodes: [
            proposedNode({
              nodeId,
              parentNodeId: ROOT_NODE_ID,
              inputs: [{ artifactId: artifact, sourceNodeId: nodeId }],
              output: { kind: "artifact", artifactId: artifact },
            }),
          ],
        }),
        at: NEXT,
      });
      expect(proposed.nodes.find((node) => node.id === nodeId)?.inputs).toEqual([
        { artifactId: artifact, sourceNodeId: nodeId },
      ]);
    });
  });
  it("accepts exact structural minimum depth and node budgets", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture, {
        budget: budget({ maxDepth: 2, maxNodes: 2, maxFanOut: 1, maxConcurrency: 1 }),
      });
      const proposed = await fixture.registry.propose({
        request: proposeRequest({
          commandId: id(604),
          planRevisionId: id(605),
          nodes: [
            proposedNode({
              nodeId: id(606),
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.IMPLEMENTATION,
              output: { kind: "implementation" },
            }),
          ],
        }),
        at: NEXT,
      });
      expect(proposed.budget.maxDepth).toBe(2);
      expect(proposed.budget.maxNodes).toBe(2);
    });
  });
  it("rejects initial approval with an open attention and leaves rows unchanged", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture);
      const before = rowCounts(fixture.temporary);
      await expect(
        fixture.registry.approve({
          request: approveRequest({ commandId: id(607), planRevisionId: REVISION_ONE_ID }),
          at: NEXT,
        }),
      ).rejects.toMatchObject({
        code: "invalid_plan",
        message: "open plan attention must be resolved before approval",
      });
      expect(rowCounts(fixture.temporary)).toEqual(before);
    });
  });
  it("approves a research-only revision and readies the research child", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture);
      const revisionId = id(608);
      const request = proposeRequest({
        commandId: id(609),
        planRevisionId: revisionId,
        nodes: [
          proposedNode({
            nodeId: id(610),
            parentNodeId: ROOT_NODE_ID,
            mode: PlanNodeMode.RESEARCH,
            output: { kind: "artifact", artifactId: id(611) },
          }),
        ],
      });
      await fixture.registry.propose({ request, at: NEXT });
      const approved = await fixture.registry.approve({
        request: approveRequest({ commandId: id(612), planRevisionId: revisionId }),
        at: APPROVED,
      });
      expect(approved.state).toBe(TreeState.APPROVED);
      expect(approved.revisions.find((revision) => revision.id === revisionId)?.state).toBe(
        PlanRevisionState.APPROVED,
      );
      expect(approved.nodes.find((node) => node.id === id(610))?.state).toBe(NodeState.READY);
      expect(approved.nodes.find((node) => node.id === id(610))?.version).toBe(1);
      expect(approved.nodes.find((node) => node.id === ROOT_NODE_ID)?.state).toBe(
        NodeState.PLANNED,
      );
      const replayed = await fixture.registry.approve({
        request: approveRequest({ commandId: id(612), planRevisionId: revisionId }),
        at: APPROVED,
      });
      expect(replayed).toEqual(approved);
    });
  });
  it("rejects approval without an executable child and leaves rows unchanged", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture);
      const revisionId = id(608);
      await fixture.registry.propose({
        request: proposeRequest({
          commandId: id(609),
          planRevisionId: revisionId,
          nodes: [
            proposedNode({
              nodeId: id(610),
              parentNodeId: ROOT_NODE_ID,
              mode: PlanNodeMode.PLAN,
              objective: "plan the next revision",
              acceptanceCriteria: ["the follow-up plan exists"],
              output: { kind: "artifact", artifactId: id(611) },
            }),
          ],
        }),
        at: NEXT,
      });
      const before = rowCounts(fixture.temporary);
      await expect(
        fixture.registry.approve({
          request: approveRequest({ commandId: id(612), planRevisionId: revisionId }),
          at: APPROVED,
        }),
      ).rejects.toMatchObject({
        code: "invalid_plan",
        message: "an approved plan requires at least one planned executable child",
      });
      expect(rowCounts(fixture.temporary)).toEqual(before);
    });
  });
  it("rejects hydration when a node policy is missing", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture);
      await fixture.temporary.database.write((transaction) => {
        transaction.run("DELETE FROM node_plan_policies WHERE node_id = ?", [ROOT_NODE_ID]);
      });
      expect(() => fixture.registry.get(taskTreeId(TREE_ID))).toThrow(
        expect.objectContaining({ code: "corrupt" }),
      );
    });
  });
  it("rejects hydration when a scope row is missing", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture);
      await fixture.temporary.database.write((transaction) => {
        transaction.run("DELETE FROM node_repository_scope WHERE node_id = ? AND ordinal = ?", [
          ROOT_NODE_ID,
          0,
        ]);
      });
      expect(() => fixture.registry.get(taskTreeId(TREE_ID))).toThrow(
        expect.objectContaining({ code: "corrupt" }),
      );
    });
  });
  it("rejects hydration when node attempts differ from the tree budget", async () => {
    await withFixture(async (fixture) => {
      await createTree(fixture);
      await fixture.temporary.database.write((transaction) => {
        transaction.run("DELETE FROM node_plan_policies WHERE node_id = ?", [ROOT_NODE_ID]);
        transaction.run("INSERT INTO node_plan_policies (node_id, max_attempts) VALUES (?, ?)", [
          ROOT_NODE_ID,
          3,
        ]);
      });
      expect(() => fixture.registry.get(taskTreeId(TREE_ID))).toThrow(
        expect.objectContaining({ code: "corrupt" }),
      );
    });
  });
});

async function markSucceededArtifact(
  fixture: Fixture,
  nodeId: string,
  artifactId: string,
  artifactType: string,
  evidenceId: string,
  at: Timestamp,
): Promise<void> {
  await fixture.temporary.database.write((transaction) => {
    transaction.run("UPDATE nodes SET state_kind = 'active' WHERE id = ?", [nodeId]);
    const contentDigest = "a".repeat(64);
    transaction.run(
      `INSERT INTO content_blobs (
         digest, size_bytes, media_type, relative_path, retention_kind, created_at_ms, verified_at_ms
       ) VALUES (?, 1, 'text/plain', ?, 'active', ?, ?)`,
      [
        contentDigest,
        `sha256/${contentDigest.slice(0, 2)}/${contentDigest.slice(2, 4)}/${contentDigest}`,
        at,
        at,
      ],
    );
    transaction.run(
      `INSERT INTO artifacts (
         id, node_id, attempt_id, tree_id, repository_id, host_id,
         content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        artifactId,
        nodeId,
        TREE_ID,
        REPOSITORY_ID,
        HOST_ID,
        contentDigest,
        artifactType,
        evidenceId,
        at,
      ],
    );
    transaction.run(
      `INSERT INTO node_outcome_records (
         node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
       ) VALUES (?, 'artifact', ?, NULL, NULL, NULL, ?)`,
      [nodeId, artifactId, at],
    );
    transaction.run(
      `UPDATE nodes
          SET state_kind = 'succeeded',
              outcome_kind = 'artifact',
              outcome_artifact_id = ?,
              outcome_content_hash = ?,
              outcome_artifact_type = ?,
              outcome_evidence_id = ?,
              version = version + 1,
              updated_at_ms = ?
        WHERE id = ?`,
      [artifactId, "a".repeat(64), artifactType, evidenceId, at, nodeId],
    );
  });
}

async function markBlocked(
  fixture: Fixture,
  nodeId: string,
  evidenceId: string,
  at: Timestamp,
): Promise<void> {
  await fixture.temporary.database.write((transaction) => {
    transaction.run(
      `UPDATE nodes
          SET state_kind = 'blocked',
              resume_state_kind = 'ready',
              blocker_kind = 'human_input',
              blocker_evidence_id = ?,
              version = version + 1,
              updated_at_ms = ?
        WHERE id = ?`,
      [evidenceId, at, nodeId],
    );
  });
}
