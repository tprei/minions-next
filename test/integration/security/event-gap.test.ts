import { create, toBinary } from "@bufbuild/protobuf";
import { AggregateKind, ProjectionChangeSchema, ProjectionRemovedSchema } from "@minions/contracts";
import {
  actorSessionId,
  commandId,
  nonEmptyText,
  repositoryId,
  timestampFromEpochMilliseconds,
  type AppliedCommand,
  type CommandRequest,
} from "@minions/core";
import {
  createSqliteCommandStore,
  createSqliteEventStore,
  SqliteDatabaseError,
  type CommandCommitNotifier,
  type ManagedSqliteDatabase,
  type SqliteCommandStore,
  type SqliteCommandTransaction,
  type SqliteEventBounds,
  type SqliteStoredEvent,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

// Security scenario 9 in packages/core/src/security-matrix.ts ("event sequence gap
// detected", boundary "event_gap"). These exercise the SQLite event store's `getBounds()`
// and `readEvents()` directly against a real, tampered event log: the primitives they
// expose (a monotonic `sequence` per row, plus `minimumAvailableSequence`/`lastSequence`)
// are exactly what a consumer needs -- and needs to actively use -- to catch silent
// command-loss rather than treat a truncated or holed log as a complete one.

function deterministicId(index: number): string {
  return `01900000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

const NOW = timestampFromEpochMilliseconds(1_725_000_000_000);
const REPOSITORY_ID = repositoryId(deterministicId(1));
const HOST_ID = deterministicId(2);
const ACTOR_SESSION_ID = actorSessionId(deterministicId(3));

const PROJECTION_EVENT = create(ProjectionChangeSchema, {
  change: {
    case: "removed",
    value: create(ProjectionRemovedSchema, {
      aggregateKind: AggregateKind.REPOSITORY,
      aggregateId: REPOSITORY_ID,
    }),
  },
});
const PROJECTION_EVENT_BYTES = toBinary(ProjectionChangeSchema, PROJECTION_EVENT);
const PROJECTION_EVENT_TYPE = nonEmptyText(ProjectionChangeSchema.typeName, "event type");

class RecordingNotifier implements CommandCommitNotifier {
  commandCommitted(): void {
    // No downstream projection to notify in this fixture.
  }
}

const temporaries: TemporarySqliteDatabase[] = [];

afterEach(async () => {
  for (const fixture of temporaries.splice(0)) {
    await fixture.dispose();
  }
});

type Fixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  database: ManagedSqliteDatabase;
  store: SqliteCommandStore;
}>;

async function createFixture(): Promise<Fixture> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(NOW));
  temporaries.push(temporary);
  await temporary.database.write((transaction) => {
    transaction.run(
      `INSERT INTO repositories (
        id, host_id, root_path, version, registered_at_ms, archived_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [REPOSITORY_ID, HOST_ID, "/workspace/minions", 0, NOW, null],
    );
  });
  const store = createSqliteCommandStore({
    database: temporary.database,
    ports: {
      clock: new FixedClock(NOW),
      ids: new SequenceIdGenerator(
        Array.from({ length: 64 }, (_, index) => deterministicId(0x900 + index)),
      ),
    },
    notifier: new RecordingNotifier(),
  });
  return { temporary, database: temporary.database, store };
}

function commandRequest(index: number): CommandRequest {
  return Object.freeze({
    id: commandId(deterministicId(0x40 + index)),
    actorSessionId: ACTOR_SESSION_ID,
    aggregateKind: "repository" as const,
    aggregateId: REPOSITORY_ID,
    expectedVersion: index,
    command: Object.freeze({
      typeName: nonEmptyText("minions.v1.ArchiveRepositoryRequest", "command type"),
      bytes: Uint8Array.of(index),
    }),
  });
}

function applyNoOpVersionBump(transaction: SqliteCommandTransaction): AppliedCommand {
  transaction.run("UPDATE repositories SET version = version + 1 WHERE id = ?", [REPOSITORY_ID]);
  return Object.freeze({
    event: Object.freeze({
      typeName: PROJECTION_EVENT_TYPE,
      bytes: new Uint8Array(PROJECTION_EVENT_BYTES),
    }),
    result: Object.freeze({
      typeName: nonEmptyText("minions.v1.ArchiveRepositoryResponse", "result type"),
      bytes: Uint8Array.of(9),
    }),
    externalOperations: [],
  });
}

async function commitEvents(store: SqliteCommandStore, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await store.execute(commandRequest(index), applyNoOpVersionBump);
  }
}

/**
 * Erases a committed event and its idempotency record, as if it had been silently pruned
 * or tampered with. Foreign keys are disabled on this raw connection deliberately: the
 * point of these tests is to observe how `SqliteEventStore` reacts to a log that a
 * legitimate write path could never produce.
 */
function deleteEvent(temporary: TemporarySqliteDatabase, sequence: bigint): void {
  const raw = new DatabaseSync(temporary.path);
  try {
    raw.exec("PRAGMA foreign_keys = OFF;");
    raw.prepare("DELETE FROM idempotency_records WHERE committed_sequence = ?").run(sequence);
    raw.prepare("DELETE FROM events WHERE sequence = ?").run(sequence);
  } finally {
    raw.close();
  }
}

/** The row-level contract a consumer must apply: sequences returned by `readEvents` must
 * increase by exactly one between consecutive rows, or a hole exists in the log. */
function hasContiguousSequences(rows: readonly SqliteStoredEvent[]): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.sequence !== previous.sequence + 1n
    ) {
      return false;
    }
  }
  return true;
}

/** The bounds-level contract a consumer must apply: a cursor older than the retained
 * window has unrecoverably missed events, even if the log downstream of it looks fine. */
function cursorPredatesRetention(cursor: bigint, bounds: SqliteEventBounds): boolean {
  return cursor < bounds.minimumAvailableSequence - 1n;
}

describe("event gap detection: SQLite event store", () => {
  it("reports a gapless, contiguous log when nothing has been removed", async () => {
    const fixture = await createFixture();
    await commitEvents(fixture.store, 5);
    const eventStore = createSqliteEventStore({ database: fixture.database });

    const bounds = eventStore.getBounds();
    expect(bounds).toEqual({ minimumAvailableSequence: 1n, lastSequence: 5n });

    const rows = eventStore.readEvents(0n, 100);
    expect(rows.map((row) => row.sequence)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(hasContiguousSequences(rows)).toBe(true);
    expect(cursorPredatesRetention(0n, bounds)).toBe(false);
  });

  it("flags a gap when a consumer's cursor predates the retained window", async () => {
    const fixture = await createFixture();
    await commitEvents(fixture.store, 5);
    deleteEvent(fixture.temporary, 1n);
    deleteEvent(fixture.temporary, 2n);
    const eventStore = createSqliteEventStore({ database: fixture.database });

    const bounds = eventStore.getBounds();
    expect(bounds).toEqual({ minimumAvailableSequence: 3n, lastSequence: 5n });

    // A consumer that last saw sequence 0 (never read, or its bookmark predates
    // retention) has permanently missed events 1 and 2. This MUST be flagged as a gap.
    expect(cursorPredatesRetention(0n, bounds)).toBe(true);

    // The danger this guards against: reading naively from that stale cursor returns
    // fewer events than were ever committed, with no error raised by `readEvents` itself
    // -- exactly the silent command-loss the event_gap scenario exists to catch. Only a
    // consumer that checks `cursorPredatesRetention` against the bounds first is safe.
    const rows = eventStore.readEvents(0n, 100);
    expect(rows.map((row) => row.sequence)).toEqual([3n, 4n, 5n]);
  });

  it("flags a mid-stream hole even when the retained bounds look perfectly healthy", async () => {
    const fixture = await createFixture();
    await commitEvents(fixture.store, 5);
    deleteEvent(fixture.temporary, 3n);
    const eventStore = createSqliteEventStore({ database: fixture.database });

    // Deleting a MIDDLE event leaves both endpoints intact, so the retention-edge check
    // alone reports a perfectly healthy window -- proving bounds checks are necessary but
    // not sufficient.
    const bounds = eventStore.getBounds();
    expect(bounds).toEqual({ minimumAvailableSequence: 1n, lastSequence: 5n });
    expect(cursorPredatesRetention(0n, bounds)).toBe(false);

    const rows = eventStore.readEvents(0n, 100);
    expect(rows.map((row) => row.sequence)).toEqual([1n, 2n, 4n, 5n]);
    expect(hasContiguousSequences(rows)).toBe(false);

    let gapAfterSequence: bigint | undefined;
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.sequence !== previous.sequence + 1n
      ) {
        gapAfterSequence = previous.sequence;
        break;
      }
    }
    expect(gapAfterSequence).toBe(2n);
  });

  it("rejects a tampered tail as corrupt instead of silently narrowing the visible history", async () => {
    const fixture = await createFixture();
    await commitEvents(fixture.store, 5);
    deleteEvent(fixture.temporary, 5n);
    const eventStore = createSqliteEventStore({ database: fixture.database });

    // Erasing the newest event (to hide evidence of the most recent command) leaves the
    // table's own AUTOINCREMENT high-water mark ahead of its actual maximum row -- the
    // store treats that mismatch as corruption rather than quietly reporting a shorter
    // history, so this specific attack is caught immediately on any read.
    expect(() => eventStore.getBounds()).toThrow(SqliteDatabaseError);
    expect(() => eventStore.getBounds()).toThrow(
      expect.objectContaining({ code: "database_corrupt" }),
    );
  });
});
