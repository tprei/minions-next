import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ManagedSqliteDatabase, SqliteTransaction } from "@minions/adapters";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NEXT_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

const CANONICAL_IDS = {
  hostId: "01900000-0000-7000-8000-000000000001",
  repositoryId: "01900000-0000-7000-8000-000000000002",
  treeId: "01900000-0000-7000-8000-000000000003",
  planRevisionId: "01900000-0000-7000-8000-000000000004",
  rootNodeId: "01900000-0000-7000-8000-000000000005",
} as const;

const EXTRA_IDS = {
  treeId: "01900000-0000-7000-8000-000000000010",
  planRevisionId: "01900000-0000-7000-8000-000000000011",
  rootNodeId: "01900000-0000-7000-8000-000000000012",
  childNodeId: "01900000-0000-7000-8000-000000000013",
  parentNodeId: "01900000-0000-7000-8000-000000000014",
  sourceNodeId: "01900000-0000-7000-8000-000000000015",
  consumerNodeId: "01900000-0000-7000-8000-000000000016",
  wrongSourceNodeId: "01900000-0000-7000-8000-000000000017",
  artifactId: "01900000-0000-7000-8000-000000000018",
} as const;

const INVALID_IDS = {
  secondRootNodeId: "01900000-0000-7000-8000-000000000020",
  parentNodeId: "01900000-0000-7000-8000-000000000021",
  childNodeId: "01900000-0000-7000-8000-000000000022",
  siblingNodeId: "01900000-0000-7000-8000-000000000023",
  artifactOutputNodeId: "01900000-0000-7000-8000-000000000024",
  implementationOutputNodeId: "01900000-0000-7000-8000-000000000025",
  succeededNodeId: "01900000-0000-7000-8000-000000000026",
  failedNodeId: "01900000-0000-7000-8000-000000000027",
  blockedNodeId: "01900000-0000-7000-8000-000000000028",
  artifactOwnerNodeId: "01900000-0000-7000-8000-000000000029",
  artifactConsumerNodeId: "01900000-0000-7000-8000-000000000030",
  artifactWrongSourceNodeId: "01900000-0000-7000-8000-000000000031",
  artifactId: "01900000-0000-7000-8000-000000000032",
  mismatchedRepositoryNodeId: "01900000-0000-7000-8000-000000000033",
  mismatchedHostNodeId: "01900000-0000-7000-8000-000000000034",
} as const;
const EXECUTION_ARTIFACT_ID = "01900000-0000-7000-8000-000000000035";
const EXECUTION_EVIDENCE_ID = "01900000-0000-7000-8000-000000000036";
const EXECUTION_CONTENT_DIGEST = "e".repeat(64);
const ACTIVE_ATTEMPT_ID = "01900000-0000-7000-8000-000000000037";
const TERMINAL_ATTEMPT_ID = "01900000-0000-7000-8000-000000000038";
const TERMINAL_EVIDENCE_ID = "01900000-0000-7000-8000-000000000039";
const GATE_ID = "01900000-0000-7000-8000-00000000003a";
const VALID_ARTIFACT_ID = "01900000-0000-7000-8000-00000000003b";
const RESTACK_CHILD_ID = "01900000-0000-7000-8000-00000000003c";
const RESTACK_ID = "01900000-0000-7000-8000-00000000003d";
const COMMAND_ID = "01900000-0000-7000-8000-00000000003e";
const JOURNAL_EVENT_ID = "01900000-0000-7000-8000-00000000003f";
const MISMATCHED_PLAN_REVISION_ID = "01900000-0000-7000-8000-000000000040";
const MISMATCHED_PLAN_ATTEMPT_ID = "01900000-0000-7000-8000-000000000041";
const DETACHED_ARTIFACT_ID = "01900000-0000-7000-8000-000000000042";
const SECOND_COMMAND_ID = "01900000-0000-7000-8000-000000000043";
const SECOND_JOURNAL_EVENT_ID = "01900000-0000-7000-8000-000000000044";
const APPLIED_OPERATION_ID = "01900000-0000-7000-8000-000000000045";
const LEGACY_OPERATION_ID = "01900000-0000-7000-8000-000000000046";

type AggregateIds = Readonly<{
  hostId: string;
  repositoryId: string;
  treeId: string;
  planRevisionId: string;
  rootNodeId: string;
}>;

type NodeRecord = Readonly<{
  id: string;
  treeId: string;
  repositoryId: string;
  hostId: string;
  parentNodeId: string | null;
  planRevisionId: string;
  mode: string;
  objective: string;
  outputKind: string;
  outputArtifactId: string | null;
  outputArtifactType: string | null;
  stateKind: string;
  resumeStateKind: string | null;
  blockerKind: string | null;
  blockerEvidenceId: string | null;
  blockerParentNodeId: string | null;
  blockerHostId: string | null;
  outcomeKind: string | null;
  outcomeArtifactId: string | null;
  outcomeContentHash: string | null;
  outcomeArtifactType: string | null;
  outcomeCommit: string | null;
  outcomeEvidenceId: string | null;
  outcomeExplanation: string | null;
  terminalEvidenceId: string | null;
  supersededPlanRevisionId: string | null;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}>;

const CLOCK = new FixedClock(NOW);
let temporaryDatabase: TemporarySqliteDatabase | undefined;

function database(): ManagedSqliteDatabase {
  if (temporaryDatabase === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return temporaryDatabase.database;
}

function insertRepository(transaction: SqliteTransaction, ids: AggregateIds): void {
  transaction.run(
    `INSERT INTO repositories (
      id, host_id, root_path, version, registered_at_ms, archived_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [ids.repositoryId, ids.hostId, "/workspace/minions", 0, NOW, null],
  );
}

function insertTree(
  transaction: SqliteTransaction,
  ids: AggregateIds,
  rootNodeId: string = ids.rootNodeId,
): void {
  transaction.run(
    `INSERT INTO trees (
      id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
      root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ids.treeId,
      ids.repositoryId,
      ids.hostId,
      BASE_COMMIT,
      "deterministic host tree",
      ids.planRevisionId,
      rootNodeId,
      0,
      NOW,
      NOW,
      null,
    ],
  );
}

function insertPlanRevision(transaction: SqliteTransaction, ids: AggregateIds): void {
  transaction.run(
    `INSERT INTO plan_revisions (
      id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
      approved_at_ms, superseded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ids.planRevisionId, ids.treeId, 1, "deterministic host tree", "draft", 0, NOW, null, null],
  );
}

function implementationNode(
  ids: AggregateIds,
  id: string,
  parentNodeId: string | null,
  objective: string,
): NodeRecord {
  return {
    id,
    treeId: ids.treeId,
    repositoryId: ids.repositoryId,
    hostId: ids.hostId,
    parentNodeId,
    planRevisionId: ids.planRevisionId,
    mode: "implementation",
    objective,
    outputKind: "implementation",
    outputArtifactId: null,
    outputArtifactType: null,
    stateKind: "planned",
    resumeStateKind: null,
    blockerKind: null,
    blockerEvidenceId: null,
    blockerParentNodeId: null,
    blockerHostId: null,
    outcomeKind: null,
    outcomeArtifactId: null,
    outcomeContentHash: null,
    outcomeArtifactType: null,
    outcomeCommit: null,
    outcomeEvidenceId: null,
    outcomeExplanation: null,
    terminalEvidenceId: null,
    supersededPlanRevisionId: null,
    version: 0,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function artifactNode(
  ids: AggregateIds,
  id: string,
  parentNodeId: string | null,
  artifactId: string,
): NodeRecord {
  return {
    ...implementationNode(ids, id, parentNodeId, "artifact-producing node"),
    mode: "explore",
    outputKind: "artifact",
    outputArtifactId: artifactId,
    outputArtifactType: "text/plain",
  };
}

function nodeWith(node: NodeRecord, updates: Partial<NodeRecord>): NodeRecord {
  return { ...node, ...updates };
}

function insertNode(transaction: SqliteTransaction, node: NodeRecord): void {
  transaction.run(
    `INSERT INTO nodes (
      id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
      mode, objective, output_kind, output_artifact_id, output_artifact_type,
      state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
      blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
      outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
      outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
      version, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      node.id,
      node.treeId,
      node.repositoryId,
      node.hostId,
      node.parentNodeId,
      node.planRevisionId,
      node.mode,
      node.objective,
      node.outputKind,
      node.outputArtifactId,
      node.outputArtifactType,
      node.stateKind,
      node.resumeStateKind,
      node.blockerKind,
      node.blockerEvidenceId,
      node.blockerParentNodeId,
      node.blockerHostId,
      node.outcomeKind,
      node.outcomeArtifactId,
      node.outcomeContentHash,
      node.outcomeArtifactType,
      node.outcomeCommit,
      node.outcomeEvidenceId,
      node.outcomeExplanation,
      node.terminalEvidenceId,
      node.supersededPlanRevisionId,
      node.version,
      node.createdAtMs,
      node.updatedAtMs,
    ],
  );
}

function insertArtifactInput(
  transaction: SqliteTransaction,
  nodeId: string,
  artifactId: string,
  sourceNodeId: string,
): void {
  transaction.run(
    `INSERT INTO node_artifact_inputs (node_id, ordinal, artifact_id, source_node_id)
    VALUES (?, ?, ?, ?)`,
    [nodeId, 0, artifactId, sourceNodeId],
  );
}

async function seedCanonicalAggregate(target: ManagedSqliteDatabase): Promise<void> {
  await target.write((transaction) => {
    insertRepository(transaction, CANONICAL_IDS);
    insertTree(transaction, CANONICAL_IDS);
    insertPlanRevision(transaction, CANONICAL_IDS);
    insertNode(
      transaction,
      implementationNode(CANONICAL_IDS, CANONICAL_IDS.rootNodeId, null, "root objective"),
    );
  });
}

async function expectSqliteConstraint(
  target: ManagedSqliteDatabase,
  operation: (transaction: SqliteTransaction) => void,
): Promise<void> {
  await expect(target.write(operation)).rejects.toMatchObject({ code: "transaction_failed" });
}

function expectCanonicalCounts(
  target: ManagedSqliteDatabase,
  nodeCount = 1n,
  artifactInputCount = 0n,
): void {
  const counts = target.read((reader) =>
    reader.get(
      `SELECT
        (SELECT count(*) FROM repositories) AS repositories,
        (SELECT count(*) FROM trees) AS trees,
        (SELECT count(*) FROM plan_revisions) AS plan_revisions,
        (SELECT count(*) FROM nodes) AS nodes,
        (SELECT count(*) FROM node_artifact_inputs) AS node_artifact_inputs`,
    ),
  );
  expect(counts).toEqual({
    repositories: 1n,
    trees: 1n,
    plan_revisions: 1n,
    nodes: nodeCount,
    node_artifact_inputs: artifactInputCount,
  });
}

describe("host SQLite current-state schema", () => {
  beforeEach(async () => {
    temporaryDatabase = await TemporarySqliteDatabase.create("host", CLOCK);
    await seedCanonicalAggregate(temporaryDatabase.database);
  });

  afterEach(async () => {
    const current = temporaryDatabase;
    temporaryDatabase = undefined;
    if (current !== undefined) {
      await current.dispose();
    }
  });

  it("persists a valid aggregate in direct current-state rows", () => {
    const target = database();
    expect(temporaryDatabase?.path).not.toBe(":memory:");

    const rows = target.read((reader) => ({
      repository: reader.get(
        `SELECT id, host_id, root_path, version, registered_at_ms, archived_at_ms
         FROM repositories`,
      ),
      tree: reader.get(
        `SELECT id, repository_id, host_id, base_commit, goal,
                active_plan_revision_id, root_node_id, version, created_at_ms,
                updated_at_ms, archived_at_ms
         FROM trees`,
      ),
      planRevision: reader.get(
        `SELECT id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
                approved_at_ms, superseded_at_ms
         FROM plan_revisions`,
      ),
      root: reader.get(
        `SELECT id, tree_id, repository_id, host_id, parent_node_id, root_tree_id,
                plan_revision_id, mode, objective, output_kind, state_kind, version,
                created_at_ms, updated_at_ms
         FROM nodes`,
      ),
    }));

    expect(rows.repository).toEqual({
      id: CANONICAL_IDS.repositoryId,
      host_id: CANONICAL_IDS.hostId,
      root_path: "/workspace/minions",
      version: 0n,
      registered_at_ms: BigInt(NOW),
      archived_at_ms: null,
    });
    expect(rows.tree).toEqual({
      id: CANONICAL_IDS.treeId,
      repository_id: CANONICAL_IDS.repositoryId,
      host_id: CANONICAL_IDS.hostId,
      base_commit: BASE_COMMIT,
      goal: "deterministic host tree",
      active_plan_revision_id: CANONICAL_IDS.planRevisionId,
      root_node_id: CANONICAL_IDS.rootNodeId,
      version: 0n,
      created_at_ms: BigInt(NOW),
      updated_at_ms: BigInt(NOW),
      archived_at_ms: null,
    });
    expect(rows.planRevision).toEqual({
      id: CANONICAL_IDS.planRevisionId,
      tree_id: CANONICAL_IDS.treeId,
      ordinal: 1n,
      goal: "deterministic host tree",
      state_kind: "draft",
      version: 0n,
      created_at_ms: BigInt(NOW),
      approved_at_ms: null,
      superseded_at_ms: null,
    });
    expect(rows.root).toEqual({
      id: CANONICAL_IDS.rootNodeId,
      tree_id: CANONICAL_IDS.treeId,
      repository_id: CANONICAL_IDS.repositoryId,
      host_id: CANONICAL_IDS.hostId,
      parent_node_id: null,
      root_tree_id: CANONICAL_IDS.treeId,
      plan_revision_id: CANONICAL_IDS.planRevisionId,
      mode: "implementation",
      objective: "root objective",
      output_kind: "implementation",
      state_kind: "planned",
      version: 0n,
      created_at_ms: BigInt(NOW),
      updated_at_ms: BigInt(NOW),
    });
  });

  it("rejects a second root in one tree through the partial root index", async () => {
    const target = database();
    await expectSqliteConstraint(target, (transaction) => {
      insertNode(
        transaction,
        implementationNode(CANONICAL_IDS, INVALID_IDS.secondRootNodeId, null, "second root"),
      );
    });
    expectCanonicalCounts(target);
  });

  it("rejects a tree whose designated root is a child", async () => {
    const target = database();
    const extraIds: AggregateIds = {
      hostId: CANONICAL_IDS.hostId,
      repositoryId: CANONICAL_IDS.repositoryId,
      treeId: EXTRA_IDS.treeId,
      planRevisionId: EXTRA_IDS.planRevisionId,
      rootNodeId: EXTRA_IDS.childNodeId,
    };

    await expectSqliteConstraint(target, (transaction) => {
      insertTree(transaction, extraIds, EXTRA_IDS.childNodeId);
      insertPlanRevision(transaction, extraIds);
      insertNode(
        transaction,
        implementationNode(extraIds, EXTRA_IDS.parentNodeId, null, "designated parent"),
      );
      insertNode(
        transaction,
        implementationNode(
          extraIds,
          EXTRA_IDS.childNodeId,
          EXTRA_IDS.parentNodeId,
          "designated child",
        ),
      );
    });
    expectCanonicalCounts(target);
  });

  it("rejects a parent from another tree", async () => {
    const target = database();
    const extraIds: AggregateIds = {
      hostId: CANONICAL_IDS.hostId,
      repositoryId: CANONICAL_IDS.repositoryId,
      treeId: EXTRA_IDS.treeId,
      planRevisionId: EXTRA_IDS.planRevisionId,
      rootNodeId: EXTRA_IDS.rootNodeId,
    };

    await expectSqliteConstraint(target, (transaction) => {
      insertTree(transaction, extraIds);
      insertPlanRevision(transaction, extraIds);
      insertNode(
        transaction,
        implementationNode(extraIds, EXTRA_IDS.rootNodeId, null, "second tree root"),
      );
      insertNode(
        transaction,
        implementationNode(
          extraIds,
          EXTRA_IDS.childNodeId,
          CANONICAL_IDS.rootNodeId,
          "cross-tree child",
        ),
      );
    });
    expectCanonicalCounts(target);
  });

  it("rejects mismatched repository and host bindings", async () => {
    const target = database();
    const mismatchedRepository = nodeWith(
      implementationNode(
        CANONICAL_IDS,
        INVALID_IDS.mismatchedRepositoryNodeId,
        CANONICAL_IDS.rootNodeId,
        "mismatched repository",
      ),
      { repositoryId: "01900000-0000-7000-8000-000000000040" },
    );
    await expectSqliteConstraint(target, (transaction) => {
      insertNode(transaction, mismatchedRepository);
    });
    expectCanonicalCounts(target);

    const mismatchedHost = nodeWith(
      implementationNode(
        CANONICAL_IDS,
        INVALID_IDS.mismatchedHostNodeId,
        CANONICAL_IDS.rootNodeId,
        "mismatched host",
      ),
      { hostId: "01900000-0000-7000-8000-000000000041" },
    );
    await expectSqliteConstraint(target, (transaction) => {
      insertNode(transaction, mismatchedHost);
    });
    expectCanonicalCounts(target);
  });

  it("rejects artifact rows with mismatched node aggregate bindings", async () => {
    const target = database();

    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO content_blobs (
          digest, size_bytes, media_type, relative_path, retention_kind,
          created_at_ms, verified_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [EXECUTION_CONTENT_DIGEST, 1, "text/plain", "evidence/output.txt", "active", NOW, NOW],
      );
      transaction.run(
        `INSERT INTO artifacts (
          id, node_id, attempt_id, tree_id, repository_id, host_id,
          content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          EXECUTION_ARTIFACT_ID,
          CANONICAL_IDS.rootNodeId,
          null,
          EXTRA_IDS.treeId,
          INVALID_IDS.mismatchedRepositoryNodeId,
          INVALID_IDS.mismatchedHostNodeId,
          EXECUTION_CONTENT_DIGEST,
          "text/plain",
          EXECUTION_EVIDENCE_ID,
          "active",
          NOW,
        ],
      );
    });

    expect(
      target.read((reader) =>
        reader.get(
          `SELECT
            (SELECT count(*) FROM content_blobs) AS content_blobs,
            (SELECT count(*) FROM artifacts) AS artifacts`,
        ),
      ),
    ).toEqual({ content_blobs: 0n, artifacts: 0n });
  });

  it("rejects mutable parent and definition updates", async () => {
    const target = database();
    const parent = implementationNode(
      CANONICAL_IDS,
      INVALID_IDS.parentNodeId,
      CANONICAL_IDS.rootNodeId,
      "parent",
    );
    const child = implementationNode(
      CANONICAL_IDS,
      INVALID_IDS.childNodeId,
      INVALID_IDS.parentNodeId,
      "child",
    );
    const sibling = implementationNode(
      CANONICAL_IDS,
      INVALID_IDS.siblingNodeId,
      CANONICAL_IDS.rootNodeId,
      "sibling",
    );
    await target.write((transaction) => {
      insertNode(transaction, parent);
      insertNode(transaction, child);
      insertNode(transaction, sibling);
      transaction.run(
        `INSERT INTO node_acceptance_criteria (node_id, ordinal, criterion)
         VALUES (?, ?, ?)`,
        [INVALID_IDS.parentNodeId, 0, "must remain deterministic"],
      );
    });

    await expectSqliteConstraint(target, (transaction) => {
      transaction.run("UPDATE repositories SET root_path = ? WHERE id = ?", [
        "/workspace/changed",
        CANONICAL_IDS.repositoryId,
      ]);
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run("UPDATE trees SET base_commit = ? WHERE id = ?", [
        NEXT_COMMIT,
        CANONICAL_IDS.treeId,
      ]);
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run("UPDATE plan_revisions SET goal = ? WHERE id = ?", [
        "changed goal",
        CANONICAL_IDS.planRevisionId,
      ]);
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run("UPDATE nodes SET parent_node_id = ? WHERE id = ?", [
        INVALID_IDS.parentNodeId,
        INVALID_IDS.siblingNodeId,
      ]);
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run("UPDATE nodes SET objective = ? WHERE id = ?", [
        "changed objective",
        INVALID_IDS.parentNodeId,
      ]);
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run("UPDATE node_acceptance_criteria SET criterion = ? WHERE node_id = ?", [
        "changed criterion",
        INVALID_IDS.parentNodeId,
      ]);
    });
    expectCanonicalCounts(target, 4n);

    const values = target.read((reader) => ({
      repository: reader.get("SELECT root_path FROM repositories WHERE id = ?", [
        CANONICAL_IDS.repositoryId,
      ]),
      tree: reader.get("SELECT base_commit FROM trees WHERE id = ?", [CANONICAL_IDS.treeId]),
      planRevision: reader.get("SELECT goal FROM plan_revisions WHERE id = ?", [
        CANONICAL_IDS.planRevisionId,
      ]),
      parent: reader.get("SELECT objective FROM nodes WHERE id = ?", [INVALID_IDS.parentNodeId]),
    }));
    expect(values.repository?.["root_path"]).toBe("/workspace/minions");
    expect(values.tree?.["base_commit"]).toBe(BASE_COMMIT);
    expect(values.planRevision?.["goal"]).toBe("deterministic host tree");
    expect(values.parent?.["objective"]).toBe("parent");
  });

  it("rejects invalid lifecycle and output combinations", async () => {
    const target = database();
    const invalidArtifactOutput = nodeWith(
      implementationNode(
        CANONICAL_IDS,
        INVALID_IDS.artifactOutputNodeId,
        CANONICAL_IDS.rootNodeId,
        "invalid artifact output",
      ),
      {
        outputKind: "artifact",
        outputArtifactId: INVALID_IDS.artifactId,
        outputArtifactType: "text/plain",
      },
    );
    await expectSqliteConstraint(target, (transaction) => {
      insertNode(transaction, invalidArtifactOutput);
    });
    expectCanonicalCounts(target);

    const invalidImplementationOutput = nodeWith(
      implementationNode(
        CANONICAL_IDS,
        INVALID_IDS.implementationOutputNodeId,
        CANONICAL_IDS.rootNodeId,
        "invalid implementation output",
      ),
      { mode: "explore" },
    );
    await expectSqliteConstraint(target, (transaction) => {
      insertNode(transaction, invalidImplementationOutput);
    });
    expectCanonicalCounts(target);

    const succeededWithoutOutcome = nodeWith(
      implementationNode(
        CANONICAL_IDS,
        INVALID_IDS.succeededNodeId,
        CANONICAL_IDS.rootNodeId,
        "succeeded without outcome",
      ),
      { stateKind: "succeeded" },
    );
    await expectSqliteConstraint(target, (transaction) => {
      insertNode(transaction, succeededWithoutOutcome);
    });
    expectCanonicalCounts(target);

    const failedWithoutTerminalEvidence = nodeWith(
      implementationNode(
        CANONICAL_IDS,
        INVALID_IDS.failedNodeId,
        CANONICAL_IDS.rootNodeId,
        "failed without terminal evidence",
      ),
      { stateKind: "failed" },
    );
    await expectSqliteConstraint(target, (transaction) => {
      insertNode(transaction, failedWithoutTerminalEvidence);
    });
    expectCanonicalCounts(target);

    const blockedWithoutEvidence = nodeWith(
      implementationNode(
        CANONICAL_IDS,
        INVALID_IDS.blockedNodeId,
        CANONICAL_IDS.rootNodeId,
        "blocked without evidence",
      ),
      { stateKind: "blocked", resumeStateKind: "ready", blockerKind: "parent" },
    );
    await expectSqliteConstraint(target, (transaction) => {
      insertNode(transaction, blockedWithoutEvidence);
    });
    expectCanonicalCounts(target);
  });

  it("binds each attempt to its node plan revision", async () => {
    const target = database();

    await target.write((transaction) => {
      transaction.run(
        `INSERT INTO plan_revisions (
          id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
          approved_at_ms, superseded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          MISMATCHED_PLAN_REVISION_ID,
          CANONICAL_IDS.treeId,
          2,
          "different plan",
          "draft",
          0,
          NOW,
          null,
          null,
        ],
      );
    });

    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO attempts (
          id, node_id, tree_id, repository_id, host_id, plan_revision_id,
          ordinal, state_kind, version, started_at_ms, finished_at_ms, evidence_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          MISMATCHED_PLAN_ATTEMPT_ID,
          CANONICAL_IDS.rootNodeId,
          CANONICAL_IDS.treeId,
          CANONICAL_IDS.repositoryId,
          CANONICAL_IDS.hostId,
          MISMATCHED_PLAN_REVISION_ID,
          1,
          "active",
          0,
          NOW,
          null,
          null,
        ],
      );
    });

    expect(
      target.read((reader) =>
        reader.get("SELECT count(*) AS attempts FROM attempts WHERE id = ?", [
          MISMATCHED_PLAN_ATTEMPT_ID,
        ]),
      ),
    ).toEqual({ attempts: 0n });
  });

  it("requires valid started and finished timestamps for execution states", async () => {
    const target = database();

    await expectSqliteConstraint(target, (transaction) => {
      transaction.run("UPDATE plan_revisions SET state_kind = ?, approved_at_ms = ? WHERE id = ?", [
        "approved",
        null,
        CANONICAL_IDS.planRevisionId,
      ]);
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO attempts (
          id, node_id, tree_id, repository_id, host_id, plan_revision_id,
          ordinal, state_kind, version, started_at_ms, finished_at_ms, evidence_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          TERMINAL_ATTEMPT_ID,
          CANONICAL_IDS.rootNodeId,
          CANONICAL_IDS.treeId,
          CANONICAL_IDS.repositoryId,
          CANONICAL_IDS.hostId,
          CANONICAL_IDS.planRevisionId,
          2,
          "failed",
          0,
          NOW,
          null,
          TERMINAL_EVIDENCE_ID,
        ],
      );
    });

    await target.write((transaction) => {
      transaction.run(
        `INSERT INTO attempts (
          id, node_id, tree_id, repository_id, host_id, plan_revision_id,
          ordinal, state_kind, version, started_at_ms, finished_at_ms, evidence_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ACTIVE_ATTEMPT_ID,
          CANONICAL_IDS.rootNodeId,
          CANONICAL_IDS.treeId,
          CANONICAL_IDS.repositoryId,
          CANONICAL_IDS.hostId,
          CANONICAL_IDS.planRevisionId,
          1,
          "active",
          0,
          NOW,
          null,
          null,
        ],
      );
      transaction.run(
        `INSERT INTO content_blobs (
          digest, size_bytes, media_type, relative_path, retention_kind,
          created_at_ms, verified_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [EXECUTION_CONTENT_DIGEST, 1, "text/plain", "evidence/valid.txt", "active", NOW, NOW],
      );
      transaction.run(
        `INSERT INTO artifacts (
          id, node_id, attempt_id, tree_id, repository_id, host_id,
          content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          VALID_ARTIFACT_ID,
          CANONICAL_IDS.rootNodeId,
          ACTIVE_ATTEMPT_ID,
          CANONICAL_IDS.treeId,
          CANONICAL_IDS.repositoryId,
          CANONICAL_IDS.hostId,
          EXECUTION_CONTENT_DIGEST,
          "text/plain",
          TERMINAL_EVIDENCE_ID,
          "active",
          NOW,
        ],
      );
      transaction.run(
        `INSERT INTO artifacts (
          id, node_id, attempt_id, tree_id, repository_id, host_id,
          content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          DETACHED_ARTIFACT_ID,
          CANONICAL_IDS.rootNodeId,
          null,
          CANONICAL_IDS.treeId,
          CANONICAL_IDS.repositoryId,
          CANONICAL_IDS.hostId,
          EXECUTION_CONTENT_DIGEST,
          "text/plain",
          EXECUTION_EVIDENCE_ID,
          "active",
          NOW,
        ],
      );
      insertNode(
        transaction,
        implementationNode(
          CANONICAL_IDS,
          RESTACK_CHILD_ID,
          CANONICAL_IDS.rootNodeId,
          "restack child",
        ),
      );
    });

    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO gate_runs (
          id, node_id, attempt_id, gate_kind, gate_name, state_kind,
          evidence_artifact_id, started_at_ms, finished_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          GATE_ID,
          CANONICAL_IDS.rootNodeId,
          ACTIVE_ATTEMPT_ID,
          "test",
          "detached-evidence",
          "passed",
          DETACHED_ARTIFACT_ID,
          NOW,
          NOW,
        ],
      );
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO gate_runs (
          id, node_id, attempt_id, gate_kind, gate_name, state_kind,
          evidence_artifact_id, started_at_ms, finished_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          GATE_ID,
          CANONICAL_IDS.rootNodeId,
          ACTIVE_ATTEMPT_ID,
          "test",
          "unit",
          "running",
          null,
          null,
          null,
        ],
      );
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO gate_runs (
          id, node_id, attempt_id, gate_kind, gate_name, state_kind,
          evidence_artifact_id, started_at_ms, finished_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          GATE_ID,
          CANONICAL_IDS.rootNodeId,
          ACTIVE_ATTEMPT_ID,
          "test",
          "unit",
          "failed",
          VALID_ARTIFACT_ID,
          NOW,
          null,
        ],
      );
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO restack_runs (
          id, node_id, parent_node_id, state_kind, old_base_commit,
          new_base_commit, result_commit, evidence_id, started_at_ms, finished_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          RESTACK_ID,
          RESTACK_CHILD_ID,
          CANONICAL_IDS.rootNodeId,
          "running",
          BASE_COMMIT,
          NEXT_COMMIT,
          null,
          null,
          null,
          null,
        ],
      );
    });
    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO restack_runs (
          id, node_id, parent_node_id, state_kind, old_base_commit,
          new_base_commit, result_commit, evidence_id, started_at_ms, finished_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          RESTACK_ID,
          RESTACK_CHILD_ID,
          CANONICAL_IDS.rootNodeId,
          "failed",
          BASE_COMMIT,
          NEXT_COMMIT,
          null,
          TERMINAL_EVIDENCE_ID,
          NOW,
          null,
        ],
      );
    });

    expect(
      target.read((reader) =>
        reader.get(
          `SELECT
            (SELECT state_kind FROM plan_revisions WHERE id = ?) AS plan_state,
            (SELECT count(*) FROM attempts WHERE id = ?) AS terminal_attempts,
            (SELECT count(*) FROM gate_runs) AS gate_runs,
            (SELECT count(*) FROM restack_runs) AS restack_runs`,
          [CANONICAL_IDS.planRevisionId, TERMINAL_ATTEMPT_ID],
        ),
      ),
    ).toEqual({
      plan_state: "draft",
      terminal_attempts: 0n,
      gate_runs: 0n,
      restack_runs: 0n,
    });
  });

  it("keeps persisted event bytes immutable", async () => {
    const target = database();

    await target.write((transaction) => {
      transaction.run(
        `INSERT INTO operator_commands (
          id, actor_session_id, aggregate_kind, aggregate_id, expected_version,
          command_type, command_payload, state_kind, created_at_ms, acknowledged_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          COMMAND_ID,
          TERMINAL_EVIDENCE_ID,
          "tree",
          CANONICAL_IDS.treeId,
          0,
          "test.command",
          Uint8Array.of(1, 2),
          "queued",
          NOW,
          null,
        ],
      );
      transaction.run(
        `INSERT INTO events (
          event_id, command_id, aggregate_kind, aggregate_id,
          aggregate_version, event_type, event_payload, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          JOURNAL_EVENT_ID,
          COMMAND_ID,
          "tree",
          CANONICAL_IDS.treeId,
          1,
          "test.event",
          Uint8Array.of(3, 4),
          NOW,
        ],
      );
    });

    await expectSqliteConstraint(target, (transaction) => {
      transaction.run("UPDATE events SET event_type = ?, event_payload = ? WHERE event_id = ?", [
        "mutated",
        Uint8Array.of(0),
        JOURNAL_EVENT_ID,
      ]);
    });

    expect(
      target.read((reader) =>
        reader.get("SELECT event_type, hex(event_payload) AS event_payload FROM events"),
      ),
    ).toEqual({ event_type: "test.event", event_payload: "0304" });

    await target.write((transaction) => {
      transaction.run("DELETE FROM events WHERE event_id = ?", [JOURNAL_EVENT_ID]);
      transaction.run(
        `INSERT INTO operator_commands (
          id, actor_session_id, aggregate_kind, aggregate_id, expected_version,
          command_type, command_payload, state_kind, created_at_ms, acknowledged_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          SECOND_COMMAND_ID,
          TERMINAL_EVIDENCE_ID,
          "tree",
          CANONICAL_IDS.treeId,
          1,
          "test.second-command",
          Uint8Array.of(5, 6),
          "queued",
          NOW,
          null,
        ],
      );
      transaction.run(
        `INSERT INTO events (
          event_id, command_id, aggregate_kind, aggregate_id,
          aggregate_version, event_type, event_payload, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          SECOND_JOURNAL_EVENT_ID,
          SECOND_COMMAND_ID,
          "tree",
          CANONICAL_IDS.treeId,
          2,
          "test.second-event",
          Uint8Array.of(7, 8),
          NOW,
        ],
      );
    });

    expect(
      target.read((reader) =>
        reader.get("SELECT sequence, event_id FROM events WHERE event_id = ?", [
          SECOND_JOURNAL_EVENT_ID,
        ]),
      ),
    ).toEqual({ sequence: 2n, event_id: SECOND_JOURNAL_EVENT_ID });
  });

  it("uses the applied external-operation receipt state", async () => {
    const target = database();

    await target.write((transaction) => {
      transaction.run(
        `INSERT INTO operator_commands (
          id, actor_session_id, aggregate_kind, aggregate_id, expected_version,
          command_type, command_payload, state_kind, created_at_ms, acknowledged_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          COMMAND_ID,
          TERMINAL_EVIDENCE_ID,
          "tree",
          CANONICAL_IDS.treeId,
          0,
          "external.command",
          Uint8Array.of(1),
          "queued",
          NOW,
          null,
        ],
      );
      transaction.run(
        `INSERT INTO external_operations (
          id, command_id, operation_kind, idempotency_key, request_type,
          request_payload, state_kind, receipt_type, receipt_payload,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          APPLIED_OPERATION_ID,
          COMMAND_ID,
          "provider_request",
          "provider/request/1",
          "provider.request",
          Uint8Array.of(2),
          "applied",
          "provider.receipt",
          Uint8Array.of(3),
          NOW,
          NOW,
        ],
      );
    });

    await expectSqliteConstraint(target, (transaction) => {
      transaction.run(
        `INSERT INTO external_operations (
          id, command_id, operation_kind, idempotency_key, request_type,
          request_payload, state_kind, receipt_type, receipt_payload,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          LEGACY_OPERATION_ID,
          COMMAND_ID,
          "provider_request",
          "provider/request/2",
          "provider.request",
          Uint8Array.of(4),
          "succeeded",
          "provider.receipt",
          Uint8Array.of(5),
          NOW,
          NOW,
        ],
      );
    });

    expect(
      target.read((reader) =>
        reader.get(
          "SELECT state_kind, receipt_type, hex(receipt_payload) AS receipt_payload FROM external_operations WHERE id = ?",
          [APPLIED_OPERATION_ID],
        ),
      ),
    ).toEqual({
      state_kind: "applied",
      receipt_type: "provider.receipt",
      receipt_payload: "03",
    });
    expect(
      target.read((reader) =>
        reader.get("SELECT id FROM external_operations WHERE id = ?", [LEGACY_OPERATION_ID]),
      ),
    ).toBeUndefined();
  });

  it("rejects an artifact input whose source node does not own the artifact", async () => {
    const target = database();
    const owner = artifactNode(
      CANONICAL_IDS,
      INVALID_IDS.artifactOwnerNodeId,
      CANONICAL_IDS.rootNodeId,
      INVALID_IDS.artifactId,
    );
    const wrongSource = implementationNode(
      CANONICAL_IDS,
      INVALID_IDS.artifactWrongSourceNodeId,
      CANONICAL_IDS.rootNodeId,
      "wrong artifact source",
    );
    const consumer = implementationNode(
      CANONICAL_IDS,
      INVALID_IDS.artifactConsumerNodeId,
      CANONICAL_IDS.rootNodeId,
      "artifact consumer",
    );

    await expectSqliteConstraint(target, (transaction) => {
      insertNode(transaction, owner);
      insertNode(transaction, wrongSource);
      insertNode(transaction, consumer);
      insertArtifactInput(
        transaction,
        INVALID_IDS.artifactConsumerNodeId,
        INVALID_IDS.artifactId,
        INVALID_IDS.artifactWrongSourceNodeId,
      );
    });
    expectCanonicalCounts(target);
  });

  it("commits valid same-tree parentage", async () => {
    const target = database();
    const parent = implementationNode(
      CANONICAL_IDS,
      EXTRA_IDS.parentNodeId,
      CANONICAL_IDS.rootNodeId,
      "same-tree parent",
    );
    const child = implementationNode(
      CANONICAL_IDS,
      EXTRA_IDS.childNodeId,
      EXTRA_IDS.parentNodeId,
      "same-tree child",
    );

    await target.write((transaction) => {
      insertNode(transaction, parent);
      insertNode(transaction, child);
    });

    const rows = target.read((reader) =>
      reader.all(
        `SELECT id, tree_id, parent_node_id
         FROM nodes
         WHERE id IN (?, ?)
         ORDER BY id`,
        [EXTRA_IDS.parentNodeId, EXTRA_IDS.childNodeId],
      ),
    );
    expect(rows).toEqual([
      {
        id: EXTRA_IDS.childNodeId,
        tree_id: CANONICAL_IDS.treeId,
        parent_node_id: EXTRA_IDS.parentNodeId,
      },
      {
        id: EXTRA_IDS.parentNodeId,
        tree_id: CANONICAL_IDS.treeId,
        parent_node_id: CANONICAL_IDS.rootNodeId,
      },
    ]);
    expectCanonicalCounts(target, 3n);
  });

  it("commits matching artifact provenance", async () => {
    const target = database();
    const source = artifactNode(
      CANONICAL_IDS,
      EXTRA_IDS.sourceNodeId,
      CANONICAL_IDS.rootNodeId,
      EXTRA_IDS.artifactId,
    );
    const consumer = implementationNode(
      CANONICAL_IDS,
      EXTRA_IDS.consumerNodeId,
      EXTRA_IDS.sourceNodeId,
      "matching artifact consumer",
    );

    await target.write((transaction) => {
      insertNode(transaction, source);
      insertNode(transaction, consumer);
      insertArtifactInput(
        transaction,
        EXTRA_IDS.consumerNodeId,
        EXTRA_IDS.artifactId,
        EXTRA_IDS.sourceNodeId,
      );
    });

    const rows = target.read((reader) => ({
      source: reader.get(
        "SELECT id, output_artifact_id, output_artifact_type FROM nodes WHERE id = ?",
        [EXTRA_IDS.sourceNodeId],
      ),
      input: reader.get(
        `SELECT node_id, ordinal, artifact_id, source_node_id
         FROM node_artifact_inputs
         WHERE node_id = ?`,
        [EXTRA_IDS.consumerNodeId],
      ),
    }));
    expect(rows.source).toEqual({
      id: EXTRA_IDS.sourceNodeId,
      output_artifact_id: EXTRA_IDS.artifactId,
      output_artifact_type: "text/plain",
    });
    expect(rows.input).toEqual({
      node_id: EXTRA_IDS.consumerNodeId,
      ordinal: 0n,
      artifact_id: EXTRA_IDS.artifactId,
      source_node_id: EXTRA_IDS.sourceNodeId,
    });
    expectCanonicalCounts(target, 3n, 1n);
    expect(
      target.read((reader) => reader.get("SELECT count(*) AS count FROM node_artifact_inputs")),
    ).toEqual({ count: 1n });
  });
});
