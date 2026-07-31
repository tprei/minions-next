import { DomainError } from "./domain-error.js";
import type { DomainPorts } from "./ports.js";
import type { TaskNode } from "./task-node.js";
import {
  attemptId,
  compareTimestamps,
  timestampFromEpochMilliseconds,
  type AttemptId,
  type HostId,
  type RepositoryId,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
} from "./value-objects.js";

declare const attemptBrand: unique symbol;

export type Attempt = Readonly<{
  [attemptBrand]: true;
  id: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  ordinal: number;
  startedAt: Timestamp;
}>;

export type CreateAttemptInput = Readonly<{
  node: TaskNode;
  ordinal: number;
}>;

export function createAttempt(input: CreateAttemptInput, ports: DomainPorts): Attempt {
  if (input.node.state.kind !== "active") {
    throw new DomainError(
      "invalid_transition",
      `cannot create an attempt for a node in ${input.node.state.kind} state`,
    );
  }
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal <= 0) {
    throw new DomainError("invalid_value", "attempt ordinal must be a positive safe integer");
  }

  const id = attemptId(ports.ids.nextId());
  const occupiedIds: readonly string[] = [
    input.node.id,
    input.node.treeId,
    input.node.repositoryId,
    input.node.hostId,
    input.node.planRevisionId,
    ...(input.node.outputContract.kind === "artifact"
      ? [input.node.outputContract.artifactId]
      : []),
  ];
  if (occupiedIds.includes(id)) {
    throw new DomainError("duplicate_id", `attempt ID ${id} already belongs to its node context`);
  }
  const startedAt = timestampFromEpochMilliseconds(ports.clock.now());
  if (compareTimestamps(startedAt, input.node.updatedAt) < 0) {
    throw new DomainError("invalid_transition", "an attempt cannot predate its active node");
  }

  return Object.freeze({
    id,
    nodeId: input.node.id,
    treeId: input.node.treeId,
    repositoryId: input.node.repositoryId,
    hostId: input.node.hostId,
    ordinal: input.ordinal,
    startedAt,
  }) as Attempt;
}
