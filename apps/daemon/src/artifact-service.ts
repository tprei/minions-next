import {
  create,
  type DescMessage,
  type MessageShape,
  type MessageValidType,
} from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { ArtifactRegistryError, BlobCorruptionError } from "@minions/adapters";
import {
  ArtifactOutcomeSchema,
  ArtifactRetention,
  ArtifactSchema,
  ArtifactService,
  CommitOutcomeSchema,
  CreateArtifactResponseSchema,
  GetArtifactResponseSchema,
  GetNodeOutcomeResponseSchema,
  ListArtifactsResponseSchema,
  NoChangeOutcomeSchema,
  NodeOutcomeSchema,
  ReadArtifactResponseSchema,
  RecordNodeOutcomeResponseSchema,
  type RecordNodeOutcomeRequest,
} from "@minions/contracts";
import {
  artifactId,
  actorSessionId,
  attemptId,
  BlobPersistenceRejected,
  commandId,
  contentHash,
  evidenceId,
  gitSha,
  nonEmptyText,
  snapshotRecordedNodeOutcome,
  taskNodeId,
  timestampFromEpochMilliseconds,
  DomainError,
  type ArtifactRecord,
  type ArtifactRetention as CoreArtifactRetention,
  type Clock,
  type ContentBlobStore,
  type ExpectedBlob,
  type NodeOutcomeRecord,
  type ArtifactRegistry as CoreArtifactRegistry,
} from "@minions/core";

const responseValidator = createValidator();

export type ArtifactServiceOptions = Readonly<{
  registry: CoreArtifactRegistry;
  blobStore: ContentBlobStore;
  clock: Clock;
}>;

export function registerArtifactService(
  router: ConnectRouter,
  options: ArtifactServiceOptions,
): void {
  router.service(ArtifactService, {
    async createArtifact(request) {
      try {
        const normalizedCommandId = commandId(request.commandId);
        const normalizedActorSessionId = actorSessionId(request.actorSessionId);
        const normalizedArtifactId = artifactId(request.artifactId);
        const normalizedNodeId = taskNodeId(request.nodeId);
        const normalizedAttemptId =
          request.attemptId === undefined ? undefined : attemptId(request.attemptId);
        const normalizedExpectedNodeVersion = safeVersion(request.expectedNodeVersion);
        const normalizedMediaType = nonEmptyText(request.mediaType, "artifact media type");
        const normalizedArtifactType = nonEmptyText(request.artifactType, "artifact type");
        const normalizedEvidenceId = evidenceId(request.evidenceId);
        const normalizedRetention = toCoreRetention(request.retention);
        const artifact = await options.blobStore.withPublishedBlob(
          request.content,
          async (blob) => {
            try {
              return await options.registry.create({
                commandId: normalizedCommandId,
                actorSessionId: normalizedActorSessionId,
                artifactId: normalizedArtifactId,
                nodeId: normalizedNodeId,
                attemptId: normalizedAttemptId,
                expectedNodeVersion: normalizedExpectedNodeVersion,
                mediaType: normalizedMediaType,
                artifactType: normalizedArtifactType,
                evidenceId: normalizedEvidenceId,
                retention: normalizedRetention,
                blob,
                at: timestampFromEpochMilliseconds(options.clock.now()),
              });
            } catch (error) {
              if (error instanceof ArtifactRegistryError && error.code !== "corrupt") {
                throw new BlobPersistenceRejected(error);
              }
              throw error;
            }
          },
        );
        return validateResponse(
          CreateArtifactResponseSchema,
          create(CreateArtifactResponseSchema, { artifact: toArtifactMessage(artifact) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    getArtifact(request) {
      try {
        const artifact = options.registry.get(artifactId(request.artifactId));
        if (artifact === undefined) {
          throw new ConnectError("artifact was not found", Code.NotFound);
        }
        return validateResponse(
          GetArtifactResponseSchema,
          create(GetArtifactResponseSchema, { artifact: toArtifactMessage(artifact) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    async readArtifact(request) {
      try {
        const artifact = options.registry.get(artifactId(request.artifactId));
        if (artifact === undefined) {
          throw new ConnectError("artifact was not found", Code.NotFound);
        }
        const content = await options.blobStore.readVerified(expectedBlob(artifact));
        return validateResponse(
          ReadArtifactResponseSchema,
          create(ReadArtifactResponseSchema, {
            artifact: toArtifactMessage(artifact),
            content,
          }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    listArtifacts(request) {
      try {
        const rows = options.registry.list({
          nodeId: taskNodeId(request.nodeId),
          afterArtifactId:
            request.afterArtifactId === undefined ? undefined : artifactId(request.afterArtifactId),
          limit: request.pageSize + 1,
        });
        const artifacts = rows.slice(0, request.pageSize);
        const hasNext = rows.length > artifacts.length;
        const last = artifacts.at(-1);
        return validateResponse(
          ListArtifactsResponseSchema,
          create(ListArtifactsResponseSchema, {
            artifacts: artifacts.map(toArtifactMessage),
            ...(hasNext && last !== undefined ? { nextArtifactId: last.id } : {}),
          }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    async recordNodeOutcome(request) {
      try {
        const outcome = await options.registry.recordOutcome({
          commandId: commandId(request.commandId),
          actorSessionId: actorSessionId(request.actorSessionId),
          nodeId: taskNodeId(request.nodeId),
          expectedNodeVersion: safeRequiredVersion(request.expectedNodeVersion),
          outcome: toCoreOutcome(request.outcome),
          at: timestampFromEpochMilliseconds(options.clock.now()),
        });
        return validateResponse(
          RecordNodeOutcomeResponseSchema,
          create(RecordNodeOutcomeResponseSchema, { outcome: toNodeOutcomeMessage(outcome) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    getNodeOutcome(request) {
      try {
        const outcome = options.registry.getOutcome(taskNodeId(request.nodeId));
        if (outcome === undefined) {
          throw new ConnectError("node outcome was not found", Code.NotFound);
        }
        return validateResponse(
          GetNodeOutcomeResponseSchema,
          create(GetNodeOutcomeResponseSchema, { outcome: toNodeOutcomeMessage(outcome) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
  });
}

function toArtifactMessage(artifact: ArtifactRecord) {
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
    retention: toProtoRetention(artifact.retention),
    createdAt: timestampMessage(artifact.createdAt),
    verifiedAt: timestampMessage(artifact.verifiedAt),
  });
}

function toNodeOutcomeMessage(record: NodeOutcomeRecord) {
  const outcome = record.outcome;
  const encoded =
    outcome.kind === "artifact"
      ? {
          case: "artifact" as const,
          value: create(ArtifactOutcomeSchema, { artifactId: outcome.artifactId }),
        }
      : outcome.kind === "no_change"
        ? {
            case: "noChange" as const,
            value: create(NoChangeOutcomeSchema, {
              revision: outcome.revision,
              evidenceId: outcome.evidenceId,
              explanation: outcome.explanation,
            }),
          }
        : {
            case: "commit" as const,
            value: create(CommitOutcomeSchema, {
              revision: outcome.revision,
              evidenceId: outcome.evidenceId,
            }),
          };
  return create(NodeOutcomeSchema, {
    nodeId: record.nodeId,
    outcome: encoded,
    createdAt: timestampMessage(record.createdAt),
  });
}

function toCoreOutcome(outcome: RecordNodeOutcomeRequest["outcome"]) {
  switch (outcome.case) {
    case "artifact":
      return snapshotRecordedNodeOutcome({
        kind: "artifact",
        artifactId: artifactId(outcome.value.artifactId),
      });
    case "noChange":
      return snapshotRecordedNodeOutcome({
        kind: "no_change",
        revision: gitSha(outcome.value.revision),
        evidenceId: evidenceId(outcome.value.evidenceId),
        explanation: nonEmptyText(outcome.value.explanation, "no-change explanation"),
      });
    case "commit":
      return snapshotRecordedNodeOutcome({
        kind: "commit",
        revision: gitSha(outcome.value.revision),
        evidenceId: evidenceId(outcome.value.evidenceId),
      });
    case undefined:
      throw new ConnectError("node outcome is required", Code.InvalidArgument);
  }
}

function expectedBlob(artifact: ArtifactRecord): ExpectedBlob {
  const digest = contentHash(artifact.contentDigest);
  return {
    digest,
    sizeBytes: artifact.sizeBytes,
    relativePath: nonEmptyText(relativePathForDigest(digest), "blob relative path"),
  };
}
function relativePathForDigest(digest: string): string {
  return `sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

function toCoreRetention(value: ArtifactRetention): CoreArtifactRetention {
  switch (value) {
    case ArtifactRetention.ACTIVE:
      return "active";
    case ArtifactRetention.ARCHIVED:
      return "archived";
    case ArtifactRetention.PURGE_PENDING:
      return "purge_pending";
    case ArtifactRetention.UNSPECIFIED:
      throw new ConnectError("artifact retention is required", Code.InvalidArgument);
  }
}

function toProtoRetention(value: CoreArtifactRetention): ArtifactRetention {
  switch (value) {
    case "active":
      return ArtifactRetention.ACTIVE;
    case "archived":
      return ArtifactRetention.ARCHIVED;
    case "purge_pending":
      return ArtifactRetention.PURGE_PENDING;
  }
}

function timestampMessage(milliseconds: number) {
  const value = BigInt(milliseconds);
  return create(TimestampSchema, {
    seconds: value / 1_000n,
    nanos: Number(value % 1_000n) * 1_000_000,
  });
}

function safeVersion(value: bigint | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectError(
      "expected node version exceeds the supported range",
      Code.InvalidArgument,
    );
  }
  return Number(value);
}

function safeRequiredVersion(value: bigint): number {
  const version = safeVersion(value);
  if (version === undefined) {
    throw new ConnectError("expected node version is required", Code.InvalidArgument);
  }
  return version;
}

function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    return error;
  }
  if (error instanceof ArtifactRegistryError) {
    switch (error.code) {
      case "not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "invalid_input":
      case "invalid_outcome":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "identity_conflict":
      case "facts_changed":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      case "corrupt":
        return new ConnectError(error.message, Code.DataLoss, undefined, undefined, error);
    }
  }
  if (error instanceof BlobCorruptionError) {
    return new ConnectError(error.message, Code.DataLoss, undefined, undefined, error);
  }
  if (error instanceof DomainError) {
    switch (error.code) {
      case "invalid_value":
      case "invalid_artifact_input":
      case "invalid_outcome":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "duplicate_id":
      case "invalid_transition":
      case "invalid_tree":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
    }
  }
  return new ConnectError("artifact operation failed", Code.Internal, undefined, undefined, error);
}

function validateResponse<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): MessageValidType<Desc> {
  const validation = responseValidator.validate(schema, message);
  if (validation.kind !== "valid") {
    throw new ConnectError(
      "artifact service produced an invalid response",
      Code.Internal,
      undefined,
      undefined,
      validation.error,
    );
  }
  return validation.message;
}
