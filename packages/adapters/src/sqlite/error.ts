export type SqliteDatabaseErrorCode =
  | "backup_exists"
  | "backup_failed"
  | "backup_required"
  | "checksum_mismatch"
  | "connection_policy_failed"
  | "database_already_open"
  | "database_closed"
  | "database_corrupt"
  | "database_newer"
  | "database_open_failed"
  | "invalid_database_path"
  | "invalid_migration_history"
  | "migration_definition_invalid"
  | "migration_failed"
  | "read_failed"
  | "transaction_async"
  | "transaction_closed"
  | "transaction_failed"
  | "transaction_reentrant";

export class SqliteDatabaseError extends Error {
  readonly code: SqliteDatabaseErrorCode;

  constructor(code: SqliteDatabaseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteDatabaseError";
    this.code = code;
  }
}
