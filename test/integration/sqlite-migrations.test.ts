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
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

const fixedTimestamp = timestampFromEpochMilliseconds(1_725_000_000_123);

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

describe("SQLite migration integration", () => {
  it.each(migrationCases)(
    "migrates an empty $kind database to v2 with policy and persistent history",
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

  it("backs up an existing host v1 database before applying only v2", async () => {
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
          currentVersion: 2,
          appliedVersions: [2],
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
          .run(3, "future_state", "f".repeat(64), fixedTimestamp);
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
          version: 3n,
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
