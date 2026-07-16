import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { copyFile, link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  hostMigrations,
  openHostDatabase,
  openSupervisorDatabase,
  SqliteDatabaseError,
  supervisorMigrations,
  type ManagedSqliteDatabase,
  type SqliteDatabaseErrorCode,
  type SqliteMigration,
} from "@minions/adapters";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase, type TestManagedSqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

const fixedTimestamp = timestampFromEpochMilliseconds(1_725_000_000_123);

const externalRepositoryUpdate = `
  import { DatabaseSync } from "node:sqlite";
  const database = new DatabaseSync(process.argv[1]);
  database.exec("PRAGMA busy_timeout = 5000");
  database.prepare("UPDATE repositories SET version = 1 WHERE id = ?").run(process.argv[2]);
  database.close();
`;
const snapshotRepositoryId = "01900000-0000-7000-8000-000000000001";
const snapshotHostId = "01900000-0000-7000-8000-000000000002";
const planRepositoryId = "01900000-0000-7000-8000-000000000010";
const planHostId = "01900000-0000-7000-8000-000000000011";
const planTreeId = "01900000-0000-7000-8000-000000000012";
const planRevisionId = "01900000-0000-7000-8000-000000000013";
const planRootNodeId = "01900000-0000-7000-8000-000000000014";
const planRootArtifactId = "01900000-0000-7000-8000-000000000015";
const planAttentionId = "01900000-0000-7000-8000-000000000016";
const secondAttentionId = "01900000-0000-7000-8000-000000000017";
const planBaseCommit = "0123456789abcdef0123456789abcdef01234567";
const harnessAttemptId = "01900000-0000-7000-8000-000000000020";
const secondHarnessAttemptId = "01900000-0000-7000-8000-000000000021";
const harnessLeaseId = "01900000-0000-7000-8000-000000000030";
const secondHarnessLeaseId = "01900000-0000-7000-8000-000000000031";
const harnessSessionId = "harness-session-1";
const secondHarnessSessionId = "harness-session-2";
const harnessPolicyDigest = "a".repeat(64);
const schedulerChildNodeId = "01900000-0000-7000-8000-000000000040";
const schedulerSecondChildNodeId = "01900000-0000-7000-8000-000000000041";
const schedulerThirdChildNodeId = "01900000-0000-7000-8000-000000000042";
const schedulerChildArtifactId = "01900000-0000-7000-8000-000000000043";
const schedulerSecondChildArtifactId = "01900000-0000-7000-8000-000000000044";
const schedulerThirdChildArtifactId = "01900000-0000-7000-8000-000000000045";
const schedulerChildAttemptId = "01900000-0000-7000-8000-000000000050";
const schedulerSecondChildAttemptId = "01900000-0000-7000-8000-000000000051";
const schedulerThirdChildAttemptId = "01900000-0000-7000-8000-000000000052";
const schedulerRootLeaseId = "01900000-0000-7000-8000-000000000060";
const schedulerSecondRootLeaseId = "01900000-0000-7000-8000-000000000061";
const schedulerChildLeaseId = "01900000-0000-7000-8000-000000000062";
const schedulerSecondChildLeaseId = "01900000-0000-7000-8000-000000000063";
const schedulerThirdChildLeaseId = "01900000-0000-7000-8000-000000000064";
const schedulerInvalidLeaseId = "01900000-0000-7000-8000-000000000065";
const schedulerOwnerId = "scheduler-owner-1";
const schedulerSecondOwnerId = "scheduler-owner-2";

const migrationCases = [
  {
    kind: "host",
    table: "content_blobs",
    open: openHostDatabase,
    migrations: hostMigrations,
  },
  {
    kind: "supervisor",
    table: "paired_devices",
    open: openSupervisorDatabase,
    migrations: supervisorMigrations,
  },
] as const;
const hostV1 = requireMigration(hostMigrations, 0, "host migration v1");

function requireMigration(
  migrations: readonly SqliteMigration[],
  index: number,
  label: string,
): SqliteMigration {
  const migration = migrations[index];
  if (migration === undefined) {
    throw new Error(`${label} is missing`);
  }
  return migration;
}

function expectedHistory(
  migrations: readonly SqliteMigration[],
  appliedAtMs: number,
): readonly Record<string, unknown>[] {
  return migrations.map((migration) => ({
    version: BigInt(migration.version),
    name: migration.name,
    checksum: migration.checksum,
    applied_at_ms: BigInt(appliedAtMs),
  }));
}

function readConnectionPolicy(database: ManagedSqliteDatabase): Record<string, unknown> {
  return database.read((reader) => ({
    journalMode: reader.get("PRAGMA journal_mode")?.["journal_mode"],
    foreignKeys: reader.get("PRAGMA foreign_keys")?.["foreign_keys"],
    synchronous: reader.get("PRAGMA synchronous")?.["synchronous"],
    trustedSchema: reader.get("PRAGMA trusted_schema")?.["trusted_schema"],
    busyTimeout: reader.get("PRAGMA busy_timeout")?.["timeout"],
  }));
}

function withReadOnlyDatabase<T>(path: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readBigInts: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function createHostV1Fixture(path: string, appliedAtMs: number, checksum: string): void {
  const migration = hostV1;
  const database = new DatabaseSync(path);
  try {
    database.exec(migration.sql);
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(migration.version, migration.name, checksum, appliedAtMs);
  } finally {
    database.close();
  }
}

function createHostV4HarnessFixture(path: string, appliedAtMs: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of hostMigrations.slice(0, 4)) {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, migration.checksum, appliedAtMs);
    }
    database.exec("BEGIN");
    database
      .prepare(
        "INSERT INTO repositories (id, host_id, root_path, version, registered_at_ms, archived_at_ms) VALUES (?, ?, ?, 0, ?, NULL)",
      )
      .run(planRepositoryId, planHostId, "/workspace/plan", appliedAtMs);
    database
      .prepare(
        `INSERT INTO trees (
           id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
           root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      )
      .run(
        planTreeId,
        planRepositoryId,
        planHostId,
        planBaseCommit,
        "plan foundation",
        planRevisionId,
        planRootNodeId,
        appliedAtMs,
        appliedAtMs,
      );
    database
      .prepare(
        `INSERT INTO plan_revisions (
           id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
           approved_at_ms, superseded_at_ms
         ) VALUES (?, ?, 1, ?, 'draft', 0, ?, NULL, NULL)`,
      )
      .run(planRevisionId, planTreeId, "plan foundation", appliedAtMs);
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
         ) VALUES (?, ?, ?, ?, NULL, ?, 'plan', ?, 'artifact', ?, 'plan',
           'planned', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        planRootNodeId,
        planTreeId,
        planRepositoryId,
        planHostId,
        planRevisionId,
        "plan foundation",
        planRootArtifactId,
        appliedAtMs,
        appliedAtMs,
      );
    database
      .prepare(
        "INSERT INTO node_acceptance_criteria (node_id, ordinal, criterion) VALUES (?, 0, ?)",
      )
      .run(planRootNodeId, "plan foundation");
    database
      .prepare(
        `INSERT INTO attempts (
           id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
           state_kind, version, started_at_ms, finished_at_ms, evidence_id
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 0, ?, NULL, NULL)`,
      )
      .run(
        harnessAttemptId,
        planRootNodeId,
        planTreeId,
        planRepositoryId,
        planHostId,
        planRevisionId,
        appliedAtMs,
      );
    database
      .prepare(
        `INSERT INTO harness_bindings (
           attempt_id, harness_kind, provider_kind, model, session_id, policy_digest,
           established_at_ms, finished_at_ms
         ) VALUES (?, 'codex', 'openai', 'gpt-5', ?, ?, ?, NULL)`,
      )
      .run(harnessAttemptId, harnessSessionId, harnessPolicyDigest, appliedAtMs);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

function createHostV5SchedulerFixture(path: string, appliedAtMs: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of hostMigrations.slice(0, 5)) {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, migration.checksum, appliedAtMs);
    }
    database
      .prepare(
        "INSERT INTO repositories (id, host_id, root_path, version, registered_at_ms, archived_at_ms) VALUES (?, ?, ?, 0, ?, NULL)",
      )
      .run(planRepositoryId, planHostId, "/workspace/plan", appliedAtMs);
  } finally {
    database.close();
  }
}

function tamperHostV1Checksum(path: string, checksum: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(checksum);
  } finally {
    database.close();
  }
}

async function expectSqliteFailure(
  operation: () => Promise<unknown>,
  expectedCode: SqliteDatabaseErrorCode,
): Promise<void> {
  const rejection = await operation().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(SqliteDatabaseError);
  expect(rejection).toMatchObject({ code: expectedCode });
}

async function seedPlanFoundation(database: TestManagedSqliteDatabase): Promise<void> {
  await database.write((transaction) => {
    transaction.run(
      "INSERT INTO repositories (id, host_id, root_path, version, registered_at_ms, archived_at_ms) VALUES (?, ?, ?, 0, ?, NULL)",
      [planRepositoryId, planHostId, "/workspace/plan", fixedTimestamp],
    );
    transaction.run(
      `INSERT INTO trees (
         id, repository_id, host_id, base_commit, goal, active_plan_revision_id,
         root_node_id, version, created_at_ms, updated_at_ms, archived_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      [
        planTreeId,
        planRepositoryId,
        planHostId,
        planBaseCommit,
        "plan foundation",
        planRevisionId,
        planRootNodeId,
        fixedTimestamp,
        fixedTimestamp,
      ],
    );
    transaction.run(
      `INSERT INTO plan_revisions (
         id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
         approved_at_ms, superseded_at_ms
       ) VALUES (?, ?, 1, ?, 'draft', 0, ?, NULL, NULL)`,
      [planRevisionId, planTreeId, "plan foundation", fixedTimestamp],
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
       ) VALUES (?, ?, ?, ?, NULL, ?, 'plan', ?, 'artifact', ?, 'plan',
         'planned', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, 0, ?, ?)`,
      [
        planRootNodeId,
        planTreeId,
        planRepositoryId,
        planHostId,
        planRevisionId,
        "plan foundation",
        planRootArtifactId,
        fixedTimestamp,
        fixedTimestamp,
      ],
    );
    transaction.run(
      "INSERT INTO node_acceptance_criteria (node_id, ordinal, criterion) VALUES (?, 0, ?)",
      [planRootNodeId, "plan foundation"],
    );
  });
}

async function seedHarnessContract(database: TestManagedSqliteDatabase): Promise<void> {
  await seedPlanFoundation(database);
  await database.write((transaction) => {
    transaction.run(
      `INSERT INTO attempts (
         id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
         state_kind, version, started_at_ms, finished_at_ms, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 0, ?, NULL, NULL)`,
      [
        harnessAttemptId,
        planRootNodeId,
        planTreeId,
        planRepositoryId,
        planHostId,
        planRevisionId,
        fixedTimestamp,
      ],
    );
    transaction.run(
      `INSERT INTO attempts (
         id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
         state_kind, version, started_at_ms, finished_at_ms, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, 2, 'active', 0, ?, NULL, NULL)`,
      [
        secondHarnessAttemptId,
        planRootNodeId,
        planTreeId,
        planRepositoryId,
        planHostId,
        planRevisionId,
        fixedTimestamp + 1,
      ],
    );
    transaction.run(
      `INSERT INTO harness_bindings (
         attempt_id, harness_kind, provider_kind, model, session_id, policy_digest,
         established_at_ms, finished_at_ms
       ) VALUES (?, 'codex', 'openai', 'gpt-5', ?, ?, ?, NULL)`,
      [harnessAttemptId, harnessSessionId, harnessPolicyDigest, fixedTimestamp],
    );
    transaction.run(
      `INSERT INTO harness_bindings (
         attempt_id, harness_kind, provider_kind, model, session_id, policy_digest,
         established_at_ms, finished_at_ms
       ) VALUES (?, 'codex', 'openai', 'gpt-5', ?, ?, ?, NULL)`,
      [secondHarnessAttemptId, secondHarnessSessionId, harnessPolicyDigest, fixedTimestamp + 1],
    );
  });
}

async function seedSchedulerChildren(database: TestManagedSqliteDatabase): Promise<void> {
  const children = [
    {
      nodeId: schedulerChildNodeId,
      artifactId: schedulerChildArtifactId,
      attemptId: schedulerChildAttemptId,
      objective: "scheduler child",
    },
    {
      nodeId: schedulerSecondChildNodeId,
      artifactId: schedulerSecondChildArtifactId,
      attemptId: schedulerSecondChildAttemptId,
      objective: "scheduler second child",
    },
    {
      nodeId: schedulerThirdChildNodeId,
      artifactId: schedulerThirdChildArtifactId,
      attemptId: schedulerThirdChildAttemptId,
      objective: "scheduler third child",
    },
  ] as const;
  await database.write((transaction) => {
    for (const child of children) {
      transaction.run(
        `INSERT INTO nodes (
           id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
           mode, objective, output_kind, output_artifact_id, output_artifact_type,
           state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
           blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
           outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
           outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
           version, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 'plan', ?, 'artifact', ?, 'plan',
           'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, 0, ?, ?)`,
        [
          child.nodeId,
          planTreeId,
          planRepositoryId,
          planHostId,
          planRootNodeId,
          planRevisionId,
          child.objective,
          child.artifactId,
          fixedTimestamp,
          fixedTimestamp,
        ],
      );
      transaction.run(
        `INSERT INTO attempts (
           id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal,
           state_kind, version, started_at_ms, finished_at_ms, evidence_id
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 0, ?, NULL, NULL)`,
        [
          child.attemptId,
          child.nodeId,
          planTreeId,
          planRepositoryId,
          planHostId,
          planRevisionId,
          fixedTimestamp,
        ],
      );
    }
  });
}

describe("SQLite migration integration", () => {
  it.each(migrationCases)(
    "migrates an empty $kind database to v6 with policy and persistent history",
    async ({ kind, table, open, migrations }) => {
      const clock = new FixedClock(fixedTimestamp);
      const temporary = await TemporarySqliteDatabase.create(kind, clock);
      try {
        expect(temporary.database.migration).toEqual({
          databaseKind: kind,
          previousVersion: 0,
          currentVersion: migrations.length,
          appliedVersions: migrations.map(({ version }) => version),
          backupPath: null,
        });
        expect(readConnectionPolicy(temporary.database)).toEqual({
          journalMode: "wal",
          foreignKeys: 1n,
          synchronous: 2n,
          trustedSchema: 0n,
          busyTimeout: 5_000n,
        });
        expect(
          temporary.database.read((reader) =>
            reader.all(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            ),
          ),
        ).toEqual(expectedHistory(migrations, fixedTimestamp));
        expect(
          temporary.database.read(
            (reader) => reader.get(`SELECT COUNT(*) AS count FROM ${table}`)?.["count"],
          ),
        ).toBe(0n);
        await expectSqliteFailure(
          () =>
            temporary.database.write((transaction) => {
              transaction.run("DELETE FROM sqlite_sequence");
            }),
          "transaction_failed",
        );
        await expectSqliteFailure(
          () =>
            temporary.database.write((transaction) => {
              transaction.run("UPDATE schema_migrations SET checksum = ?", ["f".repeat(64)]);
            }),
          "transaction_failed",
        );

        await expectSqliteFailure(
          () => open({ path: temporary.path, clock: new FixedClock(fixedTimestamp) }),
          "database_already_open",
        );
        const hardLinkPath = join(temporary.directory, `${kind}-hard-link.db`);
        await link(temporary.path, hardLinkPath);
        await expectSqliteFailure(
          () => open({ path: hardLinkPath, clock: new FixedClock(fixedTimestamp) }),
          "database_already_open",
        );
        await temporary.database.close();
        const reopened = await open({ path: temporary.path, clock });
        try {
          expect(reopened.migration).toEqual({
            databaseKind: kind,
            previousVersion: migrations.length,
            currentVersion: migrations.length,
            appliedVersions: [],
            backupPath: null,
          });
          expect(readConnectionPolicy(reopened)).toEqual({
            journalMode: "wal",
            foreignKeys: 1n,
            synchronous: 2n,
            trustedSchema: 0n,
            busyTimeout: 5_000n,
          });
          expect(
            reopened.read((reader) =>
              reader.all(
                "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
              ),
            ),
          ).toEqual(expectedHistory(migrations, fixedTimestamp));
          expect(
            reopened.read(
              (reader) => reader.get(`SELECT COUNT(*) AS count FROM ${table}`)?.["count"],
            ),
          ).toBe(0n);
        } finally {
          await reopened.close();
        }
      } finally {
        await temporary.dispose();
      }
    },
  );

  it("backs up an existing host v1 database before applying later migrations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      const v1 = hostV1;
      createHostV1Fixture(path, fixedTimestamp, v1.checksum);
      const database = await openHostDatabase({
        path,
        clock: new FixedClock(fixedTimestamp),
        backupPath,
      });
      try {
        expect(database.migration).toEqual({
          databaseKind: "host",
          previousVersion: 1,
          currentVersion: 6,
          appliedVersions: [2, 3, 4, 5, 6],
          backupPath: resolve(backupPath),
        });
        expect(
          database.read((reader) =>
            reader.all(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            ),
          ),
        ).toEqual(expectedHistory(hostMigrations, fixedTimestamp));
        expect(
          database.read(
            (reader) => reader.get("SELECT COUNT(*) AS count FROM content_blobs")?.["count"],
          ),
        ).toBe(0n);
      } finally {
        await database.close();
      }

      expect(
        withReadOnlyDatabase(backupPath, (backup) =>
          backup
            .prepare(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            )
            .all(),
        ),
      ).toEqual(expectedHistory([v1], fixedTimestamp));
      expect(
        withReadOnlyDatabase(backupPath, (backup) =>
          backup
            .prepare(
              "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'content_blobs'",
            )
            .get(),
        ),
      ).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a populated v4 database with legacy harness bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      createHostV4HarnessFixture(path, fixedTimestamp);
      await expectSqliteFailure(
        () =>
          openHostDatabase({
            path,
            clock: new FixedClock(fixedTimestamp),
            backupPath,
          }),
        "migration_failed",
      );
      const state = withReadOnlyDatabase(path, (database) => ({
        history: database
          .prepare(
            "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
          )
          .all(),
        harnessBinding: database
          .prepare(
            "SELECT attempt_id, model, policy_digest FROM harness_bindings WHERE attempt_id = ?",
          )
          .get(harnessAttemptId),
        attempt: database
          .prepare("SELECT id, state_kind FROM attempts WHERE id = ?")
          .get(harnessAttemptId),
        nodeHarnessTable: database
          .prepare(
            "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'node_harness_bindings'",
          )
          .get(),
        snapshotTable: database
          .prepare(
            "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'harness_attempt_snapshots'",
          )
          .get(),
        leaseTable: database
          .prepare(
            "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'harness_process_leases'",
          )
          .get(),
      }));
      expect(state.history).toEqual(expectedHistory(hostMigrations.slice(0, 4), fixedTimestamp));
      expect(state.harnessBinding).toEqual({
        attempt_id: harnessAttemptId,
        model: "gpt-5",
        policy_digest: harnessPolicyDigest,
      });
      expect(state.attempt).toEqual({ id: harnessAttemptId, state_kind: "active" });
      expect(state.nodeHarnessTable).toBeUndefined();
      expect(state.snapshotTable).toBeUndefined();
      expect(state.leaseTable).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rolls back a failed host v2 migration after an unversioned table conflict", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      const v1 = hostV1;
      createHostV1Fixture(path, fixedTimestamp, v1.checksum);
      const conflictingDatabase = new DatabaseSync(path);
      try {
        conflictingDatabase.exec("CREATE TABLE harness_bindings (attempt_id TEXT)");
      } finally {
        conflictingDatabase.close();
      }
      await expectSqliteFailure(
        () =>
          openHostDatabase({
            path,
            clock: new FixedClock(fixedTimestamp),
            backupPath,
          }),
        "migration_failed",
      );

      const state = withReadOnlyDatabase(path, (database) => ({
        history: database
          .prepare(
            "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
          )
          .all(),
        contentBlobs: database
          .prepare(
            "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'content_blobs'",
          )
          .get(),
        artifacts: database
          .prepare(
            "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'artifacts'",
          )
          .get(),
        harnessRows: database.prepare("SELECT COUNT(*) AS count FROM harness_bindings").get()?.[
          "count"
        ],
      }));
      expect(state.history).toEqual(expectedHistory([v1], fixedTimestamp));
      expect(state.contentBlobs).toBeUndefined();
      expect(state.artifacts).toBeUndefined();
      expect(state.harnessRows).toBe(0n);
      expect(
        withReadOnlyDatabase(backupPath, (backup) =>
          backup
            .prepare(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            )
            .all(),
        ),
      ).toEqual(expectedHistory([v1], fixedTimestamp));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("requires a backup path before migrating an existing host v1 database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-migration-"));
    const path = join(directory, "host.db");
    try {
      const v1 = hostV1;
      createHostV1Fixture(path, fixedTimestamp, v1.checksum);
      await expectSqliteFailure(
        () => openHostDatabase({ path, clock: new FixedClock(fixedTimestamp) }),
        "backup_required",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects an existing backup target before migrating an existing host v1 database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      const v1 = hostV1;
      createHostV1Fixture(path, fixedTimestamp, v1.checksum);
      await writeFile(backupPath, "existing backup target");
      await expectSqliteFailure(
        () => openHostDatabase({ path, clock: new FixedClock(fixedTimestamp), backupPath }),
        "backup_exists",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a tampered applied checksum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-migration-"));
    const path = join(directory, "host.db");
    try {
      const v1 = hostV1;
      createHostV1Fixture(path, fixedTimestamp, v1.checksum);
      tamperHostV1Checksum(path, "0".repeat(64));
      await expectSqliteFailure(
        () => openHostDatabase({ path, clock: new FixedClock(fixedTimestamp) }),
        "checksum_mismatch",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a valid forward migration history record without mutation", async () => {
    const clock = new FixedClock(fixedTimestamp);
    const temporary = await TemporarySqliteDatabase.create("host", clock);
    try {
      await temporary.database.close();
      const futureDatabase = new DatabaseSync(temporary.path);
      try {
        futureDatabase
          .prepare(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
          )
          .run(7, "future_state", "f".repeat(64), fixedTimestamp);
      } finally {
        futureDatabase.close();
      }
      await expectSqliteFailure(
        () => openHostDatabase({ path: temporary.path, clock }),
        "database_newer",
      );
      expect(
        withReadOnlyDatabase(temporary.path, (database) =>
          database
            .prepare(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            )
            .all(),
        ),
      ).toEqual([
        ...expectedHistory(hostMigrations, fixedTimestamp),
        {
          version: 7n,
          name: "future_state",
          checksum: "f".repeat(64),
          applied_at_ms: BigInt(fixedTimestamp),
        },
      ]);
      expect(
        withReadOnlyDatabase(
          temporary.path,
          (database) =>
            database.prepare("SELECT COUNT(*) AS count FROM content_blobs").get()?.["count"],
        ),
      ).toBe(0n);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects a copied database with a corrupted SQLite header", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-migration-"));
    const sourcePath = join(directory, "host.db");
    const corruptPath = join(directory, "host-corrupt.db");
    try {
      const v1 = hostV1;
      createHostV1Fixture(sourcePath, fixedTimestamp, v1.checksum);
      await copyFile(sourcePath, corruptPath);
      const corruptedHeader = await readFile(corruptPath);
      corruptedHeader[0] = 0;
      await writeFile(corruptPath, corruptedHeader);
      await expectSqliteFailure(
        () => openHostDatabase({ path: corruptPath, clock: new FixedClock(fixedTimestamp) }),
        "database_corrupt",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("SQLite v6 scheduler lease schema", () => {
  it("creates scheduler lease tables, indexes, and triggers on a fresh host database", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      expect(temporary.database.migration).toEqual({
        databaseKind: "host",
        previousVersion: 0,
        currentVersion: 6,
        appliedVersions: [1, 2, 3, 4, 5, 6],
        backupPath: null,
      });
      expect(
        temporary.database.read((reader) =>
          reader.all(
            `SELECT type, name
             FROM sqlite_schema
             WHERE name IN (
               'node_scheduler_fences',
               'scheduler_leases',
               'scheduler_leases_one_active_per_node',
               'scheduler_leases_active_expiry',
               'scheduler_leases_owner_active',
               'node_scheduler_fence_identity_is_immutable',
               'node_scheduler_fence_cannot_decrease',
               'node_scheduler_fence_is_durable',
               'scheduler_lease_identity_is_immutable',
               'scheduler_lease_heartbeat_is_monotonic',
               'scheduler_lease_state_transition_is_legal',
               'scheduler_lease_is_durable'
             )
             ORDER BY type, name`,
          ),
        ),
      ).toEqual([
        { type: "index", name: "scheduler_leases_active_expiry" },
        { type: "index", name: "scheduler_leases_one_active_per_node" },
        { type: "index", name: "scheduler_leases_owner_active" },
        { type: "table", name: "node_scheduler_fences" },
        { type: "table", name: "scheduler_leases" },
        { type: "trigger", name: "node_scheduler_fence_cannot_decrease" },
        { type: "trigger", name: "node_scheduler_fence_identity_is_immutable" },
        { type: "trigger", name: "node_scheduler_fence_is_durable" },
        { type: "trigger", name: "scheduler_lease_heartbeat_is_monotonic" },
        { type: "trigger", name: "scheduler_lease_identity_is_immutable" },
        { type: "trigger", name: "scheduler_lease_is_durable" },
        { type: "trigger", name: "scheduler_lease_state_transition_is_legal" },
      ]);
      expect(
        temporary.database.read((reader) =>
          reader.all(
            "SELECT COUNT(*) AS fences FROM node_scheduler_fences CROSS JOIN scheduler_leases",
          ),
        ),
      ).toEqual([{ fences: 0n }]);
    } finally {
      await temporary.dispose();
    }
  });

  it("upgrades a v5 host database and preserves existing rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-scheduler-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      createHostV5SchedulerFixture(path, fixedTimestamp);
      const database = await openHostDatabase({
        path,
        clock: new FixedClock(fixedTimestamp),
        backupPath,
      });
      try {
        expect(database.migration).toEqual({
          databaseKind: "host",
          previousVersion: 5,
          currentVersion: 6,
          appliedVersions: [6],
          backupPath: resolve(backupPath),
        });
        expect(
          database.read((reader) =>
            reader.get("SELECT id, host_id, root_path, version FROM repositories WHERE id = ?", [
              planRepositoryId,
            ]),
          ),
        ).toEqual({
          id: planRepositoryId,
          host_id: planHostId,
          root_path: "/workspace/plan",
          version: 0n,
        });
        expect(
          database.read((reader) =>
            reader.all(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            ),
          ),
        ).toEqual(expectedHistory(hostMigrations, fixedTimestamp));
        expect(
          database.read((reader) =>
            reader.all(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('node_scheduler_fences', 'scheduler_leases') ORDER BY name",
            ),
          ),
        ).toEqual([{ name: "node_scheduler_fences" }, { name: "scheduler_leases" }]);
      } finally {
        await database.close();
      }
      expect(
        withReadOnlyDatabase(backupPath, (backup) =>
          backup
            .prepare(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            )
            .all(),
        ),
      ).toEqual(expectedHistory(hostMigrations.slice(0, 5), fixedTimestamp));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("enforces lease capacity, composite identities, fencing history, and legal transitions", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      await seedHarnessContract(temporary.database);
      await seedSchedulerChildren(temporary.database);
      await temporary.database.write((transaction) => {
        transaction.run(
          "INSERT INTO node_scheduler_fences (node_id, next_fencing_token) VALUES (?, 1)",
          [planRootNodeId],
        );
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE node_scheduler_fences SET next_fencing_token = 2 WHERE node_id = ?",
          [planRootNodeId],
        );
      });
      expect(
        temporary.database.read((reader) =>
          reader.get("SELECT next_fencing_token FROM node_scheduler_fences WHERE node_id = ?", [
            planRootNodeId,
          ]),
        ),
      ).toEqual({ next_fencing_token: 2n });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_scheduler_fences SET next_fencing_token = 2 WHERE node_id = ?",
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_scheduler_fences SET next_fencing_token = 1 WHERE node_id = ?",
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE node_scheduler_fences SET node_id = ? WHERE node_id = ?", [
              schedulerChildNodeId,
              planRootNodeId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM node_scheduler_fences WHERE node_id = ?", [
              planRootNodeId,
            ]);
          }),
        "transaction_failed",
      );

      const insertLease = async (
        id: string,
        attemptId: string,
        nodeId: string,
        ownerId: string,
        fencingToken = 1,
        acquiredAtMs: number = fixedTimestamp,
      ): Promise<void> => {
        await temporary.database.write((transaction) => {
          transaction.run(
            `INSERT INTO scheduler_leases (
               id, attempt_id, node_id, tree_id, repository_id, host_id, owner_id,
               fencing_token, state_kind, acquired_at_ms, heartbeat_at_ms, expires_at_ms,
               released_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
            [
              id,
              attemptId,
              nodeId,
              planTreeId,
              planRepositoryId,
              planHostId,
              ownerId,
              fencingToken,
              acquiredAtMs,
              acquiredAtMs,
              acquiredAtMs + 100,
            ],
          );
        });
      };

      await insertLease(schedulerRootLeaseId, harnessAttemptId, planRootNodeId, schedulerOwnerId);
      await expectSqliteFailure(
        () =>
          insertLease(
            schedulerInvalidLeaseId,
            secondHarnessAttemptId,
            schedulerChildNodeId,
            schedulerSecondOwnerId,
          ),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          insertLease(
            schedulerSecondRootLeaseId,
            secondHarnessAttemptId,
            planRootNodeId,
            schedulerSecondOwnerId,
            2,
          ),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE scheduler_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ?",
          [fixedTimestamp + 10, fixedTimestamp + 110, schedulerRootLeaseId],
        );
      });
      expect(
        temporary.database.read((reader) =>
          reader.get(
            "SELECT state_kind, heartbeat_at_ms, expires_at_ms, released_at_ms FROM scheduler_leases WHERE id = ?",
            [schedulerRootLeaseId],
          ),
        ),
      ).toEqual({
        state_kind: "active",
        heartbeat_at_ms: BigInt(fixedTimestamp + 10),
        expires_at_ms: BigInt(fixedTimestamp + 110),
        released_at_ms: null,
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE scheduler_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ?",
              [fixedTimestamp + 10, fixedTimestamp + 120, schedulerRootLeaseId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE scheduler_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ?",
              [fixedTimestamp + 9, fixedTimestamp + 119, schedulerRootLeaseId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE scheduler_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ?",
              [fixedTimestamp + 20, fixedTimestamp + 20, schedulerRootLeaseId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE scheduler_leases SET state_kind = 'released', released_at_ms = ? WHERE id = ?",
          [fixedTimestamp + 20, schedulerRootLeaseId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE scheduler_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ?",
              [fixedTimestamp + 30, fixedTimestamp + 130, schedulerRootLeaseId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE scheduler_leases SET state_kind = 'expired', released_at_ms = ? WHERE id = ?",
              [fixedTimestamp + 30, schedulerRootLeaseId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE scheduler_leases SET owner_id = ? WHERE id = ?", [
              "changed-owner",
              schedulerRootLeaseId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE scheduler_leases SET fencing_token = ? WHERE id = ?", [
              3,
              schedulerRootLeaseId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM scheduler_leases WHERE id = ?", [schedulerRootLeaseId]);
          }),
        "transaction_failed",
      );

      await insertLease(
        schedulerSecondRootLeaseId,
        secondHarnessAttemptId,
        planRootNodeId,
        schedulerSecondOwnerId,
        2,
        fixedTimestamp + 21,
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE scheduler_leases SET state_kind = 'released', released_at_ms = ? WHERE id = ?",
          [fixedTimestamp + 41, schedulerSecondRootLeaseId],
        );
      });

      await insertLease(
        schedulerChildLeaseId,
        schedulerChildAttemptId,
        schedulerChildNodeId,
        schedulerOwnerId,
        1,
        fixedTimestamp + 1,
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE scheduler_leases SET state_kind = 'expired', released_at_ms = ? WHERE id = ?",
          [fixedTimestamp + 31, schedulerChildLeaseId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE scheduler_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ?",
              [fixedTimestamp + 40, fixedTimestamp + 140, schedulerChildLeaseId],
            );
          }),
        "transaction_failed",
      );

      await insertLease(
        schedulerSecondChildLeaseId,
        schedulerSecondChildAttemptId,
        schedulerSecondChildNodeId,
        schedulerOwnerId,
        1,
        fixedTimestamp + 2,
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE scheduler_leases SET state_kind = 'cancelled', released_at_ms = ? WHERE id = ?",
          [fixedTimestamp + 32, schedulerSecondChildLeaseId],
        );
      });

      await insertLease(
        schedulerThirdChildLeaseId,
        schedulerThirdChildAttemptId,
        schedulerThirdChildNodeId,
        schedulerOwnerId,
        1,
        fixedTimestamp + 3,
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE scheduler_leases SET state_kind = 'cancelled', released_at_ms = ? WHERE id = ?",
              [fixedTimestamp + 2, schedulerThirdChildLeaseId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE scheduler_leases SET state_kind = 'cancelled', released_at_ms = ? WHERE id = ?",
          [fixedTimestamp + 33, schedulerThirdChildLeaseId],
        );
      });
      expect(
        temporary.database.read((reader) =>
          reader.all(
            "SELECT id, node_id, state_kind, released_at_ms FROM scheduler_leases ORDER BY id",
          ),
        ),
      ).toEqual([
        {
          id: schedulerRootLeaseId,
          node_id: planRootNodeId,
          state_kind: "released",
          released_at_ms: BigInt(fixedTimestamp + 20),
        },
        {
          id: schedulerSecondRootLeaseId,
          node_id: planRootNodeId,
          state_kind: "released",
          released_at_ms: BigInt(fixedTimestamp + 41),
        },
        {
          id: schedulerChildLeaseId,
          node_id: schedulerChildNodeId,
          state_kind: "expired",
          released_at_ms: BigInt(fixedTimestamp + 31),
        },
        {
          id: schedulerSecondChildLeaseId,
          node_id: schedulerSecondChildNodeId,
          state_kind: "cancelled",
          released_at_ms: BigInt(fixedTimestamp + 32),
        },
        {
          id: schedulerThirdChildLeaseId,
          node_id: schedulerThirdChildNodeId,
          state_kind: "cancelled",
          released_at_ms: BigInt(fixedTimestamp + 33),
        },
      ]);
    } finally {
      await temporary.dispose();
    }
  });
});

describe("SQLite v4 plan foundation", () => {
  it("enforces structural budgets, ordered scope policies, attention resolution, and immutable definitions", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      await seedPlanFoundation(temporary.database);
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO tree_budgets (
                 tree_id, max_depth, max_fan_out, max_nodes, max_concurrency, max_attempts_per_node
               ) VALUES (?, 1, 1, 2, 1, 1)`,
              [planTreeId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO tree_budgets (
             tree_id, max_depth, max_fan_out, max_nodes, max_concurrency, max_attempts_per_node
           ) VALUES (?, 2, 1, 2, 1, 1)`,
          [planTreeId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO node_repository_scope (node_id, ordinal, repository_path)
               VALUES (?, 0, '')`,
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO node_repository_scope (node_id, ordinal, repository_path)
           VALUES (?, 1, 'tests')`,
          [planRootNodeId],
        );
        transaction.run(
          `INSERT INTO node_repository_scope (node_id, ordinal, repository_path)
           VALUES (?, 0, 'src')`,
          [planRootNodeId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO node_plan_policies (node_id, check_profile, max_attempts)
               VALUES (?, '', 1)`,
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO node_plan_policies (node_id, check_profile, max_attempts)
               VALUES (?, 'event', 0)`,
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO node_plan_policies (node_id, check_profile, max_attempts)
           VALUES (?, 'event', 1)`,
          [planRootNodeId],
        );
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO plan_attentions (
             id, tree_id, plan_revision_id, kind, message, state_kind, created_at_ms, resolved_at_ms
           ) VALUES (?, ?, ?, 'plan_required', 'plan is required', 'open', ?, NULL)`,
          [planAttentionId, planTreeId, planRevisionId, fixedTimestamp],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO plan_attentions (
                 id, tree_id, plan_revision_id, kind, message, state_kind, created_at_ms, resolved_at_ms
               ) VALUES (?, ?, ?, 'repair_required', 'another plan is required', 'open', ?, NULL)`,
              [secondAttentionId, planTreeId, planRevisionId, fixedTimestamp],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE plan_attentions SET state_kind = 'resolved', resolved_at_ms = ? WHERE id = ?",
              [fixedTimestamp - 1, planAttentionId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE plan_attentions SET state_kind = 'resolved', resolved_at_ms = ? WHERE id = ?",
          [fixedTimestamp, planAttentionId],
        );
        transaction.run(
          `INSERT INTO plan_attentions (
             id, tree_id, plan_revision_id, kind, message, state_kind, created_at_ms, resolved_at_ms
           ) VALUES (?, ?, ?, 'repair_required', 'repair is required', 'open', ?, NULL)`,
          [secondAttentionId, planTreeId, planRevisionId, fixedTimestamp],
        );
      });
      expect(
        temporary.database.read((reader) =>
          reader
            .all(
              "SELECT ordinal, repository_path FROM node_repository_scope WHERE node_id = ? ORDER BY ordinal",
              [planRootNodeId],
            )
            .map((row) => [row["ordinal"], row["repository_path"]]),
        ),
      ).toEqual([
        [0n, "src"],
        [1n, "tests"],
      ]);
      expect(
        temporary.database.read((reader) =>
          reader.get(
            "SELECT check_profile, max_attempts FROM node_plan_policies WHERE node_id = ?",
            [planRootNodeId],
          ),
        ),
      ).toEqual({ check_profile: "event", max_attempts: 1n });
      expect(
        temporary.database.read((reader) =>
          reader.get("SELECT max_depth, max_nodes FROM tree_budgets WHERE tree_id = ?", [
            planTreeId,
          ]),
        ),
      ).toEqual({ max_depth: 2n, max_nodes: 2n });
      expect(
        temporary.database.read((reader) =>
          reader.get("SELECT state_kind, resolved_at_ms FROM plan_attentions WHERE id = ?", [
            planAttentionId,
          ]),
        ),
      ).toEqual({ state_kind: "resolved", resolved_at_ms: BigInt(fixedTimestamp) });

      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE tree_budgets SET max_depth = 3 WHERE tree_id = ?", [
              planTreeId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_repository_scope SET repository_path = 'changed' WHERE node_id = ? AND ordinal = 0",
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_plan_policies SET check_profile = 'changed' WHERE node_id = ?",
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE plan_attentions SET message = 'changed' WHERE id = ?", [
              secondAttentionId,
            ]);
          }),
        "transaction_failed",
      );
    } finally {
      await temporary.dispose();
    }
  });
});

describe("SQLite v5 harness contract", () => {
  it("enforces durable identities, immutable attempt snapshots, and process lease lifecycle", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      await seedHarnessContract(temporary.database);
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO node_harness_bindings (
             node_id, harness_kind, provider_kind, durable_harness_id, created_at_ms
           ) VALUES (?, 'codex', 'openai', 'durable-harness-1', ?)`,
          [planRootNodeId, fixedTimestamp],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM node_harness_bindings WHERE node_id = ?", [
              planRootNodeId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT OR REPLACE INTO node_harness_bindings (
                 node_id, harness_kind, provider_kind, durable_harness_id, created_at_ms
               ) VALUES (?, 'codex', 'openai', 'durable-harness-1', ?)`,
              [planRootNodeId, fixedTimestamp],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO node_harness_bindings (
                 node_id, harness_kind, provider_kind, durable_harness_id, created_at_ms
               ) VALUES (?, 'codex', 'openai', 'durable-harness-2', ?)`,
              [planRootNodeId, fixedTimestamp],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_harness_bindings SET durable_harness_id = ? WHERE node_id = ?",
              ["changed-durable-harness", planRootNodeId],
            );
          }),
        "transaction_failed",
      );

      const snapshotInsert = `
        INSERT INTO harness_attempt_snapshots (
          attempt_id, node_id, durable_harness_id, harness_version, model, reasoning_level,
          capabilities_json, tools_json, security_policy_digest, created_at_ms
        ) VALUES (?, ?, ?, '1.0.0', 'gpt-5', 'high', ?, ?, ?, ?)
      `;
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO harness_process_leases (
                 id, attempt_id, node_id, session_id, process_id, state_kind,
                 acquired_at_ms, released_at_ms
               ) VALUES (?, ?, ?, ?, 'process-1', 'active', ?, NULL)`,
              [harnessLeaseId, harnessAttemptId, planRootNodeId, harnessSessionId, fixedTimestamp],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE harness_bindings SET model = 'other' WHERE attempt_id = ?", [
              harnessAttemptId,
            ]);
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["steer"]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE harness_bindings SET policy_digest = ? WHERE attempt_id = ?", [
              "b".repeat(64),
              harnessAttemptId,
            ]);
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["steer"]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE harness_bindings SET provider_kind = 'other' WHERE attempt_id = ?",
              [harnessAttemptId],
            );
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["steer"]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE harness_bindings SET harness_kind = 'other' WHERE attempt_id = ?",
              [harnessAttemptId],
            );
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["steer"]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["steer", 1]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["steer"]',
              '["terminal", {"name":"other"}]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["abort", "unknown"]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '[""]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["resume", "resume"]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["steer", "resume"]',
              '["terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["resume", "steer"]',
              '["terminal", "terminal"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["resume", "steer"]',
              '["z", "a"]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["resume", "steer"]',
              '[""]',
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              "{}",
              "[]",
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              "[]",
              "{}",
              harnessPolicyDigest,
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(snapshotInsert, [
              harnessAttemptId,
              planRootNodeId,
              "durable-harness-1",
              '["steer"]',
              '["terminal"]',
              "A".repeat(64),
              fixedTimestamp,
            ]);
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(snapshotInsert, [
          harnessAttemptId,
          planRootNodeId,
          "durable-harness-1",
          '["resume","steer"]',
          '["terminal"]',
          harnessPolicyDigest,
          fixedTimestamp,
        ]);
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE attempts SET state_kind = 'failed', finished_at_ms = ?, evidence_id = ? WHERE id = ?",
              [fixedTimestamp + 2, planRootArtifactId, secondHarnessAttemptId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(snapshotInsert, [
          secondHarnessAttemptId,
          planRootNodeId,
          "durable-harness-1",
          '["resume","steer"]',
          '["terminal"]',
          harnessPolicyDigest,
          fixedTimestamp + 1,
        ]);
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM harness_attempt_snapshots WHERE attempt_id = ?", [
              harnessAttemptId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT OR REPLACE INTO harness_attempt_snapshots (
                 attempt_id, node_id, durable_harness_id, harness_version, model, reasoning_level,
                 capabilities_json, tools_json, security_policy_digest, created_at_ms
               ) VALUES (?, ?, ?, '1.0.0', 'gpt-5', 'high', ?, ?, ?, ?)`,
              [
                harnessAttemptId,
                planRootNodeId,
                "durable-harness-1",
                '["resume","steer"]',
                '["terminal"]',
                harnessPolicyDigest,
                fixedTimestamp,
              ],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE harness_attempt_snapshots SET model = ? WHERE attempt_id = ?", [
              "changed-model",
              harnessAttemptId,
            ]);
          }),
        "transaction_failed",
      );

      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO harness_process_leases (
             id, attempt_id, node_id, session_id, process_id, state_kind,
             acquired_at_ms, released_at_ms
           ) VALUES (?, ?, ?, ?, 'process-1', 'active', ?, NULL)`,
          [harnessLeaseId, harnessAttemptId, planRootNodeId, harnessSessionId, fixedTimestamp],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE attempts SET state_kind = 'failed', finished_at_ms = ?, evidence_id = ? WHERE id = ?",
              [fixedTimestamp + 1, planRootArtifactId, harnessAttemptId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO harness_process_leases (
                 id, attempt_id, node_id, session_id, process_id, state_kind,
                 acquired_at_ms, released_at_ms
               ) VALUES (?, ?, ?, ?, 'process-2', 'active', ?, NULL)`,
              [
                secondHarnessLeaseId,
                secondHarnessAttemptId,
                planRootNodeId,
                secondHarnessSessionId,
                fixedTimestamp + 1,
              ],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE harness_process_leases SET process_id = ? WHERE id = ?", [
              "changed-process",
              harnessLeaseId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE harness_process_leases SET state_kind = 'active', released_at_ms = NULL WHERE id = ?",
              [harnessLeaseId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO harness_process_leases (
                 id, attempt_id, node_id, session_id, process_id, state_kind,
                 acquired_at_ms, released_at_ms
               ) VALUES (?, ?, ?, ?, 'process-invalid', 'released', ?, NULL)`,
              [
                secondHarnessLeaseId,
                secondHarnessAttemptId,
                planRootNodeId,
                secondHarnessSessionId,
                fixedTimestamp + 1,
              ],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE harness_process_leases SET state_kind = 'released', released_at_ms = ? WHERE id = ?",
          [fixedTimestamp + 1, harnessLeaseId],
        );
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE attempts SET state_kind = 'failed', finished_at_ms = ?, evidence_id = ? WHERE id = ?",
          [fixedTimestamp + 2, planRootArtifactId, harnessAttemptId],
        );
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO harness_process_leases (
             id, attempt_id, node_id, session_id, process_id, state_kind,
             acquired_at_ms, released_at_ms
           ) VALUES (?, ?, ?, ?, 'process-2', 'active', ?, NULL)`,
          [
            secondHarnessLeaseId,
            secondHarnessAttemptId,
            planRootNodeId,
            secondHarnessSessionId,
            fixedTimestamp + 2,
          ],
        );
      });
      expect(
        temporary.database.read((reader) =>
          reader.all("SELECT state_kind, released_at_ms FROM harness_process_leases ORDER BY id"),
        ),
      ).toEqual([
        { state_kind: "released", released_at_ms: BigInt(fixedTimestamp + 1) },
        { state_kind: "active", released_at_ms: null },
      ]);
    } finally {
      await temporary.dispose();
    }
  });
});

describe("SQLite snapshot reads", () => {
  it("pins all projection reads to one transaction while another process commits", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      await temporary.database.write((transaction) => {
        transaction.run(
          "INSERT INTO repositories (id, host_id, root_path, version, registered_at_ms, archived_at_ms) VALUES (?, ?, ?, 0, ?, NULL)",
          [snapshotRepositoryId, snapshotHostId, "/workspace/snapshot", fixedTimestamp],
        );
      });

      const observed = temporary.database.snapshot((reader) => {
        const before = reader.get("SELECT version FROM repositories WHERE id = ?", [
          snapshotRepositoryId,
        ])?.["version"];
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            externalRepositoryUpdate,
            temporary.path,
            snapshotRepositoryId,
          ],
          { stdio: "pipe" },
        );
        const after = reader.get("SELECT version FROM repositories WHERE id = ?", [
          snapshotRepositoryId,
        ])?.["version"];
        return { before, after };
      });

      expect(observed).toEqual({ before: 0n, after: 0n });
      expect(
        temporary.database.read(
          (reader) =>
            reader.get("SELECT version FROM repositories WHERE id = ?", [snapshotRepositoryId])?.[
              "version"
            ],
        ),
      ).toBe(1n);
    } finally {
      await temporary.dispose();
    }
  });
});
