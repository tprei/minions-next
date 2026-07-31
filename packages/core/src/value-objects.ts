import { DomainError } from "./domain-error.js";

declare const artifactIdBrand: unique symbol;
declare const actorSessionIdBrand: unique symbol;
declare const attemptIdBrand: unique symbol;
declare const contentHashBrand: unique symbol;
declare const commandIdBrand: unique symbol;
declare const evidenceIdBrand: unique symbol;
declare const gitShaBrand: unique symbol;
declare const eventIdBrand: unique symbol;
declare const externalOperationIdBrand: unique symbol;
declare const hostIdBrand: unique symbol;
declare const nonEmptyTextBrand: unique symbol;
declare const planRevisionIdBrand: unique symbol;
declare const outboxIdBrand: unique symbol;
declare const repositoryIdBrand: unique symbol;
declare const repositoryRootBrand: unique symbol;
declare const taskNodeIdBrand: unique symbol;
declare const taskTreeIdBrand: unique symbol;
declare const timestampBrand: unique symbol;

export type ArtifactId = string & { readonly [artifactIdBrand]: true };
export type ActorSessionId = string & { readonly [actorSessionIdBrand]: true };
export type AttemptId = string & { readonly [attemptIdBrand]: true };
export type ContentHash = string & { readonly [contentHashBrand]: true };
export type EvidenceId = string & { readonly [evidenceIdBrand]: true };
export type CommandId = string & { readonly [commandIdBrand]: true };
export type GitSha = string & { readonly [gitShaBrand]: true };
export type HostId = string & { readonly [hostIdBrand]: true };
export type EventId = string & { readonly [eventIdBrand]: true };
export type ExternalOperationId = string & { readonly [externalOperationIdBrand]: true };
export type NonEmptyText = string & { readonly [nonEmptyTextBrand]: true };
export type OutboxId = string & { readonly [outboxIdBrand]: true };
export type PlanRevisionId = string & { readonly [planRevisionIdBrand]: true };
export type RepositoryId = string & { readonly [repositoryIdBrand]: true };
export type RepositoryRoot = string & { readonly [repositoryRootBrand]: true };
export type TaskNodeId = string & { readonly [taskNodeIdBrand]: true };
export type TaskTreeId = string & { readonly [taskTreeIdBrand]: true };
export type Timestamp = number & { readonly [timestampBrand]: true };

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const contentHashPattern = /^[0-9a-f]{64}$/u;
const gitShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export function actorSessionId(value: string): ActorSessionId {
  return parseUuidV7(value, "actor session ID") as ActorSessionId;
}

export function artifactId(value: string): ArtifactId {
  return parseUuidV7(value, "artifact ID") as ArtifactId;
}

export function attemptId(value: string): AttemptId {
  return parseUuidV7(value, "attempt ID") as AttemptId;
}
export function commandId(value: string): CommandId {
  return parseUuidV7(value, "command ID") as CommandId;
}

export function contentHash(value: string): ContentHash {
  if (!contentHashPattern.test(value)) {
    throw new DomainError(
      "invalid_value",
      "content hash must be 64 lowercase hexadecimal characters",
    );
  }
  return value as ContentHash;
}

export function evidenceId(value: string): EvidenceId {
  return parseUuidV7(value, "evidence ID") as EvidenceId;
}
export function eventId(value: string): EventId {
  return parseUuidV7(value, "event ID") as EventId;
}
export function externalOperationId(value: string): ExternalOperationId {
  return parseUuidV7(value, "external operation ID") as ExternalOperationId;
}

export function gitSha(value: string): GitSha {
  if (!gitShaPattern.test(value)) {
    throw new DomainError(
      "invalid_value",
      "Git SHA must be 40 or 64 lowercase hexadecimal characters",
    );
  }
  return value as GitSha;
}

export function outboxId(value: string): OutboxId {
  return parseUuidV7(value, "outbox ID") as OutboxId;
}

export function hostId(value: string): HostId {
  return parseUuidV7(value, "host ID") as HostId;
}

export function nonEmptyText(value: string, fieldName: string): NonEmptyText {
  if (value.trim().length === 0) {
    throw new DomainError("invalid_value", `${fieldName} must not be empty`);
  }
  return value as NonEmptyText;
}

export function planRevisionId(value: string): PlanRevisionId {
  return parseUuidV7(value, "plan revision ID") as PlanRevisionId;
}

export function repositoryId(value: string): RepositoryId {
  return parseUuidV7(value, "repository ID") as RepositoryId;
}

export function repositoryRoot(value: string): RepositoryRoot {
  if (value.trim().length === 0) {
    throw new DomainError("invalid_value", "repository root must not be empty");
  }
  return value as RepositoryRoot;
}

export function taskNodeId(value: string): TaskNodeId {
  return parseUuidV7(value, "task node ID") as TaskNodeId;
}

export function taskTreeId(value: string): TaskTreeId {
  return parseUuidV7(value, "task tree ID") as TaskTreeId;
}

export function timestampFromEpochMilliseconds(value: number): Timestamp {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "invalid_value",
      "timestamp must be a non-negative safe integer of epoch milliseconds",
    );
  }
  return value as Timestamp;
}

export function compareTimestamps(left: Timestamp, right: Timestamp): number {
  return left - right;
}

function parseUuidV7(value: string, fieldName: string): string {
  if (!uuidV7Pattern.test(value)) {
    throw new DomainError("invalid_value", `${fieldName} must be a lowercase UUIDv7`);
  }
  return value;
}
