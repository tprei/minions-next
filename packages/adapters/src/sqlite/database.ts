import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  DatabaseSync,
  constants,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges,
} from "node:sqlite";

import type { Clock } from "@minions/core";

import { SqliteDatabaseError } from "./error.js";
import { hostMigrations, supervisorMigrations } from "./generated-migrations.js";
import {
  applyReaderPolicy,
  assertDatabaseIntegrity,
  authorizeReaderAction,
  type DatabaseKind,
  type MigrationReceipt,
  migrateSqliteDatabase,
  SQLITE_BUSY_TIMEOUT_MS,
  type SqliteMigration,
} from "./migration.js";
const activeDatabasePaths = new Set<string>();
const activeDatabaseIdentities = new Set<string>();
const protectedWriterTables: Readonly<Record<string, true>> = Object.freeze({
  schema_migrations: true,
  sqlite_sequence: true,
});
const commandJournalTables: Readonly<Record<string, true>> = Object.freeze({
  events: true,
  external_operations: true,
  idempotency_records: true,
  operator_commands: true,
  outbox: true,
});

export type SqliteValue = SQLInputValue;
export type SqliteRow = Readonly<Record<string, SQLOutputValue>>;

export type SqliteWriteResult = Readonly<{
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}>;

export interface SqliteReader {
  get(sql: string, parameters?: readonly SqliteValue[]): SqliteRow | undefined;
  all(sql: string, parameters?: readonly SqliteValue[]): readonly SqliteRow[];
}

export interface SqliteTransaction extends SqliteReader {
  run(sql: string, parameters?: readonly SqliteValue[]): SqliteWriteResult;
  withCurrentStateWrites<T>(operation: () => T): T;
}

export type OpenSqliteDatabaseOptions = Readonly<{
  path: string;
  clock: Clock;
  backupPath?: string;
}>;

export interface ManagedSqliteDatabase {
  readonly path: string;
  readonly migration: MigrationReceipt;
  checkIntegrity(): void;
  read<T>(operation: (reader: SqliteReader) => T): T;
  snapshot<T>(operation: (reader: SqliteReader) => T): T;
  close(): Promise<void>;
}

class ManagedSqliteDatabaseInstance {
  readonly path: string;
  readonly migration: MigrationReceipt;

  readonly #writerDatabase: DatabaseSync;
  readonly #readerDatabase: DatabaseSync;
  readonly #reader: SqliteReader;
  readonly #readerAuthorization: ReaderAuthorization;
  readonly #writerAuthorization: WriterAuthorization;
  readonly #releaseWriter: () => void;
  #writeTail: Promise<void> = Promise.resolve();
  #writing = false;
  #snapshotting = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    path: string,
    migration: MigrationReceipt,
    writerDatabase: DatabaseSync,
    readerDatabase: DatabaseSync,
    releaseWriter: () => void,
  ) {
    this.path = path;
    this.migration = migration;
    this.#writerDatabase = writerDatabase;
    this.#readerDatabase = readerDatabase;
    this.#releaseWriter = releaseWriter;
    this.#readerAuthorization = new ReaderAuthorization(readerDatabase);
    this.#reader = new ReaderConnection(readerDatabase, () => {
      this.#assertOpen();
    });
    this.#writerAuthorization = new WriterAuthorization(writerDatabase);
  }

  checkIntegrity(): void {
    this.#assertOpen();
    const database = new DatabaseSync(this.path, databaseOptions(true));
    try {
      assertDatabaseIntegrity(database);
    } finally {
      database.close();
    }
  }

  read<T>(operation: (reader: SqliteReader) => T): T {
    this.#assertOpen();
    return operation(this.#reader);
  }

  snapshot<T>(operation: (reader: SqliteReader) => T): T {
    this.#assertOpen();
    if (this.#snapshotting) {
      throw new SqliteDatabaseError(
        "transaction_reentrant",
        "a SQLite snapshot transaction cannot be nested",
      );
    }
    this.#snapshotting = true;
    try {
      this.#readerAuthorization.executeTransactionControl("BEGIN");
      const result = operation(this.#reader);
      if (isThenable(result)) {
        observeThenable(result);
        throw new SqliteDatabaseError(
          "transaction_async",
          "SQLite snapshot callbacks must complete synchronously",
        );
      }
      this.#readerAuthorization.executeTransactionControl("COMMIT");
      return result;
    } catch (error) {
      if (this.#readerDatabase.isTransaction) {
        try {
          this.#readerAuthorization.executeTransactionControl("ROLLBACK");
        } catch (rollbackError) {
          throw new SqliteDatabaseError(
            "transaction_failed",
            "SQLite snapshot transaction and rollback failed",
            { cause: rollbackError },
          );
        }
      }
      if (isNativeSqliteError(error)) {
        throw new SqliteDatabaseError("read_failed", "SQLite snapshot transaction failed", {
          cause: error,
        });
      }
      throw error;
    } finally {
      this.#snapshotting = false;
    }
  }

  write<T>(operation: (transaction: SqliteTransaction) => T): Promise<T> {
    if (this.#closed || this.#closePromise !== undefined) {
      return Promise.reject(
        new SqliteDatabaseError("database_closed", "the SQLite database is closed"),
      );
    }
    if (this.#writing) {
      throw new SqliteDatabaseError(
        "transaction_reentrant",
        "a SQLite writer transaction cannot enqueue another writer transaction",
      );
    }

    const result = this.#writeTail.then(() => this.#executeWrite(operation));
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeAfterWrites();
    return this.#closePromise;
  }

  #executeWrite<T>(operation: (transaction: SqliteTransaction) => T): T | Promise<never> {
    this.#writing = true;
    const transaction = new TransactionConnection(this.#writerDatabase, this.#writerAuthorization);
    let cleanupAfterReturn = true;
    try {
      this.#writerAuthorization.executeTransactionControl("BEGIN IMMEDIATE");
      const result = operation(transaction);
      if (isThenable(result)) {
        this.#writerAuthorization.executeTransactionControl("ROLLBACK");
        deactivateTransaction(transaction);
        cleanupAfterReturn = false;
        return rejectAsyncTransaction(result).finally(() => {
          this.#writing = false;
        });
      }
      this.#writerAuthorization.executeTransactionControl("COMMIT");
      return result;
    } catch (error) {
      if (this.#writerDatabase.isTransaction) {
        try {
          this.#writerAuthorization.executeTransactionControl("ROLLBACK");
        } catch (rollbackError) {
          throw new SqliteDatabaseError(
            "transaction_failed",
            "SQLite writer transaction and rollback failed",
            { cause: rollbackError },
          );
        }
      }
      if (isNativeSqliteError(error)) {
        throw new SqliteDatabaseError("transaction_failed", "SQLite writer transaction failed", {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (cleanupAfterReturn) {
        deactivateTransaction(transaction);
        this.#writing = false;
      }
    }
  }

  async #closeAfterWrites(): Promise<void> {
    await this.#writeTail;
    try {
      this.#readerDatabase.close();
    } finally {
      try {
        this.#writerDatabase.close();
      } finally {
        this.#closed = true;
        this.#releaseWriter();
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#closePromise !== undefined) {
      throw new SqliteDatabaseError("database_closed", "the SQLite database is closed");
    }
  }
}

type SqliteWriteOperation = <T>(operation: (transaction: SqliteTransaction) => T) => Promise<T>;

const managedSqliteWriters = new WeakMap<ManagedSqliteDatabase, SqliteWriteOperation>();

class ManagedSqliteDatabaseFacade implements ManagedSqliteDatabase {
  readonly path: string;
  readonly migration: MigrationReceipt;
  readonly #instance: ManagedSqliteDatabaseInstance;

  constructor(instance: ManagedSqliteDatabaseInstance) {
    this.path = instance.path;
    this.migration = instance.migration;
    this.#instance = instance;
    managedSqliteWriters.set(this, (operation) => instance.write(operation));
  }

  checkIntegrity(): void {
    this.#instance.checkIntegrity();
  }

  read<T>(operation: (reader: SqliteReader) => T): T {
    return this.#instance.read(operation);
  }

  snapshot<T>(operation: (reader: SqliteReader) => T): T {
    return this.#instance.snapshot(operation);
  }

  close(): Promise<void> {
    return this.#instance.close();
  }
}

export function executeManagedSqliteWrite<T>(
  database: ManagedSqliteDatabase,
  operation: (transaction: SqliteTransaction) => T,
): Promise<T> {
  const write = managedSqliteWriters.get(database);
  if (write === undefined) {
    return Promise.reject(
      new SqliteDatabaseError(
        "write_capability_unavailable",
        "the SQLite database does not carry an application write capability",
      ),
    );
  }
  return write(operation);
}

export function registerManagedSqliteWriterAlias(
  alias: ManagedSqliteDatabase,
  source: ManagedSqliteDatabase,
  decorate: (transaction: SqliteTransaction) => SqliteTransaction,
): void {
  if (managedSqliteWriters.has(alias)) {
    throw new SqliteDatabaseError(
      "write_capability_unavailable",
      "the SQLite database alias already carries a write capability",
    );
  }
  const write = managedSqliteWriters.get(source);
  if (write === undefined) {
    throw new SqliteDatabaseError(
      "write_capability_unavailable",
      "the source SQLite database does not carry a write capability",
    );
  }
  managedSqliteWriters.set(alias, (operation) =>
    write((transaction) => operation(decorate(transaction))),
  );
}

export function openHostDatabase(
  options: OpenSqliteDatabaseOptions,
): Promise<ManagedSqliteDatabase> {
  return openSqliteDatabase("host", hostMigrations, options);
}

export function openSupervisorDatabase(
  options: OpenSqliteDatabaseOptions,
): Promise<ManagedSqliteDatabase> {
  return openSqliteDatabase("supervisor", supervisorMigrations, options);
}

async function openSqliteDatabase(
  databaseKind: DatabaseKind,
  migrations: readonly SqliteMigration[],
  options: OpenSqliteDatabaseOptions,
): Promise<ManagedSqliteDatabase> {
  if (options.path.trim().length === 0 || options.path === ":memory:") {
    throw new SqliteDatabaseError(
      "invalid_database_path",
      "SQLite databases require a real file path",
    );
  }
  const databasePath = canonicalDatabasePath(options.path);
  const databaseExisted = existsSync(databasePath);
  let databaseIdentity = databaseExisted ? databaseFileIdentity(databasePath) : undefined;
  if (
    activeDatabasePaths.has(databasePath) ||
    (databaseIdentity !== undefined && activeDatabaseIdentities.has(databaseIdentity))
  ) {
    throw new SqliteDatabaseError(
      "database_already_open",
      "the SQLite database already has an active application writer",
    );
  }
  activeDatabasePaths.add(databasePath);
  let databaseIdentityReserved = false;
  if (databaseIdentity !== undefined) {
    activeDatabaseIdentities.add(databaseIdentity);
    databaseIdentityReserved = true;
  }
  let writerDatabase: DatabaseSync | undefined;
  let readerDatabase: DatabaseSync | undefined;

  try {
    writerDatabase = new DatabaseSync(databasePath, databaseOptions(false));
    if (databaseIdentity === undefined) {
      databaseIdentity = databaseFileIdentity(databasePath);
      if (activeDatabaseIdentities.has(databaseIdentity)) {
        throw new SqliteDatabaseError(
          "database_already_open",
          "the SQLite database already has an active application writer",
        );
      }
      activeDatabaseIdentities.add(databaseIdentity);
      databaseIdentityReserved = true;
    }
    const migration = await migrateSqliteDatabase(writerDatabase, {
      databaseKind,
      databasePath,
      databaseExisted,
      ...(options.backupPath === undefined ? {} : { backupPath: options.backupPath }),
      clock: options.clock,
      migrations,
    });
    readerDatabase = new DatabaseSync(databasePath, databaseOptions(true));
    applyReaderPolicy(readerDatabase);
    const managedDatabaseIdentity = databaseIdentity;
    const instance = new ManagedSqliteDatabaseInstance(
      databasePath,
      migration,
      writerDatabase,
      readerDatabase,
      () => {
        activeDatabasePaths.delete(databasePath);
        activeDatabaseIdentities.delete(managedDatabaseIdentity);
      },
    );
    return new ManagedSqliteDatabaseFacade(instance);
  } catch (error) {
    try {
      try {
        if (readerDatabase !== undefined) {
          readerDatabase.close();
        }
      } finally {
        if (writerDatabase !== undefined) {
          writerDatabase.close();
        }
      }
    } catch (cleanupError) {
      throw new SqliteDatabaseError(
        "database_open_failed",
        "SQLite database failed to close after an open error",
        { cause: cleanupError },
      );
    } finally {
      activeDatabasePaths.delete(databasePath);
      if (databaseIdentityReserved && databaseIdentity !== undefined) {
        activeDatabaseIdentities.delete(databaseIdentity);
      }
    }
    if (error instanceof SqliteDatabaseError) {
      throw error;
    }
    throw new SqliteDatabaseError("database_open_failed", "SQLite database could not be opened", {
      cause: error,
    });
  }
}

function canonicalDatabasePath(path: string): string {
  const resolvedPath = resolve(path);
  try {
    if (existsSync(resolvedPath)) {
      return realpathSync(resolvedPath);
    }
    return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
  } catch (error) {
    throw new SqliteDatabaseError(
      "database_open_failed",
      "SQLite database path could not be resolved",
      { cause: error },
    );
  }
}

function databaseFileIdentity(path: string): string {
  try {
    const status = statSync(path, { bigint: true });
    if (!status.isFile()) {
      throw new SqliteDatabaseError(
        "invalid_database_path",
        "SQLite databases require a regular file",
      );
    }
    return `${String(status.dev)}:${String(status.ino)}`;
  } catch (error) {
    if (error instanceof SqliteDatabaseError) {
      throw error;
    }
    throw new SqliteDatabaseError(
      "database_open_failed",
      "SQLite database identity could not be read",
      { cause: error },
    );
  }
}

function databaseOptions(readOnly: boolean): ConstructorParameters<typeof DatabaseSync>[1] {
  return {
    allowBareNamedParameters: false,
    allowExtension: false,
    allowUnknownNamedParameters: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readBigInts: true,
    readOnly,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  };
}

class ReaderConnection implements SqliteReader {
  readonly #database: DatabaseSync;
  readonly #assertAvailable: (() => void) | undefined;

  constructor(database: DatabaseSync, assertAvailable?: () => void) {
    this.#database = database;
    this.#assertAvailable = assertAvailable;
  }

  get(sql: string, parameters: readonly SqliteValue[] = []): SqliteRow | undefined {
    this.#assertAvailable?.();
    try {
      return this.#database.prepare(sql).get(...parameters);
    } catch (error) {
      if (isNativeSqliteError(error)) {
        throw new SqliteDatabaseError("read_failed", "SQLite read failed", { cause: error });
      }
      throw error;
    }
  }

  all(sql: string, parameters: readonly SqliteValue[] = []): readonly SqliteRow[] {
    this.#assertAvailable?.();
    try {
      return this.#database.prepare(sql).all(...parameters);
    } catch (error) {
      if (isNativeSqliteError(error)) {
        throw new SqliteDatabaseError("read_failed", "SQLite read failed", { cause: error });
      }
      throw error;
    }
  }
}

class TransactionConnection implements SqliteTransaction {
  readonly #database: DatabaseSync;
  readonly #reader: ReaderConnection;
  readonly #writerAuthorization: WriterAuthorization;

  constructor(database: DatabaseSync, writerAuthorization: WriterAuthorization) {
    this.#database = database;
    this.#reader = new ReaderConnection(database);
    this.#writerAuthorization = writerAuthorization;
    activeTransactions.add(this);
  }

  get(sql: string, parameters: readonly SqliteValue[] = []): SqliteRow | undefined {
    this.#assertActive();
    return this.#reader.get(sql, parameters);
  }

  all(sql: string, parameters: readonly SqliteValue[] = []): readonly SqliteRow[] {
    this.#assertActive();
    return this.#reader.all(sql, parameters);
  }

  run(sql: string, parameters: readonly SqliteValue[] = []): SqliteWriteResult {
    this.#assertActive();
    return writeResult(this.#database.prepare(sql).run(...parameters));
  }
  withCurrentStateWrites<T>(operation: () => T): T {
    this.#assertActive();
    return this.#writerAuthorization.executeCurrentStateWrites(operation);
  }

  #assertActive(): void {
    if (!activeTransactions.has(this)) {
      throw new SqliteDatabaseError(
        "transaction_closed",
        "the SQLite writer transaction is no longer active",
      );
    }
  }
}

const activeTransactions = new WeakSet<TransactionConnection>();

function deactivateTransaction(transaction: TransactionConnection): void {
  activeTransactions.delete(transaction);
}

class ReaderAuthorization {
  readonly #database: DatabaseSync;
  #transactionControlAllowed = false;

  constructor(database: DatabaseSync) {
    this.#database = database;
    database.setAuthorizer((actionCode, firstArgument, secondArgument) => {
      if (actionCode === constants.SQLITE_TRANSACTION && this.#transactionControlAllowed) {
        return constants.SQLITE_OK;
      }
      return authorizeReaderAction(actionCode, firstArgument, secondArgument);
    });
  }

  executeTransactionControl(sql: string): void {
    this.#transactionControlAllowed = true;
    try {
      this.#database.exec(sql);
    } finally {
      this.#transactionControlAllowed = false;
    }
  }
}

class WriterAuthorization {
  readonly #database: DatabaseSync;
  #transactionControlAllowed = false;
  #currentStateWrites = false;

  constructor(database: DatabaseSync) {
    this.#database = database;
    database.setAuthorizer((actionCode, firstArgument) =>
      this.#authorize(actionCode, firstArgument),
    );
  }

  executeTransactionControl(sql: string): void {
    this.#transactionControlAllowed = true;
    try {
      this.#database.exec(sql);
    } finally {
      this.#transactionControlAllowed = false;
    }
  }

  executeCurrentStateWrites<T>(operation: () => T): T {
    const previousPolicy = this.#currentStateWrites;
    this.#currentStateWrites = true;
    try {
      return operation();
    } finally {
      this.#currentStateWrites = previousPolicy;
    }
  }

  #authorize(actionCode: number, firstArgument: string | null): number {
    if (
      (actionCode === constants.SQLITE_DELETE ||
        actionCode === constants.SQLITE_INSERT ||
        actionCode === constants.SQLITE_UPDATE) &&
      firstArgument !== null &&
      (Object.hasOwn(protectedWriterTables, firstArgument.toLowerCase()) ||
        (this.#currentStateWrites &&
          Object.hasOwn(commandJournalTables, firstArgument.toLowerCase())))
    ) {
      return constants.SQLITE_DENY;
    }
    if (
      this.#currentStateWrites &&
      actionCode === constants.SQLITE_READ &&
      firstArgument !== null &&
      Object.hasOwn(commandJournalTables, firstArgument.toLowerCase())
    ) {
      return constants.SQLITE_DENY;
    }
    if (
      actionCode === constants.SQLITE_DELETE ||
      actionCode === constants.SQLITE_FUNCTION ||
      actionCode === constants.SQLITE_INSERT ||
      actionCode === constants.SQLITE_READ ||
      actionCode === constants.SQLITE_RECURSIVE ||
      actionCode === constants.SQLITE_SELECT ||
      actionCode === constants.SQLITE_UPDATE
    ) {
      return constants.SQLITE_OK;
    }
    if (actionCode === constants.SQLITE_TRANSACTION && this.#transactionControlAllowed) {
      return constants.SQLITE_OK;
    }
    return constants.SQLITE_DENY;
  }
}

function writeResult(result: StatementResultingChanges): SqliteWriteResult {
  return Object.freeze({
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid,
  });
}

function rejectAsyncTransaction(result: PromiseLike<unknown>): Promise<never> {
  const rejection = new SqliteDatabaseError(
    "transaction_async",
    "SQLite writer transaction callbacks must complete synchronously",
  );
  const observedResult = Promise.resolve(result).then(
    () => Promise.reject(rejection),
    () => Promise.reject(rejection),
  );
  return Promise.race([Promise.reject(rejection), observedResult]);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return typeof Reflect.get(value, "then") === "function";
}

function observeThenable(result: PromiseLike<unknown>): void {
  void Promise.resolve(result).then(
    () => undefined,
    () => undefined,
  );
}

function isNativeSqliteError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_SQLITE")
  );
}
