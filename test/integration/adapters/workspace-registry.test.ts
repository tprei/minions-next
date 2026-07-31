import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createSqliteGitMutationLeaseStore,
  createSqliteWorkspaceRegistry,
  hostMigrations,
  openHostDatabase,
} from "@minions/adapters";
import {
  attemptId,
  gitSha,
  hostId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
} from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";

const NOW = timestampFromEpochMilliseconds(1_725_000_000_000);
const BASE = gitSha("0123456789abcdef0123456789abcdef01234567");
const HEAD = gitSha("89abcdef0123456789abcdef0123456789abcdef");
const HOST = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY = repositoryId("01900000-0000-7000-8000-000000000002");
const SECOND_REPOSITORY = repositoryId("01900000-0000-7000-8000-000000000003");
const TREE = taskTreeId("01900000-0000-7000-8000-000000000004");
const NODE = taskNodeId("01900000-0000-7000-8000-000000000005");
const REVISION = "01900000-0000-7000-8000-000000000006";
const ATTEMPT = attemptId("01900000-0000-7000-8000-000000000007");
const SECOND_ATTEMPT = attemptId("01900000-0000-7000-8000-000000000008");
const OWNER_ONE = "01900000-0000-7000-8000-000000000009";
const OWNER_TWO = "01900000-0000-7000-8000-00000000000a";

const WORKSPACE_AUTH = Object.freeze({
  ownerId: OWNER_ONE,
  fencingToken: 1n,
  observedAt: NOW,
});

const temporaries: TemporarySqliteDatabase[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((temporary) => temporary.dispose()));
});

describe("host migration 0009", () => {
  it("backfills a legacy workspace from the canonical registration root", async () => {
    const legacy = await createLegacyDatabase(true);
    const database = await openHostDatabase({
      path: legacy.path,
      clock: new FixedClock(NOW),
      backupPath: legacy.backupPath,
    });
    try {
      const row = database.read((reader) =>
        reader.get(
          "SELECT source_path, state_kind, head_commit, ready_at_ms FROM workspace_bindings WHERE attempt_id = ?",
          [ATTEMPT],
        ),
      );
      expect(row).toEqual({
        source_path: "/canonical/repository-one",
        state_kind: "ready",
        head_commit: BASE,
        ready_at_ms: BigInt(NOW),
      });
    } finally {
      await database.close();
      await rm(legacy.directory, { force: true, recursive: true });
    }
  });

  it("rolls back when legacy ownership has no matching registration", async () => {
    const legacy = await createLegacyDatabase(false);
    await expect(
      openHostDatabase({
        path: legacy.path,
        clock: new FixedClock(NOW),
        backupPath: legacy.backupPath,
      }),
    ).rejects.toMatchObject({ code: "migration_failed" });
    const database = new DatabaseSync(legacy.path);
    try {
      expect(
        database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({
        version: 8,
      });
      expect(database.prepare("PRAGMA table_info(workspace_bindings)").all()).toHaveLength(7);
    } finally {
      database.close();
      await rm(legacy.directory, { force: true, recursive: true });
    }
  });
});

describe("SQLite workspace registry", () => {
  it("fences every lifecycle transition and replays identical requests", async () => {
    const fixture = await createFixture();
    const registry = createSqliteWorkspaceRegistry({ database: fixture.database });
    const begin = {
      attemptId: ATTEMPT,
      nodeId: NODE,
      treeId: TREE,
      hostId: HOST,
      repositoryId: REPOSITORY,
      workspacePath: "/workspaces/attempt",
      sourcePath: "/repositories/one",
      branchName: "minions/tree/node/1",
      baseCommit: BASE,
      createdAt: NOW,
      ...WORKSPACE_AUTH,
    } as const;

    const creating = await registry.begin(begin);
    expect(creating.state).toBe("creating");
    expect(await registry.begin(begin)).toEqual(creating);
    await expect(
      registry.markReady({
        attemptId: ATTEMPT,
        expectedVersion: 9,
        headCommit: HEAD,
        readyAt: NOW,
        ...WORKSPACE_AUTH,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });

    const ready = await registry.markReady({
      attemptId: ATTEMPT,
      expectedVersion: 0,
      headCommit: HEAD,
      readyAt: timestampFromEpochMilliseconds(NOW + 1),
      ...WORKSPACE_AUTH,
    });
    expect(ready.version).toBe(1);
    expect(
      await registry.markReady({
        attemptId: ATTEMPT,
        expectedVersion: 0,
        headCommit: HEAD,
        readyAt: timestampFromEpochMilliseconds(NOW + 1),
        ...WORKSPACE_AUTH,
      }),
    ).toEqual(ready);

    const cleanup = await registry.requestCleanup({
      attemptId: ATTEMPT,
      expectedVersion: 1,
      cleanupRequestedAt: timestampFromEpochMilliseconds(NOW + 2),
      ...WORKSPACE_AUTH,
    });
    expect(cleanup.state).toBe("cleanup_pending");
    expect(
      await registry.requestCleanup({
        attemptId: ATTEMPT,
        expectedVersion: 1,
        cleanupRequestedAt: timestampFromEpochMilliseconds(NOW + 2),
        ...WORKSPACE_AUTH,
      }),
    ).toEqual(cleanup);

    const cleaned = await registry.markCleaned({
      attemptId: ATTEMPT,
      expectedVersion: 2,
      cleanedAt: timestampFromEpochMilliseconds(NOW + 3),
      ...WORKSPACE_AUTH,
    });
    expect(cleaned.state).toBe("cleaned");
    expect(
      await registry.markCleaned({
        attemptId: ATTEMPT,
        expectedVersion: 2,
        cleanedAt: timestampFromEpochMilliseconds(NOW + 3),
        ...WORKSPACE_AUTH,
      }),
    ).toEqual(cleaned);
    expect(registry.listRecoverable()).toEqual([]);
    expect(registry.get(ATTEMPT).state).toBe("cleaned");
    await expect(
      registry.requestCleanup({
        attemptId: ATTEMPT,
        expectedVersion: 3,
        cleanupRequestedAt: timestampFromEpochMilliseconds(NOW + 2),
        ...WORKSPACE_AUTH,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("accepts the canonical root or a ready same-repository parent workspace only", async () => {
    const fixture = await createFixture();
    const registry = createSqliteWorkspaceRegistry({ database: fixture.database });
    const parent = await registry.begin({
      attemptId: ATTEMPT,
      nodeId: NODE,
      treeId: TREE,
      hostId: HOST,
      repositoryId: REPOSITORY,
      workspacePath: "/workspaces/parent",
      sourcePath: "/repositories/one",
      branchName: "minions/tree/node/parent",
      baseCommit: BASE,
      createdAt: NOW,
      ...WORKSPACE_AUTH,
    });
    await expect(
      registry.begin({
        attemptId: SECOND_ATTEMPT,
        nodeId: NODE,
        treeId: TREE,
        hostId: HOST,
        repositoryId: REPOSITORY,
        workspacePath: "/workspaces/child",
        sourcePath: "/workspaces/parent",
        branchName: "minions/tree/node/child",
        baseCommit: BASE,
        createdAt: NOW,
        ...WORKSPACE_AUTH,
      }),
    ).rejects.toMatchObject({ code: "ownership_conflict" });
    await registry.markReady({
      attemptId: parent.attemptId,
      expectedVersion: parent.version,
      headCommit: HEAD,
      ...WORKSPACE_AUTH,
      readyAt: timestampFromEpochMilliseconds(NOW + 1),
    });
    const child = await registry.begin({
      attemptId: SECOND_ATTEMPT,
      nodeId: NODE,
      treeId: TREE,
      hostId: HOST,
      repositoryId: REPOSITORY,
      workspacePath: "/workspaces/child",
      sourcePath: "/workspaces/parent",
      branchName: "minions/tree/node/child",
      baseCommit: BASE,
      createdAt: NOW,
      ...WORKSPACE_AUTH,
    });
    expect(child.sourcePath).toBe("/workspaces/parent");
    await expect(
      registry.begin({
        attemptId: SECOND_ATTEMPT,
        nodeId: NODE,
        treeId: TREE,
        hostId: HOST,
        repositoryId: SECOND_REPOSITORY,
        workspacePath: "/workspaces/cross-repository",
        sourcePath: "/workspaces/parent",
        branchName: "minions/tree/node/cross-repository",
        baseCommit: BASE,
        createdAt: NOW,
        ...WORKSPACE_AUTH,
      }),
    ).rejects.toMatchObject({ code: "ownership_conflict" });
  });

  it("rejects a ready-parent source when repository registration is missing", async () => {
    const fixture = await createFixture();
    const registry = createSqliteWorkspaceRegistry({ database: fixture.database });
    const parent = await registry.begin({
      attemptId: ATTEMPT,
      nodeId: NODE,
      treeId: TREE,
      hostId: HOST,
      repositoryId: REPOSITORY,
      workspacePath: "/workspaces/parent",
      sourcePath: "/repositories/one",
      branchName: "minions/tree/node/parent",
      baseCommit: BASE,
      createdAt: NOW,
      ...WORKSPACE_AUTH,
    });
    await registry.markReady({
      attemptId: parent.attemptId,
      expectedVersion: parent.version,
      headCommit: HEAD,
      ...WORKSPACE_AUTH,
      readyAt: timestampFromEpochMilliseconds(NOW + 1),
    });
    await fixture.database.write((transaction) => {
      transaction.run("DELETE FROM repository_registrations WHERE repository_id = ?", [REPOSITORY]);
    });
    await expect(
      registry.begin({
        attemptId: SECOND_ATTEMPT,
        nodeId: NODE,
        treeId: TREE,
        hostId: HOST,
        repositoryId: REPOSITORY,
        workspacePath: "/workspaces/child",
        sourcePath: "/workspaces/parent",
        branchName: "minions/tree/node/child",
        baseCommit: BASE,
        createdAt: NOW,
        ...WORKSPACE_AUTH,
      }),
    ).rejects.toMatchObject({ code: "ownership_conflict" });
  });

  it("retains creating recovery and records terminal failure", async () => {
    const fixture = await createFixture();
    const registry = createSqliteWorkspaceRegistry({ database: fixture.database });
    const begin = await registry.begin({
      attemptId: SECOND_ATTEMPT,
      nodeId: NODE,
      treeId: TREE,
      hostId: HOST,
      repositoryId: REPOSITORY,
      workspacePath: "/workspaces/attempt-2",
      sourcePath: "/repositories/one",
      branchName: "minions/tree/node/2",
      baseCommit: BASE,
      createdAt: NOW,
      ...WORKSPACE_AUTH,
    });
    expect(registry.listRecoverable().map((receipt) => receipt.attemptId)).toEqual([
      SECOND_ATTEMPT,
    ]);
    const failed = await registry.markFailed({
      attemptId: SECOND_ATTEMPT,
      expectedVersion: begin.version,
      failureCode: "clone_failed",
      ...WORKSPACE_AUTH,
    });
    expect(failed.state).toBe("failed");
    expect(
      await registry.markFailed({
        attemptId: SECOND_ATTEMPT,
        expectedVersion: begin.version,
        failureCode: "clone_failed",
        ...WORKSPACE_AUTH,
      }),
    ).toEqual(failed);
    expect(registry.listRecoverable()).toEqual([]);
  });
});

describe("SQLite Git mutation lease store", () => {
  it("excludes same-repository owners, permits independent repositories, and fences takeover", async () => {
    const fixture = await createFixture(false);
    const leases = createSqliteGitMutationLeaseStore({ database: fixture.database });
    const first = await leases.acquire({
      repositoryId: REPOSITORY,
      ownerId: OWNER_ONE,
      acquiredAt: NOW,
      leaseDurationMs: 10,
    });
    expect(first.fencingToken).toBe(1n);
    const independent = await leases.acquire({
      repositoryId: SECOND_REPOSITORY,
      ownerId: OWNER_TWO,
      acquiredAt: NOW,
      leaseDurationMs: 10,
    });
    expect(independent.repositoryId).toBe(SECOND_REPOSITORY);
    await expect(
      leases.acquire({
        repositoryId: REPOSITORY,
        ownerId: OWNER_TWO,
        acquiredAt: timestampFromEpochMilliseconds(NOW + 1),
        leaseDurationMs: 10,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });

    const takeover = await leases.acquire({
      repositoryId: REPOSITORY,
      ownerId: OWNER_TWO,
      acquiredAt: timestampFromEpochMilliseconds(NOW + 10),
      leaseDurationMs: 10,
    });
    expect(takeover.fencingToken).toBe(2n);
    await expect(
      leases.release({
        repositoryId: REPOSITORY,
        ownerId: OWNER_ONE,
        fencingToken: first.fencingToken,
        releasedAt: timestampFromEpochMilliseconds(NOW + 11),
      }),
    ).rejects.toMatchObject({ code: "stale_lease" });
    await leases.release({
      repositoryId: REPOSITORY,
      ownerId: OWNER_TWO,
      fencingToken: takeover.fencingToken,
      releasedAt: timestampFromEpochMilliseconds(NOW + 12),
    });
    const renewed = await leases.acquire({
      repositoryId: REPOSITORY,
      ownerId: OWNER_ONE,
      acquiredAt: timestampFromEpochMilliseconds(NOW + 13),
      leaseDurationMs: 10,
    });
    expect(renewed.fencingToken).toBe(3n);
  });
});

async function createFixture(
  withLease = true,
): Promise<Readonly<{ database: TemporarySqliteDatabase["database"] }>> {
  const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(NOW));
  temporaries.push(temporary);
  await temporary.database.write((transaction) => {
    for (const [id, root] of [
      [REPOSITORY, "/repositories/one"],
      [SECOND_REPOSITORY, "/repositories/two"],
    ] as const) {
      transaction.run(
        `INSERT INTO repositories (id, host_id, root_path, version, registered_at_ms, archived_at_ms)
         VALUES (?, ?, ?, 0, ?, NULL)`,
        [id, HOST, root, NOW],
      );
      transaction.run(
        `INSERT INTO repository_registrations (
           repository_id, host_id, canonical_root, canonical_remote, default_branch,
           base_commit, allowed_workspace_root, case_sensitive, registered_at_ms
         ) VALUES (?, ?, ?, ?, 'main', ?, ?, 1, ?)`,
        [id, HOST, root, `file://${root}`, BASE, `${root}/workspaces`, NOW],
      );
    }
    transaction.run(
      `INSERT INTO trees (
         id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
         root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
       ) VALUES (?, ?, ?, ?, 'goal', ?, ?, 0, ?, ?, NULL)`,
      [TREE, REPOSITORY, HOST, BASE, REVISION, NODE, NOW, NOW],
    );
    transaction.run(
      `INSERT INTO plan_revisions (
         id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
         approved_at_ms, superseded_at_ms
       ) VALUES (?, ?, 1, 'goal', 'draft', 0, ?, NULL, NULL)`,
      [REVISION, TREE, NOW],
    );
    transaction.run(
      `INSERT INTO nodes (
         id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
         mode, objective, output_kind, output_artifact_id, output_artifact_type,
         state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
         blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
         outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
         outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
         version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, NULL, ?, 'implementation', 'implement', 'implementation',
         NULL, NULL, 'ready', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
      [NODE, TREE, REPOSITORY, HOST, REVISION, NOW, NOW],
    );
    for (const [id, ordinal] of [
      [ATTEMPT, 1],
      [SECOND_ATTEMPT, 2],
    ] as const) {
      transaction.run(
        `INSERT INTO attempts (
           id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
           state_kind, version, started_at_ms, finished_at_ms, evidence_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL, NULL)`,
        [id, NODE, TREE, REPOSITORY, HOST, REVISION, ordinal, NOW],
      );
    }
  });
  if (withLease) {
    await createSqliteGitMutationLeaseStore({ database: temporary.database }).acquire({
      repositoryId: REPOSITORY,
      ownerId: OWNER_ONE,
      acquiredAt: NOW,
      leaseDurationMs: 1_000,
    });
  }
  return { database: temporary.database };
}
type LegacyDatabase = Readonly<{
  directory: string;
  path: string;
  backupPath: string;
}>;

async function createLegacyDatabase(includeRegistration: boolean): Promise<LegacyDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "minions-workspace-legacy-"));
  const path = join(directory, "host.db");
  const backupPath = join(directory, "host.backup.db");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of hostMigrations.slice(0, 8)) {
    database.exec(migration.sql);
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(migration.version, migration.name, migration.checksum, NOW);
  }
  database.exec("BEGIN");
  database
    .prepare(
      `INSERT INTO repositories (id, host_id, root_path, version, registered_at_ms, archived_at_ms)
       VALUES (?, ?, ?, 0, ?, NULL)`,
    )
    .run(REPOSITORY, HOST, "/repositories/one", NOW);
  if (includeRegistration) {
    database
      .prepare(
        `INSERT INTO repository_registrations (
           repository_id, host_id, canonical_root, canonical_remote, default_branch,
           base_commit, allowed_workspace_root, case_sensitive, registered_at_ms
         ) VALUES (?, ?, ?, ?, 'main', ?, ?, 1, ?)`,
      )
      .run(
        REPOSITORY,
        HOST,
        "/canonical/repository-one",
        "file:///repositories/one",
        BASE,
        "/workspaces",
        NOW,
      );
  }
  database
    .prepare(
      `INSERT INTO trees (
         id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
         root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
       ) VALUES (?, ?, ?, ?, 'goal', ?, ?, 0, ?, ?, NULL)`,
    )
    .run(TREE, REPOSITORY, HOST, BASE, REVISION, NODE, NOW, NOW);
  database
    .prepare(
      `INSERT INTO plan_revisions (
         id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
         approved_at_ms, superseded_at_ms
       ) VALUES (?, ?, 1, 'goal', 'draft', 0, ?, NULL, NULL)`,
    )
    .run(REVISION, TREE, NOW);
  database
    .prepare(
      `INSERT INTO nodes (
         id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
         mode, objective, output_kind, output_artifact_id, output_artifact_type,
         state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
         blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
         outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
         outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
         version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, NULL, ?, 'implementation', 'implement', 'implementation',
         NULL, NULL, 'ready', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
    )
    .run(NODE, TREE, REPOSITORY, HOST, REVISION, NOW, NOW);
  database
    .prepare(
      `INSERT INTO attempts (
         id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
         state_kind, version, started_at_ms, finished_at_ms, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 0, ?, NULL, NULL)`,
    )
    .run(ATTEMPT, NODE, TREE, REPOSITORY, HOST, REVISION, NOW);
  database
    .prepare(
      `INSERT INTO workspace_bindings (
         attempt_id, repository_id, workspace_path, branch_name, base_commit,
         created_at_ms, cleaned_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(ATTEMPT, REPOSITORY, "/workspaces/attempt", "minions/tree/node/1", BASE, NOW);
  database.exec("COMMIT");
  database.close();
  return { directory, path, backupPath };
}
