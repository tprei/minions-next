import { DomainError } from "./domain-error.js";
import type { DomainPorts } from "./ports.js";
import {
  artifactId,
  contentHash,
  evidenceId,
  gitSha,
  hostId,
  compareTimestamps,
  nonEmptyText,
  planRevisionId,
  taskNodeId,
  timestampFromEpochMilliseconds,
  type ArtifactId,
  type ContentHash,
  type EvidenceId,
  type GitSha,
  type HostId,
  type NonEmptyText,
  type PlanRevisionId,
  type RepositoryId,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
} from "./value-objects.js";

declare const taskNodeBrand: unique symbol;

export type TaskNodeMode = "explore" | "implementation" | "plan" | "research";

export type ArtifactInput = Readonly<{
  artifactId: ArtifactId;
  sourceNodeId: TaskNodeId;
}>;

export type ArtifactOutputContract = Readonly<{
  kind: "artifact";
  artifactId: ArtifactId;
  artifactType: NonEmptyText;
}>;

export type ImplementationOutputContract = Readonly<{
  kind: "implementation";
}>;

export type TaskNodeOutputContract = ArtifactOutputContract | ImplementationOutputContract;

export type ArtifactOutcome = Readonly<{
  kind: "artifact";
  artifactId: ArtifactId;
  contentHash: ContentHash;
  artifactType: NonEmptyText;
  evidenceId: EvidenceId;
}>;

export type CommitOutcome = Readonly<{
  kind: "commit";
  commit: GitSha;
  evidenceId: EvidenceId;
}>;

export type NoChangeOutcome = Readonly<{
  kind: "no_change";
  evidenceId: EvidenceId;
  explanation: NonEmptyText;
}>;

export type TaskNodeOutcome = ArtifactOutcome | CommitOutcome | NoChangeOutcome;

type EvidencedBlocker<Kind extends string> = Readonly<{
  kind: Kind;
  evidenceId: EvidenceId;
}>;

export type TaskNodeBlocker =
  | EvidencedBlocker<"authentication">
  | EvidencedBlocker<"ci_failure">
  | EvidencedBlocker<"conflict">
  | EvidencedBlocker<"gate_failure">
  | EvidencedBlocker<"human_input">
  | EvidencedBlocker<"quota">
  | Readonly<{
      kind: "parent";
      evidenceId: EvidenceId;
      parentNodeId: TaskNodeId;
    }>
  | Readonly<{
      kind: "unavailable_host";
      evidenceId: EvidenceId;
      hostId: HostId;
    }>;

export type TaskNodeState =
  | Readonly<{ kind: "planned" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "active" }>
  | Readonly<{
      kind: "blocked";
      blocker: TaskNodeBlocker;
      resumeTo: "active" | "ready";
    }>
  | Readonly<{ kind: "succeeded"; outcome: TaskNodeOutcome }>
  | Readonly<{ kind: "failed"; evidenceId: EvidenceId }>
  | Readonly<{ kind: "cancelled"; evidenceId: EvidenceId }>
  | Readonly<{ kind: "superseded"; planRevisionId: PlanRevisionId }>;

export type TaskNode = Readonly<{
  [taskNodeBrand]: true;
  id: TaskNodeId;
  treeId: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  parentNodeId: TaskNodeId | null;
  planRevisionId: PlanRevisionId;
  mode: TaskNodeMode;
  objective: NonEmptyText;
  acceptanceCriteria: readonly NonEmptyText[];
  inputs: readonly ArtifactInput[];
  outputContract: TaskNodeOutputContract;
  state: TaskNodeState;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}>;

export type TaskNodeDefinition = Readonly<{
  mode: TaskNodeMode;
  objective: string;
  acceptanceCriteria: readonly string[];
  inputs: readonly ArtifactInput[];
  outputContract:
    Readonly<{ kind: "artifact"; artifactType: string }> | ImplementationOutputContract;
}>;

export type CreateTaskNodeInput = Readonly<{
  treeId: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  parentNodeId: TaskNodeId | null;
  planRevisionId: PlanRevisionId;
  definition: TaskNodeDefinition;
}>;

export type TaskNodeTransition =
  | Readonly<{ kind: "mark_ready" }>
  | Readonly<{ kind: "activate" }>
  | Readonly<{ kind: "block"; blocker: TaskNodeBlocker }>
  | Readonly<{ kind: "unblock" }>
  | Readonly<{ kind: "succeed"; outcome: TaskNodeOutcome }>
  | Readonly<{ kind: "fail"; evidenceId: EvidenceId }>
  | Readonly<{ kind: "cancel"; evidenceId: EvidenceId }>
  | Readonly<{ kind: "supersede"; planRevisionId: PlanRevisionId }>;
const supportedModes: Readonly<Record<TaskNodeMode, true>> = {
  explore: true,
  implementation: true,
  plan: true,
  research: true,
};

const supportedTransitions: Readonly<Record<TaskNodeTransition["kind"], true>> = {
  activate: true,
  block: true,
  cancel: true,
  fail: true,
  mark_ready: true,
  succeed: true,
  supersede: true,
  unblock: true,
};

const supportedOutcomes: Readonly<Record<TaskNodeOutcome["kind"], true>> = {
  artifact: true,
  commit: true,
  no_change: true,
};

const supportedBlockers: Readonly<Record<TaskNodeBlocker["kind"], true>> = {
  authentication: true,
  ci_failure: true,
  conflict: true,
  gate_failure: true,
  human_input: true,
  parent: true,
  quota: true,
  unavailable_host: true,
};

export function createTaskNode(input: CreateTaskNodeInput, ports: DomainPorts): TaskNode {
  const definition = validateDefinition(input.definition);
  const id = taskNodeId(ports.ids.nextId());
  const outputContract =
    definition.outputContract.kind === "artifact"
      ? Object.freeze({
          ...definition.outputContract,
          artifactId: artifactId(ports.ids.nextId()),
        })
      : definition.outputContract;
  if (outputContract.kind === "artifact") {
    const nodeIdValue: string = id;
    const artifactIdValue: string = outputContract.artifactId;
    if (artifactIdValue === nodeIdValue) {
      throw new DomainError(
        "duplicate_id",
        `task node ${id} cannot own an artifact with the same ID`,
      );
    }
  }
  const createdAt = timestampFromEpochMilliseconds(ports.clock.now());
  const node = {
    id,
    treeId: input.treeId,
    repositoryId: input.repositoryId,
    hostId: input.hostId,
    parentNodeId: input.parentNodeId,
    planRevisionId: input.planRevisionId,
    mode: definition.mode,
    objective: definition.objective,
    acceptanceCriteria: definition.acceptanceCriteria,
    inputs: definition.inputs,
    outputContract,
    state: Object.freeze({ kind: "planned" as const }),
    createdAt,
    updatedAt: createdAt,
  };
  return Object.freeze(node) as TaskNode;
}

export function transitionTaskNode(
  node: TaskNode,
  transition: TaskNodeTransition,
  at: Timestamp,
): TaskNode {
  if (!Object.hasOwn(supportedTransitions, transition.kind)) {
    throw new DomainError("invalid_transition", "unsupported node transition");
  }
  timestampFromEpochMilliseconds(at);
  if (compareTimestamps(at, node.updatedAt) < 0) {
    throw new DomainError("invalid_transition", "node transitions cannot move backward in time");
  }

  let state: TaskNodeState;
  switch (transition.kind) {
    case "mark_ready":
      requireState(node, transition.kind, "planned");
      state = Object.freeze({ kind: "ready" });
      break;
    case "activate":
      requireState(node, transition.kind, "ready");
      state = Object.freeze({ kind: "active" });
      break;
    case "block":
      if (node.state.kind !== "active" && node.state.kind !== "ready") {
        throw invalidTransition(node, transition.kind);
      }
      validateBlocker(transition.blocker);
      state = Object.freeze({
        kind: "blocked",
        blocker: freezeBlocker(transition.blocker),
        resumeTo: node.state.kind,
      });
      break;
    case "unblock":
      if (node.state.kind !== "blocked") {
        throw invalidTransition(node, transition.kind);
      }
      state = Object.freeze({ kind: node.state.resumeTo });
      break;
    case "succeed":
      requireState(node, transition.kind, "active");
      validateOutcome(node.outputContract, transition.outcome);
      state = Object.freeze({ kind: "succeeded", outcome: freezeOutcome(transition.outcome) });
      break;
    case "fail":
      requireState(node, transition.kind, "active");
      evidenceId(transition.evidenceId);
      state = Object.freeze({ kind: "failed", evidenceId: transition.evidenceId });
      break;
    case "cancel":
      if (isTerminal(node.state)) {
        throw invalidTransition(node, transition.kind);
      }
      evidenceId(transition.evidenceId);
      state = Object.freeze({ kind: "cancelled", evidenceId: transition.evidenceId });
      break;
    case "supersede":
      if (
        node.state.kind !== "planned" &&
        node.state.kind !== "ready" &&
        !(node.state.kind === "blocked" && node.state.resumeTo === "ready")
      ) {
        throw invalidTransition(node, transition.kind);
      }
      planRevisionId(transition.planRevisionId);
      state = Object.freeze({ kind: "superseded", planRevisionId: transition.planRevisionId });
      break;
  }

  return Object.freeze({ ...node, state, updatedAt: at });
}

export function isTerminalNode(node: TaskNode): boolean {
  return isTerminal(node.state);
}

function validateDefinition(definition: TaskNodeDefinition): Readonly<{
  mode: TaskNodeMode;
  objective: NonEmptyText;
  acceptanceCriteria: readonly NonEmptyText[];
  inputs: readonly ArtifactInput[];
  outputContract:
    Readonly<{ kind: "artifact"; artifactType: NonEmptyText }> | ImplementationOutputContract;
}> {
  validateMode(definition.mode);
  if (definition.acceptanceCriteria.length === 0) {
    throw new DomainError(
      "invalid_value",
      "a task node requires at least one acceptance criterion",
    );
  }
  if (definition.mode === "implementation" && definition.outputContract.kind !== "implementation") {
    throw new DomainError(
      "invalid_value",
      "implementation nodes require an implementation output contract",
    );
  }
  if (definition.mode !== "implementation" && definition.outputContract.kind !== "artifact") {
    throw new DomainError(
      "invalid_value",
      `${definition.mode} nodes require an artifact output contract`,
    );
  }

  const acceptanceCriteria = Object.freeze(
    definition.acceptanceCriteria.map((criterion) =>
      nonEmptyText(criterion, "acceptance criterion"),
    ),
  );
  const seenArtifacts = new Set<ArtifactId>();
  const inputs = Object.freeze(
    definition.inputs.map((input) => {
      const validatedArtifactId = artifactId(input.artifactId);
      const validatedSourceNodeId = taskNodeId(input.sourceNodeId);
      if (seenArtifacts.has(validatedArtifactId)) {
        throw new DomainError(
          "invalid_artifact_input",
          `artifact ${validatedArtifactId} is referenced more than once`,
        );
      }
      seenArtifacts.add(validatedArtifactId);
      return Object.freeze({
        artifactId: validatedArtifactId,
        sourceNodeId: validatedSourceNodeId,
      });
    }),
  );
  const outputContract =
    definition.outputContract.kind === "artifact"
      ? Object.freeze({
          kind: "artifact" as const,
          artifactType: nonEmptyText(definition.outputContract.artifactType, "artifact type"),
        })
      : Object.freeze({ kind: "implementation" as const });

  return Object.freeze({
    mode: definition.mode,
    objective: nonEmptyText(definition.objective, "objective"),
    acceptanceCriteria,
    inputs,
    outputContract,
  });
}

function validateOutcome(contract: TaskNodeOutputContract, outcome: TaskNodeOutcome): void {
  if (!Object.hasOwn(supportedOutcomes, outcome.kind)) {
    throw new DomainError("invalid_outcome", "unsupported node outcome");
  }
  switch (outcome.kind) {
    case "artifact":
      artifactId(outcome.artifactId);
      contentHash(outcome.contentHash);
      evidenceId(outcome.evidenceId);
      nonEmptyText(outcome.artifactType, "artifact type");
      if (
        contract.kind !== "artifact" ||
        outcome.artifactId !== contract.artifactId ||
        outcome.artifactType !== contract.artifactType
      ) {
        throw new DomainError(
          "invalid_outcome",
          "artifact outcome must match the declared artifact ID and type",
        );
      }
      return;
    case "commit":
      gitSha(outcome.commit);
      evidenceId(outcome.evidenceId);
      if (contract.kind !== "implementation") {
        throw new DomainError(
          "invalid_outcome",
          "artifact output contract requires an artifact outcome",
        );
      }
      return;
    case "no_change":
      evidenceId(outcome.evidenceId);
      nonEmptyText(outcome.explanation, "no-change explanation");
      if (contract.kind !== "implementation") {
        throw new DomainError(
          "invalid_outcome",
          "artifact output contract requires an artifact outcome",
        );
      }
      return;
  }
}

function validateBlocker(blocker: TaskNodeBlocker): void {
  if (!Object.hasOwn(supportedBlockers, blocker.kind)) {
    throw new DomainError("invalid_value", "unsupported node blocker");
  }
  evidenceId(blocker.evidenceId);
  switch (blocker.kind) {
    case "authentication":
    case "ci_failure":
    case "conflict":
    case "gate_failure":
    case "human_input":
    case "quota":
      return;
    case "parent":
      taskNodeId(blocker.parentNodeId);
      return;
    case "unavailable_host":
      hostId(blocker.hostId);
      return;
  }
}

function freezeBlocker(blocker: TaskNodeBlocker): TaskNodeBlocker {
  return Object.freeze({ ...blocker });
}

function freezeOutcome(outcome: TaskNodeOutcome): TaskNodeOutcome {
  return Object.freeze({ ...outcome });
}

function requireState(
  node: TaskNode,
  transition: TaskNodeTransition["kind"],
  expected: TaskNodeState["kind"],
): void {
  if (node.state.kind !== expected) {
    throw invalidTransition(node, transition);
  }
}

function invalidTransition(node: TaskNode, transition: TaskNodeTransition["kind"]): DomainError {
  return new DomainError(
    "invalid_transition",
    `cannot apply ${transition} to a node in ${node.state.kind} state`,
  );
}

function validateMode(mode: TaskNodeMode): void {
  if (!Object.hasOwn(supportedModes, mode)) {
    throw new DomainError("invalid_value", "unsupported task node mode");
  }
}

function isTerminal(state: TaskNodeState): boolean {
  return (
    state.kind === "cancelled" ||
    state.kind === "failed" ||
    state.kind === "succeeded" ||
    state.kind === "superseded"
  );
}
