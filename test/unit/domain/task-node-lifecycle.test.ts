import {
  appendTaskNode,
  artifactId,
  contentHash,
  createRepository,
  createTaskTree,
  DomainError,
  evidenceId,
  getChildNodes,
  getTaskNode,
  gitSha,
  hostId,
  nonEmptyText,
  planRevisionId,
  repositoryRoot,
  transitionNodeInTree,
  transitionTaskNode,
  timestampFromEpochMilliseconds,
  type ArtifactOutcome,
  type CommitOutcome,
  type TaskNode,
  type TaskNodeBlocker,
  type TaskNodeDefinition,
  type TaskNodeState,
  type TaskNodeTransition,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { describe, expect, it } from "vitest";

type LifecycleStateName =
  | "planned"
  | "ready"
  | "active"
  | "blocked-from-ready"
  | "blocked-from-active"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";
type TransitionKind = TaskNodeTransition["kind"];

function deterministicUuid(counter: number): string {
  const suffix = counter.toString(16).padStart(12, "0");
  return `01890f00-0000-7000-8000-${suffix}`;
}

function expectDomainErrorCode(action: () => unknown, code: DomainError["code"]): void {
  try {
    action();
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError with code ${code}`);
}

function transitionFor(kind: TransitionKind, node: TaskNode): TaskNodeTransition {
  switch (kind) {
    case "mark_ready":
      return { kind: "mark_ready" };
    case "activate":
      return { kind: "activate" };
    case "block":
      return {
        kind: "block",
        blocker: {
          kind: "ci_failure",
          evidenceId: evidenceId(deterministicUuid(110)),
        },
      };
    case "unblock":
      return { kind: "unblock" };
    case "succeed":
      return {
        kind: "succeed",
        outcome: artifactOutcomeFor(node, 112),
      };
    case "fail":
      return {
        kind: "fail",
        evidenceId: evidenceId(deterministicUuid(113)),
      };
    case "cancel":
      return {
        kind: "cancel",
        evidenceId: evidenceId(deterministicUuid(114)),
      };
    case "supersede":
      return {
        kind: "supersede",
        planRevisionId: planRevisionId(deterministicUuid(115)),
      };
  }
}

function expectedResultKind(
  stateName: LifecycleStateName,
  transitionKind: TransitionKind,
): TaskNodeState["kind"] {
  switch (transitionKind) {
    case "mark_ready":
      return "ready";
    case "activate":
      return "active";
    case "block":
      return "blocked";
    case "unblock":
      return stateName === "blocked-from-ready" ? "ready" : "active";
    case "succeed":
      return "succeeded";
    case "fail":
      return "failed";
    case "cancel":
      return "cancelled";
    case "supersede":
      return "superseded";
  }
}

const timestamp1000 = timestampFromEpochMilliseconds(1_000);
const timestamp900 = timestampFromEpochMilliseconds(900);
const timestamp1100 = timestampFromEpochMilliseconds(1_100);
const timestamp1200 = timestampFromEpochMilliseconds(1_200);
const timestamp1300 = timestampFromEpochMilliseconds(1_300);
const timestamp1400 = timestampFromEpochMilliseconds(1_400);
const timestamp10000 = timestampFromEpochMilliseconds(10_000);
const timestamp1500 = timestampFromEpochMilliseconds(1_500);
const timestamp1600 = timestampFromEpochMilliseconds(1_600);
const timestamp1700 = timestampFromEpochMilliseconds(1_700);
const timestamp1800 = timestampFromEpochMilliseconds(1_800);
const timestamp1900 = timestampFromEpochMilliseconds(1_900);
const timestamp2000 = timestampFromEpochMilliseconds(2_000);
const timestamp1199 = timestampFromEpochMilliseconds(1_199);

const artifactDefinition = {
  mode: "plan",
  objective: "produce the planned artifact",
  acceptanceCriteria: ["the artifact satisfies the contract"],
  inputs: [],
  outputContract: { kind: "artifact", artifactType: "report" },
} satisfies TaskNodeDefinition;

const implementationDefinition = {
  mode: "implementation",
  objective: "implement the requested change",
  acceptanceCriteria: ["the implementation is complete"],
  inputs: [],
  outputContract: { kind: "implementation" },
} satisfies TaskNodeDefinition;

function artifactOutcomeFor(node: TaskNode, evidenceCounter: number): ArtifactOutcome {
  if (node.outputContract.kind !== "artifact") {
    throw new Error(`node ${node.id} does not declare an artifact output`);
  }
  return {
    kind: "artifact",
    artifactId: node.outputContract.artifactId,
    contentHash: contentHash("b".repeat(64)),
    artifactType: node.outputContract.artifactType,
    evidenceId: evidenceId(deterministicUuid(evidenceCounter)),
  };
}

const commitOutcome: CommitOutcome = {
  kind: "commit",
  commit: gitSha("c".repeat(40)),
  evidenceId: evidenceId(deterministicUuid(103)),
};

const lifecycleBlocker: TaskNodeBlocker = {
  kind: "ci_failure",
  evidenceId: evidenceId(deterministicUuid(104)),
};

const lifecyclePorts = {
  clock: new FixedClock(timestamp1000),
  ids: new SequenceIdGenerator(
    Array.from({ length: 128 }, (_, index) => deterministicUuid(index + 1)),
  ),
};
const lifecycleRepository = createRepository(
  {
    hostId: hostId(deterministicUuid(90)),
    root: repositoryRoot("/workspace/minions"),
  },
  lifecyclePorts,
);
const lifecycleTree = createTaskTree(
  {
    repository: lifecycleRepository,
    baseCommit: gitSha("d".repeat(40)),
    goal: "exercise task node lifecycle",
    root: artifactDefinition,
  },
  lifecyclePorts,
);
const planned = getTaskNode(lifecycleTree, lifecycleTree.rootNodeId);
const ready = transitionTaskNode(planned, { kind: "mark_ready" }, timestamp1100);
const active = transitionTaskNode(ready, { kind: "activate" }, timestamp1200);
const blockedFromReady = transitionTaskNode(
  ready,
  { kind: "block", blocker: lifecycleBlocker },
  timestamp1300,
);
const blockedFromActive = transitionTaskNode(
  active,
  { kind: "block", blocker: lifecycleBlocker },
  timestamp1300,
);
const succeeded = transitionTaskNode(
  active,
  { kind: "succeed", outcome: artifactOutcomeFor(active, 102) },
  timestamp1400,
);
const failed = transitionTaskNode(
  active,
  { kind: "fail", evidenceId: evidenceId(deterministicUuid(105)) },
  timestamp1400,
);
const cancelled = transitionTaskNode(
  planned,
  { kind: "cancel", evidenceId: evidenceId(deterministicUuid(106)) },
  timestamp1100,
);
const superseded = transitionTaskNode(
  planned,
  { kind: "supersede", planRevisionId: planRevisionId(deterministicUuid(107)) },
  timestamp1100,
);

const lifecycleSnapshots: readonly Readonly<{
  name: LifecycleStateName;
  node: TaskNode;
}>[] = [
  { name: "planned", node: planned },
  { name: "ready", node: ready },
  { name: "active", node: active },
  { name: "blocked-from-ready", node: blockedFromReady },
  { name: "blocked-from-active", node: blockedFromActive },
  { name: "succeeded", node: succeeded },
  { name: "failed", node: failed },
  { name: "cancelled", node: cancelled },
  { name: "superseded", node: superseded },
];

const transitionKinds: readonly TransitionKind[] = [
  "mark_ready",
  "activate",
  "block",
  "unblock",
  "succeed",
  "fail",
  "cancel",
  "supersede",
];

const legalTransitions: Readonly<Record<LifecycleStateName, readonly TransitionKind[]>> = {
  planned: ["mark_ready", "cancel", "supersede"],
  ready: ["activate", "block", "cancel", "supersede"],
  active: ["block", "succeed", "fail", "cancel"],
  "blocked-from-ready": ["unblock", "cancel", "supersede"],
  "blocked-from-active": ["unblock", "cancel"],
  succeeded: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

describe("task node lifecycle", () => {
  for (const snapshot of lifecycleSnapshots) {
    for (const transitionKind of transitionKinds) {
      const legal = legalTransitions[snapshot.name].includes(transitionKind);
      it(`${snapshot.name} ${transitionKind} transition is ${legal ? "legal" : "illegal"}`, () => {
        const transition = transitionFor(transitionKind, snapshot.node);
        const execute = (): TaskNode =>
          transitionTaskNode(snapshot.node, transition, timestamp10000);
        if (!legal) {
          expectDomainErrorCode(execute, "invalid_transition");
          return;
        }

        const transitioned = execute();
        expect(transitioned.state.kind).toBe(expectedResultKind(snapshot.name, transitionKind));
      });
    }
  }

  it("builds immutable snapshots for every lifecycle state", () => {
    expect(lifecycleSnapshots.map((snapshot) => snapshot.node.state.kind)).toEqual([
      "planned",
      "ready",
      "active",
      "blocked",
      "blocked",
      "succeeded",
      "failed",
      "cancelled",
      "superseded",
    ]);

    for (const snapshot of lifecycleSnapshots) {
      expect(Object.isFrozen(snapshot.node)).toBe(true);
      expect(Object.isFrozen(snapshot.node.state)).toBe(true);
      expect(Object.isFrozen(snapshot.node.acceptanceCriteria)).toBe(true);
      expect(Object.isFrozen(snapshot.node.inputs)).toBe(true);
      expect(Object.isFrozen(snapshot.node.outputContract)).toBe(true);
      if (snapshot.node.state.kind === "blocked") {
        expect(Object.isFrozen(snapshot.node.state.blocker)).toBe(true);
      }
      if (snapshot.node.state.kind === "succeeded") {
        expect(Object.isFrozen(snapshot.node.state.outcome)).toBe(true);
      }
    }

    const previousState = planned.state;
    const previousUpdatedAt = planned.updatedAt;
    const transitioned = transitionTaskNode(planned, { kind: "mark_ready" }, timestamp10000);

    expect(transitioned).not.toBe(planned);
    expect(planned.state).toBe(previousState);
    expect(planned.state.kind).toBe("planned");
    expect(planned.updatedAt).toBe(previousUpdatedAt);
    expect(Reflect.set(planned, "state", transitioned.state)).toBe(false);
    expect(Reflect.set(planned.state, "kind", "ready")).toBe(false);
    expect(planned.state.kind).toBe("planned");
  });

  it("resumes blocked nodes only to their captured prior state", () => {
    const resumedReady = transitionTaskNode(blockedFromReady, { kind: "unblock" }, timestamp10000);
    const resumedActive = transitionTaskNode(
      blockedFromActive,
      { kind: "unblock" },
      timestamp10000,
    );

    expect(resumedReady.state.kind).toBe("ready");
    expect(resumedActive.state.kind).toBe("active");
    if (blockedFromReady.state.kind !== "blocked") {
      throw new Error("ready blocker snapshot was not blocked");
    }
    if (blockedFromActive.state.kind !== "blocked") {
      throw new Error("active blocker snapshot was not blocked");
    }
    expect(blockedFromReady.state.kind).toBe("blocked");
    expect(blockedFromReady.state.resumeTo).toBe("ready");
    expect(blockedFromActive.state.kind).toBe("blocked");
    expect(blockedFromActive.state.resumeTo).toBe("active");
  });

  it("rejects backward timestamps and mismatched output contracts", () => {
    expectDomainErrorCode(
      () =>
        transitionTaskNode(
          active,
          { kind: "cancel", evidenceId: evidenceId(deterministicUuid(116)) },
          timestamp1199,
        ),
      "invalid_transition",
    );
    expectDomainErrorCode(
      () =>
        transitionNodeInTree(
          lifecycleTree,
          lifecycleTree.rootNodeId,
          { kind: "mark_ready" },
          timestamp900,
        ),
      "invalid_transition",
    );

    const artifactActive = transitionTaskNode(
      transitionTaskNode(planned, { kind: "mark_ready" }, timestamp1100),
      { kind: "activate" },
      timestamp1200,
    );
    expectDomainErrorCode(
      () =>
        transitionTaskNode(
          artifactActive,
          { kind: "succeed", outcome: commitOutcome },
          timestamp1400,
        ),
      "invalid_outcome",
    );
    const validArtifactOutcome = artifactOutcomeFor(artifactActive, 119);
    expectDomainErrorCode(
      () =>
        transitionTaskNode(
          artifactActive,
          {
            kind: "succeed",
            outcome: {
              ...validArtifactOutcome,
              artifactId: artifactId(deterministicUuid(120)),
            },
          },
          timestamp1400,
        ),
      "invalid_outcome",
    );
    expectDomainErrorCode(
      () =>
        transitionTaskNode(
          artifactActive,
          {
            kind: "succeed",
            outcome: {
              ...validArtifactOutcome,
              artifactType: nonEmptyText("plan", "artifact type"),
            },
          },
          timestamp1400,
        ),
      "invalid_outcome",
    );

    const implementationPorts = {
      clock: new FixedClock(timestamp1000),
      ids: new SequenceIdGenerator(
        Array.from({ length: 16 }, (_, index) => deterministicUuid(index + 200)),
      ),
    };
    const implementationRepository = createRepository(
      {
        hostId: hostId(deterministicUuid(180)),
        root: repositoryRoot("/workspace/minions-implementation"),
      },
      implementationPorts,
    );
    const implementationTree = createTaskTree(
      {
        repository: implementationRepository,
        baseCommit: gitSha("e".repeat(40)),
        goal: "exercise implementation outcome validation",
        root: implementationDefinition,
      },
      implementationPorts,
    );
    const implementationPlanned = getTaskNode(implementationTree, implementationTree.rootNodeId);
    const implementationActive = transitionTaskNode(
      transitionTaskNode(implementationPlanned, { kind: "mark_ready" }, timestamp1100),
      { kind: "activate" },
      timestamp1200,
    );
    expectDomainErrorCode(
      () =>
        transitionTaskNode(
          implementationActive,
          { kind: "succeed", outcome: artifactOutcomeFor(artifactActive, 117) },
          timestamp1400,
        ),
      "invalid_outcome",
    );
    const committed = transitionTaskNode(
      implementationActive,
      { kind: "succeed", outcome: commitOutcome },
      timestamp1400,
    );
    expect(committed.state).toEqual({ kind: "succeeded", outcome: commitOutcome });

    const noChangeOutcome = {
      kind: "no_change",
      revision: gitSha("0123456789abcdef0123456789abcdef01234567"),
      evidenceId: evidenceId(deterministicUuid(121)),
      explanation: nonEmptyText("the requested state already holds", "no-change explanation"),
    } as const;
    const unchanged = transitionTaskNode(
      implementationActive,
      { kind: "succeed", outcome: noChangeOutcome },
      timestamp1400,
    );
    expect(unchanged.state).toEqual({ kind: "succeeded", outcome: noChangeOutcome });
  });

  it("fails closed for unsupported runtime transition payloads", () => {
    expectDomainErrorCode(
      () =>
        Reflect.apply(transitionTaskNode, undefined, [
          active,
          { kind: "unexpected" },
          timestamp1400,
        ]),
      "invalid_transition",
    );
    expectDomainErrorCode(
      () =>
        Reflect.apply(transitionTaskNode, undefined, [
          active,
          { kind: "succeed", outcome: { kind: "unexpected" } },
          timestamp1400,
        ]),
      "invalid_outcome",
    );
    expectDomainErrorCode(
      () =>
        Reflect.apply(transitionTaskNode, undefined, [
          ready,
          {
            kind: "block",
            blocker: {
              kind: "unexpected",
              evidenceId: evidenceId(deterministicUuid(122)),
            },
          },
          timestamp1400,
        ]),
      "invalid_value",
    );
  });

  it("blocks only started descendants when an active parent fails", () => {
    const treePorts = {
      clock: new FixedClock(timestamp1000),
      ids: new SequenceIdGenerator(
        Array.from({ length: 64 }, (_, index) => deterministicUuid(index + 300)),
      ),
    };
    const repository = createRepository(
      {
        hostId: hostId(deterministicUuid(280)),
        root: repositoryRoot("/workspace/minions-tree"),
      },
      treePorts,
    );
    let tree = createTaskTree(
      {
        repository,
        baseCommit: gitSha("f".repeat(40)),
        goal: "exercise failed parent propagation",
        root: artifactDefinition,
      },
      treePorts,
    );
    const rootNodeId = tree.rootNodeId;

    tree = appendTaskNode(tree, rootNodeId, artifactDefinition, treePorts);
    const failedParent = getChildNodes(tree, rootNodeId)[0];
    if (failedParent === undefined) {
      throw new Error("failed parent was not appended");
    }

    tree = appendTaskNode(tree, rootNodeId, artifactDefinition, treePorts);
    const successfulSibling = getChildNodes(tree, rootNodeId)[1];
    if (successfulSibling === undefined) {
      throw new Error("successful sibling was not appended");
    }

    tree = appendTaskNode(tree, failedParent.id, artifactDefinition, treePorts);
    const readyDescendant = getChildNodes(tree, failedParent.id)[0];
    if (readyDescendant === undefined) {
      throw new Error("ready descendant was not appended");
    }

    tree = appendTaskNode(tree, failedParent.id, artifactDefinition, treePorts);
    const activeDescendant = getChildNodes(tree, failedParent.id)[1];
    if (activeDescendant === undefined) {
      throw new Error("active descendant was not appended");
    }

    tree = appendTaskNode(tree, failedParent.id, artifactDefinition, treePorts);
    const plannedDescendant = getChildNodes(tree, failedParent.id)[2];
    if (plannedDescendant === undefined) {
      throw new Error("planned descendant was not appended");
    }
    tree = appendTaskNode(tree, failedParent.id, artifactDefinition, treePorts);
    const alreadyBlockedDescendant = getChildNodes(tree, failedParent.id)[3];
    if (alreadyBlockedDescendant === undefined) {
      throw new Error("already-blocked descendant was not appended");
    }

    tree = transitionNodeInTree(tree, failedParent.id, { kind: "mark_ready" }, timestamp1100);
    tree = transitionNodeInTree(tree, failedParent.id, { kind: "activate" }, timestamp1200);
    tree = transitionNodeInTree(tree, successfulSibling.id, { kind: "mark_ready" }, timestamp1300);
    tree = transitionNodeInTree(tree, successfulSibling.id, { kind: "activate" }, timestamp1400);
    tree = transitionNodeInTree(
      tree,
      successfulSibling.id,
      { kind: "succeed", outcome: artifactOutcomeFor(successfulSibling, 118) },
      timestamp1500,
    );
    tree = transitionNodeInTree(tree, readyDescendant.id, { kind: "mark_ready" }, timestamp1600);
    tree = transitionNodeInTree(tree, activeDescendant.id, { kind: "mark_ready" }, timestamp1700);
    tree = transitionNodeInTree(tree, activeDescendant.id, { kind: "activate" }, timestamp1800);
    tree = transitionNodeInTree(
      tree,
      alreadyBlockedDescendant.id,
      { kind: "mark_ready" },
      timestamp1800,
    );
    tree = transitionNodeInTree(
      tree,
      alreadyBlockedDescendant.id,
      {
        kind: "block",
        blocker: {
          kind: "quota",
          evidenceId: evidenceId(deterministicUuid(381)),
        },
      },
      timestamp1900,
    );

    const successfulSiblingBeforeFailure = getTaskNode(tree, successfulSibling.id);
    const plannedDescendantBeforeFailure = getTaskNode(tree, plannedDescendant.id);
    const alreadyBlockedDescendantBeforeFailure = getTaskNode(tree, alreadyBlockedDescendant.id);
    const nodeIdsBeforeFailure = tree.nodes.map((node) => node.id);
    const nodeCountBeforeFailure = tree.nodes.length;
    const failureEvidenceId = evidenceId(deterministicUuid(380));

    const failedTree = transitionNodeInTree(
      tree,
      failedParent.id,
      { kind: "fail", evidenceId: failureEvidenceId },
      timestamp2000,
    );

    expect(failedTree.nodes).toHaveLength(nodeCountBeforeFailure);
    expect(failedTree.nodes.map((node) => node.id)).toEqual(nodeIdsBeforeFailure);
    expect(getTaskNode(failedTree, successfulSibling.id)).toEqual(successfulSiblingBeforeFailure);
    expect(getTaskNode(failedTree, plannedDescendant.id)).toBe(plannedDescendantBeforeFailure);

    const failedParentAfterFailure = getTaskNode(failedTree, failedParent.id);
    expect(failedParentAfterFailure.state).toEqual({
      kind: "failed",
      evidenceId: failureEvidenceId,
    });

    const readyDescendantAfterFailure = getTaskNode(failedTree, readyDescendant.id);
    if (readyDescendantAfterFailure.state.kind !== "blocked") {
      throw new Error("ready descendant was not blocked");
    }
    expect(readyDescendantAfterFailure.state.resumeTo).toBe("ready");
    if (readyDescendantAfterFailure.state.blocker.kind !== "parent") {
      throw new Error("ready descendant did not receive a parent blocker");
    }
    expect(readyDescendantAfterFailure.state.blocker.parentNodeId).toBe(failedParent.id);
    expect(readyDescendantAfterFailure.state.blocker.evidenceId).toBe(failureEvidenceId);

    const activeDescendantAfterFailure = getTaskNode(failedTree, activeDescendant.id);
    if (activeDescendantAfterFailure.state.kind !== "blocked") {
      throw new Error("active descendant was not blocked");
    }
    expect(activeDescendantAfterFailure.state.resumeTo).toBe("active");
    if (activeDescendantAfterFailure.state.blocker.kind !== "parent") {
      throw new Error("active descendant did not receive a parent blocker");
    }
    expect(activeDescendantAfterFailure.state.blocker.parentNodeId).toBe(failedParent.id);
    expect(activeDescendantAfterFailure.state.blocker.evidenceId).toBe(failureEvidenceId);
    expectDomainErrorCode(
      () =>
        transitionNodeInTree(failedTree, readyDescendant.id, { kind: "unblock" }, timestamp10000),
      "invalid_transition",
    );
    expectDomainErrorCode(
      () =>
        transitionNodeInTree(failedTree, activeDescendant.id, { kind: "unblock" }, timestamp10000),
      "invalid_transition",
    );
    expect(getTaskNode(failedTree, alreadyBlockedDescendant.id)).toBe(
      alreadyBlockedDescendantBeforeFailure,
    );
    expectDomainErrorCode(
      () =>
        transitionNodeInTree(
          failedTree,
          alreadyBlockedDescendant.id,
          { kind: "unblock" },
          timestamp10000,
        ),
      "invalid_transition",
    );

    const plannedDescendantAfterFailure = getTaskNode(failedTree, plannedDescendant.id);
    expect(plannedDescendantAfterFailure.state.kind).toBe("planned");
    expect(plannedDescendantAfterFailure).toBe(plannedDescendantBeforeFailure);
    expectDomainErrorCode(
      () =>
        transitionNodeInTree(
          failedTree,
          plannedDescendant.id,
          { kind: "mark_ready" },
          timestamp10000,
        ),
      "invalid_transition",
    );

    const successfulSiblingAfterFailure = getTaskNode(failedTree, successfulSibling.id);
    expect(successfulSiblingAfterFailure.state.kind).toBe("succeeded");
    expect(successfulSiblingAfterFailure).toBe(successfulSiblingBeforeFailure);
  });
});
