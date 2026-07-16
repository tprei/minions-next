import {
  attemptId,
  evidenceId,
  fencingToken,
  schedulerLeaseId,
  taskNodeId,
  timestampFromEpochMilliseconds,
  type AttemptId,
  type ExpiredSchedulerLeaseRecovery,
  type FencingToken,
  type IdGenerator,
  type SchedulerLease,
  type SchedulerLeaseId,
  type SchedulerStore,
  type TaskNodeId,
  type Timestamp,
} from "@minions/core";

import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteRow,
  type SqliteTransaction,
} from "./database.js";

export type SqliteSchedulerErrorCode =
  | "invalid_request"
  | "lease_not_found"
  | "stale_lease"
  | "expired_lease"
  | "corrupt"
  | "arithmetic_overflow";

export class SqliteSchedulerError extends Error {
  readonly code: SqliteSchedulerErrorCode;

  constructor(code: SqliteSchedulerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteSchedulerError";
    this.code = code;
  }
}

export type CreateSqliteSchedulerStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
  ids: IdGenerator;
}>;

export function createSqliteSchedulerStore(
  options: CreateSqliteSchedulerStoreOptions,
): SchedulerStore {
  return new DefaultSqliteSchedulerStore(options);
}

class DefaultSqliteSchedulerStore implements SchedulerStore {
  readonly #database: ManagedSqliteDatabase;
  readonly #ids: IdGenerator;

  constructor(options: CreateSqliteSchedulerStoreOptions) {
    this.#database = options.database;
    this.#ids = options.ids;
  }

  claimNext(
    request: Parameters<SchedulerStore["claimNext"]>[0],
  ): Promise<SchedulerLease | undefined> {
    const at = timestampNumber(request.at, "claim timestamp");
    const expiresAt = addDuration(at, request.leaseDurationMs);
    requireCapacity(request.capacity.maxActiveGlobal, "global capacity");
    requireCapacity(request.capacity.maxActivePerTree, "per-tree capacity");
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      projectReadyChildren(transaction, at);
      projectFailedDescendants(transaction, at);
      const candidate = selectEligibleNode(
        transaction,
        request.capacity.maxActiveGlobal,
        request.capacity.maxActivePerTree,
      );
      if (candidate === undefined) return undefined;

      const nodeId = requiredText(candidate, "id");
      const attemptOrdinal = nextAttemptOrdinal(transaction, nodeId);
      const token = allocateFence(transaction, nodeId);
      const nextAttemptId = attemptId(this.#ids.nextId());
      const nextLeaseId = schedulerLeaseId(this.#ids.nextId());
      const activated = transaction.run(
        `UPDATE nodes
            SET state_kind = 'active', version = version + 1, updated_at_ms = ?
          WHERE id = ? AND state_kind = 'ready'`,
        [at, nodeId],
      );
      if (changes(activated.changes) !== 1n) {
        throw new SqliteSchedulerError("corrupt", "eligible scheduler node was not ready");
      }
      transaction.run(
        `INSERT INTO attempts (
           id, node_id, tree_id, repository_id, host_id, plan_revision_id,
           ordinal, state_kind, version, started_at_ms, finished_at_ms, evidence_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL, NULL)`,
        [
          nextAttemptId,
          nodeId,
          requiredText(candidate, "tree_id"),
          requiredText(candidate, "repository_id"),
          requiredText(candidate, "host_id"),
          requiredText(candidate, "plan_revision_id"),
          attemptOrdinal,
          at,
        ],
      );
      transaction.run(
        `INSERT INTO scheduler_leases (
           id, attempt_id, node_id, tree_id, repository_id, host_id, owner_id,
           fencing_token, state_kind, acquired_at_ms, heartbeat_at_ms, expires_at_ms,
           released_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
        [
          nextLeaseId,
          nextAttemptId,
          nodeId,
          requiredText(candidate, "tree_id"),
          requiredText(candidate, "repository_id"),
          requiredText(candidate, "host_id"),
          request.ownerId,
          token,
          at,
          at,
          expiresAt,
        ],
      );
      return readLease(transaction, nextLeaseId);
    });
  }

  heartbeat(request: Parameters<SchedulerStore["heartbeat"]>[0]): Promise<SchedulerLease> {
    const at = timestampNumber(request.at, "heartbeat timestamp");
    const expiresAt = addDuration(at, request.leaseDurationMs);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const row = requireLeaseReference(
        transaction,
        request.lease.id,
        request.lease.ownerId,
        request.lease.fencingToken,
      );
      requireActiveUnexpired(row, at);
      if (at <= requiredInteger(row, "heartbeat_at_ms")) {
        throw new SqliteSchedulerError(
          "invalid_request",
          "scheduler heartbeat timestamp must advance",
        );
      }
      transaction.run(
        "UPDATE scheduler_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ?",
        [at, expiresAt, request.lease.id],
      );
      return readLease(transaction, request.lease.id);
    });
  }

  release(request: Parameters<SchedulerStore["release"]>[0]): Promise<void> {
    const at = timestampNumber(request.at, "release timestamp");
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const row = requireLeaseReference(
        transaction,
        request.lease.id,
        request.lease.ownerId,
        request.lease.fencingToken,
      );
      requireActiveUnexpired(row, at);
      const attempt = transaction.get("SELECT state_kind FROM attempts WHERE id = ?", [
        requiredText(row, "attempt_id"),
      ]);
      if (attempt === undefined) {
        throw new SqliteSchedulerError("corrupt", "scheduler lease attempt is missing");
      }
      transaction.run(
        "UPDATE scheduler_leases SET state_kind = 'released', released_at_ms = ? WHERE id = ?",
        [at, request.lease.id],
      );
      if (requiredText(attempt, "state_kind") === "active") {
        const failureEvidence = evidenceId(this.#ids.nextId());
        finishActiveAttempt(
          transaction,
          requiredText(row, "attempt_id"),
          "failed",
          at,
          failureEvidence,
        );
        retryOrFailNode(transaction, requiredText(row, "node_id"), at, failureEvidence);
      }
    });
  }

  cancelNode(request: Parameters<SchedulerStore["cancelNode"]>[0]): Promise<void> {
    const at = timestampNumber(request.at, "cancellation timestamp");
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const node = transaction.get("SELECT state_kind FROM nodes WHERE id = ?", [request.nodeId]);
      if (node === undefined) {
        throw new SqliteSchedulerError("invalid_request", "scheduled node does not exist");
      }
      const state = requiredText(node, "state_kind");
      if (isTerminalNodeState(state)) {
        throw new SqliteSchedulerError("invalid_request", "scheduled node is already terminal");
      }
      const activeLease = transaction.get(
        "SELECT id, attempt_id FROM scheduler_leases WHERE node_id = ? AND state_kind = 'active'",
        [request.nodeId],
      );
      if (activeLease !== undefined) {
        transaction.run(
          "UPDATE scheduler_leases SET state_kind = 'cancelled', released_at_ms = ? WHERE id = ?",
          [at, requiredText(activeLease, "id")],
        );
        finishActiveAttempt(
          transaction,
          requiredText(activeLease, "attempt_id"),
          "cancelled",
          at,
          request.evidenceId,
        );
      }
      transaction.run(
        `UPDATE nodes
            SET state_kind = 'cancelled', terminal_evidence_id = ?,
                resume_state_kind = NULL, blocker_kind = NULL, blocker_evidence_id = NULL,
                blocker_parent_node_id = NULL, blocker_host_id = NULL,
                version = version + 1, updated_at_ms = ?
          WHERE id = ?`,
        [request.evidenceId, at, request.nodeId],
      );
      blockDescendants(transaction, request.nodeId, request.evidenceId, at);
    });
  }

  async recoverExpired(atValue: Timestamp): Promise<readonly ExpiredSchedulerLeaseRecovery[]> {
    const at = timestampNumber(atValue, "recovery timestamp");
    const leases = this.#database.read((reader) =>
      reader.all(
        `SELECT id, attempt_id, node_id
           FROM scheduler_leases
          WHERE state_kind = 'active' AND expires_at_ms <= ?
          ORDER BY expires_at_ms, node_id, id`,
        [at],
      ),
    );
    const results: ExpiredSchedulerLeaseRecovery[] = [];
    for (const lease of leases) {
      let leaseId: SchedulerLeaseId | undefined;
      let leaseAttemptId: AttemptId | undefined;
      let nodeId: TaskNodeId | undefined;
      try {
        const validLeaseId = schedulerLeaseId(requiredText(lease, "id"));
        leaseId = validLeaseId;
        leaseAttemptId = attemptId(requiredText(lease, "attempt_id"));
        nodeId = taskNodeId(requiredText(lease, "node_id"));
        const recovery = await executeManagedSqliteWrite(this.#database, (transaction) =>
          recoverOneExpired(transaction, validLeaseId, at, evidenceId(this.#ids.nextId())),
        );
        results.push(
          Object.freeze({
            leaseId,
            attemptId: leaseAttemptId,
            nodeId,
            ...recovery,
          }),
        );
      } catch (error) {
        results.push(
          Object.freeze({
            leaseId,
            attemptId: leaseAttemptId,
            nodeId,
            recovered: false,
            retryScheduled: false,
            error: errorMessage(error),
          }),
        );
      }
    }
    return Object.freeze(results);
  }
}

function selectEligibleNode(
  transaction: SqliteTransaction,
  maxActiveGlobal: number,
  maxActivePerTree: number,
): SqliteRow | undefined {
  return transaction.get(
    `SELECT n.id, n.tree_id, n.repository_id, n.host_id, n.plan_revision_id
       FROM nodes n
       JOIN trees t ON t.id = n.tree_id
       JOIN repositories r ON r.id = n.repository_id
       JOIN plan_revisions p
         ON p.id = t.active_plan_revision_id AND p.tree_id = t.id
       JOIN tree_budgets b ON b.tree_id = t.id
      WHERE n.state_kind = 'ready'
        AND n.plan_revision_id = t.active_plan_revision_id
        AND t.archived_at_ms IS NULL
        AND r.archived_at_ms IS NULL
        AND p.state_kind = 'approved'
        AND (SELECT count(*) FROM scheduler_leases l WHERE l.state_kind = 'active') < ?
        AND (
          SELECT count(*) FROM scheduler_leases l
           WHERE l.state_kind = 'active' AND l.tree_id = n.tree_id
        ) < min(?, b.max_concurrency)
        AND NOT EXISTS (
          SELECT 1 FROM scheduler_leases l
           WHERE l.node_id = n.id AND l.state_kind = 'active'
        )
        AND (
          SELECT count(*) FROM attempts a WHERE a.node_id = n.id
        ) < min(
          (SELECT max_attempts FROM node_plan_policies np WHERE np.node_id = n.id),
          b.max_attempts_per_node
        )
      ORDER BY t.created_at_ms, t.id, n.created_at_ms, n.id
      LIMIT 1`,
    [maxActiveGlobal, maxActivePerTree],
  );
}

function projectReadyChildren(transaction: SqliteTransaction, at: number): void {
  transaction.run(
    `UPDATE nodes
        SET state_kind = 'ready', version = version + 1, updated_at_ms = ?
      WHERE state_kind = 'planned'
        AND EXISTS (
          SELECT 1
            FROM nodes parent
            JOIN trees tree ON tree.id = nodes.tree_id
            JOIN repositories repository ON repository.id = nodes.repository_id
            JOIN plan_revisions revision
              ON revision.tree_id = tree.id
             AND revision.id = tree.active_plan_revision_id
           WHERE parent.id = nodes.parent_node_id
             AND parent.tree_id = nodes.tree_id
             AND parent.state_kind = 'succeeded'
             AND nodes.plan_revision_id = tree.active_plan_revision_id
             AND tree.archived_at_ms IS NULL
             AND repository.archived_at_ms IS NULL
             AND revision.state_kind = 'approved'
        )`,
    [at],
  );
}

function projectFailedDescendants(transaction: SqliteTransaction, at: number): void {
  const failed = transaction.all(
    `SELECT id, terminal_evidence_id FROM nodes
      WHERE state_kind IN ('failed', 'cancelled') AND terminal_evidence_id IS NOT NULL
      ORDER BY updated_at_ms, id`,
  );
  for (const parent of failed) {
    blockDescendants(
      transaction,
      requiredText(parent, "id"),
      requiredText(parent, "terminal_evidence_id"),
      at,
    );
  }
}

function blockDescendants(
  transaction: SqliteTransaction,
  parentNodeId: string,
  blockerEvidenceId: string,
  at: number,
): void {
  transaction.run(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM nodes WHERE parent_node_id = ?
       UNION ALL
       SELECT child.id FROM nodes child JOIN descendants d ON child.parent_node_id = d.id
     )
     UPDATE nodes
        SET state_kind = 'blocked', resume_state_kind = CASE state_kind WHEN 'active' THEN 'active' ELSE 'ready' END,
            blocker_kind = 'parent', blocker_evidence_id = ?, blocker_parent_node_id = ?,
            blocker_host_id = NULL, version = version + 1, updated_at_ms = ?
      WHERE id IN (SELECT id FROM descendants)
        AND state_kind IN ('planned', 'ready', 'active')`,
    [parentNodeId, blockerEvidenceId, parentNodeId, at],
  );
}

function allocateFence(transaction: SqliteTransaction, nodeId: string): bigint {
  const current = transaction.get(
    "SELECT next_fencing_token FROM node_scheduler_fences WHERE node_id = ?",
    [nodeId],
  );
  if (current === undefined) {
    transaction.run(
      "INSERT INTO node_scheduler_fences (node_id, next_fencing_token) VALUES (?, 2)",
      [nodeId],
    );
    return 1n;
  }
  const token = requiredInteger(current, "next_fencing_token");
  if (token >= BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SqliteSchedulerError("arithmetic_overflow", "scheduler fencing token is exhausted");
  }
  transaction.run("UPDATE node_scheduler_fences SET next_fencing_token = ? WHERE node_id = ?", [
    token + 1n,
    nodeId,
  ]);
  return token;
}

function nextAttemptOrdinal(transaction: SqliteTransaction, nodeId: string): bigint {
  const row = transaction.get(
    "SELECT coalesce(max(ordinal), 0) + 1 AS ordinal FROM attempts WHERE node_id = ?",
    [nodeId],
  );
  const ordinal = requiredInteger(row, "ordinal");
  if (ordinal > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SqliteSchedulerError("arithmetic_overflow", "attempt ordinal is exhausted");
  }
  return ordinal;
}

function requireLeaseReference(
  transaction: SqliteTransaction,
  leaseId: SchedulerLeaseId,
  ownerId: string,
  token: FencingToken,
): SqliteRow {
  const row = transaction.get("SELECT * FROM scheduler_leases WHERE id = ?", [leaseId]);
  if (row === undefined) {
    throw new SqliteSchedulerError("lease_not_found", "scheduler lease does not exist");
  }
  if (
    requiredText(row, "owner_id") !== ownerId ||
    requiredInteger(row, "fencing_token") !== token
  ) {
    throw new SqliteSchedulerError(
      "stale_lease",
      "scheduler lease owner or fencing token is stale",
    );
  }
  return row;
}

function requireActiveUnexpired(row: SqliteRow, at: number): void {
  if (
    requiredText(row, "state_kind") !== "active" ||
    requiredInteger(row, "expires_at_ms") <= BigInt(at)
  ) {
    throw new SqliteSchedulerError("expired_lease", "scheduler lease is no longer active");
  }
}

type ExpiredRecoveryResult = Readonly<{
  recovered: boolean;
  retryScheduled: boolean;
  error: string | undefined;
}>;

function recoverOneExpired(
  transaction: SqliteTransaction,
  leaseId: SchedulerLeaseId,
  at: number,
  failureEvidence: string,
): ExpiredRecoveryResult {
  const lease = transaction.get("SELECT * FROM scheduler_leases WHERE id = ?", [leaseId]);
  if (lease === undefined) {
    throw new SqliteSchedulerError("corrupt", "expired scheduler lease is missing");
  }
  if (
    requiredText(lease, "state_kind") !== "active" ||
    requiredInteger(lease, "expires_at_ms") > BigInt(at)
  ) {
    return { recovered: true, retryScheduled: false, error: undefined };
  }
  transaction.run(
    "UPDATE scheduler_leases SET state_kind = 'expired', released_at_ms = ? WHERE id = ?",
    [at, leaseId],
  );
  const attemptChanged = finishActiveAttempt(
    transaction,
    requiredText(lease, "attempt_id"),
    "failed",
    at,
    failureEvidence,
  );
  if (!attemptChanged) {
    return {
      recovered: false,
      retryScheduled: false,
      error: "expired scheduler lease attempt was already terminal",
    };
  }
  const retryScheduled = retryOrFailNode(
    transaction,
    requiredText(lease, "node_id"),
    at,
    failureEvidence,
  );
  return { recovered: true, retryScheduled, error: undefined };
}

function finishActiveAttempt(
  transaction: SqliteTransaction,
  attempt: string,
  state: "failed" | "cancelled",
  at: number,
  failureEvidence: string,
): boolean {
  const result = transaction.run(
    `UPDATE attempts
        SET state_kind = ?, version = version + 1, finished_at_ms = ?, evidence_id = ?
      WHERE id = ? AND state_kind = 'active'`,
    [state, at, failureEvidence, attempt],
  );
  return changes(result.changes) === 1n;
}

function retryOrFailNode(
  transaction: SqliteTransaction,
  nodeId: string,
  at: number,
  failureEvidence: string,
): boolean {
  const budget = transaction.get(
    `SELECT min(np.max_attempts, tb.max_attempts_per_node) AS max_attempts,
            (SELECT count(*) FROM attempts a WHERE a.node_id = n.id) AS attempts
       FROM nodes n
       JOIN node_plan_policies np ON np.node_id = n.id
       JOIN tree_budgets tb ON tb.tree_id = n.tree_id
      WHERE n.id = ?`,
    [nodeId],
  );
  if (budget === undefined) {
    throw new SqliteSchedulerError("corrupt", "scheduled node budget is missing");
  }
  const canRetry = requiredInteger(budget, "attempts") < requiredInteger(budget, "max_attempts");
  if (canRetry) {
    transaction.run(
      `UPDATE nodes
          SET state_kind = 'ready', resume_state_kind = NULL, blocker_kind = NULL,
              blocker_evidence_id = NULL, blocker_parent_node_id = NULL, blocker_host_id = NULL,
              version = version + 1, updated_at_ms = ?
        WHERE id = ? AND state_kind = 'active'`,
      [at, nodeId],
    );
    return true;
  }
  transaction.run(
    `UPDATE nodes
        SET state_kind = 'failed', terminal_evidence_id = ?, resume_state_kind = NULL,
            blocker_kind = NULL, blocker_evidence_id = NULL, blocker_parent_node_id = NULL,
            blocker_host_id = NULL, version = version + 1, updated_at_ms = ?
      WHERE id = ? AND state_kind = 'active'`,
    [failureEvidence, at, nodeId],
  );
  blockDescendants(transaction, nodeId, failureEvidence, at);
  return false;
}

function readLease(transaction: SqliteTransaction, id: SchedulerLeaseId): SchedulerLease {
  const row = transaction.get("SELECT * FROM scheduler_leases WHERE id = ?", [id]);
  if (row === undefined)
    throw new SqliteSchedulerError("corrupt", "scheduler lease insert is missing");
  return Object.freeze({
    id,
    attemptId: attemptId(requiredText(row, "attempt_id")),
    nodeId: requiredText(row, "node_id") as SchedulerLease["nodeId"],
    treeId: requiredText(row, "tree_id") as SchedulerLease["treeId"],
    repositoryId: requiredText(row, "repository_id") as SchedulerLease["repositoryId"],
    hostId: requiredText(row, "host_id") as SchedulerLease["hostId"],
    ownerId: requiredText(row, "owner_id") as SchedulerLease["ownerId"],
    fencingToken: fencingToken(requiredInteger(row, "fencing_token")),
    acquiredAt: timestampFromEpochMilliseconds(requiredSafeNumber(row, "acquired_at_ms")),
    heartbeatAt: timestampFromEpochMilliseconds(requiredSafeNumber(row, "heartbeat_at_ms")),
    expiresAt: timestampFromEpochMilliseconds(requiredSafeNumber(row, "expires_at_ms")),
  });
}

function timestampNumber(value: Timestamp, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SqliteSchedulerError("invalid_request", `${fieldName} must be non-negative`);
  }
  return value;
}

function addDuration(at: number, duration: number): number {
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new SqliteSchedulerError("invalid_request", "scheduler lease duration must be positive");
  }
  const result = at + duration;
  if (!Number.isSafeInteger(result)) {
    throw new SqliteSchedulerError("arithmetic_overflow", "scheduler lease expiry overflows");
  }
  return result;
}

function requireCapacity(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SqliteSchedulerError("invalid_request", `${fieldName} must be positive`);
  }
}

function requiredText(row: SqliteRow | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SqliteSchedulerError("corrupt", `scheduler row ${key} is invalid`);
  }
  return value;
}

function requiredInteger(row: SqliteRow | undefined, key: string): bigint {
  const value = row?.[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new SqliteSchedulerError("corrupt", `scheduler row ${key} is invalid`);
}

function requiredSafeNumber(row: SqliteRow, key: string): number {
  const value = requiredInteger(row, key);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new SqliteSchedulerError("corrupt", `scheduler row ${key} exceeds safe range`);
  }
  return result;
}

function changes(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function isTerminalNodeState(state: string): boolean {
  return (
    state === "succeeded" || state === "failed" || state === "cancelled" || state === "superseded"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
