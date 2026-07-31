import {
  attemptId,
  contentHash,
  sandboxBackendKinds,
  taskNodeId,
  timestampFromEpochMilliseconds,
  type AttemptCheckpoint,
  type AttemptCheckpointIdentity,
  type AttemptId,
  type CheckpointStore,
  type NodeExecutionPhase,
  type SandboxBackendKind,
} from "@minions/core";

import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteRow,
} from "./database.js";

export type SqliteCheckpointErrorCode = "invalid_input" | "corrupt" | "write_failed";

export class SqliteCheckpointError extends Error {
  readonly code: SqliteCheckpointErrorCode;

  constructor(code: SqliteCheckpointErrorCode, message: string) {
    super(message);
    this.name = "SqliteCheckpointError";
    this.code = code;
  }
}

export type CreateSqliteCheckpointStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

/**
 * SQLite {@link CheckpointStore}: the latest {@link AttemptCheckpoint} per attempt.
 * Writes are an idempotent UPSERT in a single crash-safe transaction. Identity
 * immutability (HAR-01) + sequence monotonicity are enforced by DB triggers, so
 * a stale or conflicting writer fails closed instead of silently overwriting.
 */
export function createSqliteCheckpointStore(
  options: CreateSqliteCheckpointStoreOptions,
): CheckpointStore {
  return new DefaultSqliteCheckpointStore(options.database);
}

const PHASES: readonly NodeExecutionPhase[] = [
  "claimed",
  "sandbox_created",
  "workspace_prepared",
  "harness_started",
  "context_sent",
  "streaming",
  "finalizing",
];

const sandboxStates: Record<string, true> = {
  created: true,
  running: true,
  stopped: true,
};

class DefaultSqliteCheckpointStore implements CheckpointStore {
  readonly #database: ManagedSqliteDatabase;

  constructor(database: ManagedSqliteDatabase) {
    this.#database = database;
  }

  record(checkpoint: AttemptCheckpoint): Promise<void> {
    validateCheckpoint(checkpoint);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      transaction.run(
        `INSERT INTO attempt_checkpoints (
           attempt_id, node_id, sequence, phase, harness_id, session_id,
           sandbox_instance_id, sandbox_backend_kind, sandbox_policy_digest,
           sandbox_state, context_digest, recorded_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET
           node_id = excluded.node_id,
           sequence = excluded.sequence,
           phase = excluded.phase,
           recorded_at_ms = excluded.recorded_at_ms`,
        [
          checkpoint.attemptId,
          checkpoint.nodeId,
          checkpoint.sequence,
          checkpoint.phase,
          checkpoint.identity.harnessIdentity.durableHarnessId,
          checkpoint.identity.harnessIdentity.sessionId,
          checkpoint.identity.sandboxInstanceId,
          checkpoint.identity.sandboxBackendKind,
          checkpoint.identity.sandboxPolicyDigest,
          checkpoint.identity.sandboxState,
          checkpoint.contextDigest,
          checkpoint.recordedAt,
        ],
      );
    }).catch((error: unknown) => {
      if (error instanceof SqliteCheckpointError) throw error;
      throw new SqliteCheckpointError(
        "write_failed",
        `checkpoint record failed: ${errorMessage(error)}`,
      );
    });
  }

  latest(attemptIdValue: AttemptId): Promise<AttemptCheckpoint | undefined> {
    return Promise.resolve(
      this.#database.read((reader) => {
        const row = reader.get(
          `SELECT attempt_id, node_id, sequence, phase, harness_id, session_id,
                  sandbox_instance_id, sandbox_backend_kind, sandbox_policy_digest,
                  sandbox_state, context_digest, recorded_at_ms
             FROM attempt_checkpoints
            WHERE attempt_id = ?`,
          [attemptIdValue],
        );
        if (row === undefined) return undefined;
        return readCheckpoint(row);
      }),
    );
  }
}

function validateCheckpoint(checkpoint: AttemptCheckpoint): void {
  if (!PHASES.includes(checkpoint.phase)) {
    throw new SqliteCheckpointError(
      "invalid_input",
      `unknown checkpoint phase ${checkpoint.phase}`,
    );
  }
  if (sandboxStates[checkpoint.identity.sandboxState] !== true) {
    throw new SqliteCheckpointError(
      "invalid_input",
      `unknown sandbox state ${checkpoint.identity.sandboxState}`,
    );
  }
  if (checkpoint.identity.harnessIdentity.durableHarnessId.length === 0) {
    throw new SqliteCheckpointError("invalid_input", "checkpoint harness id is required");
  }
  if (checkpoint.identity.harnessIdentity.sessionId.length === 0) {
    throw new SqliteCheckpointError("invalid_input", "checkpoint session id is required");
  }
  if (checkpoint.identity.sandboxInstanceId.length === 0) {
    throw new SqliteCheckpointError("invalid_input", "checkpoint sandbox instance id is required");
  }
}

function readCheckpoint(row: SqliteRow): AttemptCheckpoint {
  const backendKind = requiredString(row, "sandbox_backend_kind");
  if (!(sandboxBackendKinds as readonly string[]).includes(backendKind)) {
    throw new SqliteCheckpointError(
      "corrupt",
      `checkpoint sandbox backend kind ${backendKind} is unknown`,
    );
  }
  const identity: AttemptCheckpointIdentity = Object.freeze({
    harnessIdentity: Object.freeze({
      durableHarnessId: requiredString(row, "harness_id"),
      sessionId: requiredString(row, "session_id"),
    }),
    sandboxInstanceId: requiredString(row, "sandbox_instance_id"),
    sandboxBackendKind: backendKind as SandboxBackendKind,
    sandboxPolicyDigest: contentHash(requiredString(row, "sandbox_policy_digest")),
    sandboxState: requiredString(row, "sandbox_state") as AttemptCheckpointIdentity["sandboxState"],
  });
  return Object.freeze({
    attemptId: attemptId(requiredString(row, "attempt_id")),
    nodeId: taskNodeId(requiredString(row, "node_id")),
    sequence: toBigInt(row["sequence"]),
    phase: requiredString(row, "phase") as NodeExecutionPhase,
    identity,
    contextDigest: contentHash(requiredString(row, "context_digest")),
    recordedAt: timestampFromEpochMilliseconds(toSafeNumber(row, "recorded_at_ms")),
  });
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new SqliteCheckpointError("corrupt", "checkpoint integer is invalid");
}

function toSafeNumber(row: SqliteRow, key: string): number {
  const value = toBigInt(row[key]);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new SqliteCheckpointError("corrupt", `checkpoint ${key} exceeds safe range`);
  }
  return result;
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SqliteCheckpointError("corrupt", `checkpoint ${key} is missing`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
