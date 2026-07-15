import type {
  ActorSessionId,
  AttemptId,
  CommandId,
  EventId,
  NonEmptyText,
  RepositoryId,
  TaskNodeId,
  TaskTreeId,
  Timestamp,
} from "./value-objects.js";

export type AggregateKind = "repository" | "tree" | "node" | "attempt";

export type AggregateId = RepositoryId | TaskTreeId | TaskNodeId | AttemptId;

export type EncodedMessage = Readonly<{
  typeName: NonEmptyText;
  bytes: Uint8Array;
}>;

export type CommandRequest = Readonly<{
  id: CommandId;
  actorSessionId: ActorSessionId;
  aggregateKind: AggregateKind;
  aggregateId: AggregateId;
  expectedVersion: number | null;
  command: EncodedMessage;
}>;

export type ExternalOperationIntent = Readonly<{
  operationKind: NonEmptyText;
  idempotencyKey: NonEmptyText;
  request: EncodedMessage;
  availableAt: Timestamp;
}>;

export type AppliedCommand = Readonly<{
  event: EncodedMessage;
  result: EncodedMessage;
  externalOperations: readonly ExternalOperationIntent[];
}>;

export type CommandReceipt = Readonly<{
  commandId: CommandId;
  eventId: EventId;
  eventSequence: bigint;
  aggregateVersion: number;
  result: EncodedMessage;
}>;
