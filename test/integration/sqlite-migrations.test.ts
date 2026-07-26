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
import { executeTestSqliteWrite } from "@minions/adapters/sqlite-test-support";
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
const steeringActorSessionId = "01900000-0000-7000-8000-000000000100";
const steeringCommandId = "01900000-0000-7000-8000-000000000110";
const steeringFailedCommandId = "01900000-0000-7000-8000-000000000111";
const steeringReviewCommandId = "01900000-0000-7000-8000-000000000112";
const steeringAttentionCommandId = "01900000-0000-7000-8000-000000000113";
const steeringAckFailedCommandId = "01900000-0000-7000-8000-000000000114";
const steeringAttentionId = "01900000-0000-7000-8000-000000000120";
const steeringSecondAttentionId = "01900000-0000-7000-8000-000000000121";
const steeringDeliveryToken = "01900000-0000-7000-8000-000000000130";
const steeringFailedDeliveryToken = "01900000-0000-7000-8000-000000000131";
const steeringReviewDeliveryToken = "01900000-0000-7000-8000-000000000132";
const steeringRedeliveryToken = "01900000-0000-7000-8000-000000000133";
const steeringAckFailedDeliveryToken = "01900000-0000-7000-8000-000000000134";
const planContentDigest = "b".repeat(64);
const planEvidenceId = "01900000-0000-7000-8000-000000000018";
const legacyCommitNodeId = "01900000-0000-7000-8000-000000000180";
const legacyNoChangeNodeId = "01900000-0000-7000-8000-000000000181";
const legacyOutcomeArtifactId = "01900000-0000-7000-8000-000000000182";
const legacyArtifactEvidenceId = "01900000-0000-7000-8000-000000000183";
const legacyCommitEvidenceId = "01900000-0000-7000-8000-000000000184";
const legacyNoChangeEvidenceId = "01900000-0000-7000-8000-000000000185";
const legacyOutcomeDigest = "d".repeat(64);
const legacyCommitRevision = "1234567890abcdef1234567890abcdef12345678";
const legacyUnnormalizedNodeId = "01900000-0000-7000-8000-000000000186";
const legacyMismatchedArtifactEvidenceId = "01900000-0000-7000-8000-000000000187";

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

function createHostV6SteeringFixture(path: string, appliedAtMs: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of hostMigrations.slice(0, 6)) {
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

function createHostV7ArtifactsFixture(path: string, appliedAtMs: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of hostMigrations.slice(0, 7)) {
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
        `INSERT INTO content_blobs (
           digest, size_bytes, media_type, relative_path, retention_kind,
           created_at_ms, verified_at_ms
         ) VALUES (?, 7, 'text/plain', ?, 'active', ?, ?)`,
      )
      .run(
        planContentDigest,
        `sha256/${planContentDigest.slice(0, 2)}/${planContentDigest.slice(2, 4)}/${planContentDigest}`,
        appliedAtMs,
        appliedAtMs,
      );
    database
      .prepare(
        `INSERT INTO artifacts (
           id, node_id, attempt_id, tree_id, repository_id, host_id,
           content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'plan', ?, 'active', ?)`,
      )
      .run(
        planRootArtifactId,
        planRootNodeId,
        planTreeId,
        planRepositoryId,
        planHostId,
        planContentDigest,
        planEvidenceId,
        appliedAtMs,
      );
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

function createHostV7OutcomeBackfillFixture(
  path: string,
  appliedAtMs: number,
  artifactEvidenceId = legacyArtifactEvidenceId,
): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of hostMigrations.slice(0, 7)) {
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
      .run(planRepositoryId, planHostId, "/workspace/outcomes", appliedAtMs);
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
        "outcome migration",
        planRevisionId,
        planRootNodeId,
        appliedAtMs,
        appliedAtMs + 4,
      );
    database
      .prepare(
        `INSERT INTO plan_revisions (
           id, tree_id, ordinal, goal, state_kind, version, created_at_ms,
           approved_at_ms, superseded_at_ms
         ) VALUES (?, ?, 1, ?, 'approved', 0, ?, ?, NULL)`,
      )
      .run(planRevisionId, planTreeId, "outcome migration", appliedAtMs, appliedAtMs + 1);
    const insertNode = database.prepare(
      `INSERT INTO nodes (
         id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
         mode, objective, output_kind, output_artifact_id, output_artifact_type,
         state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
         blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
         outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
         outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
         version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertNode.run(
      planRootNodeId,
      planTreeId,
      planRepositoryId,
      planHostId,
      null,
      planRevisionId,
      "plan",
      "artifact outcome",
      "artifact",
      legacyOutcomeArtifactId,
      "report",
      "succeeded",
      null,
      null,
      null,
      null,
      null,
      "artifact",
      legacyOutcomeArtifactId,
      legacyOutcomeDigest,
      "report",
      null,
      legacyArtifactEvidenceId,
      null,
      null,
      null,
      1,
      appliedAtMs,
      appliedAtMs + 2,
    );
    insertNode.run(
      legacyCommitNodeId,
      planTreeId,
      planRepositoryId,
      planHostId,
      planRootNodeId,
      planRevisionId,
      "implementation",
      "commit outcome",
      "implementation",
      null,
      null,
      "succeeded",
      null,
      null,
      null,
      null,
      null,
      "commit",
      null,
      null,
      null,
      legacyCommitRevision,
      legacyCommitEvidenceId,
      null,
      null,
      null,
      1,
      appliedAtMs + 3,
      appliedAtMs + 5,
    );
    insertNode.run(
      legacyNoChangeNodeId,
      planTreeId,
      planRepositoryId,
      planHostId,
      legacyCommitNodeId,
      planRevisionId,
      "implementation",
      "no-change outcome",
      "implementation",
      null,
      null,
      "succeeded",
      null,
      null,
      null,
      null,
      null,
      "no_change",
      null,
      null,
      null,
      null,
      legacyNoChangeEvidenceId,
      "legacy unchanged",
      null,
      null,
      1,
      appliedAtMs + 6,
      appliedAtMs + 8,
    );
    database
      .prepare(
        "INSERT INTO node_acceptance_criteria (node_id, ordinal, criterion) VALUES (?, 0, ?)",
      )
      .run(planRootNodeId, "outcome migration");
    database
      .prepare(
        `INSERT INTO content_blobs (
           digest, size_bytes, media_type, relative_path, retention_kind,
           created_at_ms, verified_at_ms
         ) VALUES (?, 7, 'text/plain', ?, 'active', ?, ?)`,
      )
      .run(
        legacyOutcomeDigest,
        `sha256/${legacyOutcomeDigest.slice(0, 2)}/${legacyOutcomeDigest.slice(2, 4)}/${legacyOutcomeDigest}`,
        appliedAtMs + 2,
        appliedAtMs + 2,
      );
    database
      .prepare(
        `INSERT INTO artifacts (
           id, node_id, attempt_id, tree_id, repository_id, host_id,
           content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'report', ?, 'active', ?)`,
      )
      .run(
        legacyOutcomeArtifactId,
        planRootNodeId,
        planTreeId,
        planRepositoryId,
        planHostId,
        legacyOutcomeDigest,
        artifactEvidenceId,
        appliedAtMs + 2,
      );
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

function createHostV9TranscriptFixture(path: string, appliedAtMs: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of hostMigrations.slice(0, 9)) {
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

function createHostV10CheckpointFixture(path: string, appliedAtMs: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of hostMigrations.slice(0, 10)) {
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
    database
      .prepare(
        `INSERT INTO attempt_transcript_chunks (
           attempt_id, sequence, occurred_at_ms, payload_kind, payload_json, recorded_at_ms
         ) VALUES (?, 0, ?, 'message', '{}', ?)`,
      )
      .run(harnessAttemptId, appliedAtMs, appliedAtMs);
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
    "migrates an empty $kind database to its latest version with policy and persistent history",
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
          currentVersion: 11,
          appliedVersions: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
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
          .run(12, "future_state", "f".repeat(64), fixedTimestamp);
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
          version: 12n,
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

describe("SQLite v7 durable steering schema", () => {
  it("creates durable steering tables, indexes, and triggers on a fresh host database", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      expect(temporary.database.migration).toEqual({
        databaseKind: "host",
        previousVersion: 0,
        currentVersion: 11,
        appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        backupPath: null,
      });
      expect(
        temporary.database.read((reader) =>
          reader.all(
            `SELECT type, name
               FROM sqlite_schema
              WHERE name IN (
                'node_command_sequences',
                'node_command_deliveries',
                'node_attention_records',
                'node_command_deliveries_node_state',
                'node_attention_records_node_state',
                'node_command_sequence_is_monotonic',
                'node_command_sequence_is_durable',
                'node_command_delivery_identity_is_immutable',
                'node_command_delivery_initial_state_is_queued',
                'node_command_delivery_terminal_is_immutable',
                'node_command_delivery_transition_is_legal',
                'node_command_delivery_is_durable',
                'node_attention_choices_are_canonical',
                'node_attention_identity_is_immutable',
                'node_attention_resolution_is_legal',
                'node_attention_is_durable'
              )
              ORDER BY type, name`,
          ),
        ),
      ).toEqual([
        { type: "index", name: "node_attention_records_node_state" },
        { type: "index", name: "node_command_deliveries_node_state" },
        { type: "table", name: "node_attention_records" },
        { type: "table", name: "node_command_deliveries" },
        { type: "table", name: "node_command_sequences" },
        { type: "trigger", name: "node_attention_choices_are_canonical" },
        { type: "trigger", name: "node_attention_identity_is_immutable" },
        { type: "trigger", name: "node_attention_is_durable" },
        { type: "trigger", name: "node_attention_resolution_is_legal" },
        { type: "trigger", name: "node_command_delivery_identity_is_immutable" },
        { type: "trigger", name: "node_command_delivery_initial_state_is_queued" },
        { type: "trigger", name: "node_command_delivery_is_durable" },
        { type: "trigger", name: "node_command_delivery_terminal_is_immutable" },
        { type: "trigger", name: "node_command_delivery_transition_is_legal" },
        { type: "trigger", name: "node_command_sequence_is_durable" },
        { type: "trigger", name: "node_command_sequence_is_monotonic" },
      ]);
      expect(
        temporary.database.read((reader) =>
          reader.get(
            "SELECT (SELECT COUNT(*) FROM node_command_sequences) AS sequences, (SELECT COUNT(*) FROM node_command_deliveries) AS deliveries, (SELECT COUNT(*) FROM node_attention_records) AS attentions",
          ),
        ),
      ).toEqual({ sequences: 0n, deliveries: 0n, attentions: 0n });
    } finally {
      await temporary.dispose();
    }
  });

  it("upgrades a v6 host database and preserves existing rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-steering-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      createHostV6SteeringFixture(path, fixedTimestamp);
      const database = await openHostDatabase({
        path,
        clock: new FixedClock(fixedTimestamp),
        backupPath,
      });
      try {
        expect(database.migration).toEqual({
          databaseKind: "host",
          previousVersion: 6,
          currentVersion: 11,
          appliedVersions: [7, 8, 9, 10, 11],
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
            reader.get(
              "SELECT (SELECT COUNT(*) FROM node_command_sequences) AS sequences, (SELECT COUNT(*) FROM node_command_deliveries) AS deliveries, (SELECT COUNT(*) FROM node_attention_records) AS attentions",
            ),
          ),
        ).toEqual({ sequences: 0n, deliveries: 0n, attentions: 0n });
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
      ).toEqual(expectedHistory(hostMigrations.slice(0, 6), fixedTimestamp));
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
        currentVersion: 11,
        appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
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
          currentVersion: 11,
          appliedVersions: [6, 7, 8, 9, 10, 11],
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

describe("SQLite v7 durable steering constraints", () => {
  it("enforces per-node command ordinals, durable delivery identity, and legal transitions", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      await seedPlanFoundation(temporary.database);
      await seedSchedulerChildren(temporary.database);
      await temporary.database.write((transaction) => {
        transaction.run(
          "INSERT INTO node_command_sequences (node_id, next_ordinal) VALUES (?, 1)",
          [planRootNodeId],
        );
        transaction.run(
          "INSERT INTO node_command_sequences (node_id, next_ordinal) VALUES (?, 1)",
          [schedulerChildNodeId],
        );
      });
      await temporary.database.write((transaction) => {
        transaction.run("UPDATE node_command_sequences SET next_ordinal = 2 WHERE node_id = ?", [
          planRootNodeId,
        ]);
        transaction.run("UPDATE node_command_sequences SET next_ordinal = 2 WHERE node_id = ?", [
          schedulerChildNodeId,
        ]);
      });
      expect(
        temporary.database.read((reader) =>
          reader.get("SELECT next_ordinal FROM node_command_sequences WHERE node_id = ?", [
            planRootNodeId,
          ]),
        ),
      ).toEqual({ next_ordinal: 2n });
      expect(
        temporary.database.read((reader) =>
          reader.get("SELECT next_ordinal FROM node_command_sequences WHERE node_id = ?", [
            schedulerChildNodeId,
          ]),
        ),
      ).toEqual({ next_ordinal: 2n });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_sequences SET next_ordinal = 2 WHERE node_id = ?",
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_sequences SET next_ordinal = 1 WHERE node_id = ?",
              [planRootNodeId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM node_command_sequences WHERE node_id = ?", [
              planRootNodeId,
            ]);
          }),
        "transaction_failed",
      );

      await temporary.database.write((transaction) => {
        for (const commandId of [
          steeringCommandId,
          steeringFailedCommandId,
          steeringReviewCommandId,
          steeringAttentionCommandId,
          steeringAckFailedCommandId,
        ]) {
          transaction.run(
            `INSERT INTO operator_commands (
               id, actor_session_id, aggregate_kind, aggregate_id, expected_version,
               command_type, command_payload, state_kind, created_at_ms, acknowledged_at_ms
             ) VALUES (?, ?, 'node', ?, 0, 'steering.test', ?, 'queued', ?, NULL)`,
            [
              commandId,
              steeringActorSessionId,
              planRootNodeId,
              Uint8Array.of(1, 2, 3),
              fixedTimestamp,
            ],
          );
        }
      });

      const insertDelivery = `INSERT INTO node_command_deliveries (
        command_id, actor_session_id, node_id, ordinal, command_kind, payload,
        safe_to_redeliver, state_kind, recovery_disposition, delivery_attempts,
        delivery_token, created_at_ms, sent_at_ms, acknowledged_at_ms, applied_at_ms,
        failed_at_ms, failure
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      await temporary.database.write((transaction) => {
        transaction.run(insertDelivery, [
          steeringCommandId,
          steeringActorSessionId,
          planRootNodeId,
          1,
          "message",
          Uint8Array.of(9),
          1,
          "queued",
          "resume_session",
          0,
          null,
          fixedTimestamp,
          null,
          null,
          null,
          null,
          null,
        ]);
        transaction.run(insertDelivery, [
          steeringAttentionCommandId,
          steeringActorSessionId,
          schedulerChildNodeId,
          1,
          "message",
          Uint8Array.of(10),
          1,
          "queued",
          "resume_session",
          0,
          null,
          fixedTimestamp,
          null,
          null,
          null,
          null,
          null,
        ]);
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringFailedCommandId,
              steeringActorSessionId,
              planRootNodeId,
              1,
              "message",
              Uint8Array.of(9),
              1,
              "queued",
              "resume_session",
              0,
              null,
              fixedTimestamp,
              null,
              null,
              null,
              null,
              null,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringReviewCommandId,
              steeringActorSessionId,
              "01900000-0000-7000-8000-000000000199",
              2,
              "message",
              Uint8Array.of(9),
              1,
              "queued",
              "resume_session",
              0,
              null,
              fixedTimestamp,
              null,
              null,
              null,
              null,
              null,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_deliveries SET command_kind = 'pause' WHERE command_id = ?",
              [steeringCommandId],
            );
          }),
        "transaction_failed",
      );

      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringFailedCommandId,
              steeringActorSessionId,
              planRootNodeId,
              2,
              "message",
              Uint8Array.of(9),
              1,
              "failed",
              "resume_session",
              1,
              steeringFailedDeliveryToken,
              fixedTimestamp,
              fixedTimestamp + 1,
              null,
              null,
              fixedTimestamp + 2,
              "direct terminal insert",
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringReviewCommandId,
              steeringActorSessionId,
              planRootNodeId,
              3,
              "message",
              Uint8Array.of(9),
              0,
              "review_required",
              "requires_review",
              1,
              steeringReviewDeliveryToken,
              fixedTimestamp,
              fixedTimestamp + 1,
              null,
              null,
              fixedTimestamp + 2,
              "direct review insert",
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringFailedCommandId,
              steeringActorSessionId,
              planRootNodeId,
              2,
              "message",
              Uint8Array.of(9),
              1,
              "queued",
              "resume_session",
              1,
              null,
              fixedTimestamp,
              null,
              null,
              null,
              null,
              null,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringFailedCommandId,
              steeringActorSessionId,
              planRootNodeId,
              2,
              "message",
              Uint8Array.of(9),
              1,
              "sent",
              "resume_session",
              0,
              null,
              fixedTimestamp,
              null,
              null,
              null,
              null,
              null,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringFailedCommandId,
              steeringActorSessionId,
              planRootNodeId,
              2,
              "message",
              Uint8Array.of(9),
              1,
              "sent",
              "resume_session",
              1,
              steeringDeliveryToken,
              fixedTimestamp,
              fixedTimestamp - 1,
              null,
              null,
              null,
              null,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringFailedCommandId,
              steeringActorSessionId,
              planRootNodeId,
              2,
              "message",
              Uint8Array.of(9),
              1,
              "failed",
              "resume_session",
              1,
              steeringDeliveryToken,
              fixedTimestamp,
              fixedTimestamp + 1,
              null,
              null,
              fixedTimestamp,
              "failure",
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertDelivery, [
              steeringFailedCommandId,
              steeringActorSessionId,
              planRootNodeId,
              2,
              "message",
              Uint8Array.of(9),
              1,
              "sent",
              "resume_session",
              1,
              "short-token",
              fixedTimestamp,
              fixedTimestamp + 1,
              null,
              null,
              null,
              null,
            ]);
          }),
        "transaction_failed",
      );

      await temporary.database.write((transaction) => {
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'sent', delivery_attempts = 1, delivery_token = ?, sent_at_ms = ?
            WHERE command_id = ?`,
          [steeringDeliveryToken, fixedTimestamp + 1, steeringCommandId],
        );
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'sent', delivery_attempts = 2, delivery_token = ?, sent_at_ms = ?
            WHERE command_id = ?`,
          [steeringRedeliveryToken, fixedTimestamp + 2, steeringCommandId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_command_deliveries
                  SET state_kind = 'failed', delivery_attempts = 0, delivery_token = NULL,
                      sent_at_ms = NULL, acknowledged_at_ms = NULL, applied_at_ms = NULL,
                      failed_at_ms = ?, failure = ?
                WHERE command_id = ?`,
              [fixedTimestamp + 4, "missing delivery token", steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_command_deliveries
                  SET state_kind = 'queued', delivery_attempts = 0, delivery_token = NULL,
                      sent_at_ms = NULL, acknowledged_at_ms = NULL, applied_at_ms = NULL,
                      failed_at_ms = NULL, failure = NULL
                WHERE command_id = ?`,
              [steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_deliveries SET state_kind = 'acknowledged' WHERE command_id = ?",
              [steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_deliveries SET delivery_token = 'short-token' WHERE command_id = ?",
              [steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_deliveries SET sent_at_ms = ? WHERE command_id = ?",
              [fixedTimestamp - 1, steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_command_deliveries
                  SET state_kind = 'acknowledged', acknowledged_at_ms = ?
                WHERE command_id = ?`,
              [fixedTimestamp + 1, steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'acknowledged', acknowledged_at_ms = ?
            WHERE command_id = ?`,
          [fixedTimestamp + 3, steeringCommandId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_command_deliveries
                  SET state_kind = 'failed', applied_at_ms = ?, failed_at_ms = ?, failure = ?
                WHERE command_id = ?`,
              [
                fixedTimestamp + 4,
                fixedTimestamp + 5,
                "applied timestamp on failed delivery",
                steeringCommandId,
              ],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_command_deliveries
                  SET state_kind = 'applied', applied_at_ms = ?
                WHERE command_id = ?`,
              [fixedTimestamp + 2, steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_command_deliveries
                  SET state_kind = 'sent', delivery_attempts = 3, delivery_token = ?,
                      sent_at_ms = ?, acknowledged_at_ms = NULL, applied_at_ms = NULL,
                      failed_at_ms = NULL, failure = NULL
                WHERE command_id = ?`,
              [steeringDeliveryToken, fixedTimestamp + 4, steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'applied', applied_at_ms = ?
            WHERE command_id = ?`,
          [fixedTimestamp + 4, steeringCommandId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_deliveries SET state_kind = 'failed', failed_at_ms = ?, failure = ? WHERE command_id = ?",
              [fixedTimestamp + 5, "late failure", steeringCommandId],
            );
          }),
        "transaction_failed",
      );

      await temporary.database.write((transaction) => {
        transaction.run(insertDelivery, [
          steeringFailedCommandId,
          steeringActorSessionId,
          planRootNodeId,
          2,
          "interrupt_now",
          Uint8Array.of(4),
          1,
          "queued",
          "retry_external_action",
          0,
          null,
          fixedTimestamp + 4,
          null,
          null,
          null,
          null,
          null,
        ]);
        transaction.run(insertDelivery, [
          steeringReviewCommandId,
          steeringActorSessionId,
          planRootNodeId,
          3,
          "cancel_node",
          Uint8Array.of(5),
          0,
          "queued",
          "requires_review",
          0,
          null,
          fixedTimestamp + 5,
          null,
          null,
          null,
          null,
          null,
        ]);
        transaction.run(insertDelivery, [
          steeringAckFailedCommandId,
          steeringActorSessionId,
          planRootNodeId,
          4,
          "answer",
          Uint8Array.of(6),
          1,
          "queued",
          "resume_session",
          0,
          null,
          fixedTimestamp + 6,
          null,
          null,
          null,
          null,
          null,
        ]);
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'sent', delivery_attempts = 1, delivery_token = ?, sent_at_ms = ?
            WHERE command_id = ?`,
          [steeringFailedDeliveryToken, fixedTimestamp + 6, steeringFailedCommandId],
        );
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'sent', delivery_attempts = 1, delivery_token = ?, sent_at_ms = ?
            WHERE command_id = ?`,
          [steeringReviewDeliveryToken, fixedTimestamp + 7, steeringReviewCommandId],
        );
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'sent', delivery_attempts = 1, delivery_token = ?, sent_at_ms = ?
            WHERE command_id = ?`,
          [steeringAckFailedDeliveryToken, fixedTimestamp + 8, steeringAckFailedCommandId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_command_deliveries
                  SET state_kind = 'review_required', applied_at_ms = ?, failed_at_ms = ?, failure = ?
                WHERE command_id = ?`,
              [
                fixedTimestamp + 9,
                fixedTimestamp + 9,
                "applied timestamp on review delivery",
                steeringReviewCommandId,
              ],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'acknowledged', acknowledged_at_ms = ?
            WHERE command_id = ?`,
          [fixedTimestamp + 9, steeringAckFailedCommandId],
        );
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'failed', failed_at_ms = ?, failure = ?
            WHERE command_id = ?`,
          [fixedTimestamp + 8, "provider unavailable", steeringFailedCommandId],
        );
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'review_required', failed_at_ms = ?, failure = ?
            WHERE command_id = ?`,
          [fixedTimestamp + 9, "unsafe stale delivery", steeringReviewCommandId],
        );
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'failed', failed_at_ms = ?, failure = ?
            WHERE command_id = ?`,
          [fixedTimestamp + 10, "failed after acknowledgement", steeringAckFailedCommandId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_deliveries SET delivery_token = ? WHERE command_id = ?",
              [steeringDeliveryToken, steeringCommandId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE node_command_deliveries SET failure = ? WHERE command_id = ?", [
              "changed failure",
              steeringFailedCommandId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE node_command_deliveries SET recovery_disposition = ? WHERE command_id = ?",
              ["resume_session", steeringReviewCommandId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM node_command_deliveries WHERE command_id = ?", [
              steeringCommandId,
            ]);
          }),
        "transaction_failed",
      );
      expect(
        temporary.database.read((reader) =>
          reader.all(
            `SELECT command_id, node_id, ordinal, safe_to_redeliver, state_kind,
                    delivery_attempts, delivery_token, sent_at_ms, acknowledged_at_ms,
                    applied_at_ms, failed_at_ms, failure
               FROM node_command_deliveries
              WHERE node_id = ?
              ORDER BY ordinal`,
            [planRootNodeId],
          ),
        ),
      ).toEqual([
        {
          command_id: steeringCommandId,
          node_id: planRootNodeId,
          ordinal: 1n,
          safe_to_redeliver: 1n,
          state_kind: "applied",
          delivery_attempts: 2n,
          delivery_token: steeringRedeliveryToken,
          sent_at_ms: BigInt(fixedTimestamp + 2),
          acknowledged_at_ms: BigInt(fixedTimestamp + 3),
          applied_at_ms: BigInt(fixedTimestamp + 4),
          failed_at_ms: null,
          failure: null,
        },
        {
          command_id: steeringFailedCommandId,
          node_id: planRootNodeId,
          ordinal: 2n,
          safe_to_redeliver: 1n,
          state_kind: "failed",
          delivery_attempts: 1n,
          delivery_token: steeringFailedDeliveryToken,
          sent_at_ms: BigInt(fixedTimestamp + 6),
          acknowledged_at_ms: null,
          applied_at_ms: null,
          failed_at_ms: BigInt(fixedTimestamp + 8),
          failure: "provider unavailable",
        },
        {
          command_id: steeringReviewCommandId,
          node_id: planRootNodeId,
          ordinal: 3n,
          safe_to_redeliver: 0n,
          state_kind: "review_required",
          delivery_attempts: 1n,
          delivery_token: steeringReviewDeliveryToken,
          sent_at_ms: BigInt(fixedTimestamp + 7),
          acknowledged_at_ms: null,
          applied_at_ms: null,
          failed_at_ms: BigInt(fixedTimestamp + 9),
          failure: "unsafe stale delivery",
        },
        {
          command_id: steeringAckFailedCommandId,
          node_id: planRootNodeId,
          ordinal: 4n,
          safe_to_redeliver: 1n,
          state_kind: "failed",
          delivery_attempts: 1n,
          delivery_token: steeringAckFailedDeliveryToken,
          sent_at_ms: BigInt(fixedTimestamp + 8),
          acknowledged_at_ms: BigInt(fixedTimestamp + 9),
          applied_at_ms: null,
          failed_at_ms: BigInt(fixedTimestamp + 10),
          failure: "failed after acknowledgement",
        },
      ]);
      expect(
        temporary.database.read((reader) =>
          reader.get(
            "SELECT command_id, node_id, ordinal, state_kind FROM node_command_deliveries WHERE node_id = ?",
            [schedulerChildNodeId],
          ),
        ),
      ).toEqual({
        command_id: steeringAttentionCommandId,
        node_id: schedulerChildNodeId,
        ordinal: 1n,
        state_kind: "queued",
      });
    } finally {
      await temporary.dispose();
    }
  });

  it("validates attention members and resolution, then preserves immutable rows", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      await seedPlanFoundation(temporary.database);
      await seedSchedulerChildren(temporary.database);
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO operator_commands (
             id, actor_session_id, aggregate_kind, aggregate_id, expected_version,
             command_type, command_payload, state_kind, created_at_ms, acknowledged_at_ms
           ) VALUES (?, ?, 'node', ?, 0, 'answer', ?, 'queued', ?, NULL)`,
          [
            steeringAttentionCommandId,
            steeringActorSessionId,
            planRootNodeId,
            Uint8Array.of(7),
            fixedTimestamp,
          ],
        );
        transaction.run(
          `INSERT INTO node_command_deliveries (
             command_id, actor_session_id, node_id, ordinal, command_kind, payload,
             safe_to_redeliver, state_kind, recovery_disposition, delivery_attempts,
             delivery_token, created_at_ms, sent_at_ms, acknowledged_at_ms, applied_at_ms,
             failed_at_ms, failure
           ) VALUES (?, ?, ?, 1, 'answer', ?, 1, 'queued', 'resume_session', 0, NULL, ?, NULL, NULL, NULL, NULL, NULL)`,
          [
            steeringAttentionCommandId,
            steeringActorSessionId,
            planRootNodeId,
            Uint8Array.of(8),
            fixedTimestamp,
          ],
        );
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'sent', delivery_attempts = 1, delivery_token = ?, sent_at_ms = ?
            WHERE command_id = ?`,
          [steeringDeliveryToken, fixedTimestamp + 1, steeringAttentionCommandId],
        );
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'acknowledged', acknowledged_at_ms = ?
            WHERE command_id = ?`,
          [fixedTimestamp + 2, steeringAttentionCommandId],
        );
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'applied', applied_at_ms = ?
            WHERE command_id = ?`,
          [fixedTimestamp + 3, steeringAttentionCommandId],
        );
        transaction.run(
          `INSERT INTO node_command_deliveries (
             command_id, actor_session_id, node_id, ordinal, command_kind, payload,
             safe_to_redeliver, state_kind, recovery_disposition, delivery_attempts,
             delivery_token, created_at_ms, sent_at_ms, acknowledged_at_ms, applied_at_ms,
             failed_at_ms, failure
           ) VALUES (?, ?, ?, 1, 'message', ?, 1, 'queued', 'resume_session', 0, NULL, ?, NULL, NULL, NULL, NULL, NULL)`,
          [
            steeringAckFailedCommandId,
            steeringActorSessionId,
            schedulerChildNodeId,
            Uint8Array.of(9),
            fixedTimestamp,
          ],
        );
        transaction.run(
          `UPDATE node_command_deliveries
              SET state_kind = 'sent', delivery_attempts = 1, delivery_token = ?, sent_at_ms = ?
            WHERE command_id = ?`,
          [steeringAckFailedDeliveryToken, fixedTimestamp + 4, steeringAckFailedCommandId],
        );
      });

      const insertAttention = `INSERT INTO node_attention_records (
        id, node_id, attention_kind, prompt, choices_json, state_kind,
        resolution_command_id, resolution, created_at_ms, resolved_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await temporary.database.write((transaction) => {
        transaction.run(insertAttention, [
          steeringAttentionId,
          planRootNodeId,
          "question",
          "Choose a deployment ring",
          '["canary","production"]',
          "open",
          null,
          null,
          fixedTimestamp,
          null,
        ]);
      });
      for (const choices of ['["canary","canary"]', "[1]", '[""]', "{}", "not-json"]) {
        await expectSqliteFailure(
          () =>
            temporary.database.write((transaction) => {
              transaction.run(insertAttention, [
                steeringSecondAttentionId,
                planRootNodeId,
                "question",
                "Invalid choices",
                choices,
                "open",
                null,
                null,
                fixedTimestamp,
                null,
              ]);
            }),
          "transaction_failed",
        );
      }
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertAttention, [
              steeringSecondAttentionId,
              planRootNodeId,
              "question",
              "Invalid state fields",
              '["canary"]',
              "open",
              steeringAttentionCommandId,
              "canary",
              fixedTimestamp,
              null,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertAttention, [
              steeringSecondAttentionId,
              planRootNodeId,
              "question",
              "Invalid resolution",
              '["canary"]',
              "resolved",
              steeringAttentionCommandId,
              null,
              fixedTimestamp,
              fixedTimestamp + 1,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertAttention, [
              steeringSecondAttentionId,
              planRootNodeId,
              "question",
              "Invalid resolution timestamp",
              '["canary"]',
              "resolved",
              steeringAttentionCommandId,
              "canary",
              fixedTimestamp,
              fixedTimestamp - 1,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(insertAttention, [
              steeringSecondAttentionId,
              planRootNodeId,
              "other",
              "Invalid kind",
              '["canary"]',
              "open",
              null,
              null,
              fixedTimestamp,
              null,
            ]);
          }),
        "transaction_failed",
      );

      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE node_attention_records SET prompt = ? WHERE id = ?", [
              "Changed prompt",
              steeringAttentionId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE node_attention_records SET choices_json = ? WHERE id = ?", [
              '["changed"]',
              steeringAttentionId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_attention_records
                  SET state_kind = 'resolved', resolution_command_id = ?, resolution = ?,
                      resolved_at_ms = ?
                WHERE id = ?`,
              [steeringAckFailedCommandId, "canary", fixedTimestamp + 4, steeringAttentionId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `UPDATE node_attention_records
                  SET state_kind = 'resolved', resolution_command_id = ?, resolution = ?,
                      resolved_at_ms = ?
                WHERE id = ?`,
              [
                "01900000-0000-7000-8000-000000000199",
                "canary",
                fixedTimestamp + 4,
                steeringAttentionId,
              ],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          `UPDATE node_attention_records
              SET state_kind = 'resolved', resolution_command_id = ?, resolution = ?,
                  resolved_at_ms = ?
            WHERE id = ?`,
          [steeringAttentionCommandId, "canary", fixedTimestamp + 4, steeringAttentionId],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE node_attention_records SET resolution = ? WHERE id = ?", [
              "production",
              steeringAttentionId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM node_attention_records WHERE id = ?", [
              steeringAttentionId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM node_command_deliveries WHERE command_id = ?", [
              steeringAttentionCommandId,
            ]);
          }),
        "transaction_failed",
      );
      expect(
        temporary.database.read((reader) =>
          reader.get(
            "SELECT id, node_id, attention_kind, prompt, choices_json, state_kind, resolution_command_id, resolution, created_at_ms, resolved_at_ms FROM node_attention_records WHERE id = ?",
            [steeringAttentionId],
          ),
        ),
      ).toEqual({
        id: steeringAttentionId,
        node_id: planRootNodeId,
        attention_kind: "question",
        prompt: "Choose a deployment ring",
        choices_json: '["canary","production"]',
        state_kind: "resolved",
        resolution_command_id: steeringAttentionCommandId,
        resolution: "canary",
        created_at_ms: BigInt(fixedTimestamp),
        resolved_at_ms: BigInt(fixedTimestamp + 4),
      });
    } finally {
      await temporary.dispose();
    }
  });
});

describe("SQLite v8 artifacts and outcomes schema", () => {
  it("creates the outcome table, index, foreign keys, checks, and durability triggers", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      expect(temporary.database.migration).toEqual({
        databaseKind: "host",
        previousVersion: 0,
        currentVersion: 11,
        appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        backupPath: null,
      });
      expect(
        temporary.database.read((reader) =>
          reader.all(
            `SELECT type, name
               FROM sqlite_schema
              WHERE name IN (
                'node_outcome_records',
                'node_outcome_records_kind_created',
                'content_blob_is_durable',
                'artifact_is_durable',
                'node_outcome_is_immutable',
                'node_outcome_is_durable'
              )
              ORDER BY type, name`,
          ),
        ),
      ).toEqual([
        { type: "index", name: "node_outcome_records_kind_created" },
        { type: "table", name: "node_outcome_records" },
        { type: "trigger", name: "artifact_is_durable" },
        { type: "trigger", name: "content_blob_is_durable" },
        { type: "trigger", name: "node_outcome_is_durable" },
        { type: "trigger", name: "node_outcome_is_immutable" },
      ]);
      expect(
        withReadOnlyDatabase(temporary.path, (database) =>
          database
            .prepare("PRAGMA table_info(node_outcome_records)")
            .all()
            .map((row) => [row["name"], row["type"], row["notnull"], row["pk"]]),
        ),
      ).toEqual([
        ["node_id", "TEXT", 1n, 1n],
        ["outcome_kind", "TEXT", 1n, 0n],
        ["artifact_id", "TEXT", 0n, 0n],
        ["revision", "TEXT", 0n, 0n],
        ["evidence_id", "TEXT", 0n, 0n],
        ["explanation", "TEXT", 0n, 0n],
        ["created_at_ms", "INTEGER", 1n, 0n],
      ]);
      expect(
        withReadOnlyDatabase(temporary.path, (database) =>
          database
            .prepare("PRAGMA index_info(node_outcome_records_kind_created)")
            .all()
            .map((row) => [row["seqno"], row["name"]]),
        ),
      ).toEqual([
        [0n, "outcome_kind"],
        [1n, "created_at_ms"],
        [2n, "node_id"],
      ]);
      expect(
        withReadOnlyDatabase(temporary.path, (database) =>
          database
            .prepare("PRAGMA foreign_key_list(node_outcome_records)")
            .all()
            .map((row) => ({
              table: row["table"],
              from: row["from"],
              to: row["to"],
              on_update: row["on_update"],
              on_delete: row["on_delete"],
            }))
            .sort((left, right) =>
              `${String(left.table)}/${String(left.from)}`.localeCompare(
                `${String(right.table)}/${String(right.from)}`,
              ),
            ),
        ),
      ).toEqual([
        {
          table: "artifacts",
          from: "artifact_id",
          to: "id",
          on_update: "RESTRICT",
          on_delete: "RESTRICT",
        },
        {
          table: "artifacts",
          from: "node_id",
          to: "node_id",
          on_update: "RESTRICT",
          on_delete: "RESTRICT",
        },
        {
          table: "nodes",
          from: "node_id",
          to: "id",
          on_update: "RESTRICT",
          on_delete: "RESTRICT",
        },
      ]);
      const tableSql = temporary.database.read(
        (reader) =>
          reader.get(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'node_outcome_records'",
          )?.["sql"],
      );
      expect(tableSql).toEqual(expect.stringContaining("STRICT"));
      expect(tableSql).toEqual(expect.stringContaining("UNIQUE (node_id, outcome_kind)"));
      expect(tableSql).toEqual(expect.stringContaining("outcome_kind = 'artifact'"));
      expect(tableSql).toEqual(expect.stringContaining("outcome_kind = 'no_change'"));
      expect(tableSql).toEqual(expect.stringContaining("outcome_kind = 'commit'"));
      expect(
        temporary.database.read((reader) =>
          reader.get(
            `SELECT
               (SELECT COUNT(*) FROM content_blobs) AS content_blobs,
               (SELECT COUNT(*) FROM artifacts) AS artifacts,
               (SELECT COUNT(*) FROM node_outcome_records) AS outcomes`,
          ),
        ),
      ).toEqual({ content_blobs: 0n, artifacts: 0n, outcomes: 0n });
    } finally {
      await temporary.dispose();
    }
  });

  it("upgrades a v7 host database and preserves content and artifact rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-artifact-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      createHostV7ArtifactsFixture(path, fixedTimestamp);
      const database = await openHostDatabase({
        path,
        clock: new FixedClock(fixedTimestamp),
        backupPath,
      });
      try {
        expect(database.migration).toEqual({
          databaseKind: "host",
          previousVersion: 7,
          currentVersion: 11,
          appliedVersions: [8, 9, 10, 11],
          backupPath: resolve(backupPath),
        });
        expect(
          database.read((reader) =>
            reader.get(
              "SELECT digest, size_bytes, media_type, relative_path, retention_kind, created_at_ms, verified_at_ms FROM content_blobs WHERE digest = ?",
              [planContentDigest],
            ),
          ),
        ).toEqual({
          digest: planContentDigest,
          size_bytes: 7n,
          media_type: "text/plain",
          relative_path: `sha256/${planContentDigest.slice(0, 2)}/${planContentDigest.slice(2, 4)}/${planContentDigest}`,
          retention_kind: "active",
          created_at_ms: BigInt(fixedTimestamp),
          verified_at_ms: BigInt(fixedTimestamp),
        });
        expect(
          database.read((reader) =>
            reader.get(
              "SELECT id, node_id, attempt_id, tree_id, repository_id, host_id, content_digest, artifact_type, evidence_id, retention_kind, created_at_ms FROM artifacts WHERE id = ?",
              [planRootArtifactId],
            ),
          ),
        ).toEqual({
          id: planRootArtifactId,
          node_id: planRootNodeId,
          attempt_id: null,
          tree_id: planTreeId,
          repository_id: planRepositoryId,
          host_id: planHostId,
          content_digest: planContentDigest,
          artifact_type: "plan",
          evidence_id: planEvidenceId,
          retention_kind: "active",
          created_at_ms: BigInt(fixedTimestamp),
        });
        expect(
          database.read(
            (reader) => reader.get("SELECT COUNT(*) AS count FROM node_outcome_records")?.["count"],
          ),
        ).toBe(0n);
        expect(
          database.read((reader) =>
            reader.all(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            ),
          ),
        ).toEqual(expectedHistory(hostMigrations, fixedTimestamp));
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
      ).toEqual(expectedHistory(hostMigrations.slice(0, 7), fixedTimestamp));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects v7 artifact metadata mismatches during backfill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-outcome-mismatch-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      createHostV7OutcomeBackfillFixture(path, fixedTimestamp, legacyMismatchedArtifactEvidenceId);
      await expect(
        openHostDatabase({
          path,
          clock: new FixedClock(fixedTimestamp),
          backupPath,
        }),
      ).rejects.toMatchObject({ code: "migration_failed" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("backfills every succeeded v7 outcome and rejects normalized mismatches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-outcome-backfill-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      createHostV7OutcomeBackfillFixture(path, fixedTimestamp);
      const database = await openHostDatabase({
        path,
        clock: new FixedClock(fixedTimestamp),
        backupPath,
      });
      try {
        expect(database.migration).toEqual({
          databaseKind: "host",
          previousVersion: 7,
          currentVersion: 11,
          appliedVersions: [8, 9, 10, 11],
          backupPath: resolve(backupPath),
        });
        expect(
          database.read((reader) =>
            reader.all(
              `SELECT node_id, outcome_kind, artifact_id, revision, evidence_id, explanation,
                      created_at_ms
                 FROM node_outcome_records
                ORDER BY node_id`,
            ),
          ),
        ).toEqual([
          {
            node_id: planRootNodeId,
            outcome_kind: "artifact",
            artifact_id: legacyOutcomeArtifactId,
            revision: null,
            evidence_id: null,
            explanation: null,
            created_at_ms: BigInt(fixedTimestamp + 2),
          },
          {
            node_id: legacyCommitNodeId,
            outcome_kind: "commit",
            artifact_id: null,
            revision: legacyCommitRevision,
            evidence_id: legacyCommitEvidenceId,
            explanation: null,
            created_at_ms: BigInt(fixedTimestamp + 5),
          },
          {
            node_id: legacyNoChangeNodeId,
            outcome_kind: "no_change",
            artifact_id: null,
            revision: legacyCommitRevision,
            evidence_id: legacyNoChangeEvidenceId,
            explanation: "legacy unchanged",
            created_at_ms: BigInt(fixedTimestamp + 8),
          },
        ]);
        expect(
          database.read((reader) =>
            reader.get(
              `SELECT COUNT(*) AS missing
                 FROM nodes AS node
                WHERE node.state_kind = 'succeeded'
                  AND NOT EXISTS (
                    SELECT 1
                      FROM node_outcome_records AS outcome
                     WHERE outcome.node_id = node.id
                  )`,
            ),
          ),
        ).toEqual({ missing: 0n });

        await expectSqliteFailure(
          () =>
            executeTestSqliteWrite(database, (transaction) => {
              transaction.run("UPDATE nodes SET outcome_commit = ? WHERE id = ?", [
                planBaseCommit,
                legacyCommitNodeId,
              ]);
            }),
          "transaction_failed",
        );
        await expectSqliteFailure(
          () =>
            executeTestSqliteWrite(database, (transaction) => {
              transaction.run("UPDATE nodes SET outcome_content_hash = ? WHERE id = ?", [
                "e".repeat(64),
                planRootNodeId,
              ]);
            }),
          "transaction_failed",
        );

        await executeTestSqliteWrite(database, (transaction) => {
          transaction.run(
            `INSERT INTO nodes (
               id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
               mode, objective, output_kind, output_artifact_id, output_artifact_type,
               state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
               blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
               outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
               outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
               version, created_at_ms, updated_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, 'implementation', 'missing outcome', 'implementation',
                       NULL, NULL, 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                       NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
            [
              legacyUnnormalizedNodeId,
              planTreeId,
              planRepositoryId,
              planHostId,
              legacyNoChangeNodeId,
              planRevisionId,
              fixedTimestamp + 9,
              fixedTimestamp + 9,
            ],
          );
        });
        await expectSqliteFailure(
          () =>
            executeTestSqliteWrite(database, (transaction) => {
              transaction.run(
                `UPDATE nodes
                    SET state_kind = 'succeeded', outcome_kind = 'commit',
                        outcome_commit = ?, outcome_evidence_id = ?,
                        version = version + 1, updated_at_ms = ?
                  WHERE id = ?`,
                [
                  legacyCommitRevision,
                  legacyCommitEvidenceId,
                  fixedTimestamp + 10,
                  legacyUnnormalizedNodeId,
                ],
              );
            }),
          "transaction_failed",
        );
        await expectSqliteFailure(
          () =>
            executeTestSqliteWrite(database, (transaction) => {
              transaction.run(
                `INSERT INTO node_outcome_records (
                   node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
                 ) VALUES (?, 'no_change', NULL, ?, ?, ?, ?)`,
                [
                  legacyUnnormalizedNodeId,
                  planBaseCommit,
                  legacyNoChangeEvidenceId,
                  "wrong inherited revision",
                  fixedTimestamp + 10,
                ],
              );
            }),
          "transaction_failed",
        );
      } finally {
        await database.close();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("enforces one outcome per node, ownership, oneof checks, and immutable durable rows", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      await seedPlanFoundation(temporary.database);
      await seedSchedulerChildren(temporary.database);
      const orphanContentDigest = "c".repeat(64);
      await temporary.database.write((transaction) => {
        const insertNodeSql = `INSERT INTO nodes (
             id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
             mode, objective, output_kind, output_artifact_id, output_artifact_type,
             state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
             blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
             outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
             outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
             version, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, 'implementation', ?, 'implementation', NULL, NULL,
                     'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                     NULL, NULL, NULL, NULL, 0, ?, ?)`;
        transaction.run(insertNodeSql, [
          legacyCommitNodeId,
          planTreeId,
          planRepositoryId,
          planHostId,
          planRootNodeId,
          planRevisionId,
          "outcome commit",
          fixedTimestamp,
          fixedTimestamp,
        ]);
        transaction.run(insertNodeSql, [
          legacyNoChangeNodeId,
          planTreeId,
          planRepositoryId,
          planHostId,
          legacyCommitNodeId,
          planRevisionId,
          "outcome no-change",
          fixedTimestamp,
          fixedTimestamp,
        ]);
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO content_blobs (
             digest, size_bytes, media_type, relative_path, retention_kind,
             created_at_ms, verified_at_ms
           ) VALUES (?, 7, 'text/plain', ?, 'active', ?, ?)`,
          [
            planContentDigest,
            `sha256/${planContentDigest.slice(0, 2)}/${planContentDigest.slice(2, 4)}/${planContentDigest}`,
            fixedTimestamp,
            fixedTimestamp,
          ],
        );
        transaction.run(
          `INSERT INTO content_blobs (
             digest, size_bytes, media_type, relative_path, retention_kind,
             created_at_ms, verified_at_ms
           ) VALUES (?, 0, 'application/octet-stream', ?, 'active', ?, ?)`,
          [
            orphanContentDigest,
            `sha256/${orphanContentDigest.slice(0, 2)}/${orphanContentDigest.slice(2, 4)}/${orphanContentDigest}`,
            fixedTimestamp,
            fixedTimestamp,
          ],
        );
        transaction.run(
          `INSERT INTO artifacts (
             id, node_id, attempt_id, tree_id, repository_id, host_id,
             content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
           ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'plan', ?, 'active', ?)`,
          [
            planRootArtifactId,
            planRootNodeId,
            planTreeId,
            planRepositoryId,
            planHostId,
            planContentDigest,
            planEvidenceId,
            fixedTimestamp,
          ],
        );
        transaction.run(
          `INSERT INTO artifacts (
             id, node_id, attempt_id, tree_id, repository_id, host_id,
             content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
           ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'plan', ?, 'active', ?)`,
          [
            schedulerChildArtifactId,
            schedulerChildNodeId,
            planTreeId,
            planRepositoryId,
            planHostId,
            planContentDigest,
            planEvidenceId,
            fixedTimestamp,
          ],
        );
      });

      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM content_blobs WHERE digest = ?", [orphanContentDigest]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM artifacts WHERE id = ?", [schedulerChildArtifactId]);
          }),
        "transaction_failed",
      );

      await temporary.database.write((transaction) => {
        transaction.run(
          "UPDATE nodes SET state_kind = 'active' WHERE id = ? AND state_kind = 'planned'",
          [planRootNodeId],
        );
      });
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO node_outcome_records (
             node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
           ) VALUES (?, 'artifact', ?, NULL, NULL, NULL, ?)`,
          [planRootNodeId, planRootArtifactId, fixedTimestamp],
        );
        transaction.run(
          `UPDATE nodes
              SET state_kind = 'succeeded', outcome_kind = 'artifact',
                  outcome_artifact_id = ?, outcome_content_hash = ?,
                  outcome_artifact_type = 'plan', outcome_evidence_id = ?,
                  version = version + 1, updated_at_ms = ?
            WHERE id = ?`,
          [
            planRootArtifactId,
            planContentDigest,
            planEvidenceId,
            fixedTimestamp + 1,
            planRootNodeId,
          ],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO node_outcome_records (
                 node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
               ) VALUES (?, 'commit', NULL, ?, ?, NULL, ?)`,
              [planRootNodeId, planBaseCommit, planEvidenceId, fixedTimestamp],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO node_outcome_records (
                 node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
               ) VALUES (?, 'no_change', NULL, ?, ?, ?, ?)`,
              [
                legacyNoChangeNodeId,
                planBaseCommit,
                planEvidenceId,
                "parent must complete first",
                fixedTimestamp,
              ],
            );
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run(
          `INSERT INTO node_outcome_records (
             node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
           ) VALUES (?, 'commit', NULL, ?, ?, NULL, ?)`,
          [legacyCommitNodeId, planBaseCommit, secondAttentionId, fixedTimestamp],
        );
        transaction.run(
          `UPDATE nodes
              SET state_kind = 'succeeded', outcome_kind = 'commit', outcome_commit = ?,
                  outcome_evidence_id = ?, version = version + 1, updated_at_ms = ?
            WHERE id = ?`,
          [planBaseCommit, secondAttentionId, fixedTimestamp + 1, legacyCommitNodeId],
        );
        transaction.run(
          `INSERT INTO node_outcome_records (
             node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
           ) VALUES (?, 'no_change', NULL, ?, ?, ?, ?)`,
          [
            legacyNoChangeNodeId,
            planBaseCommit,
            planEvidenceId,
            "inherited unchanged output",
            fixedTimestamp,
          ],
        );
      });
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              `INSERT INTO node_outcome_records (
                 node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
               ) VALUES (?, 'artifact', ?, NULL, NULL, NULL, ?)`,
              [schedulerThirdChildNodeId, planRootArtifactId, fixedTimestamp],
            );
          }),
        "transaction_failed",
      );

      const malformedOutcomes = [
        ["artifact with revision", "artifact", planRootArtifactId, planBaseCommit, null, null],
        ["artifact without artifact", "artifact", null, null, null, null],
        ["no-change without explanation", "no_change", null, planBaseCommit, planEvidenceId, null],
        ["no-change without evidence", "no_change", null, planBaseCommit, null, "unchanged"],
        [
          "commit with explanation",
          "commit",
          null,
          planBaseCommit,
          planEvidenceId,
          "unexpected explanation",
        ],
        ["commit without revision", "commit", null, null, planEvidenceId, null],
        ["invalid revision", "no_change", null, "G".repeat(40), planEvidenceId, "unchanged"],
        ["invalid evidence", "no_change", null, planBaseCommit, "short", "unchanged"],
        ["empty explanation", "commit", null, planBaseCommit, planEvidenceId, ""],
      ] as const;
      for (const [
        ,
        outcomeKind,
        artifactId,
        revision,
        evidenceId,
        explanation,
      ] of malformedOutcomes) {
        await expectSqliteFailure(
          () =>
            temporary.database.write((transaction) => {
              transaction.run(
                `INSERT INTO node_outcome_records (
                   node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  schedulerThirdChildNodeId,
                  outcomeKind,
                  artifactId,
                  revision,
                  evidenceId,
                  explanation,
                  fixedTimestamp,
                ],
              );
            }),
          "transaction_failed",
        );
      }

      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE node_outcome_records SET explanation = ? WHERE node_id = ?", [
              "changed",
              planRootNodeId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("DELETE FROM node_outcome_records WHERE node_id = ?", [planRootNodeId]);
          }),
        "transaction_failed",
      );
      expect(
        temporary.database.read((reader) =>
          reader.all(
            "SELECT node_id, outcome_kind, artifact_id, revision, evidence_id, explanation FROM node_outcome_records ORDER BY node_id",
          ),
        ),
      ).toEqual([
        {
          node_id: planRootNodeId,
          outcome_kind: "artifact",
          artifact_id: planRootArtifactId,
          revision: null,
          evidence_id: null,
          explanation: null,
        },
        {
          node_id: legacyCommitNodeId,
          outcome_kind: "commit",
          artifact_id: null,
          revision: planBaseCommit,
          evidence_id: secondAttentionId,
          explanation: null,
        },
        {
          node_id: legacyNoChangeNodeId,
          outcome_kind: "no_change",
          artifact_id: null,
          revision: planBaseCommit,
          evidence_id: planEvidenceId,
          explanation: "inherited unchanged output",
        },
      ]);
    } finally {
      await temporary.dispose();
    }
  });
});

describe("SQLite v10 attempt transcript schema", () => {
  it("creates attempt transcript chunks table, index, and stability trigger on a fresh host database", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      expect(temporary.database.migration).toEqual({
        databaseKind: "host",
        previousVersion: 0,
        currentVersion: 11,
        appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        backupPath: null,
      });
      expect(
        temporary.database.read((reader) =>
          reader.all(
            `SELECT type, name
               FROM sqlite_schema
              WHERE name IN (
                'attempt_transcript_chunks',
                'attempt_transcript_chunks_attempt',
                'attempt_transcript_chunk_payload_is_stable'
              )
              ORDER BY type, name`,
          ),
        ),
      ).toEqual([
        { type: "index", name: "attempt_transcript_chunks_attempt" },
        { type: "table", name: "attempt_transcript_chunks" },
        { type: "trigger", name: "attempt_transcript_chunk_payload_is_stable" },
      ]);
      expect(
        withReadOnlyDatabase(temporary.path, (database) =>
          database
            .prepare("PRAGMA table_info(attempt_transcript_chunks)")
            .all()
            .map((row) => [row["name"], row["type"], row["notnull"], row["pk"]]),
        ),
      ).toEqual([
        ["attempt_id", "TEXT", 1n, 1n],
        ["sequence", "INTEGER", 1n, 2n],
        ["occurred_at_ms", "INTEGER", 1n, 0n],
        ["payload_kind", "TEXT", 1n, 0n],
        ["payload_json", "TEXT", 1n, 0n],
        ["recorded_at_ms", "INTEGER", 1n, 0n],
      ]);
      expect(
        withReadOnlyDatabase(temporary.path, (database) =>
          database
            .prepare("PRAGMA index_info(attempt_transcript_chunks_attempt)")
            .all()
            .map((row) => [row["seqno"], row["name"]]),
        ),
      ).toEqual([
        [0n, "attempt_id"],
        [1n, "sequence"],
      ]);
      const tableSql = temporary.database.read(
        (reader) =>
          reader.get(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'attempt_transcript_chunks'",
          )?.["sql"],
      );
      expect(tableSql).toEqual(expect.stringContaining("STRICT"));
      expect(tableSql).toEqual(expect.stringContaining("PRIMARY KEY (attempt_id, sequence)"));
      expect(
        temporary.database.read((reader) =>
          reader.get("SELECT COUNT(*) AS chunks FROM attempt_transcript_chunks"),
        ),
      ).toEqual({ chunks: 0n });
    } finally {
      await temporary.dispose();
    }
  });

  it("upgrades a v9 host database and preserves existing rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-transcript-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      createHostV9TranscriptFixture(path, fixedTimestamp);
      const database = await openHostDatabase({
        path,
        clock: new FixedClock(fixedTimestamp),
        backupPath,
      });
      try {
        expect(database.migration).toEqual({
          databaseKind: "host",
          previousVersion: 9,
          currentVersion: 11,
          appliedVersions: [10, 11],
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
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'attempt_transcript_chunks'",
            ),
          ),
        ).toEqual([{ name: "attempt_transcript_chunks" }]);
        expect(
          database.read((reader) =>
            reader.get("SELECT COUNT(*) AS chunks FROM attempt_transcript_chunks"),
          ),
        ).toEqual({ chunks: 0n });
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
      ).toEqual(expectedHistory(hostMigrations.slice(0, 9), fixedTimestamp));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps attempt transcript chunk payloads stable for a sequence", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      const insertChunk = (
        attemptId: string,
        sequence: number,
        payloadKind: string,
        payloadJson: string,
      ): Promise<void> =>
        temporary.database.write((transaction) => {
          transaction.run(
            `INSERT INTO attempt_transcript_chunks (
               attempt_id, sequence, occurred_at_ms, payload_kind, payload_json, recorded_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [attemptId, sequence, fixedTimestamp, payloadKind, payloadJson, fixedTimestamp],
          );
        });
      await insertChunk(harnessAttemptId, 0, "message", `{"role":"user"}`);
      await expectSqliteFailure(
        () => insertChunk(harnessAttemptId, 0, "message", `{"role":"assistant"}`),
        "transaction_failed",
      );
      expect(
        temporary.database.read((reader) =>
          reader.get(
            "SELECT payload_kind, payload_json FROM attempt_transcript_chunks WHERE attempt_id = ? AND sequence = 0",
            [harnessAttemptId],
          ),
        ),
      ).toEqual({ payload_kind: "message", payload_json: `{"role":"user"}` });
      await expectSqliteFailure(
        () => insertChunk("too-short", 1, "message", "{}"),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () => insertChunk(secondHarnessAttemptId, 1, "", "{}"),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () => insertChunk(schedulerChildAttemptId, -1, "message", "{}"),
        "transaction_failed",
      );
    } finally {
      await temporary.dispose();
    }
  });
});

describe("SQLite v11 attempt checkpoint schema", () => {
  it("creates attempt checkpoints table and identity triggers on a fresh host database", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      expect(temporary.database.migration).toEqual({
        databaseKind: "host",
        previousVersion: 0,
        currentVersion: 11,
        appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        backupPath: null,
      });
      expect(
        temporary.database.read((reader) =>
          reader.all(
            `SELECT type, name
               FROM sqlite_schema
              WHERE name IN (
                'attempt_checkpoints',
                'attempt_checkpoint_identity_is_immutable',
                'attempt_checkpoint_sequence_is_monotonic'
              )
              ORDER BY type, name`,
          ),
        ),
      ).toEqual([
        { type: "table", name: "attempt_checkpoints" },
        { type: "trigger", name: "attempt_checkpoint_identity_is_immutable" },
        { type: "trigger", name: "attempt_checkpoint_sequence_is_monotonic" },
      ]);
      expect(
        withReadOnlyDatabase(temporary.path, (database) =>
          database
            .prepare("PRAGMA table_info(attempt_checkpoints)")
            .all()
            .map((row) => [row["name"], row["type"], row["notnull"], row["pk"]]),
        ),
      ).toEqual([
        ["attempt_id", "TEXT", 1n, 1n],
        ["node_id", "TEXT", 1n, 0n],
        ["sequence", "INTEGER", 1n, 0n],
        ["phase", "TEXT", 1n, 0n],
        ["harness_id", "TEXT", 1n, 0n],
        ["session_id", "TEXT", 1n, 0n],
        ["sandbox_instance_id", "TEXT", 1n, 0n],
        ["sandbox_backend_kind", "TEXT", 1n, 0n],
        ["sandbox_policy_digest", "TEXT", 1n, 0n],
        ["sandbox_state", "TEXT", 1n, 0n],
        ["context_digest", "TEXT", 1n, 0n],
        ["recorded_at_ms", "INTEGER", 1n, 0n],
      ]);
      const tableSql = temporary.database.read(
        (reader) =>
          reader.get(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'attempt_checkpoints'",
          )?.["sql"],
      );
      expect(tableSql).toEqual(expect.stringContaining("STRICT"));
      expect(tableSql).toEqual(expect.stringContaining("phase IN ("));
      expect(tableSql).toEqual(expect.stringContaining("'claimed'"));
      expect(tableSql).toEqual(expect.stringContaining("'finalizing'"));
      expect(tableSql).toEqual(
        expect.stringContaining("sandbox_state IN ('created', 'running', 'stopped')"),
      );
      expect(tableSql).toEqual(expect.stringContaining("length(sandbox_policy_digest) = 64"));
      expect(tableSql).toEqual(
        expect.stringContaining("sandbox_policy_digest NOT GLOB '*[^0-9a-f]*'"),
      );
      expect(tableSql).toEqual(expect.stringContaining("length(context_digest) = 64"));
      expect(tableSql).toEqual(expect.stringContaining("context_digest NOT GLOB '*[^0-9a-f]*'"));
      expect(
        temporary.database.read((reader) =>
          reader.get("SELECT COUNT(*) AS checkpoints FROM attempt_checkpoints"),
        ),
      ).toEqual({ checkpoints: 0n });
    } finally {
      await temporary.dispose();
    }
  });

  it("upgrades a v10 host database and preserves transcript rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minions-host-checkpoint-migration-"));
    const path = join(directory, "host.db");
    const backupPath = join(directory, "host.backup.db");
    try {
      createHostV10CheckpointFixture(path, fixedTimestamp);
      const database = await openHostDatabase({
        path,
        clock: new FixedClock(fixedTimestamp),
        backupPath,
      });
      try {
        expect(database.migration).toEqual({
          databaseKind: "host",
          previousVersion: 10,
          currentVersion: 11,
          appliedVersions: [11],
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
            reader.get(
              "SELECT attempt_id, sequence, payload_kind, payload_json FROM attempt_transcript_chunks WHERE attempt_id = ?",
              [harnessAttemptId],
            ),
          ),
        ).toEqual({
          attempt_id: harnessAttemptId,
          sequence: 0n,
          payload_kind: "message",
          payload_json: "{}",
        });
        expect(
          database.read((reader) =>
            reader.all(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'attempt_checkpoints'",
            ),
          ),
        ).toEqual([{ name: "attempt_checkpoints" }]);
        expect(
          database.read((reader) =>
            reader.get("SELECT COUNT(*) AS checkpoints FROM attempt_checkpoints"),
          ),
        ).toEqual({ checkpoints: 0n });
        expect(
          database.read((reader) =>
            reader.all(
              "SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version",
            ),
          ),
        ).toEqual(expectedHistory(hostMigrations, fixedTimestamp));
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
      ).toEqual(expectedHistory(hostMigrations.slice(0, 10), fixedTimestamp));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("enforces checkpoint identity immutability, monotonic sequence, and column checks", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", new FixedClock(fixedTimestamp));
    try {
      const insertCheckpoint = (
        attemptId: string,
        overrides: {
          node_id?: string;
          sequence?: number;
          phase?: string;
          harness_id?: string;
          session_id?: string;
          sandbox_instance_id?: string;
          sandbox_backend_kind?: string;
          sandbox_policy_digest?: string;
          sandbox_state?: string;
          context_digest?: string;
          recorded_at_ms?: number;
        } = {},
      ): Promise<void> => {
        const values = {
          node_id: planRootNodeId,
          sequence: 5,
          phase: "claimed",
          harness_id: "harness-1",
          session_id: "session-1",
          sandbox_instance_id: "sandbox-1",
          sandbox_backend_kind: "podman",
          sandbox_policy_digest: harnessPolicyDigest,
          sandbox_state: "created",
          context_digest: planContentDigest,
          recorded_at_ms: fixedTimestamp,
          ...overrides,
        };
        return temporary.database.write((transaction) => {
          transaction.run(
            `INSERT INTO attempt_checkpoints (
               attempt_id, node_id, sequence, phase, harness_id, session_id,
               sandbox_instance_id, sandbox_backend_kind, sandbox_policy_digest,
               sandbox_state, context_digest, recorded_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              attemptId,
              values.node_id,
              values.sequence,
              values.phase,
              values.harness_id,
              values.session_id,
              values.sandbox_instance_id,
              values.sandbox_backend_kind,
              values.sandbox_policy_digest,
              values.sandbox_state,
              values.context_digest,
              values.recorded_at_ms,
            ],
          );
        });
      };
      await insertCheckpoint(harnessAttemptId);
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE attempt_checkpoints SET harness_id = ? WHERE attempt_id = ?", [
              "harness-2",
              harnessAttemptId,
            ]);
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run(
              "UPDATE attempt_checkpoints SET context_digest = ? WHERE attempt_id = ?",
              ["c".repeat(64), harnessAttemptId],
            );
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          temporary.database.write((transaction) => {
            transaction.run("UPDATE attempt_checkpoints SET sequence = 3 WHERE attempt_id = ?", [
              harnessAttemptId,
            ]);
          }),
        "transaction_failed",
      );
      await temporary.database.write((transaction) => {
        transaction.run("UPDATE attempt_checkpoints SET sequence = 6 WHERE attempt_id = ?", [
          harnessAttemptId,
        ]);
      });
      expect(
        temporary.database.read((reader) =>
          reader.get("SELECT sequence FROM attempt_checkpoints WHERE attempt_id = ?", [
            harnessAttemptId,
          ]),
        ),
      ).toEqual({ sequence: 6n });
      await expectSqliteFailure(
        () => insertCheckpoint(secondHarnessAttemptId, { phase: "bogus" }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () => insertCheckpoint(schedulerChildAttemptId, { sandbox_state: "bogus" }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () =>
          insertCheckpoint(schedulerSecondChildAttemptId, {
            sandbox_policy_digest: "a".repeat(63),
          }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () => insertCheckpoint(schedulerThirdChildAttemptId, { context_digest: "g".repeat(64) }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () => insertCheckpoint(legacyCommitNodeId, { node_id: "too-short" }),
        "transaction_failed",
      );
      await expectSqliteFailure(
        () => insertCheckpoint(legacyNoChangeNodeId, { recorded_at_ms: -1 }),
        "transaction_failed",
      );
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
