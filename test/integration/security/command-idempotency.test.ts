import { create } from "@bufbuild/protobuf";
import {
  CreateTreeRequestSchema,
  RegisterRepositoryRequestSchema,
  TreeBudgetSchema,
} from "@minions/contracts";
import {
  actorSessionId,
  artifactId,
  commandId,
  hostId,
  planRevisionId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type ActorSessionId,
  type QueueNodeCommandRequest,
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
  type RepositoryInspection,
  type SqliteRow,
  type SteeringCommandStore,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";

// Security scenario 8 in packages/core/src/security-matrix.ts ("duplicate command
// idempotent", boundary "command_idempotency"). These exercise the SQLite steering
// command store's `queue()` idempotency guard directly: a command ID may only ever be
// used once, whether resubmitted concurrently, resubmitted after unrelated node activity,
// or resubmitted under a different actor's identity.

function deterministicId(index: number): string {
  return `01900000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

const AT = timestampFromEpochMilliseconds(1_700_000_000_000);
const T1 = timestampFromEpochMilliseconds(1_700_000_000_100);
const T2 = timestampFromEpochMilliseconds(1_700_000_000_200);

const HOST = hostId(deterministicId(1));
const REPOSITORY = repositoryId(deterministicId(2));
const ACTOR = actorSessionId(deterministicId(3));
const OTHER_ACTOR = actorSessionId(deterministicId(4));
const TREE = taskTreeId(deterministicId(5));
const PLAN_REVISION = planRevisionId(deterministicId(6));
const ROOT_NODE = taskNodeId(deterministicId(7));
const ROOT_ARTIFACT = artifactId(deterministicId(8));
const PLAN_ATTENTION = deterministicId(9);
const REGISTER_COMMAND = deterministicId(10);
const CREATE_COMMAND = deterministicId(11);
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const noOpNotifier: CommandCommitNotifier = Object.freeze({
  commandCommitted: () => undefined,
});

const queueCommandId = (index: number) => commandId(deterministicId(0x100 + index));

type Fixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  database: ManagedSqliteDatabase;
  steering: SteeringCommandStore;
}>;

const fixtures: TemporarySqliteDatabase[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose();
  }
});

async function createFixture(): Promise<Fixture> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(AT));
  fixtures.push(temporary);
  const database = temporary.database;
  const commandStore = createSqliteCommandStore({
    database,
    ports: {
      clock: new FixedClock(AT),
      ids: new SequenceIdGenerator(
        Array.from({ length: 64 }, (_, index) => deterministicId(0x800 + index)),
      ),
    },
    notifier: noOpNotifier,
  });
  const repositories = createRepositoryRegistry({ database, commandStore, hostId: HOST });
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
      commandId: REGISTER_COMMAND,
      actorSessionId: ACTOR,
      repositoryId: REPOSITORY,
      rootPath: "/workspace/minions",
    }),
    inspection,
    allowedWorkspaceRoot: "/workspaces",
    registeredAt: AT,
  });
  const planRegistry = createPlanRegistry({ database, commandStore, hostId: HOST });
  await planRegistry.create({
    request: create(CreateTreeRequestSchema, {
      commandId: CREATE_COMMAND,
      actorSessionId: ACTOR,
      repositoryId: REPOSITORY,
      treeId: TREE,
      planRevisionId: PLAN_REVISION,
      rootNodeId: ROOT_NODE,
      rootArtifactId: ROOT_ARTIFACT,
      goal: "prove duplicate steering commands remain idempotent",
      baseCommit: BASE_COMMIT,
      budget: create(TreeBudgetSchema, {
        maxDepth: 4,
        maxFanOut: 4,
        maxNodes: 8,
        maxConcurrency: 4,
        maxAttemptsPerNode: 2,
      }),
      attentionId: PLAN_ATTENTION,
      rootAllowedRepositoryPaths: ["."],
      rootCheckProfile: "root-checks",
    }),
    at: AT,
  });
  const steering = createSqliteSteeringCommandStore({
    database,
    commandStore,
    ports: {
      clock: new FixedClock(AT),
      ids: new SequenceIdGenerator(
        Array.from({ length: 64 }, (_, index) => deterministicId(0x600 + index)),
      ),
    },
  });
  return { temporary, database, steering };
}

function queueRequest(
  index: number,
  payload: QueueNodeCommandRequest["payload"],
  options: Readonly<{ actor?: ActorSessionId; nodeId?: TaskNodeId; at?: Timestamp }> = {},
): QueueNodeCommandRequest {
  return Object.freeze({
    commandId: queueCommandId(index),
    actorSessionId: options.actor ?? ACTOR,
    nodeId: options.nodeId ?? ROOT_NODE,
    expectedNodeVersion: undefined,
    payload,
    at: options.at ?? T1,
  });
}

function row(
  database: ManagedSqliteDatabase,
  sql: string,
  parameters: readonly (string | number | bigint | null)[] = [],
): SqliteRow | undefined {
  return database.read((reader) => reader.get(sql, parameters));
}

function count(database: ManagedSqliteDatabase, table: string): bigint {
  const value = row(database, `SELECT count(*) AS count FROM ${table}`)?.["count"];
  if (typeof value !== "bigint") {
    throw new TypeError(`expected bigint count for ${table}`);
  }
  return value;
}

function nodeVersion(database: ManagedSqliteDatabase): bigint {
  const value = row(database, "SELECT version FROM nodes WHERE id = ?", [ROOT_NODE])?.["version"];
  if (typeof value !== "bigint") {
    throw new TypeError("expected bigint node version");
  }
  return value;
}

describe("command idempotency: steering command store", () => {
  it("applies a concurrently retried command exactly once", async () => {
    const fixture = await createFixture();
    const original = queueRequest(1, { kind: "message", text: "concurrent retry" });

    const [first, second] = await Promise.all([
      fixture.steering.queue(original),
      fixture.steering.queue(original),
    ]);

    expect(second).toEqual(first);
    expect(first.ordinal).toBe(1n);
    expect(count(fixture.database, "node_command_deliveries")).toBe(1n);
    expect(nodeVersion(fixture.database)).toBe(1n);
    expect(fixture.steering.list({ nodeId: ROOT_NODE, afterOrdinal: 0n, limit: 10 })).toHaveLength(
      1,
    );
  });

  it("rejects a reused command ID carrying a different payload without mutating the original delivery", async () => {
    const fixture = await createFixture();
    const original = queueRequest(2, { kind: "message", text: "steer gently" });
    const first = await fixture.steering.queue(original);

    const conflicting: QueueNodeCommandRequest = {
      ...original,
      payload: { kind: "message", text: "steer aggressively" },
    };
    await expect(fixture.steering.queue(conflicting)).rejects.toMatchObject({
      code: "invalid_command",
    });

    expect(count(fixture.database, "node_command_deliveries")).toBe(1n);
    expect(fixture.steering.get(first.commandId)).toEqual(first);
    expect(nodeVersion(fixture.database)).toBe(1n);
  });

  it("keeps a retried duplicate idempotent even after an unrelated command advances the node", async () => {
    const fixture = await createFixture();
    const originalA = queueRequest(3, { kind: "message", text: "first steering command" });
    const first = await fixture.steering.queue(originalA);
    expect(first.ordinal).toBe(1n);

    const commandB = queueRequest(4, { kind: "pause" }, { at: T2 });
    const second = await fixture.steering.queue(commandB);
    expect(second.ordinal).toBe(2n);
    expect(nodeVersion(fixture.database)).toBe(2n);

    // Resubmitting command A verbatim must still replay its ORIGINAL effect (ordinal 1),
    // not be reinterpreted against the node's now-advanced version -- the store keys the
    // replay off the command's own recorded expected version, not the current one.
    const replay = await fixture.steering.queue(originalA);
    expect(replay).toEqual(first);
    expect(nodeVersion(fixture.database)).toBe(2n);
    expect(count(fixture.database, "node_command_deliveries")).toBe(2n);
  });

  it("rejects a reused command ID submitted under a different actor session", async () => {
    const fixture = await createFixture();
    const original = queueRequest(5, { kind: "message", text: "owned by the first actor" });
    const first = await fixture.steering.queue(original);

    const impersonated: QueueNodeCommandRequest = { ...original, actorSessionId: OTHER_ACTOR };
    await expect(fixture.steering.queue(impersonated)).rejects.toMatchObject({
      code: "invalid_command",
    });

    expect(
      row(
        fixture.database,
        "SELECT actor_session_id FROM node_command_deliveries WHERE command_id = ?",
        [first.commandId],
      )?.["actor_session_id"],
    ).toBe(ACTOR);
    expect(count(fixture.database, "node_command_deliveries")).toBe(1n);
  });
});
