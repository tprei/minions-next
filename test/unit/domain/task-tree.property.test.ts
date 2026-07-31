import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  appendTaskNode,
  artifactId,
  createRepository,
  createTaskTree,
  DomainError,
  getChildNodes,
  getTaskNode,
  gitSha,
  hostId,
  repositoryRoot,
  taskNodeId,
  timestampFromEpochMilliseconds,
  type ArtifactInput,
  type DomainPorts,
  type TaskNodeDefinition,
  type TaskNodeId,
  type TaskTree,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";

const TEST_TIMESTAMP = timestampFromEpochMilliseconds(1_700_000_000_000);
const HOST_ID = hostId(makeUuid(0x1000));
const REPOSITORY_ROOT = repositoryRoot("/workspace/minions");
const BASE_COMMIT = gitSha("a".repeat(40));

function makeUuid(counter: number): string {
  return `01890f00-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`;
}

function createPorts(appendCount: number): DomainPorts {
  const ids = Array.from({ length: appendCount + 4 }, (_, index) => makeUuid(index + 1));
  return {
    clock: new FixedClock(TEST_TIMESTAMP),
    ids: new SequenceIdGenerator(ids),
  };
}

function implementationDefinition(index: number): TaskNodeDefinition {
  return {
    mode: "implementation",
    objective: `implement task ${String(index)}`,
    acceptanceCriteria: [`task ${String(index)} is complete`],
    inputs: [],
    outputContract: { kind: "implementation" },
  };
}

function artifactDefinition(
  index: number,
  inputs: readonly ArtifactInput[] = [],
): TaskNodeDefinition {
  return {
    mode: "research",
    objective: `research task ${String(index)}`,
    acceptanceCriteria: [`research ${String(index)} is complete`],
    inputs,
    outputContract: { kind: "artifact", artifactType: "report" },
  };
}

function createBaseTree(
  ports: DomainPorts,
  root: TaskNodeDefinition = implementationDefinition(0),
): { tree: TaskTree } {
  const repository = createRepository(
    {
      hostId: HOST_ID,
      root: REPOSITORY_ROOT,
    },
    ports,
  );
  const tree = createTaskTree(
    {
      repository,
      baseCommit: BASE_COMMIT,
      goal: "complete the deterministic task tree",
      root,
    },
    ports,
  );
  return { tree };
}

function artifactInput(counter: number, sourceNodeId: TaskNodeId): ArtifactInput {
  return {
    artifactId: artifactId(makeUuid(0x2000 + counter)),
    sourceNodeId,
  };
}

function expectDomainError(action: () => unknown, code: DomainError["code"]): void {
  let caught: DomainError | undefined;
  try {
    action();
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw error;
    }
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  if (caught === undefined) {
    throw new Error(`expected a ${code} domain error`);
  }
  expect(caught.code).toBe(code);
}

function expectInvalidArtifactInput(action: () => unknown): void {
  expectDomainError(action, "invalid_artifact_input");
}

function assertTreeInvariants(
  tree: TaskTree,
  expectedParentIds: readonly (TaskNodeId | null)[],
): void {
  expect(tree.nodes).toHaveLength(expectedParentIds.length);

  const rootNodes = tree.nodes.filter((node) => node.parentNodeId === null);
  expect(rootNodes).toHaveLength(1);
  expect(rootNodes[0]?.id).toBe(tree.rootNodeId);

  const nodeIds = tree.nodes.map((node) => node.id);
  expect(new Set(nodeIds).size).toBe(nodeIds.length);
  const scopedIds = [
    tree.id,
    tree.repositoryId,
    tree.hostId,
    tree.activePlanRevisionId,
    ...nodeIds,
  ];
  expect(new Set(scopedIds).size).toBe(scopedIds.length);

  tree.nodes.forEach((node, index) => {
    expect(node.treeId).toBe(tree.id);
    expect(node.repositoryId).toBe(tree.repositoryId);
    expect(node.hostId).toBe(tree.hostId);
    expect(node.parentNodeId).toBe(expectedParentIds[index]);

    if (node.parentNodeId === null) {
      expect(node.id).toBe(tree.rootNodeId);
      return;
    }

    const parentIndex = nodeIds.indexOf(node.parentNodeId);
    expect(parentIndex).toBeGreaterThanOrEqual(0);
    expect(parentIndex).toBeLessThan(index);
    expect(getTaskNode(tree, node.parentNodeId).id).toBe(node.parentNodeId);
  });

  const visited = new Set<TaskNodeId>();
  const visit = (nodeId: TaskNodeId): void => {
    if (visited.has(nodeId)) {
      throw new Error(`tree traversal revisited node ${nodeId}`);
    }
    visited.add(nodeId);
    for (const child of getChildNodes(tree, nodeId)) {
      visit(child.id);
    }
  };
  visit(tree.rootNodeId);

  expect(visited.size).toBe(tree.nodes.length);
  expect([...visited].sort()).toEqual([...nodeIds].sort());
}

describe("task tree ordered parent properties", () => {
  it("preserves tree invariants for many deterministic parent-selector arrays", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 10_000 }), { minLength: 1, maxLength: 48 }),
        (selectors) => {
          const ports = createPorts(selectors.length);
          const { tree: initialTree } = createBaseTree(ports);
          let tree = initialTree;
          const expectedParentIds: (TaskNodeId | null)[] = [null];

          selectors.forEach((selector, index) => {
            const parentIndex = selector % tree.nodes.length;
            const parent = tree.nodes[parentIndex];
            if (parent === undefined) {
              throw new Error(`parent selector ${String(selector)} did not resolve to a node`);
            }
            const previousTree = tree;
            const previousSnapshot = structuredClone(tree);
            tree = appendTaskNode(tree, parent.id, implementationDefinition(index + 1), ports);
            expectedParentIds.push(parent.id);

            expect(previousTree).toEqual(previousSnapshot);
            expect(tree.nodes.slice(0, previousTree.nodes.length)).toEqual(previousTree.nodes);
            previousTree.nodes.forEach((node) => {
              expect(getTaskNode(tree, node.id)).toBe(node);
            });
          });

          assertTreeInvariants(tree, expectedParentIds);
        },
      ),
      { seed: 20260714, numRuns: 250 },
    );
  });

  it("keeps an earlier tree unchanged when appending a node", () => {
    const ports = createPorts(1);
    const { tree: initialTree } = createBaseTree(ports);
    const initialSnapshot = structuredClone(initialTree);
    const root = getTaskNode(initialTree, initialTree.rootNodeId);

    const appendedTree = appendTaskNode(initialTree, root.id, implementationDefinition(1), ports);

    expect(initialTree).toEqual(initialSnapshot);
    expect(initialTree.nodes).toHaveLength(1);
    expect(appendedTree).not.toBe(initialTree);
    expect(appendedTree.nodes).not.toBe(initialTree.nodes);
    expect(appendedTree.nodes[0]).toBe(root);
    expect(appendedTree.nodes[1]?.parentNodeId).toBe(root.id);
  });

  it("returns children in append order for each parent", () => {
    const ports = createPorts(5);
    const { tree: initialTree } = createBaseTree(ports);
    const root = getTaskNode(initialTree, initialTree.rootNodeId);

    const withFirst = appendTaskNode(initialTree, root.id, implementationDefinition(1), ports);
    const firstChild = withFirst.nodes[1];
    if (firstChild === undefined) {
      throw new Error("first child was not appended");
    }
    const withSecond = appendTaskNode(withFirst, root.id, implementationDefinition(2), ports);
    const secondChild = withSecond.nodes[2];
    if (secondChild === undefined) {
      throw new Error("second child was not appended");
    }
    const withThird = appendTaskNode(withSecond, root.id, implementationDefinition(3), ports);
    const thirdChild = withThird.nodes[3];
    if (thirdChild === undefined) {
      throw new Error("third child was not appended");
    }
    const withNested = appendTaskNode(withThird, firstChild.id, implementationDefinition(4), ports);
    const nestedChild = withNested.nodes[4];
    if (nestedChild === undefined) {
      throw new Error("nested child was not appended");
    }
    const finalTree = appendTaskNode(withNested, root.id, implementationDefinition(5), ports);
    const fourthChild = finalTree.nodes[5];
    if (fourthChild === undefined) {
      throw new Error("fourth child was not appended");
    }

    expect(getChildNodes(finalTree, root.id).map((node) => node.id)).toEqual([
      firstChild.id,
      secondChild.id,
      thirdChild.id,
      fourthChild.id,
    ]);
    expect(getChildNodes(finalTree, firstChild.id).map((node) => node.id)).toEqual([
      nestedChild.id,
    ]);
  });

  it("rejects duplicate tree, revision, and root IDs", () => {
    const repeatedId = makeUuid(0x5000);
    const ports: DomainPorts = {
      clock: new FixedClock(TEST_TIMESTAMP),
      ids: new SequenceIdGenerator([makeUuid(1), repeatedId, repeatedId, repeatedId]),
    };
    const repository = createRepository({ hostId: HOST_ID, root: REPOSITORY_ROOT }, ports);

    expectDomainError(
      () =>
        createTaskTree(
          {
            repository,
            baseCommit: BASE_COMMIT,
            goal: "reject collapsed identities",
            root: implementationDefinition(0),
          },
          ports,
        ),
      "duplicate_id",
    );
  });

  it("rejects a duplicate generated node ID without changing the tree", () => {
    const duplicateNodeId = makeUuid(4);
    const ports: DomainPorts = {
      clock: new FixedClock(TEST_TIMESTAMP),
      ids: new SequenceIdGenerator([
        makeUuid(1),
        makeUuid(2),
        makeUuid(3),
        duplicateNodeId,
        duplicateNodeId,
      ]),
    };
    const { tree } = createBaseTree(ports);
    const root = getTaskNode(tree, tree.rootNodeId);

    expectDomainError(
      () => appendTaskNode(tree, root.id, implementationDefinition(1), ports),
      "duplicate_id",
    );
    expect(tree.nodes).toEqual([root]);
  });

  it("rejects artifact inputs on a root node", () => {
    const ports = createPorts(0);
    const repository = createRepository(
      {
        hostId: HOST_ID,
        root: REPOSITORY_ROOT,
      },
      ports,
    );
    const rootInput = artifactInput(1, taskNodeId(makeUuid(0x3000)));

    expectInvalidArtifactInput(() =>
      createTaskTree(
        {
          repository,
          baseCommit: BASE_COMMIT,
          goal: "a root cannot consume artifacts",
          root: artifactDefinition(0, [rootInput]),
        },
        ports,
      ),
    );
  });

  it("accepts an ancestor artifact and rejects sibling and descendant sources", () => {
    const ports = createPorts(7);
    const { tree: initialTree } = createBaseTree(ports, artifactDefinition(0));
    const root = getTaskNode(initialTree, initialTree.rootNodeId);
    const withBranch = appendTaskNode(initialTree, root.id, artifactDefinition(1), ports);
    const branch = withBranch.nodes[1];
    if (branch === undefined) {
      throw new Error("branch was not appended");
    }
    const withSibling = appendTaskNode(withBranch, root.id, artifactDefinition(2), ports);
    const sibling = withSibling.nodes[2];
    if (sibling === undefined) {
      throw new Error("sibling was not appended");
    }
    if (
      root.outputContract.kind !== "artifact" ||
      branch.outputContract.kind !== "artifact" ||
      sibling.outputContract.kind !== "artifact"
    ) {
      throw new Error("artifact nodes did not declare artifact outputs");
    }
    const rootArtifactId = root.outputContract.artifactId;
    const branchArtifactId = branch.outputContract.artifactId;
    const siblingArtifactId = sibling.outputContract.artifactId;

    const acceptedInput = {
      artifactId: rootArtifactId,
      sourceNodeId: root.id,
    };
    const acceptedTree = appendTaskNode(
      withSibling,
      branch.id,
      artifactDefinition(3, [acceptedInput]),
      ports,
    );
    const acceptedNode = acceptedTree.nodes[3];
    if (acceptedNode === undefined) {
      throw new Error("ancestor input node was not appended");
    }
    expect(acceptedNode.inputs[0]?.sourceNodeId).toBe(root.id);
    expect(Reflect.set(acceptedInput, "sourceNodeId", sibling.id)).toBe(true);
    expect(acceptedNode.inputs[0]?.sourceNodeId).toBe(root.id);

    expectInvalidArtifactInput(() =>
      appendTaskNode(
        withSibling,
        branch.id,
        artifactDefinition(4, [
          {
            artifactId: siblingArtifactId,
            sourceNodeId: sibling.id,
          },
        ]),
        ports,
      ),
    );
    expectInvalidArtifactInput(() =>
      appendTaskNode(
        withSibling,
        root.id,
        artifactDefinition(5, [
          {
            artifactId: branchArtifactId,
            sourceNodeId: branch.id,
          },
        ]),
        ports,
      ),
    );
    expectInvalidArtifactInput(() =>
      appendTaskNode(
        withSibling,
        branch.id,
        artifactDefinition(6, [
          {
            artifactId: siblingArtifactId,
            sourceNodeId: root.id,
          },
        ]),
        ports,
      ),
    );
  });
});
