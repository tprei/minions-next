import { createHash, type Hash } from "node:crypto";

import { decodeProjectionChange, ProjectionChangeSchema } from "@minions/contracts";

import {
  actorSessionId,
  attemptId,
  commandId,
  DomainError,
  eventId,
  externalOperationId,
  nonEmptyText,
  outboxId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type AggregateId,
  type AggregateKind,
  type AppliedCommand,
  type CommandReceipt,
  type CommandRequest,
  type EncodedMessage,
  type ExternalOperationIntent,
} from "@minions/core";

import {
  executeManagedSqliteWrite,
  type SqliteRow,
  type SqliteTransaction,
  type SqliteValue,
  type SqliteWriteResult,
} from "./database.js";
import { SqliteCommandError } from "./command-error.js";
import type {
  ApplySqliteCommand,
  OpenSqliteCommandStoreOptions,
  SqliteCommandStore,
  SqliteCommandTransaction,
} from "./command.js";

const aggregateTableByKind: Readonly<Record<AggregateKind, string>> = Object.freeze({
  repository: "repositories",
  tree: "trees",
  node: "nodes",
  attempt: "attempts",
});
type CommandTransactionResult = Readonly<{
  receipt: CommandReceipt;
  committed: boolean;
}>;

export function createSqliteCommandStore(
  options: OpenSqliteCommandStoreOptions,
): SqliteCommandStore {
  return new DefaultSqliteCommandStore(options);
}

class DefaultSqliteCommandStore implements SqliteCommandStore {
  readonly #options: OpenSqliteCommandStoreOptions;

  constructor(options: OpenSqliteCommandStoreOptions) {
    this.#options = options;
  }

  async execute(input: CommandRequest, apply: ApplySqliteCommand): Promise<CommandReceipt> {
    const request = snapshotRequest(input);
    const requestDigest = digestRequest(request);
    let result: CommandTransactionResult;
    try {
      result = await executeManagedSqliteWrite(this.#options.database, (transaction) =>
        this.#executeTransaction(transaction, request, requestDigest, apply),
      );
    } catch (error) {
      const knownFailure = findKnownFailure(error);
      if (knownFailure !== undefined) {
        throw knownFailure;
      }
      throw new SqliteCommandError("command_failed", "SQLite command transaction failed", {
        cause: error,
      });
    }

    if (!result.committed) {
      return result.receipt;
    }
    try {
      await this.#options.notifier.commandCommitted(freezeReceipt(result.receipt));
    } catch (error) {
      throw new SqliteCommandError(
        "post_commit_notification_failed",
        "command committed but its local notification failed",
        { cause: error, receipt: result.receipt },
      );
    }
    return result.receipt;
  }

  #executeTransaction(
    transaction: SqliteTransaction,
    request: CommandRequest,
    requestDigest: string,
    apply: ApplySqliteCommand,
  ): CommandTransactionResult {
    const replay = readReplay(transaction, request, requestDigest);
    if (replay !== undefined) {
      return Object.freeze({ receipt: replay, committed: false });
    }
    if (
      transaction.get("SELECT id FROM operator_commands WHERE id = ?", [request.id]) !== undefined
    ) {
      throw new SqliteCommandError(
        "command_result_corrupt",
        "command exists without its committed idempotency result",
      );
    }

    const previousVersion = readAggregateVersion(transaction, request);
    const occurredAt = this.#now();
    transaction.run(
      `INSERT INTO operator_commands (
        id, actor_session_id, aggregate_kind, aggregate_id, expected_version,
        command_type, command_payload, state_kind, created_at_ms, acknowledged_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?, NULL)`,
      [
        request.id,
        request.actorSessionId,
        request.aggregateKind,
        request.aggregateId,
        request.expectedVersion,
        request.command.typeName,
        request.command.bytes,
        occurredAt,
      ],
    );

    const commandTransaction = new ActiveCommandTransaction(transaction);
    let rawEffect: AppliedCommand;
    try {
      rawEffect = transaction.withCurrentStateWrites(() => apply(commandTransaction));
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new SqliteCommandError("command_failed", "command application failed", {
        cause: error,
      });
    } finally {
      commandTransaction.deactivate();
    }
    if (isThenable(rawEffect)) {
      observeThenableRejection(rawEffect);
      throw new SqliteCommandError(
        "command_async",
        "SQLite command application callbacks must complete synchronously",
      );
    }
    const effect = snapshotAppliedCommand(rawEffect);
    assertProjectionEvent(effect.event);
    const resultingVersion = readResultingAggregateVersion(transaction, request, previousVersion);
    const aggregateVersion = resultingVersion + 1;
    if (!Number.isSafeInteger(aggregateVersion)) {
      throw new SqliteCommandError(
        "aggregate_version_invariant",
        "aggregate event version exceeds the safe integer range",
      );
    }

    const persistedEventId = this.#nextId("event", eventId);
    const eventWrite = transaction.run(
      `INSERT INTO events (
        event_id, command_id, aggregate_kind, aggregate_id, aggregate_version,
        event_type, event_payload, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        persistedEventId,
        request.id,
        request.aggregateKind,
        request.aggregateId,
        aggregateVersion,
        effect.event.typeName,
        effect.event.bytes,
        occurredAt,
      ],
    );
    const eventSequence = positiveBigInt(eventWrite.lastInsertRowid, "event sequence");

    persistExternalOperations(
      transaction,
      request,
      effect.externalOperations,
      eventSequence,
      occurredAt,
      () => this.#nextId("external_operation", externalOperationId),
      () => this.#nextId("outbox", outboxId),
    );

    transaction.run(
      `INSERT INTO idempotency_records (
        command_id, actor_session_id, request_digest, result_type,
        result_payload, committed_sequence, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        request.id,
        request.actorSessionId,
        requestDigest,
        effect.result.typeName,
        effect.result.bytes,
        eventSequence,
        occurredAt,
      ],
    );
    const acknowledgement = transaction.run(
      `UPDATE operator_commands
       SET state_kind = 'applied', acknowledged_at_ms = ?
       WHERE id = ? AND state_kind = 'claimed'`,
      [occurredAt, request.id],
    );
    if (writeChanges(acknowledgement) !== 1n) {
      throw new SqliteCommandError(
        "command_result_corrupt",
        "claimed command could not be acknowledged exactly once",
      );
    }

    return Object.freeze({
      receipt: freezeReceipt({
        commandId: request.id,
        eventId: persistedEventId,
        eventSequence,
        aggregateVersion,
        result: effect.result,
      }),
      committed: true,
    });
  }

  #now() {
    try {
      return timestampFromEpochMilliseconds(this.#options.ports.clock.now());
    } catch (error) {
      throw new SqliteCommandError(
        "command_failed",
        "command clock returned an invalid timestamp",
        {
          cause: error,
        },
      );
    }
  }

  #nextId<T>(kind: "event" | "external_operation" | "outbox", parse: (value: string) => T): T {
    try {
      return parse(this.#options.ports.ids.nextId());
    } catch (error) {
      throw new SqliteCommandError("command_failed", `command ${kind} ID generation failed`, {
        cause: error,
      });
    }
  }
}

class ActiveCommandTransaction implements SqliteCommandTransaction {
  readonly #transaction: SqliteTransaction;
  #active = true;

  constructor(transaction: SqliteTransaction) {
    this.#transaction = transaction;
  }

  get(sql: string, parameters: readonly SqliteValue[] = []): SqliteRow | undefined {
    this.#assertActive();
    return this.#transaction.get(sql, parameters);
  }

  all(sql: string, parameters: readonly SqliteValue[] = []): readonly SqliteRow[] {
    this.#assertActive();
    return this.#transaction.all(sql, parameters);
  }

  run(sql: string, parameters: readonly SqliteValue[] = []): SqliteWriteResult {
    this.#assertActive();
    return this.#transaction.run(sql, parameters);
  }

  deactivate(): void {
    this.#active = false;
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new SqliteCommandError(
        "command_failed",
        "SQLite command transaction is no longer active",
      );
    }
  }
}

function snapshotRequest(input: CommandRequest): CommandRequest {
  try {
    const aggregateKind = parseAggregateKind(input.aggregateKind);
    const expectedVersion = input.expectedVersion;
    if (
      expectedVersion !== null &&
      (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    ) {
      throw new DomainError(
        "invalid_value",
        "expected version must be null or a non-negative safe integer",
      );
    }
    return Object.freeze({
      id: commandId(input.id),
      actorSessionId: actorSessionId(input.actorSessionId),
      aggregateKind,
      aggregateId: parseAggregateId(aggregateKind, input.aggregateId),
      expectedVersion,
      command: snapshotMessage(input.command, "command"),
    });
  } catch (error) {
    if (error instanceof SqliteCommandError && error.code === "invalid_command") {
      throw error;
    }
    throw new SqliteCommandError("invalid_command", "command request is invalid", { cause: error });
  }
}

function parseAggregateKind(value: unknown): AggregateKind {
  if (value === "repository" || value === "tree" || value === "node" || value === "attempt") {
    return value;
  }
  throw new DomainError("invalid_value", "aggregate kind is invalid");
}

function parseAggregateId(kind: AggregateKind, value: unknown): AggregateId {
  if (typeof value !== "string") {
    throw new DomainError("invalid_value", "aggregate ID must be a string");
  }
  if (kind === "repository") {
    return repositoryId(value);
  }
  if (kind === "tree") {
    return taskTreeId(value);
  }
  if (kind === "node") {
    return taskNodeId(value);
  }
  return attemptId(value);
}

function snapshotAppliedCommand(input: unknown): AppliedCommand {
  if (
    typeof input !== "object" ||
    input === null ||
    !("event" in input) ||
    !("result" in input) ||
    !("externalOperations" in input) ||
    !Array.isArray(input.externalOperations)
  ) {
    throw new SqliteCommandError("invalid_command", "command application result is invalid");
  }
  const keys = new Set<string>();
  const rawOperations: readonly unknown[] = input.externalOperations;
  const externalOperations = rawOperations.map((intent, index) => {
    const operation = snapshotExternalOperation(intent, index);
    const key = `${String(operation.operationKind.length)}:${operation.operationKind}${String(operation.idempotencyKey.length)}:${operation.idempotencyKey}`;
    if (keys.has(key)) {
      throw new SqliteCommandError(
        "external_operation_conflict",
        "command contains duplicate external operation idempotency keys",
      );
    }
    keys.add(key);
    return operation;
  });
  return Object.freeze({
    event: snapshotMessage(input.event, "event"),
    result: snapshotMessage(input.result, "result"),
    externalOperations: Object.freeze(externalOperations),
  });
}

function snapshotExternalOperation(input: unknown, index: number): ExternalOperationIntent {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      !("operationKind" in input) ||
      typeof input.operationKind !== "string" ||
      !("idempotencyKey" in input) ||
      typeof input.idempotencyKey !== "string" ||
      !("request" in input) ||
      !("availableAt" in input) ||
      typeof input.availableAt !== "number"
    ) {
      throw new DomainError("invalid_value", "external operation intent is malformed");
    }
    return Object.freeze({
      operationKind: nonEmptyText(input.operationKind, `external operation ${String(index)} kind`),
      idempotencyKey: nonEmptyText(
        input.idempotencyKey,
        `external operation ${String(index)} idempotency key`,
      ),
      request: snapshotMessage(input.request, `external operation ${String(index)} request`),
      availableAt: timestampFromEpochMilliseconds(input.availableAt),
    });
  } catch (error) {
    throw new SqliteCommandError("invalid_command", "external operation intent is invalid", {
      cause: error,
    });
  }
}

function snapshotMessage(input: unknown, fieldName: string): EncodedMessage {
  if (
    typeof input !== "object" ||
    input === null ||
    !("bytes" in input) ||
    !(input.bytes instanceof Uint8Array) ||
    !("typeName" in input) ||
    typeof input.typeName !== "string"
  ) {
    throw new DomainError("invalid_value", `${fieldName} message is invalid`);
  }
  if (input.bytes.byteLength === 0) {
    throw new DomainError("invalid_value", `${fieldName} payload must not be empty`);
  }
  return Object.freeze({
    typeName: nonEmptyText(input.typeName, `${fieldName} type name`),
    bytes: new Uint8Array(input.bytes),
  });
}

function digestRequest(request: CommandRequest): string {
  const hash = createHash("sha256");
  updateDigestText(hash, "minions-command-v1");
  updateDigestText(hash, request.id);
  updateDigestText(hash, request.actorSessionId);
  updateDigestText(hash, request.aggregateKind);
  updateDigestText(hash, request.aggregateId);
  updateDigestText(
    hash,
    request.expectedVersion === null ? "null" : `version:${String(request.expectedVersion)}`,
  );
  updateDigestText(hash, request.command.typeName);
  updateDigestBytes(hash, request.command.bytes);
  return hash.digest("hex");
}

function assertProjectionEvent(event: EncodedMessage): void {
  if (event.typeName !== ProjectionChangeSchema.typeName) {
    throw new SqliteCommandError(
      "invalid_command",
      "command events must use minions.v1.ProjectionChange",
    );
  }
  try {
    decodeProjectionChange(event.bytes);
  } catch (error) {
    throw new SqliteCommandError(
      "invalid_command",
      "command projection event violates its Protobuf contract",
      { cause: error },
    );
  }
}

function updateDigestText(hash: Hash, value: string): void {
  hash.update(`${String(Buffer.byteLength(value, "utf8"))}:`, "utf8");
  hash.update(value, "utf8");
}

function updateDigestBytes(hash: Hash, value: Uint8Array): void {
  hash.update(`${String(value.byteLength)}:`, "utf8");
  hash.update(value);
}

function readReplay(
  transaction: SqliteTransaction,
  request: CommandRequest,
  requestDigest: string,
): CommandReceipt | undefined {
  const row = transaction.get(
    `SELECT
       idempotency_records.request_digest,
       idempotency_records.result_type,
       idempotency_records.result_payload,
       idempotency_records.committed_sequence,
       events.event_id,
       events.aggregate_version
     FROM idempotency_records
     LEFT JOIN events
       ON events.sequence = idempotency_records.committed_sequence
      AND events.command_id = idempotency_records.command_id
     WHERE idempotency_records.command_id = ?`,
    [request.id],
  );
  if (row === undefined) {
    return undefined;
  }
  const storedDigest = requiredText(row, "request_digest", "request digest");
  if (storedDigest !== requestDigest) {
    throw new SqliteCommandError(
      "command_id_conflict",
      "command ID was already used for a different request",
    );
  }
  try {
    return freezeReceipt({
      commandId: request.id,
      eventId: eventId(requiredText(row, "event_id", "event ID")),
      eventSequence: positiveBigInt(row["committed_sequence"], "committed sequence"),
      aggregateVersion: positiveSafeInteger(row["aggregate_version"], "aggregate version"),
      result: Object.freeze({
        typeName: nonEmptyText(requiredText(row, "result_type", "result type"), "result type"),
        bytes: requiredBytes(row, "result_payload", "result payload"),
      }),
    });
  } catch (error) {
    if (error instanceof SqliteCommandError) {
      throw error;
    }
    throw new SqliteCommandError("command_result_corrupt", "stored command result is malformed", {
      cause: error,
    });
  }
}

function readAggregateVersion(
  transaction: SqliteTransaction,
  request: CommandRequest,
): number | null {
  const table = aggregateTableByKind[request.aggregateKind];
  const row = transaction.get(`SELECT version FROM ${table} WHERE id = ?`, [request.aggregateId]);
  if (request.expectedVersion === null) {
    if (row !== undefined) {
      throw new SqliteCommandError(
        "aggregate_version_conflict",
        "aggregate already exists for a create command",
      );
    }
    return null;
  }
  if (row === undefined) {
    throw new SqliteCommandError("aggregate_version_conflict", "command aggregate does not exist");
  }
  const currentVersion = nonNegativeSafeInteger(row["version"], "aggregate version");
  if (currentVersion !== request.expectedVersion) {
    throw new SqliteCommandError(
      "aggregate_version_conflict",
      "command expected version does not match current aggregate version",
    );
  }
  return currentVersion;
}

function readResultingAggregateVersion(
  transaction: SqliteTransaction,
  request: CommandRequest,
  previousVersion: number | null,
): number {
  const table = aggregateTableByKind[request.aggregateKind];
  const row = transaction.get(`SELECT version FROM ${table} WHERE id = ?`, [request.aggregateId]);
  if (row === undefined) {
    throw new SqliteCommandError(
      "aggregate_version_invariant",
      "command did not persist its target aggregate",
    );
  }
  const resultingVersion = nonNegativeSafeInteger(row["version"], "resulting aggregate version");
  const expectedResult = previousVersion === null ? 0 : previousVersion + 1;
  if (!Number.isSafeInteger(expectedResult) || resultingVersion !== expectedResult) {
    throw new SqliteCommandError(
      "aggregate_version_invariant",
      "command did not advance its target aggregate version exactly once",
    );
  }
  return resultingVersion;
}

function persistExternalOperations(
  transaction: SqliteTransaction,
  request: CommandRequest,
  intents: readonly ExternalOperationIntent[],
  eventSequence: bigint,
  occurredAt: number,
  nextOperationId: () => string,
  nextOutboxId: () => string,
): void {
  for (const intent of intents) {
    const existing = transaction.get(
      `SELECT command_id FROM external_operations
       WHERE operation_kind = ? AND idempotency_key = ?`,
      [intent.operationKind, intent.idempotencyKey],
    );
    if (existing !== undefined) {
      const existingCommand = requiredText(existing, "command_id", "external operation command ID");
      throw new SqliteCommandError(
        existingCommand === request.id ? "command_result_corrupt" : "external_operation_conflict",
        "external operation idempotency key is already owned",
      );
    }
    const operationId = nextOperationId();
    const persistedOutboxId = nextOutboxId();
    transaction.run(
      `INSERT INTO external_operations (
        id, command_id, operation_kind, idempotency_key, request_type,
        request_payload, state_kind, receipt_type, receipt_payload,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
      [
        operationId,
        request.id,
        intent.operationKind,
        intent.idempotencyKey,
        intent.request.typeName,
        intent.request.bytes,
        occurredAt,
        occurredAt,
      ],
    );
    transaction.run(
      `INSERT INTO outbox (
        id, command_id, event_sequence, operation_id, state_kind,
        available_at_ms, claimed_at_ms, dispatched_at_ms
      ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
      [persistedOutboxId, request.id, eventSequence, operationId, intent.availableAt],
    );
  }
}

function freezeReceipt(receipt: CommandReceipt): CommandReceipt {
  return Object.freeze({
    commandId: receipt.commandId,
    eventId: receipt.eventId,
    eventSequence: receipt.eventSequence,
    aggregateVersion: receipt.aggregateVersion,
    result: Object.freeze({
      typeName: receipt.result.typeName,
      bytes: new Uint8Array(receipt.result.bytes),
    }),
  });
}

function requiredText(row: SqliteRow, key: string, fieldName: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SqliteCommandError("command_result_corrupt", `stored ${fieldName} is malformed`);
  }
  return value;
}

function requiredBytes(row: SqliteRow, key: string, fieldName: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new SqliteCommandError("command_result_corrupt", `stored ${fieldName} is malformed`);
  }
  return new Uint8Array(value);
}

function nonNegativeSafeInteger(value: unknown, fieldName: string): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SqliteCommandError(
        "aggregate_version_invariant",
        `${fieldName} is outside the safe integer range`,
      );
    }
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SqliteCommandError(
      "aggregate_version_invariant",
      `${fieldName} is not a non-negative safe integer`,
    );
  }
  return value;
}

function positiveSafeInteger(value: unknown, fieldName: string): number {
  const parsed = nonNegativeSafeInteger(value, fieldName);
  if (parsed === 0) {
    throw new SqliteCommandError("command_result_corrupt", `${fieldName} must be positive`);
  }
  return parsed;
}

function positiveBigInt(value: unknown, fieldName: string): bigint {
  if (typeof value === "bigint") {
    if (value > 0n) {
      return value;
    }
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }
  throw new SqliteCommandError("command_result_corrupt", `${fieldName} is malformed`);
}

function writeChanges(result: SqliteWriteResult): bigint {
  return typeof result.changes === "bigint" ? result.changes : BigInt(result.changes);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  return Reflect.get(value, "then") instanceof Function;
}

function observeThenableRejection(value: PromiseLike<unknown>): void {
  void Promise.resolve(value).catch(() => undefined);
}

function findKnownFailure(error: unknown): SqliteCommandError | DomainError | undefined {
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof SqliteCommandError || current instanceof DomainError) {
      return current;
    }
    visited.add(current);
    current = current.cause;
  }
  return undefined;
}
