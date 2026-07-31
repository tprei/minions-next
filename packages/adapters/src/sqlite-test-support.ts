import {
  executeManagedSqliteWrite,
  registerManagedSqliteWriterAlias,
  type ManagedSqliteDatabase,
  type SqliteTransaction,
} from "./sqlite/database.js";

export function executeTestSqliteWrite<T>(
  database: ManagedSqliteDatabase,
  operation: (transaction: SqliteTransaction) => T,
): Promise<T> {
  return executeManagedSqliteWrite(database, operation);
}

export function registerTestSqliteWriterAlias(
  alias: ManagedSqliteDatabase,
  source: ManagedSqliteDatabase,
  decorate: (transaction: SqliteTransaction) => SqliteTransaction,
): void {
  registerManagedSqliteWriterAlias(alias, source, decorate);
}
