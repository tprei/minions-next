import type { ManagedSqliteDatabase, SqliteRow } from "./database.js";
import { SqliteDatabaseError } from "./error.js";

export type SqliteHostSummary = Readonly<{
  id: string;
  online: boolean;
  version: number;
}>;

export type SqliteRepositorySummary = Readonly<{
  id: string;
  hostId: string;
  version: number;
  archived: boolean;
}>;

export type SqliteTreeSummary = Readonly<{
  id: string;
  repositoryId: string;
  hostId: string;
  rootNodeId: string;
  activePlanRevisionId: string;
  planStateKind: string;
  rootStateKind: string;
  version: number;
}>;

export type SqliteNodeSummary = Readonly<{
  id: string;
  treeId: string;
  parentNodeId: string | undefined;
  ordinal: number;
  objective: string;
  stateKind: string;
  version: number;
}>;

export type SqliteAttentionSummary = Readonly<{
  nodeId: string;
  kind: string;
  evidenceId: string;
}>;

export type SqliteEventBounds = Readonly<{
  minimumAvailableSequence: bigint;
  lastSequence: bigint;
}>;

export type SqliteEventSnapshot = Readonly<{
  hosts: readonly SqliteHostSummary[];
  repositories: readonly SqliteRepositorySummary[];
  trees: readonly SqliteTreeSummary[];
  nodes: readonly SqliteNodeSummary[];
  attention: readonly SqliteAttentionSummary[];
  minimumAvailableSequence: bigint;
  lastSequence: bigint;
}>;

export type SqliteStoredEvent = Readonly<{
  sequence: bigint;
  eventId: string;
  aggregateKind: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  eventPayload: Uint8Array;
  occurredAtMs: bigint;
}>;

export interface SqliteEventStore {
  getSnapshot(): SqliteEventSnapshot;
  getBounds(): SqliteEventBounds;
  readEvents(afterSequence: bigint, limit: number): readonly SqliteStoredEvent[];
}

export type OpenSqliteEventStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

export function createSqliteEventStore(options: OpenSqliteEventStoreOptions): SqliteEventStore {
  return new DefaultSqliteEventStore(options.database);
}

class DefaultSqliteEventStore implements SqliteEventStore {
  readonly #database: ManagedSqliteDatabase;

  constructor(database: ManagedSqliteDatabase) {
    this.#database = database;
  }

  getSnapshot(): SqliteEventSnapshot {
    return this.#database.snapshot((reader) => {
      const hosts = reader
        .all("SELECT DISTINCT host_id AS id FROM repositories ORDER BY host_id")
        .map(toHostSummary);
      const repositories = reader
        .all(
          "SELECT id, host_id, version, archived_at_ms IS NOT NULL AS archived FROM repositories ORDER BY id",
        )
        .map(toRepositorySummary);
      const trees = reader
        .all(
          `SELECT trees.id, trees.repository_id, trees.host_id, trees.root_node_id,
                  trees.active_plan_revision_id, trees.version,
                  plan_revisions.state_kind AS plan_state_kind,
                  root_nodes.state_kind AS root_state_kind
             FROM trees
             JOIN plan_revisions
               ON plan_revisions.tree_id = trees.id
              AND plan_revisions.id = trees.active_plan_revision_id
             JOIN nodes AS root_nodes
               ON root_nodes.tree_id = trees.id
              AND root_nodes.id = trees.root_node_id
            WHERE trees.archived_at_ms IS NULL
            ORDER BY trees.id`,
        )
        .map(toTreeSummary);
      const nodes = reader
        .all(
          `SELECT nodes.id, nodes.tree_id, nodes.parent_node_id, nodes.objective,
                  nodes.state_kind, nodes.version,
                  ROW_NUMBER() OVER (
                    PARTITION BY nodes.tree_id, nodes.parent_node_id
                    ORDER BY nodes.created_at_ms, nodes.id
                  ) - 1 AS ordinal
             FROM nodes
             JOIN trees ON trees.id = nodes.tree_id
            WHERE trees.archived_at_ms IS NULL
            ORDER BY nodes.tree_id, nodes.parent_node_id, nodes.created_at_ms, nodes.id`,
        )
        .map(toNodeSummary);
      const attention = reader
        .all(
          `SELECT nodes.id AS node_id,
                  CASE WHEN nodes.state_kind = 'failed' THEN 'node_failed' ELSE nodes.blocker_kind END AS kind,
                  CASE WHEN nodes.state_kind = 'failed' THEN nodes.terminal_evidence_id ELSE nodes.blocker_evidence_id END AS evidence_id
             FROM nodes
             JOIN trees ON trees.id = nodes.tree_id
            WHERE trees.archived_at_ms IS NULL
              AND nodes.state_kind IN ('blocked', 'failed')
            ORDER BY nodes.updated_at_ms, nodes.id`,
        )
        .map(toAttentionSummary);
      const bounds = readBounds(
        reader.get(
          "SELECT min(sequence) AS minimum_sequence, max(sequence) AS maximum_sequence FROM events",
        ),
        reader.get("SELECT seq FROM sqlite_sequence WHERE name = 'events'"),
      );

      return Object.freeze({
        hosts: Object.freeze(hosts),
        repositories: Object.freeze(repositories),
        trees: Object.freeze(trees),
        nodes: Object.freeze(nodes),
        attention: Object.freeze(attention),
        ...bounds,
      });
    });
  }

  getBounds(): SqliteEventBounds {
    return this.#database.snapshot((reader) =>
      readBounds(
        reader.get(
          "SELECT min(sequence) AS minimum_sequence, max(sequence) AS maximum_sequence FROM events",
        ),
        reader.get("SELECT seq FROM sqlite_sequence WHERE name = 'events'"),
      ),
    );
  }

  readEvents(afterSequence: bigint, limit: number): readonly SqliteStoredEvent[] {
    if (afterSequence < 0n) {
      throw new RangeError("afterSequence must be non-negative");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new RangeError("limit must be a positive safe integer no greater than 1000");
    }
    const rows = this.#database.read((reader) =>
      reader.all(
        `SELECT sequence, event_id, aggregate_kind, aggregate_id, aggregate_version,
                event_type, event_payload, occurred_at_ms
           FROM events
          WHERE sequence > ?
          ORDER BY sequence
          LIMIT ?`,
        [afterSequence, limit],
      ),
    );
    return Object.freeze(rows.map(toStoredEvent));
  }
}

function readBounds(
  aggregateRow: SqliteRow | undefined,
  sequenceRow: SqliteRow | undefined,
): SqliteEventBounds {
  if (aggregateRow === undefined) {
    throw corruptEventStore("event bounds query returned no row");
  }
  const maximum = nullableBigint(aggregateRow, "maximum_sequence");
  const recordedMaximum =
    sequenceRow === undefined ? undefined : nonNegativeBigint(sequenceRow, "seq");
  const lastSequence = maximum ?? recordedMaximum ?? 0n;
  if (recordedMaximum !== undefined && recordedMaximum < lastSequence) {
    throw corruptEventStore("SQLite event sequence is behind retained events");
  }
  if (maximum !== undefined && recordedMaximum !== undefined && recordedMaximum !== maximum) {
    throw corruptEventStore("SQLite event sequence does not match retained event history");
  }
  const minimum = nullableBigint(aggregateRow, "minimum_sequence");
  const minimumAvailableSequence = minimum ?? lastSequence + 1n;
  if (minimumAvailableSequence < 1n || minimumAvailableSequence > lastSequence + 1n) {
    throw corruptEventStore("event retention bounds are invalid");
  }
  return Object.freeze({ minimumAvailableSequence, lastSequence });
}

function toHostSummary(row: SqliteRow): SqliteHostSummary {
  return Object.freeze({
    id: requiredString(row, "id"),
    online: true,
    version: 0,
  });
}

function toRepositorySummary(row: SqliteRow): SqliteRepositorySummary {
  return Object.freeze({
    id: requiredString(row, "id"),
    hostId: requiredString(row, "host_id"),
    version: safeNumber(row, "version"),
    archived: booleanInteger(row, "archived"),
  });
}

function toTreeSummary(row: SqliteRow): SqliteTreeSummary {
  return Object.freeze({
    id: requiredString(row, "id"),
    repositoryId: requiredString(row, "repository_id"),
    hostId: requiredString(row, "host_id"),
    rootNodeId: requiredString(row, "root_node_id"),
    activePlanRevisionId: requiredString(row, "active_plan_revision_id"),
    planStateKind: requiredString(row, "plan_state_kind"),
    rootStateKind: requiredString(row, "root_state_kind"),
    version: safeNumber(row, "version"),
  });
}

function toNodeSummary(row: SqliteRow): SqliteNodeSummary {
  return Object.freeze({
    id: requiredString(row, "id"),
    treeId: requiredString(row, "tree_id"),
    parentNodeId: optionalString(row, "parent_node_id"),
    ordinal: safeNumber(row, "ordinal"),
    objective: requiredString(row, "objective"),
    stateKind: requiredString(row, "state_kind"),
    version: safeNumber(row, "version"),
  });
}

function toAttentionSummary(row: SqliteRow): SqliteAttentionSummary {
  return Object.freeze({
    nodeId: requiredString(row, "node_id"),
    kind: requiredString(row, "kind"),
    evidenceId: requiredString(row, "evidence_id"),
  });
}

function toStoredEvent(row: SqliteRow): SqliteStoredEvent {
  const payload = row["event_payload"];
  if (!(payload instanceof Uint8Array)) {
    throw corruptEventStore("event payload is not binary");
  }
  return Object.freeze({
    sequence: positiveBigint(row, "sequence"),
    eventId: requiredString(row, "event_id"),
    aggregateKind: requiredString(row, "aggregate_kind"),
    aggregateId: requiredString(row, "aggregate_id"),
    aggregateVersion: positiveSafeNumber(row, "aggregate_version"),
    eventType: requiredString(row, "event_type"),
    eventPayload: new Uint8Array(payload),
    occurredAtMs: nonNegativeBigint(row, "occurred_at_ms"),
  });
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw corruptEventStore(`${key} is not a non-empty string`);
  }
  return value;
}

function optionalString(row: SqliteRow, key: string): string | undefined {
  const value = row[key];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw corruptEventStore(`${key} is not null or a non-empty string`);
  }
  return value;
}

function booleanInteger(row: SqliteRow, key: string): boolean {
  const value = row[key];
  if (value === 0n) {
    return false;
  }
  if (value === 1n) {
    return true;
  }
  throw corruptEventStore(`${key} is not a SQLite boolean`);
}

function safeNumber(row: SqliteRow, key: string): number {
  const value = nonNegativeBigint(row, key);
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw corruptEventStore(`${key} exceeds the safe integer range`);
  }
  return converted;
}

function positiveSafeNumber(row: SqliteRow, key: string): number {
  const value = safeNumber(row, key);
  if (value < 1) {
    throw corruptEventStore(`${key} is not positive`);
  }
  return value;
}

function nonNegativeBigint(row: SqliteRow, key: string): bigint {
  const value = row[key];
  if (typeof value !== "bigint" || value < 0n) {
    throw corruptEventStore(`${key} is not a non-negative integer`);
  }
  return value;
}

function positiveBigint(row: SqliteRow, key: string): bigint {
  const value = nonNegativeBigint(row, key);
  if (value < 1n) {
    throw corruptEventStore(`${key} is not positive`);
  }
  return value;
}

function nullableBigint(row: SqliteRow, key: string): bigint | undefined {
  if (row[key] === null) {
    return undefined;
  }
  return nonNegativeBigint(row, key);
}

function corruptEventStore(message: string): SqliteDatabaseError {
  return new SqliteDatabaseError("database_corrupt", `SQLite event store is corrupt: ${message}`);
}
