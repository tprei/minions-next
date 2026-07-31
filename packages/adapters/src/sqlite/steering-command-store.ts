import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { MessageShape } from "@bufbuild/protobuf";
import {
  AnswerNodeCommandSchema,
  EmptyNodeCommandSchema,
  NodeAttentionKind,
  NodeAttentionSchema,
  NodeAttentionState,
  NodeCommandDeliveryState,
  NodeCommandPayloadSchema,
  NodeCommandRecoveryDisposition,
  NodeCommandSchema,
  ProjectionBatchSchema,
  ProjectionChangeSchema,
  QueueNodeCommandRequestSchema,
  QueueNodeCommandResponseSchema,
  ReplanNodeCommandSchema,
  ResolveApprovalNodeCommandSchema,
  TextNodeCommandSchema,
  findUnknownField,
} from "@minions/contracts";
import type {
  NodeAttention,
  NodeCommand,
  NodeCommandPayload as WireNodeCommandPayload,
} from "@minions/contracts";
import {
  actorSessionId,
  commandId,
  DomainError,
  eventId,
  nodeAttentionId,
  nodeCommandDeliveryToken,
  nodeCommandIsSafeToRedeliver,
  nonEmptyText,
  taskNodeId,
  timestampFromEpochMilliseconds,
  type CommandId,
  type DomainPorts,
  type NodeAttentionId,
  type NodeCommandPayload,
  type NodeCommandRecord,
  type NodeCommandRecoveryDisposition as CoreRecoveryDisposition,
  type NodeCommandDeliveryState as CoreDeliveryState,
  type NodeAttentionRecord,
  type TaskNodeId,
  type Timestamp,
  type NodeCommandDeliveryToken,
  type QueueNodeCommandRequest,
  type ClaimNodeCommandRequest,
  type AcknowledgeNodeCommandRequest,
  type ApplyNodeCommandRequest,
  type FailNodeCommandRequest,
  type ListNodeCommandsRequest,
  type CreateNodeAttentionRequest,
  type SteeringCommandStore,
} from "@minions/core";
import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteReader,
  type SqliteRow,
  type SqliteTransaction,
} from "./database.js";
import type { SqliteCommandStore, SqliteCommandTransaction } from "./command.js";
import { SqliteCommandError } from "./command-error.js";

export type SqliteSteeringErrorCode =
  | "invalid_command"
  | "not_found"
  | "stale_delivery"
  | "invalid_transition"
  | "attention_not_found"
  | "attention_closed"
  | "corrupt";

export class SqliteSteeringError extends Error {
  readonly code: SqliteSteeringErrorCode;

  constructor(code: SqliteSteeringErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteSteeringError";
    this.code = code;
  }
}

export type CreateSqliteSteeringCommandStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
  commandStore: SqliteCommandStore;
  ports: DomainPorts;
}>;

export function createSqliteSteeringCommandStore(
  options: CreateSqliteSteeringCommandStoreOptions,
): SteeringCommandStore {
  return new DefaultSqliteSteeringCommandStore(options);
}

class DefaultSqliteSteeringCommandStore implements SteeringCommandStore {
  readonly #database: ManagedSqliteDatabase;
  readonly #commandStore: SqliteCommandStore;
  readonly #ports: DomainPorts;

  constructor(options: CreateSqliteSteeringCommandStoreOptions) {
    this.#database = options.database;
    this.#commandStore = options.commandStore;
    this.#ports = options.ports;
  }

  async queue(input: QueueNodeCommandRequest): Promise<NodeCommandRecord> {
    const request = snapshotQueueRequest(input);
    const expectedVersion = this.#expectedNodeVersion(request.commandId, request.nodeId);
    if (
      request.expectedNodeVersion !== undefined &&
      request.expectedNodeVersion !== expectedVersion
    ) {
      throw new SqliteSteeringError(
        "invalid_transition",
        "expected node version does not match current node version",
      );
    }
    const wireRequest = create(QueueNodeCommandRequestSchema, {
      commandId: request.commandId,
      actorSessionId: request.actorSessionId,
      nodeId: request.nodeId,
      expectedNodeVersion: BigInt(expectedVersion),
      payload: encodePayloadMessage(request.payload),
    });
    const command = {
      id: request.commandId,
      actorSessionId: request.actorSessionId,
      aggregateKind: "node" as const,
      aggregateId: request.nodeId,
      expectedVersion,
      command: {
        typeName: nonEmptyText(QueueNodeCommandRequestSchema.typeName, "queue request type name"),
        bytes: toBinary(QueueNodeCommandRequestSchema, wireRequest),
      },
    } as const;

    let receipt;
    try {
      receipt = await this.#commandStore.execute(command, (transaction) =>
        this.#applyQueue(transaction, request),
      );
    } catch (error) {
      throw normalizeQueueError(error);
    }

    try {
      if (receipt.result.typeName !== QueueNodeCommandResponseSchema.typeName) {
        throw new TypeError("queue command result type is invalid");
      }
      const result = fromBinary(QueueNodeCommandResponseSchema, receipt.result.bytes);
      assertNoUnknownQueueResult(result);
      if (result.command === undefined) {
        throw new TypeError("queue command result has no command");
      }
      const decoded = decodeWireNodeCommand(result.command);
      if (
        decoded.commandId !== request.commandId ||
        decoded.actorSessionId !== request.actorSessionId ||
        decoded.nodeId !== request.nodeId ||
        decoded.state !== "queued"
      ) {
        throw new TypeError("queued command result identity is invalid");
      }
      return decoded;
    } catch (error) {
      throw new SqliteSteeringError("corrupt", "queued command result is corrupt", {
        cause: error,
      });
    }
  }

  get(input: CommandId): NodeCommandRecord | undefined {
    const parsed = parseCommandId(input, "command ID");
    try {
      return this.#database.read((reader) => {
        const row = reader.get(
          `SELECT command_id, actor_session_id, node_id, ordinal, command_kind, payload,
                  safe_to_redeliver, state_kind, recovery_disposition, delivery_attempts,
                  delivery_token, created_at_ms, sent_at_ms, acknowledged_at_ms, applied_at_ms,
                  failed_at_ms, failure
             FROM node_command_deliveries WHERE command_id = ?`,
          [parsed],
        );
        return row === undefined ? undefined : decodeCommandRow(row);
      });
    } catch (error) {
      if (error instanceof SqliteSteeringError) throw error;
      throw new SqliteSteeringError("corrupt", "steering command row is corrupt", { cause: error });
    }
  }

  list(input: ListNodeCommandsRequest): readonly NodeCommandRecord[] {
    const request = snapshotListRequest(input);
    try {
      return this.#database.read((reader) => {
        requireNode(reader, request.nodeId);
        if (request.afterOrdinal > 9_223_372_036_854_775_807n) return Object.freeze([]);
        const rows = reader.all(
          `SELECT command_id, actor_session_id, node_id, ordinal, command_kind, payload,
                  safe_to_redeliver, state_kind, recovery_disposition, delivery_attempts,
                  delivery_token, created_at_ms, sent_at_ms, acknowledged_at_ms, applied_at_ms,
                  failed_at_ms, failure
             FROM node_command_deliveries
            WHERE node_id = ? AND ordinal > ?
            ORDER BY ordinal LIMIT ?`,
          [request.nodeId, request.afterOrdinal, request.limit],
        );
        return Object.freeze(rows.map(decodeCommandRow));
      });
    } catch (error) {
      if (error instanceof SqliteSteeringError) throw error;
      throw new SqliteSteeringError("corrupt", "steering command list is corrupt", {
        cause: error,
      });
    }
  }

  async claimNext(input: ClaimNodeCommandRequest): Promise<NodeCommandRecord | undefined> {
    const request = snapshotClaimRequest(input);
    try {
      return await executeManagedSqliteWrite(this.#database, (transaction) => {
        requireNode(transaction, request.nodeId);
        if (request.afterOrdinal > 9_223_372_036_854_775_807n) return undefined;
        const rawRow = transaction.get(
          `SELECT command_id, actor_session_id, node_id, ordinal, command_kind, payload,
                  safe_to_redeliver, state_kind, recovery_disposition, delivery_attempts,
                  delivery_token, created_at_ms, sent_at_ms, acknowledged_at_ms, applied_at_ms,
                  failed_at_ms, failure
             FROM node_command_deliveries
            WHERE node_id = ? AND ordinal > ?
            ORDER BY ordinal LIMIT 1`,
          [request.nodeId, request.afterOrdinal],
        );
        if (rawRow === undefined) return undefined;
        const row = decodeCommandRow(rawRow);
        if (row.state === "queued") {
          updateDelivery(
            transaction,
            row,
            "sent",
            request.at,
            request.deliveryToken,
            1,
            undefined,
            row.recoveryDisposition,
            this.#ports,
          );
          return decodeCommandRowById(transaction, row.commandId);
        }
        if (row.state === "sent") {
          if (row.deliveryToken === request.deliveryToken) return row;
          const sentAt = row.sentAt;
          if (sentAt === undefined || request.at < sentAt) return undefined;
          if (request.at - sentAt < request.acknowledgementTimeoutMs) return undefined;
          if (!nodeCommandIsSafeToRedeliver(row.payload)) {
            updateDelivery(
              transaction,
              row,
              "review_required",
              request.at,
              row.deliveryToken,
              row.deliveryAttempts,
              "delivery acknowledgement timed out for a non-redeliverable command",
              "requires_review",
              this.#ports,
            );
            return undefined;
          }
          const attempts = incrementAttempts(row.deliveryAttempts);
          updateDelivery(
            transaction,
            row,
            "sent",
            request.at,
            request.deliveryToken,
            attempts,
            undefined,
            row.recoveryDisposition,
            this.#ports,
          );
          return decodeCommandRowById(transaction, row.commandId);
        }
        if (row.state === "acknowledged") {
          if (row.deliveryToken !== request.deliveryToken) {
            throw new SqliteSteeringError("stale_delivery", "delivery token is stale");
          }
          const resolvedAttention = resolveAttention(transaction, row, request.at);
          updateDelivery(
            transaction,
            row,
            "applied",
            request.at,
            row.deliveryToken,
            row.deliveryAttempts,
            undefined,
            row.recoveryDisposition,
            this.#ports,
            resolvedAttention,
          );
          return decodeCommandRowById(transaction, row.commandId);
        }
        return undefined;
      });
    } catch (error) {
      if (error instanceof SqliteSteeringError) throw error;
      throw new SqliteSteeringError("corrupt", "steering command claim failed", { cause: error });
    }
  }

  async acknowledge(input: AcknowledgeNodeCommandRequest): Promise<NodeCommandRecord> {
    const request = snapshotAcknowledgeRequest(input);
    return this.#transition(
      request.delivery.commandId,
      request.delivery.deliveryToken,
      request.at,
      (transaction, row) => {
        if (row.state === "acknowledged") return row;
        requireState(row, "sent");
        requireAtAfter(request.at, row.sentAt, "acknowledgement timestamp");
        updateDelivery(
          transaction,
          row,
          "acknowledged",
          request.at,
          row.deliveryToken,
          row.deliveryAttempts,
          undefined,
          row.recoveryDisposition,
          this.#ports,
        );
        return decodeCommandRowById(transaction, row.commandId);
      },
    );
  }

  async apply(input: ApplyNodeCommandRequest): Promise<NodeCommandRecord> {
    const request = snapshotApplyRequest(input);
    return this.#transition(
      request.delivery.commandId,
      request.delivery.deliveryToken,
      request.at,
      (transaction, row) => {
        if (row.state === "applied") return row;
        requireState(row, "acknowledged");
        requireAtAfter(request.at, row.acknowledgedAt, "application timestamp");
        const resolvedAttention = resolveAttention(transaction, row, request.at);
        updateDelivery(
          transaction,
          row,
          "applied",
          request.at,
          row.deliveryToken,
          row.deliveryAttempts,
          undefined,
          row.recoveryDisposition,
          this.#ports,
          resolvedAttention,
        );
        return decodeCommandRowById(transaction, row.commandId);
      },
    );
  }

  async fail(input: FailNodeCommandRequest): Promise<NodeCommandRecord> {
    const request = snapshotFailRequest(input);
    return this.#transition(
      request.delivery.commandId,
      request.delivery.deliveryToken,
      request.at,
      (transaction, row) => {
        if (row.state === "failed" || row.state === "review_required") return row;
        requireState(row, "sent", "acknowledged");
        if (row.state === "acknowledged" && request.ambiguous) {
          throw new SqliteSteeringError(
            "invalid_transition",
            "acknowledged delivery cannot be ambiguous",
          );
        }
        requireAtAfter(request.at, row.sentAt, "failure timestamp");
        requireAtAfter(request.at, row.acknowledgedAt, "failure timestamp");
        const reviewRequired = request.ambiguous && row.state === "sent";
        const state = reviewRequired ? "review_required" : "failed";
        const disposition: CoreRecoveryDisposition = reviewRequired
          ? "requires_review"
          : "retry_external_action";
        updateDelivery(
          transaction,
          row,
          state,
          request.at,
          row.deliveryToken,
          row.deliveryAttempts,
          request.failure,
          disposition,
          this.#ports,
        );
        return decodeCommandRowById(transaction, row.commandId);
      },
    );
  }

  async createAttention(input: CreateNodeAttentionRequest): Promise<NodeAttentionRecord> {
    const request = snapshotAttentionRequest(input);
    const expectedVersion = this.#expectedNodeVersion(request.commandId, request.nodeId);
    const wireAttention = create(NodeAttentionSchema, {
      id: request.id,
      nodeId: request.nodeId,
      kind: wireAttentionKind(request.kind),
      prompt: request.prompt,
      choices: [...request.choices],
      state: NodeAttentionState.OPEN,
      createdAt: timestampMessage(request.at),
    });
    const command = {
      id: request.commandId,
      actorSessionId: request.actorSessionId,
      aggregateKind: "node" as const,
      aggregateId: request.nodeId,
      expectedVersion,
      command: {
        typeName: nonEmptyText(NodeAttentionSchema.typeName, "attention command type name"),
        bytes: toBinary(NodeAttentionSchema, wireAttention),
      },
    } as const;
    let receipt;
    try {
      receipt = await this.#commandStore.execute(command, (transaction) =>
        this.#applyAttention(transaction, request),
      );
    } catch (error) {
      throw normalizeSteeringCommandError(error, "attention command transaction failed");
    }
    try {
      if (receipt.result.typeName !== NodeAttentionSchema.typeName) {
        throw new TypeError("attention command result type is invalid");
      }
      const result = fromBinary(NodeAttentionSchema, receipt.result.bytes);
      const decoded = decodeWireAttention(result);
      if (
        decoded.id !== request.id ||
        decoded.nodeId !== request.nodeId ||
        decoded.kind !== request.kind ||
        decoded.state !== "open"
      ) {
        throw new TypeError("attention command result identity is invalid");
      }
      return decoded;
    } catch (error) {
      throw new SqliteSteeringError("corrupt", "attention command result is corrupt", {
        cause: error,
      });
    }
  }

  #applyAttention(transaction: SqliteCommandTransaction, request: CreateNodeAttentionRequest) {
    const node = requireNode(transaction, request.nodeId);
    const nodeVersion = safeNumber(node["version"], "node version");
    if (request.at < timestampNumber(node["updated_at_ms"], "node update timestamp")) {
      throw new SqliteSteeringError(
        "invalid_command",
        "attention timestamp predates the node update",
      );
    }
    transaction.run(
      `INSERT INTO node_attention_records (
         id, node_id, attention_kind, prompt, choices_json, state_kind,
         resolution_command_id, resolution, created_at_ms, resolved_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, ?, NULL)`,
      [
        request.id,
        request.nodeId,
        request.kind,
        request.prompt,
        JSON.stringify(request.choices),
        request.at,
      ],
    );
    advanceNodeVersion(transaction, request.nodeId, request.at, nodeVersion);
    const attention = decodeAttentionRowById(transaction, request.id);
    const event = nodeAttentionProjection(attention);
    const result = nodeAttentionMessage(attention);
    return {
      event: {
        typeName: nonEmptyText(ProjectionChangeSchema.typeName, "projection event type name"),
        bytes: toBinary(ProjectionChangeSchema, event),
      },
      result: {
        typeName: nonEmptyText(NodeAttentionSchema.typeName, "attention result type name"),
        bytes: toBinary(NodeAttentionSchema, result),
      },
      externalOperations: [],
    } as const;
  }

  listAttention(nodeIdInput: TaskNodeId, openOnly: boolean): readonly NodeAttentionRecord[] {
    const nodeId = parseNodeId(nodeIdInput, "node ID");
    if (typeof openOnly !== "boolean") {
      throw new SqliteSteeringError("invalid_command", "attention openOnly flag is invalid");
    }
    try {
      return this.#database.read((reader) => {
        requireNode(reader, nodeId);
        const rows = reader.all(
          `SELECT id, node_id, attention_kind, prompt, choices_json, state_kind,
                  resolution_command_id, resolution, created_at_ms, resolved_at_ms
             FROM node_attention_records
            WHERE node_id = ? ${openOnly ? "AND state_kind = 'open'" : ""}
            ORDER BY created_at_ms, id`,
          [nodeId],
        );
        return Object.freeze(rows.map(decodeAttentionRow));
      });
    } catch (error) {
      if (error instanceof SqliteSteeringError) throw error;
      throw new SqliteSteeringError("corrupt", "attention list is corrupt", { cause: error });
    }
  }

  #expectedNodeVersion(command: CommandId, nodeId: TaskNodeId): number {
    try {
      return this.#database.read((reader) => {
        const existing = reader.get(
          `SELECT aggregate_kind, aggregate_id, expected_version
             FROM operator_commands WHERE id = ?`,
          [command],
        );
        if (existing !== undefined) {
          const aggregateKind = requiredText(existing, "aggregate_kind");
          const aggregateId = requiredText(existing, "aggregate_id");
          const expected = existing["expected_version"];
          if (aggregateKind === "node" && aggregateId === nodeId && expected !== null) {
            return safeNumber(expected, "expected node version");
          }
        }
        const node = requireNode(reader, nodeId);
        return safeNumber(node["version"], "node version");
      });
    } catch (error) {
      if (error instanceof SqliteSteeringError) throw error;
      throw new SqliteSteeringError("corrupt", "node version is corrupt", { cause: error });
    }
  }

  #applyQueue(transaction: SqliteCommandTransaction, request: QueueNodeCommandRequest) {
    const node = requireNode(transaction, request.nodeId);
    const nodeVersion = safeNumber(node["version"], "node version");
    const nodeUpdatedAt = timestampNumber(node["updated_at_ms"], "node update timestamp");
    if (request.at < nodeUpdatedAt) {
      throw new DomainError("invalid_value", "queue timestamp predates the node update");
    }
    validateQueueAttention(transaction, request.nodeId, request.payload);
    const sequence = transaction.get(
      "SELECT next_ordinal FROM node_command_sequences WHERE node_id = ?",
      [request.nodeId],
    );
    let ordinal: bigint;
    if (sequence === undefined) {
      ordinal = 1n;
      transaction.run("INSERT INTO node_command_sequences (node_id, next_ordinal) VALUES (?, 2)", [
        request.nodeId,
      ]);
    } else {
      const next = positiveBigint(sequence, "next_ordinal");
      ordinal = next;
      transaction.run(
        "UPDATE node_command_sequences SET next_ordinal = ? WHERE node_id = ? AND next_ordinal = ?",
        [next + 1n, request.nodeId, next],
      );
    }
    const disposition = recoveryDisposition(node["state_kind"], node["resume_state_kind"]);
    const safe = nodeCommandIsSafeToRedeliver(request.payload) ? 1 : 0;
    transaction.run(
      `INSERT INTO node_command_deliveries (
         command_id, actor_session_id, node_id, ordinal, command_kind, payload,
         safe_to_redeliver, state_kind, recovery_disposition, delivery_attempts,
         delivery_token, created_at_ms, sent_at_ms, acknowledged_at_ms, applied_at_ms,
         failed_at_ms, failure
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, ?, NULL, NULL, NULL, NULL, NULL)`,
      [
        request.commandId,
        request.actorSessionId,
        request.nodeId,
        ordinal,
        request.payload.kind,
        encodePayload(request.payload),
        safe,
        disposition,
        request.at,
      ],
    );
    advanceNodeVersion(transaction, request.nodeId, request.at, nodeVersion);
    const commandRecord = decodeCommandRowById(transaction, request.commandId);
    const event = nodeCommandProjection(commandRecord);
    if (event.change.case !== "nodeCommandUpserted") {
      throw new SqliteSteeringError("corrupt", "node command projection event is malformed");
    }
    const result = create(QueueNodeCommandResponseSchema, { command: event.change.value });
    return {
      event: {
        typeName: nonEmptyText(ProjectionChangeSchema.typeName, "projection event type name"),
        bytes: toBinary(ProjectionChangeSchema, event),
      },
      result: {
        typeName: nonEmptyText(QueueNodeCommandResponseSchema.typeName, "queue result type name"),
        bytes: toBinary(QueueNodeCommandResponseSchema, result),
      },
      externalOperations: [],
    } as const;
  }

  async #transition(
    commandIdInput: CommandId,
    tokenInput: NodeCommandDeliveryToken,
    at: Timestamp,
    operation: (transaction: SqliteTransaction, row: NodeCommandRecord) => NodeCommandRecord,
  ): Promise<NodeCommandRecord> {
    const commandIdValue = parseCommandId(commandIdInput, "command ID");
    const token = parseDeliveryToken(tokenInput, "delivery token");
    try {
      return await executeManagedSqliteWrite(this.#database, (transaction) => {
        const existing = transaction.get(
          "SELECT command_id FROM node_command_deliveries WHERE command_id = ?",
          [commandIdValue],
        );
        if (existing === undefined) {
          throw new SqliteSteeringError("not_found", "node command was not found");
        }
        const row = decodeCommandRowById(transaction, commandIdValue);
        if (row.deliveryToken !== token) {
          throw new SqliteSteeringError("stale_delivery", "delivery token is stale");
        }
        const result = operation(transaction, row);
        if (result.commandId !== row.commandId) {
          throw new SqliteSteeringError("corrupt", "delivery transition returned another command");
        }
        return result;
      });
    } catch (error) {
      if (error instanceof SqliteSteeringError) throw error;
      throw new SqliteSteeringError("corrupt", "steering command transition failed", {
        cause: error,
      });
    }
  }
}

function snapshotQueueRequest(input: QueueNodeCommandRequest): QueueNodeCommandRequest {
  try {
    const command = parseCommandId(input.commandId, "command ID");
    const actor = parseActorSessionId(input.actorSessionId, "actor session ID");
    const node = parseNodeId(input.nodeId, "node ID");
    const at = timestampFromEpochMilliseconds(input.at);
    const payload = snapshotPayload(input.payload);
    if (
      input.expectedNodeVersion !== undefined &&
      (!Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 0)
    ) {
      throw new TypeError("expected node version is invalid");
    }
    return Object.freeze({
      commandId: command,
      actorSessionId: actor,
      nodeId: node,
      expectedNodeVersion: input.expectedNodeVersion,
      payload,
      at,
    });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("invalid_command", "queue request is invalid", { cause: error });
  }
}

function snapshotListRequest(input: ListNodeCommandsRequest): ListNodeCommandsRequest {
  try {
    const nodeId = parseNodeId(input.nodeId, "node ID");
    if (typeof input.afterOrdinal !== "bigint" || input.afterOrdinal < 0n) {
      throw new TypeError("after ordinal is invalid");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 201) {
      throw new TypeError("list limit must be between 1 and 201");
    }
    return Object.freeze({ nodeId, afterOrdinal: input.afterOrdinal, limit: input.limit });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("invalid_command", "list request is invalid", { cause: error });
  }
}

function snapshotClaimRequest(input: ClaimNodeCommandRequest): ClaimNodeCommandRequest {
  try {
    const nodeId = parseNodeId(input.nodeId, "node ID");
    if (typeof input.afterOrdinal !== "bigint" || input.afterOrdinal < 0n) {
      throw new TypeError("after ordinal is invalid");
    }
    const at = timestampFromEpochMilliseconds(input.at);
    if (
      !Number.isSafeInteger(input.acknowledgementTimeoutMs) ||
      input.acknowledgementTimeoutMs <= 0
    ) {
      throw new TypeError("acknowledgement timeout is invalid");
    }
    const deliveryToken = parseDeliveryToken(input.deliveryToken, "delivery token");
    return Object.freeze({
      nodeId,
      afterOrdinal: input.afterOrdinal,
      at,
      acknowledgementTimeoutMs: input.acknowledgementTimeoutMs,
      deliveryToken,
    });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("invalid_command", "claim request is invalid", { cause: error });
  }
}

function snapshotAcknowledgeRequest(
  input: AcknowledgeNodeCommandRequest,
): AcknowledgeNodeCommandRequest {
  try {
    return Object.freeze({
      delivery: snapshotDelivery(input.delivery),
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("invalid_command", "acknowledge request is invalid", {
      cause: error,
    });
  }
}

function snapshotApplyRequest(input: ApplyNodeCommandRequest): ApplyNodeCommandRequest {
  try {
    return Object.freeze({
      delivery: snapshotDelivery(input.delivery),
      at: timestampFromEpochMilliseconds(input.at),
    });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("invalid_command", "apply request is invalid", { cause: error });
  }
}

function snapshotFailRequest(input: FailNodeCommandRequest): FailNodeCommandRequest {
  try {
    if (typeof input.failure !== "string" || input.failure.trim().length === 0) {
      throw new TypeError("failure must not be empty");
    }
    if (typeof input.ambiguous !== "boolean") throw new TypeError("ambiguous flag is invalid");
    return Object.freeze({
      delivery: snapshotDelivery(input.delivery),
      at: timestampFromEpochMilliseconds(input.at),
      failure: input.failure,
      ambiguous: input.ambiguous,
    });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("invalid_command", "fail request is invalid", { cause: error });
  }
}

function snapshotDelivery(
  input: AcknowledgeNodeCommandRequest["delivery"],
): AcknowledgeNodeCommandRequest["delivery"] {
  return Object.freeze({
    commandId: parseCommandId(input.commandId, "command ID"),
    deliveryToken: parseDeliveryToken(input.deliveryToken, "delivery token"),
  });
}

function snapshotAttentionRequest(input: CreateNodeAttentionRequest): CreateNodeAttentionRequest {
  try {
    const command = parseCommandId(input.commandId, "command ID");
    const actor = parseActorSessionId(input.actorSessionId, "actor session ID");
    const id = parseAttentionId(input.id, "attention ID");
    const nodeId = parseNodeId(input.nodeId, "node ID");
    const prompt = nonEmptyText(input.prompt, "attention prompt");
    if (!Array.isArray(input.choices)) throw new TypeError("attention choices are invalid");
    const choices = input.choices.map((choice: unknown): string => {
      if (typeof choice !== "string") throw new TypeError("attention choice is invalid");
      return nonEmptyText(choice, "attention choice");
    });
    if (new Set(choices).size !== choices.length)
      throw new TypeError("attention choices are duplicated");
    const at = timestampFromEpochMilliseconds(input.at);
    return Object.freeze({
      commandId: command,
      actorSessionId: actor,
      id,
      nodeId,
      kind: input.kind,
      prompt,
      choices: Object.freeze(choices),
      at,
    });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("invalid_command", "attention request is invalid", {
      cause: error,
    });
  }
}

function snapshotPayload(input: unknown): NodeCommandPayload {
  if (typeof input !== "object" || input === null || !("kind" in input)) {
    throw new TypeError("command payload is invalid");
  }
  const kind = input.kind;
  switch (kind) {
    case "message":
    case "steer_after_current_tool":
    case "follow_up_after_turn":
      if (!("text" in input) || typeof input.text !== "string")
        throw new TypeError("command text is invalid");
      return Object.freeze({ kind, text: nonEmptyText(input.text, "command text") });
    case "interrupt_now":
    case "pause":
    case "resume":
    case "retry":
    case "cancel_node":
    case "cancel_subtree":
      return Object.freeze({ kind });
    case "answer":
      if (!("attentionId" in input) || typeof input.attentionId !== "string")
        throw new TypeError("attention ID is invalid");
      if (!("answer" in input) || typeof input.answer !== "string")
        throw new TypeError("answer is invalid");
      return Object.freeze({
        kind,
        attentionId: nodeAttentionId(input.attentionId),
        answer: nonEmptyText(input.answer, "answer"),
      });
    case "approve":
    case "reject":
      if (!("attentionId" in input) || typeof input.attentionId !== "string")
        throw new TypeError("attention ID is invalid");
      if (!("reason" in input) || input.reason === undefined)
        return Object.freeze({
          kind,
          attentionId: nodeAttentionId(input.attentionId),
          reason: undefined,
        });
      if (typeof input.reason !== "string") throw new TypeError("approval reason is invalid");
      return Object.freeze({
        kind,
        attentionId: nodeAttentionId(input.attentionId),
        reason: nonEmptyText(input.reason, "approval reason"),
      });
    case "replan_unstarted_subtree":
      if (!("objective" in input) || typeof input.objective !== "string")
        throw new TypeError("replan objective is invalid");
      return Object.freeze({ kind, objective: nonEmptyText(input.objective, "replan objective") });
    default:
      throw new TypeError("command payload kind is invalid");
  }
}

function encodePayload(payload: NodeCommandPayload): Uint8Array {
  return toBinary(NodeCommandPayloadSchema, encodePayloadMessage(payload));
}

function encodePayloadMessage(
  payload: NodeCommandPayload,
): MessageShape<typeof NodeCommandPayloadSchema> {
  switch (payload.kind) {
    case "message":
      return create(NodeCommandPayloadSchema, {
        command: { case: "message", value: create(TextNodeCommandSchema, { text: payload.text }) },
      });
    case "steer_after_current_tool":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "steerAfterCurrentTool",
          value: create(TextNodeCommandSchema, { text: payload.text }),
        },
      });
    case "interrupt_now":
      return create(NodeCommandPayloadSchema, {
        command: { case: "interruptNow", value: create(EmptyNodeCommandSchema) },
      });
    case "follow_up_after_turn":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "followUpAfterTurn",
          value: create(TextNodeCommandSchema, { text: payload.text }),
        },
      });
    case "pause":
      return create(NodeCommandPayloadSchema, {
        command: { case: "pause", value: create(EmptyNodeCommandSchema) },
      });
    case "resume":
      return create(NodeCommandPayloadSchema, {
        command: { case: "resume", value: create(EmptyNodeCommandSchema) },
      });
    case "answer":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "answer",
          value: create(AnswerNodeCommandSchema, {
            attentionId: payload.attentionId,
            answer: payload.answer,
          }),
        },
      });
    case "approve":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "approve",
          value: create(
            ResolveApprovalNodeCommandSchema,
            payload.reason === undefined
              ? { attentionId: payload.attentionId }
              : { attentionId: payload.attentionId, reason: payload.reason },
          ),
        },
      });
    case "reject":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "reject",
          value: create(
            ResolveApprovalNodeCommandSchema,
            payload.reason === undefined
              ? { attentionId: payload.attentionId }
              : { attentionId: payload.attentionId, reason: payload.reason },
          ),
        },
      });
    case "retry":
      return create(NodeCommandPayloadSchema, {
        command: { case: "retry", value: create(EmptyNodeCommandSchema) },
      });
    case "cancel_node":
      return create(NodeCommandPayloadSchema, {
        command: { case: "cancelNode", value: create(EmptyNodeCommandSchema) },
      });
    case "cancel_subtree":
      return create(NodeCommandPayloadSchema, {
        command: { case: "cancelSubtree", value: create(EmptyNodeCommandSchema) },
      });
    case "replan_unstarted_subtree":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "replanUnstartedSubtree",
          value: create(ReplanNodeCommandSchema, { objective: payload.objective }),
        },
      });
  }
}

function decodePayload(bytes: Uint8Array): NodeCommandPayload {
  try {
    const message = fromBinary(NodeCommandPayloadSchema, bytes);
    assertNoUnknownPayload(message);
    return decodeWirePayload(message);
  } catch (error) {
    throw new SqliteSteeringError("corrupt", "node command payload is corrupt", { cause: error });
  }
}

function decodeWirePayload(message: WireNodeCommandPayload): NodeCommandPayload {
  switch (message.command.case) {
    case "message":
      return Object.freeze({
        kind: "message",
        text: nonEmptyText(message.command.value.text, "command text"),
      });
    case "steerAfterCurrentTool":
      return Object.freeze({
        kind: "steer_after_current_tool",
        text: nonEmptyText(message.command.value.text, "command text"),
      });
    case "interruptNow":
      return Object.freeze({ kind: "interrupt_now" });
    case "followUpAfterTurn":
      return Object.freeze({
        kind: "follow_up_after_turn",
        text: nonEmptyText(message.command.value.text, "command text"),
      });
    case "pause":
      return Object.freeze({ kind: "pause" });
    case "resume":
      return Object.freeze({ kind: "resume" });
    case "answer":
      return Object.freeze({
        kind: "answer",
        attentionId: nodeAttentionId(message.command.value.attentionId),
        answer: nonEmptyText(message.command.value.answer, "answer"),
      });
    case "approve":
      return Object.freeze({
        kind: "approve",
        attentionId: nodeAttentionId(message.command.value.attentionId),
        ...(message.command.value.reason === undefined
          ? { reason: undefined }
          : { reason: nonEmptyText(message.command.value.reason, "approval reason") }),
      });
    case "reject":
      return Object.freeze({
        kind: "reject",
        attentionId: nodeAttentionId(message.command.value.attentionId),
        ...(message.command.value.reason === undefined
          ? { reason: undefined }
          : { reason: nonEmptyText(message.command.value.reason, "approval reason") }),
      });
    case "retry":
      return Object.freeze({ kind: "retry" });
    case "cancelNode":
      return Object.freeze({ kind: "cancel_node" });
    case "cancelSubtree":
      return Object.freeze({ kind: "cancel_subtree" });
    case "replanUnstartedSubtree":
      return Object.freeze({
        kind: "replan_unstarted_subtree",
        objective: nonEmptyText(message.command.value.objective, "replan objective"),
      });
    case undefined:
      throw new TypeError("node command payload oneof is missing");
  }
}

function decodeWireNodeCommand(message: NodeCommand): NodeCommandRecord {
  assertNoUnknownNodeCommand(message);
  const commandIdValue = parseCommandId(message.commandId, "command ID");
  const actorSessionIdValue = parseActorSessionId(message.actorSessionId, "actor session ID");
  const nodeIdValue = parseNodeId(message.nodeId, "node ID");
  if (message.ordinal < 1n) throw new TypeError("command ordinal is invalid");
  if (message.payload === undefined) throw new TypeError("node command payload is missing");
  const payload = decodeWirePayload(message.payload);
  const state = coreDeliveryState(parseDeliveryState(message.deliveryState));
  const recoveryDisposition = coreRecoveryDisposition(
    parseRecoveryDisposition(message.recoveryDisposition),
  );
  if (!Number.isSafeInteger(message.deliveryAttempts) || message.deliveryAttempts < 0)
    throw new TypeError("delivery attempts are invalid");
  const createdAt = timestampFromProto(message.createdAt, "created_at");
  const sentAt =
    message.sentAt === undefined ? undefined : timestampFromProto(message.sentAt, "sent_at");
  const acknowledgedAt =
    message.acknowledgedAt === undefined
      ? undefined
      : timestampFromProto(message.acknowledgedAt, "acknowledged_at");
  const appliedAt =
    message.appliedAt === undefined
      ? undefined
      : timestampFromProto(message.appliedAt, "applied_at");
  const failedAt =
    message.failedAt === undefined ? undefined : timestampFromProto(message.failedAt, "failed_at");
  const failure =
    message.failure === undefined ? undefined : nonEmptyText(message.failure, "failure");
  validateDeliveryShape(
    state,
    message.deliveryAttempts,
    undefined,
    createdAt,
    sentAt,
    acknowledgedAt,
    appliedAt,
    failedAt,
    failure,
  );
  return Object.freeze({
    commandId: commandIdValue,
    actorSessionId: actorSessionIdValue,
    nodeId: nodeIdValue,
    ordinal: message.ordinal,
    payload,
    state,
    recoveryDisposition,
    deliveryAttempts: message.deliveryAttempts,
    deliveryToken: undefined,
    createdAt,
    sentAt,
    acknowledgedAt,
    appliedAt,
    failedAt,
    failure,
  });
}

function coreDeliveryState(value: NodeCommandDeliveryState): CoreDeliveryState {
  switch (value) {
    case NodeCommandDeliveryState.QUEUED:
      return "queued";
    case NodeCommandDeliveryState.SENT:
      return "sent";
    case NodeCommandDeliveryState.ACKNOWLEDGED:
      return "acknowledged";
    case NodeCommandDeliveryState.APPLIED:
      return "applied";
    case NodeCommandDeliveryState.FAILED:
      return "failed";
    case NodeCommandDeliveryState.REVIEW_REQUIRED:
      return "review_required";
    case NodeCommandDeliveryState.UNSPECIFIED:
      throw new TypeError("delivery state is invalid");
  }
}

function coreRecoveryDisposition(value: NodeCommandRecoveryDisposition): CoreRecoveryDisposition {
  switch (value) {
    case NodeCommandRecoveryDisposition.RESUME_SESSION:
      return "resume_session";
    case NodeCommandRecoveryDisposition.FORK_SESSION:
      return "fork_session";
    case NodeCommandRecoveryDisposition.RETRY_EXTERNAL_ACTION:
      return "retry_external_action";
    case NodeCommandRecoveryDisposition.REQUIRES_REVIEW:
      return "requires_review";
    case NodeCommandRecoveryDisposition.UNSPECIFIED:
      throw new TypeError("recovery disposition is invalid");
  }
}

function assertNoUnknownPayload(message: MessageShape<typeof NodeCommandPayloadSchema>): void {
  if (findUnknownField(NodeCommandPayloadSchema, message) !== undefined) {
    throw new TypeError("node command payload contains unknown fields");
  }
}

function assertNoUnknownQueueResult(
  message: MessageShape<typeof QueueNodeCommandResponseSchema>,
): void {
  if (findUnknownField(QueueNodeCommandResponseSchema, message) !== undefined) {
    throw new TypeError("queue command result contains unknown fields");
  }
}

function assertNoUnknownNodeCommand(message: MessageShape<typeof NodeCommandSchema>): void {
  if (findUnknownField(NodeCommandSchema, message) !== undefined) {
    throw new TypeError("node command contains unknown fields");
  }
}
function wireAttentionKind(kind: "question" | "approval"): NodeAttentionKind {
  return kind === "question" ? NodeAttentionKind.QUESTION : NodeAttentionKind.APPROVAL;
}

function wireAttentionState(state: "open" | "resolved"): NodeAttentionState {
  return state === "open" ? NodeAttentionState.OPEN : NodeAttentionState.RESOLVED;
}

function nodeAttentionMessage(
  record: NodeAttentionRecord,
): MessageShape<typeof NodeAttentionSchema> {
  return create(NodeAttentionSchema, {
    id: record.id,
    nodeId: record.nodeId,
    kind: wireAttentionKind(record.kind),
    prompt: record.prompt,
    choices: [...record.choices],
    state: wireAttentionState(record.state),
    ...(record.resolutionCommandId === undefined
      ? {}
      : { resolutionCommandId: record.resolutionCommandId }),
    ...(record.resolution === undefined ? {} : { resolution: record.resolution }),
    createdAt: timestampMessage(record.createdAt),
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: timestampMessage(record.resolvedAt) }),
  });
}

function nodeAttentionProjection(
  record: NodeAttentionRecord,
): MessageShape<typeof ProjectionChangeSchema> {
  return create(ProjectionChangeSchema, {
    change: { case: "nodeAttentionUpserted", value: nodeAttentionMessage(record) },
  });
}

function assertNoUnknownAttention(message: MessageShape<typeof NodeAttentionSchema>): void {
  if (findUnknownField(NodeAttentionSchema, message) !== undefined) {
    throw new TypeError("node attention contains unknown fields");
  }
}

function decodeWireAttention(message: NodeAttention): NodeAttentionRecord {
  assertNoUnknownAttention(message);
  const id = parseAttentionId(message.id, "attention ID");
  const nodeId = parseNodeId(message.nodeId, "node ID");
  if (message.kind !== NodeAttentionKind.QUESTION && message.kind !== NodeAttentionKind.APPROVAL) {
    throw new TypeError("attention kind is invalid");
  }
  const kind = message.kind === NodeAttentionKind.QUESTION ? "question" : "approval";
  const prompt = nonEmptyText(message.prompt, "attention prompt");
  const choices = message.choices.map((choice) => nonEmptyText(choice, "attention choice"));
  if (message.state !== NodeAttentionState.OPEN && message.state !== NodeAttentionState.RESOLVED) {
    throw new TypeError("attention state is invalid");
  }
  const state = message.state === NodeAttentionState.OPEN ? "open" : "resolved";
  const resolutionCommandId =
    message.resolutionCommandId === undefined
      ? undefined
      : parseCommandId(message.resolutionCommandId, "resolution command ID");
  const resolution =
    message.resolution === undefined ? undefined : nonEmptyText(message.resolution, "resolution");
  const createdAt = timestampFromProto(message.createdAt, "created_at");
  const resolvedAt =
    message.resolvedAt === undefined
      ? undefined
      : timestampFromProto(message.resolvedAt, "resolved_at");
  if (state === "open") {
    if (resolutionCommandId !== undefined || resolution !== undefined || resolvedAt !== undefined) {
      throw new TypeError("open attention shape is invalid");
    }
  } else if (
    resolutionCommandId === undefined ||
    resolution === undefined ||
    resolvedAt === undefined
  ) {
    throw new TypeError("resolved attention shape is invalid");
  }
  return Object.freeze({
    id,
    nodeId,
    kind,
    prompt,
    choices: Object.freeze(choices),
    state,
    resolutionCommandId,
    resolution,
    createdAt,
    resolvedAt,
  });
}

function nodeCommandProjection(
  record: NodeCommandRecord,
): MessageShape<typeof ProjectionChangeSchema> {
  return create(ProjectionChangeSchema, {
    change: { case: "nodeCommandUpserted", value: nodeCommandMessage(record) },
  });
}
function nodeCommandAttentionProjection(
  record: NodeCommandRecord,
  attention: NodeAttentionRecord,
): MessageShape<typeof ProjectionChangeSchema> {
  return create(ProjectionChangeSchema, {
    change: {
      case: "batch",
      value: create(ProjectionBatchSchema, {
        changes: [nodeCommandProjection(record), nodeAttentionProjection(attention)],
      }),
    },
  });
}

function nodeCommandMessage(record: NodeCommandRecord): MessageShape<typeof NodeCommandSchema> {
  return create(NodeCommandSchema, {
    commandId: record.commandId,
    actorSessionId: record.actorSessionId,
    nodeId: record.nodeId,
    ordinal: record.ordinal,
    payload: encodePayloadMessage(record.payload),
    deliveryState: wireDeliveryState(record.state),
    recoveryDisposition: wireRecoveryDisposition(record.recoveryDisposition),
    deliveryAttempts: record.deliveryAttempts,
    createdAt: timestampMessage(record.createdAt),
    ...(record.sentAt === undefined ? {} : { sentAt: timestampMessage(record.sentAt) }),
    ...(record.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: timestampMessage(record.acknowledgedAt) }),
    ...(record.appliedAt === undefined ? {} : { appliedAt: timestampMessage(record.appliedAt) }),
    ...(record.failedAt === undefined ? {} : { failedAt: timestampMessage(record.failedAt) }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  });
}

function wireDeliveryState(state: CoreDeliveryState): NodeCommandDeliveryState {
  switch (state) {
    case "queued":
      return NodeCommandDeliveryState.QUEUED;
    case "sent":
      return NodeCommandDeliveryState.SENT;
    case "acknowledged":
      return NodeCommandDeliveryState.ACKNOWLEDGED;
    case "applied":
      return NodeCommandDeliveryState.APPLIED;
    case "failed":
      return NodeCommandDeliveryState.FAILED;
    case "review_required":
      return NodeCommandDeliveryState.REVIEW_REQUIRED;
  }
}

function wireRecoveryDisposition(
  disposition: CoreRecoveryDisposition,
): NodeCommandRecoveryDisposition {
  switch (disposition) {
    case "resume_session":
      return NodeCommandRecoveryDisposition.RESUME_SESSION;
    case "fork_session":
      return NodeCommandRecoveryDisposition.FORK_SESSION;
    case "retry_external_action":
      return NodeCommandRecoveryDisposition.RETRY_EXTERNAL_ACTION;
    case "requires_review":
      return NodeCommandRecoveryDisposition.REQUIRES_REVIEW;
  }
}

function timestampMessage(value: Timestamp): { seconds: bigint; nanos: number } {
  const milliseconds = BigInt(value);
  return { seconds: milliseconds / 1_000n, nanos: Number(milliseconds % 1_000n) * 1_000_000 };
}

function timestampFromProto(
  value: { seconds: bigint; nanos: number } | undefined,
  fieldName: string,
): Timestamp {
  if (
    value === undefined ||
    typeof value.seconds !== "bigint" ||
    !Number.isInteger(value.nanos) ||
    value.nanos < 0 ||
    value.nanos >= 1_000_000_000
  ) {
    throw new TypeError(`${fieldName} timestamp is invalid`);
  }
  const milliseconds = value.seconds * 1_000n + BigInt(Math.floor(value.nanos / 1_000_000));
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER))
    throw new TypeError(`${fieldName} timestamp is too large`);
  return timestampFromEpochMilliseconds(Number(milliseconds));
}

function decodeCommandRow(row: SqliteRow): NodeCommandRecord {
  try {
    const commandIdValue = parseCommandId(requiredText(row, "command_id"), "command ID");
    const actorSessionIdValue = parseActorSessionId(
      requiredText(row, "actor_session_id"),
      "actor session ID",
    );
    const nodeIdValue = parseNodeId(requiredText(row, "node_id"), "node ID");
    const ordinal = positiveBigint(row, "ordinal");
    const payloadValue = row["payload"];
    if (!(payloadValue instanceof Uint8Array) || payloadValue.byteLength === 0)
      throw new TypeError("payload is invalid");
    const payload = decodePayload(new Uint8Array(payloadValue));
    const commandKind = requiredText(row, "command_kind");
    if (commandKind !== payload.kind) throw new TypeError("command kind does not match payload");
    const safe = sqliteBoolean(row, "safe_to_redeliver");
    if (safe !== nodeCommandIsSafeToRedeliver(payload))
      throw new TypeError("safe delivery flag does not match payload");
    const state = parseDeliveryStateText(requiredText(row, "state_kind"));
    const recoveryDisposition = parseRecoveryText(requiredText(row, "recovery_disposition"));
    const attempts = safeNumber(row["delivery_attempts"], "delivery attempts");
    if (attempts > 0xffffffff) throw new TypeError("delivery attempts exceed uint32 range");
    const tokenValue = optionalText(row, "delivery_token");
    const deliveryToken =
      tokenValue === undefined ? undefined : parseDeliveryToken(tokenValue, "delivery token");
    const createdAt = timestampNumber(row["created_at_ms"], "created timestamp");
    const sentAt = optionalTimestamp(row, "sent_at_ms");
    const acknowledgedAt = optionalTimestamp(row, "acknowledged_at_ms");
    const appliedAt = optionalTimestamp(row, "applied_at_ms");
    const failedAt = optionalTimestamp(row, "failed_at_ms");
    const failure = optionalText(row, "failure");
    validateDeliveryShape(
      state,
      attempts,
      deliveryToken,
      createdAt,
      sentAt,
      acknowledgedAt,
      appliedAt,
      failedAt,
      failure,
    );
    return Object.freeze({
      commandId: commandIdValue,
      actorSessionId: actorSessionIdValue,
      nodeId: nodeIdValue,
      ordinal,
      payload,
      state,
      recoveryDisposition,
      deliveryAttempts: attempts,
      deliveryToken,
      createdAt,
      sentAt,
      acknowledgedAt,
      appliedAt,
      failedAt,
      failure,
    });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("corrupt", "node command row is malformed", { cause: error });
  }
}

function validateDeliveryShape(
  state: CoreDeliveryState,
  attempts: number,
  token: NodeCommandDeliveryToken | undefined,
  createdAt: Timestamp,
  sentAt: Timestamp | undefined,
  acknowledgedAt: Timestamp | undefined,
  appliedAt: Timestamp | undefined,
  failedAt: Timestamp | undefined,
  failure: string | undefined,
): void {
  if (sentAt !== undefined && sentAt < createdAt)
    throw new TypeError("sent timestamp precedes creation");
  if (acknowledgedAt !== undefined && (sentAt === undefined || acknowledgedAt < sentAt))
    throw new TypeError("acknowledged timestamp is invalid");
  if (appliedAt !== undefined && (acknowledgedAt === undefined || appliedAt < acknowledgedAt))
    throw new TypeError("applied timestamp is invalid");
  if (failedAt !== undefined && (sentAt === undefined || failedAt < sentAt))
    throw new TypeError("failed timestamp is invalid");
  if (state === "queued") {
    if (
      attempts !== 0 ||
      token !== undefined ||
      sentAt !== undefined ||
      acknowledgedAt !== undefined ||
      appliedAt !== undefined ||
      failedAt !== undefined ||
      failure !== undefined
    )
      throw new TypeError("queued delivery shape is invalid");
    return;
  }
  if (state === "sent") {
    if (
      attempts < 1 ||
      token === undefined ||
      sentAt === undefined ||
      acknowledgedAt !== undefined ||
      appliedAt !== undefined ||
      failedAt !== undefined ||
      failure !== undefined
    )
      throw new TypeError("sent delivery shape is invalid");
    return;
  }
  if (state === "acknowledged") {
    if (
      attempts < 1 ||
      token === undefined ||
      sentAt === undefined ||
      acknowledgedAt === undefined ||
      appliedAt !== undefined ||
      failedAt !== undefined ||
      failure !== undefined
    )
      throw new TypeError("acknowledged delivery shape is invalid");
    return;
  }
  if (state === "applied") {
    if (
      attempts < 1 ||
      token === undefined ||
      sentAt === undefined ||
      acknowledgedAt === undefined ||
      appliedAt === undefined ||
      failedAt !== undefined ||
      failure !== undefined
    )
      throw new TypeError("applied delivery shape is invalid");
    return;
  }
  if (
    attempts < 1 ||
    token === undefined ||
    sentAt === undefined ||
    appliedAt !== undefined ||
    failedAt === undefined ||
    failure === undefined
  )
    throw new TypeError("terminal delivery shape is invalid");
}

function decodeCommandRowById(reader: SqliteReader, commandIdValue: CommandId): NodeCommandRecord {
  const row = reader.get(
    `SELECT command_id, actor_session_id, node_id, ordinal, command_kind, payload,
            safe_to_redeliver, state_kind, recovery_disposition, delivery_attempts,
            delivery_token, created_at_ms, sent_at_ms, acknowledged_at_ms, applied_at_ms,
            failed_at_ms, failure
       FROM node_command_deliveries WHERE command_id = ?`,
    [commandIdValue],
  );
  if (row === undefined) throw new SqliteSteeringError("corrupt", "node command row disappeared");
  return decodeCommandRow(row);
}

function decodeAttentionRow(row: SqliteRow): NodeAttentionRecord {
  try {
    const id = parseAttentionId(requiredText(row, "id"), "attention ID");
    const nodeId = parseNodeId(requiredText(row, "node_id"), "node ID");
    const kindText = requiredText(row, "attention_kind");
    if (kindText !== "question" && kindText !== "approval")
      throw new TypeError("attention kind is invalid");
    const kind: "question" | "approval" = kindText === "question" ? "question" : "approval";
    const prompt = nonEmptyText(requiredText(row, "prompt"), "attention prompt");
    const choicesValue = row["choices_json"];
    if (typeof choicesValue !== "string") throw new TypeError("attention choices are invalid");
    const parsed: unknown = JSON.parse(choicesValue);
    if (!Array.isArray(parsed)) throw new TypeError("attention choices are invalid");
    const choices = parsed.map((choice) => {
      if (typeof choice !== "string") throw new TypeError("attention choice is invalid");
      return nonEmptyText(choice, "attention choice");
    });
    if (new Set(choices).size !== choices.length)
      throw new TypeError("attention choices are duplicated");
    const stateText = requiredText(row, "state_kind");
    if (stateText !== "open" && stateText !== "resolved")
      throw new TypeError("attention state is invalid");
    const state: "open" | "resolved" = stateText === "open" ? "open" : "resolved";
    const resolutionCommandIdValue = optionalText(row, "resolution_command_id");
    const resolution = optionalText(row, "resolution");
    const createdAt = timestampNumber(row["created_at_ms"], "attention creation timestamp");
    const resolvedAt = optionalTimestamp(row, "resolved_at_ms");
    const resolutionCommandId =
      resolutionCommandIdValue === undefined
        ? undefined
        : parseCommandId(resolutionCommandIdValue, "resolution command ID");
    if (state === "open") {
      if (resolutionCommandId !== undefined || resolution !== undefined || resolvedAt !== undefined)
        throw new TypeError("open attention shape is invalid");
    } else {
      if (resolutionCommandId === undefined || resolution === undefined || resolvedAt === undefined)
        throw new TypeError("resolved attention shape is invalid");
    }
    if (resolvedAt !== undefined && resolvedAt < createdAt)
      throw new TypeError("attention resolution timestamp is invalid");
    return Object.freeze({
      id,
      nodeId,
      kind,
      prompt,
      choices: Object.freeze(choices),
      state,
      resolutionCommandId,
      resolution,
      createdAt,
      resolvedAt,
    });
  } catch (error) {
    if (error instanceof SqliteSteeringError) throw error;
    throw new SqliteSteeringError("corrupt", "node attention row is malformed", { cause: error });
  }
}

function decodeAttentionRowById(reader: SqliteReader, id: NodeAttentionId): NodeAttentionRecord {
  const row = reader.get(
    `SELECT id, node_id, attention_kind, prompt, choices_json, state_kind,
            resolution_command_id, resolution, created_at_ms, resolved_at_ms
       FROM node_attention_records WHERE id = ?`,
    [id],
  );
  if (row === undefined) throw new SqliteSteeringError("corrupt", "attention row disappeared");
  return decodeAttentionRow(row);
}

function validateQueueAttention(
  transaction: SqliteCommandTransaction,
  nodeId: TaskNodeId,
  payload: NodeCommandPayload,
): void {
  let attentionIdValue: NodeAttentionId;
  let kind: "question" | "approval";
  switch (payload.kind) {
    case "answer":
      attentionIdValue = payload.attentionId;
      kind = "question";
      break;
    case "approve":
    case "reject":
      attentionIdValue = payload.attentionId;
      kind = "approval";
      break;
    case "message":
    case "steer_after_current_tool":
    case "interrupt_now":
    case "follow_up_after_turn":
    case "pause":
    case "resume":
    case "retry":
    case "cancel_node":
    case "cancel_subtree":
    case "replan_unstarted_subtree":
      return;
  }
  const row = transaction.get(
    `SELECT id, node_id, attention_kind, prompt, choices_json, state_kind,
            resolution_command_id, resolution, created_at_ms, resolved_at_ms
       FROM node_attention_records WHERE id = ?`,
    [attentionIdValue],
  );
  if (row === undefined) {
    throw new SqliteSteeringError("attention_not_found", "attention does not exist");
  }
  const attention = decodeAttentionRow(row);
  if (
    payload.kind === "answer" &&
    attention.choices.length > 0 &&
    !attention.choices.includes(payload.answer)
  ) {
    throw new SqliteSteeringError("invalid_command", "answer is not one of the attention choices");
  }
  if (attention.nodeId !== nodeId) {
    throw new SqliteSteeringError(
      "attention_not_found",
      "attention does not belong to the command node",
    );
  }
  if (attention.kind !== kind) {
    throw new SqliteSteeringError("invalid_command", "attention kind does not match command");
  }
  if (attention.state !== "open") {
    throw new SqliteSteeringError("attention_closed", "attention is already resolved");
  }
  const pendingRows = transaction.all(
    `SELECT payload
       FROM node_command_deliveries
      WHERE node_id = ? AND state_kind IN ('queued', 'sent', 'acknowledged', 'review_required')
        AND command_kind IN ('answer', 'approve', 'reject')`,
    [nodeId],
  );
  for (const pendingRow of pendingRows) {
    const payloadBytes = pendingRow["payload"];
    if (!(payloadBytes instanceof Uint8Array)) {
      throw new SqliteSteeringError("corrupt", "pending resolver payload is malformed");
    }
    const pendingPayload = decodePayload(payloadBytes);
    if (
      (pendingPayload.kind === "answer" ||
        pendingPayload.kind === "approve" ||
        pendingPayload.kind === "reject") &&
      pendingPayload.attentionId === attention.id
    ) {
      throw new SqliteSteeringError(
        "invalid_command",
        "attention already has an unresolved command",
      );
    }
  }
}

function resolveAttention(
  transaction: SqliteTransaction,
  row: NodeCommandRecord,
  at: Timestamp,
): NodeAttentionRecord | undefined {
  let attentionIdValue: NodeAttentionId;
  let kind: "question" | "approval";
  let resolution: string;
  switch (row.payload.kind) {
    case "answer":
      attentionIdValue = row.payload.attentionId;
      kind = "question";
      resolution = row.payload.answer;
      break;
    case "approve":
      attentionIdValue = row.payload.attentionId;
      kind = "approval";
      resolution = row.payload.reason ?? "approved";
      break;
    case "reject":
      attentionIdValue = row.payload.attentionId;
      kind = "approval";
      resolution = row.payload.reason ?? "rejected";
      break;
    case "message":
    case "steer_after_current_tool":
    case "interrupt_now":
    case "follow_up_after_turn":
    case "pause":
    case "resume":
    case "retry":
    case "cancel_node":
    case "cancel_subtree":
    case "replan_unstarted_subtree":
      return undefined;
  }
  const attention = transaction.get(
    `SELECT id, node_id, attention_kind, prompt, choices_json, state_kind,
            resolution_command_id, resolution, created_at_ms, resolved_at_ms
       FROM node_attention_records WHERE id = ?`,
    [attentionIdValue],
  );
  if (attention === undefined)
    throw new SqliteSteeringError("attention_not_found", "attention does not exist");
  const decoded = decodeAttentionRow(attention);
  if (decoded.nodeId !== row.nodeId || decoded.kind !== kind) {
    throw new SqliteSteeringError(
      "attention_not_found",
      "attention does not belong to the command node",
    );
  }
  if (decoded.state !== "open")
    throw new SqliteSteeringError("attention_closed", "attention is already resolved");
  const updated = transaction.run(
    `UPDATE node_attention_records
        SET state_kind = 'resolved', resolution_command_id = ?, resolution = ?, resolved_at_ms = ?
      WHERE id = ? AND node_id = ? AND attention_kind = ? AND state_kind = 'open'`,
    [row.commandId, resolution, at, attentionIdValue, row.nodeId, kind],
  );
  if (writeChanges(updated.changes) !== 1n)
    throw new SqliteSteeringError("corrupt", "attention was not resolved exactly once");
  return decodeAttentionRowById(transaction, attentionIdValue);
}

function updateDelivery(
  transaction: SqliteTransaction,
  row: NodeCommandRecord,
  state: CoreDeliveryState,
  at: Timestamp,
  token: NodeCommandDeliveryToken | undefined,
  attempts: number,
  failure: string | undefined,
  disposition: CoreRecoveryDisposition,
  ports: DomainPorts,
  attention?: NodeAttentionRecord,
): void {
  const oldNode = requireNode(transaction, row.nodeId);
  const oldVersion = safeNumber(oldNode["version"], "node version");
  if (at < timestampNumber(oldNode["updated_at_ms"], "node update timestamp")) {
    throw new SqliteSteeringError("invalid_command", "delivery timestamp predates node update");
  }
  const result = transaction.run(
    `UPDATE node_command_deliveries
        SET state_kind = ?, recovery_disposition = ?, delivery_attempts = ?, delivery_token = ?,
            sent_at_ms = ?, acknowledged_at_ms = ?, applied_at_ms = ?, failed_at_ms = ?, failure = ?
      WHERE command_id = ? AND state_kind = ?`,
    [
      state,
      disposition,
      attempts,
      token ?? null,
      state === "sent" ? at : (row.sentAt ?? null),
      state === "acknowledged" || state === "applied"
        ? (row.acknowledgedAt ?? at)
        : (row.acknowledgedAt ?? null),
      state === "applied" ? at : (row.appliedAt ?? null),
      state === "failed" || state === "review_required" ? at : (row.failedAt ?? null),
      state === "failed" || state === "review_required" ? (failure ?? null) : null,
      row.commandId,
      row.state,
    ],
  );
  if (writeChanges(result.changes) !== 1n)
    throw new SqliteSteeringError("invalid_transition", "delivery transition was not applied");
  advanceNodeVersion(transaction, row.nodeId, at, oldVersion);
  const next = decodeCommandRowById(transaction, row.commandId);
  appendNodeCommandEvent(transaction, next, at, ports, attention);
}

function appendNodeCommandEvent(
  transaction: SqliteTransaction,
  record: NodeCommandRecord,
  at: Timestamp,
  ports: DomainPorts,
  attention?: NodeAttentionRecord,
): void {
  const node = requireNode(transaction, record.nodeId);
  // P1 (review #12) — corrected: the generic command-store.ts execute() path
  // (readResultingAggregateVersion + `resultingVersion + 1`) is the
  // authoritative, system-wide convention for every aggregate kind: an
  // event's aggregate_version is the aggregate's version AFTER advancing
  // (already reflected in the row read here) PLUS one more, because the
  // aggregate's own `version` column and the per-aggregate `events`
  // sequence are deliberately offset by one throughout this framework (see
  // readResultingAggregateVersion in command-store.ts, used identically by
  // every other command kind - plan-revisions, artifacts, etc.). Matching
  // that convention here (rather than diverging from it) is what avoids
  // colliding with the next queued command's own advanceNodeVersion+event
  // pair - an earlier version of this fix instead DROPPED the +1, which
  // broke this invariant and reintroduced the exact UNIQUE constraint
  // collision it was meant to fix.
  const nodeVersion = safeNumber(node["version"], "node version") + 1;
  const event =
    attention === undefined
      ? nodeCommandProjection(record)
      : nodeCommandAttentionProjection(record, attention);
  let eventIdValue: string;
  try {
    eventIdValue = eventId(ports.ids.nextId());
  } catch (error) {
    throw new SqliteSteeringError("corrupt", "event ID generation failed", { cause: error });
  }
  transaction.run(
    `INSERT INTO events (
       event_id, command_id, aggregate_kind, aggregate_id, aggregate_version,
       event_type, event_payload, occurred_at_ms
     ) VALUES (?, ?, 'node', ?, ?, ?, ?, ?)`,
    [
      eventIdValue,
      record.commandId,
      record.nodeId,
      nodeVersion,
      ProjectionChangeSchema.typeName,
      toBinary(ProjectionChangeSchema, event),
      at,
    ],
  );
}

function advanceNodeVersion(
  transaction: SqliteCommandTransaction,
  nodeId: TaskNodeId,
  at: Timestamp,
  expectedVersion: number,
): void {
  const result = transaction.run(
    `UPDATE nodes SET version = version + 1, updated_at_ms = ? WHERE id = ? AND version = ?`,
    [at, nodeId, expectedVersion],
  );
  if (writeChanges(result.changes) !== 1n)
    throw new SqliteSteeringError(
      "invalid_transition",
      "node version did not advance exactly once",
    );
}

function requireNode(reader: SqliteReader, nodeId: TaskNodeId): SqliteRow {
  const row = reader.get(
    "SELECT id, version, updated_at_ms, state_kind, resume_state_kind FROM nodes WHERE id = ?",
    [nodeId],
  );
  if (row === undefined) throw new SqliteSteeringError("not_found", "node was not found");
  requiredText(row, "id");
  return row;
}

function recoveryDisposition(
  stateValue: unknown,
  resumeStateValue: unknown,
): CoreRecoveryDisposition {
  const state = requiredStateText(stateValue, "node state");
  if (state === "active" || (state === "blocked" && resumeStateValue === "active"))
    return "resume_session";
  if (state === "failed" || state === "cancelled" || state === "succeeded") return "fork_session";
  return "requires_review";
}

function requireState(row: NodeCommandRecord, ...allowed: CoreDeliveryState[]): void {
  if (!allowed.includes(row.state))
    throw new SqliteSteeringError("invalid_transition", "delivery state transition is invalid");
}

function requireAtAfter(at: Timestamp, previous: Timestamp | undefined, fieldName: string): void {
  if (previous !== undefined && at < previous)
    throw new SqliteSteeringError(
      "invalid_command",
      `${fieldName} predates the previous delivery timestamp`,
    );
}

function incrementAttempts(value: number): number {
  if (value >= 0xffffffff) throw new SqliteSteeringError("corrupt", "delivery attempts overflow");
  return value + 1;
}

function parseCommandId(value: unknown, fieldName: string): CommandId {
  if (typeof value !== "string")
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`);
  try {
    return commandId(value);
  } catch (error) {
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`, { cause: error });
  }
}

function parseActorSessionId(value: unknown, fieldName: string) {
  if (typeof value !== "string")
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`);
  try {
    return actorSessionId(value);
  } catch (error) {
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`, { cause: error });
  }
}

function parseNodeId(value: unknown, fieldName: string): TaskNodeId {
  if (typeof value !== "string")
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`);
  try {
    return taskNodeId(value);
  } catch (error) {
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`, { cause: error });
  }
}

function parseAttentionId(value: unknown, fieldName: string): NodeAttentionId {
  if (typeof value !== "string")
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`);
  try {
    return nodeAttentionId(value);
  } catch (error) {
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`, { cause: error });
  }
}

function parseDeliveryToken(value: unknown, fieldName: string): NodeCommandDeliveryToken {
  if (typeof value !== "string")
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`);
  try {
    return nodeCommandDeliveryToken(value);
  } catch (error) {
    throw new SqliteSteeringError("invalid_command", `${fieldName} is invalid`, { cause: error });
  }
}

function requiredText(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${key} is invalid`);
  return value;
}

function optionalText(row: SqliteRow, key: string): string | undefined {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${key} is invalid`);
  return value;
}

function sqliteBoolean(row: SqliteRow, key: string): boolean {
  const value = row[key];
  if (value === 0n) return false;
  if (value === 1n) return true;
  throw new TypeError(`${key} is not boolean`);
}

function safeNumber(value: unknown, fieldName: string): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError(`${fieldName} is outside safe range`);
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${fieldName} is invalid`);
  return value;
}

function positiveBigint(row: SqliteRow, key: string): bigint {
  const value = row[key];
  if (typeof value !== "bigint" || value < 1n) throw new TypeError(`${key} is invalid`);
  return value;
}

function timestampNumber(value: unknown, fieldName: string): Timestamp {
  return timestampFromEpochMilliseconds(safeNumber(value, fieldName));
}

function optionalTimestamp(row: SqliteRow, key: string): Timestamp | undefined {
  if (row[key] === null) return undefined;
  return timestampNumber(row[key], key);
}

function parseDeliveryState(value: unknown): NodeCommandDeliveryState {
  if (
    value === NodeCommandDeliveryState.QUEUED ||
    value === NodeCommandDeliveryState.SENT ||
    value === NodeCommandDeliveryState.ACKNOWLEDGED ||
    value === NodeCommandDeliveryState.APPLIED ||
    value === NodeCommandDeliveryState.FAILED ||
    value === NodeCommandDeliveryState.REVIEW_REQUIRED
  )
    return value;
  throw new TypeError("delivery state is invalid");
}

function parseDeliveryStateText(value: string): CoreDeliveryState {
  if (
    value === "queued" ||
    value === "sent" ||
    value === "acknowledged" ||
    value === "applied" ||
    value === "failed" ||
    value === "review_required"
  )
    return value;
  throw new TypeError("delivery state is invalid");
}

function parseRecoveryDisposition(value: unknown): NodeCommandRecoveryDisposition {
  if (
    value === NodeCommandRecoveryDisposition.RESUME_SESSION ||
    value === NodeCommandRecoveryDisposition.FORK_SESSION ||
    value === NodeCommandRecoveryDisposition.RETRY_EXTERNAL_ACTION ||
    value === NodeCommandRecoveryDisposition.REQUIRES_REVIEW
  )
    return value;
  throw new TypeError("recovery disposition is invalid");
}

function parseRecoveryText(value: string): CoreRecoveryDisposition {
  if (
    value === "resume_session" ||
    value === "fork_session" ||
    value === "retry_external_action" ||
    value === "requires_review"
  )
    return value;
  throw new TypeError("recovery disposition is invalid");
}

function requiredStateText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new SqliteSteeringError("corrupt", `${fieldName} is invalid`);
  return value;
}

function writeChanges(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function normalizeSteeringCommandError(error: unknown, message: string): SqliteSteeringError {
  const visited = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof SqliteSteeringError) return current;
    if (current instanceof DomainError) {
      return new SqliteSteeringError("invalid_command", current.message, { cause: current });
    }
    if (current instanceof SqliteCommandError) {
      if (current.code === "invalid_command" || current.code === "command_id_conflict") {
        return new SqliteSteeringError("invalid_command", current.message, { cause: current });
      }
      if (current.code === "aggregate_version_conflict") {
        return new SqliteSteeringError(
          "invalid_transition",
          "expected node version does not match",
          {
            cause: current,
          },
        );
      }
    }
    visited.add(current);
    current = current.cause;
  }
  return new SqliteSteeringError("corrupt", message, { cause: error });
}

function normalizeQueueError(error: unknown): SqliteSteeringError {
  return normalizeSteeringCommandError(error, "queue command transaction failed");
}
