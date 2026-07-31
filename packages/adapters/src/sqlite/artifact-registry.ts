import { create, fromBinary, toBinary, type MessageShape } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import {
  ArtifactOutcomeSchema,
  ArtifactRetention as ProtoArtifactRetention,
  ArtifactSchema,
  CommitOutcomeSchema,
  CreateArtifactResponseSchema,
  findUnknownField,
  PersistArtifactCommandSchema,
  NodeOutcomeSchema,
  NodeState,
  NodeSummarySchema,
  NoChangeOutcomeSchema,
  ProjectionBatchSchema,
  ProjectionChangeSchema,
  RecordNodeOutcomeRequestSchema,
  RecordNodeOutcomeResponseSchema,
} from "@minions/contracts";
import type {
  ArtifactRecord,
  ArtifactRegistry,
  ArtifactRetention,
  CreateArtifactRequest,
  ExpectedBlob,
  ListArtifactsRequest,
  NodeOutcomeRecord,
  RecordNodeOutcomeRequest,
  RecordedNodeOutcome,
  StoredBlob,
  Timestamp,
} from "@minions/core";
import {
  actorSessionId,
  artifactId,
  attemptId,
  commandId,
  contentHash,
  DomainError,
  evidenceId,
  gitSha,
  hostId,
  nonEmptyText,
  repositoryId,
  taskNodeId,
  timestampFromEpochMilliseconds,
  taskTreeId,
  type ActorSessionId,
  type ArtifactId,
  type AttemptId,
  type CommandId,
  type ContentHash,
  type EvidenceId,
  type GitSha,
  type HostId,
  type NonEmptyText,
  type RepositoryId,
  type TaskNodeId,
  type TaskTreeId,
} from "@minions/core";

import type { ManagedSqliteDatabase, SqliteReader, SqliteRow } from "./database.js";
import { SqliteCommandError } from "./command-error.js";
import type { SqliteCommandStore, SqliteCommandTransaction } from "./command.js";

export type CreateSqliteArtifactRegistryOptions = Readonly<{
  database: ManagedSqliteDatabase;
  commandStore: SqliteCommandStore;
  hostId: HostId;
}>;

export type ArtifactRegistryErrorCode =
  | "not_found"
  | "invalid_input"
  | "invalid_outcome"
  | "identity_conflict"
  | "facts_changed"
  | "corrupt";

export class ArtifactRegistryError extends Error {
  readonly code: ArtifactRegistryErrorCode;

  constructor(code: ArtifactRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactRegistryError";
    this.code = code;
  }
}

export function createSqliteArtifactRegistry(
  options: CreateSqliteArtifactRegistryOptions,
): ArtifactRegistry {
  const trustedHostId = parseHostId(options.hostId, "host ID");
  return new DefaultSqliteArtifactRegistry(options.database, options.commandStore, trustedHostId);
}

type CreateSnapshot = Readonly<{
  request: CreateArtifactRequest;
  requestBytes: Uint8Array;
}>;

type OutcomeSnapshot = Readonly<{
  request: RecordNodeOutcomeRequest;
  requestBytes: Uint8Array;
}>;

type NodeMutationRecord = Readonly<{
  id: TaskNodeId;
  treeId: TaskTreeId;
  rootNodeId: TaskNodeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  parentNodeId: TaskNodeId | undefined;
  planRevisionId: string;
  mode: string;
  objective: NonEmptyText;
  outputKind: "artifact" | "implementation";
  outputArtifactId: ArtifactId | undefined;
  outputArtifactType: NonEmptyText | undefined;
  stateKind: string;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  outcomeKind: "artifact" | "commit" | "no_change" | undefined;
  outcomeArtifactId: ArtifactId | undefined;
  outcomeContentHash: ContentHash | undefined;
  outcomeArtifactType: NonEmptyText | undefined;
  outcomeCommit: GitSha | undefined;
  outcomeEvidenceId: EvidenceId | undefined;
  outcomeExplanation: NonEmptyText | undefined;
  treeBaseCommit: GitSha;
  treeArchived: boolean;
  repositoryArchived: boolean;
  activePlanRevisionId: string;
  planRevisionState: string;
}>;

type EncodedEffect = Readonly<{
  event: Readonly<{ typeName: NonEmptyText; bytes: Uint8Array }>;
  result: Readonly<{ typeName: NonEmptyText; bytes: Uint8Array }>;
  externalOperations: readonly [];
}>;

class DefaultSqliteArtifactRegistry implements ArtifactRegistry {
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

  async create(input: CreateArtifactRequest): Promise<ArtifactRecord> {
    let snapshot: CreateSnapshot;
    try {
      snapshot = snapshotCreateInput(input);
    } catch (error) {
      throw normalizeArtifactError(error, "artifact create request is invalid");
    }
    const expectedVersion = this.#expectedNodeVersion(
      snapshot.request.commandId,
      snapshot.request.nodeId,
      snapshot.request.expectedNodeVersion,
    );
    const command = commandRequest(
      snapshot.request.commandId,
      snapshot.request.actorSessionId,
      snapshot.request.nodeId,
      expectedVersion,
      PersistArtifactCommandSchema.typeName,
      snapshot.requestBytes,
    );
    try {
      const receipt = await this.#commandStore.execute(command, (transaction) =>
        applyCreate(transaction, snapshot.request, this.#hostId),
      );
      return this.#resultArtifact(receipt.result, receipt.aggregateVersion, snapshot);
    } catch (error) {
      throw normalizeArtifactError(error, "artifact command failed");
    }
  }

  get(id: ArtifactId): ArtifactRecord | undefined {
    const parsed = parseArtifactId(id, "artifact ID");
    try {
      return this.#database.read((reader) => {
        const row = reader.get(`${artifactQuery()} WHERE a.id = ?`, [parsed]);
        if (row === undefined || requiredString(row, "host_id") !== this.#hostId) return undefined;
        return artifactFromRow(reader, row, this.#hostId);
      });
    } catch (error) {
      throw normalizeArtifactError(error, "artifact read failed");
    }
  }

  list(input: ListArtifactsRequest): readonly ArtifactRecord[] {
    let nodeId: TaskNodeId;
    let afterArtifactId: ArtifactId | undefined;
    try {
      nodeId = parseNodeId(input.nodeId, "node ID");
      afterArtifactId =
        input.afterArtifactId === undefined
          ? undefined
          : parseArtifactId(input.afterArtifactId, "cursor artifact ID");
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 201) {
        throw new ArtifactRegistryError(
          "invalid_input",
          "artifact list limit must be between 1 and 201",
        );
      }
    } catch (error) {
      throw normalizeArtifactError(error, "artifact list request is invalid");
    }
    try {
      return this.#database.read((reader) => {
        const node = reader.get("SELECT host_id FROM nodes WHERE id = ?", [nodeId]);
        if (node === undefined || requiredString(node, "host_id") !== this.#hostId) {
          return Object.freeze([]);
        }
        const rows =
          afterArtifactId === undefined
            ? reader.all(`${artifactQuery()} WHERE a.node_id = ? ORDER BY a.id LIMIT ?`, [
                nodeId,
                input.limit,
              ])
            : reader.all(
                `${artifactQuery()} WHERE a.node_id = ? AND a.id > ? ORDER BY a.id LIMIT ?`,
                [nodeId, afterArtifactId, input.limit],
              );
        return Object.freeze(rows.map((row) => artifactFromRow(reader, row, this.#hostId)));
      });
    } catch (error) {
      throw normalizeArtifactError(error, "artifact list failed");
    }
  }

  expectedBlobs(): readonly ExpectedBlob[] {
    try {
      return this.#database.read((reader) => {
        const rows = reader.all(
          `SELECT digest, size_bytes, relative_path
             FROM content_blobs ORDER BY digest`,
        );
        return Object.freeze(rows.map(expectedBlobFromRow));
      });
    } catch (error) {
      throw normalizeArtifactError(error, "expected blob read failed");
    }
  }

  async recordOutcome(input: RecordNodeOutcomeRequest): Promise<NodeOutcomeRecord> {
    let snapshot: OutcomeSnapshot;
    try {
      snapshot = snapshotOutcomeInput(input);
    } catch (error) {
      throw normalizeArtifactError(error, "node outcome request is invalid");
    }
    const command = commandRequest(
      snapshot.request.commandId,
      snapshot.request.actorSessionId,
      snapshot.request.nodeId,
      snapshot.request.expectedNodeVersion,
      RecordNodeOutcomeRequestSchema.typeName,
      snapshot.requestBytes,
    );
    try {
      const receipt = await this.#commandStore.execute(command, (transaction) =>
        applyOutcome(transaction, snapshot.request, this.#hostId),
      );
      return this.#resultOutcome(receipt.result, receipt.aggregateVersion, snapshot);
    } catch (error) {
      throw normalizeArtifactError(error, "node outcome command failed");
    }
  }

  getOutcome(nodeId: TaskNodeId): NodeOutcomeRecord | undefined {
    const parsed = parseNodeId(nodeId, "node ID");
    try {
      return this.#database.read((reader) => {
        const node = reader.get("SELECT host_id FROM nodes WHERE id = ?", [parsed]);
        if (node === undefined || requiredString(node, "host_id") !== this.#hostId)
          return undefined;
        return readNormalizedOutcome(reader, parsed);
      });
    } catch (error) {
      throw normalizeArtifactError(error, "node outcome read failed");
    }
  }

  #expectedNodeVersion(
    command: CommandId,
    nodeId: TaskNodeId,
    requested: number | undefined,
  ): number {
    try {
      return this.#database.read((reader) => {
        const row = reader.get(
          `SELECT aggregate_kind, aggregate_id, expected_version
             FROM operator_commands WHERE id = ?`,
          [command],
        );
        if (
          row?.["aggregate_kind"] === "node" &&
          row["aggregate_id"] === nodeId &&
          row["expected_version"] !== null
        ) {
          return safeInteger(row["expected_version"], "stored expected node version");
        }
        const node = reader.get("SELECT version FROM nodes WHERE id = ?", [nodeId]);
        if (node === undefined) {
          throw new ArtifactRegistryError("not_found", "node does not exist");
        }
        return requested ?? safeInteger(node["version"], "node version");
      });
    } catch (error) {
      throw normalizeArtifactError(error, "node version read failed");
    }
  }

  #resultArtifact(
    result: Readonly<{ typeName: string; bytes: Uint8Array }>,
    aggregateVersion: number,
    snapshot: CreateSnapshot,
  ): ArtifactRecord {
    if (result.typeName !== CreateArtifactResponseSchema.typeName) {
      throw new ArtifactRegistryError("corrupt", "artifact result type does not match the command");
    }
    try {
      const decoded = fromBinary(CreateArtifactResponseSchema, result.bytes);
      if (findUnknownField(CreateArtifactResponseSchema, decoded) !== undefined) {
        throw new TypeError("artifact result contains unknown fields");
      }
      if (decoded.artifact === undefined)
        throw new TypeError("artifact result is missing artifact");
      if (!Number.isSafeInteger(aggregateVersion) || aggregateVersion < 1) {
        throw new TypeError("artifact result version is invalid");
      }
      const artifact = artifactFromMessage(decoded.artifact);
      assertArtifactMatchesRequest(artifact, snapshot.request);
      if (
        artifact.nodeId !== snapshot.request.nodeId ||
        artifact.id !== snapshot.request.artifactId
      ) {
        throw new TypeError("artifact result identity differs from request");
      }
      const persisted = this.#database.read((reader) => {
        const row = reader.get(`${artifactQuery()} WHERE a.id = ?`, [snapshot.request.artifactId]);
        if (row === undefined) throw new TypeError("artifact result is not persisted");
        return artifactFromRow(reader, row, this.#hostId);
      });
      assertArtifactEquivalent(artifact, persisted);
      return persisted;
    } catch (error) {
      if (error instanceof ArtifactRegistryError) throw error;
      throw new ArtifactRegistryError("corrupt", "artifact command result is corrupt", {
        cause: error,
      });
    }
  }

  #resultOutcome(
    result: Readonly<{ typeName: string; bytes: Uint8Array }>,
    aggregateVersion: number,
    snapshot: OutcomeSnapshot,
  ): NodeOutcomeRecord {
    if (result.typeName !== RecordNodeOutcomeResponseSchema.typeName) {
      throw new ArtifactRegistryError(
        "corrupt",
        "node outcome result type does not match the command",
      );
    }
    try {
      const decoded = fromBinary(RecordNodeOutcomeResponseSchema, result.bytes);
      if (findUnknownField(RecordNodeOutcomeResponseSchema, decoded) !== undefined) {
        throw new TypeError("node outcome result contains unknown fields");
      }
      if (decoded.outcome === undefined)
        throw new TypeError("node outcome result is missing outcome");
      const outcome = outcomeFromMessage(decoded.outcome);
      if (outcome.nodeId !== snapshot.request.nodeId) {
        throw new TypeError("node outcome result identity differs from request");
      }
      assertRecordedOutcomeEqual(outcome.outcome, snapshot.request.outcome);
      if (aggregateVersion < 1) throw new TypeError("node outcome result version is invalid");
      const persisted = this.#database.read((reader) =>
        readNormalizedOutcome(reader, outcome.nodeId),
      );
      if (persisted === undefined) throw new TypeError("node outcome result is not persisted");
      assertOutcomeRecordEquivalent(outcome, persisted);
      return persisted;
    } catch (error) {
      if (error instanceof ArtifactRegistryError) throw error;
      throw new ArtifactRegistryError("corrupt", "node outcome command result is corrupt", {
        cause: error,
      });
    }
  }
}

function snapshotCreateInput(input: CreateArtifactRequest): CreateSnapshot {
  const request = snapshotCreateArtifactRequest(input);
  if (typeof request.blob.created !== "boolean") {
    throw new ArtifactRegistryError("invalid_input", "blob creation receipt is invalid");
  }
  const expectedPath = blobPath(request.blob.digest);
  if (request.blob.relativePath !== expectedPath) {
    throw new ArtifactRegistryError("invalid_input", "blob relative path is not canonical");
  }
  if (request.blob.verifiedAt > request.at) {
    throw new ArtifactRegistryError(
      "invalid_input",
      "blob verification follows artifact timestamp",
    );
  }
  const message = create(PersistArtifactCommandSchema, {
    artifactId: request.artifactId,
    nodeId: request.nodeId,
    ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
    mediaType: request.mediaType,
    artifactType: request.artifactType,
    evidenceId: request.evidenceId,
    retention: retentionToProto(request.retention),
    contentDigest: request.blob.digest,
    sizeBytes: request.blob.sizeBytes,
    relativePath: request.blob.relativePath,
    verifiedAt: timestampMessage(request.blob.verifiedAt),
  });
  return Object.freeze({
    request,
    requestBytes: toBinary(PersistArtifactCommandSchema, message),
  });
}

function snapshotOutcomeInput(input: RecordNodeOutcomeRequest): OutcomeSnapshot {
  const request = snapshotRecordNodeOutcomeRequest(input);
  const message = create(RecordNodeOutcomeRequestSchema, {
    commandId: request.commandId,
    actorSessionId: request.actorSessionId,
    nodeId: request.nodeId,
    expectedNodeVersion: BigInt(request.expectedNodeVersion),
    outcome: outcomeToMessage(request.outcome),
  });
  return Object.freeze({
    request,
    requestBytes: toBinary(RecordNodeOutcomeRequestSchema, message),
  });
}

function snapshotCreateArtifactRequest(input: CreateArtifactRequest): CreateArtifactRequest {
  try {
    if (input.blob.sizeBytes < 0n) throw new DomainError("invalid_value", "blob size is negative");
    const expectedNodeVersion = input.expectedNodeVersion;
    if (
      expectedNodeVersion !== undefined &&
      (!Number.isSafeInteger(expectedNodeVersion) || expectedNodeVersion < 0)
    ) {
      throw new DomainError("invalid_value", "expected node version is invalid");
    }
    return Object.freeze({
      commandId: commandId(input.commandId),
      actorSessionId: actorSessionId(input.actorSessionId),
      artifactId: artifactId(input.artifactId),
      nodeId: taskNodeId(input.nodeId),
      attemptId: input.attemptId === undefined ? undefined : attemptId(input.attemptId),
      expectedNodeVersion,
      mediaType: nonEmptyText(input.mediaType, "artifact media type"),
      artifactType: nonEmptyText(input.artifactType, "artifact type"),
      evidenceId: evidenceId(input.evidenceId),
      retention: retentionFromValue(input.retention),
      blob: snapshotStoredBlob(input.blob),
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    if (error instanceof ArtifactRegistryError) throw error;
    throw new ArtifactRegistryError("invalid_input", "artifact create request is invalid", {
      cause: error,
    });
  }
}

function snapshotStoredBlob(input: StoredBlob): StoredBlob {
  if (typeof input.created !== "boolean") {
    throw new DomainError("invalid_value", "blob creation receipt is invalid");
  }
  return Object.freeze({
    digest: contentHash(input.digest),
    sizeBytes: input.sizeBytes,
    relativePath: nonEmptyText(input.relativePath, "blob relative path"),
    verifiedAt: timestampFromEpochMilliseconds(input.verifiedAt),
    created: input.created,
  });
}

function snapshotRecordNodeOutcomeRequest(
  input: RecordNodeOutcomeRequest,
): RecordNodeOutcomeRequest {
  try {
    if (!Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 0) {
      throw new DomainError("invalid_value", "expected node version is invalid");
    }
    const outcome = snapshotRecordedOutcome(input.outcome);
    return Object.freeze({
      commandId: commandId(input.commandId),
      actorSessionId: actorSessionId(input.actorSessionId),
      nodeId: taskNodeId(input.nodeId),
      expectedNodeVersion: input.expectedNodeVersion,
      outcome,
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    if (error instanceof ArtifactRegistryError) throw error;
    throw new ArtifactRegistryError("invalid_outcome", "node outcome request is invalid", {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function requiredOutcomeString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new DomainError("invalid_value", `${key} is invalid`);
  return value;
}

function snapshotRecordedOutcome(input: unknown): RecordedNodeOutcome {
  if (!isRecord(input)) {
    throw new ArtifactRegistryError("invalid_outcome", "node outcome is missing its kind");
  }
  const { kind } = input;
  if (typeof kind !== "string") {
    throw new ArtifactRegistryError("invalid_outcome", "node outcome is missing its kind");
  }
  const keys = Object.keys(input).sort();
  if (kind === "artifact") {
    if (keys.join(",") !== "artifactId,kind") {
      throw new ArtifactRegistryError(
        "invalid_outcome",
        "artifact outcome must contain exactly one record",
      );
    }
    return Object.freeze({
      kind: "artifact",
      artifactId: artifactId(requiredOutcomeString(input, "artifactId")),
    });
  }
  if (kind === "no_change") {
    if (keys.join(",") !== "evidenceId,explanation,kind,revision") {
      throw new ArtifactRegistryError(
        "invalid_outcome",
        "no-change outcome must contain exactly one record",
      );
    }
    return Object.freeze({
      kind: "no_change",
      revision: gitSha(requiredOutcomeString(input, "revision")),
      evidenceId: evidenceId(requiredOutcomeString(input, "evidenceId")),
      explanation: nonEmptyText(
        requiredOutcomeString(input, "explanation"),
        "no-change explanation",
      ),
    });
  }
  if (kind === "commit") {
    if (keys.join(",") !== "evidenceId,kind,revision") {
      throw new ArtifactRegistryError(
        "invalid_outcome",
        "commit outcome must contain exactly one record",
      );
    }
    return Object.freeze({
      kind: "commit",
      revision: gitSha(requiredOutcomeString(input, "revision")),
      evidenceId: evidenceId(requiredOutcomeString(input, "evidenceId")),
    });
  }
  throw new ArtifactRegistryError("invalid_outcome", "node outcome kind is invalid");
}

function commandRequest(
  id: CommandId,
  actorSessionIdValue: ActorSessionId,
  nodeId: TaskNodeId,
  expectedVersion: number,
  typeName: string,
  bytes: Uint8Array,
): {
  readonly id: CommandId;
  readonly actorSessionId: ActorSessionId;
  readonly aggregateKind: "node";
  readonly aggregateId: TaskNodeId;
  readonly expectedVersion: number;
  readonly command: Readonly<{
    readonly typeName: NonEmptyText;
    readonly bytes: Uint8Array;
  }>;
} {
  return {
    id,
    actorSessionId: actorSessionIdValue,
    aggregateKind: "node" as const,
    aggregateId: nodeId,
    expectedVersion,
    command: { typeName: nonEmptyText(typeName, "command type name"), bytes },
  } as const;
}

function applyCreate(
  transaction: SqliteCommandTransaction,
  request: CreateArtifactRequest,
  trustedHostId: HostId,
): EncodedEffect {
  const node = readNodeMutation(transaction, request.nodeId, trustedHostId);
  assertActiveNode(node, request.at, "artifact creation");
  if (node.outputKind !== "artifact") {
    throw new ArtifactRegistryError(
      "invalid_outcome",
      "implementation nodes cannot create artifacts",
    );
  }
  if (
    node.outputArtifactId !== request.artifactId ||
    node.outputArtifactType !== request.artifactType
  ) {
    throw new ArtifactRegistryError(
      "invalid_outcome",
      "artifact metadata does not match the node contract",
    );
  }
  assertAttemptOwnership(transaction, request.attemptId, node, trustedHostId);
  const existingArtifact = transaction.get("SELECT id FROM artifacts WHERE id = ?", [
    request.artifactId,
  ]);
  if (existingArtifact !== undefined) {
    throw new ArtifactRegistryError("identity_conflict", "artifact ID is already registered");
  }
  const blobRow = transaction.get(
    `SELECT digest, size_bytes, media_type, relative_path, retention_kind,
            created_at_ms, verified_at_ms
       FROM content_blobs WHERE digest = ?`,
    [request.blob.digest],
  );
  if (blobRow === undefined) {
    if (!request.blob.created) {
      throw new ArtifactRegistryError(
        "corrupt",
        "blob receipt claims an existing blob that is missing",
      );
    }
    transaction.run(
      `INSERT INTO content_blobs (
         digest, size_bytes, media_type, relative_path, retention_kind,
         created_at_ms, verified_at_ms
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [
        request.blob.digest,
        request.blob.sizeBytes,
        request.mediaType,
        request.blob.relativePath,
        request.blob.verifiedAt,
        request.blob.verifiedAt,
      ],
    );
  } else {
    assertBlobExact(blobRow, request.blob, request.mediaType);
    const verified = transaction.run(
      `UPDATE content_blobs SET verified_at_ms = ? WHERE digest = ?`,
      [request.blob.verifiedAt, request.blob.digest],
    );
    if (changes(verified.changes) !== 1n) {
      throw new ArtifactRegistryError("corrupt", "existing blob verification was not refreshed");
    }
  }
  transaction.run(
    `INSERT INTO artifacts (
       id, node_id, attempt_id, tree_id, repository_id, host_id,
       content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.artifactId,
      request.nodeId,
      request.attemptId ?? null,
      node.treeId,
      node.repositoryId,
      trustedHostId,
      request.blob.digest,
      request.artifactType,
      request.evidenceId,
      request.retention,
      request.at,
    ],
  );
  const update = transaction.run(
    `UPDATE nodes
        SET version = version + 1, updated_at_ms = ?
      WHERE id = ? AND state_kind = 'active'`,
    [request.at, request.nodeId],
  );
  if (changes(update.changes) !== 1n) {
    throw new ArtifactRegistryError("corrupt", "active node version did not advance exactly once");
  }
  const row = transaction.get(`${artifactQuery()} WHERE a.id = ?`, [request.artifactId]);
  if (row === undefined) throw new ArtifactRegistryError("corrupt", "created artifact is missing");
  const artifact = artifactFromRow(transaction, row, trustedHostId);
  const updatedNode = readNodeMutation(transaction, request.nodeId, trustedHostId);
  return effectForArtifact(transaction, artifact, updatedNode);
}

function applyOutcome(
  transaction: SqliteCommandTransaction,
  request: RecordNodeOutcomeRequest,
  trustedHostId: HostId,
): EncodedEffect {
  const node = readNodeMutation(transaction, request.nodeId, trustedHostId);
  assertActiveNode(node, request.at, "node outcome");
  if (node.outcomeKind !== undefined) {
    throw new ArtifactRegistryError("identity_conflict", "node already has an outcome");
  }
  const artifact = assertOutcomeContract(transaction, node, request.outcome, trustedHostId);
  if (request.outcome.kind === "no_change") {
    assertInheritedRevision(transaction, node, request.outcome.revision, trustedHostId);
  }
  const outcomeRecord = outcomeRecordValues(request.outcome, artifact);
  const insert = transaction.run(
    `INSERT INTO node_outcome_records (
       node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      request.nodeId,
      outcomeRecord.kind,
      outcomeRecord.artifactId ?? null,
      outcomeRecord.revision ?? null,
      outcomeRecord.kind === "artifact" ? null : (outcomeRecord.evidenceId ?? null),
      outcomeRecord.explanation ?? null,
      request.at,
    ],
  );
  if (changes(insert.changes) !== 1n) {
    throw new ArtifactRegistryError("corrupt", "node outcome record was not inserted exactly once");
  }
  const update = transaction.run(
    `UPDATE nodes
        SET state_kind = 'succeeded', outcome_kind = ?, outcome_artifact_id = ?,
            outcome_content_hash = ?, outcome_artifact_type = ?, outcome_commit = ?,
            outcome_evidence_id = ?, outcome_explanation = ?, version = version + 1,
            updated_at_ms = ?
      WHERE id = ? AND state_kind = 'active' AND outcome_kind IS NULL`,
    [
      outcomeRecord.kind,
      outcomeRecord.artifactId ?? null,
      outcomeRecord.contentHash ?? null,
      outcomeRecord.artifactType ?? null,
      outcomeRecord.kind === "commit" ? (outcomeRecord.revision ?? null) : null,
      outcomeRecord.evidenceId ?? null,
      outcomeRecord.explanation ?? null,
      request.at,
      request.nodeId,
    ],
  );
  if (changes(update.changes) !== 1n) {
    throw new ArtifactRegistryError("corrupt", "node outcome state did not advance exactly once");
  }
  const readyChildren = projectReadyChildren(transaction, node, request.at, trustedHostId);
  const persisted = readNormalizedOutcome(transaction, request.nodeId);
  if (persisted === undefined)
    throw new ArtifactRegistryError("corrupt", "node outcome disappeared");
  const updatedNode = readNodeMutation(transaction, request.nodeId, trustedHostId);
  return effectForOutcome(transaction, persisted, updatedNode, readyChildren);
}

function assertOutcomeContract(
  transaction: SqliteCommandTransaction,
  node: NodeMutationRecord,
  outcome: RecordedNodeOutcome,
  trustedHostId: HostId,
): ArtifactRecord | undefined {
  if (outcome.kind === "artifact") {
    if (
      node.outputKind !== "artifact" ||
      node.outputArtifactId !== outcome.artifactId ||
      node.outputArtifactType === undefined
    ) {
      throw new ArtifactRegistryError(
        "invalid_outcome",
        "artifact outcome does not match the node contract",
      );
    }
    const artifactRow = transaction.get(`${artifactQuery()} WHERE a.id = ?`, [outcome.artifactId]);
    if (artifactRow === undefined) {
      throw new ArtifactRegistryError(
        "invalid_outcome",
        "artifact outcome references an unknown artifact",
      );
    }
    const artifact = artifactFromRow(transaction, artifactRow, trustedHostId);
    if (
      artifact.nodeId !== node.id ||
      artifact.hostId !== trustedHostId ||
      artifact.id !== outcome.artifactId ||
      artifact.artifactType !== node.outputArtifactType
    ) {
      throw new ArtifactRegistryError(
        "invalid_outcome",
        "artifact outcome metadata is not owned by the node",
      );
    }
    return artifact;
  }
  if (node.outputKind !== "implementation") {
    throw new ArtifactRegistryError(
      "invalid_outcome",
      "implementation outcome requires an implementation node",
    );
  }
  return undefined;
}

function assertInheritedRevision(
  transaction: SqliteCommandTransaction,
  node: NodeMutationRecord,
  revision: GitSha,
  trustedHostId: HostId,
): void {
  const visited = new Set<string>();
  let cursor: NodeMutationRecord = node;
  while (cursor.parentNodeId !== undefined) {
    if (visited.has(cursor.id)) {
      throw new ArtifactRegistryError("corrupt", "node ancestry contains a cycle");
    }
    visited.add(cursor.id);
    const parent = readNodeMutation(transaction, cursor.parentNodeId, trustedHostId);
    if (
      parent.treeId !== node.treeId ||
      parent.repositoryId !== node.repositoryId ||
      parent.hostId !== node.hostId
    ) {
      throw new ArtifactRegistryError("corrupt", "node ancestry ownership is corrupt");
    }
    if (parent.id === node.rootNodeId && parent.stateKind === "planned") {
      if (revision !== node.treeBaseCommit) {
        throw new ArtifactRegistryError(
          "invalid_outcome",
          "no-change revision differs from the tree base commit",
        );
      }
      return;
    }
    if (parent.stateKind !== "succeeded" || parent.outcomeKind === undefined) {
      throw new ArtifactRegistryError(
        "invalid_outcome",
        "no-change revision has no completed parent chain",
      );
    }
    const normalized = readNormalizedOutcome(transaction, parent.id);
    if (normalized?.outcome.kind !== parent.outcomeKind) {
      throw new ArtifactRegistryError(
        "corrupt",
        "completed parent has no unique normalized outcome",
      );
    }
    if (parent.outcomeKind === "commit" || parent.outcomeKind === "no_change") {
      const normalizedRevision =
        normalized.outcome.kind === "commit" || normalized.outcome.kind === "no_change"
          ? normalized.outcome.revision
          : undefined;
      const parentRevision =
        parent.outcomeKind === "commit" ? parent.outcomeCommit : normalizedRevision;
      if (
        parentRevision === undefined ||
        normalizedRevision === undefined ||
        (parent.outcomeKind === "commit" && parent.outcomeCommit !== normalizedRevision)
      ) {
        throw new ArtifactRegistryError("corrupt", "parent revision is not normalized");
      }
      if (parentRevision !== revision) {
        throw new ArtifactRegistryError(
          "invalid_outcome",
          "no-change revision differs from its parent revision",
        );
      }
      return;
    }
    cursor = parent;
  }
  if (cursor.treeBaseCommit !== revision) {
    throw new ArtifactRegistryError(
      "invalid_outcome",
      "no-change revision differs from the tree base commit",
    );
  }
}

function assertActiveNode(node: NodeMutationRecord, at: Timestamp, operation: string): void {
  if (node.stateKind !== "active") {
    throw new ArtifactRegistryError("invalid_outcome", `${operation} requires an active node`);
  }
  if (node.treeArchived || node.repositoryArchived || node.planRevisionState !== "approved") {
    throw new ArtifactRegistryError(
      "invalid_outcome",
      `${operation} requires an active approved plan`,
    );
  }
  if (node.activePlanRevisionId !== node.planRevisionId) {
    throw new ArtifactRegistryError(
      "invalid_outcome",
      `${operation} targets an inactive plan revision`,
    );
  }
  if (at < node.updatedAt) {
    throw new ArtifactRegistryError(
      "invalid_input",
      `${operation} timestamp predates the node update`,
    );
  }
}

function assertAttemptOwnership(
  transaction: SqliteCommandTransaction,
  requestedAttemptId: AttemptId | undefined,
  node: NodeMutationRecord,
  trustedHostId: HostId,
): void {
  if (requestedAttemptId === undefined) return;
  const row = transaction.get(
    `SELECT id, node_id, tree_id, repository_id, host_id, plan_revision_id, state_kind
       FROM attempts WHERE id = ?`,
    [requestedAttemptId],
  );
  if (row === undefined) {
    throw new ArtifactRegistryError("identity_conflict", "artifact attempt does not exist");
  }
  if (
    requiredString(row, "node_id") !== node.id ||
    requiredString(row, "tree_id") !== node.treeId ||
    requiredString(row, "repository_id") !== node.repositoryId ||
    requiredString(row, "host_id") !== trustedHostId ||
    requiredString(row, "plan_revision_id") !== node.planRevisionId ||
    requiredString(row, "state_kind") !== "active"
  ) {
    throw new ArtifactRegistryError(
      "identity_conflict",
      "artifact attempt is not owned by the node",
    );
  }
}

function assertBlobExact(row: SqliteRow, blob: StoredBlob, mediaType: NonEmptyText): void {
  const digest = contentHash(requiredString(row, "digest"));
  const size = safeBigint(row["size_bytes"], "blob size_bytes");
  const storedMediaType = nonEmptyText(requiredString(row, "media_type"), "blob media type");
  const relativePath = nonEmptyText(requiredString(row, "relative_path"), "blob relative_path");
  const retention = requiredString(row, "retention_kind");
  const verifiedAt = safeTimestamp(row["verified_at_ms"], "blob verified_at_ms");
  const createdAt = safeTimestamp(row["created_at_ms"], "blob created_at_ms");
  if (
    digest !== blob.digest ||
    size !== blob.sizeBytes ||
    storedMediaType !== mediaType ||
    relativePath !== blob.relativePath ||
    relativePath !== blobPath(digest) ||
    retention !== "active" ||
    blob.verifiedAt < createdAt ||
    verifiedAt < createdAt
  ) {
    throw new ArtifactRegistryError(
      "identity_conflict",
      "existing blob metadata differs from the receipt",
    );
  }
}

function projectReadyChildren(
  transaction: SqliteCommandTransaction,
  parent: NodeMutationRecord,
  at: Timestamp,
  trustedHostId: HostId,
): readonly NodeMutationRecord[] {
  const candidates = transaction.all(
    `SELECT child.id
       FROM nodes AS child
       JOIN nodes AS parent ON parent.id = child.parent_node_id
       JOIN trees AS tree ON tree.id = child.tree_id
       JOIN repositories AS repository ON repository.id = child.repository_id
       JOIN plan_revisions AS revision
         ON revision.tree_id = tree.id
        AND revision.id = tree.active_plan_revision_id
       JOIN node_outcome_records AS outcome ON outcome.node_id = parent.id
      WHERE child.state_kind = 'planned'
        AND child.parent_node_id = ?
        AND parent.tree_id = child.tree_id
        AND parent.state_kind = 'succeeded'
        AND outcome.outcome_kind IN ('artifact', 'no_change', 'commit')
        AND child.plan_revision_id = tree.active_plan_revision_id
        AND tree.archived_at_ms IS NULL
        AND repository.archived_at_ms IS NULL
        AND revision.state_kind = 'approved'
        AND parent.blocker_kind IS NULL
        AND child.blocker_kind IS NULL
      ORDER BY child.created_at_ms, child.id`,
    [parent.id],
  );
  const children: NodeMutationRecord[] = [];
  for (const candidate of candidates) {
    const childId = taskNodeId(requiredString(candidate, "id"));
    const update = transaction.run(
      `UPDATE nodes
          SET state_kind = 'ready', version = version + 1, updated_at_ms = ?
        WHERE id = ? AND state_kind = 'planned'`,
      [at, childId],
    );
    if (changes(update.changes) !== 1n) {
      throw new ArtifactRegistryError("corrupt", "planned child did not become ready exactly once");
    }
    children.push(readNodeMutation(transaction, childId, trustedHostId));
  }
  return Object.freeze(children);
}

function effectForArtifact(
  transaction: SqliteCommandTransaction,
  artifact: ArtifactRecord,
  node: NodeMutationRecord,
): EncodedEffect {
  const artifactMessage = artifactToMessage(artifact);
  const changes = [
    create(ProjectionChangeSchema, {
      change: { case: "artifactUpserted", value: artifactMessage },
    }),
    create(ProjectionChangeSchema, {
      change: { case: "nodeUpserted", value: nodeSummaryMessage(transaction, node) },
    }),
  ];
  const event = create(ProjectionChangeSchema, {
    change: { case: "batch", value: create(ProjectionBatchSchema, { changes }) },
  });
  const result = create(CreateArtifactResponseSchema, { artifact: artifactMessage });
  return Object.freeze({
    event: Object.freeze({
      typeName: nonEmptyText(ProjectionChangeSchema.typeName, "event type name"),
      bytes: toBinary(ProjectionChangeSchema, event),
    }),
    result: Object.freeze({
      typeName: nonEmptyText(CreateArtifactResponseSchema.typeName, "result type name"),
      bytes: toBinary(CreateArtifactResponseSchema, result),
    }),
    externalOperations: [],
  });
}

function effectForOutcome(
  transaction: SqliteCommandTransaction,
  record: NodeOutcomeRecord,
  node: NodeMutationRecord,
  readyChildren: readonly NodeMutationRecord[],
): EncodedEffect {
  const outcomeMessage = outcomeToMessage(record.outcome);
  const nodeOutcome = create(NodeOutcomeSchema, {
    nodeId: record.nodeId,
    outcome: outcomeMessage,
    createdAt: timestampMessage(record.createdAt),
  });
  const changes = [
    create(ProjectionChangeSchema, {
      change: { case: "nodeOutcomeUpserted", value: nodeOutcome },
    }),
    create(ProjectionChangeSchema, {
      change: { case: "nodeUpserted", value: nodeSummaryMessage(transaction, node) },
    }),
    ...readyChildren.map((child) =>
      create(ProjectionChangeSchema, {
        change: { case: "nodeUpserted", value: nodeSummaryMessage(transaction, child) },
      }),
    ),
  ];
  const event = create(ProjectionChangeSchema, {
    change: { case: "batch", value: create(ProjectionBatchSchema, { changes }) },
  });
  const result = create(RecordNodeOutcomeResponseSchema, { outcome: nodeOutcome });
  return Object.freeze({
    event: Object.freeze({
      typeName: nonEmptyText(ProjectionChangeSchema.typeName, "event type name"),
      bytes: toBinary(ProjectionChangeSchema, event),
    }),
    result: Object.freeze({
      typeName: nonEmptyText(RecordNodeOutcomeResponseSchema.typeName, "result type name"),
      bytes: toBinary(RecordNodeOutcomeResponseSchema, result),
    }),
    externalOperations: [],
  });
}

function nodeSummaryMessage(transaction: SqliteCommandTransaction, node: NodeMutationRecord) {
  return create(NodeSummarySchema, {
    id: node.id,
    treeId: node.treeId,
    ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
    ordinal: BigInt(siblingOrdinal(transaction, node)),
    objective: node.objective,
    state: nodeStateFromKind(node.stateKind),
    version: BigInt(node.version),
  });
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
  throw new ArtifactRegistryError("corrupt", "node state is invalid");
}

function siblingOrdinal(transaction: SqliteCommandTransaction, node: NodeMutationRecord): number {
  const row = transaction.get(
    `SELECT count(*) AS ordinal
       FROM nodes AS sibling
      WHERE sibling.tree_id = ? AND (
        (sibling.parent_node_id IS NULL AND ? IS NULL)
        OR sibling.parent_node_id = ?
      )
        AND (
          sibling.created_at_ms < ?
          OR (sibling.created_at_ms = ? AND sibling.id < ?)
        )`,
    [
      node.treeId,
      node.parentNodeId ?? null,
      node.parentNodeId ?? null,
      node.createdAt,
      node.createdAt,
      node.id,
    ],
  );
  if (row === undefined)
    throw new ArtifactRegistryError("corrupt", "node sibling ordinal is missing");
  return safeInteger(row["ordinal"], "node sibling ordinal");
}

function artifactQuery(): string {
  return `SELECT a.id, a.node_id, a.attempt_id, a.tree_id, a.repository_id, a.host_id,
                 a.content_digest, a.artifact_type, a.evidence_id, a.retention_kind,
                 a.created_at_ms, c.size_bytes, c.media_type, c.relative_path,
                 c.verified_at_ms, c.digest AS blob_digest,
                 n.host_id AS node_host_id, n.tree_id AS node_tree_id,
                 n.repository_id AS node_repository_id
            FROM artifacts AS a
            JOIN content_blobs AS c ON c.digest = a.content_digest
            JOIN nodes AS n ON n.id = a.node_id`;
}

function artifactFromRow(
  reader: SqliteReader,
  row: SqliteRow,
  trustedHostId: HostId,
): ArtifactRecord {
  const id = artifactId(requiredString(row, "id"));
  const nodeId = taskNodeId(requiredString(row, "node_id"));
  const treeId = taskTreeId(requiredString(row, "tree_id"));
  const repository = repositoryId(requiredString(row, "repository_id"));
  const host = hostId(requiredString(row, "host_id"));
  const nodeHost = hostId(requiredString(row, "node_host_id"));
  const nodeTree = taskTreeId(requiredString(row, "node_tree_id"));
  const nodeRepository = repositoryId(requiredString(row, "node_repository_id"));
  if (
    host !== trustedHostId ||
    nodeHost !== host ||
    nodeTree !== treeId ||
    nodeRepository !== repository
  ) {
    throw new ArtifactRegistryError("identity_conflict", "artifact ownership is not local");
  }
  const attemptValue = nullableString(row["attempt_id"], "attempt_id");
  const attempt = attemptValue === undefined ? undefined : attemptId(attemptValue);
  if (attempt !== undefined) {
    const attemptRow = reader.get(
      `SELECT node_id, tree_id, repository_id, host_id FROM attempts WHERE id = ?`,
      [attempt],
    );
    if (
      attemptRow === undefined ||
      requiredString(attemptRow, "node_id") !== nodeId ||
      requiredString(attemptRow, "tree_id") !== treeId ||
      requiredString(attemptRow, "repository_id") !== repository ||
      requiredString(attemptRow, "host_id") !== host
    ) {
      throw new ArtifactRegistryError("corrupt", "artifact attempt ownership is corrupt");
    }
  }
  const digest = contentHash(requiredString(row, "content_digest"));
  const blobDigest = contentHash(requiredString(row, "blob_digest"));
  const sizeBytes = safeBigint(row["size_bytes"], "artifact size_bytes");
  const mediaType = nonEmptyText(requiredString(row, "media_type"), "artifact media type");
  const artifactType = nonEmptyText(requiredString(row, "artifact_type"), "artifact type");
  const evidence = evidenceId(requiredString(row, "evidence_id"));
  const retention = retentionFromValue(requiredString(row, "retention_kind"));
  const createdAt = safeTimestamp(row["created_at_ms"], "artifact created_at_ms");
  const verifiedAt = safeTimestamp(row["verified_at_ms"], "artifact verified_at_ms");
  const relativePath = nonEmptyText(requiredString(row, "relative_path"), "artifact relative_path");
  if (digest !== blobDigest || relativePath !== blobPath(digest) || sizeBytes < 0n) {
    throw new ArtifactRegistryError("corrupt", "artifact blob metadata is corrupt");
  }
  return Object.freeze({
    id,
    nodeId,
    attemptId: attempt,
    treeId,
    repositoryId: repository,
    hostId: host,
    contentDigest: digest,
    sizeBytes,
    mediaType,
    artifactType,
    evidenceId: evidence,
    retention,
    createdAt,
    verifiedAt,
  });
}

function expectedBlobFromRow(row: SqliteRow): ExpectedBlob {
  const digest = contentHash(requiredString(row, "digest"));
  const sizeBytes = safeBigint(row["size_bytes"], "blob size_bytes");
  const relativePath = nonEmptyText(requiredString(row, "relative_path"), "blob relative_path");
  if (relativePath !== blobPath(digest) || sizeBytes < 0n) {
    throw new ArtifactRegistryError("corrupt", "content blob metadata is corrupt");
  }
  return Object.freeze({ digest, sizeBytes, relativePath });
}

function readNodeMutation(
  reader: SqliteReader,
  nodeId: TaskNodeId,
  trustedHostId: HostId,
): NodeMutationRecord {
  const row = reader.get(
    `SELECT n.id, n.tree_id, n.repository_id, n.host_id, n.parent_node_id,
            n.plan_revision_id, n.mode, n.objective, n.output_kind,
            n.output_artifact_id, n.output_artifact_type, n.state_kind,
            n.outcome_kind, n.outcome_artifact_id, n.outcome_content_hash,
            n.outcome_artifact_type, n.outcome_commit, n.outcome_evidence_id,
            n.outcome_explanation, n.version, n.created_at_ms, n.updated_at_ms,
            t.base_commit, t.root_node_id, t.active_plan_revision_id, t.archived_at_ms AS tree_archived,
            r.archived_at_ms AS repository_archived, p.state_kind AS plan_revision_state
       FROM nodes AS n
       JOIN trees AS t ON t.id = n.tree_id
       JOIN repositories AS r ON r.id = n.repository_id
       JOIN plan_revisions AS p ON p.id = n.plan_revision_id AND p.tree_id = n.tree_id
      WHERE n.id = ?`,
    [nodeId],
  );
  if (row === undefined) throw new ArtifactRegistryError("not_found", "node does not exist");
  const id = taskNodeId(requiredString(row, "id"));
  const treeId = taskTreeId(requiredString(row, "tree_id"));
  const repository = repositoryId(requiredString(row, "repository_id"));
  const host = hostId(requiredString(row, "host_id"));
  if (id !== nodeId || host !== trustedHostId) {
    throw new ArtifactRegistryError("identity_conflict", "node belongs to another host");
  }
  const parent = nullableString(row["parent_node_id"], "parent_node_id");
  const outputKind = requiredString(row, "output_kind");
  if (outputKind !== "artifact" && outputKind !== "implementation") {
    throw new ArtifactRegistryError("corrupt", "node output contract is corrupt");
  }
  const outputArtifactIdValue = nullableString(row["output_artifact_id"], "output_artifact_id");
  const outputArtifactTypeValue = nullableString(
    row["output_artifact_type"],
    "output_artifact_type",
  );
  if (
    (outputKind === "artifact" &&
      (outputArtifactIdValue === undefined || outputArtifactTypeValue === undefined)) ||
    (outputKind === "implementation" &&
      (outputArtifactIdValue !== undefined || outputArtifactTypeValue !== undefined))
  ) {
    throw new ArtifactRegistryError("corrupt", "node output contract is inconsistent");
  }
  const outcomeKindValue = nullableString(row["outcome_kind"], "outcome_kind");
  if (
    outcomeKindValue !== undefined &&
    outcomeKindValue !== "artifact" &&
    outcomeKindValue !== "commit" &&
    outcomeKindValue !== "no_change"
  ) {
    throw new ArtifactRegistryError("corrupt", "node outcome kind is corrupt");
  }
  const outcomeArtifactIdValue = nullableString(row["outcome_artifact_id"], "outcome_artifact_id");
  const outcomeContentHashValue = nullableString(
    row["outcome_content_hash"],
    "outcome_content_hash",
  );
  const outcomeArtifactTypeValue = nullableString(
    row["outcome_artifact_type"],
    "outcome_artifact_type",
  );
  const outcomeCommitValue = nullableString(row["outcome_commit"], "outcome_commit");
  const outcomeEvidenceIdValue = nullableString(row["outcome_evidence_id"], "outcome_evidence_id");
  const outcomeExplanationValue = nullableString(row["outcome_explanation"], "outcome_explanation");
  if (outcomeKindValue === undefined) {
    if (
      outcomeArtifactIdValue !== undefined ||
      outcomeContentHashValue !== undefined ||
      outcomeArtifactTypeValue !== undefined ||
      outcomeCommitValue !== undefined ||
      outcomeEvidenceIdValue !== undefined ||
      outcomeExplanationValue !== undefined
    ) {
      throw new ArtifactRegistryError("corrupt", "node outcome columns are not empty");
    }
  }
  const stateKind = requiredString(row, "state_kind");
  if ((stateKind === "succeeded") !== (outcomeKindValue !== undefined)) {
    throw new ArtifactRegistryError("corrupt", "node state and outcome columns disagree");
  }
  return Object.freeze({
    id,
    treeId,
    rootNodeId: taskNodeId(requiredString(row, "root_node_id")),
    repositoryId: repository,
    hostId: host,
    parentNodeId: parent === undefined ? undefined : taskNodeId(parent),
    planRevisionId: requiredString(row, "plan_revision_id"),
    mode: requiredString(row, "mode"),
    objective: nonEmptyText(requiredString(row, "objective"), "node objective"),
    outputKind,
    outputArtifactId:
      outputArtifactIdValue === undefined ? undefined : artifactId(outputArtifactIdValue),
    outputArtifactType:
      outputArtifactTypeValue === undefined
        ? undefined
        : nonEmptyText(outputArtifactTypeValue, "node artifact type"),
    stateKind,
    version: safeInteger(row["version"], "node version"),
    createdAt: safeTimestamp(row["created_at_ms"], "node created_at_ms"),
    updatedAt: safeTimestamp(row["updated_at_ms"], "node updated_at_ms"),
    outcomeKind: outcomeKindValue,
    outcomeArtifactId:
      outcomeArtifactIdValue === undefined ? undefined : artifactId(outcomeArtifactIdValue),
    outcomeContentHash:
      outcomeContentHashValue === undefined ? undefined : contentHash(outcomeContentHashValue),
    outcomeArtifactType:
      outcomeArtifactTypeValue === undefined
        ? undefined
        : nonEmptyText(outcomeArtifactTypeValue, "outcome artifact type"),
    outcomeCommit: outcomeCommitValue === undefined ? undefined : gitSha(outcomeCommitValue),
    outcomeEvidenceId:
      outcomeEvidenceIdValue === undefined ? undefined : evidenceId(outcomeEvidenceIdValue),
    outcomeExplanation:
      outcomeExplanationValue === undefined
        ? undefined
        : nonEmptyText(outcomeExplanationValue, "outcome explanation"),
    treeBaseCommit: gitSha(requiredString(row, "base_commit")),
    treeArchived: row["tree_archived"] !== null,
    repositoryArchived: row["repository_archived"] !== null,
    activePlanRevisionId: requiredString(row, "active_plan_revision_id"),
    planRevisionState: requiredString(row, "plan_revision_state"),
  });
}

function readNormalizedOutcome(
  reader: SqliteReader,
  nodeId: TaskNodeId,
): NodeOutcomeRecord | undefined {
  const node = reader.get(
    `SELECT state_kind, outcome_kind, outcome_artifact_id, outcome_content_hash,
            outcome_artifact_type, outcome_commit, outcome_evidence_id, outcome_explanation
       FROM nodes WHERE id = ?`,
    [nodeId],
  );
  if (node === undefined) throw new ArtifactRegistryError("not_found", "node does not exist");
  const row = reader.get(
    `SELECT node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
       FROM node_outcome_records WHERE node_id = ?`,
    [nodeId],
  );
  const stateKind = requiredString(node, "state_kind");
  if (row === undefined) {
    if (stateKind === "succeeded" || requiredNullable(node, "outcome_kind") !== undefined) {
      throw new ArtifactRegistryError("corrupt", "succeeded node has no normalized outcome");
    }
    return undefined;
  }
  if (stateKind !== "succeeded") {
    throw new ArtifactRegistryError("corrupt", "non-succeeded node has a normalized outcome");
  }
  const outcome = outcomeFromRow(row);
  if (outcome.nodeId !== nodeId || outcome.outcome.kind !== requiredString(node, "outcome_kind")) {
    throw new ArtifactRegistryError(
      "corrupt",
      "node outcome normalization disagrees with node columns",
    );
  }
  const artifactIdColumn = requiredNullable(node, "outcome_artifact_id");
  const contentHashColumn = requiredNullable(node, "outcome_content_hash");
  const artifactTypeColumn = requiredNullable(node, "outcome_artifact_type");
  const revisionColumn = requiredNullable(node, "outcome_commit");
  const evidenceColumn = requiredNullable(node, "outcome_evidence_id");
  const explanationColumn = requiredNullable(node, "outcome_explanation");
  if (outcome.outcome.kind === "artifact") {
    if (
      artifactIdColumn !== outcome.outcome.artifactId ||
      contentHashColumn === undefined ||
      artifactTypeColumn === undefined ||
      revisionColumn !== undefined ||
      explanationColumn !== undefined
    ) {
      throw new ArtifactRegistryError("corrupt", "artifact outcome columns are not normalized");
    }
    const artifact = reader.get(
      `SELECT node_id, artifact_type, content_digest, evidence_id
         FROM artifacts WHERE id = ?`,
      [outcome.outcome.artifactId],
    );
    if (
      artifact === undefined ||
      requiredString(artifact, "node_id") !== nodeId ||
      contentHashColumn !== contentHash(requiredString(artifact, "content_digest")) ||
      artifactTypeColumn !==
        nonEmptyText(requiredString(artifact, "artifact_type"), "artifact type") ||
      evidenceColumn !== evidenceId(requiredString(artifact, "evidence_id"))
    ) {
      throw new ArtifactRegistryError("corrupt", "artifact outcome metadata is not normalized");
    }
  } else if (
    artifactIdColumn !== undefined ||
    contentHashColumn !== undefined ||
    artifactTypeColumn !== undefined ||
    (outcome.outcome.kind === "commit"
      ? revisionColumn !== outcome.outcome.revision
      : revisionColumn !== undefined) ||
    evidenceColumn !== outcome.outcome.evidenceId ||
    (outcome.outcome.kind === "no_change"
      ? explanationColumn !== outcome.outcome.explanation
      : explanationColumn !== undefined)
  ) {
    throw new ArtifactRegistryError("corrupt", "revision outcome columns are not normalized");
  }
  return outcome;
}

function outcomeFromRow(row: SqliteRow): NodeOutcomeRecord {
  const nodeId = taskNodeId(requiredString(row, "node_id"));
  const kind = requiredString(row, "outcome_kind");
  const artifactValue = nullableString(row["artifact_id"], "artifact_id");
  const revisionValue = nullableString(row["revision"], "revision");
  const evidenceValue = nullableString(row["evidence_id"], "evidence_id");
  const explanationValue = nullableString(row["explanation"], "explanation");
  let outcome: RecordedNodeOutcome;
  if (kind === "artifact") {
    if (
      artifactValue === undefined ||
      revisionValue !== undefined ||
      evidenceValue !== undefined ||
      explanationValue !== undefined
    ) {
      throw new ArtifactRegistryError("corrupt", "artifact outcome record is malformed");
    }
    outcome = Object.freeze({ kind: "artifact", artifactId: artifactId(artifactValue) });
  } else if (kind === "no_change") {
    if (
      artifactValue !== undefined ||
      revisionValue === undefined ||
      evidenceValue === undefined ||
      explanationValue === undefined
    ) {
      throw new ArtifactRegistryError("corrupt", "no-change outcome record is malformed");
    }
    outcome = Object.freeze({
      kind: "no_change",
      revision: gitSha(revisionValue),
      evidenceId: evidenceId(evidenceValue),
      explanation: nonEmptyText(explanationValue, "no-change explanation"),
    });
  } else if (kind === "commit") {
    if (
      artifactValue !== undefined ||
      revisionValue === undefined ||
      evidenceValue === undefined ||
      explanationValue !== undefined
    ) {
      throw new ArtifactRegistryError("corrupt", "commit outcome record is malformed");
    }
    outcome = Object.freeze({
      kind: "commit",
      revision: gitSha(revisionValue),
      evidenceId: evidenceId(evidenceValue),
    });
  } else {
    throw new ArtifactRegistryError("corrupt", "node outcome record kind is invalid");
  }
  return Object.freeze({
    nodeId,
    outcome,
    createdAt: safeTimestamp(row["created_at_ms"], "node outcome created_at_ms"),
  });
}

function outcomeRecordValues(
  outcome: RecordedNodeOutcome,
  artifact: ArtifactRecord | undefined,
): Readonly<{
  kind: "artifact" | "commit" | "no_change";
  artifactId?: ArtifactId;
  contentHash?: ContentHash;
  artifactType?: NonEmptyText;
  revision?: GitSha;
  evidenceId?: EvidenceId;
  explanation?: NonEmptyText;
}> {
  switch (outcome.kind) {
    case "artifact":
      if (artifact === undefined) {
        throw new ArtifactRegistryError("corrupt", "artifact outcome metadata is missing");
      }
      return Object.freeze({
        kind: "artifact",
        artifactId: outcome.artifactId,
        contentHash: artifact.contentDigest,
        artifactType: artifact.artifactType,
        evidenceId: artifact.evidenceId,
      });
    case "no_change":
      return Object.freeze({
        kind: "no_change",
        revision: outcome.revision,
        evidenceId: outcome.evidenceId,
        explanation: outcome.explanation,
      });
    case "commit":
      return Object.freeze({
        kind: "commit",
        revision: outcome.revision,
        evidenceId: outcome.evidenceId,
      });
  }
}
function artifactToMessage(artifact: ArtifactRecord) {
  return create(ArtifactSchema, {
    artifactId: artifact.id,
    nodeId: artifact.nodeId,
    ...(artifact.attemptId === undefined ? {} : { attemptId: artifact.attemptId }),
    treeId: artifact.treeId,
    repositoryId: artifact.repositoryId,
    hostId: artifact.hostId,
    contentDigest: artifact.contentDigest,
    sizeBytes: artifact.sizeBytes,
    mediaType: artifact.mediaType,
    artifactType: artifact.artifactType,
    evidenceId: artifact.evidenceId,
    retention: retentionToProto(artifact.retention),
    createdAt: timestampMessage(artifact.createdAt),
    verifiedAt: timestampMessage(artifact.verifiedAt),
  });
}

function artifactFromMessage(message: MessageShape<typeof ArtifactSchema>): ArtifactRecord {
  return Object.freeze({
    id: artifactId(message.artifactId),
    nodeId: taskNodeId(message.nodeId),
    attemptId: message.attemptId === undefined ? undefined : attemptId(message.attemptId),
    treeId: taskTreeId(message.treeId),
    repositoryId: repositoryId(message.repositoryId),
    hostId: hostId(message.hostId),
    contentDigest: contentHash(message.contentDigest),
    sizeBytes: message.sizeBytes,
    mediaType: nonEmptyText(message.mediaType, "artifact media type"),
    artifactType: nonEmptyText(message.artifactType, "artifact type"),
    evidenceId: evidenceId(message.evidenceId),
    retention: retentionFromProto(message.retention),
    createdAt: timestampFromMessage(message.createdAt),
    verifiedAt: timestampFromMessage(message.verifiedAt),
  });
}

function outcomeToMessage(outcome: RecordedNodeOutcome) {
  if (outcome.kind === "artifact") {
    return {
      case: "artifact" as const,
      value: create(ArtifactOutcomeSchema, { artifactId: outcome.artifactId }),
    };
  }
  if (outcome.kind === "no_change") {
    return {
      case: "noChange" as const,
      value: create(NoChangeOutcomeSchema, {
        revision: outcome.revision,
        evidenceId: outcome.evidenceId,
        explanation: outcome.explanation,
      }),
    };
  }
  return {
    case: "commit" as const,
    value: create(CommitOutcomeSchema, {
      revision: outcome.revision,
      evidenceId: outcome.evidenceId,
    }),
  };
}

function outcomeFromMessage(message: MessageShape<typeof NodeOutcomeSchema>): NodeOutcomeRecord {
  if (message.createdAt === undefined) throw new TypeError("node outcome timestamp is missing");
  if (message.outcome.case === "artifact") {
    return Object.freeze({
      nodeId: taskNodeId(message.nodeId),
      outcome: Object.freeze({
        kind: "artifact",
        artifactId: artifactId(message.outcome.value.artifactId),
      }),
      createdAt: timestampFromMessage(message.createdAt),
    });
  }
  if (message.outcome.case === "noChange") {
    return Object.freeze({
      nodeId: taskNodeId(message.nodeId),
      outcome: Object.freeze({
        kind: "no_change",
        revision: gitSha(message.outcome.value.revision),
        evidenceId: evidenceId(message.outcome.value.evidenceId),
        explanation: nonEmptyText(message.outcome.value.explanation, "no-change explanation"),
      }),
      createdAt: timestampFromMessage(message.createdAt),
    });
  }
  if (message.outcome.case === "commit") {
    return Object.freeze({
      nodeId: taskNodeId(message.nodeId),
      outcome: Object.freeze({
        kind: "commit",
        revision: gitSha(message.outcome.value.revision),
        evidenceId: evidenceId(message.outcome.value.evidenceId),
      }),
      createdAt: timestampFromMessage(message.createdAt),
    });
  }
  throw new TypeError("node outcome oneof is missing");
}

function assertArtifactMatchesRequest(
  artifact: ArtifactRecord,
  request: CreateArtifactRequest,
): void {
  if (
    artifact.id !== request.artifactId ||
    artifact.nodeId !== request.nodeId ||
    artifact.attemptId !== request.attemptId ||
    artifact.contentDigest !== request.blob.digest ||
    artifact.sizeBytes !== request.blob.sizeBytes ||
    artifact.mediaType !== request.mediaType ||
    artifact.artifactType !== request.artifactType ||
    artifact.evidenceId !== request.evidenceId ||
    artifact.retention !== request.retention ||
    artifact.createdAt !== request.at ||
    artifact.verifiedAt !== request.blob.verifiedAt
  ) {
    throw new ArtifactRegistryError(
      "facts_changed",
      "artifact result facts differ from the request",
    );
  }
}

function assertArtifactEquivalent(left: ArtifactRecord, right: ArtifactRecord): void {
  if (
    left.id !== right.id ||
    left.nodeId !== right.nodeId ||
    left.attemptId !== right.attemptId ||
    left.treeId !== right.treeId ||
    left.repositoryId !== right.repositoryId ||
    left.hostId !== right.hostId ||
    left.contentDigest !== right.contentDigest ||
    left.sizeBytes !== right.sizeBytes ||
    left.mediaType !== right.mediaType ||
    left.artifactType !== right.artifactType ||
    left.evidenceId !== right.evidenceId ||
    left.retention !== right.retention ||
    left.createdAt !== right.createdAt ||
    left.verifiedAt !== right.verifiedAt
  ) {
    throw new ArtifactRegistryError(
      "facts_changed",
      "persisted artifact facts differ from the result",
    );
  }
}

function assertRecordedOutcomeEqual(left: RecordedNodeOutcome, right: RecordedNodeOutcome): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new ArtifactRegistryError(
      "facts_changed",
      "node outcome result differs from the request",
    );
  }
}

function assertOutcomeRecordEquivalent(left: NodeOutcomeRecord, right: NodeOutcomeRecord): void {
  if (
    left.nodeId !== right.nodeId ||
    left.createdAt !== right.createdAt ||
    JSON.stringify(left.outcome) !== JSON.stringify(right.outcome)
  ) {
    throw new ArtifactRegistryError(
      "facts_changed",
      "persisted node outcome differs from the result",
    );
  }
}

function parseArtifactId(value: unknown, fieldName: string): ArtifactId {
  try {
    return artifactId(String(value));
  } catch (error) {
    throw new ArtifactRegistryError("invalid_input", `${fieldName} is invalid`, { cause: error });
  }
}

function parseNodeId(value: unknown, fieldName: string): TaskNodeId {
  try {
    return taskNodeId(String(value));
  } catch (error) {
    throw new ArtifactRegistryError("invalid_input", `${fieldName} is invalid`, { cause: error });
  }
}

function parseHostId(value: unknown, fieldName: string): HostId {
  try {
    return hostId(String(value));
  } catch (error) {
    throw new ArtifactRegistryError("invalid_input", `${fieldName} is invalid`, { cause: error });
  }
}

function artifactRetentionKind(value: unknown): ArtifactRetention {
  return retentionFromValue(value);
}

function retentionFromValue(value: unknown): ArtifactRetention {
  if (value === "active" || value === "archived" || value === "purge_pending") return value;
  throw new ArtifactRegistryError("invalid_input", "artifact retention is invalid");
}

function retentionToProto(value: ArtifactRetention): ProtoArtifactRetention {
  const kind = artifactRetentionKind(value);
  if (kind === "active") return ProtoArtifactRetention.ACTIVE;
  if (kind === "archived") return ProtoArtifactRetention.ARCHIVED;
  return ProtoArtifactRetention.PURGE_PENDING;
}

function retentionFromProto(value: ProtoArtifactRetention): ArtifactRetention {
  if (value === ProtoArtifactRetention.ACTIVE) return "active";
  if (value === ProtoArtifactRetention.ARCHIVED) return "archived";
  if (value === ProtoArtifactRetention.PURGE_PENDING) return "purge_pending";
  throw new TypeError("artifact retention enum is invalid");
}

function blobPath(digest: ContentHash): string {
  return `sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

function timestampMessage(value: Timestamp) {
  return create(TimestampSchema, {
    seconds: BigInt(Math.floor(value / 1000)),
    nanos: (value % 1000) * 1_000_000,
  });
}

function timestampFromMessage(value: { seconds: bigint; nanos: number } | undefined): Timestamp {
  if (
    value === undefined ||
    !Number.isSafeInteger(value.nanos) ||
    value.nanos < 0 ||
    value.nanos > 999_999_999
  ) {
    throw new TypeError("timestamp is invalid");
  }
  if (value.nanos % 1_000_000 !== 0) throw new TypeError("timestamp precision is invalid");
  const milliseconds = value.seconds * 1000n + BigInt(value.nanos / 1_000_000);
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("timestamp is too large");
  return timestampFromEpochMilliseconds(Number(milliseconds));
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`${key} is missing or not text`);
  return value;
}

function nullableString(value: unknown, key: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${key} is not text or null`);
  return value;
}

function requiredNullable(row: SqliteRow, key: string): string | undefined {
  if (!(key in row)) throw new TypeError(`${key} is missing`);
  return nullableString(row[key], key);
}

function safeInteger(value: unknown, fieldName: string): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError(`${fieldName} is invalid`);
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} is invalid`);
  }
  return value;
}

function safeTimestamp(value: unknown, fieldName: string): Timestamp {
  return timestampFromEpochMilliseconds(safeInteger(value, fieldName));
}

function safeBigint(value: unknown, fieldName: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError(`${fieldName} is invalid`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError(`${fieldName} is invalid`);
}

function changes(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function normalizeArtifactError(error: unknown, message: string): ArtifactRegistryError | Error {
  let current = error;
  const visited = new Set<Error>();
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof ArtifactRegistryError) return current;
    visited.add(current);
    current = current.cause;
  }
  if (error instanceof DomainError) {
    return new ArtifactRegistryError(
      error.code === "invalid_outcome" ? "invalid_outcome" : "invalid_input",
      error.message,
      { cause: error },
    );
  }
  if (error instanceof SqliteCommandError) {
    if (error.code === "aggregate_version_conflict" || error.code === "command_id_conflict") {
      return new ArtifactRegistryError(
        "identity_conflict",
        "artifact command conflicts with an existing command or version",
        { cause: error },
      );
    }
    if (error.code === "command_result_corrupt") {
      return new ArtifactRegistryError("corrupt", "artifact command result is corrupt", {
        cause: error,
      });
    }
    if (error.code === "invalid_command") {
      return new ArtifactRegistryError("invalid_input", "artifact command is invalid", {
        cause: error,
      });
    }
    if (error.code === "command_failed") {
      return new ArtifactRegistryError("corrupt", message, { cause: error });
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
