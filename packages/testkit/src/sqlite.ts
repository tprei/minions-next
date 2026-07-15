import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DatabaseKind,
  type ManagedSqliteDatabase,
  openHostDatabase,
  openSupervisorDatabase,
} from "@minions/adapters";
import type { Clock } from "@minions/core";

export class TemporarySqliteDatabase {
  readonly directory: string;
  readonly path: string;
  readonly backupPath: string;
  readonly database: ManagedSqliteDatabase;

  private disposed = false;

  private constructor(
    directory: string,
    path: string,
    backupPath: string,
    database: ManagedSqliteDatabase,
  ) {
    this.directory = directory;
    this.path = path;
    this.backupPath = backupPath;
    this.database = database;
  }

  static async create(kind: DatabaseKind, clock: Clock): Promise<TemporarySqliteDatabase> {
    const directory = await mkdtemp(join(tmpdir(), `minions-${kind}-database-`));
    const path = join(directory, `${kind}.db`);
    const backupPath = join(directory, `${kind}.backup.db`);
    try {
      const database = await (kind === "host"
        ? openHostDatabase({ path, clock })
        : openSupervisorDatabase({ path, clock }));
      return new TemporarySqliteDatabase(directory, path, backupPath, database);
    } catch (error) {
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.database.close();
    await rm(this.directory, { force: true, recursive: true });
    this.disposed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
