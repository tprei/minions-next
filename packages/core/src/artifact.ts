import { DomainError } from "./domain-error.js";
import {
  actorSessionId,
  artifactId,
  attemptId,
  commandId,
  contentHash,
  evidenceId,
  gitSha,
  hostId,
  nonEmptyText,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
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
  type Timestamp,
} from "./value-objects.js";

export type ArtifactRetention = "active" | "archived" | "purge_pending";

export type ContentBlobRecord = Readonly<{
  digest: ContentHash;
  sizeBytes: bigint;
  mediaType: NonEmptyText;
  relativePath: NonEmptyText;
  retention: ArtifactRetention;
  createdAt: Timestamp;
  verifiedAt: Timestamp;
}>;

export type ArtifactRecord = Readonly<{
  id: ArtifactId;
  nodeId: TaskNodeId;
  attemptId: AttemptId | undefined;
  treeId: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  contentDigest: ContentHash;
  sizeBytes: bigint;
  mediaType: NonEmptyText;
  artifactType: NonEmptyText;
  evidenceId: EvidenceId;
  retention: ArtifactRetention;
  createdAt: Timestamp;
  verifiedAt: Timestamp;
}>;

export type StoredBlob = Readonly<{
  digest: ContentHash;
  sizeBytes: bigint;
  relativePath: NonEmptyText;
  verifiedAt: Timestamp;
  created: boolean;
}>;

export type ExpectedBlob = Readonly<{
  digest: ContentHash;
  sizeBytes: bigint;
  relativePath: NonEmptyText;
}>;

export type BlobReconciliation = Readonly<{
  removedTemporaryPaths: readonly string[];
  removedOrphanPaths: readonly string[];
  missingDigests: readonly ContentHash[];
  corruptDigests: readonly ContentHash[];
}>;

export class BlobPersistenceRejected extends Error {
  constructor(cause: Error) {
    super("blob persistence callback rejected before commit", { cause });
    this.name = "BlobPersistenceRejected";
  }
}

export interface ContentBlobStore {
  withPublishedBlob<T>(content: Uint8Array, persist: (blob: StoredBlob) => Promise<T>): Promise<T>;
  readVerified(expected: ExpectedBlob): Promise<Uint8Array>;
  reconcile(expected: readonly ExpectedBlob[]): Promise<BlobReconciliation>;
}

export type CreateArtifactRequest = Readonly<{
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  artifactId: ArtifactId;
  nodeId: TaskNodeId;
  attemptId: AttemptId | undefined;
  expectedNodeVersion: number | undefined;
  mediaType: NonEmptyText;
  artifactType: NonEmptyText;
  evidenceId: EvidenceId;
  retention: ArtifactRetention;
  blob: StoredBlob;
  at: Timestamp;
}>;

export type ListArtifactsRequest = Readonly<{
  nodeId: TaskNodeId;
  afterArtifactId: ArtifactId | undefined;
  limit: number;
}>;

export type ArtifactNodeOutcome = Readonly<{
  kind: "artifact";
  artifactId: ArtifactId;
}>;

export type NoChangeNodeOutcome = Readonly<{
  kind: "no_change";
  revision: GitSha;
  evidenceId: EvidenceId;
  explanation: NonEmptyText;
}>;

export type CommitNodeOutcome = Readonly<{
  kind: "commit";
  revision: GitSha;
  evidenceId: EvidenceId;
}>;

export type RecordedNodeOutcome = ArtifactNodeOutcome | NoChangeNodeOutcome | CommitNodeOutcome;

export type RecordNodeOutcomeRequest = Readonly<{
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  nodeId: TaskNodeId;
  expectedNodeVersion: number;
  outcome: RecordedNodeOutcome;
  at: Timestamp;
}>;

export type NodeOutcomeRecord = Readonly<{
  nodeId: TaskNodeId;
  outcome: RecordedNodeOutcome;
  createdAt: Timestamp;
}>;

export interface ArtifactRegistry {
  create(request: CreateArtifactRequest): Promise<ArtifactRecord>;
  get(id: ArtifactId): ArtifactRecord | undefined;
  list(request: ListArtifactsRequest): readonly ArtifactRecord[];
  expectedBlobs(): readonly ExpectedBlob[];
  recordOutcome(request: RecordNodeOutcomeRequest): Promise<NodeOutcomeRecord>;
  getOutcome(nodeId: TaskNodeId): NodeOutcomeRecord | undefined;
}

export function snapshotArtifactRetention(value: unknown): ArtifactRetention {
  if (value === "active" || value === "archived" || value === "purge_pending") return value;
  throw new DomainError("invalid_value", "artifact retention is invalid");
}

export function snapshotCreateArtifactRequest(input: CreateArtifactRequest): CreateArtifactRequest {
  const expectedNodeVersion = input.expectedNodeVersion;
  if (
    expectedNodeVersion !== undefined &&
    (!Number.isSafeInteger(expectedNodeVersion) || expectedNodeVersion < 0)
  ) {
    throw new DomainError("invalid_value", "expected node version is invalid");
  }
  if (input.blob.sizeBytes < 0n) {
    throw new DomainError("invalid_value", "blob size must be non-negative");
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
    retention: snapshotArtifactRetention(input.retention),
    blob: Object.freeze({
      digest: contentHash(input.blob.digest),
      sizeBytes: input.blob.sizeBytes,
      relativePath: nonEmptyText(input.blob.relativePath, "blob relative path"),
      verifiedAt: timestampFromEpochMilliseconds(input.blob.verifiedAt),
      created: input.blob.created,
    }),
    at: timestampFromEpochMilliseconds(input.at),
  });
}

export function snapshotRecordedNodeOutcome(input: RecordedNodeOutcome): RecordedNodeOutcome {
  switch (input.kind) {
    case "artifact":
      return Object.freeze({ kind: "artifact", artifactId: artifactId(input.artifactId) });
    case "no_change":
      return Object.freeze({
        kind: "no_change",
        revision: gitSha(input.revision),
        evidenceId: evidenceId(input.evidenceId),
        explanation: nonEmptyText(input.explanation, "no-change explanation"),
      });
    case "commit":
      return Object.freeze({
        kind: "commit",
        revision: gitSha(input.revision),
        evidenceId: evidenceId(input.evidenceId),
      });
  }
}

export function snapshotArtifactRecord(input: ArtifactRecord): ArtifactRecord {
  return Object.freeze({
    id: artifactId(input.id),
    nodeId: taskNodeId(input.nodeId),
    attemptId: input.attemptId === undefined ? undefined : attemptId(input.attemptId),
    treeId: taskTreeId(input.treeId),
    repositoryId: repositoryId(input.repositoryId),
    hostId: hostId(input.hostId),
    contentDigest: contentHash(input.contentDigest),
    sizeBytes: input.sizeBytes,
    mediaType: nonEmptyText(input.mediaType, "artifact media type"),
    artifactType: nonEmptyText(input.artifactType, "artifact type"),
    evidenceId: evidenceId(input.evidenceId),
    retention: snapshotArtifactRetention(input.retention),
    createdAt: timestampFromEpochMilliseconds(input.createdAt),
    verifiedAt: timestampFromEpochMilliseconds(input.verifiedAt),
  });
}
