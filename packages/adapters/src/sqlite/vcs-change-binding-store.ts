import {
  contentHash,
  gitSha,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  validateVcsChangeBinding,
  VcsChangeBindingStoreError,
  type ConflictState,
  type ContentHash,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";

import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteRow,
} from "./database.js";

export type CreateSqliteVcsChangeBindingStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

/**
 * SQLite {@link VcsChangeBindingStore}: the durable identity link between a
 * (tree, node) and its jj change (PR 29, GIT-02/GIT-16). Each upsert is a
 * single crash-safe transaction, idempotent on the composite key (tree_id,
 * node_id). Identity immutability + rewrite monotonicity + delete durability
 * are enforced by DB triggers, so a stale or conflicting writer fails closed
 * instead of silently corrupting the binding.
 */
export function createSqliteVcsChangeBindingStore(
  options: CreateSqliteVcsChangeBindingStoreOptions,
): VcsChangeBindingStore {
  return new DefaultSqliteVcsChangeBindingStore(options.database);
}

const UPSERT_SQL = `INSERT INTO vcs_change_bindings (
    tree_id, node_id, jj_change_id, current_commit_id, parent_change_id,
    bookmark, rewrite_generation, last_jj_operation_id, last_pushed_commit_id,
    last_reviewed_commit_id, conflict_state, recorded_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tree_id, node_id) DO UPDATE SET
    jj_change_id = excluded.jj_change_id,
    current_commit_id = excluded.current_commit_id,
    parent_change_id = excluded.parent_change_id,
    bookmark = excluded.bookmark,
    rewrite_generation = excluded.rewrite_generation,
    last_jj_operation_id = excluded.last_jj_operation_id,
    last_pushed_commit_id = excluded.last_pushed_commit_id,
    last_reviewed_commit_id = excluded.last_reviewed_commit_id,
    conflict_state = excluded.conflict_state,
    recorded_at_ms = excluded.recorded_at_ms`;

const SELECT_COLUMNS = `tree_id, node_id, jj_change_id, current_commit_id, parent_change_id,
    bookmark, rewrite_generation, last_jj_operation_id, last_pushed_commit_id,
    last_reviewed_commit_id, conflict_state, recorded_at_ms`;

class DefaultSqliteVcsChangeBindingStore implements VcsChangeBindingStore {
  readonly #database: ManagedSqliteDatabase;

  constructor(database: ManagedSqliteDatabase) {
    this.#database = database;
  }

  async upsertBinding(binding: VcsChangeBinding): Promise<void> {
    try {
      validateVcsChangeBinding(binding);
    } catch (error) {
      throw new VcsChangeBindingStoreError(
        "invalid_input",
        `vcs change binding is invalid: ${errorMessage(error)}`,
      );
    }
    await executeManagedSqliteWrite(this.#database, (transaction) => {
      transaction.run(UPSERT_SQL, [
        binding.treeId,
        binding.nodeId,
        binding.jjChangeId,
        binding.currentCommitId,
        binding.parentChangeId ?? null,
        binding.bookmark ?? null,
        binding.rewriteGeneration,
        binding.lastJjOperationId,
        binding.lastPushedCommitId ?? null,
        binding.lastReviewedCommitId ?? null,
        binding.conflictState,
        binding.recordedAt,
      ]);
    }).catch((error: unknown) => {
      if (error instanceof VcsChangeBindingStoreError) throw error;
      throw new VcsChangeBindingStoreError(
        "write_failed",
        `vcs change binding upsert failed: ${errorMessage(error)}`,
      );
    });
  }

  getBinding(
    treeIdValue: TaskTreeId,
    nodeIdValue: TaskNodeId,
  ): Promise<VcsChangeBinding | undefined> {
    return Promise.resolve(
      this.#database.read((reader) => {
        const row = reader.get(
          `SELECT ${SELECT_COLUMNS} FROM vcs_change_bindings WHERE tree_id = ? AND node_id = ?`,
          [treeIdValue, nodeIdValue],
        );
        return row === undefined ? undefined : readBinding(row);
      }),
    );
  }

  getByChangeId(
    treeIdValue: TaskTreeId,
    jjChangeIdValue: ContentHash,
  ): Promise<VcsChangeBinding | undefined> {
    return Promise.resolve(
      this.#database.read((reader) => {
        const row = reader.get(
          `SELECT ${SELECT_COLUMNS} FROM vcs_change_bindings WHERE tree_id = ? AND jj_change_id = ?`,
          [treeIdValue, jjChangeIdValue],
        );
        return row === undefined ? undefined : readBinding(row);
      }),
    );
  }

  listForTree(treeIdValue: TaskTreeId): Promise<readonly VcsChangeBinding[]> {
    return Promise.resolve(
      this.#database.read((reader) =>
        reader
          .all(
            `SELECT ${SELECT_COLUMNS} FROM vcs_change_bindings WHERE tree_id = ?
             ORDER BY node_id ASC`,
            [treeIdValue],
          )
          .map((row) => readBinding(row)),
      ),
    );
  }

  assertNoOrphans(treeIdValue: TaskTreeId, knownNodeIds: readonly TaskNodeId[]): Promise<void> {
    const known = new Set<string>(knownNodeIds);
    return new Promise((resolve) => {
      this.#database.read((reader) => {
        const rows = reader.all(
          "SELECT DISTINCT node_id AS node_id FROM vcs_change_bindings WHERE tree_id = ?",
          [treeIdValue],
        );
        const orphans = rows
          .map((row) => requiredString(row, "node_id"))
          .filter((nodeIdValue) => !known.has(nodeIdValue));
        if (orphans.length > 0) {
          throw new VcsChangeBindingStoreError(
            "orphan_binding",
            `vcs change bindings reference unknown nodes in tree ${treeIdValue}: ${orphans.join(", ")}`,
          );
        }
      });
      resolve();
    });
  }

  assertNoDuplicates(treeIdValue: TaskTreeId): Promise<void> {
    return new Promise((resolve) => {
      this.#database.read((reader) => {
        // The composite PK guarantees at most one row per (tree_id, node_id);
        // this defensively asserts that invariant and additionally fail-closes
        // when a single jj change is bound to more than one node in the tree.
        const duplicatedNodes = reader.all(
          `SELECT node_id AS node_id, COUNT(*) AS occurrences
             FROM vcs_change_bindings
            WHERE tree_id = ?
            GROUP BY node_id
           HAVING occurrences > 1`,
          [treeIdValue],
        );
        if (duplicatedNodes.length > 0) {
          throw new VcsChangeBindingStoreError(
            "duplicate_binding",
            `duplicate vcs change bindings for nodes in tree ${treeIdValue}: ${duplicatedNodes
              .map((row) => requiredString(row, "node_id"))
              .join(", ")}`,
          );
        }
        const duplicatedChanges = reader.all(
          `SELECT jj_change_id AS jj_change_id, COUNT(DISTINCT node_id) AS node_count
             FROM vcs_change_bindings
            WHERE tree_id = ?
            GROUP BY jj_change_id
           HAVING node_count > 1`,
          [treeIdValue],
        );
        if (duplicatedChanges.length > 0) {
          throw new VcsChangeBindingStoreError(
            "duplicate_binding",
            `jj change ids bound to multiple nodes in tree ${treeIdValue}: ${duplicatedChanges
              .map((row) => requiredString(row, "jj_change_id"))
              .join(", ")}`,
          );
        }
      });
      resolve();
    });
  }
}

function readBinding(row: SqliteRow): VcsChangeBinding {
  const conflictValue = requiredString(row, "conflict_state");
  const conflictState = conflictStateFromValue(conflictValue);
  const parentChangeId = nullableString(row, "parent_change_id");
  const bookmark = nullableString(row, "bookmark");
  const lastPushedCommitId = nullableString(row, "last_pushed_commit_id");
  const lastReviewedCommitId = nullableString(row, "last_reviewed_commit_id");
  return Object.freeze({
    treeId: taskTreeId(requiredString(row, "tree_id")),
    nodeId: taskNodeId(requiredString(row, "node_id")),
    jjChangeId: contentHash(requiredString(row, "jj_change_id")),
    currentCommitId: gitSha(requiredString(row, "current_commit_id")),
    parentChangeId: parentChangeId === undefined ? undefined : contentHash(parentChangeId),
    bookmark,
    rewriteGeneration: toSafeNumber(row, "rewrite_generation"),
    lastJjOperationId: contentHash(requiredString(row, "last_jj_operation_id")),
    lastPushedCommitId: lastPushedCommitId === undefined ? undefined : gitSha(lastPushedCommitId),
    lastReviewedCommitId:
      lastReviewedCommitId === undefined ? undefined : gitSha(lastReviewedCommitId),
    conflictState,
    recordedAt: timestampFromEpochMilliseconds(toSafeNumber(row, "recorded_at_ms")),
  });
}

function conflictStateFromValue(value: string): ConflictState {
  switch (value) {
    case "clean":
      return "clean";
    case "conflict":
      return "conflict";
    case "resolved":
      return "resolved";
    default:
      throw new VcsChangeBindingStoreError("corrupt", `unknown conflict state: ${value}`);
  }
}

function toSafeNumber(row: SqliteRow, key: string): number {
  const value = row[key];
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) {
    throw new VcsChangeBindingStoreError("corrupt", `vcs change binding ${key} is not an integer`);
  }
  return numeric;
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new VcsChangeBindingStoreError("corrupt", `vcs change binding ${key} is missing`);
  }
  return value;
}

function nullableString(row: SqliteRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new VcsChangeBindingStoreError("corrupt", `vcs change binding ${key} is invalid`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
