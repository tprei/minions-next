import {
  contentHash,
  gitSha,
  GateReceiptStoreError,
  taskNodeId,
  timestampFromEpochMilliseconds,
  type GateOutcome,
  type GateReceipt,
  type GateReceiptRecord,
  type GateReceiptStore,
  type TaskNodeId,
} from "@minions/core";

import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteRow,
} from "./database.js";

export type CreateSqliteGateReceiptStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

/**
 * SQLite {@link GateReceiptStore}: append-only, immutable, durable evidence
 * receipts for gate runs (QA-06). Each write is a single atomic insert; rows
 * are queryable by node and by node + gate name, ranged by sequence.
 */
export function createSqliteGateReceiptStore(
  options: CreateSqliteGateReceiptStoreOptions,
): GateReceiptStore {
  return new DefaultSqliteGateReceiptStore(options.database);
}

const OUTCOMES: Readonly<Record<string, GateOutcome>> = Object.freeze({
  passed: "passed",
  failed: "failed",
  timeout: "timeout",
  cancelled: "cancelled",
  missing_executable: "missing_executable",
  error: "error",
});

class DefaultSqliteGateReceiptStore implements GateReceiptStore {
  readonly #database: ManagedSqliteDatabase;

  constructor(database: ManagedSqliteDatabase) {
    this.#database = database;
  }

  record(record: GateReceiptRecord): Promise<void> {
    validateRecord(record);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      transaction.run(
        `INSERT INTO gate_receipts (
           node_id, attempt_id, gate_name, category, outcome, exit_code,
           duration_ms, stdout_digest, stderr_digest, head_commit,
           profile_hash, environment_digest, captured_at_ms, sequence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.nodeId,
          record.attemptId ?? null,
          record.receipt.gateName,
          record.receipt.category,
          record.receipt.outcome,
          record.receipt.exitCode,
          record.receipt.durationMs,
          record.receipt.stdoutDigest,
          record.receipt.stderrDigest,
          record.receipt.headCommit,
          record.receipt.profileHash,
          record.receipt.environmentDigest,
          record.receipt.capturedAt,
          record.receipt.sequence,
        ],
      );
    }).catch((error: unknown) => {
      if (error instanceof GateReceiptStoreError) throw error;
      throw new GateReceiptStoreError(
        "write_failed",
        `gate receipt record failed: ${errorMessage(error)}`,
      );
    });
  }

  listForNode(nodeIdValue: TaskNodeId): Promise<readonly GateReceipt[]> {
    return Promise.resolve(
      this.#database.read((reader) =>
        reader
          .all(
            `SELECT gate_name, category, outcome, exit_code, duration_ms,
                    stdout_digest, stderr_digest, head_commit, profile_hash,
                    environment_digest, captured_at_ms, sequence
               FROM gate_receipts
              WHERE node_id = ?
              ORDER BY sequence ASC, id ASC`,
            [nodeIdValue],
          )
          .map((row) => readReceipt(row)),
      ),
    );
  }

  listForGate(nodeIdValue: TaskNodeId, gateName: string): Promise<readonly GateReceipt[]> {
    if (gateName.length === 0) {
      return Promise.reject(
        new GateReceiptStoreError("invalid_input", "gate name must not be empty"),
      );
    }
    return Promise.resolve(
      this.#database.read((reader) =>
        reader
          .all(
            `SELECT gate_name, category, outcome, exit_code, duration_ms,
                    stdout_digest, stderr_digest, head_commit, profile_hash,
                    environment_digest, captured_at_ms, sequence
               FROM gate_receipts
              WHERE node_id = ? AND gate_name = ?
              ORDER BY sequence ASC, id ASC`,
            [nodeIdValue, gateName],
          )
          .map((row) => readReceipt(row)),
      ),
    );
  }
}

function validateRecord(record: GateReceiptRecord): void {
  taskNodeId(record.nodeId);
  if (record.receipt.gateName.length === 0) {
    throw new GateReceiptStoreError("invalid_input", "gate name is required");
  }
  if (OUTCOMES[record.receipt.outcome] === undefined) {
    throw new GateReceiptStoreError(
      "invalid_input",
      `unknown gate outcome: ${record.receipt.outcome}`,
    );
  }
  if (!Number.isSafeInteger(record.receipt.durationMs) || record.receipt.durationMs < 0) {
    throw new GateReceiptStoreError(
      "invalid_input",
      "gate receipt durationMs must be a non-negative safe integer",
    );
  }
  if (
    record.receipt.exitCode !== null &&
    (!Number.isSafeInteger(record.receipt.exitCode) || record.receipt.exitCode < 0)
  ) {
    throw new GateReceiptStoreError(
      "invalid_input",
      "gate receipt exitCode must be null or a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(record.receipt.sequence) || record.receipt.sequence < 0) {
    throw new GateReceiptStoreError(
      "invalid_input",
      "gate receipt sequence must be a non-negative safe integer",
    );
  }
  if (record.receipt.category < 0) {
    throw new GateReceiptStoreError("invalid_input", "gate category must be non-negative");
  }
}

function readReceipt(row: SqliteRow): GateReceipt {
  const outcomeValue = requiredString(row, "outcome");
  const outcome = OUTCOMES[outcomeValue];
  if (outcome === undefined) {
    throw new GateReceiptStoreError("corrupt", `unknown gate outcome: ${outcomeValue}`);
  }
  const exitCodeRaw = row["exit_code"];
  const exitCode =
    exitCodeRaw === null || exitCodeRaw === undefined ? null : toSafeNumber(row, "exit_code");
  return Object.freeze({
    gateName: requiredString(row, "gate_name"),
    category: toSafeNumber(row, "category"),
    outcome,
    exitCode,
    durationMs: toSafeNumber(row, "duration_ms"),
    stdoutDigest: contentHash(requiredString(row, "stdout_digest")),
    stderrDigest: contentHash(requiredString(row, "stderr_digest")),
    headCommit: gitSha(requiredString(row, "head_commit")),
    profileHash: contentHash(requiredString(row, "profile_hash")),
    environmentDigest: contentHash(requiredString(row, "environment_digest")),
    capturedAt: timestampFromEpochMilliseconds(toSafeNumber(row, "captured_at_ms")),
    sequence: toSafeNumber(row, "sequence"),
  });
}

function toSafeNumber(row: SqliteRow, key: string): number {
  const value = row[key];
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) {
    throw new GateReceiptStoreError("corrupt", `gate receipt ${key} is not an integer`);
  }
  return numeric;
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new GateReceiptStoreError("corrupt", `gate receipt ${key} is missing`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
