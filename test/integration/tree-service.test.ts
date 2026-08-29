import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createSqliteSchedulerStore,
  createSqliteVcsChangeBindingStore,
  openHostDatabase,
} from "@minions/adapters";
import {
  ApiVersionSchema,
  ApprovePlanRequestSchema,
  ArtifactInputSchema,
  ArtifactOutputContractSchema,
  AttentionKind,
  AttentionSummarySchema,
  CreateTemplatedTreeRequestSchema,
  CreateTreeRequestSchema,
  EventService,
  GetServerInfoRequestSchema,
  ImplementationOutputContractSchema,
  ListTreesRequestSchema,
  NodeBudgetSchema,
  NodeState,
  PlanAttentionKind,
  PlanAttentionSchema,
  PlanAttentionState,
  PlanNodeMode,
  PlanRevisionSchema,
  PlanRevisionState,
  ProposedNodeSchema,
  ProposePlanRequestSchema,
  RegisterRepositoryRequestSchema,
  RepairPlanRequestSchema,
  RepositoryService,
  ServerCapability,
  SystemService,
  TaskNodeSchema,
  TaskTreeSchema,
  TreeBudgetSchema,
  TaskTemplate,
  TreeService,
  TreeState,
  TreeSummarySchema,
  VcsChangeBindingSchema,
  VcsConflictState,
  type PlanAttention,
  type PlanRevision,
  type TaskNode,
  type TaskTree,
  type TreeBudget,
} from "@minions/contracts";
import {
  contentHash,
  gitSha,
  schedulerCapacityPolicy,
  schedulerOwnerId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type Clock,
  type Timestamp as ClockTimestamp,
} from "@minions/core";
import { SequenceIdGenerator } from "@minions/testkit";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { main as runCli } from "../../apps/cli/src/index.js";
import {
  createStructuredLogger,
  startDaemonRuntime,
  type DaemonRuntimeOptions,
  type RunningDaemonRuntime,
  type StructuredLogger,
} from "@minions/daemon";

const STARTED_AT_MS = 1_700_000_000_000;
const CONNECT_PROPOSED_AT_MS = STARTED_AT_MS + 100;
const CONNECT_APPROVED_AT_MS = STARTED_AT_MS + 200;
const CONNECT_SECOND_PROPOSED_AT_MS = STARTED_AT_MS + 300;
const CONNECT_SECOND_APPROVED_AT_MS = STARTED_AT_MS + 400;
const CLI_PROPOSED_AT_MS = STARTED_AT_MS + 100;
const CLI_APPROVED_AT_MS = STARTED_AT_MS + 200;
const RESTARTED_AT_MS = STARTED_AT_MS + 1_000;

const CONNECT_INSTANCE_ID = "01900000-0000-7000-8000-000000000001";
const CONNECT_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000002";
const CONNECT_REGISTER_EVENT_ID = "01900000-0000-7000-8000-000000000003";
const CONNECT_CREATE_EVENT_ID = "01900000-0000-7000-8000-000000000004";
const CONNECT_PROPOSE_EVENT_ID = "01900000-0000-7000-8000-000000000005";
const CONNECT_APPROVE_EVENT_ID = "01900000-0000-7000-8000-000000000006";
const CONNECT_SECOND_PROPOSE_EVENT_ID = "01900000-0000-7000-8000-000000000007";
const CONNECT_SECOND_APPROVE_EVENT_ID = "01900000-0000-7000-8000-000000000008";
const CONNECT_SECOND_CREATE_EVENT_ID = "01900000-0000-7000-8000-000000000009";
const CONNECT_RESTART_INSTANCE_ID = "01900000-0000-7000-8000-00000000000a";
const CONNECT_RESTART_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-00000000000b";
const CONNECT_REGISTER_COMMAND_ID = "01900000-0000-7000-8000-000000000010";
const CONNECT_ACTOR_SESSION_ID = "01900000-0000-7000-8000-000000000011";
const CONNECT_REPOSITORY_ID = "01900000-0000-7000-8000-000000000012";
const CONNECT_TREE_ID = "01900000-0000-7000-8000-000000000100";
const CONNECT_INITIAL_REVISION_ID = "01900000-0000-7000-8000-000000000101";
const CONNECT_ROOT_NODE_ID = "01900000-0000-7000-8000-000000000102";
const CONNECT_ROOT_ARTIFACT_ID = "01900000-0000-7000-8000-000000000103";
const CONNECT_ATTENTION_ID = "01900000-0000-7000-8000-000000000104";
const CONNECT_CREATE_COMMAND_ID = "01900000-0000-7000-8000-000000000105";
const CONNECT_BAD_REVISION_ID = "01900000-0000-7000-8000-000000000106";
const CONNECT_BAD_NODE_ID = "01900000-0000-7000-8000-000000000107";
const CONNECT_PROPOSAL_COMMAND_ID = "01900000-0000-7000-8000-000000000108";
const CONNECT_PROPOSAL_REVISION_ID = "01900000-0000-7000-8000-000000000109";
const CONNECT_CHILD_NODE_ID = "01900000-0000-7000-8000-00000000010a";
const CONNECT_DEEP_NODE_ID = "01900000-0000-7000-8000-00000000010b";
const CONNECT_DEEP_ARTIFACT_ID = "01900000-0000-7000-8000-00000000010c";
const CONNECT_APPROVE_COMMAND_ID = "01900000-0000-7000-8000-00000000010d";
const CONNECT_SECOND_PROPOSAL_COMMAND_ID = "01900000-0000-7000-8000-00000000010e";
const CONNECT_SECOND_REVISION_ID = "01900000-0000-7000-8000-00000000010f";
const CONNECT_SECOND_CHILD_NODE_ID = "01900000-0000-7000-8000-000000000110";
const CONNECT_SECOND_DEEP_NODE_ID = "01900000-0000-7000-8000-000000000111";
const CONNECT_SECOND_DEEP_ARTIFACT_ID = "01900000-0000-7000-8000-000000000112";
const CONNECT_SECOND_APPROVE_COMMAND_ID = "01900000-0000-7000-8000-000000000113";
const CONNECT_SECOND_TREE_ID = "01900000-0000-7000-8000-000000000200";
const CONNECT_SECOND_INITIAL_REVISION_ID = "01900000-0000-7000-8000-000000000201";
const CONNECT_SECOND_ROOT_NODE_ID = "01900000-0000-7000-8000-000000000202";
const CONNECT_SECOND_ROOT_ARTIFACT_ID = "01900000-0000-7000-8000-000000000203";
const CONNECT_SECOND_ATTENTION_ID = "01900000-0000-7000-8000-000000000204";
const CONNECT_SECOND_CREATE_COMMAND_ID = "01900000-0000-7000-8000-000000000205";
const CONNECT_REPAIR_INSTANCE_ID = "01900000-0000-7000-8000-000000000401";
const CONNECT_REPAIR_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000402";
const CONNECT_REPAIR_REGISTER_EVENT_ID = "01900000-0000-7000-8000-000000000403";
const CONNECT_REPAIR_CREATE_EVENT_ID = "01900000-0000-7000-8000-000000000404";
const CONNECT_REPAIR_EVENT_ID = "01900000-0000-7000-8000-000000000405";
const CONNECT_REPAIR_RESTART_INSTANCE_ID = "01900000-0000-7000-8000-000000000406";
const CONNECT_REPAIR_RESTART_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000407";
const CONNECT_REPAIR_REGISTER_COMMAND_ID = "01900000-0000-7000-8000-000000000408";
const CONNECT_REPAIR_ACTOR_SESSION_ID = "01900000-0000-7000-8000-000000000409";
const CONNECT_REPAIR_REPOSITORY_ID = "01900000-0000-7000-8000-00000000040a";
const CONNECT_REPAIR_TREE_ID = "01900000-0000-7000-8000-00000000040b";
const CONNECT_REPAIR_INITIAL_REVISION_ID = "01900000-0000-7000-8000-00000000040c";
const CONNECT_REPAIR_ROOT_NODE_ID = "01900000-0000-7000-8000-00000000040d";
const CONNECT_REPAIR_ROOT_ARTIFACT_ID = "01900000-0000-7000-8000-00000000040e";
const CONNECT_REPAIR_ATTENTION_ID = "01900000-0000-7000-8000-00000000040f";
const CONNECT_REPAIR_CREATE_COMMAND_ID = "01900000-0000-7000-8000-000000000413";
const CONNECT_REPAIR_COMMAND_ID = "01900000-0000-7000-8000-000000000410";
const CONNECT_REPAIR_PLAN_REVISION_ID = "01900000-0000-7000-8000-000000000411";
const CONNECT_REPAIR_NODE_ID = "01900000-0000-7000-8000-000000000412";

const CONNECT_SCOPE_ROOT = ".";
const CONNECT_SCOPE_IMPLEMENTATION = ["src", "tests"] as const;
const CLI_SCOPE_ROOT = ".";
const CLI_SCOPE_IMPLEMENTATION = ["src", "tests"] as const;

const CLI_REPAIR_INSTANCE_ID = "01900000-0000-7000-8000-000000000501";
const CLI_REPAIR_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000502";
const CLI_REPAIR_REGISTER_EVENT_ID = "01900000-0000-7000-8000-000000000503";
const CLI_REPAIR_CREATE_EVENT_ID = "01900000-0000-7000-8000-000000000504";
const CLI_REPAIR_EVENT_ID = "01900000-0000-7000-8000-000000000505";
const CLI_REPAIR_RESTART_INSTANCE_ID = "01900000-0000-7000-8000-000000000506";
const CLI_REPAIR_RESTART_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000507";
const CLI_REPAIR_REGISTER_COMMAND_ID = "01900000-0000-7000-8000-000000000508";
const CLI_REPAIR_ACTOR_SESSION_ID = "01900000-0000-7000-8000-000000000509";
const CLI_REPAIR_REPOSITORY_ID = "01900000-0000-7000-8000-00000000050a";
const CLI_REPAIR_PLAN_REVISION_ID = "01900000-0000-7000-8000-000000000510";
const CLI_REPAIR_NODE_ID = "01900000-0000-7000-8000-000000000511";
const CLI_REPAIR_GOAL = "repair the cli tree";

const CLI_INSTANCE_ID = "01900000-0000-7000-8000-000000000301";
const CLI_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000302";
const CLI_REGISTER_EVENT_ID = "01900000-0000-7000-8000-000000000303";
const CLI_CREATE_EVENT_ID = "01900000-0000-7000-8000-000000000304";
const CLI_PROPOSE_EVENT_ID = "01900000-0000-7000-8000-000000000305";
const CLI_APPROVE_EVENT_ID = "01900000-0000-7000-8000-000000000306";
const CLI_RESTART_INSTANCE_ID = "01900000-0000-7000-8000-000000000307";
const CLI_RESTART_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000308";
const CLI_REGISTER_COMMAND_ID = "01900000-0000-7000-8000-000000000309";
const CLI_ACTOR_SESSION_ID = "01900000-0000-7000-8000-00000000030a";
const CLI_REPOSITORY_ID = "01900000-0000-7000-8000-00000000030b";
const CLI_CHILD_NODE_ID = "01900000-0000-7000-8000-00000000030c";
const CLI_DEEP_NODE_ID = "01900000-0000-7000-8000-00000000030d";
const CLI_DEEP_ARTIFACT_ID = "01900000-0000-7000-8000-00000000030e";
const CLI_PROPOSAL_REVISION_ID = "01900000-0000-7000-8000-00000000030f";

const CONNECT_INITIAL_GOAL = "connect tree root";
const CONNECT_FIRST_PLAN_GOAL = "ship nested connect tree";
const CONNECT_SECOND_PLAN_GOAL = "ship final connect tree";
const CONNECT_CHILD_OBJECTIVE = "implement the first child";
const CONNECT_DEEP_OBJECTIVE = "research the first child output";
const CONNECT_SECOND_CHILD_OBJECTIVE = "implement the final child";
const CONNECT_SECOND_DEEP_OBJECTIVE = "research the final child output";
const CONNECT_REPAIR_GOAL = "repair the connect tree";
const CLI_INITIAL_GOAL = "cli tree root";
const CLI_PLAN_GOAL = "ship nested cli tree";
const VCS_BINDING_INSTANCE_ID = "01900000-0000-7000-8000-000000000601";
const VCS_BINDING_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000602";
const VCS_BINDING_REGISTER_EVENT_ID = "01900000-0000-7000-8000-000000000603";
const VCS_BINDING_CREATE_EVENT_ID = "01900000-0000-7000-8000-000000000604";
const VCS_BINDING_RESTART_INSTANCE_ID = "01900000-0000-7000-8000-000000000605";
const VCS_BINDING_RESTART_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000606";
const VCS_BINDING_REGISTER_COMMAND_ID = "01900000-0000-7000-8000-000000000607";
const VCS_BINDING_ACTOR_SESSION_ID = "01900000-0000-7000-8000-000000000608";
const VCS_BINDING_REPOSITORY_ID = "01900000-0000-7000-8000-000000000609";
const VCS_BINDING_TREE_ID = "01900000-0000-7000-8000-00000000060a";
const VCS_BINDING_INITIAL_REVISION_ID = "01900000-0000-7000-8000-00000000060b";
const VCS_BINDING_ROOT_NODE_ID = "01900000-0000-7000-8000-00000000060c";
const VCS_BINDING_ROOT_ARTIFACT_ID = "01900000-0000-7000-8000-00000000060d";
const VCS_BINDING_ATTENTION_ID = "01900000-0000-7000-8000-00000000060e";
const VCS_BINDING_CREATE_COMMAND_ID = "01900000-0000-7000-8000-00000000060f";
const VCS_BINDING_GOAL = "vcs binding tree root";
const VCS_BINDING_JJ_CHANGE_ID = "ab".repeat(32);
const VCS_BINDING_CURRENT_COMMIT_ID = "cd".repeat(20);
const VCS_BINDING_LAST_JJ_OPERATION_ID = "ef".repeat(32);
const SCHEDULER_CLOCK_INSTANCE_ID = "01900000-0000-7000-8000-000000000701";
const SCHEDULER_CLOCK_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000702";
const SCHEDULER_CLOCK_REGISTER_EVENT_ID = "01900000-0000-7000-8000-000000000703";
const SCHEDULER_CLOCK_CREATE_EVENT_ID = "01900000-0000-7000-8000-000000000704";
const SCHEDULER_CLOCK_PROPOSE_EVENT_ID = "01900000-0000-7000-8000-000000000705";
const SCHEDULER_CLOCK_APPROVE_EVENT_ID = "01900000-0000-7000-8000-000000000706";
const SCHEDULER_CLOCK_RESTART_INSTANCE_ID = "01900000-0000-7000-8000-000000000707";
const SCHEDULER_CLOCK_RESTART_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000708";
const SCHEDULER_CLOCK_ATTEMPT_ID = "01900000-0000-7000-8000-000000000709";
const SCHEDULER_CLOCK_LEASE_ID = "01900000-0000-7000-8000-00000000070a";

interface GitFixture {
  readonly directory: string;
  readonly origin: string;
  readonly root: string;
  readonly remote: string;
  readonly baseCommit: string;
}

type Clients = Readonly<{
  system: Client<typeof SystemService>;
  repository: Client<typeof RepositoryService>;
  tree: Client<typeof TreeService>;
  event: Client<typeof EventService>;
}>;

type LogCapture = Readonly<{
  stream: Writable;
}>;

type OutputCapture = Readonly<{
  chunks: string[];
  stream: Writable;
}>;

type DatabaseState = Readonly<{
  trees: readonly Record<string, unknown>[];
  revisions: readonly Record<string, unknown>[];
  nodes: readonly Record<string, unknown>[];
  attentions: readonly Record<string, unknown>[];
  commands: readonly Record<string, unknown>[];
  idempotency: readonly Record<string, unknown>[];
  events: readonly Record<string, unknown>[];
}>;

type CliCapture = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;
type JsonTimestamp = Readonly<{ seconds: string; nanos: number }>;
type JsonArtifact = Readonly<{ artifact_id: string; artifact_type: string }>;
type JsonInput = Readonly<{ artifact_id: string; source_node_id: string }>;
type JsonOutput =
  | Readonly<{ artifact: JsonArtifact }>
  | Readonly<{ implementation: Readonly<Record<string, never>> }>;
type JsonNodeBudget = Readonly<{ max_attempts: number }>;
type JsonNode = Readonly<{
  id: string;
  tree_id: string;
  repository_id: string;
  host_id: string;
  parent_node_id?: string;
  plan_revision_id: string;
  mode: string;
  objective: string;
  acceptance_criteria: readonly string[];
  inputs: readonly JsonInput[];
  state: string;
  version: string;
  created_at: JsonTimestamp;
  updated_at: JsonTimestamp;
  allowed_repository_paths: readonly string[];
  budget: JsonNodeBudget;
  artifact?: JsonArtifact;
  implementation?: Readonly<Record<string, never>>;
}>;
type JsonRevision = Readonly<{
  id: string;
  tree_id: string;
  ordinal: string;
  goal: string;
  state: string;
  version: string;
  created_at: JsonTimestamp;
  approved_at?: JsonTimestamp;
  superseded_at?: JsonTimestamp;
}>;
type JsonAttention = Readonly<{
  id: string;
  tree_id: string;
  plan_revision_id?: string;
  kind: string;
  message: string;
  state: string;
  created_at: JsonTimestamp;
  resolved_at?: JsonTimestamp;
}>;
type JsonBudget = Readonly<{
  max_depth: number;
  max_fan_out: number;
  max_nodes: number;
  max_concurrency: number;
  max_attempts_per_node: number;
}>;
type JsonTree = Readonly<{
  id: string;
  repository_id: string;
  host_id: string;
  base_commit: string;
  goal: string;
  active_plan_revision_id: string;
  root_node_id: string;
  state: string;
  version: string;
  created_at: JsonTimestamp;
  updated_at: JsonTimestamp;
  revisions: readonly JsonRevision[];
  nodes: readonly JsonNode[];
  budget: JsonBudget;
  attention?: JsonAttention;
}>;
type JsonSummary = Readonly<{
  id: string;
  repository_id: string;
  host_id: string;
  root_node_id: string;
  active_plan_revision_id: string;
  state: string;
  version: string;
}>;
type CliTreeResponse = Readonly<{ tree: JsonTree }>;
type CliListResponse = Readonly<{ trees: readonly JsonSummary[] }>;
type CliErrorResponse = Readonly<{ status: string; code: string; message: string }>;

class MutableClock implements Clock {
  #value: ClockTimestamp;

  constructor(milliseconds: number) {
    this.#value = timestampFromEpochMilliseconds(milliseconds);
  }

  now(): ClockTimestamp {
    return this.#value;
  }

  set(milliseconds: number): void {
    this.#value = timestampFromEpochMilliseconds(milliseconds);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireString(record: JsonRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function requireInteger(record: JsonRecord, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}

function requireArray(record: JsonRecord, field: string): readonly unknown[] {
  const value = record[field];
  if (!isUnknownArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  return value;
}

function requireStringArray(record: JsonRecord, field: string): readonly string[] {
  return requireArray(record, field).map((value, index) => {
    if (typeof value !== "string") {
      throw new TypeError(`${field}[${String(index)}] must be a string`);
    }
    return value;
  });
}

function assertExactKeys(
  record: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new TypeError(`unknown field ${key}`);
    }
  }
  for (const key of required) {
    if (!hasOwn(record, key)) {
      throw new TypeError(`missing field ${key}`);
    }
  }
}

function parseJsonTimestamp(value: unknown, field: string): JsonTimestamp {
  const timestamp = requireRecord(value, field);
  assertExactKeys(timestamp, ["seconds", "nanos"]);
  return {
    seconds: requireString(timestamp, "seconds"),
    nanos: requireInteger(timestamp, "nanos"),
  };
}

function parseJsonInput(value: unknown, field: string): JsonInput {
  const input = requireRecord(value, field);
  assertExactKeys(input, ["artifact_id", "source_node_id"]);
  return {
    artifact_id: requireString(input, "artifact_id"),
    source_node_id: requireString(input, "source_node_id"),
  };
}

function parseJsonArtifact(value: unknown, field: string): JsonArtifact {
  const artifact = requireRecord(value, field);
  assertExactKeys(artifact, ["artifact_id", "artifact_type"]);
  return {
    artifact_id: requireString(artifact, "artifact_id"),
    artifact_type: requireString(artifact, "artifact_type"),
  };
}

function parseJsonNode(value: unknown, index: number): JsonNode {
  const field = `nodes[${String(index)}]`;
  const node = requireRecord(value, field);
  assertExactKeys(
    node,
    [
      "id",
      "tree_id",
      "repository_id",
      "host_id",
      "plan_revision_id",
      "mode",
      "objective",
      "acceptance_criteria",
      "inputs",
      "state",
      "version",
      "created_at",
      "updated_at",
      "allowed_repository_paths",
      "budget",
    ],
    ["parent_node_id", "artifact", "implementation"],
  );
  const hasArtifact = hasOwn(node, "artifact");
  const hasImplementation = hasOwn(node, "implementation");
  if (hasArtifact === hasImplementation) {
    throw new TypeError(`${field} must contain exactly one output contract`);
  }
  if (hasImplementation) {
    const implementation = requireRecord(node["implementation"], `${field}.implementation`);
    assertExactKeys(implementation, []);
  }
  const parentNodeId = hasOwn(node, "parent_node_id")
    ? requireString(node, "parent_node_id")
    : undefined;
  const output: JsonOutput = hasArtifact
    ? { artifact: parseJsonArtifact(node["artifact"], `${field}.artifact`) }
    : { implementation: {} };
  return {
    id: requireString(node, "id"),
    tree_id: requireString(node, "tree_id"),
    repository_id: requireString(node, "repository_id"),
    host_id: requireString(node, "host_id"),
    ...(parentNodeId === undefined ? {} : { parent_node_id: parentNodeId }),
    plan_revision_id: requireString(node, "plan_revision_id"),
    mode: requireString(node, "mode"),
    objective: requireString(node, "objective"),
    acceptance_criteria: requireStringArray(node, "acceptance_criteria"),
    inputs: requireArray(node, "inputs").map((input, inputIndex) =>
      parseJsonInput(input, `${field}.inputs[${String(inputIndex)}]`),
    ),
    state: requireString(node, "state"),
    version: requireString(node, "version"),
    created_at: parseJsonTimestamp(node["created_at"], `${field}.created_at`),
    updated_at: parseJsonTimestamp(node["updated_at"], `${field}.updated_at`),
    allowed_repository_paths: requireStringArray(node, "allowed_repository_paths"),
    budget: parseJsonNodeBudget(node["budget"], `${field}.budget`),
    ...output,
  };
}

function parseJsonRevision(value: unknown, index: number): JsonRevision {
  const field = `revisions[${String(index)}]`;
  const revision = requireRecord(value, field);
  assertExactKeys(
    revision,
    ["id", "tree_id", "ordinal", "goal", "state", "version", "created_at"],
    ["approved_at", "superseded_at"],
  );
  const approvedAt = hasOwn(revision, "approved_at")
    ? parseJsonTimestamp(revision["approved_at"], `${field}.approved_at`)
    : undefined;
  const supersededAt = hasOwn(revision, "superseded_at")
    ? parseJsonTimestamp(revision["superseded_at"], `${field}.superseded_at`)
    : undefined;
  return {
    id: requireString(revision, "id"),
    tree_id: requireString(revision, "tree_id"),
    ordinal: requireString(revision, "ordinal"),
    goal: requireString(revision, "goal"),
    state: requireString(revision, "state"),
    version: requireString(revision, "version"),
    created_at: parseJsonTimestamp(revision["created_at"], `${field}.created_at`),
    ...(approvedAt === undefined ? {} : { approved_at: approvedAt }),
    ...(supersededAt === undefined ? {} : { superseded_at: supersededAt }),
  };
}

function parseJsonAttention(value: unknown): JsonAttention {
  const attention = requireRecord(value, "attention");
  assertExactKeys(
    attention,
    ["id", "tree_id", "kind", "message", "state", "created_at"],
    ["plan_revision_id", "resolved_at"],
  );
  const planRevisionId = hasOwn(attention, "plan_revision_id")
    ? requireString(attention, "plan_revision_id")
    : undefined;
  const resolvedAt = hasOwn(attention, "resolved_at")
    ? parseJsonTimestamp(attention["resolved_at"], "attention.resolved_at")
    : undefined;
  return {
    id: requireString(attention, "id"),
    tree_id: requireString(attention, "tree_id"),
    ...(planRevisionId === undefined ? {} : { plan_revision_id: planRevisionId }),
    kind: requireString(attention, "kind"),
    message: requireString(attention, "message"),
    state: requireString(attention, "state"),
    created_at: parseJsonTimestamp(attention["created_at"], "attention.created_at"),
    ...(resolvedAt === undefined ? {} : { resolved_at: resolvedAt }),
  };
}

function parseJsonBudget(value: unknown): JsonBudget {
  const budget = requireRecord(value, "budget");
  assertExactKeys(budget, [
    "max_depth",
    "max_fan_out",
    "max_nodes",
    "max_concurrency",
    "max_attempts_per_node",
  ]);
  return {
    max_depth: requireInteger(budget, "max_depth"),
    max_fan_out: requireInteger(budget, "max_fan_out"),
    max_nodes: requireInteger(budget, "max_nodes"),
    max_concurrency: requireInteger(budget, "max_concurrency"),
    max_attempts_per_node: requireInteger(budget, "max_attempts_per_node"),
  };
}
function parseJsonNodeBudget(value: unknown, field: string): JsonNodeBudget {
  const budget = requireRecord(value, field);
  assertExactKeys(budget, ["max_attempts"]);
  return { max_attempts: requireInteger(budget, "max_attempts") };
}

function parseJsonTree(value: unknown): JsonTree {
  const tree = requireRecord(value, "tree");
  assertExactKeys(
    tree,
    [
      "id",
      "repository_id",
      "host_id",
      "base_commit",
      "goal",
      "active_plan_revision_id",
      "root_node_id",
      "state",
      "version",
      "created_at",
      "updated_at",
      "revisions",
      "nodes",
      "budget",
    ],
    ["attention"],
  );
  const attention = hasOwn(tree, "attention") ? parseJsonAttention(tree["attention"]) : undefined;
  return {
    id: requireString(tree, "id"),
    repository_id: requireString(tree, "repository_id"),
    host_id: requireString(tree, "host_id"),
    base_commit: requireString(tree, "base_commit"),
    goal: requireString(tree, "goal"),
    active_plan_revision_id: requireString(tree, "active_plan_revision_id"),
    root_node_id: requireString(tree, "root_node_id"),
    state: requireString(tree, "state"),
    version: requireString(tree, "version"),
    created_at: parseJsonTimestamp(tree["created_at"], "tree.created_at"),
    updated_at: parseJsonTimestamp(tree["updated_at"], "tree.updated_at"),
    revisions: requireArray(tree, "revisions").map((revision, index) =>
      parseJsonRevision(revision, index),
    ),
    nodes: requireArray(tree, "nodes").map((node, index) => parseJsonNode(node, index)),
    budget: parseJsonBudget(tree["budget"]),
    ...(attention === undefined ? {} : { attention }),
  };
}

function parseCliTreeResponse(value: unknown): CliTreeResponse {
  const response = requireRecord(value, "response");
  assertExactKeys(response, ["tree"]);
  return { tree: parseJsonTree(response["tree"]) };
}

function parseJsonSummary(value: unknown, index: number): JsonSummary {
  const summary = requireRecord(value, `trees[${String(index)}]`);
  assertExactKeys(summary, [
    "id",
    "repository_id",
    "host_id",
    "root_node_id",
    "active_plan_revision_id",
    "state",
    "version",
  ]);
  return {
    id: requireString(summary, "id"),
    repository_id: requireString(summary, "repository_id"),
    host_id: requireString(summary, "host_id"),
    root_node_id: requireString(summary, "root_node_id"),
    active_plan_revision_id: requireString(summary, "active_plan_revision_id"),
    state: requireString(summary, "state"),
    version: requireString(summary, "version"),
  };
}

function parseCliListResponse(value: unknown): CliListResponse {
  const response = requireRecord(value, "response");
  assertExactKeys(response, ["trees"]);
  return {
    trees: requireArray(response, "trees").map((summary, index) =>
      parseJsonSummary(summary, index),
    ),
  };
}

function parseCliErrorResponse(value: unknown): CliErrorResponse {
  const response = requireRecord(value, "error");
  assertExactKeys(response, ["status", "code", "message"]);
  return {
    status: requireString(response, "status"),
    code: requireString(response, "code"),
    message: requireString(response, "message"),
  };
}

function createLogCapture(): LogCapture {
  return {
    stream: new Writable({
      write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        callback();
      },
    }),
  };
}

function createOutputCapture(): OutputCapture {
  const chunks: string[] = [];
  return {
    chunks,
    stream: new Writable({
      write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        chunks.push(chunk.toString("utf8"));
        callback();
      },
    }),
  };
}

function connectClients(baseUrl: string): Clients {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "1.1",
    useBinaryFormat: true,
    nodeOptions: { agent: false },
  });
  return {
    system: createClient(SystemService, transport),
    repository: createClient(RepositoryService, transport),
    tree: createClient(TreeService, transport),
    event: createClient(EventService, transport),
  };
}

function runtimeOptions(
  home: string,
  port: number,
  clock: Clock,
  ids: SequenceIdGenerator,
  logger: StructuredLogger,
): DaemonRuntimeOptions {
  return {
    home,
    mode: "local",
    port,
    serverVersion: "1.0.0",
    clock,
    ids,
    logger,
    displayName: "tree-service-test-host",
  };
}

function registerRequest(
  commandId: string,
  actorSessionId: string,
  repositoryId: string,
  rootPath: string,
) {
  return create(RegisterRepositoryRequestSchema, {
    commandId,
    actorSessionId,
    repositoryId,
    rootPath,
  });
}

function treeBudget(
  maxDepth = 4,
  maxFanOut = 4,
  maxNodes = 8,
  maxConcurrency = 4,
  maxAttemptsPerNode = 2,
): TreeBudget {
  return create(TreeBudgetSchema, {
    maxDepth,
    maxFanOut,
    maxNodes,
    maxConcurrency,
    maxAttemptsPerNode,
  });
}

function createTreeRequest(
  commandId: string,
  actorSessionId: string,
  repositoryId: string,
  treeId: string,
  planRevisionId: string,
  rootNodeId: string,
  rootArtifactId: string,
  attentionId: string,
  goal: string,
  baseCommit: string,
  budget: TreeBudget,
) {
  return create(CreateTreeRequestSchema, {
    commandId,
    actorSessionId,
    repositoryId,
    treeId,
    planRevisionId,
    rootNodeId,
    rootArtifactId,
    goal,
    baseCommit,
    budget,
    rootAllowedRepositoryPaths: [CONNECT_SCOPE_ROOT],
    attentionId,
  });
}

function proposedImplementationNode(
  nodeId: string,
  parentNodeId: string,
  objective: string,
  acceptanceCriteria: readonly string[],
) {
  return create(ProposedNodeSchema, {
    nodeId,
    parentNodeId,
    mode: PlanNodeMode.IMPLEMENTATION,
    objective,
    acceptanceCriteria: [...acceptanceCriteria],
    inputs: [],
    outputContract: {
      case: "implementation",
      value: create(ImplementationOutputContractSchema, {}),
    },
    allowedRepositoryPaths: [...CONNECT_SCOPE_IMPLEMENTATION],
  });
}

function proposedResearchNode(
  nodeId: string,
  parentNodeId: string,
  objective: string,
  acceptanceCriteria: readonly string[],
  artifactId: string,
) {
  return create(ProposedNodeSchema, {
    nodeId,
    parentNodeId,
    mode: PlanNodeMode.RESEARCH,
    objective,
    acceptanceCriteria: [...acceptanceCriteria],
    inputs: [
      create(ArtifactInputSchema, {
        artifactId: CONNECT_ROOT_ARTIFACT_ID,
        sourceNodeId: CONNECT_ROOT_NODE_ID,
      }),
    ],
    outputContract: {
      case: "artifact",
      value: create(ArtifactOutputContractSchema, {
        artifactId,
        artifactType: "research/notes",
      }),
    },
    allowedRepositoryPaths: [...CONNECT_SCOPE_IMPLEMENTATION],
  });
}

function proposedResearchNodeForCli(
  nodeId: string,
  parentNodeId: string,
  objective: string,
  acceptanceCriteria: readonly string[],
  artifactId: string,
  rootArtifactId: string,
  rootNodeId: string,
) {
  return {
    nodeId,
    parentNodeId,
    mode: "PLAN_NODE_MODE_RESEARCH",
    objective,
    acceptanceCriteria: [...acceptanceCriteria],
    inputs: [{ artifactId: rootArtifactId, sourceNodeId: rootNodeId }],
    allowedRepositoryPaths: [...CLI_SCOPE_IMPLEMENTATION],
    artifact: { artifactId, artifactType: "research/notes" },
  };
}

function timestampMessage(milliseconds: number) {
  const value = BigInt(milliseconds);
  return create(TimestampSchema, {
    seconds: value / 1_000n,
    nanos: Number(value % 1_000n) * 1_000_000,
  });
}

function expectedRevision(
  id: string,
  treeId: string,
  ordinal: number,
  goal: string,
  state: PlanRevisionState,
  version: bigint,
  createdAtMs: number,
  approvedAtMs?: number,
  supersededAtMs?: number,
): PlanRevision {
  return create(PlanRevisionSchema, {
    id,
    treeId,
    ordinal: BigInt(ordinal),
    goal,
    state,
    version,
    createdAt: timestampMessage(createdAtMs),
    ...(approvedAtMs === undefined ? {} : { approvedAt: timestampMessage(approvedAtMs) }),
    ...(supersededAtMs === undefined ? {} : { supersededAt: timestampMessage(supersededAtMs) }),
  });
}

function expectedArtifactNode(
  id: string,
  treeId: string,
  repositoryId: string,
  hostId: string,
  planRevisionId: string,
  mode: PlanNodeMode,
  objective: string,
  acceptanceCriteria: readonly string[],
  artifactId: string,
  artifactType: string,
  state: NodeState,
  version: bigint,
  createdAtMs: number,
  updatedAtMs: number,
  parentNodeId?: string,
  inputs: readonly Readonly<{ artifactId: string; sourceNodeId: string }>[] = [],
): TaskNode {
  return create(TaskNodeSchema, {
    id,
    treeId,
    repositoryId,
    hostId,
    ...(parentNodeId === undefined ? {} : { parentNodeId }),
    planRevisionId,
    mode,
    objective,
    acceptanceCriteria: [...acceptanceCriteria],
    inputs: inputs.map((input) => create(ArtifactInputSchema, input)),
    outputContract: {
      case: "artifact",
      value: create(ArtifactOutputContractSchema, { artifactId, artifactType }),
    },
    state,
    allowedRepositoryPaths:
      mode === PlanNodeMode.PLAN ? [CONNECT_SCOPE_ROOT] : [...CONNECT_SCOPE_IMPLEMENTATION],
    budget: create(NodeBudgetSchema, { maxAttempts: 2 }),
    version,
    createdAt: timestampMessage(createdAtMs),
    updatedAt: timestampMessage(updatedAtMs),
  });
}

function expectedImplementationNode(
  id: string,
  treeId: string,
  repositoryId: string,
  hostId: string,
  planRevisionId: string,
  objective: string,
  acceptanceCriteria: readonly string[],
  state: NodeState,
  version: bigint,
  createdAtMs: number,
  updatedAtMs: number,
  parentNodeId: string,
): TaskNode {
  return create(TaskNodeSchema, {
    id,
    treeId,
    repositoryId,
    hostId,
    parentNodeId,
    planRevisionId,
    mode: PlanNodeMode.IMPLEMENTATION,
    objective,
    acceptanceCriteria: [...acceptanceCriteria],
    inputs: [],
    outputContract: {
      case: "implementation",
      value: create(ImplementationOutputContractSchema, {}),
    },
    state,
    allowedRepositoryPaths: [...CONNECT_SCOPE_IMPLEMENTATION],
    budget: create(NodeBudgetSchema, { maxAttempts: 2 }),
    version,
    createdAt: timestampMessage(createdAtMs),
    updatedAt: timestampMessage(updatedAtMs),
  });
}

function expectedAttention(
  id: string,
  treeId: string,
  planRevisionId: string,
  createdAtMs: number,
): PlanAttention {
  return create(PlanAttentionSchema, {
    id,
    treeId,
    planRevisionId,
    kind: PlanAttentionKind.PLAN_REQUIRED,
    message: "tree requires an initial plan",
    state: PlanAttentionState.OPEN,
    createdAt: timestampMessage(createdAtMs),
  });
}

function expectedTree(input: {
  treeId: string;
  repositoryId: string;
  hostId: string;
  baseCommit: string;
  goal: string;
  activePlanRevisionId: string;
  rootNodeId: string;
  state: TreeState;
  version: bigint;
  createdAtMs: number;
  updatedAtMs: number;
  revisions: readonly PlanRevision[];
  nodes: readonly TaskNode[];
  budget: TreeBudget;
  attention?: PlanAttention;
}): TaskTree {
  return create(TaskTreeSchema, {
    id: input.treeId,
    repositoryId: input.repositoryId,
    hostId: input.hostId,
    baseCommit: input.baseCommit,
    goal: input.goal,
    activePlanRevisionId: input.activePlanRevisionId,
    rootNodeId: input.rootNodeId,
    state: input.state,
    version: input.version,
    createdAt: timestampMessage(input.createdAtMs),
    updatedAt: timestampMessage(input.updatedAtMs),
    revisions: [...input.revisions],
    nodes: [...input.nodes],
    budget: input.budget,
    ...(input.attention === undefined ? {} : { attention: input.attention }),
  });
}

function expectedSummary(
  treeId: string,
  repositoryId: string,
  hostId: string,
  rootNodeId: string,
  activePlanRevisionId: string,
  state: TreeState,
  version: bigint,
) {
  return create(TreeSummarySchema, {
    id: treeId,
    repositoryId,
    hostId,
    rootNodeId,
    activePlanRevisionId,
    state,
    version,
  });
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const GATE_PROFILE_FIXTURE = `required_categories:
  - lint
gates:
  lint:
    executable: "true"
`;

async function createGitFixture(name: string): Promise<GitFixture> {
  const directory = await mkdtemp(join(tmpdir(), `minions-tree-service-${name}-`));
  const origin = join(directory, "origin.git");
  const root = join(directory, "working");
  const remote = `https://github.com/Minions/${name}`;
  try {
    await runGit(directory, ["init", "--bare", origin]);
    await runGit(directory, ["clone", origin, root]);
    await runGit(root, ["config", "user.name", "Tree Service Test"]);
    await runGit(root, ["config", "user.email", "tree-service@example.test"]);
    await runGit(root, ["checkout", "-b", "main"]);
    await writeFile(join(root, "README.md"), `${name}\n`, "utf8");
    await mkdir(join(root, ".minions"), { recursive: true });
    await writeFile(join(root, ".minions", "gates.yaml"), GATE_PROFILE_FIXTURE, "utf8");
    await runGit(root, ["add", "README.md", ".minions/gates.yaml"]);
    await runGit(root, ["commit", "-m", "initial"]);
    await runGit(root, ["push", "--set-upstream", "origin", "main"]);
    await runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await runGit(root, ["fetch", "origin"]);
    await runGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const baseCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    await runGit(root, ["remote", "set-url", "origin", remote]);
    return { directory, origin, root, remote, baseCommit };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const rejectOnError = (error: Error): void => {
    reject(error);
  };
  server.once("error", rejectOnError);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.off("error", rejectOnError);
      reject(new Error("loopback port reservation did not bind to a TCP address"));
      return;
    }
    server.close((error) => {
      server.off("error", rejectOnError);
      if (error === undefined) {
        resolve(address.port);
      } else {
        reject(error);
      }
    });
  });
  return promise;
}

async function closeWritable(stream: Writable): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  stream.end((error?: Error | null) => {
    if (error === undefined || error === null) {
      resolve(undefined);
    } else {
      reject(error);
    }
  });
  await promise;
}

async function captureCli(action: () => Promise<number>): Promise<CliCapture> {
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const originalStdout = process.stdout;
  const originalStderr = process.stderr;
  Object.defineProperty(process, "stdout", { configurable: true, value: stdout.stream });
  Object.defineProperty(process, "stderr", { configurable: true, value: stderr.stream });
  try {
    const code = await action();
    return {
      code,
      stdout: stdout.chunks.join(""),
      stderr: stderr.chunks.join(""),
    };
  } finally {
    Object.defineProperty(process, "stdout", { configurable: true, value: originalStdout });
    Object.defineProperty(process, "stderr", { configurable: true, value: originalStderr });
    await closeWritable(stdout.stream);
    await closeWritable(stderr.stream);
  }
}

async function captureCliJson<T>(
  action: () => Promise<number>,
  parse: (value: unknown) => T,
): Promise<Readonly<{ code: number; json: T }>> {
  const captured = await captureCli(action);
  expect(captured.stderr).toBe("");
  if (captured.stdout.length === 0) {
    throw new Error("CLI did not produce JSON output");
  }
  return { code: captured.code, json: parse(JSON.parse(captured.stdout)) };
}

async function expectConnectCode<T>(
  action: () => Promise<T>,
  expected: Code,
): Promise<ConnectError> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConnectError);
  if (!(thrown instanceof ConnectError)) {
    throw new Error("expected a ConnectError");
  }
  expect(thrown.code).toBe(expected);
  return thrown;
}

function withReadOnlyDatabase<T>(path: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readBigInts: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function readDatabaseState(path: string): DatabaseState {
  return withReadOnlyDatabase(path, (database) => ({
    trees: database.prepare("SELECT * FROM trees ORDER BY id").all(),
    revisions: database.prepare("SELECT * FROM plan_revisions ORDER BY tree_id, ordinal").all(),
    nodes: database.prepare("SELECT * FROM nodes ORDER BY tree_id, created_at_ms, rowid").all(),
    attentions: database
      .prepare("SELECT * FROM plan_attentions ORDER BY tree_id, created_at_ms, id")
      .all(),
    commands: database.prepare("SELECT * FROM operator_commands ORDER BY id").all(),
    idempotency: database.prepare("SELECT * FROM idempotency_records ORDER BY command_id").all(),
    events: database.prepare("SELECT * FROM events ORDER BY sequence").all(),
  }));
}

function jsonTimestamp(milliseconds: number): JsonTimestamp {
  const value = BigInt(milliseconds);
  return { seconds: (value / 1_000n).toString(), nanos: Number(value % 1_000n) * 1_000_000 };
}

function jsonRevision(
  id: string,
  treeId: string,
  ordinal: number,
  goal: string,
  state: string,
  version: number,
  createdAtMs: number,
  approvedAtMs?: number,
  supersededAtMs?: number,
): JsonRevision {
  return {
    id,
    tree_id: treeId,
    ordinal: String(ordinal),
    goal,
    state,
    version: String(version),
    created_at: jsonTimestamp(createdAtMs),
    ...(approvedAtMs === undefined ? {} : { approved_at: jsonTimestamp(approvedAtMs) }),
    ...(supersededAtMs === undefined ? {} : { superseded_at: jsonTimestamp(supersededAtMs) }),
  };
}

function jsonArtifactNode(
  input: Readonly<{
    id: string;
    treeId: string;
    repositoryId: string;
    hostId: string;
    parentNodeId?: string;
    planRevisionId: string;
    mode: string;
    objective: string;
    acceptanceCriteria: readonly string[];
    inputs: readonly JsonInput[];
    artifactId: string;
    artifactType: string;
    state: string;
    version: number;
    createdAtMs: number;
    updatedAtMs: number;
  }>,
): JsonNode {
  return {
    id: input.id,
    tree_id: input.treeId,
    repository_id: input.repositoryId,
    host_id: input.hostId,
    ...(input.parentNodeId === undefined ? {} : { parent_node_id: input.parentNodeId }),
    plan_revision_id: input.planRevisionId,
    mode: input.mode,
    objective: input.objective,
    acceptance_criteria: [...input.acceptanceCriteria],
    inputs: [...input.inputs],
    state: input.state,
    allowed_repository_paths:
      input.mode === "PLAN_NODE_MODE_PLAN" ? [CLI_SCOPE_ROOT] : [...CLI_SCOPE_IMPLEMENTATION],
    budget: { max_attempts: 2 },
    version: String(input.version),
    created_at: jsonTimestamp(input.createdAtMs),
    updated_at: jsonTimestamp(input.updatedAtMs),
    artifact: { artifact_id: input.artifactId, artifact_type: input.artifactType },
  };
}

function jsonImplementationNode(
  input: Readonly<{
    id: string;
    treeId: string;
    repositoryId: string;
    hostId: string;
    parentNodeId: string;
    planRevisionId: string;
    objective: string;
    acceptanceCriteria: readonly string[];
    state: string;
    version: number;
    createdAtMs: number;
    updatedAtMs: number;
  }>,
): JsonNode {
  return {
    id: input.id,
    tree_id: input.treeId,
    repository_id: input.repositoryId,
    host_id: input.hostId,
    parent_node_id: input.parentNodeId,
    plan_revision_id: input.planRevisionId,
    mode: "PLAN_NODE_MODE_IMPLEMENTATION",
    objective: input.objective,
    acceptance_criteria: [...input.acceptanceCriteria],
    inputs: [],
    state: input.state,
    allowed_repository_paths: [...CLI_SCOPE_IMPLEMENTATION],
    budget: { max_attempts: 2 },
    version: String(input.version),
    created_at: jsonTimestamp(input.createdAtMs),
    updated_at: jsonTimestamp(input.updatedAtMs),
    implementation: {},
  };
}

function jsonSummary(
  id: string,
  repositoryId: string,
  hostId: string,
  rootNodeId: string,
  revisionId: string,
  state: string,
  version: number,
): JsonSummary {
  return {
    id,
    repository_id: repositoryId,
    host_id: hostId,
    root_node_id: rootNodeId,
    active_plan_revision_id: revisionId,
    state,
    version: String(version),
  };
}

function requireNode(tree: JsonTree, id: string): JsonNode {
  const node = tree.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`tree node ${id} is missing`);
  }
  return node;
}

function requireArtifact(node: JsonNode): JsonArtifact {
  if (node.artifact === undefined) {
    throw new Error(`node ${node.id} does not have an artifact output`);
  }
  return node.artifact;
}

describe("tree service integration", () => {
  it("round-trips real Connect tree planning, typed failures, supersession, pagination, snapshots, and restart reads", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-tree-service-connect-home-"));
    const fixture = await createGitFixture("connect");
    const capture = createLogCapture();
    const clock = new MutableClock(STARTED_AT_MS);
    let runtime: RunningDaemonRuntime | undefined;
    let restartedRuntime: RunningDaemonRuntime | undefined;
    try {
      const port = await reserveLoopbackPort();
      const logger = createStructuredLogger({ stream: capture.stream, now: () => clock.now() });
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([
            CONNECT_INSTANCE_ID,
            CONNECT_HOST_CANDIDATE_ID,
            CONNECT_REGISTER_EVENT_ID,
            CONNECT_CREATE_EVENT_ID,
            CONNECT_PROPOSE_EVENT_ID,
            CONNECT_APPROVE_EVENT_ID,
            CONNECT_SECOND_PROPOSE_EVENT_ID,
            CONNECT_SECOND_APPROVE_EVENT_ID,
            CONNECT_SECOND_CREATE_EVENT_ID,
          ]),
          logger,
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const clients = connectClients(runtime.server.baseUrl);
      const serverInfo = await clients.system.getServerInfo(
        create(GetServerInfoRequestSchema, {
          clientName: "tree-service-connect-test",
          apiVersion: create(ApiVersionSchema, { major: 1 }),
        }),
      );
      expect(serverInfo.capabilities).toContain(ServerCapability.TREE_PLANNING);

      const registered = await clients.repository.registerRepository(
        registerRequest(
          CONNECT_REGISTER_COMMAND_ID,
          CONNECT_ACTOR_SESSION_ID,
          CONNECT_REPOSITORY_ID,
          fixture.root,
        ),
      );
      expect(registered.repository).toMatchObject({
        id: CONNECT_REPOSITORY_ID,
        hostId,
        canonicalRoot: await realpath(fixture.root),
        canonicalRemote: fixture.remote,
        defaultBranch: "main",
        baseCommit: fixture.baseCommit,
      });

      await expectConnectCode(
        () =>
          clients.tree.getTree({
            treeId: "01900000-0000-4000-8000-000000000001",
          }),
        Code.InvalidArgument,
      );
      await expectConnectCode(
        () =>
          clients.tree.getTree({
            treeId: "01900000-0000-7000-8000-00000000ffff",
          }),
        Code.NotFound,
      );

      const budget = treeBudget();
      const createdResponse = await clients.tree.createTree(
        createTreeRequest(
          CONNECT_CREATE_COMMAND_ID,
          CONNECT_ACTOR_SESSION_ID,
          CONNECT_REPOSITORY_ID,
          CONNECT_TREE_ID,
          CONNECT_INITIAL_REVISION_ID,
          CONNECT_ROOT_NODE_ID,
          CONNECT_ROOT_ARTIFACT_ID,
          CONNECT_ATTENTION_ID,
          CONNECT_INITIAL_GOAL,
          fixture.baseCommit,
          budget,
        ),
      );
      const created = createdResponse.tree;
      if (created === undefined) {
        throw new Error("create response did not contain a tree");
      }
      const createdExpected = expectedTree({
        treeId: CONNECT_TREE_ID,
        repositoryId: CONNECT_REPOSITORY_ID,
        hostId,
        baseCommit: fixture.baseCommit,
        goal: CONNECT_INITIAL_GOAL,
        activePlanRevisionId: CONNECT_INITIAL_REVISION_ID,
        rootNodeId: CONNECT_ROOT_NODE_ID,
        state: TreeState.DRAFT,
        version: 0n,
        createdAtMs: STARTED_AT_MS,
        updatedAtMs: STARTED_AT_MS,
        revisions: [
          expectedRevision(
            CONNECT_INITIAL_REVISION_ID,
            CONNECT_TREE_ID,
            1,
            CONNECT_INITIAL_GOAL,
            PlanRevisionState.DRAFT,
            0n,
            STARTED_AT_MS,
          ),
        ],
        nodes: [
          expectedArtifactNode(
            CONNECT_ROOT_NODE_ID,
            CONNECT_TREE_ID,
            CONNECT_REPOSITORY_ID,
            hostId,
            CONNECT_INITIAL_REVISION_ID,
            PlanNodeMode.PLAN,
            CONNECT_INITIAL_GOAL,
            [CONNECT_INITIAL_GOAL],
            CONNECT_ROOT_ARTIFACT_ID,
            "plan",
            NodeState.PLANNED,
            0n,
            STARTED_AT_MS,
            STARTED_AT_MS,
          ),
        ],
        budget,
        attention: expectedAttention(
          CONNECT_ATTENTION_ID,
          CONNECT_TREE_ID,
          CONNECT_INITIAL_REVISION_ID,
          STARTED_AT_MS,
        ),
      });
      expect(created).toEqual(createdExpected);
      const createdSnapshot = await clients.event.getSnapshot({});
      expect(createdSnapshot.attention).toEqual([
        create(AttentionSummarySchema, {
          nodeId: CONNECT_ROOT_NODE_ID,
          kind: AttentionKind.HUMAN_INPUT,
        }),
      ]);

      const invalidTopologyRequest = create(ProposePlanRequestSchema, {
        commandId: CONNECT_BAD_REVISION_ID,
        actorSessionId: CONNECT_ACTOR_SESSION_ID,
        treeId: CONNECT_TREE_ID,
        planRevisionId: CONNECT_BAD_REVISION_ID,
        goal: CONNECT_FIRST_PLAN_GOAL,
        nodes: [
          create(ProposedNodeSchema, {
            nodeId: CONNECT_BAD_NODE_ID,
            parentNodeId: "01900000-0000-7000-8000-00000000fffe",
            mode: PlanNodeMode.IMPLEMENTATION,
            objective: "invalid parent",
            acceptanceCriteria: ["never persists"],
            inputs: [],
            outputContract: {
              case: "implementation",
              value: create(ImplementationOutputContractSchema, {}),
            },
            allowedRepositoryPaths: [...CONNECT_SCOPE_IMPLEMENTATION],
          }),
        ],
      });
      await expectConnectCode(
        () => clients.tree.proposePlan(invalidTopologyRequest),
        Code.FailedPrecondition,
      );
      const afterInvalidTopology = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(afterInvalidTopology.commands).toHaveLength(2);
      expect(afterInvalidTopology.idempotency).toHaveLength(2);
      expect(afterInvalidTopology.events).toHaveLength(2);

      clock.set(CONNECT_PROPOSED_AT_MS);
      const firstProposalRequest = create(ProposePlanRequestSchema, {
        commandId: CONNECT_PROPOSAL_COMMAND_ID,
        actorSessionId: CONNECT_ACTOR_SESSION_ID,
        treeId: CONNECT_TREE_ID,
        planRevisionId: CONNECT_PROPOSAL_REVISION_ID,
        goal: CONNECT_FIRST_PLAN_GOAL,
        nodes: [
          proposedImplementationNode(
            CONNECT_CHILD_NODE_ID,
            CONNECT_ROOT_NODE_ID,
            CONNECT_CHILD_OBJECTIVE,
            ["the first child is implementable"],
          ),
          proposedResearchNode(
            CONNECT_DEEP_NODE_ID,
            CONNECT_CHILD_NODE_ID,
            CONNECT_DEEP_OBJECTIVE,
            ["the first child output is researched"],
            CONNECT_DEEP_ARTIFACT_ID,
          ),
        ],
      });
      const firstProposedResponse = await clients.tree.proposePlan(firstProposalRequest);
      const firstProposed = firstProposedResponse.tree;
      if (firstProposed === undefined) {
        throw new Error("first proposal response did not contain a tree");
      }
      expect(firstProposed).toEqual(
        expectedTree({
          treeId: CONNECT_TREE_ID,
          repositoryId: CONNECT_REPOSITORY_ID,
          hostId,
          baseCommit: fixture.baseCommit,
          goal: CONNECT_FIRST_PLAN_GOAL,
          activePlanRevisionId: CONNECT_PROPOSAL_REVISION_ID,
          rootNodeId: CONNECT_ROOT_NODE_ID,
          state: TreeState.DRAFT,
          version: 1n,
          createdAtMs: STARTED_AT_MS,
          updatedAtMs: CONNECT_PROPOSED_AT_MS,
          revisions: [
            expectedRevision(
              CONNECT_INITIAL_REVISION_ID,
              CONNECT_TREE_ID,
              1,
              CONNECT_INITIAL_GOAL,
              PlanRevisionState.DRAFT,
              0n,
              STARTED_AT_MS,
            ),
            expectedRevision(
              CONNECT_PROPOSAL_REVISION_ID,
              CONNECT_TREE_ID,
              2,
              CONNECT_FIRST_PLAN_GOAL,
              PlanRevisionState.DRAFT,
              0n,
              CONNECT_PROPOSED_AT_MS,
            ),
          ],
          nodes: [
            expectedArtifactNode(
              CONNECT_ROOT_NODE_ID,
              CONNECT_TREE_ID,
              CONNECT_REPOSITORY_ID,
              hostId,
              CONNECT_INITIAL_REVISION_ID,
              PlanNodeMode.PLAN,
              CONNECT_INITIAL_GOAL,
              [CONNECT_INITIAL_GOAL],
              CONNECT_ROOT_ARTIFACT_ID,
              "plan",
              NodeState.PLANNED,
              0n,
              STARTED_AT_MS,
              STARTED_AT_MS,
            ),
            expectedImplementationNode(
              CONNECT_CHILD_NODE_ID,
              CONNECT_TREE_ID,
              CONNECT_REPOSITORY_ID,
              hostId,
              CONNECT_PROPOSAL_REVISION_ID,
              CONNECT_CHILD_OBJECTIVE,
              ["the first child is implementable"],
              NodeState.PLANNED,
              0n,
              CONNECT_PROPOSED_AT_MS,
              CONNECT_PROPOSED_AT_MS,
              CONNECT_ROOT_NODE_ID,
            ),
            expectedArtifactNode(
              CONNECT_DEEP_NODE_ID,
              CONNECT_TREE_ID,
              CONNECT_REPOSITORY_ID,
              hostId,
              CONNECT_PROPOSAL_REVISION_ID,
              PlanNodeMode.RESEARCH,
              CONNECT_DEEP_OBJECTIVE,
              ["the first child output is researched"],
              CONNECT_DEEP_ARTIFACT_ID,
              "research/notes",
              NodeState.PLANNED,
              0n,
              CONNECT_PROPOSED_AT_MS,
              CONNECT_PROPOSED_AT_MS,
              CONNECT_CHILD_NODE_ID,
              [{ artifactId: CONNECT_ROOT_ARTIFACT_ID, sourceNodeId: CONNECT_ROOT_NODE_ID }],
            ),
          ],
          budget,
        }),
      );
      const proposedSnapshot = await clients.event.getSnapshot({});
      expect(proposedSnapshot.attention).toEqual([]);
      const resolvedAttention = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(resolvedAttention.attentions).toHaveLength(1);
      expect(resolvedAttention.attentions[0]).toMatchObject({
        id: CONNECT_ATTENTION_ID,
        tree_id: CONNECT_TREE_ID,
        plan_revision_id: CONNECT_INITIAL_REVISION_ID,
        kind: "plan_required",
        message: "tree requires an initial plan",
        state_kind: "resolved",
        created_at_ms: BigInt(STARTED_AT_MS),
        resolved_at_ms: BigInt(CONNECT_PROPOSED_AT_MS),
      });

      const changedFactsRequest = create(ProposePlanRequestSchema, {
        ...firstProposalRequest,
        goal: "changed facts must not replay",
      });
      await expectConnectCode(
        () => clients.tree.proposePlan(changedFactsRequest),
        Code.FailedPrecondition,
      );
      const afterChangedFacts = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(afterChangedFacts.commands).toHaveLength(3);
      expect(afterChangedFacts.idempotency).toHaveLength(3);
      expect(afterChangedFacts.events).toHaveLength(3);

      clock.set(CONNECT_APPROVED_AT_MS);
      const firstApproveResponse = await clients.tree.approvePlan(
        create(ApprovePlanRequestSchema, {
          commandId: CONNECT_APPROVE_COMMAND_ID,
          actorSessionId: CONNECT_ACTOR_SESSION_ID,
          treeId: CONNECT_TREE_ID,
          planRevisionId: CONNECT_PROPOSAL_REVISION_ID,
        }),
      );
      const firstApproved = firstApproveResponse.tree;
      if (firstApproved === undefined) {
        throw new Error("first approval response did not contain a tree");
      }
      expect(firstApproved.state).toBe(TreeState.APPROVED);
      expect(firstApproved.nodes.find((node) => node.id === CONNECT_CHILD_NODE_ID)?.state).toBe(
        NodeState.READY,
      );
      expect(firstApproved.nodes.find((node) => node.id === CONNECT_DEEP_NODE_ID)?.state).toBe(
        NodeState.PLANNED,
      );
      expect(firstApproved.revisions[1]?.state).toBe(PlanRevisionState.APPROVED);
      expect(firstApproved.attention).toBeUndefined();

      clock.set(CONNECT_SECOND_PROPOSED_AT_MS);
      const secondProposalResponse = await clients.tree.proposePlan(
        create(ProposePlanRequestSchema, {
          commandId: CONNECT_SECOND_PROPOSAL_COMMAND_ID,
          actorSessionId: CONNECT_ACTOR_SESSION_ID,
          treeId: CONNECT_TREE_ID,
          planRevisionId: CONNECT_SECOND_REVISION_ID,
          goal: CONNECT_SECOND_PLAN_GOAL,
          nodes: [
            proposedImplementationNode(
              CONNECT_SECOND_CHILD_NODE_ID,
              CONNECT_ROOT_NODE_ID,
              CONNECT_SECOND_CHILD_OBJECTIVE,
              ["the final child is implementable"],
            ),
            proposedResearchNode(
              CONNECT_SECOND_DEEP_NODE_ID,
              CONNECT_SECOND_CHILD_NODE_ID,
              CONNECT_SECOND_DEEP_OBJECTIVE,
              ["the final child output is researched"],
              CONNECT_SECOND_DEEP_ARTIFACT_ID,
            ),
          ],
        }),
      );
      const secondProposed = secondProposalResponse.tree;
      if (secondProposed === undefined) {
        throw new Error("second proposal response did not contain a tree");
      }
      expect(secondProposed.revisions).toEqual([
        expectedRevision(
          CONNECT_INITIAL_REVISION_ID,
          CONNECT_TREE_ID,
          1,
          CONNECT_INITIAL_GOAL,
          PlanRevisionState.DRAFT,
          0n,
          STARTED_AT_MS,
        ),
        expectedRevision(
          CONNECT_PROPOSAL_REVISION_ID,
          CONNECT_TREE_ID,
          2,
          CONNECT_FIRST_PLAN_GOAL,
          PlanRevisionState.SUPERSEDED,
          2n,
          CONNECT_PROPOSED_AT_MS,
          CONNECT_APPROVED_AT_MS,
          CONNECT_SECOND_PROPOSED_AT_MS,
        ),
        expectedRevision(
          CONNECT_SECOND_REVISION_ID,
          CONNECT_TREE_ID,
          3,
          CONNECT_SECOND_PLAN_GOAL,
          PlanRevisionState.DRAFT,
          0n,
          CONNECT_SECOND_PROPOSED_AT_MS,
        ),
      ]);
      expect(
        secondProposed.nodes.filter((node) => node.state === NodeState.SUPERSEDED),
      ).toHaveLength(2);

      clock.set(CONNECT_SECOND_APPROVED_AT_MS);
      const approvedResponse = await clients.tree.approvePlan(
        create(ApprovePlanRequestSchema, {
          commandId: CONNECT_SECOND_APPROVE_COMMAND_ID,
          actorSessionId: CONNECT_ACTOR_SESSION_ID,
          treeId: CONNECT_TREE_ID,
          planRevisionId: CONNECT_SECOND_REVISION_ID,
        }),
      );
      const approved = approvedResponse.tree;
      if (approved === undefined) {
        throw new Error("final approval response did not contain a tree");
      }
      const approvedExpected = expectedTree({
        treeId: CONNECT_TREE_ID,
        repositoryId: CONNECT_REPOSITORY_ID,
        hostId,
        baseCommit: fixture.baseCommit,
        goal: CONNECT_SECOND_PLAN_GOAL,
        activePlanRevisionId: CONNECT_SECOND_REVISION_ID,
        rootNodeId: CONNECT_ROOT_NODE_ID,
        state: TreeState.APPROVED,
        version: 4n,
        createdAtMs: STARTED_AT_MS,
        updatedAtMs: CONNECT_SECOND_APPROVED_AT_MS,
        revisions: [
          expectedRevision(
            CONNECT_INITIAL_REVISION_ID,
            CONNECT_TREE_ID,
            1,
            CONNECT_INITIAL_GOAL,
            PlanRevisionState.DRAFT,
            0n,
            STARTED_AT_MS,
          ),
          expectedRevision(
            CONNECT_PROPOSAL_REVISION_ID,
            CONNECT_TREE_ID,
            2,
            CONNECT_FIRST_PLAN_GOAL,
            PlanRevisionState.SUPERSEDED,
            2n,
            CONNECT_PROPOSED_AT_MS,
            CONNECT_APPROVED_AT_MS,
            CONNECT_SECOND_PROPOSED_AT_MS,
          ),
          expectedRevision(
            CONNECT_SECOND_REVISION_ID,
            CONNECT_TREE_ID,
            3,
            CONNECT_SECOND_PLAN_GOAL,
            PlanRevisionState.APPROVED,
            1n,
            CONNECT_SECOND_PROPOSED_AT_MS,
            CONNECT_SECOND_APPROVED_AT_MS,
          ),
        ],
        nodes: [
          expectedArtifactNode(
            CONNECT_ROOT_NODE_ID,
            CONNECT_TREE_ID,
            CONNECT_REPOSITORY_ID,
            hostId,
            CONNECT_INITIAL_REVISION_ID,
            PlanNodeMode.PLAN,
            CONNECT_INITIAL_GOAL,
            [CONNECT_INITIAL_GOAL],
            CONNECT_ROOT_ARTIFACT_ID,
            "plan",
            NodeState.PLANNED,
            0n,
            STARTED_AT_MS,
            STARTED_AT_MS,
          ),
          expectedImplementationNode(
            CONNECT_CHILD_NODE_ID,
            CONNECT_TREE_ID,
            CONNECT_REPOSITORY_ID,
            hostId,
            CONNECT_PROPOSAL_REVISION_ID,
            CONNECT_CHILD_OBJECTIVE,
            ["the first child is implementable"],
            NodeState.SUPERSEDED,
            2n,
            CONNECT_PROPOSED_AT_MS,
            CONNECT_SECOND_PROPOSED_AT_MS,
            CONNECT_ROOT_NODE_ID,
          ),
          expectedArtifactNode(
            CONNECT_DEEP_NODE_ID,
            CONNECT_TREE_ID,
            CONNECT_REPOSITORY_ID,
            hostId,
            CONNECT_PROPOSAL_REVISION_ID,
            PlanNodeMode.RESEARCH,
            CONNECT_DEEP_OBJECTIVE,
            ["the first child output is researched"],
            CONNECT_DEEP_ARTIFACT_ID,
            "research/notes",
            NodeState.SUPERSEDED,
            1n,
            CONNECT_PROPOSED_AT_MS,
            CONNECT_SECOND_PROPOSED_AT_MS,
            CONNECT_CHILD_NODE_ID,
            [{ artifactId: CONNECT_ROOT_ARTIFACT_ID, sourceNodeId: CONNECT_ROOT_NODE_ID }],
          ),
          expectedImplementationNode(
            CONNECT_SECOND_CHILD_NODE_ID,
            CONNECT_TREE_ID,
            CONNECT_REPOSITORY_ID,
            hostId,
            CONNECT_SECOND_REVISION_ID,
            CONNECT_SECOND_CHILD_OBJECTIVE,
            ["the final child is implementable"],
            NodeState.READY,
            1n,
            CONNECT_SECOND_PROPOSED_AT_MS,
            CONNECT_SECOND_APPROVED_AT_MS,
            CONNECT_ROOT_NODE_ID,
          ),
          expectedArtifactNode(
            CONNECT_SECOND_DEEP_NODE_ID,
            CONNECT_TREE_ID,
            CONNECT_REPOSITORY_ID,
            hostId,
            CONNECT_SECOND_REVISION_ID,
            PlanNodeMode.RESEARCH,
            CONNECT_SECOND_DEEP_OBJECTIVE,
            ["the final child output is researched"],
            CONNECT_SECOND_DEEP_ARTIFACT_ID,
            "research/notes",
            NodeState.PLANNED,
            0n,
            CONNECT_SECOND_PROPOSED_AT_MS,
            CONNECT_SECOND_PROPOSED_AT_MS,
            CONNECT_SECOND_CHILD_NODE_ID,
            [{ artifactId: CONNECT_ROOT_ARTIFACT_ID, sourceNodeId: CONNECT_ROOT_NODE_ID }],
          ),
        ],
        budget,
      });
      expect(approved).toEqual(approvedExpected);

      clock.set(CONNECT_SECOND_APPROVED_AT_MS);
      const secondCreatedResponse = await clients.tree.createTree(
        createTreeRequest(
          CONNECT_SECOND_CREATE_COMMAND_ID,
          CONNECT_ACTOR_SESSION_ID,
          CONNECT_REPOSITORY_ID,
          CONNECT_SECOND_TREE_ID,
          CONNECT_SECOND_INITIAL_REVISION_ID,
          CONNECT_SECOND_ROOT_NODE_ID,
          CONNECT_SECOND_ROOT_ARTIFACT_ID,
          CONNECT_SECOND_ATTENTION_ID,
          "second tree",
          fixture.baseCommit,
          budget,
        ),
      );
      const secondCreated = secondCreatedResponse.tree;
      if (secondCreated === undefined) {
        throw new Error("second create response did not contain a tree");
      }
      expect(secondCreated.state).toBe(TreeState.DRAFT);
      expect(secondCreated.version).toBe(0n);
      expect(secondCreated.attention?.state).toBe(PlanAttentionState.OPEN);

      const firstPage = await clients.tree.listTrees(
        create(ListTreesRequestSchema, { pageSize: 1 }),
      );
      expect(firstPage.trees).toEqual([
        expectedSummary(
          CONNECT_TREE_ID,
          CONNECT_REPOSITORY_ID,
          hostId,
          CONNECT_ROOT_NODE_ID,
          CONNECT_SECOND_REVISION_ID,
          TreeState.APPROVED,
          4n,
        ),
      ]);
      expect(firstPage.nextPageToken).toBe(CONNECT_TREE_ID);
      const secondPage = await clients.tree.listTrees(
        create(ListTreesRequestSchema, { pageSize: 1, pageToken: firstPage.nextPageToken }),
      );
      expect(secondPage.trees).toEqual([
        expectedSummary(
          CONNECT_SECOND_TREE_ID,
          CONNECT_REPOSITORY_ID,
          hostId,
          CONNECT_SECOND_ROOT_NODE_ID,
          CONNECT_SECOND_INITIAL_REVISION_ID,
          TreeState.DRAFT,
          0n,
        ),
      ]);
      expect(secondPage.nextPageToken).toBeUndefined();

      const snapshot = await clients.event.getSnapshot({});
      expect(snapshot.trees).toEqual([
        expectedSummary(
          CONNECT_TREE_ID,
          CONNECT_REPOSITORY_ID,
          hostId,
          CONNECT_ROOT_NODE_ID,
          CONNECT_SECOND_REVISION_ID,
          TreeState.APPROVED,
          4n,
        ),
        expectedSummary(
          CONNECT_SECOND_TREE_ID,
          CONNECT_REPOSITORY_ID,
          hostId,
          CONNECT_SECOND_ROOT_NODE_ID,
          CONNECT_SECOND_INITIAL_REVISION_ID,
          TreeState.DRAFT,
          0n,
        ),
      ]);
      expect(snapshot.attention).toEqual([
        create(AttentionSummarySchema, {
          nodeId: CONNECT_SECOND_ROOT_NODE_ID,
          kind: AttentionKind.HUMAN_INPUT,
        }),
      ]);
      expect(snapshot.lastSequence).toBe(7n);
      expect(snapshot.minimumAvailableSequence).toBe(1n);

      const hostDatabasePath = join(home, "hosts", hostId, "host.db");
      const persisted = readDatabaseState(hostDatabasePath);
      expect(persisted.trees).toHaveLength(2);
      expect(persisted.revisions).toHaveLength(4);
      expect(persisted.nodes).toHaveLength(6);
      expect(persisted.attentions).toHaveLength(2);
      expect(persisted.commands).toHaveLength(7);
      expect(persisted.idempotency).toHaveLength(7);
      expect(persisted.events).toHaveLength(7);
      expect(
        persisted.revisions.find((row) => row["id"] === CONNECT_PROPOSAL_REVISION_ID),
      ).toMatchObject({
        state_kind: "superseded",
        version: 2n,
        approved_at_ms: BigInt(CONNECT_APPROVED_AT_MS),
        superseded_at_ms: BigInt(CONNECT_SECOND_PROPOSED_AT_MS),
      });
      expect(persisted.attentions.find((row) => row["id"] === CONNECT_ATTENTION_ID)).toMatchObject({
        state_kind: "resolved",
        resolved_at_ms: BigInt(CONNECT_PROPOSED_AT_MS),
      });
      expect(
        persisted.attentions.find((row) => row["id"] === CONNECT_SECOND_ATTENTION_ID),
      ).toMatchObject({
        state_kind: "open",
        resolved_at_ms: null,
      });

      await runtime.close();
      runtime = undefined;
      const restartedClock = new MutableClock(RESTARTED_AT_MS);
      const restartedLogger = createStructuredLogger({
        stream: capture.stream,
        now: () => restartedClock.now(),
      });
      restartedRuntime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          restartedClock,
          new SequenceIdGenerator([CONNECT_RESTART_INSTANCE_ID, CONNECT_RESTART_HOST_CANDIDATE_ID]),
          restartedLogger,
        ),
      );
      expect(restartedRuntime.hostId).toBe(hostId);
      const restartedClients = connectClients(restartedRuntime.server.baseUrl);
      const restartedTreeResponse = await restartedClients.tree.getTree({
        treeId: CONNECT_TREE_ID,
      });
      if (restartedTreeResponse.tree === undefined) {
        throw new Error("restart get response did not contain a tree");
      }
      expect(restartedTreeResponse.tree).toEqual(approvedExpected);
      const restartedFirstPage = await restartedClients.tree.listTrees(
        create(ListTreesRequestSchema, { pageSize: 1 }),
      );
      expect(restartedFirstPage).toEqual(firstPage);
      const restartedSecondPage = await restartedClients.tree.listTrees(
        create(ListTreesRequestSchema, {
          pageSize: 1,
          pageToken: restartedFirstPage.nextPageToken,
        }),
      );
      expect(restartedSecondPage).toEqual(secondPage);
      const restartedSnapshot = await restartedClients.event.getSnapshot({});
      expect(restartedSnapshot.trees).toEqual(snapshot.trees);
      expect(restartedSnapshot.attention).toEqual(snapshot.attention);
      expect(restartedSnapshot.lastSequence).toBe(7n);
      expect(restartedSnapshot.minimumAvailableSequence).toBe(1n);
      await restartedRuntime.close();
      restartedRuntime = undefined;
    } finally {
      await restartedRuntime?.close();
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });

  it("returns the daemon-recorded VCS change binding on GetTree", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-tree-service-vcs-binding-home-"));
    const fixture = await createGitFixture("vcs-binding");
    const capture = createLogCapture();
    const clock = new MutableClock(STARTED_AT_MS);
    let runtime: RunningDaemonRuntime | undefined;
    let restartedRuntime: RunningDaemonRuntime | undefined;
    try {
      const port = await reserveLoopbackPort();
      const logger = createStructuredLogger({ stream: capture.stream, now: () => clock.now() });
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([
            VCS_BINDING_INSTANCE_ID,
            VCS_BINDING_HOST_CANDIDATE_ID,
            VCS_BINDING_REGISTER_EVENT_ID,
            VCS_BINDING_CREATE_EVENT_ID,
          ]),
          logger,
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const clients = connectClients(runtime.server.baseUrl);
      await clients.repository.registerRepository(
        registerRequest(
          VCS_BINDING_REGISTER_COMMAND_ID,
          VCS_BINDING_ACTOR_SESSION_ID,
          VCS_BINDING_REPOSITORY_ID,
          fixture.root,
        ),
      );

      const createdResponse = await clients.tree.createTree(
        createTreeRequest(
          VCS_BINDING_CREATE_COMMAND_ID,
          VCS_BINDING_ACTOR_SESSION_ID,
          VCS_BINDING_REPOSITORY_ID,
          VCS_BINDING_TREE_ID,
          VCS_BINDING_INITIAL_REVISION_ID,
          VCS_BINDING_ROOT_NODE_ID,
          VCS_BINDING_ROOT_ARTIFACT_ID,
          VCS_BINDING_ATTENTION_ID,
          VCS_BINDING_GOAL,
          fixture.baseCommit,
          treeBudget(),
        ),
      );
      const created = createdResponse.tree;
      if (created === undefined) {
        throw new Error("create response did not contain a tree");
      }
      const rootNodeBeforeBinding = expectedArtifactNode(
        VCS_BINDING_ROOT_NODE_ID,
        VCS_BINDING_TREE_ID,
        VCS_BINDING_REPOSITORY_ID,
        hostId,
        VCS_BINDING_INITIAL_REVISION_ID,
        PlanNodeMode.PLAN,
        VCS_BINDING_GOAL,
        [VCS_BINDING_GOAL],
        VCS_BINDING_ROOT_ARTIFACT_ID,
        "plan",
        NodeState.PLANNED,
        0n,
        STARTED_AT_MS,
        STARTED_AT_MS,
      );
      // No binding exists yet: an unstarted plan node's field stays unset.
      expect(created.nodes).toEqual([rootNodeBeforeBinding]);
      expect(created.nodes[0]?.vcsChangeBinding).toBeUndefined();

      await runtime.close();
      runtime = undefined;

      const bindingDatabase = await openHostDatabase({
        path: join(home, "hosts", hostId, "host.db"),
        clock,
      });
      try {
        await createSqliteVcsChangeBindingStore({ database: bindingDatabase }).upsertBinding({
          treeId: taskTreeId(VCS_BINDING_TREE_ID),
          nodeId: taskNodeId(VCS_BINDING_ROOT_NODE_ID),
          jjChangeId: contentHash(VCS_BINDING_JJ_CHANGE_ID),
          currentCommitId: gitSha(VCS_BINDING_CURRENT_COMMIT_ID),
          parentChangeId: undefined,
          bookmark: undefined,
          rewriteGeneration: 0,
          lastJjOperationId: contentHash(VCS_BINDING_LAST_JJ_OPERATION_ID),
          lastPushedCommitId: undefined,
          lastReviewedCommitId: undefined,
          conflictState: "clean",
          recordedAt: timestampFromEpochMilliseconds(STARTED_AT_MS),
        });
      } finally {
        await bindingDatabase.close();
      }

      const restartedClock = new MutableClock(RESTARTED_AT_MS);
      const restartedLogger = createStructuredLogger({
        stream: capture.stream,
        now: () => restartedClock.now(),
      });
      restartedRuntime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          restartedClock,
          new SequenceIdGenerator([
            VCS_BINDING_RESTART_INSTANCE_ID,
            VCS_BINDING_RESTART_HOST_CANDIDATE_ID,
          ]),
          restartedLogger,
        ),
      );
      expect(restartedRuntime.hostId).toBe(hostId);
      const restartedClients = connectClients(restartedRuntime.server.baseUrl);
      const restartedTreeResponse = await restartedClients.tree.getTree({
        treeId: VCS_BINDING_TREE_ID,
      });
      const restartedTree = restartedTreeResponse.tree;
      if (restartedTree === undefined) {
        throw new Error("restarted get response did not contain a tree");
      }
      const expectedBinding = create(VcsChangeBindingSchema, {
        jjChangeId: VCS_BINDING_JJ_CHANGE_ID,
        currentCommitId: VCS_BINDING_CURRENT_COMMIT_ID,
        rewriteGeneration: 0,
        lastJjOperationId: VCS_BINDING_LAST_JJ_OPERATION_ID,
        conflictState: VcsConflictState.CLEAN,
      });
      expect(restartedTree.nodes).toHaveLength(1);
      expect(restartedTree.nodes[0]?.vcsChangeBinding).toEqual(expectedBinding);
      expect(restartedTree.nodes[0]).toEqual({
        ...rootNodeBeforeBinding,
        vcsChangeBinding: expectedBinding,
      });

      await restartedRuntime.close();
      restartedRuntime = undefined;
    } finally {
      await restartedRuntime?.close();
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });

  it("reads a tree after a node mutation lands later than the last tree-level command", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-tree-service-scheduler-clock-home-"));
    const fixture = await createGitFixture("scheduler-clock");
    const capture = createLogCapture();
    const clock = new MutableClock(STARTED_AT_MS);
    let runtime: RunningDaemonRuntime | undefined;
    let restartedRuntime: RunningDaemonRuntime | undefined;
    try {
      const port = await reserveLoopbackPort();
      const logger = createStructuredLogger({ stream: capture.stream, now: () => clock.now() });
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([
            SCHEDULER_CLOCK_INSTANCE_ID,
            SCHEDULER_CLOCK_HOST_CANDIDATE_ID,
            SCHEDULER_CLOCK_REGISTER_EVENT_ID,
            SCHEDULER_CLOCK_CREATE_EVENT_ID,
            SCHEDULER_CLOCK_PROPOSE_EVENT_ID,
            SCHEDULER_CLOCK_APPROVE_EVENT_ID,
          ]),
          logger,
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const clients = connectClients(runtime.server.baseUrl);
      await clients.repository.registerRepository(
        registerRequest(
          CONNECT_REGISTER_COMMAND_ID,
          CONNECT_ACTOR_SESSION_ID,
          CONNECT_REPOSITORY_ID,
          fixture.root,
        ),
      );
      const createdResponse = await clients.tree.createTree(
        createTreeRequest(
          CONNECT_CREATE_COMMAND_ID,
          CONNECT_ACTOR_SESSION_ID,
          CONNECT_REPOSITORY_ID,
          CONNECT_TREE_ID,
          CONNECT_INITIAL_REVISION_ID,
          CONNECT_ROOT_NODE_ID,
          CONNECT_ROOT_ARTIFACT_ID,
          CONNECT_ATTENTION_ID,
          CONNECT_INITIAL_GOAL,
          fixture.baseCommit,
          treeBudget(),
        ),
      );
      expect(createdResponse.tree?.id).toBe(CONNECT_TREE_ID);

      clock.set(CONNECT_PROPOSED_AT_MS);
      const proposedResponse = await clients.tree.proposePlan(
        create(ProposePlanRequestSchema, {
          commandId: CONNECT_PROPOSAL_COMMAND_ID,
          actorSessionId: CONNECT_ACTOR_SESSION_ID,
          treeId: CONNECT_TREE_ID,
          planRevisionId: CONNECT_PROPOSAL_REVISION_ID,
          goal: CONNECT_FIRST_PLAN_GOAL,
          nodes: [
            proposedImplementationNode(
              CONNECT_CHILD_NODE_ID,
              CONNECT_ROOT_NODE_ID,
              CONNECT_CHILD_OBJECTIVE,
              ["the scheduler child is implementable"],
            ),
            proposedResearchNode(
              CONNECT_DEEP_NODE_ID,
              CONNECT_CHILD_NODE_ID,
              CONNECT_DEEP_OBJECTIVE,
              ["the scheduler child output is researched"],
              CONNECT_DEEP_ARTIFACT_ID,
            ),
          ],
        }),
      );
      const proposed = proposedResponse.tree;
      if (proposed === undefined) {
        throw new Error("proposal response did not contain a tree");
      }
      expect(proposed.nodes.find((node) => node.id === CONNECT_CHILD_NODE_ID)?.state).toBe(
        NodeState.PLANNED,
      );

      clock.set(CONNECT_APPROVED_AT_MS);
      const approvedResponse = await clients.tree.approvePlan(
        create(ApprovePlanRequestSchema, {
          commandId: CONNECT_APPROVE_COMMAND_ID,
          actorSessionId: CONNECT_ACTOR_SESSION_ID,
          treeId: CONNECT_TREE_ID,
          planRevisionId: CONNECT_PROPOSAL_REVISION_ID,
        }),
      );
      const approved = approvedResponse.tree;
      if (approved === undefined) {
        throw new Error("approval response did not contain a tree");
      }
      expect(approved.state).toBe(TreeState.APPROVED);
      expect(approved.nodes.find((node) => node.id === CONNECT_CHILD_NODE_ID)?.state).toBe(
        NodeState.READY,
      );

      const activatedAtMs = CONNECT_APPROVED_AT_MS + 1000;
      clock.set(activatedAtMs);

      await runtime.close();
      runtime = undefined;

      const schedulerDatabase = await openHostDatabase({
        path: join(home, "hosts", hostId, "host.db"),
        clock,
      });
      try {
        const scheduler = createSqliteSchedulerStore({
          database: schedulerDatabase,
          ids: new SequenceIdGenerator([SCHEDULER_CLOCK_ATTEMPT_ID, SCHEDULER_CLOCK_LEASE_ID]),
        });
        const lease = await scheduler.claimNext({
          ownerId: schedulerOwnerId("tree-service-scheduler-clock-test"),
          at: clock.now(),
          leaseDurationMs: 60_000,
          capacity: schedulerCapacityPolicy(4, 4),
        });
        if (lease === undefined) {
          throw new Error("scheduler did not claim the ready node");
        }
        expect(lease.nodeId).toBe(CONNECT_CHILD_NODE_ID);
      } finally {
        await schedulerDatabase.close();
      }

      const hostDatabasePath = join(home, "hosts", hostId, "host.db");
      const persisted = readDatabaseState(hostDatabasePath);
      const persistedTree = persisted.trees.find((tree) => tree["id"] === CONNECT_TREE_ID);
      const persistedChild = persisted.nodes.find((node) => node["id"] === CONNECT_CHILD_NODE_ID);
      expect(persistedTree?.["updated_at_ms"]).toBe(BigInt(CONNECT_APPROVED_AT_MS));
      expect(persistedChild?.["state_kind"]).toBe("active");
      expect(persistedChild?.["updated_at_ms"]).toBe(BigInt(activatedAtMs));

      const restartedClock = new MutableClock(activatedAtMs + 1000);
      const restartedLogger = createStructuredLogger({
        stream: capture.stream,
        now: () => restartedClock.now(),
      });
      restartedRuntime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          restartedClock,
          new SequenceIdGenerator([
            SCHEDULER_CLOCK_RESTART_INSTANCE_ID,
            SCHEDULER_CLOCK_RESTART_HOST_CANDIDATE_ID,
          ]),
          restartedLogger,
        ),
      );
      expect(restartedRuntime.hostId).toBe(hostId);
      const restartedClients = connectClients(restartedRuntime.server.baseUrl);
      const rereadResponse = await restartedClients.tree.getTree({
        treeId: CONNECT_TREE_ID,
      });
      const reread = rereadResponse.tree;
      if (reread === undefined) {
        throw new Error("reread get response did not contain a tree");
      }
      expect(reread.state).toBe(TreeState.APPROVED);
      expect(reread.nodes.find((node) => node.id === CONNECT_CHILD_NODE_ID)?.state).toBe(
        NodeState.ACTIVE,
      );

      await restartedRuntime.close();
      restartedRuntime = undefined;
    } finally {
      await restartedRuntime?.close();
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });

  it("round-trips CLI tree create, get, list, propose, and approve with strict JSON and durable restart reads", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-tree-service-cli-home-"));
    const fixture = await createGitFixture("cli");
    const capture = createLogCapture();
    const clock = new MutableClock(STARTED_AT_MS);
    let runtime: RunningDaemonRuntime | undefined;
    let restartedRuntime: RunningDaemonRuntime | undefined;
    let planPath: string | undefined;
    let malformedPlanPath: string | undefined;
    try {
      const port = await reserveLoopbackPort();
      const logger = createStructuredLogger({ stream: capture.stream, now: () => clock.now() });
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([
            CLI_INSTANCE_ID,
            CLI_HOST_CANDIDATE_ID,
            CLI_REGISTER_EVENT_ID,
            CLI_CREATE_EVENT_ID,
            CLI_PROPOSE_EVENT_ID,
            CLI_APPROVE_EVENT_ID,
          ]),
          logger,
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const registered = await connectClients(runtime.server.baseUrl).repository.registerRepository(
        registerRequest(
          CLI_REGISTER_COMMAND_ID,
          CLI_ACTOR_SESSION_ID,
          CLI_REPOSITORY_ID,
          fixture.root,
        ),
      );
      expect(registered.repository?.id).toBe(CLI_REPOSITORY_ID);

      const missingRootScope = await captureCli(() =>
        runCli([
          "tree",
          "create",
          CLI_REPOSITORY_ID,
          CLI_INITIAL_GOAL,
          fixture.baseCommit,
          "--max-depth",
          "4",
          "--max-fan-out",
          "3",
          "--max-nodes",
          "8",
          "--max-concurrency",
          "2",
          "--max-attempts-per-node",
          "2",
          "--home",
          home,
        ]),
      );
      expect(missingRootScope.code).toBe(2);
      expect(missingRootScope.stdout).toBe("");
      expect(missingRootScope.stderr).toContain("--root-allowed-path");

      const created = await captureCliJson(
        () =>
          runCli([
            "tree",
            "create",
            CLI_REPOSITORY_ID,
            CLI_INITIAL_GOAL,
            fixture.baseCommit,
            "--max-depth",
            "4",
            "--max-fan-out",
            "3",
            "--max-nodes",
            "8",
            "--max-concurrency",
            "2",
            "--max-attempts-per-node",
            "2",
            "--root-allowed-path",
            CLI_SCOPE_ROOT,
            "--home",
            home,
          ]),
        parseCliTreeResponse,
      );
      expect(created.code).toBe(0);
      const createdTree = created.json.tree;
      expect(createdTree).toMatchObject({
        repository_id: CLI_REPOSITORY_ID,
        host_id: hostId,
        base_commit: fixture.baseCommit,
        goal: CLI_INITIAL_GOAL,
        state: "TREE_STATE_DRAFT",
        version: "0",
        created_at: jsonTimestamp(STARTED_AT_MS),
        updated_at: jsonTimestamp(STARTED_AT_MS),
        budget: {
          max_depth: 4,
          max_fan_out: 3,
          max_nodes: 8,
          max_concurrency: 2,
          max_attempts_per_node: 2,
        },
      });
      expect(typeof createdTree.active_plan_revision_id).toBe("string");
      expect(typeof createdTree.root_node_id).toBe("string");
      expect(createdTree.revisions).toEqual([
        jsonRevision(
          createdTree.active_plan_revision_id,
          createdTree.id,
          1,
          CLI_INITIAL_GOAL,
          "PLAN_REVISION_STATE_DRAFT",
          0,
          STARTED_AT_MS,
        ),
      ]);
      const createdRoot = requireNode(createdTree, createdTree.root_node_id);
      const createdRootArtifact = requireArtifact(createdRoot);
      expect(createdTree.nodes).toEqual([
        jsonArtifactNode({
          id: createdTree.root_node_id,
          treeId: createdTree.id,
          repositoryId: CLI_REPOSITORY_ID,
          hostId,
          planRevisionId: createdTree.active_plan_revision_id,
          mode: "PLAN_NODE_MODE_PLAN",
          objective: CLI_INITIAL_GOAL,
          acceptanceCriteria: [CLI_INITIAL_GOAL],
          inputs: [],
          artifactId: createdRootArtifact.artifact_id,
          artifactType: "plan",
          state: "NODE_STATE_PLANNED",
          version: 0,
          createdAtMs: STARTED_AT_MS,
          updatedAtMs: STARTED_AT_MS,
        }),
      ]);
      expect(createdTree.attention).toBeDefined();
      if (createdTree.attention === undefined) {
        throw new Error("create response did not contain plan attention");
      }
      expect(createdTree.attention).toEqual({
        id: createdTree.attention.id,
        tree_id: createdTree.id,
        plan_revision_id: createdTree.active_plan_revision_id,
        kind: "PLAN_ATTENTION_KIND_PLAN_REQUIRED",
        message: "tree requires an initial plan",
        state: "PLAN_ATTENTION_STATE_OPEN",
        created_at: jsonTimestamp(STARTED_AT_MS),
      });
      expect(typeof createdTree.attention.id).toBe("string");

      const fetched = await captureCliJson(
        () => runCli(["tree", "get", createdTree.id, "--home", home]),
        parseCliTreeResponse,
      );
      expect(fetched.code).toBe(0);
      expect(fetched.json.tree).toEqual(createdTree);
      const listedBeforePlan = await captureCliJson(
        () => runCli(["tree", "list", "--home", home]),
        parseCliListResponse,
      );
      expect(listedBeforePlan.code).toBe(0);
      expect(listedBeforePlan.json.trees).toEqual([
        jsonSummary(
          createdTree.id,
          CLI_REPOSITORY_ID,
          hostId,
          createdTree.root_node_id,
          createdTree.active_plan_revision_id,
          "TREE_STATE_DRAFT",
          0,
        ),
      ]);

      const beforeMalformedPlan = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      const malformedPath = join(home, "malformed-plan.json");
      malformedPlanPath = malformedPath;
      await writeFile(
        malformedPath,
        JSON.stringify({ goal: CLI_PLAN_GOAL, nodes: [], unexpected: true }),
        "utf8",
      );
      const malformed = await captureCli(() =>
        runCli([
          "tree",
          "propose",
          createdTree.id,
          CLI_PROPOSAL_REVISION_ID,
          malformedPath,
          "--home",
          home,
        ]),
      );
      expect(malformed.code).toBe(2);
      expect(malformed.stdout).toBe("");
      const malformedError = parseCliErrorResponse(JSON.parse(malformed.stderr));
      expect(malformedError).toMatchObject({
        status: "error",
        code: "invalid_usage",
      });
      expect(malformedError.message).toContain("unknown field unexpected");
      const afterMalformedPlan = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(afterMalformedPlan.commands).toHaveLength(beforeMalformedPlan.commands.length);
      expect(afterMalformedPlan.idempotency).toHaveLength(beforeMalformedPlan.idempotency.length);
      expect(afterMalformedPlan.events).toHaveLength(beforeMalformedPlan.events.length);

      const planRootArtifact = createdRootArtifact.artifact_id;
      planPath = join(home, "plan.json");
      await writeFile(
        planPath,
        JSON.stringify({
          goal: CLI_PLAN_GOAL,
          nodes: [
            {
              nodeId: CLI_CHILD_NODE_ID,
              parentNodeId: createdTree.root_node_id,
              mode: "PLAN_NODE_MODE_IMPLEMENTATION",
              objective: "implement the cli child",
              acceptanceCriteria: ["the cli child is implementable"],
              inputs: [],
              implementation: {},
              allowedRepositoryPaths: [...CLI_SCOPE_IMPLEMENTATION],
            },
            proposedResearchNodeForCli(
              CLI_DEEP_NODE_ID,
              CLI_CHILD_NODE_ID,
              "research the cli child output",
              ["the cli child output is researched"],
              CLI_DEEP_ARTIFACT_ID,
              planRootArtifact,
              createdTree.root_node_id,
            ),
          ],
        }),
        "utf8",
      );
      clock.set(CLI_PROPOSED_AT_MS);
      const proposed = await captureCliJson(
        () =>
          runCli([
            "tree",
            "propose",
            createdTree.id,
            CLI_PROPOSAL_REVISION_ID,
            planPath ?? "",
            "--home",
            home,
          ]),
        parseCliTreeResponse,
      );
      expect(proposed.code).toBe(0);
      const proposedTree = proposed.json.tree;
      const cliProposedRevisionId = proposedTree.active_plan_revision_id;
      expect(cliProposedRevisionId).toBe(CLI_PROPOSAL_REVISION_ID);
      expect(proposedTree).toMatchObject({
        id: createdTree.id,
        repository_id: CLI_REPOSITORY_ID,
        host_id: hostId,
        base_commit: fixture.baseCommit,
        goal: CLI_PLAN_GOAL,
        state: "TREE_STATE_DRAFT",
        version: "1",
        created_at: jsonTimestamp(STARTED_AT_MS),
        updated_at: jsonTimestamp(CLI_PROPOSED_AT_MS),
        budget: createdTree.budget,
      });
      expect(proposedTree.revisions).toEqual([
        jsonRevision(
          createdTree.active_plan_revision_id,
          createdTree.id,
          1,
          CLI_INITIAL_GOAL,
          "PLAN_REVISION_STATE_DRAFT",
          0,
          STARTED_AT_MS,
        ),
        jsonRevision(
          cliProposedRevisionId,
          createdTree.id,
          2,
          CLI_PLAN_GOAL,
          "PLAN_REVISION_STATE_DRAFT",
          0,
          CLI_PROPOSED_AT_MS,
        ),
      ]);
      expect(proposedTree.nodes).toEqual([
        jsonArtifactNode({
          id: createdTree.root_node_id,
          treeId: createdTree.id,
          repositoryId: CLI_REPOSITORY_ID,
          hostId,
          planRevisionId: createdTree.active_plan_revision_id,
          mode: "PLAN_NODE_MODE_PLAN",
          objective: CLI_INITIAL_GOAL,
          acceptanceCriteria: [CLI_INITIAL_GOAL],
          inputs: [],
          artifactId: planRootArtifact,
          artifactType: "plan",
          state: "NODE_STATE_PLANNED",
          version: 0,
          createdAtMs: STARTED_AT_MS,
          updatedAtMs: STARTED_AT_MS,
        }),
        jsonImplementationNode({
          id: CLI_CHILD_NODE_ID,
          treeId: createdTree.id,
          repositoryId: CLI_REPOSITORY_ID,
          hostId,
          parentNodeId: createdTree.root_node_id,
          planRevisionId: cliProposedRevisionId,
          objective: "implement the cli child",
          acceptanceCriteria: ["the cli child is implementable"],
          state: "NODE_STATE_PLANNED",
          version: 0,
          createdAtMs: CLI_PROPOSED_AT_MS,
          updatedAtMs: CLI_PROPOSED_AT_MS,
        }),
        jsonArtifactNode({
          id: CLI_DEEP_NODE_ID,
          treeId: createdTree.id,
          repositoryId: CLI_REPOSITORY_ID,
          hostId,
          parentNodeId: CLI_CHILD_NODE_ID,
          planRevisionId: cliProposedRevisionId,
          mode: "PLAN_NODE_MODE_RESEARCH",
          objective: "research the cli child output",
          acceptanceCriteria: ["the cli child output is researched"],
          inputs: [{ artifact_id: planRootArtifact, source_node_id: createdTree.root_node_id }],
          artifactId: CLI_DEEP_ARTIFACT_ID,
          artifactType: "research/notes",
          state: "NODE_STATE_PLANNED",
          version: 0,
          createdAtMs: CLI_PROPOSED_AT_MS,
          updatedAtMs: CLI_PROPOSED_AT_MS,
        }),
      ]);
      expect(proposedTree.attention).toBeUndefined();

      clock.set(CLI_APPROVED_AT_MS);
      const approved = await captureCliJson(
        () => runCli(["tree", "approve", createdTree.id, cliProposedRevisionId, "--home", home]),
        parseCliTreeResponse,
      );
      expect(approved.code).toBe(0);
      const approvedTree = approved.json.tree;
      expect(approvedTree).toMatchObject({
        id: createdTree.id,
        repository_id: CLI_REPOSITORY_ID,
        host_id: hostId,
        base_commit: fixture.baseCommit,
        goal: CLI_PLAN_GOAL,
        active_plan_revision_id: cliProposedRevisionId,
        root_node_id: createdTree.root_node_id,
        state: "TREE_STATE_APPROVED",
        version: "2",
        created_at: jsonTimestamp(STARTED_AT_MS),
        updated_at: jsonTimestamp(CLI_APPROVED_AT_MS),
        revisions: [
          jsonRevision(
            createdTree.active_plan_revision_id,
            createdTree.id,
            1,
            CLI_INITIAL_GOAL,
            "PLAN_REVISION_STATE_DRAFT",
            0,
            STARTED_AT_MS,
          ),
          jsonRevision(
            cliProposedRevisionId,
            createdTree.id,
            2,
            CLI_PLAN_GOAL,
            "PLAN_REVISION_STATE_APPROVED",
            1,
            CLI_PROPOSED_AT_MS,
            CLI_APPROVED_AT_MS,
          ),
        ],
        nodes: [
          jsonArtifactNode({
            id: createdTree.root_node_id,
            treeId: createdTree.id,
            repositoryId: CLI_REPOSITORY_ID,
            hostId,
            planRevisionId: createdTree.active_plan_revision_id,
            mode: "PLAN_NODE_MODE_PLAN",
            objective: CLI_INITIAL_GOAL,
            acceptanceCriteria: [CLI_INITIAL_GOAL],
            inputs: [],
            artifactId: planRootArtifact,
            artifactType: "plan",
            state: "NODE_STATE_PLANNED",
            version: 0,
            createdAtMs: STARTED_AT_MS,
            updatedAtMs: STARTED_AT_MS,
          }),
          jsonImplementationNode({
            id: CLI_CHILD_NODE_ID,
            treeId: createdTree.id,
            repositoryId: CLI_REPOSITORY_ID,
            hostId,
            parentNodeId: createdTree.root_node_id,
            planRevisionId: cliProposedRevisionId,
            objective: "implement the cli child",
            acceptanceCriteria: ["the cli child is implementable"],
            state: "NODE_STATE_READY",
            version: 1,
            createdAtMs: CLI_PROPOSED_AT_MS,
            updatedAtMs: CLI_APPROVED_AT_MS,
          }),
          jsonArtifactNode({
            id: CLI_DEEP_NODE_ID,
            treeId: createdTree.id,
            repositoryId: CLI_REPOSITORY_ID,
            hostId,
            parentNodeId: CLI_CHILD_NODE_ID,
            planRevisionId: cliProposedRevisionId,
            mode: "PLAN_NODE_MODE_RESEARCH",
            objective: "research the cli child output",
            acceptanceCriteria: ["the cli child output is researched"],
            inputs: [{ artifact_id: planRootArtifact, source_node_id: createdTree.root_node_id }],
            artifactId: CLI_DEEP_ARTIFACT_ID,
            artifactType: "research/notes",
            state: "NODE_STATE_PLANNED",
            version: 0,
            createdAtMs: CLI_PROPOSED_AT_MS,
            updatedAtMs: CLI_PROPOSED_AT_MS,
          }),
        ],
        budget: createdTree.budget,
      });
      expect(approvedTree.attention).toBeUndefined();
      const listedAfterApproval = await captureCliJson(
        () => runCli(["tree", "list", "--home", home]),
        parseCliListResponse,
      );
      expect(listedAfterApproval.json.trees).toEqual([
        jsonSummary(
          createdTree.id,
          CLI_REPOSITORY_ID,
          hostId,
          createdTree.root_node_id,
          cliProposedRevisionId,
          "TREE_STATE_APPROVED",
          2,
        ),
      ]);

      const hostDatabasePath = join(home, "hosts", hostId, "host.db");
      const persisted = readDatabaseState(hostDatabasePath);
      expect(persisted.commands).toHaveLength(4);
      expect(persisted.idempotency).toHaveLength(4);
      expect(persisted.events).toHaveLength(4);

      await runtime.close();
      runtime = undefined;
      const restartedClock = new MutableClock(RESTARTED_AT_MS);
      const restartedLogger = createStructuredLogger({
        stream: capture.stream,
        now: () => restartedClock.now(),
      });
      const restartedPort = await reserveLoopbackPort();
      restartedRuntime = await startDaemonRuntime(
        runtimeOptions(
          home,
          restartedPort,
          restartedClock,
          new SequenceIdGenerator([CLI_RESTART_INSTANCE_ID, CLI_RESTART_HOST_CANDIDATE_ID]),
          restartedLogger,
        ),
      );
      expect(restartedRuntime.hostId).toBe(hostId);
      const restartedGet = await captureCliJson(
        () => runCli(["tree", "get", createdTree.id, "--home", home]),
        parseCliTreeResponse,
      );
      expect(restartedGet.json.tree).toEqual(approvedTree);
      const restartedList = await captureCliJson(
        () => runCli(["tree", "list", "--home", home]),
        parseCliListResponse,
      );
      expect(restartedList.json.trees).toEqual(listedAfterApproval.json.trees);
      await restartedRuntime.close();
      restartedRuntime = undefined;
    } finally {
      await restartedRuntime?.close();
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(planPath ?? join(home, "plan.json"), { force: true });
      await rm(malformedPlanPath ?? join(home, "malformed-plan.json"), { force: true });
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });
  it("repairs a named Connect plan attention and preserves scope policy across restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-tree-service-connect-repair-home-"));
    const fixture = await createGitFixture("connect-repair");
    const capture = createLogCapture();
    const clock = new MutableClock(STARTED_AT_MS);
    let runtime: RunningDaemonRuntime | undefined;
    let restartedRuntime: RunningDaemonRuntime | undefined;
    try {
      const port = await reserveLoopbackPort();
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([
            CONNECT_REPAIR_INSTANCE_ID,
            CONNECT_REPAIR_HOST_CANDIDATE_ID,
            CONNECT_REPAIR_REGISTER_EVENT_ID,
            CONNECT_REPAIR_CREATE_EVENT_ID,
            CONNECT_REPAIR_EVENT_ID,
          ]),
          createStructuredLogger({ stream: capture.stream, now: () => clock.now() }),
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const clients = connectClients(runtime.server.baseUrl);
      const registered = await clients.repository.registerRepository(
        registerRequest(
          CONNECT_REPAIR_REGISTER_COMMAND_ID,
          CONNECT_REPAIR_ACTOR_SESSION_ID,
          CONNECT_REPAIR_REPOSITORY_ID,
          fixture.root,
        ),
      );
      expect(registered.repository?.id).toBe(CONNECT_REPAIR_REPOSITORY_ID);
      const budget = treeBudget();
      const createdResponse = await clients.tree.createTree(
        createTreeRequest(
          CONNECT_REPAIR_CREATE_COMMAND_ID,
          CONNECT_REPAIR_ACTOR_SESSION_ID,
          CONNECT_REPAIR_REPOSITORY_ID,
          CONNECT_REPAIR_TREE_ID,
          CONNECT_REPAIR_INITIAL_REVISION_ID,
          CONNECT_REPAIR_ROOT_NODE_ID,
          CONNECT_REPAIR_ROOT_ARTIFACT_ID,
          CONNECT_REPAIR_ATTENTION_ID,
          CONNECT_INITIAL_GOAL,
          fixture.baseCommit,
          budget,
        ),
      );
      const created = createdResponse.tree;
      const createdAttention = created?.attention;
      if (createdAttention === undefined) {
        throw new Error("repair fixture create response is missing plan attention");
      }
      const beforeMalformed = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      const malformedRequest = create(RepairPlanRequestSchema, {
        commandId: "01900000-0000-7000-8000-000000000416",
        actorSessionId: CONNECT_REPAIR_ACTOR_SESSION_ID,
        treeId: CONNECT_REPAIR_TREE_ID,
        planRevisionId: CONNECT_REPAIR_PLAN_REVISION_ID,
        attentionId: createdAttention.id,
        goal: CONNECT_REPAIR_GOAL,
        nodes: [
          create(ProposedNodeSchema, {
            nodeId: CONNECT_REPAIR_NODE_ID,
            parentNodeId: CONNECT_REPAIR_ROOT_NODE_ID,
            mode: PlanNodeMode.IMPLEMENTATION,
            objective: "repair the connect child",
            acceptanceCriteria: ["the repaired child is implementable"],
            inputs: [],
            outputContract: {
              case: "implementation",
              value: create(ImplementationOutputContractSchema, {}),
            },
            allowedRepositoryPaths: ["../escape"],
          }),
        ],
      });
      await expectConnectCode(
        () => clients.tree.repairPlan(malformedRequest),
        Code.InvalidArgument,
      );
      const afterMalformed = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(afterMalformed.commands).toHaveLength(beforeMalformed.commands.length);
      expect(afterMalformed.idempotency).toHaveLength(beforeMalformed.idempotency.length);
      expect(afterMalformed.events).toHaveLength(beforeMalformed.events.length);

      const wrongAttentionRequest = create(RepairPlanRequestSchema, {
        ...malformedRequest,
        commandId: "01900000-0000-7000-8000-000000000417",
        attentionId: "01900000-0000-7000-8000-000000000418",
        nodes: [
          proposedImplementationNode(
            CONNECT_REPAIR_NODE_ID,
            CONNECT_REPAIR_ROOT_NODE_ID,
            "repair the connect child",
            ["the repaired child is implementable"],
          ),
        ],
      });
      await expectConnectCode(
        () => clients.tree.repairPlan(wrongAttentionRequest),
        Code.FailedPrecondition,
      );
      const afterWrongAttention = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(afterWrongAttention.commands).toHaveLength(beforeMalformed.commands.length);
      expect(afterWrongAttention.idempotency).toHaveLength(beforeMalformed.idempotency.length);
      expect(afterWrongAttention.events).toHaveLength(beforeMalformed.events.length);

      clock.set(CONNECT_PROPOSED_AT_MS);
      const repairedResponse = await clients.tree.repairPlan(
        create(RepairPlanRequestSchema, {
          commandId: CONNECT_REPAIR_COMMAND_ID,
          actorSessionId: CONNECT_REPAIR_ACTOR_SESSION_ID,
          treeId: CONNECT_REPAIR_TREE_ID,
          planRevisionId: CONNECT_REPAIR_PLAN_REVISION_ID,
          attentionId: createdAttention.id,
          goal: CONNECT_REPAIR_GOAL,
          nodes: [
            proposedImplementationNode(
              CONNECT_REPAIR_NODE_ID,
              CONNECT_REPAIR_ROOT_NODE_ID,
              "repair the connect child",
              ["the repaired child is implementable"],
            ),
          ],
        }),
      );
      const repaired = repairedResponse.tree;
      if (repaired === undefined) {
        throw new Error("repair response did not contain a tree");
      }
      expect(repaired).toEqual(
        expectedTree({
          treeId: CONNECT_REPAIR_TREE_ID,
          repositoryId: CONNECT_REPAIR_REPOSITORY_ID,
          hostId,
          baseCommit: fixture.baseCommit,
          goal: CONNECT_REPAIR_GOAL,
          activePlanRevisionId: CONNECT_REPAIR_PLAN_REVISION_ID,
          rootNodeId: CONNECT_REPAIR_ROOT_NODE_ID,
          state: TreeState.DRAFT,
          version: 1n,
          createdAtMs: STARTED_AT_MS,
          updatedAtMs: CONNECT_PROPOSED_AT_MS,
          revisions: [
            expectedRevision(
              CONNECT_REPAIR_INITIAL_REVISION_ID,
              CONNECT_REPAIR_TREE_ID,
              1,
              CONNECT_INITIAL_GOAL,
              PlanRevisionState.DRAFT,
              0n,
              STARTED_AT_MS,
            ),
            expectedRevision(
              CONNECT_REPAIR_PLAN_REVISION_ID,
              CONNECT_REPAIR_TREE_ID,
              2,
              CONNECT_REPAIR_GOAL,
              PlanRevisionState.DRAFT,
              0n,
              CONNECT_PROPOSED_AT_MS,
            ),
          ],
          nodes: [
            expectedArtifactNode(
              CONNECT_REPAIR_ROOT_NODE_ID,
              CONNECT_REPAIR_TREE_ID,
              CONNECT_REPAIR_REPOSITORY_ID,
              hostId,
              CONNECT_REPAIR_INITIAL_REVISION_ID,
              PlanNodeMode.PLAN,
              CONNECT_INITIAL_GOAL,
              [CONNECT_INITIAL_GOAL],
              CONNECT_REPAIR_ROOT_ARTIFACT_ID,
              "plan",
              NodeState.PLANNED,
              0n,
              STARTED_AT_MS,
              STARTED_AT_MS,
            ),
            expectedImplementationNode(
              CONNECT_REPAIR_NODE_ID,
              CONNECT_REPAIR_TREE_ID,
              CONNECT_REPAIR_REPOSITORY_ID,
              hostId,
              CONNECT_REPAIR_PLAN_REVISION_ID,
              "repair the connect child",
              ["the repaired child is implementable"],
              NodeState.PLANNED,
              0n,
              CONNECT_PROPOSED_AT_MS,
              CONNECT_PROPOSED_AT_MS,
              CONNECT_REPAIR_ROOT_NODE_ID,
            ),
          ],
          budget,
        }),
      );
      expect(repaired.attention).toBeUndefined();
      expect((await clients.event.getSnapshot({})).attention).toEqual([]);
      const persisted = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(persisted.attentions).toHaveLength(1);
      expect(persisted.attentions[0]).toMatchObject({
        id: CONNECT_REPAIR_ATTENTION_ID,
        state_kind: "resolved",
        resolved_at_ms: BigInt(CONNECT_PROPOSED_AT_MS),
      });
      expect(persisted.commands).toHaveLength(3);
      expect(persisted.idempotency).toHaveLength(3);
      expect(persisted.events).toHaveLength(3);

      await runtime.close();
      runtime = undefined;
      const restartedClock = new MutableClock(RESTARTED_AT_MS);
      const restartedPort = await reserveLoopbackPort();
      restartedRuntime = await startDaemonRuntime(
        runtimeOptions(
          home,
          restartedPort,
          restartedClock,
          new SequenceIdGenerator([
            CONNECT_REPAIR_RESTART_INSTANCE_ID,
            CONNECT_REPAIR_RESTART_HOST_CANDIDATE_ID,
          ]),
          createStructuredLogger({ stream: capture.stream, now: () => restartedClock.now() }),
        ),
      );
      const restartedClients = connectClients(restartedRuntime.server.baseUrl);
      const restartedTree = await restartedClients.tree.getTree({
        treeId: CONNECT_REPAIR_TREE_ID,
      });
      expect(restartedTree.tree).toEqual(repaired);
      expect((await restartedClients.event.getSnapshot({})).attention).toEqual([]);
      await restartedRuntime.close();
      restartedRuntime = undefined;
    } finally {
      await restartedRuntime?.close();
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });

  it("repairs a named CLI plan attention with strict JSON and durable restart reads", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-tree-service-cli-repair-home-"));
    const fixture = await createGitFixture("cli-repair");
    const capture = createLogCapture();
    const clock = new MutableClock(STARTED_AT_MS);
    let runtime: RunningDaemonRuntime | undefined;
    let restartedRuntime: RunningDaemonRuntime | undefined;
    let malformedPath: string | undefined;
    let repairPath: string | undefined;
    try {
      const port = await reserveLoopbackPort();
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([
            CLI_REPAIR_INSTANCE_ID,
            CLI_REPAIR_HOST_CANDIDATE_ID,
            CLI_REPAIR_REGISTER_EVENT_ID,
            CLI_REPAIR_CREATE_EVENT_ID,
            CLI_REPAIR_EVENT_ID,
          ]),
          createStructuredLogger({ stream: capture.stream, now: () => clock.now() }),
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const clients = connectClients(runtime.server.baseUrl);
      await clients.repository.registerRepository(
        registerRequest(
          CLI_REPAIR_REGISTER_COMMAND_ID,
          CLI_REPAIR_ACTOR_SESSION_ID,
          CLI_REPAIR_REPOSITORY_ID,
          fixture.root,
        ),
      );
      const created = await captureCliJson(
        () =>
          runCli([
            "tree",
            "create",
            CLI_REPAIR_REPOSITORY_ID,
            CLI_INITIAL_GOAL,
            fixture.baseCommit,
            "--max-depth",
            "4",
            "--max-fan-out",
            "3",
            "--max-nodes",
            "8",
            "--max-concurrency",
            "2",
            "--max-attempts-per-node",
            "2",
            "--root-allowed-path",
            CLI_SCOPE_ROOT,
            "--home",
            home,
          ]),
        parseCliTreeResponse,
      );
      expect(created.code).toBe(0);
      const createdTree = created.json.tree;
      if (createdTree.attention === undefined) {
        throw new Error("CLI repair create response did not contain plan attention");
      }
      const createdAttention = createdTree.attention;
      const beforeMalformed = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      malformedPath = join(home, "malformed-repair-plan.json");
      await writeFile(
        malformedPath,
        JSON.stringify({
          goal: CLI_REPAIR_GOAL,
          nodes: [
            {
              nodeId: CLI_REPAIR_NODE_ID,
              parentNodeId: createdTree.root_node_id,
              mode: "PLAN_NODE_MODE_IMPLEMENTATION",
              objective: "repair the cli child",
              acceptanceCriteria: ["the repaired cli child is implementable"],
              inputs: [],
              allowedRepositoryPaths: ["../escape"],
              implementation: {},
            },
          ],
        }),
        "utf8",
      );
      const malformed = await captureCli(() =>
        runCli([
          "tree",
          "repair",
          createdTree.id,
          CLI_REPAIR_PLAN_REVISION_ID,
          createdAttention.id,
          malformedPath ?? "",
          "--home",
          home,
        ]),
      );
      expect(malformed.code).toBe(2);
      expect(malformed.stdout).toBe("");
      const malformedError = parseCliErrorResponse(JSON.parse(malformed.stderr));
      expect(malformedError).toMatchObject({
        status: "error",
        code: "invalid_usage",
      });
      expect(malformedError.message).toContain("canonical relative path");
      const afterMalformed = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(afterMalformed.commands).toHaveLength(beforeMalformed.commands.length);
      expect(afterMalformed.idempotency).toHaveLength(beforeMalformed.idempotency.length);
      expect(afterMalformed.events).toHaveLength(beforeMalformed.events.length);

      repairPath = join(home, "repair-plan.json");
      await writeFile(
        repairPath,
        JSON.stringify({
          goal: CLI_REPAIR_GOAL,
          nodes: [
            {
              nodeId: CLI_REPAIR_NODE_ID,
              parentNodeId: createdTree.root_node_id,
              mode: "PLAN_NODE_MODE_IMPLEMENTATION",
              objective: "repair the cli child",
              acceptanceCriteria: ["the repaired cli child is implementable"],
              inputs: [],
              allowedRepositoryPaths: [...CLI_SCOPE_IMPLEMENTATION],
              implementation: {},
            },
          ],
        }),
        "utf8",
      );
      clock.set(CLI_PROPOSED_AT_MS);
      const repaired = await captureCliJson(
        () =>
          runCli([
            "tree",
            "repair",
            createdTree.id,
            CLI_REPAIR_PLAN_REVISION_ID,
            createdAttention.id,
            repairPath ?? "",
            "--home",
            home,
          ]),
        parseCliTreeResponse,
      );
      expect(repaired.code).toBe(0);
      const repairedTree = repaired.json.tree;
      expect(repairedTree.goal).toBe(CLI_REPAIR_GOAL);
      expect(repairedTree.version).toBe("1");
      expect(repairedTree.active_plan_revision_id).toBe(CLI_REPAIR_PLAN_REVISION_ID);
      expect(repairedTree.attention).toBeUndefined();
      const repairedRoot = requireNode(repairedTree, repairedTree.root_node_id);
      const repairedRootArtifact = requireArtifact(repairedRoot);
      expect(repairedTree.nodes).toEqual([
        jsonArtifactNode({
          id: repairedTree.root_node_id,
          treeId: repairedTree.id,
          repositoryId: CLI_REPAIR_REPOSITORY_ID,
          hostId,
          planRevisionId: createdTree.active_plan_revision_id,
          mode: "PLAN_NODE_MODE_PLAN",
          objective: CLI_INITIAL_GOAL,
          acceptanceCriteria: [CLI_INITIAL_GOAL],
          inputs: [],
          artifactId: repairedRootArtifact.artifact_id,
          artifactType: "plan",
          state: "NODE_STATE_PLANNED",
          version: 0,
          createdAtMs: STARTED_AT_MS,
          updatedAtMs: STARTED_AT_MS,
        }),
        jsonImplementationNode({
          id: CLI_REPAIR_NODE_ID,
          treeId: repairedTree.id,
          repositoryId: CLI_REPAIR_REPOSITORY_ID,
          hostId,
          parentNodeId: repairedTree.root_node_id,
          planRevisionId: CLI_REPAIR_PLAN_REVISION_ID,
          objective: "repair the cli child",
          acceptanceCriteria: ["the repaired cli child is implementable"],
          state: "NODE_STATE_PLANNED",
          version: 0,
          createdAtMs: CLI_PROPOSED_AT_MS,
          updatedAtMs: CLI_PROPOSED_AT_MS,
        }),
      ]);
      expect((await clients.event.getSnapshot({})).attention).toEqual([]);
      const persisted = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(persisted.commands).toHaveLength(3);
      expect(persisted.idempotency).toHaveLength(3);
      expect(persisted.events).toHaveLength(3);

      await runtime.close();
      runtime = undefined;
      const restartedClock = new MutableClock(RESTARTED_AT_MS);
      const restartedPort = await reserveLoopbackPort();
      restartedRuntime = await startDaemonRuntime(
        runtimeOptions(
          home,
          restartedPort,
          restartedClock,
          new SequenceIdGenerator([
            CLI_REPAIR_RESTART_INSTANCE_ID,
            CLI_REPAIR_RESTART_HOST_CANDIDATE_ID,
          ]),
          createStructuredLogger({ stream: capture.stream, now: () => restartedClock.now() }),
        ),
      );
      const restartedGet = await captureCliJson(
        () => runCli(["tree", "get", repairedTree.id, "--home", home]),
        parseCliTreeResponse,
      );
      expect(restartedGet.json.tree).toEqual(repairedTree);
      expect(
        (await connectClients(restartedRuntime.server.baseUrl).event.getSnapshot({})).attention,
      ).toEqual([]);
      await restartedRuntime.close();
      restartedRuntime = undefined;
    } finally {
      await restartedRuntime?.close();
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(malformedPath ?? join(home, "malformed-repair-plan.json"), { force: true });
      await rm(repairPath ?? join(home, "repair-plan.json"), { force: true });
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });

  it("creates templated trees for EXPLAIN, FIX, handles replay idempotency and rejects invalid template/prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-tree-templated-test-home-"));
    const fixture = await createGitFixture("templated");
    const capture = createLogCapture();
    const clock = new MutableClock(STARTED_AT_MS);
    let runtime: RunningDaemonRuntime | undefined;
    try {
      const port = await reserveLoopbackPort();
      const logger = createStructuredLogger({ stream: capture.stream, now: () => clock.now() });
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([
            "01900000-0000-7000-8000-000000001001",
            "01900000-0000-7000-8000-000000001002",
            "01900000-0000-7000-8000-000000001003",
            "01900000-0000-7000-8000-000000001004",
            "01900000-0000-7000-8000-000000001005",
            "01900000-0000-7000-8000-000000001006",
            "01900000-0000-7000-8000-000000001007",
            "01900000-0000-7000-8000-000000001008",
            "01900000-0000-7000-8000-000000001009",
            "01900000-0000-7000-8000-00000000100a",
            "01900000-0000-7000-8000-00000000100b",
            "01900000-0000-7000-8000-00000000100c",
            "01900000-0000-7000-8000-00000000100d",
            "01900000-0000-7000-8000-00000000100e",
            "01900000-0000-7000-8000-00000000100f",
            "01900000-0000-7000-8000-000000001010",
          ]),
          logger,
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const clients = connectClients(runtime.server.baseUrl);

      const repoId = "01900000-0000-7000-8000-000000000201";
      await clients.repository.registerRepository(
        registerRequest(
          "01900000-0000-7000-8000-000000000202",
          "01900000-0000-7000-8000-000000000203",
          repoId,
          fixture.root,
        ),
      );

      await expectConnectCode(
        () =>
          clients.tree.createTemplatedTree(
            create(CreateTemplatedTreeRequestSchema, {
              commandId: "01900000-0000-7000-8000-000000000210",
              actorSessionId: "01900000-0000-7000-8000-000000000203",
              repositoryId: repoId,
              treeId: "01900000-0000-7000-8000-000000000211",
              planRevisionId: "01900000-0000-7000-8000-000000000212",
              rootNodeId: "01900000-0000-7000-8000-000000000213",
              rootArtifactId: "01900000-0000-7000-8000-000000000214",
              attentionId: "01900000-0000-7000-8000-000000000215",
              template: TaskTemplate.UNSPECIFIED,
              prompt: "explain the architecture",
            }),
          ),
        Code.InvalidArgument,
      );

      await expectConnectCode(
        () =>
          clients.tree.createTemplatedTree(
            create(CreateTemplatedTreeRequestSchema, {
              commandId: "01900000-0000-7000-8000-000000000220",
              actorSessionId: "01900000-0000-7000-8000-000000000203",
              repositoryId: repoId,
              treeId: "01900000-0000-7000-8000-000000000221",
              planRevisionId: "01900000-0000-7000-8000-000000000222",
              rootNodeId: "01900000-0000-7000-8000-000000000223",
              rootArtifactId: "01900000-0000-7000-8000-000000000224",
              attentionId: "01900000-0000-7000-8000-000000000225",
              template: TaskTemplate.EXPLAIN,
              prompt: "   ",
            }),
          ),
        Code.InvalidArgument,
      );

      const explainCommandId = "01900000-0000-7000-8000-000000000230";
      const explainTreeId = "01900000-0000-7000-8000-000000000231";
      const explainRevisionId = "01900000-0000-7000-8000-000000000232";
      const explainRootNodeId = "01900000-0000-7000-8000-000000000233";
      const explainRootArtifactId = "01900000-0000-7000-8000-000000000234";
      const explainAttentionId = "01900000-0000-7000-8000-000000000235";
      const explainPrompt = "explain authentication architecture";

      const explainResponse = await clients.tree.createTemplatedTree(
        create(CreateTemplatedTreeRequestSchema, {
          commandId: explainCommandId,
          actorSessionId: "01900000-0000-7000-8000-000000000203",
          repositoryId: repoId,
          treeId: explainTreeId,
          planRevisionId: explainRevisionId,
          rootNodeId: explainRootNodeId,
          rootArtifactId: explainRootArtifactId,
          attentionId: explainAttentionId,
          template: TaskTemplate.EXPLAIN,
          prompt: explainPrompt,
        }),
      );

      const explainTree = explainResponse.tree;
      if (explainTree === undefined) {
        throw new Error("explain template response did not contain a tree");
      }
      expect(explainTree.id).toBe(explainTreeId);
      expect(explainTree.state).toBe(TreeState.APPROVED);
      expect(explainTree.goal).toBe(explainPrompt);
      expect(explainTree.revisions).toHaveLength(1);
      expect(explainTree.revisions[0]?.state).toBe(PlanRevisionState.APPROVED);
      expect(explainTree.revisions[0]?.version).toBe(1n);
      expect(explainTree.nodes).toHaveLength(2);
      const explainRoot = explainTree.nodes.find((n) => n.id === explainRootNodeId);
      expect(explainRoot?.mode).toBe(PlanNodeMode.PLAN);
      expect(explainRoot?.state).toBe(NodeState.PLANNED);
      const explainResearchChild = explainTree.nodes.find((n) => n.id !== explainRootNodeId);
      expect(explainResearchChild).toBeDefined();
      expect(explainResearchChild?.parentNodeId).toBe(explainRootNodeId);
      expect(explainResearchChild?.mode).toBe(PlanNodeMode.RESEARCH);
      expect(explainResearchChild?.state).toBe(NodeState.READY);
      expect(explainResearchChild?.version).toBe(1n);
      expect(explainResearchChild?.outputContract.case).toBe("artifact");

      const explainReplay = await clients.tree.createTemplatedTree(
        create(CreateTemplatedTreeRequestSchema, {
          commandId: explainCommandId,
          actorSessionId: "01900000-0000-7000-8000-000000000203",
          repositoryId: repoId,
          treeId: explainTreeId,
          planRevisionId: explainRevisionId,
          rootNodeId: explainRootNodeId,
          rootArtifactId: explainRootArtifactId,
          attentionId: explainAttentionId,
          template: TaskTemplate.EXPLAIN,
          prompt: explainPrompt,
        }),
      );
      expect(explainReplay.tree).toEqual(explainTree);

      const fixCommandId = "01900000-0000-7000-8000-000000000240";
      const fixTreeId = "01900000-0000-7000-8000-000000000241";
      const fixRevisionId = "01900000-0000-7000-8000-000000000242";
      const fixRootNodeId = "01900000-0000-7000-8000-000000000243";
      const fixRootArtifactId = "01900000-0000-7000-8000-000000000244";
      const fixAttentionId = "01900000-0000-7000-8000-000000000245";
      const fixPrompt = "fix connection timeout bug";

      const fixResponse = await clients.tree.createTemplatedTree(
        create(CreateTemplatedTreeRequestSchema, {
          commandId: fixCommandId,
          actorSessionId: "01900000-0000-7000-8000-000000000203",
          repositoryId: repoId,
          treeId: fixTreeId,
          planRevisionId: fixRevisionId,
          rootNodeId: fixRootNodeId,
          rootArtifactId: fixRootArtifactId,
          attentionId: fixAttentionId,
          template: TaskTemplate.FIX,
          prompt: fixPrompt,
        }),
      );

      const fixTree = fixResponse.tree;
      if (fixTree === undefined) {
        throw new Error("fix template response did not contain a tree");
      }
      expect(fixTree.id).toBe(fixTreeId);
      expect(fixTree.state).toBe(TreeState.DRAFT);
      expect(fixTree.goal).toBe(fixPrompt);
      expect(fixTree.revisions).toHaveLength(1);
      expect(fixTree.revisions[0]?.state).toBe(PlanRevisionState.DRAFT);
      expect(fixTree.revisions[0]?.version).toBe(0n);
      expect(fixTree.nodes).toHaveLength(3);

      const fixRoot = fixTree.nodes.find((n) => n.id === fixRootNodeId);
      expect(fixRoot).toBeDefined();
      expect(fixRoot?.mode).toBe(PlanNodeMode.PLAN);
      expect(fixRoot?.state).toBe(NodeState.PLANNED);

      const fixResearchChild = fixTree.nodes.find((n) => n.mode === PlanNodeMode.RESEARCH);
      if (fixResearchChild === undefined) {
        throw new Error("fix template did not produce a research child");
      }
      expect(fixResearchChild.parentNodeId).toBe(fixRootNodeId);
      expect(fixResearchChild.state).toBe(NodeState.PLANNED);
      expect(fixResearchChild.version).toBe(0n);
      expect(fixResearchChild.outputContract.case).toBe("artifact");

      const fixImplementationGrandchild = fixTree.nodes.find(
        (n) => n.mode === PlanNodeMode.IMPLEMENTATION,
      );
      if (fixImplementationGrandchild === undefined) {
        throw new Error("fix template did not produce an implementation grandchild");
      }
      expect(fixImplementationGrandchild.parentNodeId).toBe(fixResearchChild.id);
      expect(fixImplementationGrandchild.parentNodeId).not.toBe(fixRootNodeId);
      expect(fixImplementationGrandchild.state).toBe(NodeState.PLANNED);
      expect(fixImplementationGrandchild.version).toBe(0n);
      expect(fixImplementationGrandchild.outputContract.case).toBe("implementation");

      const featureCommandId = "01900000-0000-7000-8000-000000000250";
      const featureTreeId = "01900000-0000-7000-8000-000000000251";
      const featureRevisionId = "01900000-0000-7000-8000-000000000252";
      const featureRootNodeId = "01900000-0000-7000-8000-000000000253";
      const featureRootArtifactId = "01900000-0000-7000-8000-000000000254";
      const featureAttentionId = "01900000-0000-7000-8000-000000000255";
      const featurePrompt = "build dark mode setting";

      const featureResponse = await clients.tree.createTemplatedTree(
        create(CreateTemplatedTreeRequestSchema, {
          commandId: featureCommandId,
          actorSessionId: "01900000-0000-7000-8000-000000000203",
          repositoryId: repoId,
          treeId: featureTreeId,
          planRevisionId: featureRevisionId,
          rootNodeId: featureRootNodeId,
          rootArtifactId: featureRootArtifactId,
          attentionId: featureAttentionId,
          template: TaskTemplate.FEATURE,
          prompt: featurePrompt,
        }),
      );

      const featureTree = featureResponse.tree;
      if (featureTree === undefined) {
        throw new Error("feature template response did not contain a tree");
      }
      expect(featureTree.state).toBe(TreeState.DRAFT);
      expect(featureTree.nodes).toHaveLength(3);
      const featureExploreChild = featureTree.nodes.find((n) => n.mode === PlanNodeMode.EXPLORE);
      if (featureExploreChild === undefined) {
        throw new Error("feature template did not produce an explore child");
      }
      expect(featureExploreChild.parentNodeId).toBe(featureRootNodeId);

      const featureImplementationGrandchild = featureTree.nodes.find(
        (n) => n.mode === PlanNodeMode.IMPLEMENTATION,
      );
      if (featureImplementationGrandchild === undefined) {
        throw new Error("feature template did not produce an implementation grandchild");
      }
      expect(featureImplementationGrandchild.parentNodeId).toBe(featureExploreChild.id);
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });
});
