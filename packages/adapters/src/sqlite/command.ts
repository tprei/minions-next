import type { AppliedCommand, CommandReceipt, CommandRequest, DomainPorts } from "@minions/core";

import type {
  ManagedSqliteDatabase,
  SqliteReader,
  SqliteValue,
  SqliteWriteResult,
} from "./database.js";

export interface SqliteCommandTransaction extends SqliteReader {
  run(sql: string, parameters?: readonly SqliteValue[]): SqliteWriteResult;
}

export type ApplySqliteCommand = (transaction: SqliteCommandTransaction) => AppliedCommand;

export interface CommandCommitNotifier {
  commandCommitted(receipt: CommandReceipt): void | Promise<void>;
}

export interface SqliteCommandStore {
  execute(request: CommandRequest, apply: ApplySqliteCommand): Promise<CommandReceipt>;
}

export type OpenSqliteCommandStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
  ports: DomainPorts;
  notifier: CommandCommitNotifier;
}>;
