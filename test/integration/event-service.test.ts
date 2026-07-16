import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createEventCommitWaiter,
  createSqliteCommandStore,
  openHostDatabase,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
  type SqliteCommandStore,
} from "@minions/adapters";
import { executeTestSqliteWrite } from "@minions/adapters/sqlite-test-support";
import {
  AttentionKind,
  AttentionSummarySchema,
  ErrorDetailSchema,
  EventService,
  HostSummarySchema,
  NodeState,
  NodeSummarySchema,
  ProjectionChangeSchema,
  RepositorySummarySchema,
  TreeState,
  TreeSummarySchema,
  type WatchEventsResponse,
} from "@minions/contracts";
import {
  actorSessionId,
  commandId,
  nonEmptyText,
  repositoryId,
  timestampFromEpochMilliseconds,
  type CommandRequest,
  type DomainPorts,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

import { startSystemServer, type RunningSystemServer } from "../../apps/daemon/src/server.js";

const now = timestampFromEpochMilliseconds(1_725_000_000_123);
const repositoryIdentifier = repositoryId(uuid(1));
const hostIdentifier = uuid(2);
const actorIdentifier = actorSessionId(uuid(3));
const eventTypeName = nonEmptyText("minions.v1.ProjectionChange", "event type name");
const treeIdentifier = uuid(4);
const planRevisionIdentifier = uuid(5);
const rootNodeIdentifier = uuid(6);
const blockerEvidenceIdentifier = uuid(7);
const baseCommit = "0123456789abcdef0123456789abcdef01234567";
const rootObjective = "x".repeat(4_097);

interface RunningEventFixture {
  server: RunningSystemServer;
  client: Client<typeof EventService>;
}

interface OpenedEventStream {
  controller: AbortController;
  iterator: AsyncIterator<WatchEventsResponse>;
}

describe("EventService integration", () => {
  it("delivers exact ordered replay across snapshot races, reconnect, polling, and restart", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(now));
    await seedSnapshotProjections(temporary.database);
    const clock = new FixedClock(now);
    const ports: DomainPorts = {
      clock,
      ids: new SequenceIdGenerator(Array.from({ length: 16 }, (_, index) => uuid(100 + index))),
    };
    let database: ManagedSqliteDatabase = temporary.database;
    let waiter: EventCommitWaiter = createEventCommitWaiter();
    let commandStore = createSqliteCommandStore({ database, ports, notifier: waiter });
    let running = await startEventFixture(database, waiter);
    let runningOpen = true;
    let reopenedDatabase: ManagedSqliteDatabase | undefined;

    try {
      await appendRepository(commandStore, 1);
      const snapshot = await running.client.getSnapshot({});
      expect(snapshot.lastSequence).toBe(1n);
      expect(snapshot.minimumAvailableSequence).toBe(1n);
      expect(snapshot.hosts).toEqual([
        create(HostSummarySchema, {
          id: hostIdentifier,
          online: true,
          version: 0n,
        }),
      ]);
      expect(snapshot.repositories).toEqual([
        create(RepositorySummarySchema, {
          id: repositoryIdentifier,
          hostId: hostIdentifier,
          version: 1n,
          archived: false,
        }),
      ]);
      expect(snapshot.trees).toEqual([
        create(TreeSummarySchema, {
          id: treeIdentifier,
          repositoryId: repositoryIdentifier,
          hostId: hostIdentifier,
          rootNodeId: rootNodeIdentifier,
          activePlanRevisionId: planRevisionIdentifier,
          state: TreeState.DRAFT,
          version: 0n,
        }),
      ]);
      expect(snapshot.nodes).toEqual([
        create(NodeSummarySchema, {
          id: rootNodeIdentifier,
          treeId: treeIdentifier,
          ordinal: 0n,
          objective: rootObjective,
          state: NodeState.BLOCKED,
          version: 0n,
        }),
      ]);
      expect(snapshot.attention).toEqual([
        create(AttentionSummarySchema, {
          nodeId: rootNodeIdentifier,
          kind: AttentionKind.HUMAN_INPUT,
          evidenceId: blockerEvidenceIdentifier,
        }),
      ]);

      await appendRepository(commandStore, 2);
      const betweenSnapshotAndStream = openStream(running.client, snapshot.lastSequence);
      expect((await receiveNext(betweenSnapshotAndStream.iterator)).event?.sequence).toBe(2n);
      betweenSnapshotAndStream.controller.abort();

      const liveStream = openStream(running.client, 2n);
      const duringStream = receiveNext(liveStream.iterator);
      await appendRepository(commandStore, 3);
      expect((await duringStream).event?.sequence).toBe(3n);
      liveStream.controller.abort();

      await appendRepository(commandStore, 4);
      const reconnected = openStream(running.client, 3n);
      expect((await receiveNext(reconnected.iterator)).event?.sequence).toBe(4n);
      const nextAfterReconnect = receiveNext(reconnected.iterator);
      await appendRepository(commandStore, 5);
      expect((await nextAfterReconnect).event?.sequence).toBe(5n);
      reconnected.controller.abort();

      await running.server.close();
      runningOpen = false;
      await database.close();
      database = await openHostDatabase({ path: temporary.path, clock });
      reopenedDatabase = database;
      waiter = createEventCommitWaiter();
      commandStore = createSqliteCommandStore({ database, ports, notifier: waiter });
      await appendRepository(commandStore, 6);
      running = await startEventFixture(database, waiter);
      runningOpen = true;

      const afterRestart = openStream(running.client, 5n);
      expect((await receiveNext(afterRestart.iterator)).event?.sequence).toBe(6n);
      afterRestart.controller.abort();

      const pollingStream = openStream(running.client, 6n);
      const deliveredByPolling = receiveNext(pollingStream.iterator);
      const unobservedWaiter = createEventCommitWaiter();
      const unobservedStore = createSqliteCommandStore({
        database,
        ports,
        notifier: unobservedWaiter,
      });
      await appendRepository(unobservedStore, 7);
      unobservedWaiter.close();
      expect((await deliveredByPolling).event?.sequence).toBe(7n);
      pollingStream.controller.abort();

      await executeTestSqliteWrite(database, (transaction) => {
        transaction.run("DELETE FROM idempotency_records WHERE committed_sequence <= ?", [5n]);
        transaction.run("DELETE FROM events WHERE sequence <= ?", [5n]);
      });
      const expired = await expectConnectError(async () => {
        const stream = running.client.watchEvents({ afterSequence: 4n });
        await stream[Symbol.asyncIterator]().next();
      });
      expect(expired.code).toBe(Code.OutOfRange);
      const details = expired.findDetails(ErrorDetailSchema);
      expect(details).toHaveLength(1);
      expect(details[0]?.detail.case).toBe("eventCursorExpired");
      if (details[0]?.detail.case !== "eventCursorExpired") {
        throw new Error("expected an event cursor expiration detail");
      }
      expect(details[0].detail.value.minimumAvailableSequence).toBe(6n);
      expect(details[0].detail.value.lastSequence).toBe(7n);

      const finalSnapshot = await running.client.getSnapshot({});
      expect(finalSnapshot.lastSequence).toBe(7n);
      expect(finalSnapshot.minimumAvailableSequence).toBe(6n);
      expect(finalSnapshot.repositories[0]?.version).toBe(7n);

      await executeTestSqliteWrite(database, (transaction) => {
        transaction.run("UPDATE trees SET archived_at_ms = ? WHERE id = ?", [now, treeIdentifier]);
      });
      const archivedSnapshot = await running.client.getSnapshot({});
      expect(archivedSnapshot.trees).toEqual([]);
      expect(archivedSnapshot.nodes).toEqual([]);
      expect(archivedSnapshot.attention).toEqual([]);
    } finally {
      if (runningOpen) {
        await running.server.close();
      }
      if (reopenedDatabase !== undefined) {
        await reopenedDatabase.close();
      }
      await temporary.dispose();
    }
  });

  it("rejects incompatible retained events before binding a listener", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(now));
    const waiter = createEventCommitWaiter();
    try {
      await seedSnapshotProjections(temporary.database);
      await seedIncompatibleEvent(temporary.database);
      const startup = await startSystemServer({
        port: 0,
        database: temporary.database,
        eventWaiter: waiter,
        eventPollIntervalMs: 10,
        serverVersion: "0.0.0",
      }).then(
        (server) => ({ case: "started", server }) as const,
        (error: unknown) => ({ case: "rejected", error }) as const,
      );
      if (startup.case === "started") {
        await startup.server.close();
        throw new Error("server accepted an incompatible retained event");
      }
      if (!(startup.error instanceof ConnectError)) {
        throw startup.error;
      }
      expect(startup.error.code).toBe(Code.Internal);
    } finally {
      waiter.close();
      await temporary.dispose();
    }
  });

  it("terminates an active event response when the daemon closes", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(now));
    await seedSnapshotProjections(temporary.database);
    const waiter = createEventCommitWaiter();
    const store = createSqliteCommandStore({
      database: temporary.database,
      ports: {
        clock: new FixedClock(now),
        ids: new SequenceIdGenerator([uuid(120)]),
      },
      notifier: waiter,
    });
    const running = await startEventFixture(temporary.database, waiter);
    let runningOpen = true;
    try {
      await appendRepository(store, 1);
      const stream = openStream(running.client, 0n);
      expect((await receiveNext(stream.iterator)).event?.sequence).toBe(1n);
      const pending = stream.iterator.next();
      await running.server.close();
      runningOpen = false;
      const completion = await pending.then(
        (result) => ({ case: "ended", result }) as const,
        (error: unknown) => ({ case: "rejected", error }) as const,
      );
      if (completion.case === "ended") {
        expect(completion.result.done).toBe(true);
      } else {
        expect(completion.error).toBeInstanceOf(ConnectError);
      }
    } finally {
      if (runningOpen) {
        await running.server.close();
      }
      await temporary.dispose();
    }
  });
});

async function startEventFixture(
  database: ManagedSqliteDatabase,
  waiter: EventCommitWaiter,
): Promise<RunningEventFixture> {
  const server = await startSystemServer({
    port: 0,
    database,
    eventWaiter: waiter,
    eventPollIntervalMs: 10,
    serverVersion: "0.0.0",
  });
  return {
    server,
    client: createClient(
      EventService,
      createConnectTransport({
        baseUrl: server.baseUrl,
        httpVersion: "1.1",
        useBinaryFormat: true,
      }),
    ),
  };
}

async function seedSnapshotProjections(database: ManagedSqliteDatabase): Promise<void> {
  await executeTestSqliteWrite(database, (transaction) => {
    transaction.run(
      "INSERT INTO repositories (id, host_id, root_path, version, registered_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, NULL)",
      [repositoryIdentifier, hostIdentifier, "/workspace/minions", 0, now],
    );
    transaction.run(
      `INSERT INTO trees (
         id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
         root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      [
        treeIdentifier,
        repositoryIdentifier,
        hostIdentifier,
        baseCommit,
        "Realtime supervision",
        planRevisionIdentifier,
        rootNodeIdentifier,
        now,
        now,
      ],
    );
    transaction.run(
      `INSERT INTO plan_revisions (
         id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
         approved_at_ms, superseded_at_ms
       ) VALUES (?, ?, 1, ?, 'draft', 0, ?, NULL, NULL)`,
      [planRevisionIdentifier, treeIdentifier, "Realtime supervision", now],
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
         'blocked', 'ready', 'human_input', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, 0, ?, ?)`,
      [
        rootNodeIdentifier,
        treeIdentifier,
        repositoryIdentifier,
        hostIdentifier,
        planRevisionIdentifier,
        rootObjective,
        blockerEvidenceIdentifier,
        now,
        now,
      ],
    );
  });
}

async function appendRepository(store: SqliteCommandStore, version: number): Promise<void> {
  const projection = repositoryProjection(version);
  const bytes = toBinary(ProjectionChangeSchema, projection);
  const request: CommandRequest = {
    id: commandId(uuid(10 + version)),
    actorSessionId: actorIdentifier,
    aggregateKind: "repository",
    aggregateId: repositoryIdentifier,
    expectedVersion: version - 1,
    command: {
      typeName: eventTypeName,
      bytes,
    },
  };
  await store.execute(request, (transaction) => {
    transaction.run("UPDATE repositories SET version = ? WHERE id = ? AND version = ?", [
      version,
      repositoryIdentifier,
      version - 1,
    ]);
    return {
      aggregateVersion: version,
      event: { typeName: eventTypeName, bytes },
      result: { typeName: eventTypeName, bytes },
      externalOperations: [],
    };
  });
}

async function seedIncompatibleEvent(database: ManagedSqliteDatabase): Promise<void> {
  await executeTestSqliteWrite(database, (transaction) => {
    const legacyCommandId = uuid(90);
    transaction.run(
      `INSERT INTO operator_commands (
         id, actor_session_id, aggregate_kind, aggregate_id, expected_version,
         command_type, command_payload, state_kind, created_at_ms, acknowledged_at_ms
       ) VALUES (?, ?, 'repository', ?, 0, ?, ?, 'applied', ?, ?)`,
      [
        legacyCommandId,
        actorIdentifier,
        repositoryIdentifier,
        "minions.v1.ArchiveRepositoryRequest",
        Uint8Array.of(1),
        now,
        now,
      ],
    );
    transaction.run(
      `INSERT INTO events (
         event_id, command_id, aggregate_kind, aggregate_id, aggregate_version,
         event_type, event_payload, occurred_at_ms
       ) VALUES (?, ?, 'repository', ?, 1, ?, ?, ?)`,
      [
        uuid(91),
        legacyCommandId,
        repositoryIdentifier,
        "minions.v1.RepositoryArchived",
        Uint8Array.of(7, 8),
        now,
      ],
    );
  });
}

function repositoryProjection(version: number) {
  return create(ProjectionChangeSchema, {
    change: {
      case: "repositoryUpserted",
      value: create(RepositorySummarySchema, {
        id: repositoryIdentifier,
        hostId: hostIdentifier,
        version: BigInt(version),
        archived: false,
      }),
    },
  });
}

function openStream(client: Client<typeof EventService>, afterSequence: bigint): OpenedEventStream {
  const controller = new AbortController();
  const iterable = client.watchEvents({ afterSequence }, { signal: controller.signal });
  return {
    controller,
    iterator: iterable[Symbol.asyncIterator](),
  };
}

async function receiveNext(
  iterator: AsyncIterator<WatchEventsResponse>,
): Promise<WatchEventsResponse> {
  const result = await iterator.next();
  if (result.done === true) {
    throw new Error("event stream ended before delivering an event");
  }
  return result.value;
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

function uuid(value: number): string {
  return `01900000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}
