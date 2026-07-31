import { DomainError } from "./domain-error.js";
import type { DomainPorts } from "./ports.js";
import type { Repository } from "./repository.js";
import {
  createTaskNode,
  transitionTaskNode,
  type TaskNode,
  type TaskNodeDefinition,
  type TaskNodeTransition,
} from "./task-node.js";
import {
  compareTimestamps,
  gitSha,
  nonEmptyText,
  planRevisionId,
  taskTreeId,
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

declare const taskTreeBrand: unique symbol;

export type TaskTree = Readonly<{
  [taskTreeBrand]: true;
  id: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  baseCommit: GitSha;
  goal: NonEmptyText;
  activePlanRevisionId: PlanRevisionId;
  rootNodeId: TaskNodeId;
  nodes: readonly TaskNode[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}>;

export type CreateTaskTreeInput = Readonly<{
  repository: Repository;
  baseCommit: GitSha;
  goal: string;
  root: TaskNodeDefinition;
}>;

export function createTaskTree(input: CreateTaskTreeInput, ports: DomainPorts): TaskTree {
  const goal = nonEmptyText(input.goal, "tree goal");
  const baseCommit = gitSha(input.baseCommit);
  if (input.root.inputs.length !== 0) {
    throw new DomainError(
      "invalid_artifact_input",
      "a root node cannot consume ancestor artifacts",
    );
  }

  const id = taskTreeId(ports.ids.nextId());
  const activePlanRevisionId = planRevisionId(ports.ids.nextId());
  const root = createTaskNode(
    {
      treeId: id,
      repositoryId: input.repository.id,
      hostId: input.repository.hostId,
      parentNodeId: null,
      planRevisionId: activePlanRevisionId,
      definition: input.root,
    },
    ports,
  );
  validateDistinctTreeIds(input.repository, id, activePlanRevisionId, root);
  if (compareTimestamps(root.createdAt, input.repository.registeredAt) < 0) {
    throw new DomainError("invalid_tree", "a task tree cannot predate its repository registration");
  }

  return Object.freeze({
    id,
    repositoryId: input.repository.id,
    hostId: input.repository.hostId,
    baseCommit,
    goal,
    activePlanRevisionId,
    rootNodeId: root.id,
    nodes: Object.freeze([root]),
    createdAt: root.createdAt,
    updatedAt: root.updatedAt,
  }) as TaskTree;
}

export function appendTaskNode(
  tree: TaskTree,
  parentNodeId: TaskNodeId,
  definition: TaskNodeDefinition,
  ports: DomainPorts,
): TaskTree {
  const parent = getTaskNode(tree, parentNodeId);
  validateArtifactInputs(tree, parent, definition);

  const node = createTaskNode(
    {
      treeId: tree.id,
      repositoryId: tree.repositoryId,
      hostId: tree.hostId,
      parentNodeId: parent.id,
      planRevisionId: tree.activePlanRevisionId,
      definition,
    },
    ports,
  );
  validateNewNodeIds(tree, node);
  if (compareTimestamps(node.createdAt, tree.updatedAt) < 0) {
    throw new DomainError("invalid_tree", "tree updates cannot move backward in time");
  }

  return replaceTreeNodes(tree, Object.freeze([...tree.nodes, node]), node.updatedAt);
}

export function transitionNodeInTree(
  tree: TaskTree,
  nodeId: TaskNodeId,
  transition: TaskNodeTransition,
  at: Timestamp,
): TaskTree {
  if (compareTimestamps(at, tree.updatedAt) < 0) {
    throw new DomainError("invalid_transition", "tree transitions cannot move backward in time");
  }

  const current = getTaskNode(tree, nodeId);
  if (
    (transition.kind === "mark_ready" ||
      transition.kind === "activate" ||
      transition.kind === "unblock") &&
    findFailedAncestor(tree, current) !== undefined
  ) {
    throw new DomainError(
      "invalid_transition",
      "a node with a failed ancestor cannot become runnable",
    );
  }

  const transitioned = transitionTaskNode(current, transition, at);
  let nodes = tree.nodes.map((node) => (node.id === transitioned.id ? transitioned : node));
  if (transitioned.state.kind === "failed") {
    nodes = blockStartedDescendants(tree, nodes, transitioned, transitioned.state.evidenceId, at);
  }

  return replaceTreeNodes(tree, Object.freeze(nodes), at);
}

export function getTaskNode(tree: TaskTree, nodeId: TaskNodeId): TaskNode {
  const node = tree.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    throw new DomainError("not_found", `task node ${nodeId} does not belong to tree ${tree.id}`);
  }
  return node;
}

export function getChildNodes(tree: TaskTree, parentNodeId: TaskNodeId): readonly TaskNode[] {
  getTaskNode(tree, parentNodeId);
  return Object.freeze(tree.nodes.filter((node) => node.parentNodeId === parentNodeId));
}

export function getAncestorNodes(tree: TaskTree, nodeId: TaskNodeId): readonly TaskNode[] {
  const ancestors: TaskNode[] = [];
  let current = getTaskNode(tree, nodeId);
  while (current.parentNodeId !== null) {
    current = getTaskNode(tree, current.parentNodeId);
    ancestors.push(current);
  }
  return Object.freeze(ancestors);
}

function validateArtifactInputs(
  tree: TaskTree,
  parent: TaskNode,
  definition: TaskNodeDefinition,
): void {
  const ancestorIds = new Set<TaskNodeId>([parent.id]);
  for (const ancestor of getAncestorNodes(tree, parent.id)) {
    ancestorIds.add(ancestor.id);
  }
  for (const input of definition.inputs) {
    if (!ancestorIds.has(input.sourceNodeId)) {
      throw new DomainError(
        "invalid_artifact_input",
        `artifact ${input.artifactId} must be owned by an ancestor of the new node`,
      );
    }
    const source = getTaskNode(tree, input.sourceNodeId);
    if (
      source.outputContract.kind !== "artifact" ||
      source.outputContract.artifactId !== input.artifactId
    ) {
      throw new DomainError(
        "invalid_artifact_input",
        `artifact ${input.artifactId} is not declared by ancestor ${input.sourceNodeId}`,
      );
    }
  }
}

function validateDistinctTreeIds(
  repository: Repository,
  treeId: TaskTreeId,
  revisionId: PlanRevisionId,
  root: TaskNode,
): void {
  const ids = [repository.id, repository.hostId, treeId, revisionId, ...ownedNodeIds(root)];
  if (new Set(ids).size !== ids.length) {
    throw new DomainError(
      "duplicate_id",
      "repository, tree, revision, node, and artifact IDs must differ",
    );
  }
}

function validateNewNodeIds(tree: TaskTree, node: TaskNode): void {
  const occupiedIds = new Set<string>([
    tree.repositoryId,
    tree.hostId,
    tree.id,
    tree.activePlanRevisionId,
  ]);
  for (const existing of tree.nodes) {
    for (const id of ownedNodeIds(existing)) {
      occupiedIds.add(id);
    }
  }
  for (const id of ownedNodeIds(node)) {
    if (occupiedIds.has(id)) {
      throw new DomainError("duplicate_id", `ID ${id} already belongs to tree ${tree.id}`);
    }
  }
}

function ownedNodeIds(node: TaskNode): readonly string[] {
  return node.outputContract.kind === "artifact"
    ? [node.id, node.outputContract.artifactId]
    : [node.id];
}

function findFailedAncestor(tree: TaskTree, node: TaskNode): TaskNode | undefined {
  let parentNodeId = node.parentNodeId;
  while (parentNodeId !== null) {
    const parent = getTaskNode(tree, parentNodeId);
    if (parent.state.kind === "failed") {
      return parent;
    }
    parentNodeId = parent.parentNodeId;
  }
  return undefined;
}

function blockStartedDescendants(
  treeBeforeTransition: TaskTree,
  nodes: readonly TaskNode[],
  failedNode: TaskNode,
  evidenceId: EvidenceId,
  at: Timestamp,
): TaskNode[] {
  return nodes.map((node) => {
    if (
      (node.state.kind !== "active" && node.state.kind !== "ready") ||
      !isDescendantOf(treeBeforeTransition, node, failedNode.id)
    ) {
      return node;
    }
    return transitionTaskNode(
      node,
      {
        kind: "block",
        blocker: Object.freeze({
          kind: "parent",
          evidenceId,
          parentNodeId: failedNode.id,
        }),
      },
      at,
    );
  });
}

function isDescendantOf(tree: TaskTree, node: TaskNode, ancestorId: TaskNodeId): boolean {
  let parentNodeId = node.parentNodeId;
  while (parentNodeId !== null) {
    if (parentNodeId === ancestorId) {
      return true;
    }
    parentNodeId = getTaskNode(tree, parentNodeId).parentNodeId;
  }
  return false;
}

function replaceTreeNodes(
  tree: TaskTree,
  nodes: readonly TaskNode[],
  updatedAt: Timestamp,
): TaskTree {
  return Object.freeze({ ...tree, nodes, updatedAt });
}
