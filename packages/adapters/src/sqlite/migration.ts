import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { backup, constants, DatabaseSync } from "node:sqlite";

import type { Clock } from "@minions/core";

import { SqliteDatabaseError } from "./error.js";

export type DatabaseKind = "host" | "supervisor";

export type SqliteMigration = Readonly<{
  version: number;
  name: string;
  checksum: string;
  sql: string;
}>;

export type MigrationReceipt = Readonly<{
  databaseKind: DatabaseKind;
  previousVersion: number;
  currentVersion: number;
  appliedVersions: readonly number[];
  backupPath: string | null;
}>;

type AppliedMigration = Readonly<{
  version: number;
  name: string;
  checksum: string;
}>;

type MigrationRunnerOptions = Readonly<{
  databaseKind: DatabaseKind;
  databasePath: string;
  databaseExisted: boolean;
  backupPath?: string;
  clock: Clock;
  migrations: readonly SqliteMigration[];
}>;

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const readerPragmas: Readonly<Record<string, true>> = Object.freeze({
  busy_timeout: true,
  foreign_keys: true,
  journal_mode: true,
  synchronous: true,
  trusted_schema: true,
});

export async function migrateSqliteDatabase(
  database: DatabaseSync,
  options: MigrationRunnerOptions,
): Promise<MigrationReceipt> {
  validateMigrationDefinitions(options.migrations);
  assertDatabaseIntegrity(database);
  const applied = readAppliedMigrations(database);
  validateMigrationHistory(applied, options.migrations);
  const pending = options.migrations.slice(applied.length);
  const previousVersion = applied.length;
  let backupPath: string | null = null;

  if (pending.length > 0 && options.databaseExisted) {
    backupPath = await createVerifiedBackup(database, options.databasePath, options.backupPath);
  }

  applyConnectionPolicy(database);
  if (pending.length > 0) {
    applyPendingMigrations(database, pending, options.clock);
  }
  assertDatabaseIntegrity(database);

  return Object.freeze({
    databaseKind: options.databaseKind,
    previousVersion,
    currentVersion: options.migrations.length,
    appliedVersions: Object.freeze(pending.map((migration) => migration.version)),
    backupPath,
  });
}

function applyConnectionPolicy(database: DatabaseSync): void {
  try {
    const journalMode = database.prepare("PRAGMA journal_mode = WAL").get()?.["journal_mode"];
    if (journalMode !== "wal") {
      throw new SqliteDatabaseError("connection_policy_failed", "SQLite refused WAL journal mode");
    }
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
      PRAGMA recursive_triggers = ON;
      PRAGMA wal_autocheckpoint = 1000;
    `);
    const foreignKeys = database.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"];
    const synchronous = database.prepare("PRAGMA synchronous").get()?.["synchronous"];
    const trustedSchema = database.prepare("PRAGMA trusted_schema").get()?.["trusted_schema"];
    const busyTimeout = database.prepare("PRAGMA busy_timeout").get()?.["timeout"];
    if (
      foreignKeys !== 1n ||
      synchronous !== 2n ||
      trustedSchema !== 0n ||
      busyTimeout !== BigInt(SQLITE_BUSY_TIMEOUT_MS)
    ) {
      throw new SqliteDatabaseError(
        "connection_policy_failed",
        "SQLite connection policy verification failed",
      );
    }
  } catch (error) {
    if (error instanceof SqliteDatabaseError) {
      throw error;
    }
    throw new SqliteDatabaseError(
      "connection_policy_failed",
      "SQLite connection policy could not be applied",
      { cause: error },
    );
  }
}

export function applyReaderPolicy(database: DatabaseSync): void {
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
    `);
    const foreignKeys = database.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"];
    const trustedSchema = database.prepare("PRAGMA trusted_schema").get()?.["trusted_schema"];
    const busyTimeout = database.prepare("PRAGMA busy_timeout").get()?.["timeout"];
    if (
      foreignKeys !== 1n ||
      trustedSchema !== 0n ||
      busyTimeout !== BigInt(SQLITE_BUSY_TIMEOUT_MS)
    ) {
      throw new SqliteDatabaseError(
        "connection_policy_failed",
        "SQLite reader policy verification failed",
      );
    }
    database.setAuthorizer(authorizeReaderAction);
  } catch (error) {
    if (error instanceof SqliteDatabaseError) {
      throw error;
    }
    throw new SqliteDatabaseError(
      "connection_policy_failed",
      "SQLite reader policy could not be applied",
      { cause: error },
    );
  }
}

export function authorizeReaderAction(
  actionCode: number,
  firstArgument: string | null,
  secondArgument: string | null,
): number {
  if (
    actionCode === constants.SQLITE_FUNCTION ||
    actionCode === constants.SQLITE_READ ||
    actionCode === constants.SQLITE_RECURSIVE ||
    actionCode === constants.SQLITE_SELECT
  ) {
    return constants.SQLITE_OK;
  }
  if (
    actionCode === constants.SQLITE_PRAGMA &&
    firstArgument !== null &&
    secondArgument === null &&
    Object.hasOwn(readerPragmas, firstArgument)
  ) {
    return constants.SQLITE_OK;
  }
  return constants.SQLITE_DENY;
}

function assertDatabaseIntegrity(database: DatabaseSync): void {
  try {
    const rows = database.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.["integrity_check"] !== "ok") {
      throw new SqliteDatabaseError("database_corrupt", "SQLite integrity check failed");
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length !== 0) {
      throw new SqliteDatabaseError(
        "database_corrupt",
        "SQLite foreign-key integrity check failed",
      );
    }
  } catch (error) {
    if (error instanceof SqliteDatabaseError) {
      throw error;
    }
    throw new SqliteDatabaseError("database_corrupt", "SQLite integrity check failed", {
      cause: error,
    });
  }
}

function validateMigrationDefinitions(migrations: readonly SqliteMigration[]): void {
  if (migrations.length === 0) {
    throw new SqliteDatabaseError(
      "migration_definition_invalid",
      "at least one SQLite migration is required",
    );
  }
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    const computedChecksum = createHash("sha256").update(migration.sql).digest("hex");
    if (
      migration.version !== expectedVersion ||
      !/^[a-z0-9_]+$/u.test(migration.name) ||
      migration.sql.trim().length === 0 ||
      migration.checksum !== computedChecksum
    ) {
      throw new SqliteDatabaseError(
        "migration_definition_invalid",
        `invalid SQLite migration definition at version ${String(expectedVersion)}`,
      );
    }
  }
}

function readAppliedMigrations(database: DatabaseSync): readonly AppliedMigration[] {
  try {
    const table = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    if (table?.["present"] !== 1n) {
      return [];
    }
    return database
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => {
        const version = row["version"];
        const name = row["name"];
        const checksum = row["checksum"];
        if (
          typeof version !== "bigint" ||
          typeof name !== "string" ||
          typeof checksum !== "string"
        ) {
          throw new SqliteDatabaseError(
            "invalid_migration_history",
            "SQLite migration history contains invalid values",
          );
        }
        const numericVersion = Number(version);
        if (!Number.isSafeInteger(numericVersion)) {
          throw new SqliteDatabaseError(
            "invalid_migration_history",
            "SQLite migration version is outside the safe integer range",
          );
        }
        return Object.freeze({ version: numericVersion, name, checksum });
      });
  } catch (error) {
    if (error instanceof SqliteDatabaseError) {
      throw error;
    }
    throw new SqliteDatabaseError(
      "invalid_migration_history",
      "SQLite migration history could not be read",
      { cause: error },
    );
  }
}

function validateMigrationHistory(
  applied: readonly AppliedMigration[],
  migrations: readonly SqliteMigration[],
): void {
  for (const [index, record] of applied.entries()) {
    const expectedVersion = index + 1;
    if (record.version !== expectedVersion) {
      throw new SqliteDatabaseError(
        "invalid_migration_history",
        `SQLite migration history has a gap at version ${String(expectedVersion)}`,
      );
    }
    const migration = migrations[index];
    if (migration === undefined) {
      throw new SqliteDatabaseError(
        "database_newer",
        `SQLite database version ${String(record.version)} is newer than this application`,
      );
    }
    if (record.name !== migration.name || record.checksum !== migration.checksum) {
      throw new SqliteDatabaseError(
        "checksum_mismatch",
        `SQLite migration checksum mismatch at version ${String(record.version)}`,
      );
    }
  }
}

async function createVerifiedBackup(
  database: DatabaseSync,
  databasePath: string,
  requestedBackupPath: string | undefined,
): Promise<string> {
  if (requestedBackupPath === undefined) {
    throw new SqliteDatabaseError(
      "backup_required",
      "an explicit backup path is required before migrating an existing database",
    );
  }
  const backupPath = resolve(requestedBackupPath);
  if (backupPath === resolve(databasePath)) {
    throw new SqliteDatabaseError(
      "invalid_database_path",
      "the SQLite backup path must differ from the database path",
    );
  }
  if (existsSync(backupPath)) {
    throw new SqliteDatabaseError("backup_exists", "the SQLite backup path already exists");
  }

  let stagingDirectory: string | undefined;
  let failure: SqliteDatabaseError | undefined;
  try {
    stagingDirectory = mkdtempSync(`${backupPath}.tmp-`);
    const stagingPath = resolve(stagingDirectory, "backup.sqlite");
    await backup(database, stagingPath);
    const backupDatabase = new DatabaseSync(stagingPath, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readBigInts: true,
      readOnly: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    try {
      assertDatabaseIntegrity(backupDatabase);
    } finally {
      backupDatabase.close();
    }
    try {
      linkSync(stagingPath, backupPath);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw new SqliteDatabaseError("backup_exists", "the SQLite backup path already exists");
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SqliteDatabaseError && error.code === "backup_exists") {
      failure = error;
    } else {
      failure = new SqliteDatabaseError("backup_failed", "SQLite backup could not be verified", {
        cause: error,
      });
    }
  }
  if (stagingDirectory !== undefined) {
    try {
      rmSync(stagingDirectory, { force: true, recursive: true });
    } catch (error) {
      let cleanupCause: unknown = error;
      if (failure !== undefined) {
        cleanupCause = new AggregateError(
          [failure, error],
          "SQLite backup and staging cleanup failed",
        );
      }
      failure = new SqliteDatabaseError("backup_failed", "SQLite backup staging cleanup failed", {
        cause: cleanupCause,
      });
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  return backupPath;
}

function applyPendingMigrations(
  database: DatabaseSync,
  pending: readonly SqliteMigration[],
  clock: Clock,
): void {
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const migration of pending) {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, migration.checksum, clock.now());
    }
    assertDatabaseIntegrity(database);
    database.exec("COMMIT");
  } catch (error) {
    let failure = error;
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        failure = new AggregateError([error, rollbackError], "SQLite migration rollback failed");
      }
    }
    if (failure instanceof SqliteDatabaseError) {
      throw failure;
    }
    throw new SqliteDatabaseError("migration_failed", "SQLite migration transaction failed", {
      cause: failure,
    });
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}
