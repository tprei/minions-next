import {
  RecoveryStoreError,
  type ElevationGrant,
  type ElevationGrantState,
  type RecordedRecoveryAction,
  type RecoveryActionKind,
  type RecoveryActionState,
  type RecoveryStore,
} from "@minions/core";

import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteRow,
  type SqliteValue,
} from "./database.js";

export type CreateSqliteRecoveryStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

/**
 * SQLite {@link RecoveryStore}: durable elevation grants and the recovery
 * actions executed under them (PR 56 — maintenance-elevation-recovery). Every
 * write is a single atomic statement; the schema's own triggers (migration
 * `0014_recovery_elevation.sql`) enforce identity immutability, legal state
 * transitions, and durability (no delete) as a defense-in-depth backstop
 * beneath this adapter's own validation.
 */
export function createSqliteRecoveryStore(
  options: CreateSqliteRecoveryStoreOptions,
): RecoveryStore {
  return new DefaultSqliteRecoveryStore(options.database);
}

const ACTION_KINDS: Readonly<Record<string, RecoveryActionKind>> = Object.freeze({
  signal: "signal",
  restart: "restart",
  quarantine: "quarantine",
  reconcile: "reconcile",
  debug_attach: "debug_attach",
  source_patch_branch: "source_patch_branch",
  shadow_verify: "shadow_verify",
  candidate_activate: "candidate_activate",
  force_rollback: "force_rollback",
});

const GRANT_STATES: Readonly<Record<string, ElevationGrantState>> = Object.freeze({
  pending: "pending",
  approved: "approved",
  denied: "denied",
  expired: "expired",
  consumed: "consumed",
});

const ACTION_STATES: Readonly<Record<string, RecoveryActionState>> = Object.freeze({
  pending: "pending",
  executed: "executed",
  failed: "failed",
  rejected: "rejected",
  expired: "expired",
});

const GRANT_COLUMNS = `id, requested_by_session_id, authorized_kinds_json, justification, state,
    approvals_received, created_at_ms, expires_at_ms`;

const ACTION_COLUMNS = `id, grant_id, kind, target, expected_state, actor_session_id, expires_at_ms,
    state, created_at_ms, executed_at_ms, failure`;

class DefaultSqliteRecoveryStore implements RecoveryStore {
  readonly #database: ManagedSqliteDatabase;

  constructor(database: ManagedSqliteDatabase) {
    this.#database = database;
  }

  createGrant(grant: ElevationGrant): Promise<void> {
    validateGrantForWrite(grant);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      transaction.run(
        `INSERT INTO elevation_grants (${GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          grant.id,
          grant.requestedBySessionId,
          JSON.stringify(grant.authorizedKinds),
          grant.justification,
          grant.state,
          grant.approvalsReceived,
          grant.createdAt,
          grant.expiresAt,
        ],
      );
    }).catch((error: unknown) => {
      if (error instanceof RecoveryStoreError) throw error;
      throw new RecoveryStoreError(
        "write_failed",
        `elevation grant create failed: ${errorMessage(error)}`,
      );
    });
  }

  getGrant(id: string): Promise<ElevationGrant | undefined> {
    if (id.length === 0) {
      return Promise.reject(new RecoveryStoreError("invalid_input", "grant id must not be empty"));
    }
    return Promise.resolve(
      this.#database.read((reader) => {
        const row = reader.get(`SELECT ${GRANT_COLUMNS} FROM elevation_grants WHERE id = ?`, [id]);
        return row === undefined ? undefined : readGrant(row);
      }),
    );
  }

  createAction(action: RecordedRecoveryAction): Promise<void> {
    validateActionForWrite(action);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      transaction.run(
        `INSERT INTO recovery_actions (${ACTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          action.id,
          action.grantId,
          action.kind,
          action.target,
          action.expectedState,
          action.actorSessionId,
          action.expiresAt,
          action.state,
          action.createdAt,
          action.executedAt ?? null,
          action.failure ?? null,
        ],
      );
    }).catch((error: unknown) => {
      if (error instanceof RecoveryStoreError) throw error;
      throw new RecoveryStoreError(
        "write_failed",
        `recovery action create failed: ${errorMessage(error)}`,
      );
    });
  }

  recordActionOutcome(
    id: string,
    outcome: Readonly<{ state: RecoveryActionState; executedAt?: number; failure?: string }>,
  ): Promise<void> {
    if (id.length === 0) {
      return Promise.reject(
        new RecoveryStoreError("invalid_input", "recovery action id must not be empty"),
      );
    }
    if (ACTION_STATES[outcome.state] === undefined) {
      return Promise.reject(
        new RecoveryStoreError("invalid_input", `unknown recovery action state: ${outcome.state}`),
      );
    }
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const result = transaction.run(
        `UPDATE recovery_actions SET state = ?, executed_at_ms = ?, failure = ? WHERE id = ?`,
        [outcome.state, outcome.executedAt ?? null, outcome.failure ?? null, id],
      );
      if (Number(result.changes) === 0) {
        throw new RecoveryStoreError("not_found", `recovery action not found: ${id}`);
      }
    }).catch((error: unknown) => {
      if (error instanceof RecoveryStoreError) throw error;
      throw new RecoveryStoreError(
        "write_failed",
        `recovery action outcome record failed: ${errorMessage(error)}`,
      );
    });
  }

  markGrantConsumed(id: string): Promise<void> {
    if (id.length === 0) {
      return Promise.reject(new RecoveryStoreError("invalid_input", "grant id must not be empty"));
    }
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const result = transaction.run(
        `UPDATE elevation_grants SET state = 'consumed' WHERE id = ?`,
        [id],
      );
      if (Number(result.changes) === 0) {
        throw new RecoveryStoreError("not_found", `elevation grant not found: ${id}`);
      }
    }).catch((error: unknown) => {
      if (error instanceof RecoveryStoreError) throw error;
      throw new RecoveryStoreError(
        "write_failed",
        `elevation grant consume failed: ${errorMessage(error)}`,
      );
    });
  }

  listActions(
    options: Readonly<{ target?: string; limit: number; before?: string }>,
  ): Promise<readonly RecordedRecoveryAction[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      return Promise.reject(
        new RecoveryStoreError(
          "invalid_input",
          "listActions limit must be a positive safe integer",
        ),
      );
    }
    return Promise.resolve(
      this.#database.read((reader) => {
        let cursor: Readonly<{ createdAtMs: number; id: string }> | undefined;
        if (options.before !== undefined) {
          const cursorRow = reader.get(
            `SELECT created_at_ms, id FROM recovery_actions WHERE id = ?`,
            [options.before],
          );
          if (cursorRow === undefined) {
            return Object.freeze([]);
          }
          cursor = Object.freeze({
            createdAtMs: toSafeNumber(cursorRow, "created_at_ms"),
            id: requiredString(cursorRow, "id"),
          });
        }
        const conditions: string[] = [];
        const parameters: SqliteValue[] = [];
        if (options.target !== undefined) {
          conditions.push("target = ?");
          parameters.push(options.target);
        }
        if (cursor !== undefined) {
          conditions.push("(created_at_ms < ? OR (created_at_ms = ? AND id < ?))");
          parameters.push(cursor.createdAtMs, cursor.createdAtMs, cursor.id);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        parameters.push(options.limit);
        return Object.freeze(
          reader
            .all(
              `SELECT ${ACTION_COLUMNS} FROM recovery_actions
                 ${whereClause}
                ORDER BY created_at_ms DESC, id DESC
                LIMIT ?`,
              parameters,
            )
            .map((row) => readAction(row)),
        );
      }),
    );
  }
}

function validateGrantForWrite(grant: ElevationGrant): void {
  if (grant.id.length === 0) {
    throw new RecoveryStoreError("invalid_input", "grant id must not be empty");
  }
  if (grant.requestedBySessionId.length === 0) {
    throw new RecoveryStoreError("invalid_input", "grant requestedBySessionId must not be empty");
  }
  if (grant.authorizedKinds.length === 0) {
    throw new RecoveryStoreError("invalid_input", "grant authorizedKinds must not be empty");
  }
  for (const kind of grant.authorizedKinds) {
    if (ACTION_KINDS[kind] === undefined) {
      throw new RecoveryStoreError("invalid_input", `unknown recovery action kind: ${kind}`);
    }
  }
  if (grant.justification.length === 0) {
    throw new RecoveryStoreError("invalid_input", "grant justification must not be empty");
  }
  if (GRANT_STATES[grant.state] === undefined) {
    throw new RecoveryStoreError("invalid_input", `unknown elevation grant state: ${grant.state}`);
  }
  if (!Number.isSafeInteger(grant.approvalsReceived) || grant.approvalsReceived < 0) {
    throw new RecoveryStoreError(
      "invalid_input",
      "grant approvalsReceived must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(grant.createdAt) || !Number.isSafeInteger(grant.expiresAt)) {
    throw new RecoveryStoreError(
      "invalid_input",
      "grant createdAt/expiresAt must be safe integers",
    );
  }
}

function validateActionForWrite(action: RecordedRecoveryAction): void {
  if (action.id.length === 0) {
    throw new RecoveryStoreError("invalid_input", "recovery action id must not be empty");
  }
  if (action.grantId.length === 0) {
    throw new RecoveryStoreError("invalid_input", "recovery action grantId must not be empty");
  }
  if (ACTION_KINDS[action.kind] === undefined) {
    throw new RecoveryStoreError("invalid_input", `unknown recovery action kind: ${action.kind}`);
  }
  if (action.target.length === 0) {
    throw new RecoveryStoreError("invalid_input", "recovery action target must not be empty");
  }
  if (action.expectedState.length === 0) {
    throw new RecoveryStoreError(
      "invalid_input",
      "recovery action expectedState must not be empty",
    );
  }
  if (action.actorSessionId.length === 0) {
    throw new RecoveryStoreError(
      "invalid_input",
      "recovery action actorSessionId must not be empty",
    );
  }
  if (ACTION_STATES[action.state] === undefined) {
    throw new RecoveryStoreError("invalid_input", `unknown recovery action state: ${action.state}`);
  }
  if (!Number.isSafeInteger(action.createdAt) || !Number.isSafeInteger(action.expiresAt)) {
    throw new RecoveryStoreError(
      "invalid_input",
      "recovery action createdAt/expiresAt must be safe integers",
    );
  }
}

function readGrant(row: SqliteRow): ElevationGrant {
  const stateValue = requiredString(row, "state");
  const state = GRANT_STATES[stateValue];
  if (state === undefined) {
    throw new RecoveryStoreError("corrupt", `unknown elevation grant state: ${stateValue}`);
  }
  return Object.freeze({
    id: requiredString(row, "id"),
    requestedBySessionId: requiredString(row, "requested_by_session_id"),
    authorizedKinds: decodeKinds(requiredString(row, "authorized_kinds_json")),
    justification: requiredString(row, "justification"),
    state,
    approvalsReceived: toSafeNumber(row, "approvals_received"),
    createdAt: toSafeNumber(row, "created_at_ms"),
    expiresAt: toSafeNumber(row, "expires_at_ms"),
  });
}

function readAction(row: SqliteRow): RecordedRecoveryAction {
  const kindValue = requiredString(row, "kind");
  const kind = ACTION_KINDS[kindValue];
  if (kind === undefined) {
    throw new RecoveryStoreError("corrupt", `unknown recovery action kind: ${kindValue}`);
  }
  const stateValue = requiredString(row, "state");
  const state = ACTION_STATES[stateValue];
  if (state === undefined) {
    throw new RecoveryStoreError("corrupt", `unknown recovery action state: ${stateValue}`);
  }
  const executedAtRaw = row["executed_at_ms"];
  const failureRaw = row["failure"];
  return Object.freeze({
    id: requiredString(row, "id"),
    grantId: requiredString(row, "grant_id"),
    kind,
    target: requiredString(row, "target"),
    expectedState: requiredString(row, "expected_state"),
    actorSessionId: requiredString(row, "actor_session_id"),
    expiresAt: toSafeNumber(row, "expires_at_ms"),
    state,
    createdAt: toSafeNumber(row, "created_at_ms"),
    ...(executedAtRaw === null || executedAtRaw === undefined
      ? {}
      : { executedAt: toSafeNumber(row, "executed_at_ms") }),
    ...(typeof failureRaw === "string" ? { failure: failureRaw } : {}),
  });
}

function decodeKinds(json: string): readonly RecoveryActionKind[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RecoveryStoreError(
      "corrupt",
      `elevation grant authorized_kinds_json is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new RecoveryStoreError(
      "corrupt",
      "elevation grant authorized_kinds_json is not an array",
    );
  }
  return Object.freeze(
    (parsed as readonly unknown[]).map((value) => {
      if (typeof value !== "string" || ACTION_KINDS[value] === undefined) {
        throw new RecoveryStoreError(
          "corrupt",
          `elevation grant authorized_kinds_json contains an unknown kind: ${String(value)}`,
        );
      }
      return ACTION_KINDS[value];
    }),
  );
}

function toSafeNumber(row: SqliteRow, key: string): number {
  const value = row[key];
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) {
    throw new RecoveryStoreError("corrupt", `recovery row ${key} is not an integer`);
  }
  return numeric;
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RecoveryStoreError("corrupt", `recovery row ${key} is missing`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
