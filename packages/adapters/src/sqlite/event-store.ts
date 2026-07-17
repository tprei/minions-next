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
  evidenceId: string | undefined;
}>;

type SqliteArtifactProjection = Readonly<{
  id: string;
  nodeId: string;
  attemptId: string | undefined;
  treeId: string;
  repositoryId: string;
  hostId: string;
  contentDigest: string;
  sizeBytes: bigint;
  mediaType: string;
  artifactType: string;
  evidenceId: string;
  retentionKind: "active" | "archived" | "purge_pending";
  createdAtMs: bigint;
  verifiedAtMs: bigint;
}>;

type SqliteNodeOutcomeProjection = Readonly<{
  nodeId: string;
  createdAtMs: bigint;
}> &
  (
    | Readonly<{
        kind: "artifact";
        artifactId: string;
      }>
    | Readonly<{
        kind: "no_change";
        revision: string;
        evidenceId: string;
        explanation: string;
      }>
    | Readonly<{
        kind: "commit";
        revision: string;
        evidenceId: string;
      }>
  );

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
  artifacts: readonly SqliteArtifactProjection[];
  nodeOutcomes: readonly SqliteNodeOutcomeProjection[];
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
          `SELECT node_id, kind, evidence_id
             FROM (
               SELECT nodes.id AS node_id,
                      CASE WHEN nodes.state_kind = 'failed'
                           THEN 'node_failed'
                           ELSE nodes.blocker_kind
                       END AS kind,
                      CASE WHEN nodes.state_kind = 'failed'
                           THEN nodes.terminal_evidence_id
                           ELSE nodes.blocker_evidence_id
                       END AS evidence_id,
                      nodes.updated_at_ms AS ordered_at_ms
                 FROM nodes
                 JOIN trees ON trees.id = nodes.tree_id
                WHERE trees.archived_at_ms IS NULL
                  AND nodes.state_kind IN ('blocked', 'failed')
               UNION ALL
               SELECT trees.root_node_id AS node_id,
                      'human_input' AS kind,
                      NULL AS evidence_id,
                      plan_attentions.created_at_ms AS ordered_at_ms
                 FROM plan_attentions
                 JOIN trees ON trees.id = plan_attentions.tree_id
                WHERE trees.archived_at_ms IS NULL
                  AND plan_attentions.state_kind = 'open'
             )
            ORDER BY ordered_at_ms, node_id`,
        )
        .map(toAttentionSummary);
      const artifacts = reader
        .all(
          `SELECT a.id, a.node_id, a.attempt_id, a.tree_id, a.repository_id, a.host_id,
                  a.content_digest, a.artifact_type, a.evidence_id, a.retention_kind,
                  a.created_at_ms, c.digest AS blob_digest, c.size_bytes, c.media_type,
                  c.relative_path, c.verified_at_ms,
                  owner.id AS owner_node_id, owner.tree_id AS owner_tree_id,
                  owner.repository_id AS owner_repository_id, owner.host_id AS owner_host_id,
                  attempt.id AS attempt_row_id, attempt.node_id AS attempt_node_id,
                  attempt.tree_id AS attempt_tree_id,
                  attempt.repository_id AS attempt_repository_id,
                  attempt.host_id AS attempt_host_id
             FROM artifacts AS a
             LEFT JOIN content_blobs AS c ON c.digest = a.content_digest
             LEFT JOIN nodes AS owner ON owner.id = a.node_id
             LEFT JOIN attempts AS attempt ON attempt.id = a.attempt_id
            ORDER BY a.id`,
        )
        .map(toArtifactProjection);
      const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
      const missingOutcome = reader.get(
        `SELECT nodes.id
           FROM nodes
          WHERE (nodes.state_kind = 'succeeded' OR nodes.outcome_kind IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM node_outcome_records
               WHERE node_outcome_records.node_id = nodes.id
            )
          LIMIT 1`,
      );
      if (missingOutcome !== undefined) {
        throw corruptEventStore("succeeded node has no normalized outcome");
      }
      const nodeOutcomes = reader
        .all(
          `SELECT outcomes.node_id AS normalized_node_id,
                  outcomes.outcome_kind AS normalized_outcome_kind,
                  outcomes.artifact_id, outcomes.revision, outcomes.evidence_id,
                  outcomes.explanation, outcomes.created_at_ms,
                  owner.id AS owner_node_id, owner.state_kind AS node_state_kind,
                  owner.outcome_kind AS node_outcome_kind,
                  owner.outcome_artifact_id AS node_outcome_artifact_id,
                  owner.outcome_content_hash AS node_outcome_content_hash,
                  owner.outcome_artifact_type AS node_outcome_artifact_type,
                  owner.outcome_commit AS node_outcome_commit,
                  owner.outcome_evidence_id AS node_outcome_evidence_id,
                  owner.outcome_explanation AS node_outcome_explanation
             FROM node_outcome_records AS outcomes
             LEFT JOIN nodes AS owner ON owner.id = outcomes.node_id
            ORDER BY outcomes.node_id`,
        )
        .map((row) => toNodeOutcomeProjection(row, artifactsById));

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
        artifacts: Object.freeze(artifacts),
        nodeOutcomes: Object.freeze(nodeOutcomes),
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

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function toArtifactProjection(row: SqliteRow): SqliteArtifactProjection {
  const id = requiredUuid(row, "id");
  const nodeId = requiredUuid(row, "node_id");
  const treeId = requiredUuid(row, "tree_id");
  const repositoryId = requiredUuid(row, "repository_id");
  const hostId = requiredUuid(row, "host_id");
  if (
    nodeId !== requiredUuid(row, "owner_node_id") ||
    treeId !== requiredUuid(row, "owner_tree_id") ||
    repositoryId !== requiredUuid(row, "owner_repository_id") ||
    hostId !== requiredUuid(row, "owner_host_id")
  ) {
    throw corruptEventStore("artifact ownership does not match its node");
  }
  const attemptId = optionalUuid(row, "attempt_id");
  const attemptRowId = optionalUuid(row, "attempt_row_id");
  if (attemptId !== attemptRowId) {
    throw corruptEventStore("artifact attempt ownership is corrupt");
  }
  if (attemptId !== undefined) {
    if (
      nodeId !== requiredUuid(row, "attempt_node_id") ||
      treeId !== requiredUuid(row, "attempt_tree_id") ||
      repositoryId !== requiredUuid(row, "attempt_repository_id") ||
      hostId !== requiredUuid(row, "attempt_host_id")
    ) {
      throw corruptEventStore("artifact attempt ownership is corrupt");
    }
  }
  const contentDigest = requiredContentHash(row, "content_digest");
  if (contentDigest !== requiredContentHash(row, "blob_digest")) {
    throw corruptEventStore("artifact blob digest does not match its content digest");
  }
  const relativePath = requiredNonEmptyString(row, "relative_path");
  if (relativePath !== canonicalBlobPath(contentDigest)) {
    throw corruptEventStore("artifact blob path is not canonical");
  }
  const createdAtMs = nonNegativeBigint(row, "created_at_ms");
  return Object.freeze({
    id,
    nodeId,
    attemptId,
    treeId,
    repositoryId,
    hostId,
    contentDigest,
    sizeBytes: nonNegativeBigint(row, "size_bytes"),
    mediaType: requiredNonEmptyString(row, "media_type"),
    artifactType: requiredNonEmptyString(row, "artifact_type"),
    evidenceId: requiredUuid(row, "evidence_id"),
    retentionKind: retentionKind(row, "retention_kind"),
    createdAtMs,
    verifiedAtMs: nonNegativeBigint(row, "verified_at_ms"),
  });
}

function toNodeOutcomeProjection(
  row: SqliteRow,
  artifactsById: ReadonlyMap<string, SqliteArtifactProjection>,
): SqliteNodeOutcomeProjection {
  const nodeId = requiredUuid(row, "normalized_node_id");
  if (nodeId !== requiredUuid(row, "owner_node_id")) {
    throw corruptEventStore("node outcome ownership does not match its node");
  }
  if (requiredString(row, "node_state_kind") !== "succeeded") {
    throw corruptEventStore("non-succeeded node has a normalized outcome");
  }
  const kind = requiredString(row, "normalized_outcome_kind");
  if (kind !== requiredString(row, "node_outcome_kind")) {
    throw corruptEventStore("node outcome normalization disagrees with node columns");
  }
  const artifactId = optionalUuid(row, "artifact_id");
  const revision = optionalGitSha(row, "revision");
  const evidenceId = optionalUuid(row, "evidence_id");
  const explanation = optionalNonEmptyString(row, "explanation");
  const nodeArtifactId = optionalUuid(row, "node_outcome_artifact_id");
  const nodeContentHash = optionalContentHash(row, "node_outcome_content_hash");
  const nodeArtifactType = optionalNonEmptyString(row, "node_outcome_artifact_type");
  const nodeCommit = optionalGitSha(row, "node_outcome_commit");
  const nodeEvidenceId = optionalUuid(row, "node_outcome_evidence_id");
  const nodeExplanation = optionalNonEmptyString(row, "node_outcome_explanation");
  const createdAtMs = nonNegativeBigint(row, "created_at_ms");

  if (kind === "artifact") {
    const artifact = artifactId === undefined ? undefined : artifactsById.get(artifactId);
    if (artifact === undefined) {
      throw corruptEventStore("artifact outcome normalization is corrupt");
    }
    if (
      artifact.nodeId !== nodeId ||
      revision !== undefined ||
      evidenceId !== undefined ||
      explanation !== undefined ||
      nodeArtifactId !== artifact.id ||
      nodeContentHash !== artifact.contentDigest ||
      nodeArtifactType !== artifact.artifactType ||
      nodeCommit !== undefined ||
      nodeEvidenceId !== artifact.evidenceId ||
      nodeExplanation !== undefined
    ) {
      throw corruptEventStore("artifact outcome normalization is corrupt");
    }
    return Object.freeze({
      nodeId,
      kind: "artifact",
      artifactId: artifact.id,
      createdAtMs,
    });
  }
  if (kind === "no_change") {
    if (
      artifactId !== undefined ||
      revision === undefined ||
      evidenceId === undefined ||
      explanation === undefined ||
      nodeArtifactId !== undefined ||
      nodeContentHash !== undefined ||
      nodeArtifactType !== undefined ||
      nodeCommit !== undefined ||
      nodeEvidenceId !== evidenceId ||
      nodeExplanation !== explanation
    ) {
      throw corruptEventStore("no-change outcome normalization is corrupt");
    }
    return Object.freeze({
      nodeId,
      kind: "no_change",
      revision,
      evidenceId,
      explanation,
      createdAtMs,
    });
  }
  if (kind === "commit") {
    if (
      artifactId !== undefined ||
      revision === undefined ||
      evidenceId === undefined ||
      explanation !== undefined ||
      nodeArtifactId !== undefined ||
      nodeContentHash !== undefined ||
      nodeArtifactType !== undefined ||
      nodeCommit !== revision ||
      nodeEvidenceId !== evidenceId ||
      nodeExplanation !== undefined
    ) {
      throw corruptEventStore("commit outcome normalization is corrupt");
    }
    return Object.freeze({
      nodeId,
      kind: "commit",
      revision,
      evidenceId,
      createdAtMs,
    });
  }
  throw corruptEventStore("node outcome record kind is invalid");
}

function requiredUuid(row: SqliteRow, key: string): string {
  const value = requiredString(row, key);
  if (!UUID_V7_PATTERN.test(value)) {
    throw corruptEventStore(`${key} is not a lowercase UUIDv7`);
  }
  return value;
}

function optionalUuid(row: SqliteRow, key: string): string | undefined {
  const value = optionalNonEmptyString(row, key);
  if (value === undefined) {
    return undefined;
  }
  if (!UUID_V7_PATTERN.test(value)) {
    throw corruptEventStore(`${key} is not a lowercase UUIDv7`);
  }
  return value;
}

function requiredContentHash(row: SqliteRow, key: string): string {
  const value = requiredString(row, key);
  if (!CONTENT_HASH_PATTERN.test(value)) {
    throw corruptEventStore(`${key} is not a lowercase content hash`);
  }
  return value;
}

function optionalContentHash(row: SqliteRow, key: string): string | undefined {
  const value = optionalNonEmptyString(row, key);
  if (value === undefined) {
    return undefined;
  }
  if (!CONTENT_HASH_PATTERN.test(value)) {
    throw corruptEventStore(`${key} is not a lowercase content hash`);
  }
  return value;
}

function optionalGitSha(row: SqliteRow, key: string): string | undefined {
  const value = optionalNonEmptyString(row, key);
  if (value === undefined) {
    return undefined;
  }
  if (!GIT_SHA_PATTERN.test(value)) {
    throw corruptEventStore(`${key} is not a lowercase Git SHA`);
  }
  return value;
}

function requiredNonEmptyString(row: SqliteRow, key: string): string {
  const value = requiredString(row, key);
  if (value.trim().length === 0) {
    throw corruptEventStore(`${key} is empty`);
  }
  return value;
}

function optionalNonEmptyString(row: SqliteRow, key: string): string | undefined {
  const value = row[key];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw corruptEventStore(`${key} is not null or a non-empty string`);
  }
  return value;
}

function retentionKind(row: SqliteRow, key: string): SqliteArtifactProjection["retentionKind"] {
  switch (requiredString(row, key)) {
    case "active":
      return "active";
    case "archived":
      return "archived";
    case "purge_pending":
      return "purge_pending";
    default:
      throw corruptEventStore(`${key} is not a supported artifact retention kind`);
  }
}

function canonicalBlobPath(contentDigest: string): string {
  return `sha256/${contentDigest.slice(0, 2)}/${contentDigest.slice(2, 4)}/${contentDigest}`;
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
    evidenceId: optionalString(row, "evidence_id"),
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
