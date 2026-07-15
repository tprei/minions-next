import type { CommandReceipt } from "@minions/core";

export type SqliteCommandErrorCode =
  | "aggregate_version_conflict"
  | "aggregate_version_invariant"
  | "command_async"
  | "command_failed"
  | "command_id_conflict"
  | "command_result_corrupt"
  | "external_operation_conflict"
  | "invalid_command"
  | "post_commit_notification_failed";

export class SqliteCommandError extends Error {
  readonly code: SqliteCommandErrorCode;
  readonly receipt: CommandReceipt | undefined;

  constructor(
    code: SqliteCommandErrorCode,
    message: string,
    options: Readonly<{ cause?: unknown; receipt?: CommandReceipt }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SqliteCommandError";
    this.code = code;
    this.receipt = options.receipt;
  }
}
