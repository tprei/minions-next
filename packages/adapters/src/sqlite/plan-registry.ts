import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import {
  ApprovePlanRequestSchema,
  ApprovePlanResponseSchema,
  AttentionKind,
  AttentionRemovedSchema,
  AttentionSummarySchema,
  ArtifactInputSchema,
  ArtifactOutputContractSchema,
  CreateTemplatedTreeRequestSchema,
  CreateTemplatedTreeResponseSchema,
  CreateTreeRequestSchema,
  CreateTreeResponseSchema,
  ImplementationOutputContractSchema,
  NodeBudgetSchema,
  NodeSummarySchema,
  NodeState,
  PlanAttentionKind,
  PlanAttentionSchema,
  PlanAttentionState,
  PlanNodeMode,
  PlanRevisionSchema,
  PlanRevisionState,
  ProjectionChangeSchema,
  ProjectionBatchSchema,
  ProposePlanRequestSchema,
  ProposePlanResponseSchema,
  RepairPlanRequestSchema,
  RepairPlanResponseSchema,
  TaskNodeSchema,
  TaskTreeSchema,
  TreeBudgetSchema,
  TreeState,
  TreeSummarySchema,
  findUnknownField,
} from "@minions/contracts";
import type {
  ApprovePlanRequest,
  CreateTemplatedTreeRequest,
  CreateTreeRequest,
  ProposePlanRequest,
  ProposedNode,
  RepairPlanRequest,
} from "@minions/contracts";
import type { ResolvedTaskTemplate } from "@minions/core";
import {
  actorSessionId,
  artifactId,
  commandId,
  contentHash,
  evidenceId,
  gitSha,
  hostId,
  nonEmptyText,
  planRevisionId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
} from "@minions/core";
import type {
  ActorSessionId,
  ArtifactId,
  CommandId,
  GitSha,
  HostId,
  NonEmptyText,
  PlanRevisionId,
  RepositoryId,
  TaskNodeId,
  TaskTreeId,
  Timestamp,
} from "@minions/core";

import type { ManagedSqliteDatabase, SqliteReader, SqliteRow } from "./database.js";
import { SqliteCommandError } from "./command-error.js";
import type { SqliteCommandStore, SqliteCommandTransaction } from "./command.js";

export type PlanRegistryErrorCode =
  | "not_found"
  | "invalid_input"
  | "invalid_plan"
  | "identity_conflict"
  | "facts_changed"
  | "corrupt";

export class PlanRegistryError extends Error {
  readonly code: PlanRegistryErrorCode;

  constructor(code: PlanRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanRegistryError";
    this.code = code;
  }
}

export type TreeBudgetRecord = Readonly<{
  maxDepth: number;
  maxFanOut: number;
  maxNodes: number;
  maxConcurrency: number;
  maxAttemptsPerNode: number;
}>;

export type ArtifactInputRecord = Readonly<{
  artifactId: ArtifactId;
  sourceNodeId: TaskNodeId;
}>;

export type ArtifactOutputRecord = Readonly<{
  case: "artifact";
  value: Readonly<{
    artifactId: ArtifactId;
    artifactType: NonEmptyText;
  }>;
}>;

export type ImplementationOutputRecord = Readonly<{
  case: "implementation";
  value: Readonly<Record<string, never>>;
}>;
export type TaskNodeOutputRecord = ArtifactOutputRecord | ImplementationOutputRecord;

export type PlanRevisionRecord = Readonly<{
  id: PlanRevisionId;
  treeId: TaskTreeId;
  ordinal: number;
  goal: NonEmptyText;
  state: PlanRevisionState;
  version: number;
  createdAt: Timestamp;
  approvedAt?: Timestamp;
  supersededAt?: Timestamp;
}>;

type NodeBudgetRecord = Readonly<{
  maxAttempts: number;
}>;

export type TaskNodeRecord = Readonly<{
  id: TaskNodeId;
  treeId: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  parentNodeId?: TaskNodeId;
  planRevisionId: PlanRevisionId;
  mode: PlanNodeMode;
  objective: NonEmptyText;
  acceptanceCriteria: readonly NonEmptyText[];
  inputs: readonly ArtifactInputRecord[];
  outputContract: TaskNodeOutputRecord;
  allowedRepositoryPaths: readonly NonEmptyText[];
  budget: NodeBudgetRecord;
  state: NodeState;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}>;

export type PlanAttentionRecord = Readonly<{
  id: string;
  treeId: TaskTreeId;
  planRevisionId?: PlanRevisionId;
  kind: PlanAttentionKind;
  message: NonEmptyText;
  state: PlanAttentionState;
  createdAt: Timestamp;
  resolvedAt?: Timestamp;
}>;

export type TreeRecord = Readonly<{
  id: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  baseCommit: GitSha;
  goal: NonEmptyText;
  activePlanRevisionId: PlanRevisionId;
  rootNodeId: TaskNodeId;
  state: TreeState;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revisions: readonly PlanRevisionRecord[];
  nodes: readonly TaskNodeRecord[];
  budget: TreeBudgetRecord;
  attention?: PlanAttentionRecord;
}>;

export type TreeSummaryRecord = Readonly<{
  id: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  rootNodeId: TaskNodeId;
  activePlanRevisionId: PlanRevisionId;
  state: TreeState;
  version: number;
}>;

export type CreatePlanRegistryOptions = Readonly<{
  database: ManagedSqliteDatabase;
  commandStore: SqliteCommandStore;
  hostId: HostId;
}>;

export type CreateTreeInput = Readonly<{
  request: CreateTreeRequest;
  at: Timestamp;
}>;

export type CreateTemplatedNodeInput = Readonly<{
  nodeId: TaskNodeId;
  artifactId?: ArtifactId | undefined;
}>;

export type CreateTemplatedTreeInput = Readonly<{
  request: CreateTemplatedTreeRequest;
  resolved: ResolvedTaskTemplate;
  baseCommit: GitSha;
  mintedNodes: readonly CreateTemplatedNodeInput[];
  at: Timestamp;
}>;
export type ProposePlanInput = Readonly<{
  request: ProposePlanRequest;
  at: Timestamp;
}>;

export type RepairPlanInput = Readonly<{
  request: RepairPlanRequest;
  at: Timestamp;
}>;

export type ApprovePlanInput = Readonly<{
  request: ApprovePlanRequest;
  at: Timestamp;
}>;

export type ListTreesInput = Readonly<{
  afterId: TaskTreeId | undefined;
  limit: number;
}>;

export interface PlanRegistry {
  create(input: CreateTreeInput): Promise<TreeRecord>;
  createTemplated(input: CreateTemplatedTreeInput): Promise<TreeRecord>;
  get(treeId: TaskTreeId): TreeRecord;
  list(input: ListTreesInput): readonly TreeSummaryRecord[];
  propose(input: ProposePlanInput): Promise<TreeRecord>;
  repair(input: RepairPlanInput): Promise<TreeRecord>;
  approve(input: ApprovePlanInput): Promise<TreeRecord>;
}

type ProposedNodeRecord = Readonly<{
  id: TaskNodeId;
  parentNodeId: TaskNodeId | undefined;
  mode: PlanNodeMode;
  objective: NonEmptyText;
  acceptanceCriteria: readonly NonEmptyText[];
  inputs: readonly ArtifactInputRecord[];
  outputContract: TaskNodeOutputRecord;
  allowedRepositoryPaths: readonly NonEmptyText[];
}>;

type NodePolicyRecord = Readonly<{
  maxAttempts: number;
}>;

type CreateSnapshot = Readonly<{
  requestBytes: Uint8Array;
  commandId: CommandId;

  actorSessionId: ActorSessionId;
  repositoryId: RepositoryId;
  treeId: TaskTreeId;
  planRevisionId: PlanRevisionId;
  rootNodeId: TaskNodeId;
  rootArtifactId: ArtifactId;
  goal: NonEmptyText;
  baseCommit: GitSha;
  budget: TreeBudgetRecord;
  rootAllowedRepositoryPaths: readonly NonEmptyText[];
  attentionId: string;
  at: Timestamp;
}>;

type CreateTemplatedSnapshot = Readonly<{
  requestBytes: Uint8Array;
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  repositoryId: RepositoryId;
  treeId: TaskTreeId;
  planRevisionId: PlanRevisionId;
  rootNodeId: TaskNodeId;
  rootArtifactId: ArtifactId;
  goal: NonEmptyText;
  baseCommit: GitSha;
  budget: TreeBudgetRecord;
  rootAllowedRepositoryPaths: readonly NonEmptyText[];
  attentionId: string;
  autoApprove: boolean;
  nodes: readonly ProposedNodeRecord[];
  at: Timestamp;
}>;
type PlanSnapshot = Readonly<{
  requestBytes: Uint8Array;
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  treeId: TaskTreeId;
  planRevisionId: PlanRevisionId;
  goal: NonEmptyText;
  nodes: readonly ProposedNodeRecord[];
  at: Timestamp;
  attentionId?: string;
}>;

type ApproveSnapshot = Readonly<{
  requestBytes: Uint8Array;
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  treeId: TaskTreeId;
  planRevisionId: PlanRevisionId;
  at: Timestamp;
}>;

type RegistrySnapshot = CreateSnapshot | CreateTemplatedSnapshot | PlanSnapshot | ApproveSnapshot;

type EncodedEffect = Readonly<{
  event: Readonly<{ typeName: NonEmptyText; bytes: Uint8Array }>;
  result: Readonly<{ typeName: NonEmptyText; bytes: Uint8Array }>;
  externalOperations: readonly [];
}>;

export function createPlanRegistry(options: CreatePlanRegistryOptions): PlanRegistry {
  const trustedHostId = parseHostId(options.hostId, "host ID");
  return new DefaultPlanRegistry(options.database, options.commandStore, trustedHostId);
}

class DefaultPlanRegistry implements PlanRegistry {
  readonly #database: ManagedSqliteDatabase;
  readonly #commandStore: SqliteCommandStore;
  readonly #hostId: HostId;

  constructor(
    database: ManagedSqliteDatabase,
    commandStore: SqliteCommandStore,
    hostIdValue: HostId,
  ) {
    this.#database = database;
    this.#commandStore = commandStore;
    this.#hostId = hostIdValue;
  }

  async create(input: CreateTreeInput): Promise<TreeRecord> {
    const snapshot = snapshotCreateInput(input);
    const command = commandRequest(
      snapshot.commandId,
      snapshot.actorSessionId,
      "tree",
      snapshot.treeId,
      null,
      CreateTreeRequestSchema.typeName,
      snapshot.requestBytes,
    );
    try {
      const receipt = await this.#commandStore.execute(command, (transaction) =>
        applyCreate(transaction, snapshot, this.#hostId),
      );
      return this.#resultTree(
        receipt.result,
        CreateTreeResponseSchema.typeName,
        receipt.aggregateVersion,
        snapshot,
        "create",
      );
    } catch (error) {
      throw normalizePlanError(error);
    }
  }

  async createTemplated(input: CreateTemplatedTreeInput): Promise<TreeRecord> {
    const snapshot = snapshotCreateTemplatedInput(input);
    const command = commandRequest(
      snapshot.commandId,
      snapshot.actorSessionId,
      "tree",
      snapshot.treeId,
      null,
      CreateTemplatedTreeRequestSchema.typeName,
      snapshot.requestBytes,
    );
    try {
      const receipt = await this.#commandStore.execute(command, (transaction) =>
        applyCreateTemplated(transaction, snapshot, this.#hostId),
      );
      return this.#resultTree(
        receipt.result,
        CreateTemplatedTreeResponseSchema.typeName,
        receipt.aggregateVersion,
        snapshot,
        "createTemplated",
      );
    } catch (error) {
      throw normalizePlanError(error);
    }
  }
  get(treeId: TaskTreeId): TreeRecord {
    const parsed = parseTreeId(treeId, "tree ID");
    try {
      return this.#database.read((reader) => readTreeRecord(reader, parsed));
    } catch (error) {
      throw normalizeReadError(error);
    }
  }

  list(input: ListTreesInput): readonly TreeSummaryRecord[] {
    const afterId =
      input.afterId === undefined ? undefined : parseTreeId(input.afterId, "cursor tree ID");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101) {
      throw new PlanRegistryError("invalid_input", "tree list limit must be between 1 and 101");
    }
    try {
      return this.#database.read((reader) => {
        const rows =
          afterId === undefined
            ? reader.all("SELECT id FROM trees WHERE archived_at_ms IS NULL ORDER BY id LIMIT ?", [
                input.limit,
              ])
            : reader.all(
                "SELECT id FROM trees WHERE archived_at_ms IS NULL AND id > ? ORDER BY id LIMIT ?",
                [afterId, input.limit],
              );
        const summaries = rows.map((row) => {
          const id = taskTreeId(requiredString(row, "id"));
          const tree = readTreeRecord(reader, id);
          return toTreeSummary(tree);
        });
        return Object.freeze(summaries);
      });
    } catch (error) {
      throw normalizeReadError(error);
    }
  }

  async propose(input: ProposePlanInput): Promise<TreeRecord> {
    const snapshot = snapshotProposeInput(input);
    return this.#applyPlan(snapshot, false);
  }

  async repair(input: RepairPlanInput): Promise<TreeRecord> {
    const snapshot = snapshotRepairInput(input);
    return this.#applyPlan(snapshot, true);
  }

  async approve(input: ApprovePlanInput): Promise<TreeRecord> {
    const snapshot = snapshotApproveInput(input);
    let current: TreeRecord;
    try {
      current = this.get(snapshot.treeId);
    } catch (error) {
      throw normalizePlanError(error);
    }
    const expectedVersion = this.#expectedTreeVersion(
      snapshot.treeId,
      snapshot.commandId,
      current.version,
    );
    const command = commandRequest(
      snapshot.commandId,
      snapshot.actorSessionId,
      "tree",
      snapshot.treeId,
      expectedVersion,
      ApprovePlanRequestSchema.typeName,
      snapshot.requestBytes,
    );
    try {
      const receipt = await this.#commandStore.execute(command, (transaction) =>
        applyApprove(transaction, snapshot),
      );
      return this.#resultTree(
        receipt.result,
        ApprovePlanResponseSchema.typeName,
        receipt.aggregateVersion,
        snapshot,
        "approve",
      );
    } catch (error) {
      throw normalizePlanError(error);
    }
  }
  #expectedTreeVersion(treeId: TaskTreeId, command: CommandId, currentVersion: number): number {
    try {
      return this.#database.read((reader) => {
        const row = reader.get(
          `SELECT aggregate_kind, aggregate_id, expected_version
             FROM operator_commands WHERE id = ?`,
          [command],
        );
        if (row?.["aggregate_kind"] !== "tree" || row["aggregate_id"] !== treeId) {
          return currentVersion;
        }
        const expected = row["expected_version"];
        if (expected === null) {
          return currentVersion;
        }
        return safeInteger(expected, "stored expected tree version");
      });
    } catch (error) {
      if (error instanceof PlanRegistryError) throw error;
      throw new PlanRegistryError("corrupt", "stored tree command version is corrupt", {
        cause: error,
      });
    }
  }

  async #applyPlan(snapshot: PlanSnapshot, repair: boolean): Promise<TreeRecord> {
    let current: TreeRecord;
    try {
      current = this.get(snapshot.treeId);
    } catch (error) {
      throw normalizePlanError(error);
    }
    const expectedVersion = this.#expectedTreeVersion(
      snapshot.treeId,
      snapshot.commandId,
      current.version,
    );
    const command = commandRequest(
      snapshot.commandId,
      snapshot.actorSessionId,
      "tree",
      snapshot.treeId,
      expectedVersion,
      repair ? RepairPlanRequestSchema.typeName : ProposePlanRequestSchema.typeName,
      snapshot.requestBytes,
    );
    try {
      const receipt = await this.#commandStore.execute(command, (transaction) =>
        applyPlan(transaction, snapshot, repair),
      );
      return this.#resultTree(
        receipt.result,
        repair ? RepairPlanResponseSchema.typeName : ProposePlanResponseSchema.typeName,
        receipt.aggregateVersion,
        snapshot,
        repair ? "repair" : "propose",
      );
    } catch (error) {
      throw normalizePlanError(error);
    }
  }

  #resultTree(
    result: Readonly<{ typeName: string; bytes: Uint8Array }>,
    expectedTypeName: string,
    aggregateVersion: number,
    snapshot: RegistrySnapshot,
    operation: "create" | "createTemplated" | "propose" | "repair" | "approve",
  ): TreeRecord {
    if (result.typeName !== expectedTypeName) {
      throw new PlanRegistryError("corrupt", "plan result type does not match the command");
    }
    try {
      const schema =
        operation === "create"
          ? CreateTreeResponseSchema
          : operation === "createTemplated"
            ? CreateTemplatedTreeResponseSchema
            : operation === "propose"
              ? ProposePlanResponseSchema
              : operation === "repair"
                ? RepairPlanResponseSchema
                : ApprovePlanResponseSchema;
      const decoded = fromBinary(schema, result.bytes);
      const unknownField = findUnknownField(schema, decoded);
      if (unknownField !== undefined || decoded.tree === undefined) {
        throw new TypeError("plan result violates its Protobuf contract");
      }
      const tree = treeFromMessage(decoded.tree);
      assertRequestFacts(tree, snapshot, operation);
      assertResultVersion(tree, aggregateVersion);
      const persisted = this.#database.read((reader) => readTreeRecord(reader, snapshot.treeId));
      assertImmutableReplayFacts(tree, persisted);
      if (persisted.version === tree.version && !equivalentTree(tree, persisted)) {
        throw new PlanRegistryError("corrupt", "plan result does not match persisted tree");
      }
      return persisted.version === tree.version ? persisted : tree;
    } catch (error) {
      if (error instanceof PlanRegistryError) {
        throw error;
      }
      throw new PlanRegistryError("corrupt", "plan command result is corrupt", { cause: error });
    }
  }
}

function commandRequest(
  id: CommandId,
  actorSessionIdValue: ActorSessionId,
  aggregateKind: "tree",
  aggregateId: TaskTreeId,
  expectedVersion: number | null,
  typeName: string,
  bytes: Uint8Array,
) {
  return {
    id,
    actorSessionId: actorSessionIdValue,
    aggregateKind,
    aggregateId,
    expectedVersion,
    command: { typeName: nonEmptyText(typeName, "command type name"), bytes },
  } as const;
}

function applyCreate(
  transaction: SqliteCommandTransaction,
  snapshot: CreateSnapshot,
  trustedHostId: HostId,
): EncodedEffect {
  const registration = transaction.get(
    `SELECT rr.repository_id, rr.host_id, rr.base_commit, rr.registered_at_ms,
            r.id AS projection_id, r.host_id AS projection_host_id,
            r.version AS projection_version, r.archived_at_ms AS projection_archived_at_ms
       FROM repository_registrations AS rr
       JOIN repositories AS r ON r.id = rr.repository_id
      WHERE rr.repository_id = ?`,
    [snapshot.repositoryId],
  );
  if (registration === undefined) {
    throw new PlanRegistryError("not_found", "repository registration does not exist");
  }
  const registeredHost = parseHostId(requiredString(registration, "host_id"), "registered host ID");
  const registeredBase = parseGitSha(
    requiredString(registration, "base_commit"),
    "registered base commit",
  );
  const registeredAt = safeTimestamp(registration["registered_at_ms"], "registered_at_ms");
  if (
    requiredString(registration, "projection_id") !== snapshot.repositoryId ||
    requiredString(registration, "projection_host_id") !== registeredHost ||
    safeInteger(registration["projection_version"], "projection_version") !== 0 ||
    registration["projection_archived_at_ms"] !== null
  ) {
    throw new PlanRegistryError("corrupt", "repository registration projection is corrupt");
  }
  if (registeredHost !== trustedHostId) {
    throw new PlanRegistryError(
      "identity_conflict",
      "repository registration belongs to another host",
    );
  }
  if (registeredBase !== snapshot.baseCommit) {
    throw new PlanRegistryError(
      "identity_conflict",
      "tree base commit differs from registered repository base commit",
    );
  }
  if (snapshot.at < registeredAt) {
    // If the registered repository timestamp is slightly in the future due to millisecond
    // clock granularity across processes, allow within 1 second of registration.
    if (registeredAt - snapshot.at > 1000) {
      throw new PlanRegistryError(
        "invalid_input",
        "tree timestamp predates repository registration",
      );
    }
  }
  assertDistinctIds(
    [
      snapshot.repositoryId,
      trustedHostId,
      snapshot.treeId,
      snapshot.planRevisionId,
      snapshot.rootNodeId,
      snapshot.rootArtifactId,
      snapshot.attentionId,
    ],
    "tree IDs must be distinct",
  );
  assertCreateIdAvailability(transaction, snapshot);
  transaction.run(
    `INSERT INTO trees (
       id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
       root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
    [
      snapshot.treeId,
      snapshot.repositoryId,
      trustedHostId,
      snapshot.baseCommit,
      snapshot.goal,
      snapshot.planRevisionId,
      snapshot.rootNodeId,
      snapshot.at,
      snapshot.at,
    ],
  );
  transaction.run(
    `INSERT INTO plan_revisions (
       id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
       approved_at_ms, superseded_at_ms
     ) VALUES (?, ?, 1, ?, 'draft', 0, ?, NULL, NULL)`,
    [snapshot.planRevisionId, snapshot.treeId, snapshot.goal, snapshot.at],
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
     ) VALUES (?, ?, ?, ?, NULL, ?, 'plan', ?, 'artifact', ?, 'plan',
               'planned', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
    [
      snapshot.rootNodeId,
      snapshot.treeId,
      snapshot.repositoryId,
      trustedHostId,
      snapshot.planRevisionId,
      snapshot.goal,
      snapshot.rootArtifactId,
      snapshot.at,
      snapshot.at,
    ],
  );
  transaction.run(
    `INSERT INTO node_acceptance_criteria (node_id, ordinal, criterion)
     VALUES (?, 0, ?)`,
    [snapshot.rootNodeId, snapshot.goal],
  );
  for (let index = 0; index < snapshot.rootAllowedRepositoryPaths.length; index += 1) {
    const repositoryPath = snapshot.rootAllowedRepositoryPaths[index];
    if (repositoryPath === undefined) {
      throw new PlanRegistryError("corrupt", "root repository scope is sparse");
    }
    transaction.run(
      `INSERT INTO node_repository_scope (node_id, ordinal, repository_path)
       VALUES (?, ?, ?)`,
      [snapshot.rootNodeId, index, repositoryPath],
    );
  }
  transaction.run(
    `INSERT INTO node_plan_policies (node_id, max_attempts)
     VALUES (?, ?)`,
    [snapshot.rootNodeId, snapshot.budget.maxAttemptsPerNode],
  );
  transaction.run(
    `INSERT INTO tree_budgets (
       tree_id, max_depth, max_fan_out, max_nodes, max_concurrency, max_attempts_per_node
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      snapshot.treeId,
      snapshot.budget.maxDepth,
      snapshot.budget.maxFanOut,
      snapshot.budget.maxNodes,
      snapshot.budget.maxConcurrency,
      snapshot.budget.maxAttemptsPerNode,
    ],
  );
  transaction.run(
    `INSERT INTO plan_attentions (
       id, tree_id, plan_revision_id, kind, message, state_kind, created_at_ms, resolved_at_ms
     ) VALUES (?, ?, ?, 'plan_required', ?, 'open', ?, NULL)`,
    [
      snapshot.attentionId,
      snapshot.treeId,
      snapshot.planRevisionId,
      "tree requires an initial plan",
      snapshot.at,
    ],
  );
  const tree = readTreeRecord(transaction, snapshot.treeId);
  return effectForTree(tree, "create");
}

function applyCreateTemplated(
  transaction: SqliteCommandTransaction,
  snapshot: CreateTemplatedSnapshot,
  trustedHostId: HostId,
): EncodedEffect {
  const registration = transaction.get(
    `SELECT rr.repository_id, rr.host_id, rr.base_commit, rr.registered_at_ms,
            r.id AS projection_id, r.host_id AS projection_host_id,
            r.version AS projection_version, r.archived_at_ms AS projection_archived_at_ms
       FROM repository_registrations AS rr
       JOIN repositories AS r ON r.id = rr.repository_id
      WHERE rr.repository_id = ?`,
    [snapshot.repositoryId],
  );
  if (registration === undefined) {
    throw new PlanRegistryError("not_found", "repository registration does not exist");
  }
  const registeredHost = parseHostId(requiredString(registration, "host_id"), "registered host ID");
  const registeredBase = parseGitSha(
    requiredString(registration, "base_commit"),
    "registered base commit",
  );
  const registeredAt = safeTimestamp(registration["registered_at_ms"], "registered_at_ms");
  if (
    requiredString(registration, "projection_id") !== snapshot.repositoryId ||
    requiredString(registration, "projection_host_id") !== registeredHost ||
    safeInteger(registration["projection_version"], "projection_version") !== 0 ||
    registration["projection_archived_at_ms"] !== null
  ) {
    throw new PlanRegistryError("corrupt", "repository registration projection is corrupt");
  }
  if (registeredHost !== trustedHostId) {
    throw new PlanRegistryError(
      "identity_conflict",
      "repository registration belongs to another host",
    );
  }
  if (registeredBase !== snapshot.baseCommit) {
    throw new PlanRegistryError(
      "identity_conflict",
      "tree base commit differs from registered repository base commit",
    );
  }
  if (snapshot.at < registeredAt) {
    if (registeredAt - snapshot.at > 1000) {
      throw new PlanRegistryError(
        "invalid_input",
        "tree timestamp predates repository registration",
      );
    }
  }
  assertDistinctIds(
    [
      snapshot.repositoryId,
      trustedHostId,
      snapshot.treeId,
      snapshot.planRevisionId,
      snapshot.rootNodeId,
      snapshot.rootArtifactId,
      snapshot.attentionId,
      ...snapshot.nodes.flatMap((node) => [
        node.id,
        ...(node.outputContract.case === "artifact" ? [node.outputContract.value.artifactId] : []),
      ]),
    ],
    "tree IDs must be distinct",
  );
  assertCreateTemplatedIdAvailability(transaction, snapshot);

  transaction.run(
    `INSERT INTO trees (
       id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
       root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
    [
      snapshot.treeId,
      snapshot.repositoryId,
      trustedHostId,
      snapshot.baseCommit,
      snapshot.goal,
      snapshot.planRevisionId,
      snapshot.rootNodeId,
      snapshot.at,
      snapshot.at,
    ],
  );
  transaction.run(
    `INSERT INTO plan_revisions (
       id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
       approved_at_ms, superseded_at_ms
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL)`,
    [
      snapshot.planRevisionId,
      snapshot.treeId,
      snapshot.goal,
      snapshot.autoApprove ? "approved" : "draft",
      snapshot.autoApprove ? 1 : 0,
      snapshot.at,
      snapshot.autoApprove ? snapshot.at : null,
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
     ) VALUES (?, ?, ?, ?, NULL, ?, 'plan', ?, 'artifact', ?, 'plan',
               'planned', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
    [
      snapshot.rootNodeId,
      snapshot.treeId,
      snapshot.repositoryId,
      trustedHostId,
      snapshot.planRevisionId,
      snapshot.goal,
      snapshot.rootArtifactId,
      snapshot.at,
      snapshot.at,
    ],
  );
  transaction.run(
    `INSERT INTO node_acceptance_criteria (node_id, ordinal, criterion)
     VALUES (?, 0, ?)`,
    [snapshot.rootNodeId, snapshot.goal],
  );
  for (let index = 0; index < snapshot.rootAllowedRepositoryPaths.length; index += 1) {
    const repositoryPath = snapshot.rootAllowedRepositoryPaths[index];
    if (repositoryPath === undefined) {
      throw new PlanRegistryError("corrupt", "root repository scope is sparse");
    }
    transaction.run(
      `INSERT INTO node_repository_scope (node_id, ordinal, repository_path)
       VALUES (?, ?, ?)`,
      [snapshot.rootNodeId, index, repositoryPath],
    );
  }
  transaction.run(
    `INSERT INTO node_plan_policies (node_id, max_attempts)
     VALUES (?, ?)`,
    [snapshot.rootNodeId, snapshot.budget.maxAttemptsPerNode],
  );

  for (const node of snapshot.nodes) {
    const isDirectExecutableChild =
      snapshot.autoApprove &&
      node.parentNodeId === snapshot.rootNodeId &&
      isExecutableNodeMode(node.mode);
    const nodeStateKind = isDirectExecutableChild ? "ready" : "planned";
    const output = node.outputContract.case === "artifact" ? node.outputContract.value : undefined;

    transaction.run(
      `INSERT INTO nodes (
         id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
         mode, objective, output_kind, output_artifact_id, output_artifact_type,
         state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
         blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
         outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
         outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
         version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      [
        node.id,
        snapshot.treeId,
        snapshot.repositoryId,
        trustedHostId,
        node.parentNodeId ?? null,
        snapshot.planRevisionId,
        modeKind(node.mode),
        node.objective,
        node.outputContract.case,
        output?.artifactId ?? null,
        output?.artifactType ?? null,
        nodeStateKind,
        isDirectExecutableChild ? 1 : 0,
        snapshot.at,
        snapshot.at,
      ],
    );
    for (let index = 0; index < node.acceptanceCriteria.length; index += 1) {
      const criterion = node.acceptanceCriteria[index];
      if (criterion === undefined) {
        throw new PlanRegistryError("corrupt", "node acceptance criteria are sparse");
      }
      transaction.run(
        `INSERT INTO node_acceptance_criteria (node_id, ordinal, criterion)
         VALUES (?, ?, ?)`,
        [node.id, index, criterion],
      );
    }
    for (let index = 0; index < node.inputs.length; index += 1) {
      const input = node.inputs[index];
      if (input === undefined) {
        throw new PlanRegistryError("corrupt", "node artifact inputs are sparse");
      }
      transaction.run(
        `INSERT INTO node_artifact_inputs (node_id, ordinal, artifact_id, source_node_id)
         VALUES (?, ?, ?, ?)`,
        [node.id, index, input.artifactId, input.sourceNodeId],
      );
    }
    for (let index = 0; index < node.allowedRepositoryPaths.length; index += 1) {
      const repositoryPath = node.allowedRepositoryPaths[index];
      if (repositoryPath === undefined) {
        throw new PlanRegistryError("corrupt", "node repository scope is sparse");
      }
      transaction.run(
        `INSERT INTO node_repository_scope (node_id, ordinal, repository_path)
         VALUES (?, ?, ?)`,
        [node.id, index, repositoryPath],
      );
    }
    transaction.run(
      `INSERT INTO node_plan_policies (node_id, max_attempts)
       VALUES (?, ?)`,
      [node.id, snapshot.budget.maxAttemptsPerNode],
    );
  }

  transaction.run(
    `INSERT INTO tree_budgets (
       tree_id, max_depth, max_fan_out, max_nodes, max_concurrency, max_attempts_per_node
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      snapshot.treeId,
      snapshot.budget.maxDepth,
      snapshot.budget.maxFanOut,
      snapshot.budget.maxNodes,
      snapshot.budget.maxConcurrency,
      snapshot.budget.maxAttemptsPerNode,
    ],
  );

  transaction.run(
    `INSERT INTO plan_attentions (
       id, tree_id, plan_revision_id, kind, message, state_kind, created_at_ms, resolved_at_ms
     ) VALUES (?, ?, ?, 'plan_required', ?, 'resolved', ?, ?)`,
    [
      snapshot.attentionId,
      snapshot.treeId,
      snapshot.planRevisionId,
      "tree requires an initial plan",
      snapshot.at,
      snapshot.at,
    ],
  );

  const tree = readTreeRecord(transaction, snapshot.treeId);
  return effectForTree(tree, "createTemplated");
}
function applyPlan(
  transaction: SqliteCommandTransaction,
  snapshot: PlanSnapshot,
  repair: boolean,
): EncodedEffect {
  const current = readTreeRecord(transaction, snapshot.treeId);
  if (snapshot.at < current.updatedAt) {
    throw new PlanRegistryError("invalid_input", "plan timestamp predates the current tree update");
  }
  if (
    current.activePlanRevisionId === snapshot.planRevisionId ||
    current.revisions.some((revision) => revision.id === snapshot.planRevisionId)
  ) {
    throw new PlanRegistryError("invalid_plan", "plan revision ID is already used by this tree");
  }
  if (current.goal.length === 0) {
    throw new PlanRegistryError("corrupt", "tree goal is empty");
  }
  if (repair) {
    if (snapshot.attentionId === undefined) {
      throw new PlanRegistryError("invalid_input", "repair attention ID is required");
    }
    const attention = current.attention;
    if (attention?.id !== snapshot.attentionId || attention.state !== PlanAttentionState.OPEN) {
      throw new PlanRegistryError(
        "invalid_plan",
        "repair attention is not an open attention on this tree",
      );
    }
  } else if (
    current.attention !== undefined &&
    current.attention.kind !== PlanAttentionKind.PLAN_REQUIRED
  ) {
    throw new PlanRegistryError("invalid_plan", "another plan attention is already open");
  }
  validateProposedPlan(current, snapshot.nodes, snapshot.goal, snapshot.planRevisionId);
  assertProposedIdAvailability(transaction, snapshot);
  const ordinal =
    current.revisions.reduce((maximum, revision) => Math.max(maximum, revision.ordinal), 0) + 1;
  const nextVersion = current.version + 1;
  const revision = transaction.get("SELECT id FROM plan_revisions WHERE id = ?", [
    snapshot.planRevisionId,
  ]);
  if (revision !== undefined) {
    throw new PlanRegistryError("invalid_plan", "plan revision ID is already persisted");
  }
  transaction.run(
    `INSERT INTO plan_revisions (
       id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
       approved_at_ms, superseded_at_ms
     ) VALUES (?, ?, ?, ?, 'draft', 0, ?, NULL, NULL)`,
    [snapshot.planRevisionId, snapshot.treeId, ordinal, snapshot.goal, snapshot.at],
  );
  const oldActiveRevision = current.revisions.find(
    (revisionValue) => revisionValue.id === current.activePlanRevisionId,
  );
  if (oldActiveRevision?.state === PlanRevisionState.APPROVED) {
    transaction.run(
      `UPDATE plan_revisions
          SET state_kind = 'superseded', version = version + 1, superseded_at_ms = ?
        WHERE id = ? AND state_kind = 'approved'`,
      [snapshot.at, oldActiveRevision.id],
    );
  }
  transaction.run(
    `UPDATE nodes
        SET state_kind = 'superseded', superseded_plan_revision_id = ?, version = version + 1,
            updated_at_ms = ?
      WHERE tree_id = ? AND id <> ? AND state_kind IN ('planned', 'ready')`,
    [snapshot.planRevisionId, snapshot.at, snapshot.treeId, current.rootNodeId],
  );
  for (const node of snapshot.nodes) {
    const output = node.outputContract.case === "artifact" ? node.outputContract.value : undefined;
    transaction.run(
      `INSERT INTO nodes (
         id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
         mode, objective, output_kind, output_artifact_id, output_artifact_type,
         state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
         blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
         outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
         outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
         version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
      [
        node.id,
        snapshot.treeId,
        current.repositoryId,
        current.hostId,
        node.parentNodeId ?? null,
        snapshot.planRevisionId,
        modeKind(node.mode),
        node.objective,
        node.outputContract.case,
        output?.artifactId ?? null,
        output?.artifactType ?? null,
        snapshot.at,
        snapshot.at,
      ],
    );
    for (let index = 0; index < node.acceptanceCriteria.length; index += 1) {
      const criterion = node.acceptanceCriteria[index];
      if (criterion === undefined) {
        throw new PlanRegistryError("corrupt", "node acceptance criteria are sparse");
      }
      transaction.run(
        `INSERT INTO node_acceptance_criteria (node_id, ordinal, criterion)
         VALUES (?, ?, ?)`,
        [node.id, index, criterion],
      );
    }
    for (let index = 0; index < node.inputs.length; index += 1) {
      const input = node.inputs[index];
      if (input === undefined) {
        throw new PlanRegistryError("corrupt", "node artifact inputs are sparse");
      }
      transaction.run(
        `INSERT INTO node_artifact_inputs (node_id, ordinal, artifact_id, source_node_id)
         VALUES (?, ?, ?, ?)`,
        [node.id, index, input.artifactId, input.sourceNodeId],
      );
    }
    for (let index = 0; index < node.allowedRepositoryPaths.length; index += 1) {
      const repositoryPath = node.allowedRepositoryPaths[index];
      if (repositoryPath === undefined) {
        throw new PlanRegistryError("corrupt", "node repository scope is sparse");
      }
      transaction.run(
        `INSERT INTO node_repository_scope (node_id, ordinal, repository_path)
         VALUES (?, ?, ?)`,
        [node.id, index, repositoryPath],
      );
    }
    transaction.run(
      `INSERT INTO node_plan_policies (node_id, max_attempts)
       VALUES (?, ?)`,
      [node.id, current.budget.maxAttemptsPerNode],
    );
  }
  if (
    current.attention !== undefined &&
    (!repair || current.attention.id === snapshot.attentionId)
  ) {
    if (current.attention.kind === PlanAttentionKind.PLAN_REQUIRED || repair) {
      transaction.run(
        `UPDATE plan_attentions
            SET state_kind = 'resolved', resolved_at_ms = ?
          WHERE id = ? AND tree_id = ? AND state_kind = 'open'`,
        [snapshot.at, current.attention.id, snapshot.treeId],
      );
    }
  }
  transaction.run(
    `UPDATE trees
        SET active_plan_revision_id = ?, goal = ?, version = version + 1, updated_at_ms = ?
      WHERE id = ?`,
    [snapshot.planRevisionId, snapshot.goal, snapshot.at, snapshot.treeId],
  );
  const tree = readTreeRecord(transaction, snapshot.treeId);
  if (tree.version !== nextVersion) {
    throw new PlanRegistryError("corrupt", "tree version did not advance exactly once");
  }
  return effectForTree(tree, repair ? "repair" : "propose");
}

function applyApprove(
  transaction: SqliteCommandTransaction,
  snapshot: ApproveSnapshot,
): EncodedEffect {
  const current = readTreeRecord(transaction, snapshot.treeId);
  if (snapshot.at < current.updatedAt) {
    throw new PlanRegistryError(
      "invalid_input",
      "approval timestamp predates the current tree update",
    );
  }
  if (current.activePlanRevisionId !== snapshot.planRevisionId) {
    throw new PlanRegistryError("invalid_plan", "approval must name the active plan revision");
  }
  const revision = current.revisions.find((candidate) => candidate.id === snapshot.planRevisionId);
  if (revision === undefined) {
    throw new PlanRegistryError("corrupt", "active plan revision is missing");
  }
  if (revision.state !== PlanRevisionState.DRAFT) {
    throw new PlanRegistryError("invalid_plan", "only a draft plan revision can be approved");
  }
  if (current.attention?.state === PlanAttentionState.OPEN) {
    throw new PlanRegistryError(
      "invalid_plan",
      "open plan attention must be resolved before approval",
    );
  }
  if (
    !current.nodes.some(
      (node) =>
        node.planRevisionId === snapshot.planRevisionId &&
        isExecutableNodeMode(node.mode) &&
        node.state === NodeState.PLANNED,
    )
  ) {
    throw new PlanRegistryError(
      "invalid_plan",
      "an approved plan requires at least one planned executable child",
    );
  }
  transaction.run(
    `UPDATE plan_revisions
        SET state_kind = 'approved', version = version + 1, approved_at_ms = ?
      WHERE id = ? AND state_kind = 'draft'`,
    [snapshot.at, snapshot.planRevisionId],
  );
  transaction.run(
    `UPDATE nodes
        SET state_kind = 'ready', version = version + 1, updated_at_ms = ?
      WHERE tree_id = ? AND plan_revision_id = ? AND parent_node_id = ?
        AND mode IN (${EXECUTABLE_NODE_MODE_PLACEHOLDERS}) AND state_kind = 'planned'`,
    [
      snapshot.at,
      snapshot.treeId,
      snapshot.planRevisionId,
      current.rootNodeId,
      ...EXECUTABLE_NODE_MODE_KINDS,
    ],
  );
  transaction.run(`UPDATE trees SET version = version + 1, updated_at_ms = ? WHERE id = ?`, [
    snapshot.at,
    snapshot.treeId,
  ]);
  const tree = readTreeRecord(transaction, snapshot.treeId);
  if (tree.state !== TreeState.APPROVED) {
    throw new PlanRegistryError("corrupt", "approved tree did not derive an approved state");
  }
  return effectForTree(tree, "approve");
}

function effectForTree(
  tree: TreeRecord,
  operation: "create" | "createTemplated" | "propose" | "repair" | "approve",
): EncodedEffect {
  const responseSchema = responseSchemaFor(operation);
  const response = create(responseSchema, { tree: treeMessage(tree) });
  const changes: MessageShape<typeof ProjectionChangeSchema>[] = [
    create(ProjectionChangeSchema, {
      change: {
        case: "treeUpserted",
        value: create(TreeSummarySchema, {
          id: tree.id,
          repositoryId: tree.repositoryId,
          hostId: tree.hostId,
          rootNodeId: tree.rootNodeId,
          activePlanRevisionId: tree.activePlanRevisionId,
          state: tree.state,
          version: BigInt(tree.version),
        }),
      },
    }),
  ];
  const siblingOrdinals = new Map<string, number>();
  const siblingGroups = new Map<string | undefined, TaskNodeRecord[]>();
  for (const node of tree.nodes) {
    const siblings = siblingGroups.get(node.parentNodeId) ?? [];
    siblings.push(node);
    siblingGroups.set(node.parentNodeId, siblings);
  }
  for (const siblings of siblingGroups.values()) {
    siblings.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
    siblings.forEach((node, ordinal) => siblingOrdinals.set(node.id, ordinal));
  }
  for (const node of tree.nodes) {
    const ordinal = siblingOrdinals.get(node.id);
    if (ordinal === undefined) {
      throw new PlanRegistryError("corrupt", "tree node sibling ordering is corrupt");
    }
    changes.push(
      create(ProjectionChangeSchema, {
        change: {
          case: "nodeUpserted",
          value: create(NodeSummarySchema, {
            id: node.id,
            treeId: tree.id,
            parentNodeId: node.parentNodeId,
            ordinal: BigInt(ordinal),
            objective: node.objective,
            state: node.state,
            version: BigInt(node.version),
          }),
        },
      }),
    );
  }
  changes.push(
    create(ProjectionChangeSchema, {
      change:
        tree.attention === undefined
          ? {
              case: "attentionRemoved",
              value: create(AttentionRemovedSchema, { nodeId: tree.rootNodeId }),
            }
          : {
              case: "attentionUpserted",
              value: create(AttentionSummarySchema, {
                nodeId: tree.rootNodeId,
                kind: AttentionKind.HUMAN_INPUT,
              }),
            },
    }),
  );
  const event = create(ProjectionChangeSchema, {
    change: {
      case: "batch",
      value: create(ProjectionBatchSchema, { changes }),
    },
  });
  return Object.freeze({
    event: Object.freeze({
      typeName: nonEmptyText(ProjectionChangeSchema.typeName, "event type name"),
      bytes: toBinary(ProjectionChangeSchema, event),
    }),
    result: Object.freeze({
      typeName: nonEmptyText(responseSchema.typeName, "result type name"),
      bytes: toBinary(responseSchema, response),
    }),
    externalOperations: [],
  });
}

function responseSchemaFor(
  operation: "create" | "createTemplated" | "propose" | "repair" | "approve",
) {
  if (operation === "create") return CreateTreeResponseSchema;
  if (operation === "createTemplated") return CreateTemplatedTreeResponseSchema;
  if (operation === "propose") return ProposePlanResponseSchema;
  if (operation === "repair") return RepairPlanResponseSchema;
  return ApprovePlanResponseSchema;
}

function treeMessage(tree: TreeRecord) {
  const revisions = tree.revisions.map((revision) =>
    create(PlanRevisionSchema, {
      id: revision.id,
      treeId: revision.treeId,
      ordinal: BigInt(revision.ordinal),
      goal: revision.goal,
      state: revision.state,
      version: BigInt(revision.version),
      createdAt: timestampMessage(revision.createdAt),
      ...(revision.approvedAt === undefined
        ? {}
        : { approvedAt: timestampMessage(revision.approvedAt) }),
      ...(revision.supersededAt === undefined
        ? {}
        : { supersededAt: timestampMessage(revision.supersededAt) }),
    }),
  );
  const nodes = tree.nodes.map((node) =>
    create(TaskNodeSchema, {
      id: node.id,
      treeId: node.treeId,
      repositoryId: node.repositoryId,
      hostId: node.hostId,
      ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
      planRevisionId: node.planRevisionId,
      mode: node.mode,
      objective: node.objective,
      acceptanceCriteria: [...node.acceptanceCriteria],
      inputs: node.inputs.map((input) => create(ArtifactInputSchema, input)),
      outputContract:
        node.outputContract.case === "artifact"
          ? {
              case: "artifact" as const,
              value: create(ArtifactOutputContractSchema, node.outputContract.value),
            }
          : {
              case: "implementation" as const,
              value: create(ImplementationOutputContractSchema, {}),
            },
      state: node.state,
      version: BigInt(node.version),
      createdAt: timestampMessage(node.createdAt),
      updatedAt: timestampMessage(node.updatedAt),
      allowedRepositoryPaths: [...node.allowedRepositoryPaths],
      budget: create(NodeBudgetSchema, node.budget),
    }),
  );
  return create(TaskTreeSchema, {
    id: tree.id,
    repositoryId: tree.repositoryId,
    hostId: tree.hostId,
    baseCommit: tree.baseCommit,
    goal: tree.goal,
    activePlanRevisionId: tree.activePlanRevisionId,
    rootNodeId: tree.rootNodeId,
    state: tree.state,
    version: BigInt(tree.version),
    createdAt: timestampMessage(tree.createdAt),
    updatedAt: timestampMessage(tree.updatedAt),
    revisions,
    nodes,
    budget: create(TreeBudgetSchema, tree.budget),
    ...(tree.attention === undefined ? {} : { attention: attentionMessage(tree.attention) }),
  });
}

function attentionMessage(attention: PlanAttentionRecord) {
  return create(PlanAttentionSchema, {
    id: attention.id,
    treeId: attention.treeId,
    ...(attention.planRevisionId === undefined ? {} : { planRevisionId: attention.planRevisionId }),
    kind: attention.kind,
    message: attention.message,
    state: attention.state,
    createdAt: timestampMessage(attention.createdAt),
    ...(attention.resolvedAt === undefined
      ? {}
      : { resolvedAt: timestampMessage(attention.resolvedAt) }),
  });
}

function snapshotCreateInput(input: CreateTreeInput): CreateSnapshot {
  try {
    const { message, bytes } = snapshotMessage(
      CreateTreeRequestSchema,
      input.request,
      "create tree request",
    );
    const budget = snapshotBudget(message.budget);
    const repository = repositoryId(message.repositoryId);
    const tree = taskTreeId(message.treeId);
    const revision = planRevisionId(message.planRevisionId);
    const root = taskNodeId(message.rootNodeId);
    const artifact = artifactId(message.rootArtifactId);
    return Object.freeze({
      requestBytes: bytes,
      commandId: commandId(message.commandId),
      actorSessionId: actorSessionId(message.actorSessionId),
      repositoryId: repository,
      treeId: tree,
      planRevisionId: revision,
      rootNodeId: root,
      rootArtifactId: artifact,
      goal: nonEmptyText(message.goal, "tree goal"),
      baseCommit: gitSha(message.baseCommit),
      budget,
      rootAllowedRepositoryPaths: snapshotRepositoryPaths(
        message.rootAllowedRepositoryPaths,
        "root allowed repository paths",
      ),
      attentionId: parseUuid(message.attentionId, "attention ID"),
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    if (error instanceof PlanRegistryError) throw error;
    throw new PlanRegistryError("invalid_input", "create tree input is invalid", { cause: error });
  }
}

function snapshotCreateTemplatedInput(input: CreateTemplatedTreeInput): CreateTemplatedSnapshot {
  try {
    const { message, bytes } = snapshotMessage(
      CreateTemplatedTreeRequestSchema,
      input.request,
      "create templated tree request",
    );
    const budget = snapshotBudget(input.resolved.budget);
    const repository = repositoryId(message.repositoryId);
    const tree = taskTreeId(message.treeId);
    const revision = planRevisionId(message.planRevisionId);
    const root = taskNodeId(message.rootNodeId);
    const artifact = artifactId(message.rootArtifactId);
    const goal = nonEmptyText(message.prompt, "prompt");
    const baseCommit = gitSha(input.baseCommit);

    if (input.mintedNodes.length !== input.resolved.nodes.length) {
      throw new PlanRegistryError(
        "invalid_input",
        "minted nodes count does not match resolved template nodes count",
      );
    }

    const proposedNodes: ProposedNodeRecord[] = input.resolved.nodes.map((node, index) => {
      const minted = input.mintedNodes[index];
      if (minted === undefined) {
        throw new PlanRegistryError(
          "invalid_input",
          `minted node missing at index ${index.toString()}`,
        );
      }
      const parentNodeId =
        node.parentIndex === undefined ? root : input.mintedNodes[node.parentIndex]?.nodeId;
      if (parentNodeId === undefined) {
        throw new PlanRegistryError("invalid_input", "invalid parent node index");
      }
      const mode = modeFromKind(node.mode);
      if (mode === PlanNodeMode.PLAN || mode === PlanNodeMode.UNSPECIFIED) {
        throw new PlanRegistryError(
          "invalid_input",
          "template child mode cannot be plan or unspecified",
        );
      }
      let outputContract: TaskNodeOutputRecord;
      if (node.outputKind === "artifact") {
        if (minted.artifactId === undefined) {
          throw new PlanRegistryError(
            "invalid_input",
            "minted artifactId required for artifact output",
          );
        }
        outputContract = {
          case: "artifact",
          value: {
            artifactId: artifactId(minted.artifactId),
            artifactType: nonEmptyText("report", "artifact type"),
          },
        };
      } else {
        outputContract = {
          case: "implementation",
          value: {},
        };
      }
      return Object.freeze({
        id: taskNodeId(minted.nodeId),
        parentNodeId: taskNodeId(parentNodeId),
        mode,
        objective: nonEmptyText(node.objective, "node objective"),
        acceptanceCriteria: node.acceptanceCriteria.map((criterion, criterionIndex) =>
          nonEmptyText(criterion, `acceptance criteria ${criterionIndex.toString()}`),
        ),
        inputs: [],
        outputContract,
        allowedRepositoryPaths: snapshotRepositoryPaths(
          node.allowedRepositoryPaths,
          "node allowed repository paths",
        ),
      });
    });

    return Object.freeze({
      requestBytes: bytes,
      commandId: commandId(message.commandId),
      actorSessionId: actorSessionId(message.actorSessionId),
      repositoryId: repository,
      treeId: tree,
      planRevisionId: revision,
      rootNodeId: root,
      rootArtifactId: artifact,
      goal,
      baseCommit,
      budget,
      rootAllowedRepositoryPaths: snapshotRepositoryPaths(["."], "root allowed repository paths"),
      attentionId: parseUuid(message.attentionId, "attention ID"),
      autoApprove: input.resolved.autoApprove,
      nodes: Object.freeze(proposedNodes),
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    if (error instanceof PlanRegistryError) throw error;
    throw new PlanRegistryError("invalid_input", "create templated tree input is invalid", {
      cause: error,
    });
  }
}

function snapshotProposeInput(input: ProposePlanInput): PlanSnapshot {
  try {
    const { message, bytes } = snapshotMessage(
      ProposePlanRequestSchema,
      input.request,
      "propose plan request",
    );
    return Object.freeze({
      requestBytes: bytes,
      commandId: commandId(message.commandId),
      actorSessionId: actorSessionId(message.actorSessionId),
      treeId: taskTreeId(message.treeId),
      planRevisionId: planRevisionId(message.planRevisionId),
      goal: nonEmptyText(message.goal, "plan goal"),
      nodes: snapshotProposedNodes(message.nodes),
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    if (error instanceof PlanRegistryError) throw error;
    throw new PlanRegistryError("invalid_input", "propose plan input is invalid", { cause: error });
  }
}

function snapshotRepairInput(input: RepairPlanInput): PlanSnapshot {
  try {
    const { message, bytes } = snapshotMessage(
      RepairPlanRequestSchema,
      input.request,
      "repair plan request",
    );
    return Object.freeze({
      requestBytes: bytes,
      commandId: commandId(message.commandId),
      actorSessionId: actorSessionId(message.actorSessionId),
      treeId: taskTreeId(message.treeId),
      planRevisionId: planRevisionId(message.planRevisionId),
      goal: nonEmptyText(message.goal, "plan goal"),
      nodes: snapshotProposedNodes(message.nodes),
      attentionId: parseUuid(message.attentionId, "attention ID"),
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    if (error instanceof PlanRegistryError) throw error;
    throw new PlanRegistryError("invalid_input", "repair plan input is invalid", { cause: error });
  }
}

function snapshotApproveInput(input: ApprovePlanInput): ApproveSnapshot {
  try {
    const { message, bytes } = snapshotMessage(
      ApprovePlanRequestSchema,
      input.request,
      "approve plan request",
    );
    return Object.freeze({
      requestBytes: bytes,
      commandId: commandId(message.commandId),
      actorSessionId: actorSessionId(message.actorSessionId),
      treeId: taskTreeId(message.treeId),
      planRevisionId: planRevisionId(message.planRevisionId),
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    throw new PlanRegistryError("invalid_input", "approve plan input is invalid", { cause: error });
  }
}

function snapshotMessage<Desc extends DescMessage>(
  schema: Desc,
  input: MessageShape<Desc>,
  fieldName: string,
): { message: MessageShape<Desc>; bytes: Uint8Array } {
  try {
    const bytes = toBinary(schema, input);
    const message = fromBinary(schema, bytes);
    const unknownField = findUnknownField(schema, message);
    if (unknownField !== undefined) {
      throw new TypeError(`${fieldName} contains an unknown field`);
    }
    return { message, bytes: new Uint8Array(bytes) };
  } catch (error) {
    throw new TypeError(`${fieldName} is malformed`, { cause: error });
  }
}

type BudgetInput = Readonly<{
  maxDepth: number;
  maxFanOut: number;
  maxNodes: number;
  maxConcurrency: number;
  maxAttemptsPerNode: number;
}>;

function snapshotBudget(value: BudgetInput | undefined): TreeBudgetRecord {
  if (value === undefined) {
    throw new TypeError("tree budget is required");
  }
  const budget = {
    maxDepth: positiveInteger(value.maxDepth, "max_depth"),
    maxFanOut: positiveInteger(value.maxFanOut, "max_fan_out"),
    maxNodes: positiveInteger(value.maxNodes, "max_nodes"),
    maxConcurrency: positiveInteger(value.maxConcurrency, "max_concurrency"),
    maxAttemptsPerNode: positiveInteger(value.maxAttemptsPerNode, "max_attempts_per_node"),
  };
  if (budget.maxConcurrency > budget.maxNodes) {
    throw new TypeError("max_concurrency must not exceed max_nodes");
  }
  if (budget.maxDepth < 2) {
    throw new TypeError("max_depth must include the structural root and one child");
  }
  if (budget.maxNodes < 2) {
    throw new TypeError("max_nodes must include the structural root and one child");
  }
  return Object.freeze(budget);
}

function snapshotRepositoryPaths(
  values: readonly string[],
  fieldName: string,
): readonly NonEmptyText[] {
  if (values.length < 1) throw new TypeError(`${fieldName} must contain at least one path`);
  const paths = values.map((value, index) =>
    repositoryPath(value, `${fieldName}[${String(index)}]`),
  );
  if (new Set(paths).size !== paths.length) {
    throw new TypeError(`${fieldName} must not contain duplicate paths`);
  }
  return Object.freeze(paths);
}

function repositoryPath(value: string, fieldName: string): NonEmptyText {
  const path = nonEmptyText(value, fieldName);
  const hasControlCharacter = (): boolean => {
    for (let index = 0; index < path.length; index += 1) {
      const code = path.charCodeAt(index);
      if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) return true;
    }
    return false;
  };
  if (
    path.length > 512 ||
    hasControlCharacter() ||
    path.includes("\\") ||
    (path !== "." &&
      (path.startsWith("/") ||
        path.endsWith("/") ||
        /^[A-Za-z]:[/\\]/u.test(path) ||
        path
          .split("/")
          .some((component) => component.length === 0 || component === "." || component === "..")))
  ) {
    throw new TypeError(`${fieldName} is not a canonical relative repository path`);
  }
  return path;
}

function snapshotProposedNodes(values: readonly ProposedNode[]): readonly ProposedNodeRecord[] {
  if (values.length < 1) {
    throw new TypeError("a plan must contain at least one proposed node");
  }
  const nodes = values.map((value, index) => {
    const id = taskNodeId(value.nodeId);
    const parentNodeId =
      value.parentNodeId === undefined ? undefined : taskNodeId(value.parentNodeId);
    const mode = parsePlanNodeMode(value.mode);
    const objective = nonEmptyText(value.objective, `node ${String(index)} objective`);
    if (
      value.acceptanceCriteria.length < 1 ||
      value.acceptanceCriteria.some((criterion) => criterion.trim().length === 0)
    ) {
      throw new TypeError(`node ${String(index)} acceptance criteria are invalid`);
    }
    const acceptanceCriteria = Object.freeze(
      value.acceptanceCriteria.map((criterion) => nonEmptyText(criterion, "acceptance criterion")),
    );
    const inputs = Object.freeze(
      value.inputs.map((inputValue) =>
        Object.freeze({
          artifactId: artifactId(inputValue.artifactId),
          sourceNodeId: taskNodeId(inputValue.sourceNodeId),
        }),
      ),
    );
    const outputContract = outputRecordFromProposed(value, mode);
    return Object.freeze({
      id,
      parentNodeId,
      mode,
      objective,
      acceptanceCriteria,
      inputs,
      outputContract,
      allowedRepositoryPaths: snapshotRepositoryPaths(
        value.allowedRepositoryPaths,
        `node ${String(index)} allowed repository paths`,
      ),
    });
  });
  const ids = new Set<string>();
  const artifacts = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      throw new PlanRegistryError("invalid_plan", "proposed node IDs must be unique");
    }
    ids.add(node.id);
    if (node.outputContract.case === "artifact") {
      if (
        ids.has(node.outputContract.value.artifactId) ||
        artifacts.has(node.outputContract.value.artifactId)
      ) {
        throw new PlanRegistryError(
          "invalid_plan",
          "proposed node and artifact IDs must be unique",
        );
      }
      artifacts.add(node.outputContract.value.artifactId);
    }
    for (const input of node.inputs) {
      if (node.inputs.filter((candidate) => candidate.artifactId === input.artifactId).length > 1) {
        throw new PlanRegistryError("invalid_plan", "node artifact inputs must be unique");
      }
    }
  }
  return Object.freeze(nodes);
}

function outputRecordFromProposed(value: ProposedNode, mode: PlanNodeMode): TaskNodeOutputRecord {
  if (value.outputContract.case === "implementation") {
    if (mode !== PlanNodeMode.IMPLEMENTATION) {
      throw new PlanRegistryError(
        "invalid_plan",
        "only implementation mode may use implementation output",
      );
    }
    return Object.freeze({ case: "implementation", value: Object.freeze({}) });
  }
  if (value.outputContract.case === "artifact") {
    if (mode === PlanNodeMode.IMPLEMENTATION) {
      throw new PlanRegistryError(
        "invalid_plan",
        "implementation mode requires implementation output",
      );
    }
    return Object.freeze({
      case: "artifact",
      value: Object.freeze({
        artifactId: artifactId(value.outputContract.value.artifactId),
        artifactType: nonEmptyText(value.outputContract.value.artifactType, "artifact type"),
      }),
    });
  }
  throw new TypeError("node output contract is required");
}

function validateProposedPlan(
  current: TreeRecord,
  proposed: readonly ProposedNodeRecord[],
  goal: NonEmptyText,
  revisionId: PlanRevisionId,
): void {
  if (goal.length === 0) {
    throw new PlanRegistryError("invalid_plan", "plan goal must not be empty");
  }
  const existing = new Map<string, TaskNodeRecord>();
  const occupied = new Set<string>([current.id, current.repositoryId, current.hostId]);
  for (const revision of current.revisions) {
    occupied.add(revision.id);
  }
  for (const node of current.nodes) {
    existing.set(node.id, node);
    occupied.add(node.id);
    if (node.outputContract.case === "artifact") {
      occupied.add(node.outputContract.value.artifactId);
    }
  }
  if (occupied.has(revisionId)) {
    throw new PlanRegistryError("invalid_plan", "plan revision ID is already in use");
  }
  const proposedById = new Map<string, ProposedNodeRecord>();
  const proposedArtifacts = new Set<string>();
  for (const node of proposed) {
    if (occupied.has(node.id) || proposedById.has(node.id) || proposedArtifacts.has(node.id)) {
      throw new PlanRegistryError("invalid_plan", "proposed node ID is already in use");
    }
    proposedById.set(node.id, node);
    if (node.outputContract.case === "artifact") {
      const artifact = node.outputContract.value.artifactId;
      if (occupied.has(artifact) || proposedArtifacts.has(artifact) || proposedById.has(artifact)) {
        throw new PlanRegistryError("invalid_plan", "proposed artifact ID is already in use");
      }
      proposedArtifacts.add(artifact);
    }
  }
  if (proposedById.has(revisionId) || proposedArtifacts.has(revisionId)) {
    throw new PlanRegistryError(
      "invalid_plan",
      "plan revision ID is already used by a proposed node or artifact",
    );
  }
  const children = new Map<string, number>();
  const depthMemo = new Map<string, number>([[current.rootNodeId, 1]]);
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depthMemo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new PlanRegistryError("invalid_plan", "plan contains a cycle");
    visiting.add(id);
    const node = proposedById.get(id);
    if (node === undefined) {
      const existingNode = existing.get(id);
      if (existingNode === undefined)
        throw new PlanRegistryError("invalid_plan", "plan parent does not exist");
      if (id !== current.rootNodeId && !isStartedOrTerminal(existingNode.state)) {
        throw new PlanRegistryError(
          "invalid_plan",
          "existing plan parent must be started or terminal",
        );
      }
      if (existingNode.parentNodeId === undefined) {
        throw new PlanRegistryError("corrupt", "non-root node has no parent");
      }
      const depth = depthOf(existingNode.parentNodeId) + 1;
      depthMemo.set(id, depth);
      visiting.delete(id);
      return depth;
    }
    if (node.parentNodeId === undefined)
      throw new PlanRegistryError("invalid_plan", "every proposed node needs one parent");
    if (node.parentNodeId === node.id)
      throw new PlanRegistryError("invalid_plan", "a node cannot parent itself");
    const depth = depthOf(node.parentNodeId) + 1;
    depthMemo.set(id, depth);
    visiting.delete(id);
    return depth;
  };
  for (const node of proposed) {
    if (node.parentNodeId === undefined) {
      throw new PlanRegistryError("invalid_plan", "multiple roots are not allowed");
    }
    if (
      node.parentNodeId !== current.rootNodeId &&
      !proposedById.has(node.parentNodeId) &&
      !existing.has(node.parentNodeId)
    ) {
      throw new PlanRegistryError("invalid_plan", "proposed node parent does not exist");
    }
    const depth = depthOf(node.id);
    if (depth > current.budget.maxDepth) {
      throw new PlanRegistryError("invalid_plan", "plan exceeds max_depth");
    }
    const parent = node.parentNodeId;
    children.set(parent, (children.get(parent) ?? 0) + 1);
  }
  const retained = current.nodes.filter(
    (node) =>
      node.id === current.rootNodeId ||
      (node.state !== NodeState.PLANNED &&
        node.state !== NodeState.READY &&
        node.state !== NodeState.SUPERSEDED),
  );
  if (retained.length + proposed.length > current.budget.maxNodes) {
    throw new PlanRegistryError("invalid_plan", "plan exceeds max_nodes");
  }
  for (const [parent, count] of children) {
    const retainedChildren = retained.filter((node) => node.parentNodeId === parent).length;
    if (retainedChildren + count > current.budget.maxFanOut) {
      throw new PlanRegistryError("invalid_plan", "plan exceeds max_fan_out");
    }
  }
  for (const node of proposed) {
    for (const input of node.inputs) {
      const source = proposedById.get(input.sourceNodeId) ?? existing.get(input.sourceNodeId);
      if (source === undefined) {
        throw new PlanRegistryError(
          "invalid_plan",
          "artifact source node does not exist in this tree",
        );
      }
      if (
        source.outputContract.case !== "artifact" ||
        source.outputContract.value.artifactId !== input.artifactId
      ) {
        throw new PlanRegistryError(
          "invalid_plan",
          "artifact input does not match its source output",
        );
      }
      if (!isAncestor(node.id, input.sourceNodeId, proposedById, existing)) {
        throw new PlanRegistryError(
          "invalid_plan",
          "artifact inputs may only name the node or an ancestor",
        );
      }
    }
  }
}

function isAncestor(
  nodeId: string,
  sourceId: string,
  proposed: ReadonlyMap<string, ProposedNodeRecord>,
  existing: ReadonlyMap<string, TaskNodeRecord>,
): boolean {
  if (nodeId === sourceId) return true;
  let current = proposed.get(nodeId)?.parentNodeId ?? existing.get(nodeId)?.parentNodeId;
  const visited = new Set<string>();
  while (current !== undefined) {
    if (current === sourceId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = proposed.get(current)?.parentNodeId ?? existing.get(current)?.parentNodeId;
  }
  return false;
}

function isStartedOrTerminal(state: NodeState): boolean {
  return (
    state === NodeState.ACTIVE ||
    state === NodeState.BLOCKED ||
    state === NodeState.SUCCEEDED ||
    state === NodeState.FAILED ||
    state === NodeState.CANCELLED
  );
}

function readTreeRecord(reader: SqliteReader, treeId: TaskTreeId): TreeRecord {
  try {
    const treeRow = reader.get(
      `SELECT id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
              root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
         FROM trees WHERE id = ?`,
      [treeId],
    );
    if (treeRow === undefined) {
      throw new PlanRegistryError("not_found", "tree does not exist");
    }
    if (treeRow["archived_at_ms"] !== null) {
      throw new PlanRegistryError("not_found", "tree does not exist");
    }
    const id = taskTreeId(requiredString(treeRow, "id"));
    const repository = repositoryId(requiredString(treeRow, "repository_id"));
    const host = hostId(requiredString(treeRow, "host_id"));
    const baseCommit = gitSha(requiredString(treeRow, "base_commit"));
    const goal = nonEmptyText(requiredString(treeRow, "goal"), "tree goal");
    const activeRevisionId = planRevisionId(requiredString(treeRow, "active_plan_revision_id"));
    const rootNodeId = taskNodeId(requiredString(treeRow, "root_node_id"));
    const version = safeInteger(treeRow["version"], "tree version");
    const createdAt = safeTimestamp(treeRow["created_at_ms"], "tree created_at_ms");
    const updatedAt = safeTimestamp(treeRow["updated_at_ms"], "tree updated_at_ms");
    if (id !== treeId || updatedAt < createdAt)
      throw new TypeError("tree identity or timestamps are invalid");
    const repositoryRow = reader.get(
      `SELECT rr.repository_id, rr.host_id, rr.base_commit, rr.registered_at_ms,
              r.id AS projection_id, r.host_id AS projection_host_id,
              r.version AS projection_version, r.archived_at_ms AS projection_archived_at_ms
         FROM repository_registrations AS rr
         JOIN repositories AS r ON r.id = rr.repository_id
        WHERE rr.repository_id = ?`,
      [repository],
    );
    if (repositoryRow === undefined) throw new TypeError("tree repository registration is missing");
    const registeredAt = safeTimestamp(
      repositoryRow["registered_at_ms"],
      "repository registered_at_ms",
    );
    if (
      requiredString(repositoryRow, "projection_id") !== repository ||
      requiredString(repositoryRow, "projection_host_id") !== host ||
      requiredString(repositoryRow, "host_id") !== host ||
      gitSha(requiredString(repositoryRow, "base_commit")) !== baseCommit ||
      safeInteger(repositoryRow["projection_version"], "projection_version") < 0 ||
      repositoryRow["projection_archived_at_ms"] !== null ||
      createdAt < registeredAt
    ) {
      throw new TypeError("tree repository binding is corrupt");
    }
    const revisionRows = reader.all(
      `SELECT id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
              approved_at_ms, superseded_at_ms
         FROM plan_revisions WHERE tree_id = ? ORDER BY ordinal`,
      [id],
    );
    const revisions = revisionRows.map((row) => revisionFromRow(row, id));
    if (
      revisions.length === 0 ||
      revisions.some((revision, index) => revision.ordinal !== index + 1)
    ) {
      throw new TypeError("plan revision ordinals are not contiguous");
    }
    const activeRevision = revisions.find((revision) => revision.id === activeRevisionId);
    if (
      activeRevision === undefined ||
      activeRevision.state === PlanRevisionState.SUPERSEDED ||
      activeRevision.goal !== goal
    ) {
      throw new TypeError("active plan revision is invalid");
    }
    const nodeRows = reader.all(
      `SELECT id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
              mode, objective, output_kind, output_artifact_id, output_artifact_type,
              state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
              blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
              outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
              outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
              version, created_at_ms, updated_at_ms
         FROM nodes WHERE tree_id = ? ORDER BY created_at_ms, rowid`,
      [id],
    );
    const criteriaRows = reader.all(
      `SELECT node_id, ordinal, criterion FROM node_acceptance_criteria
        WHERE node_id IN (SELECT id FROM nodes WHERE tree_id = ?)
        ORDER BY node_id, ordinal`,
      [id],
    );
    const criteria = new Map<string, NonEmptyText[]>();
    for (const row of criteriaRows) {
      const nodeId = requiredString(row, "node_id");
      const ordinal = safeInteger(row["ordinal"], "acceptance ordinal");
      const values = criteria.get(nodeId) ?? [];
      if (ordinal !== values.length)
        throw new TypeError("acceptance criteria ordinals are not contiguous");
      values.push(nonEmptyText(requiredString(row, "criterion"), "acceptance criterion"));
      criteria.set(nodeId, values);
    }
    const inputRows = reader.all(
      `SELECT node_id, ordinal, artifact_id, source_node_id
         FROM node_artifact_inputs
        WHERE node_id IN (SELECT id FROM nodes WHERE tree_id = ?)
        ORDER BY node_id, ordinal`,
      [id],
    );
    const inputs = new Map<string, ArtifactInputRecord[]>();
    for (const row of inputRows) {
      const nodeId = requiredString(row, "node_id");
      const ordinal = safeInteger(row["ordinal"], "artifact input ordinal");
      const values = inputs.get(nodeId) ?? [];
      if (ordinal !== values.length)
        throw new TypeError("artifact input ordinals are not contiguous");
      values.push(
        Object.freeze({
          artifactId: artifactId(requiredString(row, "artifact_id")),
          sourceNodeId: taskNodeId(requiredString(row, "source_node_id")),
        }),
      );
      inputs.set(nodeId, values);
    }
    const budgetRows = reader.all(
      `SELECT tree_id, max_depth, max_fan_out, max_nodes, max_concurrency, max_attempts_per_node
         FROM tree_budgets WHERE tree_id = ?`,
      [id],
    );
    if (budgetRows.length !== 1) throw new TypeError("tree budget is missing or duplicated");
    const budget = budgetFromRow(budgetRows[0]);
    const scopeRows = reader.all(
      `SELECT node_id, ordinal, repository_path
         FROM node_repository_scope
        WHERE node_id IN (SELECT id FROM nodes WHERE tree_id = ?)
        ORDER BY node_id, ordinal`,
      [id],
    );
    const scopes = new Map<string, NonEmptyText[]>();
    for (const row of scopeRows) {
      const nodeId = requiredString(row, "node_id");
      const ordinal = safeInteger(row["ordinal"], "repository scope ordinal");
      const values = scopes.get(nodeId) ?? [];
      if (ordinal !== values.length) {
        throw new TypeError("repository scope ordinals are not contiguous");
      }
      values.push(repositoryPath(requiredString(row, "repository_path"), "repository path"));
      scopes.set(nodeId, values);
    }
    const policyRows = reader.all(
      `SELECT node_id, max_attempts
         FROM node_plan_policies
        WHERE node_id IN (SELECT id FROM nodes WHERE tree_id = ?)
        ORDER BY node_id`,
      [id],
    );
    const policies = new Map<string, NodePolicyRecord>();
    for (const row of policyRows) {
      const nodeId = requiredString(row, "node_id");
      if (policies.has(nodeId)) throw new TypeError("node plan policy is duplicated");
      const maxAttempts = safePositiveInteger(row["max_attempts"], "node max_attempts");
      if (maxAttempts !== budget.maxAttemptsPerNode) {
        throw new TypeError("node max_attempts differs from tree budget");
      }
      policies.set(
        nodeId,
        Object.freeze({
          maxAttempts,
        }),
      );
    }
    if (policies.size !== nodeRows.length) {
      throw new TypeError("node plan policies are missing");
    }
    const nodes = nodeRows.map((row) =>
      nodeFromRow(row, id, repository, host, revisions, criteria, inputs, scopes, policies),
    );
    const attentionRows = reader.all(
      `SELECT id, tree_id, plan_revision_id, kind, message, state_kind, created_at_ms, resolved_at_ms
         FROM plan_attentions WHERE tree_id = ? ORDER BY created_at_ms, id`,
      [id],
    );
    const attentions = attentionRows.map((row) => attentionFromRow(row, id, revisions));
    const open = attentions.filter((attention) => attention.state === PlanAttentionState.OPEN);
    if (open.length > 1) throw new TypeError("tree has multiple open attentions");
    const record = Object.freeze({
      id,
      repositoryId: repository,
      hostId: host,
      baseCommit,
      goal,
      activePlanRevisionId: activeRevisionId,
      rootNodeId,
      state:
        activeRevision.state === PlanRevisionState.DRAFT ? TreeState.DRAFT : TreeState.APPROVED,
      version,
      createdAt,
      updatedAt,
      revisions: Object.freeze(revisions),
      nodes: Object.freeze(nodes),
      budget,
      ...(open[0] === undefined ? {} : { attention: open[0] }),
    });
    validateTreeRecord(record);
    return record;
  } catch (error) {
    if (error instanceof PlanRegistryError) throw error;
    throw new PlanRegistryError("corrupt", "tree data is corrupt", { cause: error });
  }
}

function revisionFromRow(row: SqliteRow, treeId: TaskTreeId): PlanRevisionRecord {
  const id = planRevisionId(requiredString(row, "id"));
  if (taskTreeId(requiredString(row, "tree_id")) !== treeId)
    throw new TypeError("plan revision tree binding is invalid");
  const ordinal = safePositiveInteger(row["ordinal"], "plan revision ordinal");
  const goal = nonEmptyText(requiredString(row, "goal"), "plan revision goal");
  const state = revisionStateFromKind(requiredString(row, "state_kind"));
  const version = safeInteger(row["version"], "plan revision version");
  const createdAt = safeTimestamp(row["created_at_ms"], "plan revision created_at_ms");
  const approvedAt = nullableTimestamp(row["approved_at_ms"], "plan revision approved_at_ms");
  const supersededAt = nullableTimestamp(row["superseded_at_ms"], "plan revision superseded_at_ms");
  if (state === PlanRevisionState.DRAFT && (approvedAt !== undefined || supersededAt !== undefined))
    throw new TypeError("draft revision timestamps are invalid");
  if (
    state === PlanRevisionState.APPROVED &&
    (approvedAt === undefined || supersededAt !== undefined || approvedAt < createdAt)
  )
    throw new TypeError("approved revision timestamps are invalid");
  if (
    state === PlanRevisionState.SUPERSEDED &&
    (approvedAt === undefined ||
      supersededAt === undefined ||
      approvedAt < createdAt ||
      supersededAt < approvedAt)
  )
    throw new TypeError("superseded revision timestamps are invalid");
  return Object.freeze({
    id,
    treeId,
    ordinal,
    goal,
    state,
    version,
    createdAt,
    ...(approvedAt === undefined ? {} : { approvedAt }),
    ...(supersededAt === undefined ? {} : { supersededAt }),
  });
}

function nodeFromRow(
  row: SqliteRow,
  treeId: TaskTreeId,
  repositoryIdValue: RepositoryId,
  hostIdValue: HostId,
  revisions: readonly PlanRevisionRecord[],
  criteria: ReadonlyMap<string, readonly NonEmptyText[]>,
  inputs: ReadonlyMap<string, readonly ArtifactInputRecord[]>,
  scopes: ReadonlyMap<string, readonly NonEmptyText[]>,
  policies: ReadonlyMap<string, NodePolicyRecord>,
): TaskNodeRecord {
  const id = taskNodeId(requiredString(row, "id"));
  if (
    taskTreeId(requiredString(row, "tree_id")) !== treeId ||
    repositoryId(requiredString(row, "repository_id")) !== repositoryIdValue ||
    hostId(requiredString(row, "host_id")) !== hostIdValue
  )
    throw new TypeError("node binding is invalid");
  const parentNodeId = nullableNodeId(row["parent_node_id"], "parent_node_id");
  const revisionId = planRevisionId(requiredString(row, "plan_revision_id"));
  if (!revisions.some((revision) => revision.id === revisionId))
    throw new TypeError("node plan revision is unknown");
  const mode = modeFromKind(requiredString(row, "mode"));
  const objective = nonEmptyText(requiredString(row, "objective"), "node objective");
  const output = outputFromRow(row, mode);
  const state = nodeStateFromKind(requiredString(row, "state_kind"));
  validateNodeAuxiliaryState(row, state, revisions);
  const version = safeInteger(row["version"], "node version");
  const createdAt = safeTimestamp(row["created_at_ms"], "node created_at_ms");
  const updatedAt = safeTimestamp(row["updated_at_ms"], "node updated_at_ms");
  if (updatedAt < createdAt) throw new TypeError("node timestamps are invalid");
  const nodeCriteria = criteria.get(id);
  if (nodeCriteria === undefined || nodeCriteria.length < 1)
    throw new TypeError("node acceptance criteria are missing");
  const nodeScope = scopes.get(id);
  if (nodeScope === undefined || nodeScope.length < 1)
    throw new TypeError("node repository scope is missing");
  const nodePolicy = policies.get(id);
  if (nodePolicy === undefined) throw new TypeError("node plan policy is missing");
  const nodeInputs = inputs.get(id) ?? [];
  return Object.freeze({
    id,
    treeId,
    repositoryId: repositoryIdValue,
    hostId: hostIdValue,
    ...(parentNodeId === undefined ? {} : { parentNodeId }),
    planRevisionId: revisionId,
    mode,
    objective,
    acceptanceCriteria: Object.freeze([...nodeCriteria]),
    inputs: Object.freeze([...nodeInputs]),
    outputContract: output,
    allowedRepositoryPaths: Object.freeze([...nodeScope]),
    budget: Object.freeze({ maxAttempts: nodePolicy.maxAttempts }),
    state,
    version,
    createdAt,
    updatedAt,
  });
}

function outputFromRow(row: SqliteRow, mode: PlanNodeMode): TaskNodeOutputRecord {
  const kind = requiredString(row, "output_kind");
  if (kind === "implementation") {
    if (
      mode !== PlanNodeMode.IMPLEMENTATION ||
      row["output_artifact_id"] !== null ||
      row["output_artifact_type"] !== null
    )
      throw new TypeError("implementation output contract is invalid");
    return Object.freeze({ case: "implementation", value: Object.freeze({}) });
  }
  if (kind === "artifact") {
    if (mode === PlanNodeMode.IMPLEMENTATION)
      throw new TypeError("implementation node has artifact output");
    const outputArtifactId = artifactId(requiredString(row, "output_artifact_id"));
    const outputArtifactType = nonEmptyText(
      requiredString(row, "output_artifact_type"),
      "artifact output type",
    );
    return Object.freeze({
      case: "artifact",
      value: Object.freeze({ artifactId: outputArtifactId, artifactType: outputArtifactType }),
    });
  }
  throw new TypeError("node output kind is invalid");
}

function validateNodeAuxiliaryState(
  row: SqliteRow,
  state: NodeState,
  revisions: readonly PlanRevisionRecord[],
): void {
  const resume = nullableKind(row["resume_state_kind"]);
  const blocker = nullableKind(row["blocker_kind"]);
  const blockerEvidence = nullableString(row["blocker_evidence_id"], "blocker_evidence_id");
  const blockerParent = nullableString(row["blocker_parent_node_id"], "blocker_parent_node_id");
  const blockerHost = nullableString(row["blocker_host_id"], "blocker_host_id");
  const outcome = nullableKind(row["outcome_kind"]);
  const outcomeArtifact = nullableString(row["outcome_artifact_id"], "outcome_artifact_id");
  const outcomeHash = nullableString(row["outcome_content_hash"], "outcome_content_hash");
  const outcomeType = nullableString(row["outcome_artifact_type"], "outcome_artifact_type");
  const outcomeCommit = nullableString(row["outcome_commit"], "outcome_commit");
  const outcomeEvidence = nullableString(row["outcome_evidence_id"], "outcome_evidence_id");
  const explanation = nullableString(row["outcome_explanation"], "outcome_explanation");
  const terminal = nullableString(row["terminal_evidence_id"], "terminal_evidence_id");
  const superseded = nullableString(
    row["superseded_plan_revision_id"],
    "superseded_plan_revision_id",
  );
  if (
    blocker !== undefined &&
    blocker !== "authentication" &&
    blocker !== "ci_failure" &&
    blocker !== "conflict" &&
    blocker !== "gate_failure" &&
    blocker !== "human_input" &&
    blocker !== "parent" &&
    blocker !== "quota" &&
    blocker !== "unavailable_host"
  ) {
    throw new TypeError("blocker kind is invalid");
  }
  if (
    outcome !== undefined &&
    outcome !== "artifact" &&
    outcome !== "commit" &&
    outcome !== "no_change"
  ) {
    throw new TypeError("outcome kind is invalid");
  }
  for (const [value, parse] of [
    [blockerEvidence, evidenceId],
    [outcomeEvidence, evidenceId],
    [terminal, evidenceId],
  ] as const) {
    if (value !== undefined) parse(value);
  }
  if (blockerParent !== undefined) taskNodeId(blockerParent);
  if (blockerHost !== undefined) hostId(blockerHost);
  if (outcomeArtifact !== undefined) artifactId(outcomeArtifact);
  if (outcomeHash !== undefined) contentHash(outcomeHash);
  if (outcomeType !== undefined) nonEmptyText(outcomeType, "outcome artifact type");
  if (outcomeCommit !== undefined) gitSha(outcomeCommit);
  if (explanation !== undefined) nonEmptyText(explanation, "outcome explanation");
  if (superseded !== undefined) planRevisionId(superseded);
  if (state === NodeState.BLOCKED) {
    if (
      (resume !== "ready" && resume !== "active") ||
      blocker === undefined ||
      blockerEvidence === undefined
    )
      throw new TypeError("blocked node state is incomplete");
    if (
      blocker === "parent"
        ? blockerParent === undefined || blockerHost !== undefined
        : blockerParent !== undefined
    )
      throw new TypeError("parent blocker is invalid");
    if (
      blocker === "unavailable_host"
        ? blockerHost === undefined || blockerParent !== undefined
        : blockerHost !== undefined
    )
      throw new TypeError("host blocker is invalid");
    if (outcome !== undefined || terminal !== undefined || superseded !== undefined)
      throw new TypeError("blocked node has terminal state data");
    return;
  }
  if (
    resume !== undefined ||
    blocker !== undefined ||
    blockerEvidence !== undefined ||
    blockerParent !== undefined ||
    blockerHost !== undefined
  )
    throw new TypeError("non-blocked node has blocker state data");
  if (state === NodeState.SUCCEEDED) {
    if (outcome === undefined || outcomeEvidence === undefined)
      throw new TypeError("succeeded node outcome is incomplete");
    if (
      outcome === "artifact" &&
      (outcomeArtifact === undefined ||
        outcomeHash === undefined ||
        outcomeType === undefined ||
        outcomeCommit !== undefined ||
        explanation !== undefined)
    )
      throw new TypeError("artifact outcome is invalid");
    if (
      outcome === "commit" &&
      (outcomeCommit === undefined ||
        outcomeArtifact !== undefined ||
        outcomeHash !== undefined ||
        outcomeType !== undefined ||
        explanation !== undefined)
    )
      throw new TypeError("commit outcome is invalid");
    if (
      outcome === "no_change" &&
      (explanation === undefined ||
        outcomeArtifact !== undefined ||
        outcomeHash !== undefined ||
        outcomeType !== undefined ||
        outcomeCommit !== undefined)
    )
      throw new TypeError("no-change outcome is invalid");
    if (terminal !== undefined || superseded !== undefined)
      throw new TypeError("succeeded node has invalid terminal data");
    return;
  }
  if (state === NodeState.FAILED || state === NodeState.CANCELLED) {
    if (
      terminal === undefined ||
      outcome !== undefined ||
      outcomeArtifact !== undefined ||
      outcomeHash !== undefined ||
      outcomeType !== undefined ||
      outcomeCommit !== undefined ||
      outcomeEvidence !== undefined ||
      explanation !== undefined ||
      superseded !== undefined
    )
      throw new TypeError("failed or cancelled node state is invalid");
    return;
  }
  if (state === NodeState.SUPERSEDED) {
    if (
      superseded === undefined ||
      !revisions.some((revision) => revision.id === superseded) ||
      terminal !== undefined ||
      outcome !== undefined ||
      outcomeArtifact !== undefined ||
      outcomeHash !== undefined ||
      outcomeType !== undefined ||
      outcomeCommit !== undefined ||
      outcomeEvidence !== undefined ||
      explanation !== undefined
    )
      throw new TypeError("superseded node state is invalid");
    return;
  }
  if (
    outcome !== undefined ||
    outcomeArtifact !== undefined ||
    outcomeHash !== undefined ||
    outcomeType !== undefined ||
    outcomeCommit !== undefined ||
    outcomeEvidence !== undefined ||
    explanation !== undefined ||
    terminal !== undefined ||
    superseded !== undefined
  )
    throw new TypeError("runnable node has terminal state data");
}

function budgetFromRow(row: SqliteRow | undefined): TreeBudgetRecord {
  if (row === undefined) throw new TypeError("tree budget row is missing");
  return snapshotBudget({
    maxDepth: safeInteger(row["max_depth"], "max_depth"),
    maxFanOut: safeInteger(row["max_fan_out"], "max_fan_out"),
    maxNodes: safeInteger(row["max_nodes"], "max_nodes"),
    maxConcurrency: safeInteger(row["max_concurrency"], "max_concurrency"),
    maxAttemptsPerNode: safeInteger(row["max_attempts_per_node"], "max_attempts_per_node"),
  });
}

function attentionFromRow(
  row: SqliteRow,
  treeId: TaskTreeId,
  revisions: readonly PlanRevisionRecord[],
): PlanAttentionRecord {
  const id = parseUuid(requiredString(row, "id"), "attention ID");
  if (taskTreeId(requiredString(row, "tree_id")) !== treeId)
    throw new TypeError("attention tree binding is invalid");
  const revisionValue = nullableString(row["plan_revision_id"], "plan_revision_id");
  const revision = revisionValue === undefined ? undefined : planRevisionId(revisionValue);
  if (revision !== undefined && !revisions.some((candidate) => candidate.id === revision))
    throw new TypeError("attention plan revision is unknown");
  const kind = attentionKindFromKind(requiredString(row, "kind"));
  const message = nonEmptyText(requiredString(row, "message"), "attention message");
  const state = attentionStateFromKind(requiredString(row, "state_kind"));
  const createdAt = safeTimestamp(row["created_at_ms"], "attention created_at_ms");
  const resolvedAt = nullableTimestamp(row["resolved_at_ms"], "attention resolved_at_ms");
  if (
    (state === PlanAttentionState.OPEN && resolvedAt !== undefined) ||
    (state === PlanAttentionState.RESOLVED && (resolvedAt === undefined || resolvedAt < createdAt))
  )
    throw new TypeError("attention timestamps are invalid");
  return Object.freeze({
    id,
    treeId,
    ...(revision === undefined ? {} : { planRevisionId: revision }),
    kind,
    message,
    state,
    createdAt,
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
  });
}

function validateTreeRecord(tree: TreeRecord): void {
  if (tree.revisions.length === 0 || tree.nodes.length === 0)
    throw new TypeError("tree aggregate is incomplete");
  if (tree.createdAt > tree.updatedAt) throw new TypeError("tree timestamps are invalid");
  for (const revision of tree.revisions) {
    if (revision.treeId !== tree.id || revision.createdAt > tree.updatedAt)
      throw new TypeError("plan revision binding or timestamp is invalid");
    if (
      revision.state === PlanRevisionState.DRAFT &&
      (revision.approvedAt !== undefined || revision.supersededAt !== undefined)
    )
      throw new TypeError("draft revision timestamps are invalid");
    if (
      revision.state === PlanRevisionState.APPROVED &&
      (revision.approvedAt === undefined ||
        revision.supersededAt !== undefined ||
        revision.approvedAt < revision.createdAt)
    )
      throw new TypeError("approved revision timestamps are invalid");
    if (
      revision.state === PlanRevisionState.SUPERSEDED &&
      (revision.approvedAt === undefined ||
        revision.supersededAt === undefined ||
        revision.approvedAt < revision.createdAt ||
        revision.supersededAt < revision.approvedAt)
    )
      throw new TypeError("superseded revision timestamps are invalid");
  }
  if (
    tree.attention !== undefined &&
    (tree.attention.treeId !== tree.id ||
      tree.attention.state !== PlanAttentionState.OPEN ||
      tree.attention.resolvedAt !== undefined ||
      tree.attention.createdAt > tree.updatedAt ||
      (tree.attention.planRevisionId !== undefined &&
        !tree.revisions.some((revision) => revision.id === tree.attention?.planRevisionId)))
  ) {
    throw new TypeError("tree attention is invalid");
  }
  if (tree.revisions.some((revision, index) => revision.ordinal !== index + 1))
    throw new TypeError("tree revision ordinals are invalid");
  const active = tree.revisions.find((revision) => revision.id === tree.activePlanRevisionId);
  if (
    active === undefined ||
    active.state === PlanRevisionState.SUPERSEDED ||
    active.goal !== tree.goal
  )
    throw new TypeError("tree active revision is invalid");
  if (
    tree.state !== (active.state === PlanRevisionState.DRAFT ? TreeState.DRAFT : TreeState.APPROVED)
  )
    throw new TypeError("tree state is not derived from active revision");
  const nodeById = new Map<string, TaskNodeRecord>();
  const artifacts = new Map<string, TaskNodeRecord>();
  let roots = 0;
  for (const node of tree.nodes) {
    if (
      node.treeId !== tree.id ||
      node.repositoryId !== tree.repositoryId ||
      node.hostId !== tree.hostId
    )
      throw new TypeError("node binding does not match tree");
    if (!tree.revisions.some((revision) => revision.id === node.planRevisionId))
      throw new TypeError("node plan revision is unknown");
    if (
      node.acceptanceCriteria.length < 1 ||
      node.acceptanceCriteria.some((criterion) => criterion.length === 0)
    )
      throw new TypeError("node acceptance criteria are invalid");
    snapshotRepositoryPaths(node.allowedRepositoryPaths, "node allowed repository paths");
    if (
      !Number.isSafeInteger(node.budget.maxAttempts) ||
      node.budget.maxAttempts < 1 ||
      node.budget.maxAttempts !== tree.budget.maxAttemptsPerNode
    ) {
      throw new TypeError("node budget differs from tree budget");
    }
    if (node.createdAt > node.updatedAt) throw new TypeError("node timestamps are invalid");
    if (nodeById.has(node.id)) throw new TypeError("tree contains duplicate node IDs");
    nodeById.set(node.id, node);
    if (node.parentNodeId === undefined) roots += 1;
    if (node.outputContract.case === "artifact") {
      if (artifacts.has(node.outputContract.value.artifactId))
        throw new TypeError("tree contains duplicate artifact IDs");
      artifacts.set(node.outputContract.value.artifactId, node);
    }
    if (
      active.state === PlanRevisionState.DRAFT &&
      node.planRevisionId === active.id &&
      node.state === NodeState.READY
    )
      throw new TypeError("draft plan contains a ready node");
  }
  const identityIds = [
    tree.id,
    tree.repositoryId,
    tree.hostId,
    ...tree.revisions.map((revision) => revision.id),
    ...tree.nodes.flatMap((node) => [
      node.id,
      ...(node.outputContract.case === "artifact" ? [node.outputContract.value.artifactId] : []),
    ]),
    ...(tree.attention === undefined ? [] : [tree.attention.id]),
  ];
  if (new Set(identityIds).size !== identityIds.length)
    throw new TypeError("tree aggregate IDs are not distinct");
  const root = nodeById.get(tree.rootNodeId);
  if (
    root === undefined ||
    root.parentNodeId !== undefined ||
    roots !== 1 ||
    root.mode !== PlanNodeMode.PLAN ||
    root.state !== NodeState.PLANNED ||
    root.outputContract.case !== "artifact" ||
    root.outputContract.value.artifactType !== "plan"
  )
    throw new TypeError("tree structural root is invalid");
  for (const node of tree.nodes) {
    if (node.parentNodeId !== undefined && !nodeById.has(node.parentNodeId))
      throw new TypeError("node parent is unknown");
    if (node.parentNodeId === node.id) throw new TypeError("node cannot parent itself");
    if (node.inputs.length > 0) {
      for (const input of node.inputs) {
        const source = nodeById.get(input.sourceNodeId);
        if (
          source?.outputContract.case !== "artifact" ||
          source.outputContract.value.artifactId !== input.artifactId
        )
          throw new TypeError("node artifact input is invalid");
        if (!isAncestorRecord(node, input.sourceNodeId, nodeById))
          throw new TypeError("node artifact input is not from the node or an ancestor");
      }
    }
  }
  const retained = tree.nodes.filter((node) => node.state !== NodeState.SUPERSEDED);
  if (retained.length > tree.budget.maxNodes)
    throw new TypeError("tree exceeds persisted max_nodes budget");
  const depthMemo = new Map<string, number>([[tree.rootNodeId, 1]]);
  const visiting = new Set<string>();
  const depthOf = (node: TaskNodeRecord): number => {
    const known = depthMemo.get(node.id);
    if (known !== undefined) return known;
    if (visiting.has(node.id)) throw new TypeError("tree contains a parent cycle");
    visiting.add(node.id);
    if (node.parentNodeId === undefined) throw new TypeError("node is detached from root");
    const parent = nodeById.get(node.parentNodeId);
    if (parent === undefined) throw new TypeError("node parent is missing");
    const depth = depthOf(parent) + 1;
    depthMemo.set(node.id, depth);
    visiting.delete(node.id);
    return depth;
  };
  const fanout = new Map<string, number>();
  for (const node of retained) {
    const depth = depthOf(node);
    if (depth > tree.budget.maxDepth)
      throw new TypeError("tree exceeds persisted max_depth budget");
    if (node.parentNodeId !== undefined)
      fanout.set(node.parentNodeId, (fanout.get(node.parentNodeId) ?? 0) + 1);
  }
  for (const count of fanout.values())
    if (count > tree.budget.maxFanOut)
      throw new TypeError("tree exceeds persisted max_fan_out budget");
}

function isAncestorRecord(
  node: TaskNodeRecord,
  sourceId: string,
  nodes: ReadonlyMap<string, TaskNodeRecord>,
): boolean {
  if (node.id === sourceId) return true;
  let parent = node.parentNodeId;
  const seen = new Set<string>();
  while (parent !== undefined) {
    if (parent === sourceId) return true;
    if (seen.has(parent)) return false;
    seen.add(parent);
    parent = nodes.get(parent)?.parentNodeId;
  }
  return false;
}

function treeFromMessage(value: unknown): TreeRecord {
  try {
    if (typeof value !== "object" || value === null) throw new TypeError("tree message is missing");
    const message = value as {
      id: string;
      repositoryId: string;
      hostId: string;
      baseCommit: string;
      goal: string;
      activePlanRevisionId: string;
      rootNodeId: string;
      state: unknown;
      version: bigint;
      createdAt?: unknown;
      updatedAt?: unknown;
      revisions: readonly unknown[];
      nodes: readonly unknown[];
      budget?: unknown;
      attention?: unknown;
    };
    if (!Array.isArray(message.revisions) || !Array.isArray(message.nodes))
      throw new TypeError("tree message collections are invalid");
    const revisions = message.revisions.map((revision) => revisionFromMessage(revision));
    const nodes = message.nodes.map((node) => nodeFromMessage(node));
    const budget = budgetFromMessage(message.budget);
    const attention =
      message.attention === undefined ? undefined : attentionFromMessage(message.attention);
    const tree = Object.freeze({
      id: taskTreeId(message.id),
      repositoryId: repositoryId(message.repositoryId),
      hostId: hostId(message.hostId),
      baseCommit: gitSha(message.baseCommit),
      goal: nonEmptyText(message.goal, "tree goal"),
      activePlanRevisionId: planRevisionId(message.activePlanRevisionId),
      rootNodeId: taskNodeId(message.rootNodeId),
      state: treeStateFromValue(message.state),
      version: safeBigIntNumber(message.version, "tree version"),
      createdAt: timestampFromMessage(message.createdAt, "tree created_at"),
      updatedAt: timestampFromMessage(message.updatedAt, "tree updated_at"),
      revisions: Object.freeze(revisions),
      nodes: Object.freeze(nodes),
      budget,
      ...(attention === undefined ? {} : { attention }),
    });
    validateTreeRecord(tree);
    return tree;
  } catch (error) {
    if (error instanceof PlanRegistryError) throw error;
    throw new PlanRegistryError("corrupt", "task tree result is semantically invalid", {
      cause: error,
    });
  }
}

function revisionFromMessage(value: unknown): PlanRevisionRecord {
  const message = assertObject(value, "plan revision");
  const approvedAt = optionalTimestampProperty(message, "approvedAt");
  const supersededAt = optionalTimestampProperty(message, "supersededAt");
  return revisionFromParts(message, approvedAt, supersededAt);
}

function revisionFromParts(
  message: Readonly<Record<string, unknown>>,
  approvedAt: Timestamp | undefined,
  supersededAt: Timestamp | undefined,
): PlanRevisionRecord {
  return Object.freeze({
    id: planRevisionId(requiredObjectString(message, "id")),
    treeId: taskTreeId(requiredObjectString(message, "treeId")),
    ordinal: safeBigIntNumber(requiredObjectBigInt(message, "ordinal"), "plan revision ordinal"),
    goal: nonEmptyText(requiredObjectString(message, "goal"), "plan revision goal"),
    state: revisionStateFromValue(message["state"]),
    version: safeBigIntNumber(requiredObjectBigInt(message, "version"), "plan revision version"),
    createdAt: timestampFromMessage(message["createdAt"], "plan revision created_at"),
    ...(approvedAt === undefined ? {} : { approvedAt }),
    ...(supersededAt === undefined ? {} : { supersededAt }),
  });
}

function nodeFromMessage(value: unknown): TaskNodeRecord {
  const message = assertObject(value, "task node");
  const parent = optionalStringProperty(message, "parentNodeId");
  const inputsValue = message["inputs"];
  const criteriaValue = message["acceptanceCriteria"];
  const pathsValue = message["allowedRepositoryPaths"];
  if (!Array.isArray(inputsValue) || !Array.isArray(criteriaValue) || !Array.isArray(pathsValue)) {
    throw new TypeError("task node collections are invalid");
  }
  const output = outputFromMessage(message["outputContract"], parsePlanNodeMode(message["mode"]));
  return Object.freeze({
    id: taskNodeId(requiredObjectString(message, "id")),
    treeId: taskTreeId(requiredObjectString(message, "treeId")),
    repositoryId: repositoryId(requiredObjectString(message, "repositoryId")),
    hostId: hostId(requiredObjectString(message, "hostId")),
    ...(parent === undefined ? {} : { parentNodeId: taskNodeId(parent) }),
    planRevisionId: planRevisionId(requiredObjectString(message, "planRevisionId")),
    mode: parsePlanNodeMode(message["mode"]),
    objective: nonEmptyText(requiredObjectString(message, "objective"), "node objective"),
    acceptanceCriteria: Object.freeze(
      criteriaValue.map((criterion) =>
        nonEmptyText(assertString(criterion, "acceptance criterion"), "acceptance criterion"),
      ),
    ),
    inputs: Object.freeze(inputsValue.map((input) => artifactInputFromMessage(input))),
    outputContract: output,
    allowedRepositoryPaths: snapshotRepositoryPaths(
      pathsValue.map((path) => assertString(path, "repository path")),
      "node allowed repository paths",
    ),
    budget: nodeBudgetFromMessage(message["budget"]),
    state: nodeStateFromValue(message["state"]),
    version: safeBigIntNumber(requiredObjectBigInt(message, "version"), "node version"),
    createdAt: timestampFromMessage(message["createdAt"], "node created_at"),
    updatedAt: timestampFromMessage(message["updatedAt"], "node updated_at"),
  });
}

function artifactInputFromMessage(value: unknown): ArtifactInputRecord {
  const message = assertObject(value, "artifact input");
  return Object.freeze({
    artifactId: artifactId(requiredObjectString(message, "artifactId")),
    sourceNodeId: taskNodeId(requiredObjectString(message, "sourceNodeId")),
  });
}

function outputFromMessage(value: unknown, mode: PlanNodeMode): TaskNodeOutputRecord {
  const message = assertObject(value, "node output contract");
  const caseValue = message["case"];
  if (caseValue === "implementation") {
    if (mode !== PlanNodeMode.IMPLEMENTATION)
      throw new TypeError("implementation output mode is invalid");
    return Object.freeze({ case: "implementation", value: Object.freeze({}) });
  }
  if (caseValue === "artifact") {
    if (mode === PlanNodeMode.IMPLEMENTATION)
      throw new TypeError("artifact output mode is invalid");
    const artifact = assertObject(message["value"], "artifact output");
    return Object.freeze({
      case: "artifact",
      value: Object.freeze({
        artifactId: artifactId(requiredObjectString(artifact, "artifactId")),
        artifactType: nonEmptyText(requiredObjectString(artifact, "artifactType"), "artifact type"),
      }),
    });
  }
  throw new TypeError("node output contract is invalid");
}

function nodeBudgetFromMessage(value: unknown): NodeBudgetRecord {
  const message = assertObject(value, "node budget");
  return Object.freeze({
    maxAttempts: safePositiveInteger(safeNumberProperty(message, "maxAttempts"), "max_attempts"),
  });
}

function budgetFromMessage(value: unknown): TreeBudgetRecord {
  const message = assertObject(value, "tree budget");
  return snapshotBudget({
    maxDepth: safeNumberProperty(message, "maxDepth"),
    maxFanOut: safeNumberProperty(message, "maxFanOut"),
    maxNodes: safeNumberProperty(message, "maxNodes"),
    maxConcurrency: safeNumberProperty(message, "maxConcurrency"),
    maxAttemptsPerNode: safeNumberProperty(message, "maxAttemptsPerNode"),
  });
}

function attentionFromMessage(value: unknown): PlanAttentionRecord {
  const message = assertObject(value, "plan attention");
  const planRevision = optionalStringProperty(message, "planRevisionId");
  const resolved = optionalTimestampProperty(message, "resolvedAt");
  return Object.freeze({
    id: parseUuid(requiredObjectString(message, "id"), "attention ID"),
    treeId: taskTreeId(requiredObjectString(message, "treeId")),
    ...(planRevision === undefined ? {} : { planRevisionId: planRevisionId(planRevision) }),
    kind: attentionKindFromValue(message["kind"]),
    message: nonEmptyText(requiredObjectString(message, "message"), "attention message"),
    state: attentionStateFromValue(message["state"]),
    createdAt: timestampFromMessage(message["createdAt"], "attention created_at"),
    ...(resolved === undefined ? {} : { resolvedAt: resolved }),
  });
}

function assertResultVersion(tree: TreeRecord, aggregateVersion: number): void {
  if (
    !Number.isSafeInteger(aggregateVersion) ||
    aggregateVersion < 1 ||
    tree.version + 1 !== aggregateVersion
  ) {
    throw new PlanRegistryError("corrupt", "plan result aggregate version is invalid");
  }
}

function assertRequestFacts(
  tree: TreeRecord,
  snapshot: RegistrySnapshot,
  operation: "create" | "createTemplated" | "propose" | "repair" | "approve",
): void {
  if (tree.id !== snapshot.treeId)
    throw new PlanRegistryError("facts_changed", "replayed tree ID differs from request");
  if (operation === "create" && "rootArtifactId" in snapshot) {
    const root = tree.nodes.find((node) => node.id === tree.rootNodeId);
    const attention = tree.attention;
    if (
      root?.mode !== PlanNodeMode.PLAN ||
      root.state !== NodeState.PLANNED ||
      root.objective !== tree.goal ||
      root.acceptanceCriteria.length !== 1 ||
      root.acceptanceCriteria[0] !== tree.goal ||
      root.outputContract.case !== "artifact" ||
      root.outputContract.value.artifactId !== snapshot.rootArtifactId ||
      root.outputContract.value.artifactType !== "plan" ||
      !sameStrings(root.allowedRepositoryPaths, snapshot.rootAllowedRepositoryPaths) ||
      root.budget.maxAttempts !== snapshot.budget.maxAttemptsPerNode ||
      !sameAttentionFacts(
        attention,
        snapshot.attentionId,
        snapshot.treeId,
        snapshot.planRevisionId,
        tree.createdAt,
      )
    ) {
      throw new PlanRegistryError(
        "facts_changed",
        "replayed structural root facts differ from create request",
      );
    }
  }
  if (operation === "create" && "rootArtifactId" in snapshot) {
    const root = tree.nodes.find((node) => node.id === tree.rootNodeId);
    const revision = tree.revisions.find((candidate) => candidate.id === snapshot.planRevisionId);
    if (
      tree.repositoryId !== snapshot.repositoryId ||
      tree.baseCommit !== snapshot.baseCommit ||
      tree.goal !== snapshot.goal ||
      tree.rootNodeId !== snapshot.rootNodeId ||
      tree.activePlanRevisionId !== snapshot.planRevisionId ||
      tree.state !== TreeState.DRAFT ||
      tree.version !== 0 ||
      tree.createdAt !== tree.updatedAt ||
      tree.revisions.length !== 1 ||
      revision?.state !== PlanRevisionState.DRAFT ||
      revision.version !== 0 ||
      revision.createdAt !== tree.createdAt ||
      revision.approvedAt !== undefined ||
      revision.supersededAt !== undefined ||
      root === undefined ||
      tree.nodes.length !== 1 ||
      root.planRevisionId !== snapshot.planRevisionId ||
      root.version !== 0 ||
      root.createdAt !== tree.createdAt ||
      root.updatedAt !== tree.updatedAt ||
      tree.budget.maxDepth !== snapshot.budget.maxDepth ||
      tree.budget.maxFanOut !== snapshot.budget.maxFanOut ||
      tree.budget.maxNodes !== snapshot.budget.maxNodes ||
      tree.budget.maxConcurrency !== snapshot.budget.maxConcurrency ||
      tree.budget.maxAttemptsPerNode !== snapshot.budget.maxAttemptsPerNode
    )
      throw new PlanRegistryError(
        "facts_changed",
        "replayed tree facts differ from create request",
      );
    return;
  }
  if (operation === "createTemplated" && "autoApprove" in snapshot && "nodes" in snapshot) {
    const root = tree.nodes.find((node) => node.id === tree.rootNodeId);
    const revision = tree.revisions.find((candidate) => candidate.id === snapshot.planRevisionId);
    const expectedTreeState = snapshot.autoApprove ? TreeState.APPROVED : TreeState.DRAFT;
    const expectedRevisionState = snapshot.autoApprove
      ? PlanRevisionState.APPROVED
      : PlanRevisionState.DRAFT;

    if (
      tree.repositoryId !== snapshot.repositoryId ||
      tree.baseCommit !== snapshot.baseCommit ||
      tree.goal !== snapshot.goal ||
      tree.rootNodeId !== snapshot.rootNodeId ||
      tree.activePlanRevisionId !== snapshot.planRevisionId ||
      tree.state !== expectedTreeState ||
      tree.version !== 0 ||
      tree.createdAt !== tree.updatedAt ||
      tree.revisions.length !== 1 ||
      revision?.state !== expectedRevisionState ||
      revision.version !== (snapshot.autoApprove ? 1 : 0) ||
      revision.createdAt !== tree.createdAt ||
      (snapshot.autoApprove
        ? revision.approvedAt !== tree.createdAt
        : revision.approvedAt !== undefined) ||
      revision.supersededAt !== undefined ||
      tree.attention !== undefined ||
      root === undefined ||
      tree.nodes.length !== 1 + snapshot.nodes.length ||
      root.planRevisionId !== snapshot.planRevisionId ||
      root.version !== 0 ||
      root.createdAt !== tree.createdAt ||
      root.updatedAt !== tree.updatedAt ||
      root.mode !== PlanNodeMode.PLAN ||
      root.state !== NodeState.PLANNED ||
      root.objective !== tree.goal ||
      root.acceptanceCriteria.length !== 1 ||
      root.acceptanceCriteria[0] !== tree.goal ||
      root.outputContract.case !== "artifact" ||
      root.outputContract.value.artifactId !== snapshot.rootArtifactId ||
      root.outputContract.value.artifactType !== "plan" ||
      !sameStrings(root.allowedRepositoryPaths, snapshot.rootAllowedRepositoryPaths) ||
      root.budget.maxAttempts !== snapshot.budget.maxAttemptsPerNode ||
      tree.budget.maxDepth !== snapshot.budget.maxDepth ||
      tree.budget.maxFanOut !== snapshot.budget.maxFanOut ||
      tree.budget.maxNodes !== snapshot.budget.maxNodes ||
      tree.budget.maxConcurrency !== snapshot.budget.maxConcurrency ||
      tree.budget.maxAttemptsPerNode !== snapshot.budget.maxAttemptsPerNode
    ) {
      throw new PlanRegistryError(
        "facts_changed",
        "replayed tree facts differ from create templated request",
      );
    }
    const childNodes = tree.nodes.filter((node) => node.id !== tree.rootNodeId);
    if (childNodes.length !== snapshot.nodes.length) {
      throw new PlanRegistryError(
        "facts_changed",
        "replayed templated child node count differs from request",
      );
    }
    for (let index = 0; index < snapshot.nodes.length; index += 1) {
      const candidate = snapshot.nodes[index];
      const node = childNodes[index];
      if (candidate === undefined || node === undefined) {
        throw new PlanRegistryError("facts_changed", "replayed templated child nodes are sparse");
      }
      const isDirectExecutable =
        snapshot.autoApprove &&
        candidate.parentNodeId === snapshot.rootNodeId &&
        isExecutableNodeMode(candidate.mode);
      const expectedNodeState = isDirectExecutable ? NodeState.READY : NodeState.PLANNED;

      const expectedParentId =
        candidate.parentNodeId === snapshot.rootNodeId
          ? tree.rootNodeId
          : (() => {
              const parentCandidateIndex = snapshot.nodes.findIndex(
                (n) => n.id === candidate.parentNodeId,
              );
              return parentCandidateIndex >= 0 ? childNodes[parentCandidateIndex]?.id : undefined;
            })();

      const sameOutputContract =
        node.outputContract.case === candidate.outputContract.case &&
        (node.outputContract.case !== "artifact" ||
          (candidate.outputContract.case === "artifact" &&
            node.outputContract.value.artifactType ===
              candidate.outputContract.value.artifactType));

      if (
        node.parentNodeId !== expectedParentId ||
        node.mode !== candidate.mode ||
        node.objective !== candidate.objective ||
        !sameStrings(node.acceptanceCriteria, candidate.acceptanceCriteria) ||
        !sameInputs(node.inputs, candidate.inputs) ||
        !sameOutputContract ||
        !sameStrings(node.allowedRepositoryPaths, candidate.allowedRepositoryPaths) ||
        node.budget.maxAttempts !== tree.budget.maxAttemptsPerNode ||
        node.state !== expectedNodeState ||
        node.version !== (isDirectExecutable ? 1 : 0) ||
        node.createdAt !== tree.createdAt ||
        node.updatedAt !== tree.updatedAt
      ) {
        throw new PlanRegistryError(
          "facts_changed",
          "replayed templated child nodes differ from request",
        );
      }
    }
    return;
  }
  if (operation === "approve" && "planRevisionId" in snapshot) {
    const revision = tree.revisions.find((candidate) => candidate.id === snapshot.planRevisionId);
    const revisionNodes = tree.nodes.filter(
      (node) => node.planRevisionId === snapshot.planRevisionId && node.id !== tree.rootNodeId,
    );
    const executableNodes = revisionNodes.filter((node) => isExecutableNodeMode(node.mode));
    if (
      tree.activePlanRevisionId !== snapshot.planRevisionId ||
      tree.state !== TreeState.APPROVED ||
      tree.attention !== undefined ||
      revision?.state !== PlanRevisionState.APPROVED ||
      revision.version !== 1 ||
      revision.approvedAt === undefined ||
      revision.approvedAt !== tree.updatedAt ||
      executableNodes.length === 0 ||
      revisionNodes.some((node) => {
        const isDirectExecutable =
          node.parentNodeId === tree.rootNodeId && isExecutableNodeMode(node.mode);
        return isDirectExecutable
          ? node.state !== NodeState.READY ||
              node.version !== 1 ||
              node.updatedAt !== tree.updatedAt
          : node.state !== NodeState.PLANNED ||
              node.version !== 0 ||
              node.updatedAt !== node.createdAt;
      })
    ) {
      throw new PlanRegistryError("facts_changed", "replayed approval facts differ from request");
    }
    return;
  }
  if (!("nodes" in snapshot))
    throw new PlanRegistryError("facts_changed", "replayed plan facts are unavailable");
  if (tree.activePlanRevisionId !== snapshot.planRevisionId || tree.goal !== snapshot.goal)
    throw new PlanRegistryError("facts_changed", "replayed plan facts differ from request");
  const revision = tree.revisions.find((candidate) => candidate.id === snapshot.planRevisionId);
  if (
    tree.state !== TreeState.DRAFT ||
    tree.attention !== undefined ||
    revision?.state !== PlanRevisionState.DRAFT ||
    revision.version !== 0 ||
    revision.createdAt !== tree.updatedAt ||
    revision.approvedAt !== undefined ||
    revision.supersededAt !== undefined
  ) {
    throw new PlanRegistryError("facts_changed", "replayed plan lifecycle differs from request");
  }
  const planned = tree.nodes.filter(
    (node) => node.planRevisionId === snapshot.planRevisionId && node.id !== tree.rootNodeId,
  );
  if (planned.length !== snapshot.nodes.length)
    throw new PlanRegistryError("facts_changed", "replayed plan node count differs from request");
  for (const candidate of snapshot.nodes) {
    const node = planned.find((value) => value.id === candidate.id);
    if (
      node === undefined ||
      node.parentNodeId !== candidate.parentNodeId ||
      node.mode !== candidate.mode ||
      node.objective !== candidate.objective ||
      !sameStrings(node.acceptanceCriteria, candidate.acceptanceCriteria) ||
      !sameInputs(node.inputs, candidate.inputs) ||
      !sameOutput(node.outputContract, candidate.outputContract) ||
      !sameStrings(node.allowedRepositoryPaths, candidate.allowedRepositoryPaths) ||
      node.budget.maxAttempts !== tree.budget.maxAttemptsPerNode ||
      node.state !== NodeState.PLANNED ||
      node.version !== 0 ||
      node.createdAt !== node.updatedAt ||
      node.updatedAt !== tree.updatedAt
    )
      throw new PlanRegistryError("facts_changed", "replayed plan nodes differ from request");
  }
}

function assertImmutableReplayFacts(result: TreeRecord, persisted: TreeRecord): void {
  if (
    result.id !== persisted.id ||
    result.repositoryId !== persisted.repositoryId ||
    result.hostId !== persisted.hostId ||
    result.baseCommit !== persisted.baseCommit ||
    result.rootNodeId !== persisted.rootNodeId ||
    result.createdAt !== persisted.createdAt ||
    result.budget.maxDepth !== persisted.budget.maxDepth ||
    result.budget.maxFanOut !== persisted.budget.maxFanOut ||
    result.budget.maxNodes !== persisted.budget.maxNodes ||
    result.budget.maxConcurrency !== persisted.budget.maxConcurrency ||
    result.budget.maxAttemptsPerNode !== persisted.budget.maxAttemptsPerNode
  ) {
    throw new PlanRegistryError("corrupt", "historical plan result changes immutable tree facts");
  }
  const maximumRevisionOrdinal = Math.max(...result.revisions.map((revision) => revision.ordinal));
  const expectedRevisionIds = new Set(
    persisted.revisions
      .filter((revision) => revision.ordinal <= maximumRevisionOrdinal)
      .map((revision) => revision.id),
  );
  const resultRevisionIds = new Set(result.revisions.map((revision) => revision.id));
  if (
    expectedRevisionIds.size !== resultRevisionIds.size ||
    [...expectedRevisionIds].some((id) => !resultRevisionIds.has(id))
  ) {
    throw new PlanRegistryError("corrupt", "historical plan result omits persisted revisions");
  }
  const persistedRevisionOrdinals = new Map(
    persisted.revisions.map((revision) => [revision.id, revision.ordinal]),
  );
  const expectedNodeIds = new Set(
    persisted.nodes
      .filter((node) => {
        const ordinal = persistedRevisionOrdinals.get(node.planRevisionId);
        return ordinal !== undefined && ordinal <= maximumRevisionOrdinal;
      })
      .map((node) => node.id),
  );
  const resultNodeIds = new Set(result.nodes.map((node) => node.id));
  if (
    expectedNodeIds.size !== resultNodeIds.size ||
    [...expectedNodeIds].some((id) => !resultNodeIds.has(id))
  ) {
    throw new PlanRegistryError("corrupt", "historical plan result omits persisted nodes");
  }
  const activeRevision = result.revisions.find(
    (revision) => revision.id === result.activePlanRevisionId,
  );
  if (activeRevision === undefined) {
    throw new PlanRegistryError("corrupt", "historical plan result omits its active revision");
  }
  for (const revision of result.revisions) {
    const current = persisted.revisions.find((candidate) => candidate.id === revision.id);
    if (current === undefined) {
      throw new PlanRegistryError(
        "corrupt",
        "historical plan result changes immutable revision facts",
      );
    }
    if (
      revision.treeId !== current.treeId ||
      revision.ordinal !== current.ordinal ||
      revision.goal !== current.goal ||
      revision.createdAt !== current.createdAt ||
      revision.state !== historicalRevisionState(result, current, activeRevision.ordinal) ||
      revision.version !== revisionVersionForState(revision.state) ||
      (revision.approvedAt !== undefined && revision.approvedAt !== current.approvedAt) ||
      (revision.supersededAt !== undefined && revision.supersededAt !== current.supersededAt)
    ) {
      throw new PlanRegistryError(
        "corrupt",
        "historical plan result changes immutable revision facts",
      );
    }
  }
  for (const node of result.nodes) {
    const current = persisted.nodes.find((candidate) => candidate.id === node.id);
    if (current === undefined) {
      throw new PlanRegistryError("corrupt", "historical plan result changes immutable node facts");
    }
    const revisionOrdinal = persistedRevisionOrdinals.get(node.planRevisionId);
    if (revisionOrdinal === undefined) {
      throw new PlanRegistryError("corrupt", "historical plan node revision is unavailable");
    }
    const wasSupersededBeforeActiveRevision =
      revisionOrdinal < activeRevision.ordinal && current.state === NodeState.SUPERSEDED;
    if (
      node.treeId !== current.treeId ||
      node.repositoryId !== current.repositoryId ||
      node.hostId !== current.hostId ||
      node.parentNodeId !== current.parentNodeId ||
      node.planRevisionId !== current.planRevisionId ||
      node.mode !== current.mode ||
      node.objective !== current.objective ||
      !sameStrings(node.acceptanceCriteria, current.acceptanceCriteria) ||
      !sameInputs(node.inputs, current.inputs) ||
      !sameOutput(node.outputContract, current.outputContract) ||
      !sameStrings(node.allowedRepositoryPaths, current.allowedRepositoryPaths) ||
      node.budget.maxAttempts !== current.budget.maxAttempts ||
      node.createdAt !== current.createdAt ||
      node.version > current.version ||
      node.updatedAt > current.updatedAt ||
      (wasSupersededBeforeActiveRevision &&
        (node.state !== NodeState.SUPERSEDED ||
          node.version !== current.version ||
          node.updatedAt !== current.updatedAt)) ||
      (node.version === current.version &&
        (node.state !== current.state || node.updatedAt !== current.updatedAt))
    ) {
      throw new PlanRegistryError("corrupt", "historical plan result changes immutable node facts");
    }
  }
}

function historicalRevisionState(
  result: TreeRecord,
  revision: PlanRevisionRecord,
  activeOrdinal: number,
): PlanRevisionState {
  if (revision.id === result.activePlanRevisionId) {
    return result.state === TreeState.DRAFT ? PlanRevisionState.DRAFT : PlanRevisionState.APPROVED;
  }
  if (revision.ordinal < activeOrdinal && revision.state === PlanRevisionState.SUPERSEDED) {
    return PlanRevisionState.SUPERSEDED;
  }
  return PlanRevisionState.DRAFT;
}

function revisionVersionForState(state: PlanRevisionState): number {
  if (state === PlanRevisionState.DRAFT) return 0;
  if (state === PlanRevisionState.APPROVED) return 1;
  return 2;
}

function equivalentTree(left: TreeRecord, right: TreeRecord): boolean {
  return JSON.stringify(treePlain(left)) === JSON.stringify(treePlain(right));
}

function treePlain(tree: TreeRecord): unknown {
  return {
    id: tree.id,
    repositoryId: tree.repositoryId,
    hostId: tree.hostId,
    baseCommit: tree.baseCommit,
    goal: tree.goal,
    activePlanRevisionId: tree.activePlanRevisionId,
    rootNodeId: tree.rootNodeId,
    state: tree.state,
    version: tree.version,
    createdAt: tree.createdAt,
    updatedAt: tree.updatedAt,
    revisions: tree.revisions.map((revision) => ({ ...revision })),
    nodes: tree.nodes.map((node) => ({
      ...node,
      acceptanceCriteria: [...node.acceptanceCriteria],
      inputs: node.inputs.map((input) => ({ ...input })),
      allowedRepositoryPaths: [...node.allowedRepositoryPaths],
      budget: { ...node.budget },
      outputContract:
        node.outputContract.case === "artifact"
          ? { case: "artifact", value: { ...node.outputContract.value } }
          : { case: "implementation", value: {} },
    })),
    budget: { ...tree.budget },
    attention: tree.attention === undefined ? undefined : { ...tree.attention },
  };
}

function sameAttentionFacts(
  attention: PlanAttentionRecord | undefined,
  attentionId: string,
  treeId: TaskTreeId,
  planRevisionId: PlanRevisionId,
  createdAt: Timestamp,
): boolean {
  return (
    attention?.id === attentionId &&
    attention.treeId === treeId &&
    attention.planRevisionId === planRevisionId &&
    attention.kind === PlanAttentionKind.PLAN_REQUIRED &&
    attention.message === "tree requires an initial plan" &&
    attention.state === PlanAttentionState.OPEN &&
    attention.createdAt === createdAt &&
    attention.resolvedAt === undefined
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameInputs(
  left: readonly ArtifactInputRecord[],
  right: readonly ArtifactInputRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const candidate = right[index];
      return (
        candidate?.artifactId === value.artifactId && candidate.sourceNodeId === value.sourceNodeId
      );
    })
  );
}

function sameOutput(left: TaskNodeOutputRecord, right: TaskNodeOutputRecord): boolean {
  if (left.case !== right.case) return false;
  return (
    left.case === "implementation" ||
    (left.value.artifactId === right.value.artifactId &&
      left.value.artifactType === right.value.artifactType)
  );
}

function toTreeSummary(tree: TreeRecord): TreeSummaryRecord {
  return Object.freeze({
    id: tree.id,
    repositoryId: tree.repositoryId,
    hostId: tree.hostId,
    rootNodeId: tree.rootNodeId,
    activePlanRevisionId: tree.activePlanRevisionId,
    state: tree.state,
    version: tree.version,
  });
}

function assertCreateIdAvailability(
  transaction: SqliteCommandTransaction,
  snapshot: CreateSnapshot,
): void {
  const ids = [
    snapshot.treeId,
    snapshot.planRevisionId,
    snapshot.rootNodeId,
    snapshot.rootArtifactId,
    snapshot.attentionId,
  ];
  for (const id of ids) {
    const row = transaction.get(
      `SELECT id FROM trees WHERE id = ?
       UNION ALL SELECT id FROM plan_revisions WHERE id = ?
       UNION ALL SELECT id FROM nodes WHERE id = ?
       UNION ALL SELECT output_artifact_id AS id FROM nodes WHERE output_artifact_id = ?
       UNION ALL SELECT id FROM plan_attentions WHERE id = ?
       UNION ALL SELECT id FROM repositories WHERE id = ?`,
      [id, id, id, id, id, id],
    );
    if (row !== undefined)
      throw new PlanRegistryError("invalid_plan", "tree IDs are already persisted");
  }
}

function assertCreateTemplatedIdAvailability(
  transaction: SqliteCommandTransaction,
  snapshot: CreateTemplatedSnapshot,
): void {
  const ids = [
    snapshot.treeId,
    snapshot.planRevisionId,
    snapshot.rootNodeId,
    snapshot.rootArtifactId,
    snapshot.attentionId,
    ...snapshot.nodes.flatMap((node) => [
      node.id,
      ...(node.outputContract.case === "artifact" ? [node.outputContract.value.artifactId] : []),
    ]),
  ];
  for (const id of ids) {
    const row = transaction.get(
      `SELECT id FROM trees WHERE id = ?
       UNION ALL SELECT id FROM plan_revisions WHERE id = ?
       UNION ALL SELECT id FROM nodes WHERE id = ?
       UNION ALL SELECT output_artifact_id AS id FROM nodes WHERE output_artifact_id = ?
       UNION ALL SELECT id FROM plan_attentions WHERE id = ?
       UNION ALL SELECT id FROM repositories WHERE id = ?`,
      [id, id, id, id, id, id],
    );
    if (row !== undefined)
      throw new PlanRegistryError("invalid_plan", "tree IDs are already persisted");
  }
}

function assertProposedIdAvailability(
  transaction: SqliteCommandTransaction,
  snapshot: PlanSnapshot,
): void {
  const ids = [
    snapshot.planRevisionId,
    ...snapshot.nodes.flatMap((node) => [
      node.id,
      ...(node.outputContract.case === "artifact" ? [node.outputContract.value.artifactId] : []),
    ]),
  ];
  for (const id of ids) {
    const row = transaction.get(
      `SELECT id FROM trees WHERE id = ?
       UNION ALL SELECT id FROM plan_revisions WHERE id = ?
       UNION ALL SELECT id FROM nodes WHERE id = ?
       UNION ALL SELECT output_artifact_id AS id FROM nodes WHERE output_artifact_id = ?
       UNION ALL SELECT id FROM plan_attentions WHERE id = ?
       UNION ALL SELECT id FROM repositories WHERE id = ?`,
      [id, id, id, id, id, id],
    );
    if (row !== undefined) {
      throw new PlanRegistryError(
        "invalid_plan",
        "plan node, artifact, or revision ID is already persisted",
      );
    }
  }
}

function assertDistinctIds(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new PlanRegistryError("invalid_plan", message);
}

const EXECUTABLE_NODE_MODES: readonly PlanNodeMode[] = [
  PlanNodeMode.RESEARCH,
  PlanNodeMode.EXPLORE,
  PlanNodeMode.IMPLEMENTATION,
];

const EXECUTABLE_NODE_MODE_KINDS: readonly string[] = EXECUTABLE_NODE_MODES.map((mode) =>
  modeKind(mode),
);

const EXECUTABLE_NODE_MODE_PLACEHOLDERS: string = EXECUTABLE_NODE_MODE_KINDS.map(() => "?").join(
  ", ",
);

/** Modes a plan approval activates. PLAN is excluded: the root's own planning node is never
 *  promoted to ready by approving the plan it produced. */
function isExecutableNodeMode(mode: PlanNodeMode): boolean {
  return EXECUTABLE_NODE_MODES.includes(mode);
}

function modeKind(mode: PlanNodeMode): string {
  if (mode === PlanNodeMode.PLAN) return "plan";
  if (mode === PlanNodeMode.RESEARCH) return "research";
  if (mode === PlanNodeMode.EXPLORE) return "explore";
  if (mode === PlanNodeMode.IMPLEMENTATION) return "implementation";
  throw new PlanRegistryError("invalid_plan", "node mode is invalid");
}

function modeFromKind(value: string): PlanNodeMode {
  if (value === "plan") return PlanNodeMode.PLAN;
  if (value === "research") return PlanNodeMode.RESEARCH;
  if (value === "explore") return PlanNodeMode.EXPLORE;
  if (value === "implementation") return PlanNodeMode.IMPLEMENTATION;
  throw new TypeError("node mode is invalid");
}

function revisionStateFromKind(value: string): PlanRevisionState {
  if (value === "draft") return PlanRevisionState.DRAFT;
  if (value === "approved") return PlanRevisionState.APPROVED;
  if (value === "superseded") return PlanRevisionState.SUPERSEDED;
  throw new TypeError("plan revision state is invalid");
}

function revisionStateFromValue(value: unknown): PlanRevisionState {
  if (value === PlanRevisionState.DRAFT) return PlanRevisionState.DRAFT;
  if (value === PlanRevisionState.APPROVED) return PlanRevisionState.APPROVED;
  if (value === PlanRevisionState.SUPERSEDED) return PlanRevisionState.SUPERSEDED;
  throw new TypeError("plan revision enum is invalid");
}

function nodeStateFromKind(value: string): NodeState {
  if (value === "planned") return NodeState.PLANNED;
  if (value === "ready") return NodeState.READY;
  if (value === "active") return NodeState.ACTIVE;
  if (value === "blocked") return NodeState.BLOCKED;
  if (value === "succeeded") return NodeState.SUCCEEDED;
  if (value === "failed") return NodeState.FAILED;
  if (value === "cancelled") return NodeState.CANCELLED;
  if (value === "superseded") return NodeState.SUPERSEDED;
  throw new TypeError("node state is invalid");
}

function nodeStateFromValue(value: unknown): NodeState {
  if (value === NodeState.PLANNED) return NodeState.PLANNED;
  if (value === NodeState.READY) return NodeState.READY;
  if (value === NodeState.ACTIVE) return NodeState.ACTIVE;
  if (value === NodeState.BLOCKED) return NodeState.BLOCKED;
  if (value === NodeState.SUCCEEDED) return NodeState.SUCCEEDED;
  if (value === NodeState.FAILED) return NodeState.FAILED;
  if (value === NodeState.CANCELLED) return NodeState.CANCELLED;
  if (value === NodeState.SUPERSEDED) return NodeState.SUPERSEDED;
  throw new TypeError("node state enum is invalid");
}

function attentionKindFromKind(value: string): PlanAttentionKind {
  if (value === "plan_required") return PlanAttentionKind.PLAN_REQUIRED;
  if (value === "plan_invalid") return PlanAttentionKind.PLAN_INVALID;
  if (value === "repair_required") return PlanAttentionKind.REPAIR_REQUIRED;
  throw new TypeError("attention kind is invalid");
}

function attentionKindFromValue(value: unknown): PlanAttentionKind {
  if (value === PlanAttentionKind.PLAN_REQUIRED) return PlanAttentionKind.PLAN_REQUIRED;
  if (value === PlanAttentionKind.PLAN_INVALID) return PlanAttentionKind.PLAN_INVALID;
  if (value === PlanAttentionKind.REPAIR_REQUIRED) return PlanAttentionKind.REPAIR_REQUIRED;
  throw new TypeError("attention kind enum is invalid");
}

function attentionStateFromKind(value: string): PlanAttentionState {
  if (value === "open") return PlanAttentionState.OPEN;
  if (value === "resolved") return PlanAttentionState.RESOLVED;
  throw new TypeError("attention state is invalid");
}

function attentionStateFromValue(value: unknown): PlanAttentionState {
  if (value === PlanAttentionState.OPEN) return PlanAttentionState.OPEN;
  if (value === PlanAttentionState.RESOLVED) return PlanAttentionState.RESOLVED;
  throw new TypeError("attention state enum is invalid");
}

function treeStateFromValue(value: unknown): TreeState {
  if (value === TreeState.DRAFT) return TreeState.DRAFT;
  if (value === TreeState.APPROVED) return TreeState.APPROVED;
  throw new TypeError("tree state enum is invalid");
}

function parsePlanNodeMode(value: unknown): PlanNodeMode {
  if (
    value === PlanNodeMode.PLAN ||
    value === PlanNodeMode.RESEARCH ||
    value === PlanNodeMode.EXPLORE ||
    value === PlanNodeMode.IMPLEMENTATION
  )
    return value;
  throw new TypeError("node mode enum is invalid");
}

function parseHostId(value: unknown, fieldName: string): HostId {
  try {
    if (typeof value !== "string") throw new TypeError(`${fieldName} must be a string`);
    return hostId(value);
  } catch (error) {
    throw new PlanRegistryError("invalid_input", `${fieldName} is invalid`, { cause: error });
  }
}

function parseTreeId(value: unknown, fieldName: string): TaskTreeId {
  try {
    if (typeof value !== "string") throw new TypeError(`${fieldName} must be a string`);
    return taskTreeId(value);
  } catch (error) {
    throw new PlanRegistryError("invalid_input", `${fieldName} is invalid`, { cause: error });
  }
}

function parseGitSha(value: string, fieldName: string): GitSha {
  try {
    return gitSha(value);
  } catch (error) {
    throw new PlanRegistryError("corrupt", `${fieldName} is invalid`, { cause: error });
  }
}

function parseUuid(value: unknown, fieldName: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    throw new TypeError(`${fieldName} is invalid`);
  return value;
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${key} is not a non-empty string`);
  return value;
}

function nullableString(value: unknown, fieldName: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${fieldName} is not null or a non-empty string`);
  return value;
}

function nullableNodeId(value: unknown, fieldName: string): TaskNodeId | undefined {
  const parsed = nullableString(value, fieldName);
  return parsed === undefined ? undefined : taskNodeId(parsed);
}

function nullableKind(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("nullable kind is invalid");
  return value;
}

function safeInteger(value: unknown, fieldName: string): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError(`${fieldName} is outside safe integer range`);
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new TypeError(`${fieldName} is not a non-negative safe integer`);
}

function safePositiveInteger(value: unknown, fieldName: string): number {
  const parsed = safeInteger(value, fieldName);
  if (parsed < 1) throw new TypeError(`${fieldName} must be positive`);
  return parsed;
}

function positiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${fieldName} must be positive`);
  return value;
}

function safeTimestamp(value: unknown, fieldName: string): Timestamp {
  return timestampFromEpochMilliseconds(safeInteger(value, fieldName));
}

function nullableTimestamp(value: unknown, fieldName: string): Timestamp | undefined {
  if (value === null) return undefined;
  return safeTimestamp(value, fieldName);
}

function timestampMessage(value: Timestamp): { seconds: bigint; nanos: number } {
  const milliseconds = BigInt(value);
  return { seconds: milliseconds / 1_000n, nanos: Number(milliseconds % 1_000n) * 1_000_000 };
}

function timestampFromMessage(value: unknown, fieldName: string): Timestamp {
  if (typeof value !== "object" || value === null || !("seconds" in value) || !("nanos" in value))
    throw new TypeError(`${fieldName} is missing`);
  const seconds = value.seconds;
  const nanos = value.nanos;
  if (
    typeof seconds !== "bigint" ||
    typeof nanos !== "number" ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos > 999_999_999 ||
    nanos % 1_000_000 !== 0
  )
    throw new TypeError(`${fieldName} is malformed`);
  const milliseconds = seconds * 1_000n + BigInt(nanos / 1_000_000);
  if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER))
    throw new TypeError(`${fieldName} is outside safe integer range`);
  return timestampFromEpochMilliseconds(Number(milliseconds));
}

function safeBigIntNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new TypeError(`${fieldName} is not a safe uint64`);
  return Number(value);
}

function assertObject(value: unknown, fieldName: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${fieldName} is malformed`);
  return value as Readonly<Record<string, unknown>>;
}

function requiredObjectString(value: Readonly<Record<string, unknown>>, key: string): string {
  return assertString(value[key], key);
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${fieldName} is invalid`);
  return value;
}

function requiredObjectBigInt(value: Readonly<Record<string, unknown>>, key: string): bigint {
  const field = value[key];
  if (typeof field !== "bigint") throw new TypeError(`${key} is invalid`);
  return field;
}

function optionalStringProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  return assertString(field, key);
}

function optionalTimestampProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Timestamp | undefined {
  const field = value[key];
  return field === undefined ? undefined : timestampFromMessage(field, key);
}

function safeNumberProperty(value: Readonly<Record<string, unknown>>, key: string): number {
  const field = value[key];
  if (typeof field !== "number") throw new TypeError(`${key} is invalid`);
  return field;
}

function normalizeReadError(error: unknown): PlanRegistryError | Error {
  if (error instanceof PlanRegistryError) return error;
  return new PlanRegistryError("corrupt", "tree registry read failed", { cause: error });
}

function normalizePlanError(error: unknown): PlanRegistryError | Error {
  let current = error;
  const visited = new Set<Error>();
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof PlanRegistryError) return current;
    visited.add(current);
    current = current.cause;
  }
  if (error instanceof SqliteCommandError) {
    if (error.code === "command_id_conflict" || error.code === "aggregate_version_conflict")
      return new PlanRegistryError(
        "identity_conflict",
        "tree command conflicts with an existing command or version",
        { cause: error },
      );
    if (error.code === "command_result_corrupt")
      return new PlanRegistryError("corrupt", "tree command result is corrupt", { cause: error });
    if (error.code === "invalid_command")
      return new PlanRegistryError("invalid_input", "tree command is invalid", { cause: error });
    if (error.code === "command_failed")
      return new PlanRegistryError("corrupt", "tree command failed", { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
