import {
  DomainError,
  artifactId,
  attemptId,
  contentHash,
  createAttempt,
  createRepository,
  createTaskTree,
  evidenceId,
  getTaskNode,
  gitSha,
  hostId,
  nonEmptyText,
  planRevisionId,
  repositoryId,
  repositoryRoot,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  transitionNodeInTree,
  type ArtifactInput,
  type DomainErrorCode,
  type TaskNodeDefinition,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { describe, expect, it } from "vitest";

function deterministicUuid(counter: number): string {
  return `01890f00-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`;
}

function expectDomainError(action: () => unknown, code: DomainErrorCode): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(DomainError);
  if (thrown instanceof DomainError) {
    expect(thrown.code).toBe(code);
  }
}

describe("domain value-object boundaries", () => {
  it("rejects wrong-version, uppercase, and malformed UUIDv7 IDs", () => {
    const invalidValues = [
      "01890f00-0000-6000-8000-000000000001",
      "01890F00-0000-7000-8000-ABCDEFABCDEF",
      "01890f00-0000-7000-8000-00000000001",
      "not-a-uuid",
    ];
    const constructors = [
      { name: "artifact ID", parse: artifactId },
      { name: "attempt ID", parse: attemptId },
      { name: "evidence ID", parse: evidenceId },
      { name: "host ID", parse: hostId },
      { name: "plan revision ID", parse: planRevisionId },
      { name: "repository ID", parse: repositoryId },
      { name: "task node ID", parse: taskNodeId },
      { name: "task tree ID", parse: taskTreeId },
    ];

    for (const constructor of constructors) {
      for (const value of invalidValues) {
        expectDomainError(() => constructor.parse(value), "invalid_value");
      }
    }
  });

  it("accepts lowercase 40- and 64-character Git SHAs and rejects other forms", () => {
    const sha40 = "a".repeat(40);
    const sha64 = "b".repeat(64);

    expect(gitSha(sha40)).toBe(sha40);
    expect(gitSha(sha64)).toBe(sha64);

    for (const invalidSha of [
      "A".repeat(40),
      "a".repeat(39),
      "a".repeat(41),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(40),
    ]) {
      expectDomainError(() => gitSha(invalidSha), "invalid_value");
    }
  });

  it("accepts lowercase 64-character content hashes and rejects other forms", () => {
    const validHash = "c".repeat(64);

    expect(contentHash(validHash)).toBe(validHash);

    for (const invalidHash of ["C".repeat(64), "c".repeat(63), "c".repeat(65), "g".repeat(64)]) {
      expectDomainError(() => contentHash(invalidHash), "invalid_value");
    }
  });

  it("rejects negative, fractional, and unsafe timestamps and whitespace-only text", () => {
    expect(timestampFromEpochMilliseconds(0)).toBe(0);
    expect(timestampFromEpochMilliseconds(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);

    for (const invalidTimestamp of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectDomainError(() => timestampFromEpochMilliseconds(invalidTimestamp), "invalid_value");
    }

    expect(nonEmptyText("kept exactly", "objective")).toBe("kept exactly");
    for (const invalidText of ["", " ", "\t\n"]) {
      expectDomainError(() => nonEmptyText(invalidText, "objective"), "invalid_value");
    }
  });
});

describe("aggregate factory boundaries", () => {
  it("consumes deterministic ports, freezes roots, preserves bindings, and copies definition arrays", () => {
    const timestamp = timestampFromEpochMilliseconds(1_700_000_000_000);
    const repositoryIdentifier = repositoryId(deterministicUuid(1));
    const treeIdentifier = taskTreeId(deterministicUuid(2));
    const revisionIdentifier = planRevisionId(deterministicUuid(3));
    const rootNodeIdentifier = taskNodeId(deterministicUuid(4));
    const rootArtifactIdentifier = artifactId(deterministicUuid(5));
    const attemptIdentifier = attemptId(deterministicUuid(6));
    const repositoryHost = hostId(deterministicUuid(20));
    const repositoryPath = repositoryRoot("/workspaces/minions");
    const baseCommit = gitSha("d".repeat(40));
    const rootAcceptanceCriteria = ["produce a report"];
    const rootInputs: ArtifactInput[] = [];
    const rootDefinition: TaskNodeDefinition = {
      mode: "research",
      objective: "inspect the repository",
      acceptanceCriteria: rootAcceptanceCriteria,
      inputs: rootInputs,
      outputContract: { kind: "artifact", artifactType: "report" },
    };
    const ports = {
      clock: new FixedClock(timestamp),
      ids: new SequenceIdGenerator([
        deterministicUuid(1),
        deterministicUuid(2),
        deterministicUuid(3),
        deterministicUuid(4),
        deterministicUuid(5),
        deterministicUuid(6),
      ]),
    };

    const repository = createRepository({ hostId: repositoryHost, root: repositoryPath }, ports);
    const tree = createTaskTree(
      {
        repository,
        baseCommit,
        goal: "understand the domain",
        root: rootDefinition,
      },
      ports,
    );
    const root = getTaskNode(tree, tree.rootNodeId);

    expect(repository.id).toBe(repositoryIdentifier);
    expect(repository.hostId).toBe(repositoryHost);
    expect(repository.root).toBe(repositoryPath);
    expect(repository.registeredAt).toBe(timestamp);
    expect(Object.isFrozen(repository)).toBe(true);

    expect(tree.id).toBe(treeIdentifier);
    expect(tree.activePlanRevisionId).toBe(revisionIdentifier);
    expect(tree.rootNodeId).toBe(rootNodeIdentifier);
    expect(tree.repositoryId).toBe(repository.id);
    expect(tree.hostId).toBe(repository.hostId);
    expect(tree.baseCommit).toBe(baseCommit);
    expect(tree.createdAt).toBe(timestamp);
    expect(tree.updatedAt).toBe(timestamp);
    expect(Object.isFrozen(tree)).toBe(true);
    expect(Object.isFrozen(tree.nodes)).toBe(true);

    expect(root.id).toBe(rootNodeIdentifier);
    expect(root.treeId).toBe(tree.id);
    expect(root.repositoryId).toBe(repository.id);
    expect(root.hostId).toBe(repository.hostId);
    expect(root.parentNodeId).toBeNull();
    expect(root.createdAt).toBe(timestamp);
    expect(root.updatedAt).toBe(timestamp);
    expect(root.acceptanceCriteria).toEqual(["produce a report"]);
    expect(root.inputs).toEqual([]);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.acceptanceCriteria)).toBe(true);
    expect(Object.isFrozen(root.inputs)).toBe(true);
    if (root.outputContract.kind !== "artifact") {
      throw new Error("research root did not declare an artifact output");
    }
    expect(root.outputContract.artifactId).toBe(rootArtifactIdentifier);
    expect(root.outputContract.artifactType).toBe("report");

    rootAcceptanceCriteria[0] = "mutated after creation";
    rootAcceptanceCriteria.push("another criterion");
    rootInputs.push({
      artifactId: artifactId(deterministicUuid(21)),
      sourceNodeId: root.id,
    });

    expect(root.acceptanceCriteria).toEqual(["produce a report"]);
    expect(root.inputs).toEqual([]);

    const readyTree = transitionNodeInTree(
      tree,
      tree.rootNodeId,
      { kind: "mark_ready" },
      timestamp,
    );
    const activeTree = transitionNodeInTree(
      readyTree,
      readyTree.rootNodeId,
      { kind: "activate" },
      timestamp,
    );
    const activeRoot = getTaskNode(activeTree, activeTree.rootNodeId);
    const attempt = createAttempt({ node: activeRoot, ordinal: 1 }, ports);

    expect(attempt.id).toBe(attemptIdentifier);
    expect(attempt.nodeId).toBe(activeRoot.id);
    expect(attempt.treeId).toBe(tree.id);
    expect(attempt.repositoryId).toBe(repository.id);
    expect(attempt.hostId).toBe(repository.hostId);
    expect(attempt.startedAt).toBe(timestamp);
    expect(Object.isFrozen(attempt)).toBe(true);

    const succeededTree = transitionNodeInTree(
      activeTree,
      activeTree.rootNodeId,
      {
        kind: "succeed",
        outcome: {
          kind: "artifact",
          artifactId: root.outputContract.artifactId,
          contentHash: contentHash("e".repeat(64)),
          artifactType: root.outputContract.artifactType,
          evidenceId: evidenceId(deterministicUuid(23)),
        },
      },
      timestamp,
    );
    expect(getTaskNode(succeededTree, succeededTree.rootNodeId).state).toEqual({
      kind: "succeeded",
      outcome: {
        kind: "artifact",
        artifactId: root.outputContract.artifactId,
        contentHash: contentHash("e".repeat(64)),
        artifactType: root.outputContract.artifactType,
        evidenceId: evidenceId(deterministicUuid(23)),
      },
    });
  });

  it("accepts attempts only for active nodes and positive safe ordinals", () => {
    const timestamp = timestampFromEpochMilliseconds(1_700_000_000_001);
    const repository = createRepository(
      {
        hostId: hostId(deterministicUuid(30)),
        root: repositoryRoot("/workspaces/attempts"),
      },
      {
        clock: new FixedClock(timestamp),
        ids: new SequenceIdGenerator([
          deterministicUuid(31),
          deterministicUuid(32),
          deterministicUuid(33),
          deterministicUuid(34),
        ]),
      },
    );
    const ports = {
      clock: new FixedClock(timestamp),
      ids: new SequenceIdGenerator([deterministicUuid(34)]),
    };
    const tree = createTaskTree(
      {
        repository,
        baseCommit: gitSha("f".repeat(40)),
        goal: "exercise attempt boundaries",
        root: {
          mode: "implementation",
          objective: "make the change",
          acceptanceCriteria: ["the change is complete"],
          inputs: [],
          outputContract: { kind: "implementation" },
        },
      },
      {
        clock: new FixedClock(timestamp),
        ids: new SequenceIdGenerator([
          deterministicUuid(35),
          deterministicUuid(36),
          deterministicUuid(37),
        ]),
      },
    );
    const plannedNode = getTaskNode(tree, tree.rootNodeId);

    expectDomainError(
      () => createAttempt({ node: plannedNode, ordinal: 1 }, ports),
      "invalid_transition",
    );

    const readyTree = transitionNodeInTree(
      tree,
      tree.rootNodeId,
      { kind: "mark_ready" },
      timestamp,
    );
    const activeTree = transitionNodeInTree(
      readyTree,
      readyTree.rootNodeId,
      { kind: "activate" },
      timestamp,
    );
    const activeNode = getTaskNode(activeTree, activeTree.rootNodeId);

    for (const ordinal of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectDomainError(() => createAttempt({ node: activeNode, ordinal }, ports), "invalid_value");
    }

    const attempt = createAttempt(
      {
        node: activeNode,
        ordinal: Number.MAX_SAFE_INTEGER,
      },
      ports,
    );
    expect(attempt.id).toBe(attemptId(deterministicUuid(34)));
    expect(attempt.ordinal).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("rejects backward aggregate creation and reused context IDs", () => {
    const earlier = timestampFromEpochMilliseconds(1_000);
    const later = timestampFromEpochMilliseconds(2_000);
    const lateRepository = createRepository(
      {
        hostId: hostId(deterministicUuid(50)),
        root: repositoryRoot("/workspaces/late-repository"),
      },
      {
        clock: new FixedClock(later),
        ids: new SequenceIdGenerator([deterministicUuid(51)]),
      },
    );
    expectDomainError(
      () =>
        createTaskTree(
          {
            repository: lateRepository,
            baseCommit: gitSha("a".repeat(40)),
            goal: "reject a tree before registration",
            root: {
              mode: "implementation",
              objective: "reject backward creation",
              acceptanceCriteria: ["creation fails closed"],
              inputs: [],
              outputContract: { kind: "implementation" },
            },
          },
          {
            clock: new FixedClock(earlier),
            ids: new SequenceIdGenerator([
              deterministicUuid(52),
              deterministicUuid(53),
              deterministicUuid(54),
            ]),
          },
        ),
      "invalid_tree",
    );

    const repository = createRepository(
      {
        hostId: hostId(deterministicUuid(60)),
        root: repositoryRoot("/workspaces/temporal-attempt"),
      },
      {
        clock: new FixedClock(earlier),
        ids: new SequenceIdGenerator([deterministicUuid(61)]),
      },
    );
    const tree = createTaskTree(
      {
        repository,
        baseCommit: gitSha("b".repeat(40)),
        goal: "reject an attempt before activation",
        root: {
          mode: "implementation",
          objective: "validate attempt time",
          acceptanceCriteria: ["attempt time is monotonic"],
          inputs: [],
          outputContract: { kind: "implementation" },
        },
      },
      {
        clock: new FixedClock(earlier),
        ids: new SequenceIdGenerator([
          deterministicUuid(62),
          deterministicUuid(63),
          deterministicUuid(64),
        ]),
      },
    );
    const readyTree = transitionNodeInTree(
      tree,
      tree.rootNodeId,
      { kind: "mark_ready" },
      timestampFromEpochMilliseconds(1_100),
    );
    const activeTree = transitionNodeInTree(
      readyTree,
      readyTree.rootNodeId,
      { kind: "activate" },
      timestampFromEpochMilliseconds(1_200),
    );
    const activeNode = getTaskNode(activeTree, activeTree.rootNodeId);

    expectDomainError(
      () =>
        createAttempt(
          { node: activeNode, ordinal: 1 },
          {
            clock: new FixedClock(timestampFromEpochMilliseconds(1_199)),
            ids: new SequenceIdGenerator([deterministicUuid(65)]),
          },
        ),
      "invalid_transition",
    );
    expectDomainError(
      () =>
        createAttempt(
          { node: activeNode, ordinal: 1 },
          {
            clock: new FixedClock(timestampFromEpochMilliseconds(1_200)),
            ids: new SequenceIdGenerator([deterministicUuid(64)]),
          },
        ),
      "duplicate_id",
    );

    const duplicateHostId = deterministicUuid(70);
    expectDomainError(
      () =>
        createRepository(
          {
            hostId: hostId(duplicateHostId),
            root: repositoryRoot("/workspaces/duplicate-host"),
          },
          {
            clock: new FixedClock(earlier),
            ids: new SequenceIdGenerator([duplicateHostId]),
          },
        ),
      "duplicate_id",
    );
  });
});

describe("SequenceIdGenerator", () => {
  it("copies caller input, preserves order, and fails on exhaustion", () => {
    const first = deterministicUuid(40);
    const second = deterministicUuid(41);
    const callerInput = [first, second];
    const generator = new SequenceIdGenerator(callerInput);

    callerInput.reverse();
    callerInput.push(deterministicUuid(42));

    expect(generator.nextId()).toBe(first);
    expect(generator.nextId()).toBe(second);
    expect(() => generator.nextId()).toThrow("SequenceIdGenerator exhausted: no IDs remain");
    expect(() => generator.nextId()).toThrow("SequenceIdGenerator exhausted: no IDs remain");
  });
});
