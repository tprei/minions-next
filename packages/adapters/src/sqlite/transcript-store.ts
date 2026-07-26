import {
  attemptId,
  timestampFromEpochMilliseconds,
  type AttemptId,
  type HarnessEventPayload,
  type TranscriptChunk,
  type TranscriptStore,
} from "@minions/core";

import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteRow,
} from "./database.js";

export type SqliteTranscriptErrorCode = "invalid_input" | "corrupt" | "write_failed";

export class SqliteTranscriptError extends Error {
  readonly code: SqliteTranscriptErrorCode;

  constructor(code: SqliteTranscriptErrorCode, message: string) {
    super(message);
    this.name = "SqliteTranscriptError";
    this.code = code;
  }
}

export type CreateSqliteTranscriptStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

/**
 * SQLite {@link TranscriptStore}: append-only transcript chunks per attempt,
 * ordered by the harness stable sequence (HAR-05). Writes are crash-safe
 * (single managed transaction); appends are idempotent for an already-stored
 * identical sequence and fail-closed on a payload conflict at the same sequence.
 */
export function createSqliteTranscriptStore(
  options: CreateSqliteTranscriptStoreOptions,
): TranscriptStore {
  return new DefaultSqliteTranscriptStore(options.database);
}

class DefaultSqliteTranscriptStore implements TranscriptStore {
  readonly #database: ManagedSqliteDatabase;

  constructor(database: ManagedSqliteDatabase) {
    this.#database = database;
  }

  append(chunk: TranscriptChunk): Promise<void> {
    return this.appendAll([chunk]);
  }

  appendAll(chunks: readonly TranscriptChunk[]): Promise<void> {
    if (chunks.length === 0) return Promise.resolve();
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      for (const chunk of chunks) {
        const serialized = serializePayload(chunk.payload);
        const existing = transaction.get(
          `SELECT payload_kind, payload_json
             FROM attempt_transcript_chunks
            WHERE attempt_id = ? AND sequence = ?`,
          [chunk.attemptId, chunk.sequence],
        );
        if (existing !== undefined) {
          if (
            requiredString(existing, "payload_kind") !== serialized.kind ||
            requiredString(existing, "payload_json") !== serialized.json
          ) {
            throw new SqliteTranscriptError(
              "corrupt",
              `transcript chunk ${chunk.attemptId}:${chunk.sequence.toString()} payload is not stable`,
            );
          }
          continue;
        }
        transaction.run(
          `INSERT INTO attempt_transcript_chunks (
             attempt_id, sequence, occurred_at_ms, payload_kind, payload_json, recorded_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            chunk.attemptId,
            chunk.sequence,
            chunk.occurredAt,
            serialized.kind,
            serialized.json,
            chunk.occurredAt,
          ],
        );
      }
    }).catch((error: unknown) => {
      if (error instanceof SqliteTranscriptError) throw error;
      throw new SqliteTranscriptError(
        "write_failed",
        `transcript append failed: ${errorMessage(error)}`,
      );
    });
  }

  readAfter(attemptIdValue: AttemptId, afterSequence: bigint): Promise<readonly TranscriptChunk[]> {
    return Promise.resolve(
      this.#database.read((reader) =>
        reader
          .all(
            `SELECT attempt_id, sequence, occurred_at_ms, payload_kind, payload_json
               FROM attempt_transcript_chunks
              WHERE attempt_id = ? AND sequence > ?
              ORDER BY sequence`,
            [attemptIdValue, afterSequence],
          )
          .map((row) => readChunk(row)),
      ),
    );
  }

  readAll(attemptIdValue: AttemptId): Promise<readonly TranscriptChunk[]> {
    return Promise.resolve(
      this.#database.read((reader) =>
        reader
          .all(
            `SELECT attempt_id, sequence, occurred_at_ms, payload_kind, payload_json
               FROM attempt_transcript_chunks
              WHERE attempt_id = ?
              ORDER BY sequence`,
            [attemptIdValue],
          )
          .map((row) => readChunk(row)),
      ),
    );
  }

  latestSequence(attemptIdValue: AttemptId): Promise<bigint> {
    return Promise.resolve(
      this.#database.read((reader) => {
        const row = reader.get(
          `SELECT MAX(sequence) AS sequence FROM attempt_transcript_chunks WHERE attempt_id = ?`,
          [attemptIdValue],
        );
        const value = row?.["sequence"];
        if (value === undefined || value === null) return 0n;
        return toBigInt(value);
      }),
    );
  }
}

type SerializedPayload = Readonly<{ kind: string; json: string }>;

const payloadKinds: Record<string, true> = {
  message: true,
  thinking: true,
  tool_call: true,
  tool_result: true,
  prompt_started: true,
  prompt_finished: true,
  turn_started: true,
  turn_finished: true,
  usage: true,
  retry: true,
  question: true,
  error: true,
  result: true,
};

function serializePayload(payload: HarnessEventPayload): SerializedPayload {
  if (payloadKinds[payload.kind] !== true) {
    throw new SqliteTranscriptError("invalid_input", `unknown payload kind ${payload.kind}`);
  }
  return Object.freeze({ kind: payload.kind, json: JSON.stringify(payload) });
}

function readChunk(row: SqliteRow): TranscriptChunk {
  const kind = requiredString(row, "payload_kind");
  const json = requiredString(row, "payload_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SqliteTranscriptError(
      "corrupt",
      `transcript payload is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const payload = parsePayload(parsed, kind);
  return Object.freeze({
    attemptId: attemptId(requiredString(row, "attempt_id")),
    sequence: toBigInt(row["sequence"]),
    occurredAt: timestampFromEpochMilliseconds(toSafeNumber(row, "occurred_at_ms")),
    payload,
  });
}

function parsePayload(value: unknown, expectedKind: string): HarnessEventPayload {
  if (typeof value !== "object" || value === null) {
    throw new SqliteTranscriptError("corrupt", "transcript payload is not an object");
  }
  const record = value as { kind?: unknown };
  if (record.kind !== expectedKind) {
    throw new SqliteTranscriptError(
      "corrupt",
      `transcript payload kind ${String(record.kind)} does not match stored ${expectedKind}`,
    );
  }
  return value as HarnessEventPayload;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new SqliteTranscriptError("corrupt", "transcript integer is invalid");
}

function toSafeNumber(row: SqliteRow, key: string): number {
  const value = toBigInt(row[key]);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new SqliteTranscriptError("corrupt", `transcript ${key} exceeds safe range`);
  }
  return result;
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SqliteTranscriptError("corrupt", `transcript ${key} is missing`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
