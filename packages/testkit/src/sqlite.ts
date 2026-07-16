import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DatabaseKind,
  type ManagedSqliteDatabase,
  openHostDatabase,
  openSupervisorDatabase,
  type SqliteReader,
  type SqliteTransaction,
  type SqliteValue,
  type SqliteWriteResult,
} from "@minions/adapters";
import {
  executeTestSqliteWrite,
  registerTestSqliteWriterAlias,
} from "@minions/adapters/sqlite-test-support";
import type { Clock } from "@minions/core";

export interface TestManagedSqliteDatabase extends ManagedSqliteDatabase {
  write<T>(operation: (transaction: SqliteTransaction) => T): Promise<T>;
}

class TestSqliteDatabaseAlias implements TestManagedSqliteDatabase {
  readonly #inner: ManagedSqliteDatabase;
  readonly path: string;
  readonly migration: ManagedSqliteDatabase["migration"];

  constructor(inner: ManagedSqliteDatabase) {
    this.#inner = inner;
    this.path = inner.path;
    this.migration = inner.migration;
    registerTestSqliteWriterAlias(this, inner, (transaction) => transaction);
  }

  checkIntegrity(): void {
    this.#inner.checkIntegrity();
  }

  read<T>(operation: (reader: SqliteReader) => T): T {
    return this.#inner.read(operation);
  }

  snapshot<T>(operation: (reader: SqliteReader) => T): T {
    return this.#inner.snapshot(operation);
  }

  write<T>(operation: (transaction: SqliteTransaction) => T): Promise<T> {
    return executeTestSqliteWrite(this, operation);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

export class TemporarySqliteDatabase {
  readonly directory: string;
  readonly path: string;
  readonly backupPath: string;
  readonly database: TestManagedSqliteDatabase;
  readonly applicationDatabase: ManagedSqliteDatabase;

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
    this.applicationDatabase = database;
    this.database = new TestSqliteDatabaseAlias(database);
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
    await this.applicationDatabase.close();
    await rm(this.directory, { force: true, recursive: true });
    this.disposed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

export type InjectedWriteFailureTiming = "before" | "after";

export class InjectedSqliteWriteFailure extends Error {
  readonly writeIndex: number;
  readonly timing: InjectedWriteFailureTiming;

  constructor(writeIndex: number, timing: InjectedWriteFailureTiming) {
    super(`injected SQLite write failure ${timing} write ${String(writeIndex)}`);
    this.name = "InjectedSqliteWriteFailure";
    this.writeIndex = writeIndex;
    this.timing = timing;
  }
}

export class FaultInjectingSqliteDatabase implements TestManagedSqliteDatabase {
  readonly #inner: ManagedSqliteDatabase;
  readonly #failAtWrite: number;
  readonly #timing: InjectedWriteFailureTiming;
  #observedWriteCount = 0;

  constructor(
    inner: ManagedSqliteDatabase,
    options: Readonly<{
      failAtWrite: number;
      timing: InjectedWriteFailureTiming;
    }>,
  ) {
    if (!Number.isSafeInteger(options.failAtWrite) || options.failAtWrite <= 0) {
      throw new RangeError("failAtWrite must be a positive safe integer");
    }
    this.#inner = inner;
    this.#failAtWrite = options.failAtWrite;
    this.#timing = options.timing;
    registerTestSqliteWriterAlias(
      this,
      inner,
      (transaction) => new FaultInjectingSqliteTransaction(transaction, this),
    );
  }

  get path(): string {
    return this.#inner.path;
  }

  get migration(): ManagedSqliteDatabase["migration"] {
    return this.#inner.migration;
  }

  get observedWriteCount(): number {
    return this.#observedWriteCount;
  }

  checkIntegrity(): void {
    this.#inner.checkIntegrity();
  }

  read<T>(operation: (reader: SqliteReader) => T): T {
    return this.#inner.read(operation);
  }

  snapshot<T>(operation: (reader: SqliteReader) => T): T {
    return this.#inner.snapshot(operation);
  }

  write<T>(operation: (transaction: SqliteTransaction) => T): Promise<T> {
    return executeTestSqliteWrite(this, operation);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  run(
    transaction: SqliteTransaction,
    sql: string,
    parameters: readonly SqliteValue[],
  ): SqliteWriteResult {
    this.#observedWriteCount += 1;
    const writeIndex = this.#observedWriteCount;
    if (writeIndex === this.#failAtWrite && this.#timing === "before") {
      throw new InjectedSqliteWriteFailure(writeIndex, this.#timing);
    }
    const result = transaction.run(sql, parameters);
    if (writeIndex === this.#failAtWrite && this.#timing === "after") {
      throw new InjectedSqliteWriteFailure(writeIndex, this.#timing);
    }
    return result;
  }
}

class FaultInjectingSqliteTransaction implements SqliteTransaction {
  readonly #inner: SqliteTransaction;
  readonly #database: FaultInjectingSqliteDatabase;

  constructor(inner: SqliteTransaction, database: FaultInjectingSqliteDatabase) {
    this.#inner = inner;
    this.#database = database;
  }

  get(sql: string, parameters: readonly SqliteValue[] = []) {
    return this.#inner.get(sql, parameters);
  }

  all(sql: string, parameters: readonly SqliteValue[] = []) {
    return this.#inner.all(sql, parameters);
  }

  run(sql: string, parameters: readonly SqliteValue[] = []): SqliteWriteResult {
    return this.#database.run(this.#inner, sql, parameters);
  }

  withCurrentStateWrites<T>(operation: () => T): T {
    return this.#inner.withCurrentStateWrites(operation);
  }
}
