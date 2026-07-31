import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteCommandStore,
  SqliteCommandError,
  type CommandCommitNotifier,
  type ManagedSqliteDatabase,
  type SqliteCommandStore,
  type SqliteCommandTransaction,
} from "@minions/adapters";
import {
  actorSessionId,
  commandId,
  nonEmptyText,
  repositoryId,
  timestampFromEpochMilliseconds,
  type AppliedCommand,
  type CommandReceipt,
  type CommandRequest,
  type ExternalOperationIntent,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import {
  FaultInjectingSqliteDatabase,
  TemporarySqliteDatabase,
  type InjectedWriteFailureTiming,
} from "@minions/testkit/sqlite";

const NOW = timestampFromEpochMilliseconds(1_725_000_000_123);
const REPOSITORY_ID = repositoryId("01900000-0000-7000-8000-000000000001");
const HOST_ID = "01900000-0000-7000-8000-000000000002";
const ACTOR_SESSION_ID = actorSessionId("01900000-0000-7000-8000-000000000003");
const COMMAND_ID = commandId("01900000-0000-7000-8000-000000000004");
const SECOND_COMMAND_ID = commandId("01900000-0000-7000-8000-000000000005");
const EVENT_ID = "01900000-0000-7000-8000-000000000010";
const OPERATION_ID = "01900000-0000-7000-8000-000000000011";
const OUTBOX_ID = "01900000-0000-7000-8000-000000000012";
const SECOND_EVENT_ID = "01900000-0000-7000-8000-000000000013";
const temporaries: TemporarySqliteDatabase[] = [];

class RecordingNotifier implements CommandCommitNotifier {
  readonly receipts: CommandReceipt[] = [];
  fail = false;

  commandCommitted(receipt: CommandReceipt): void {
    if (this.fail) {
      throw new Error("notification unavailable");
    }
    this.receipts.push(receipt);
  }
}

type Fixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  database: ManagedSqliteDatabase;
  store: SqliteCommandStore;
  notifier: RecordingNotifier;
}>;

afterEach(async () => {
  for (const temporary of temporaries.splice(0)) {
    await temporary.dispose();
  }
});

async function createFixture(
  options: Readonly<{
    generatedIds?: readonly string[];
    fault?: Readonly<{ failAtWrite: number; timing: InjectedWriteFailureTiming }>;
    seedRepository?: boolean;
  }> = {},
): Promise<Fixture> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(NOW));
  temporaries.push(temporary);
  if (options.seedRepository !== false) {
    await temporary.database.write((transaction) => {
      transaction.run(
        `INSERT INTO repositories (
          id, host_id, root_path, version, registered_at_ms, archived_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [REPOSITORY_ID, HOST_ID, "/workspace/minions", 0, NOW, null],
      );
    });
  }
  const database =
    options.fault === undefined
      ? temporary.applicationDatabase
      : new FaultInjectingSqliteDatabase(temporary.applicationDatabase, options.fault);
  const notifier = new RecordingNotifier();
  const store = createSqliteCommandStore({
    database,
    ports: {
      clock: new FixedClock(NOW),
      ids: new SequenceIdGenerator(options.generatedIds ?? [EVENT_ID, OPERATION_ID, OUTBOX_ID]),
    },
    notifier,
  });
  return { temporary, database, store, notifier };
}

function request(
  id = COMMAND_ID,
  expectedVersion: number | null = 0,
  payload: Uint8Array = Uint8Array.of(1, 2, 3),
): CommandRequest {
  return Object.freeze({
    id,
    actorSessionId: ACTOR_SESSION_ID,
    aggregateKind: "repository",
    aggregateId: REPOSITORY_ID,
    expectedVersion,
    command: Object.freeze({
      typeName: nonEmptyText("minions.v1.ArchiveRepositoryRequest", "command type"),
      bytes: payload,
    }),
  });
}

function operationIntent(idempotencyKey = "github/repository/archive/1"): ExternalOperationIntent {
  return Object.freeze({
    operationKind: nonEmptyText("github_repository_update", "operation kind"),
    idempotencyKey: nonEmptyText(idempotencyKey, "idempotency key"),
    request: Object.freeze({
      typeName: nonEmptyText("minions.v1.GitHubRepositoryUpdate", "operation request type"),
      bytes: Uint8Array.of(4, 5, 6),
    }),
    availableAt: NOW,
  });
}

function appliedCommand(
  externalOperations: readonly ExternalOperationIntent[] = [operationIntent()],
): AppliedCommand {
  return Object.freeze({
    event: Object.freeze({
      typeName: nonEmptyText("minions.v1.RepositoryArchived", "event type"),
      bytes: Uint8Array.of(7, 8),
    }),
    result: Object.freeze({
      typeName: nonEmptyText("minions.v1.ArchiveRepositoryResponse", "result type"),
      bytes: Uint8Array.of(9, 10),
    }),
    externalOperations,
  });
}

function applyRepositoryUpdate(callCounter?: { count: number }) {
  return (transaction: SqliteCommandTransaction): AppliedCommand => {
    if (callCounter !== undefined) {
      callCounter.count += 1;
    }
    transaction.run("UPDATE repositories SET version = version + 1 WHERE id = ?", [REPOSITORY_ID]);
    return appliedCommand();
  };
}

function row(database: ManagedSqliteDatabase, sql: string, parameters: readonly string[] = []) {
  return database.read((reader) => reader.get(sql, parameters));
}

function count(database: ManagedSqliteDatabase, table: string): bigint {
  const value = row(database, `SELECT count(*) AS count FROM ${table}`)?.["count"];
  if (typeof value !== "bigint") {
    throw new TypeError(`count for ${table} is not an integer`);
  }
  return value;
}

describe("SQLite command transaction", () => {
  it("keeps the application database free of a raw writer capability", async () => {
    const fixture = await createFixture();

    expect(Reflect.has(fixture.temporary.applicationDatabase, "write")).toBe(false);
  });

  it("commits state, event, outbox intent, and stable result atomically", async () => {
    const fixture = await createFixture();

    const receipt = await fixture.store.execute(request(), applyRepositoryUpdate());

    expect(receipt).toEqual({
      commandId: COMMAND_ID,
      eventId: EVENT_ID,
      eventSequence: 1n,
      aggregateVersion: 2,
      result: {
        typeName: "minions.v1.ArchiveRepositoryResponse",
        bytes: Uint8Array.of(9, 10),
      },
    });
    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 1n });
    expect(
      row(
        fixture.database,
        `SELECT state_kind, acknowledged_at_ms
         FROM operator_commands WHERE id = ?`,
        [COMMAND_ID],
      ),
    ).toEqual({ state_kind: "applied", acknowledged_at_ms: BigInt(NOW) });
    expect(
      row(
        fixture.database,
        `SELECT event_id, aggregate_kind, aggregate_id, aggregate_version,
                event_type, hex(event_payload) AS payload
         FROM events WHERE command_id = ?`,
        [COMMAND_ID],
      ),
    ).toEqual({
      event_id: EVENT_ID,
      aggregate_kind: "repository",
      aggregate_id: REPOSITORY_ID,
      aggregate_version: 2n,
      event_type: "minions.v1.RepositoryArchived",
      payload: "0708",
    });
    expect(
      row(
        fixture.database,
        `SELECT id, state_kind, receipt_type, hex(request_payload) AS request_payload
         FROM external_operations WHERE command_id = ?`,
        [COMMAND_ID],
      ),
    ).toEqual({
      id: OPERATION_ID,
      state_kind: "pending",
      receipt_type: null,
      request_payload: "040506",
    });
    expect(
      row(
        fixture.database,
        `SELECT id, event_sequence, operation_id, state_kind, available_at_ms
         FROM outbox WHERE command_id = ?`,
        [COMMAND_ID],
      ),
    ).toEqual({
      id: OUTBOX_ID,
      event_sequence: 1n,
      operation_id: OPERATION_ID,
      state_kind: "pending",
      available_at_ms: BigInt(NOW),
    });
    expect(
      row(
        fixture.database,
        `SELECT result_type, hex(result_payload) AS result_payload, committed_sequence
         FROM idempotency_records WHERE command_id = ?`,
        [COMMAND_ID],
      ),
    ).toEqual({
      result_type: "minions.v1.ArchiveRepositoryResponse",
      result_payload: "090A",
      committed_sequence: 1n,
    });
    expect(fixture.notifier.receipts).toEqual([receipt]);
  });

  it("creates an absent aggregate at version zero with event version one", async () => {
    const fixture = await createFixture({ seedRepository: false });

    const receipt = await fixture.store.execute(request(COMMAND_ID, null), (transaction) => {
      transaction.run(
        `INSERT INTO repositories (
          id, host_id, root_path, version, registered_at_ms, archived_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [REPOSITORY_ID, HOST_ID, "/workspace/minions", 0, NOW, null],
      );
      return appliedCommand();
    });

    expect(receipt.aggregateVersion).toBe(1);
    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 0n });
    expect(
      row(fixture.database, "SELECT aggregate_version FROM events WHERE command_id = ?", [
        COMMAND_ID,
      ]),
    ).toEqual({ aggregate_version: 1n });
  });

  it("deduplicates concurrent identical commands to one effect and notification", async () => {
    const fixture = await createFixture();
    const calls = { count: 0 };
    const apply = applyRepositoryUpdate(calls);

    const [first, second] = await Promise.all([
      fixture.store.execute(request(), apply),
      fixture.store.execute(request(), apply),
    ]);

    expect(second).toEqual(first);
    expect(calls.count).toBe(1);
    expect(count(fixture.database, "events")).toBe(1n);
    expect(count(fixture.database, "outbox")).toBe(1n);
    expect(fixture.notifier.receipts).toEqual([first]);
  });

  it("rejects reuse of a command ID for changed request bytes", async () => {
    const fixture = await createFixture();
    const calls = { count: 0 };
    await fixture.store.execute(request(), applyRepositoryUpdate(calls));

    await expect(
      fixture.store.execute(
        request(COMMAND_ID, 0, Uint8Array.of(99)),
        applyRepositoryUpdate(calls),
      ),
    ).rejects.toMatchObject({ code: "command_id_conflict" });

    expect(calls.count).toBe(1);
    expect(count(fixture.database, "events")).toBe(1n);
  });

  it("snapshots mutable command bytes before enqueueing the write", async () => {
    const fixture = await createFixture();
    const payload = Uint8Array.of(1, 2, 3);

    const pending = fixture.store.execute(request(COMMAND_ID, 0, payload), applyRepositoryUpdate());
    payload.fill(99);
    await pending;

    expect(
      row(
        fixture.database,
        "SELECT hex(command_payload) AS command_payload FROM operator_commands WHERE id = ?",
        [COMMAND_ID],
      ),
    ).toEqual({ command_payload: "010203" });
  });

  it("rejects a stale aggregate version before persisting a command", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.store.execute(request(COMMAND_ID, 1), applyRepositoryUpdate()),
    ).rejects.toMatchObject({ code: "aggregate_version_conflict" });

    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 0n });
    expectJournalCounts(fixture.database, 0n);
  });

  it("rolls back when the target aggregate version does not advance", async () => {
    const fixture = await createFixture();

    await expect(fixture.store.execute(request(), () => appliedCommand())).rejects.toMatchObject({
      code: "aggregate_version_invariant",
    });

    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 0n });
    expectJournalCounts(fixture.database, 0n);
  });

  it("rolls back a state mutation when command application throws", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.store.execute(request(), (transaction) => {
        transaction.run("UPDATE repositories SET version = version + 1 WHERE id = ?", [
          REPOSITORY_ID,
        ]);
        throw new Error("transition failed");
      }),
    ).rejects.toMatchObject({ code: "command_failed" });

    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 0n });
    expectJournalCounts(fixture.database, 0n);
  });

  it("does not trust adapter failure codes thrown by command handlers", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.store.execute(request(), () => {
        throw new SqliteCommandError(
          "post_commit_notification_failed",
          "forged post-commit failure",
        );
      }),
    ).rejects.toMatchObject({
      code: "command_failed",
      receipt: undefined,
    });

    expectJournalCounts(fixture.database, 0n);
  });

  it("denies command handlers direct access to journal tables", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.store.execute(request(), (transaction) => {
        transaction.run(
          `INSERT INTO events (
            event_id, command_id, aggregate_kind, aggregate_id, aggregate_version,
            event_type, event_payload, occurred_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "01900000-0000-7000-8000-000000000099",
            COMMAND_ID,
            "repository",
            REPOSITORY_ID,
            1,
            "forged.event",
            Uint8Array.of(1),
            NOW,
          ],
        );
        transaction.run("UPDATE repositories SET version = version + 1 WHERE id = ?", [
          REPOSITORY_ID,
        ]);
        return appliedCommand();
      }),
    ).rejects.toMatchObject({ code: "command_failed" });

    expectJournalCounts(fixture.database, 0n);
    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 0n });
  });

  it("denies command handlers read access to journal tables", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.store.execute(request(), (transaction) => {
        transaction.all("SELECT sequence FROM events");
        transaction.run("UPDATE repositories SET version = version + 1 WHERE id = ?", [
          REPOSITORY_ID,
        ]);
        return appliedCommand();
      }),
    ).rejects.toMatchObject({ code: "command_failed" });

    expectJournalCounts(fixture.database, 0n);
    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 0n });
  });

  it("rejects duplicate external intents and rolls back their state transition", async () => {
    const fixture = await createFixture();
    const duplicate = operationIntent();

    await expect(
      fixture.store.execute(request(), (transaction) => {
        transaction.run("UPDATE repositories SET version = version + 1 WHERE id = ?", [
          REPOSITORY_ID,
        ]);
        return appliedCommand([duplicate, duplicate]);
      }),
    ).rejects.toMatchObject({ code: "external_operation_conflict" });

    expectJournalCounts(fixture.database, 0n);
    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 0n });
  });

  it("prevents different commands from sharing an external idempotency key", async () => {
    const fixture = await createFixture({
      generatedIds: [EVENT_ID, OPERATION_ID, OUTBOX_ID, SECOND_EVENT_ID],
    });
    await fixture.store.execute(request(), applyRepositoryUpdate());

    await expect(
      fixture.store.execute(request(SECOND_COMMAND_ID, 1), (transaction) => {
        transaction.run("UPDATE repositories SET version = version + 1 WHERE id = ?", [
          REPOSITORY_ID,
        ]);
        return appliedCommand();
      }),
    ).rejects.toMatchObject({ code: "external_operation_conflict" });

    expect(
      row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
    ).toEqual({ version: 1n });
    expect(count(fixture.database, "events")).toBe(1n);
    expect(count(fixture.database, "external_operations")).toBe(1n);
    expect(count(fixture.database, "operator_commands")).toBe(1n);
  });

  it("reports notification failure with a committed replayable receipt", async () => {
    const fixture = await createFixture();
    fixture.notifier.fail = true;
    const calls = { count: 0 };
    const apply = applyRepositoryUpdate(calls);

    let failure: SqliteCommandError | undefined;
    try {
      await fixture.store.execute(request(), apply);
    } catch (error) {
      if (error instanceof SqliteCommandError) {
        failure = error;
      } else {
        throw error;
      }
    }

    expect(failure).toMatchObject({ code: "post_commit_notification_failed" });
    expect(failure?.receipt).toBeDefined();
    const replay = await fixture.store.execute(request(), apply);
    expect(replay).toEqual(failure?.receipt);
    expect(calls.count).toBe(1);
    expect(fixture.notifier.receipts).toEqual([]);
    expect(count(fixture.database, "events")).toBe(1n);
  });

  it("awaits and reports an asynchronous notifier rejection after commit", async () => {
    const fixture = await createFixture();
    const store = createSqliteCommandStore({
      database: fixture.database,
      ports: {
        clock: new FixedClock(NOW),
        ids: new SequenceIdGenerator([EVENT_ID, OPERATION_ID, OUTBOX_ID]),
      },
      notifier: {
        async commandCommitted(): Promise<void> {
          await Promise.resolve();
          throw new Error("asynchronous notification unavailable");
        },
      },
    });

    await expect(store.execute(request(), applyRepositoryUpdate())).rejects.toMatchObject({
      code: "post_commit_notification_failed",
    });

    expect(count(fixture.database, "events")).toBe(1n);
    expect(count(fixture.database, "idempotency_records")).toBe(1n);
  });

  it("copies persisted result bytes across receipts", async () => {
    const fixture = await createFixture();
    const first = await fixture.store.execute(request(), applyRepositoryUpdate());
    const notified = fixture.notifier.receipts[0];
    if (notified === undefined) {
      throw new TypeError("committed receipt was not delivered");
    }
    notified.result.bytes[0] = 44;
    expect(first.result.bytes).toEqual(Uint8Array.of(9, 10));
    expect(notified.result.bytes).not.toBe(first.result.bytes);
    first.result.bytes[0] = 255;

    const replay = await fixture.store.execute(request(), applyRepositoryUpdate());

    expect(replay.result.bytes).toEqual(Uint8Array.of(9, 10));
    expect(replay.result.bytes).not.toBe(first.result.bytes);
  });

  for (const timing of ["before", "after"] as const) {
    for (let failAtWrite = 1; failAtWrite <= 7; failAtWrite += 1) {
      it(`rolls back when failure occurs ${timing} write ${String(failAtWrite)}`, async () => {
        const fixture = await createFixture({ fault: { failAtWrite, timing } });

        await expect(
          fixture.store.execute(request(), applyRepositoryUpdate()),
        ).rejects.toMatchObject({ code: "command_failed" });

        expect(fixture.database).toBeInstanceOf(FaultInjectingSqliteDatabase);
        if (fixture.database instanceof FaultInjectingSqliteDatabase) {
          expect(fixture.database.observedWriteCount).toBe(failAtWrite);
        }

        expect(
          row(fixture.database, "SELECT version FROM repositories WHERE id = ?", [REPOSITORY_ID]),
        ).toEqual({ version: 0n });
        expectJournalCounts(fixture.database, 0n);
        expect(fixture.notifier.receipts).toEqual([]);
      });
    }
  }
});

function expectJournalCounts(database: ManagedSqliteDatabase, expected: bigint): void {
  for (const table of [
    "operator_commands",
    "events",
    "external_operations",
    "outbox",
    "idempotency_records",
  ]) {
    expect(count(database, table)).toBe(expected);
  }
}
