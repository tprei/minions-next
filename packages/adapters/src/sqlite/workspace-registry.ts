import {
  attemptId,
  fencingToken,
  gitSha,
  hostId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type AttemptId,
  type GitSha,
  type HostId,
  type RepositoryId,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
  type WorkspaceReceipt,
  type WorkspaceState,
} from "@minions/core";

import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteReader,
  type SqliteRow,
  type SqliteTransaction,
} from "./database.js";

export type WorkspaceBeginInput = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  hostId: HostId;
  repositoryId: RepositoryId;
  workspacePath: string;
  sourcePath: string;
  branchName: string;
  baseCommit: GitSha;
  createdAt: Timestamp;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
  expectedVersion?: number;
}>;

export type WorkspaceReadyInput = Readonly<{
  attemptId: AttemptId;
  expectedVersion: number;
  headCommit: GitSha;
  readyAt: Timestamp;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

export type WorkspaceCleanupInput = Readonly<{
  attemptId: AttemptId;
  expectedVersion: number;
  cleanupRequestedAt: Timestamp;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

export type WorkspaceCleanedInput = Readonly<{
  attemptId: AttemptId;
  expectedVersion: number;
  cleanedAt: Timestamp;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

export type WorkspaceFailedInput = Readonly<{
  attemptId: AttemptId;
  expectedVersion: number;
  failureCode: string;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

export interface WorkspaceRegistry {
  begin(input: WorkspaceBeginInput): Promise<WorkspaceReceipt>;
  markReady(input: WorkspaceReadyInput): Promise<WorkspaceReceipt>;
  requestCleanup(input: WorkspaceCleanupInput): Promise<WorkspaceReceipt>;
  markCleaned(input: WorkspaceCleanedInput): Promise<WorkspaceReceipt>;
  markFailed(input: WorkspaceFailedInput): Promise<WorkspaceReceipt>;
  get(attemptId: AttemptId): WorkspaceReceipt;
  listRecoverable(): readonly WorkspaceReceipt[];
}

export type WorkspaceRegistryErrorCode =
  | "invalid_input"
  | "not_found"
  | "ownership_conflict"
  | "conflict"
  | "version_conflict"
  | "invalid_transition"
  | "stale_lease"
  | "corrupt";

export class WorkspaceRegistryError extends Error {
  readonly code: WorkspaceRegistryErrorCode;

  constructor(code: WorkspaceRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceRegistryError";
    this.code = code;
  }
}

export type CreateSqliteWorkspaceRegistryOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

export class SqliteWorkspaceRegistry implements WorkspaceRegistry {
  readonly #database: ManagedSqliteDatabase;

  constructor(options: CreateSqliteWorkspaceRegistryOptions) {
    this.#database = options.database;
  }

  begin(input: WorkspaceBeginInput): Promise<WorkspaceReceipt> {
    const candidate = validateBeginInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      assertWorkspaceOwnership(transaction, candidate);
      assertMutationLeaseHeld(
        transaction,
        candidate.repositoryId,
        candidate.ownerId,
        candidate.fencingToken,
        candidate.observedAt,
      );
      const existing = readWorkspaceByAttempt(transaction, candidate.attemptId);
      if (existing === undefined) {
        if (candidate.expectedVersion !== undefined && candidate.expectedVersion !== 0) {
          throw new WorkspaceRegistryError(
            "version_conflict",
            "new workspace must begin at version zero",
          );
        }
        transaction.run(
          `INSERT INTO workspace_bindings (
             attempt_id, node_id, tree_id, repository_id, host_id,
             workspace_path, source_path, branch_name, base_commit, head_commit,
             state_kind, created_at_ms, ready_at_ms, cleanup_requested_at_ms,
             cleaned_at_ms, failure_code, version, mutation_fencing_token
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, NULL, NULL, NULL, NULL, 0, ?)`,
          [
            candidate.attemptId,
            candidate.nodeId,
            candidate.treeId,
            candidate.repositoryId,
            candidate.hostId,
            candidate.workspacePath,
            candidate.sourcePath,
            candidate.branchName,
            candidate.baseCommit,
            candidate.baseCommit,
            candidate.createdAt,
            candidate.fencingToken,
          ],
        );
        return requireWorkspaceByAttempt(transaction, candidate.attemptId);
      }
      assertMutationFence(existing, candidate.fencingToken);

      assertIdentityMatches(existing, candidate);
      if (candidate.expectedVersion !== undefined) {
        assertExpectedVersion(existing, candidate.expectedVersion);
      }
      if (existing.state !== "creating") {
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "workspace begin cannot replay a non-creating receipt",
        );
      }
      return existing;
    }).catch((error: unknown) => {
      throw normalizeWorkspaceError(error);
    });
  }

  markReady(input: WorkspaceReadyInput): Promise<WorkspaceReceipt> {
    const candidate = validateReadyInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const existing = requireWorkspaceByAttempt(transaction, candidate.attemptId);
      assertMutationLeaseHeld(
        transaction,
        existing.repositoryId,
        candidate.ownerId,
        candidate.fencingToken,
        candidate.observedAt,
      );
      assertMutationFence(existing, candidate.fencingToken);
      if (existing.state === "ready") {
        if (
          existing.headCommit === candidate.headCommit &&
          existing.readyAt === candidate.readyAt
        ) {
          return existing;
        }
        assertExpectedVersion(existing, candidate.expectedVersion);
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "ready workspace replay does not match the committed receipt",
        );
      }
      assertExpectedVersion(existing, candidate.expectedVersion);
      if (existing.state !== "creating") {
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "workspace can only become ready from creating",
        );
      }
      if (candidate.readyAt < existing.createdAt) {
        throw new WorkspaceRegistryError(
          "invalid_input",
          "workspace ready timestamp predates creation",
        );
      }
      transaction.run(
        `UPDATE workspace_bindings
            SET head_commit = ?, state_kind = 'ready', ready_at_ms = ?,
                mutation_fencing_token = ?, version = version + 1
          WHERE attempt_id = ? AND version = ? AND state_kind = 'creating'`,
        [
          candidate.headCommit,
          candidate.readyAt,
          candidate.fencingToken,
          candidate.attemptId,
          candidate.expectedVersion,
        ],
      );
      return requireWorkspaceByAttempt(transaction, candidate.attemptId);
    }).catch((error: unknown) => {
      throw normalizeWorkspaceError(error);
    });
  }

  requestCleanup(input: WorkspaceCleanupInput): Promise<WorkspaceReceipt> {
    const candidate = validateCleanupInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const existing = requireWorkspaceByAttempt(transaction, candidate.attemptId);
      assertMutationLeaseHeld(
        transaction,
        existing.repositoryId,
        candidate.ownerId,
        candidate.fencingToken,
        candidate.observedAt,
      );
      assertMutationFence(existing, candidate.fencingToken);
      if (existing.state === "cleanup_pending") {
        if (existing.cleanupRequestedAt === candidate.cleanupRequestedAt) {
          return existing;
        }
        assertExpectedVersion(existing, candidate.expectedVersion);
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "cleanup request replay does not match the committed receipt",
        );
      }
      assertExpectedVersion(existing, candidate.expectedVersion);
      if (existing.state !== "ready") {
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "workspace cleanup can only start from ready",
        );
      }
      if (candidate.cleanupRequestedAt < requireTimestamp(existing.readyAt, "ready_at_ms")) {
        throw new WorkspaceRegistryError(
          "invalid_input",
          "workspace cleanup timestamp predates readiness",
        );
      }
      transaction.run(
        `UPDATE workspace_bindings
            SET state_kind = 'cleanup_pending', cleanup_requested_at_ms = ?,
                mutation_fencing_token = ?, version = version + 1
          WHERE attempt_id = ? AND version = ? AND state_kind = 'ready'`,
        [
          candidate.cleanupRequestedAt,
          candidate.fencingToken,
          candidate.attemptId,
          candidate.expectedVersion,
        ],
      );
      return requireWorkspaceByAttempt(transaction, candidate.attemptId);
    }).catch((error: unknown) => {
      throw normalizeWorkspaceError(error);
    });
  }

  markCleaned(input: WorkspaceCleanedInput): Promise<WorkspaceReceipt> {
    const candidate = validateCleanedInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const existing = requireWorkspaceByAttempt(transaction, candidate.attemptId);
      assertMutationLeaseHeld(
        transaction,
        existing.repositoryId,
        candidate.ownerId,
        candidate.fencingToken,
        candidate.observedAt,
      );
      assertMutationFence(existing, candidate.fencingToken);
      if (existing.state === "cleaned") {
        if (existing.cleanedAt === candidate.cleanedAt) {
          return existing;
        }
        assertExpectedVersion(existing, candidate.expectedVersion);
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "cleaned workspace replay does not match the committed receipt",
        );
      }
      assertExpectedVersion(existing, candidate.expectedVersion);
      if (existing.state !== "cleanup_pending") {
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "workspace can only become cleaned from cleanup_pending",
        );
      }
      if (
        candidate.cleanedAt <
        requireTimestamp(existing.cleanupRequestedAt, "cleanup_requested_at_ms")
      ) {
        throw new WorkspaceRegistryError(
          "invalid_input",
          "workspace cleaned timestamp predates cleanup request",
        );
      }
      transaction.run(
        `UPDATE workspace_bindings
            SET state_kind = 'cleaned', cleaned_at_ms = ?,
                mutation_fencing_token = ?, version = version + 1
          WHERE attempt_id = ? AND version = ? AND state_kind = 'cleanup_pending'`,
        [
          candidate.cleanedAt,
          candidate.fencingToken,
          candidate.attemptId,
          candidate.expectedVersion,
        ],
      );
      return requireWorkspaceByAttempt(transaction, candidate.attemptId);
    }).catch((error: unknown) => {
      throw normalizeWorkspaceError(error);
    });
  }

  markFailed(input: WorkspaceFailedInput): Promise<WorkspaceReceipt> {
    const candidate = validateFailedInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const existing = requireWorkspaceByAttempt(transaction, candidate.attemptId);
      assertMutationLeaseHeld(
        transaction,
        existing.repositoryId,
        candidate.ownerId,
        candidate.fencingToken,
        candidate.observedAt,
      );
      assertMutationFence(existing, candidate.fencingToken);
      if (existing.state === "failed") {
        if (existing.failureCode === candidate.failureCode) {
          return existing;
        }
        assertExpectedVersion(existing, candidate.expectedVersion);
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "failed workspace replay does not match the committed receipt",
        );
      }
      assertExpectedVersion(existing, candidate.expectedVersion);
      if (!isFailureSource(existing.state)) {
        throw new WorkspaceRegistryError(
          "invalid_transition",
          "workspace cannot fail after cleanup",
        );
      }
      transaction.run(
        `UPDATE workspace_bindings
            SET state_kind = 'failed', failure_code = ?,
                mutation_fencing_token = ?, version = version + 1
          WHERE attempt_id = ? AND version = ? AND state_kind IN ('creating', 'ready', 'cleanup_pending')`,
        [
          candidate.failureCode,
          candidate.fencingToken,
          candidate.attemptId,
          candidate.expectedVersion,
        ],
      );
      return requireWorkspaceByAttempt(transaction, candidate.attemptId);
    }).catch((error: unknown) => {
      throw normalizeWorkspaceError(error);
    });
  }

  get(attemptIdValue: AttemptId): WorkspaceReceipt {
    const parsedAttemptId = parseAttemptId(attemptIdValue, "attempt ID");
    try {
      const receipt = this.#database.read((reader) =>
        readWorkspaceByAttempt(reader, parsedAttemptId),
      );
      if (receipt === undefined) {
        throw new WorkspaceRegistryError("not_found", "workspace receipt does not exist");
      }
      return receipt;
    } catch (error: unknown) {
      throw normalizeWorkspaceError(error);
    }
  }

  listRecoverable(): readonly WorkspaceReceipt[] {
    try {
      return this.#database.read((reader) =>
        Object.freeze(
          reader
            .all(
              `SELECT attempt_id, node_id, tree_id, repository_id, host_id,
                      workspace_path, source_path, branch_name, base_commit, head_commit,
                      state_kind, created_at_ms, ready_at_ms, cleanup_requested_at_ms,
                      cleaned_at_ms, failure_code, version, mutation_fencing_token
                 FROM workspace_bindings
                WHERE state_kind IN ('creating', 'cleanup_pending')
                ORDER BY created_at_ms, attempt_id`,
            )
            .map(toWorkspaceReceipt),
        ),
      );
    } catch (error: unknown) {
      throw normalizeWorkspaceError(error);
    }
  }
}

export function createSqliteWorkspaceRegistry(
  options: CreateSqliteWorkspaceRegistryOptions,
): SqliteWorkspaceRegistry {
  return new SqliteWorkspaceRegistry(options);
}

export type GitMutationLeaseAcquireInput = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  acquiredAt: Timestamp;
  leaseDurationMs: number;
}>;

export type GitMutationLeaseReleaseInput = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  fencingToken: bigint;
  releasedAt: Timestamp;
}>;
export type GitMutationLeaseRenewInput = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  fencingToken: bigint;
  renewedAt: Timestamp;
  leaseDurationMs: number;
}>;

export type GitMutationLeaseAssertHeldInput = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

export type GitMutationLease = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  fencingToken: bigint;
  acquiredAt: Timestamp;
  renewedAt: Timestamp;
  expiresAt: Timestamp;
  releasedAt: Timestamp | undefined;
}>;

export interface GitMutationLeaseStore {
  acquire(input: GitMutationLeaseAcquireInput): Promise<GitMutationLease>;
  renew(input: GitMutationLeaseRenewInput): Promise<GitMutationLease>;
  assertHeld(input: GitMutationLeaseAssertHeldInput): Promise<void>;
  release(input: GitMutationLeaseReleaseInput): Promise<void>;
}

export type GitMutationLeaseErrorCode =
  "invalid_input" | "not_found" | "unavailable" | "stale_lease" | "arithmetic_overflow" | "corrupt";

export class GitMutationLeaseError extends Error {
  readonly code: GitMutationLeaseErrorCode;

  constructor(code: GitMutationLeaseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitMutationLeaseError";
    this.code = code;
  }
}

export type CreateSqliteGitMutationLeaseStoreOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

const MAX_FENCING_TOKEN = BigInt(Number.MAX_SAFE_INTEGER);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class SqliteGitMutationLeaseStore implements GitMutationLeaseStore {
  readonly #database: ManagedSqliteDatabase;

  constructor(options: CreateSqliteGitMutationLeaseStoreOptions) {
    this.#database = options.database;
  }

  acquire(input: GitMutationLeaseAcquireInput): Promise<GitMutationLease> {
    const candidate = validateLeaseAcquireInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      requireRepository(transaction, candidate.repositoryId);
      const existingRow = transaction.get(
        `SELECT repository_id, owner_id, fencing_token, state_kind,
                acquired_at_ms, renewed_at_ms, expires_at_ms, released_at_ms
           FROM git_mutation_leases
          WHERE repository_id = ?`,
        [candidate.repositoryId],
      );
      if (existingRow === undefined) {
        transaction.run(
          `INSERT INTO git_mutation_leases (
             repository_id, owner_id, fencing_token, state_kind,
             acquired_at_ms, renewed_at_ms, expires_at_ms, released_at_ms
           ) VALUES (?, ?, 1, 'active', ?, ?, ?, NULL)`,
          [
            candidate.repositoryId,
            candidate.ownerId,
            candidate.acquiredAt,
            candidate.acquiredAt,
            candidate.expiresAt,
          ],
        );
        return requireLease(transaction, candidate.repositoryId);
      }
      const existing = toLease(existingRow);
      const isActive =
        existing.releasedAt === undefined && existing.expiresAt > candidate.acquiredAt;
      if (isActive) {
        throw new GitMutationLeaseError(
          "unavailable",
          "the repository already has an active Git mutation lease",
        );
      }
      if (candidate.acquiredAt < existing.acquiredAt) {
        throw new GitMutationLeaseError(
          "invalid_input",
          "Git mutation lease acquisition timestamp regresses",
        );
      }
      if (existing.releasedAt !== undefined && candidate.acquiredAt < existing.releasedAt) {
        throw new GitMutationLeaseError(
          "invalid_input",
          "Git mutation lease acquisition predates release",
        );
      }
      if (existing.fencingToken >= MAX_FENCING_TOKEN) {
        throw new GitMutationLeaseError(
          "arithmetic_overflow",
          "Git mutation lease fencing token cannot be incremented safely",
        );
      }
      const nextToken = existing.fencingToken + 1n;
      const updated = transaction.run(
        `UPDATE git_mutation_leases
            SET owner_id = ?, fencing_token = ?, state_kind = 'active',
                acquired_at_ms = ?, renewed_at_ms = ?, expires_at_ms = ?, released_at_ms = NULL
          WHERE repository_id = ? AND fencing_token = ?`,
        [
          candidate.ownerId,
          nextToken,
          candidate.acquiredAt,
          candidate.acquiredAt,
          candidate.expiresAt,
          candidate.repositoryId,
          existing.fencingToken,
        ],
      );
      if (changes(updated.changes) !== 1n) {
        throw new GitMutationLeaseError(
          "stale_lease",
          "Git mutation lease changed during acquisition",
        );
      }
      return requireLease(transaction, candidate.repositoryId);
    }).catch((error: unknown) => {
      throw normalizeLeaseError(error);
    });
  }

  renew(input: GitMutationLeaseRenewInput): Promise<GitMutationLease> {
    const candidate = validateLeaseRenewInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const row = transaction.get(
        `SELECT repository_id, owner_id, fencing_token, state_kind,
                acquired_at_ms, renewed_at_ms, expires_at_ms, released_at_ms
           FROM git_mutation_leases
          WHERE repository_id = ?`,
        [candidate.repositoryId],
      );
      if (row === undefined) {
        throw new GitMutationLeaseError("not_found", "Git mutation lease does not exist");
      }
      const existing = toLease(row);
      const sameReplay =
        existing.ownerId === candidate.ownerId &&
        existing.fencingToken === candidate.fencingToken &&
        existing.renewedAt === candidate.renewedAt &&
        existing.expiresAt === candidate.expiresAt &&
        existing.releasedAt === undefined;
      if (sameReplay) {
        return existing;
      }
      if (
        existing.ownerId !== candidate.ownerId ||
        existing.fencingToken !== candidate.fencingToken ||
        existing.releasedAt !== undefined ||
        existing.expiresAt <= candidate.renewedAt
      ) {
        throw new GitMutationLeaseError("stale_lease", "Git mutation lease renewal is stale");
      }
      if (candidate.renewedAt <= existing.renewedAt) {
        throw new GitMutationLeaseError(
          "stale_lease",
          "Git mutation lease renewal timestamp is not monotonic",
        );
      }
      const updated = transaction.run(
        `UPDATE git_mutation_leases
            SET renewed_at_ms = ?, expires_at_ms = ?
          WHERE repository_id = ? AND owner_id = ? AND fencing_token = ?
            AND state_kind = 'active' AND released_at_ms IS NULL
            AND renewed_at_ms = ?`,
        [
          candidate.renewedAt,
          candidate.expiresAt,
          candidate.repositoryId,
          candidate.ownerId,
          candidate.fencingToken,
          existing.renewedAt,
        ],
      );
      if (changes(updated.changes) !== 1n) {
        throw new GitMutationLeaseError("stale_lease", "Git mutation lease changed during renewal");
      }
      return requireLease(transaction, candidate.repositoryId);
    }).catch((error: unknown) => {
      throw normalizeLeaseError(error);
    });
  }

  assertHeld(input: GitMutationLeaseAssertHeldInput): Promise<void> {
    const candidate = validateLeaseAssertHeldInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      assertMutationLeaseHeld(
        transaction,
        candidate.repositoryId,
        candidate.ownerId,
        candidate.fencingToken,
        candidate.observedAt,
      );
    }).catch((error: unknown) => {
      throw normalizeLeaseError(error);
    });
  }

  release(input: GitMutationLeaseReleaseInput): Promise<void> {
    const candidate = validateLeaseReleaseInput(input);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const row = transaction.get(
        `SELECT repository_id, owner_id, fencing_token, state_kind,
                acquired_at_ms, renewed_at_ms, expires_at_ms, released_at_ms
           FROM git_mutation_leases
          WHERE repository_id = ?`,
        [candidate.repositoryId],
      );
      if (row === undefined) {
        throw new GitMutationLeaseError("not_found", "Git mutation lease does not exist");
      }
      const existing = toLease(row);
      if (
        existing.ownerId !== candidate.ownerId ||
        existing.fencingToken !== candidate.fencingToken ||
        existing.releasedAt !== undefined ||
        existing.expiresAt < candidate.releasedAt
      ) {
        throw new GitMutationLeaseError("stale_lease", "Git mutation lease release is stale");
      }
      if (candidate.releasedAt < existing.renewedAt) {
        throw new GitMutationLeaseError(
          "invalid_input",
          "Git mutation lease release timestamp predates renewal",
        );
      }
      const updated = transaction.run(
        `UPDATE git_mutation_leases
            SET state_kind = 'released', released_at_ms = ?
          WHERE repository_id = ? AND owner_id = ? AND fencing_token = ?
            AND state_kind = 'active' AND released_at_ms IS NULL`,
        [candidate.releasedAt, candidate.repositoryId, candidate.ownerId, candidate.fencingToken],
      );
      if (changes(updated.changes) !== 1n) {
        throw new GitMutationLeaseError("stale_lease", "Git mutation lease release is stale");
      }
    }).catch((error: unknown) => {
      throw normalizeLeaseError(error);
    });
  }
}

export function createSqliteGitMutationLeaseStore(
  options: CreateSqliteGitMutationLeaseStoreOptions,
): SqliteGitMutationLeaseStore {
  return new SqliteGitMutationLeaseStore(options);
}

type ValidatedBeginInput = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  hostId: HostId;
  repositoryId: RepositoryId;
  workspacePath: string;
  sourcePath: string;
  branchName: string;
  baseCommit: GitSha;
  createdAt: Timestamp;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
  expectedVersion: number | undefined;
}>;

type ValidatedReadyInput = Readonly<{
  attemptId: AttemptId;
  expectedVersion: number;
  headCommit: GitSha;
  readyAt: Timestamp;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

type ValidatedCleanupInput = Readonly<{
  attemptId: AttemptId;
  expectedVersion: number;
  cleanupRequestedAt: Timestamp;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

type ValidatedCleanedInput = Readonly<{
  attemptId: AttemptId;
  expectedVersion: number;
  cleanedAt: Timestamp;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

type ValidatedFailedInput = Readonly<{
  attemptId: AttemptId;
  expectedVersion: number;
  failureCode: string;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;
type ValidatedLeaseAcquireInput = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  acquiredAt: Timestamp;
  expiresAt: Timestamp;
}>;

type ValidatedLeaseRenewInput = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  fencingToken: bigint;
  renewedAt: Timestamp;
  expiresAt: Timestamp;
}>;

type ValidatedLeaseAssertHeldInput = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  fencingToken: bigint;
  observedAt: Timestamp;
}>;

type ValidatedLeaseReleaseInput = Readonly<{
  repositoryId: RepositoryId;
  ownerId: string;
  fencingToken: bigint;
  releasedAt: Timestamp;
}>;

function validateBeginInput(input: WorkspaceBeginInput): ValidatedBeginInput {
  const expectedVersion =
    input.expectedVersion === undefined
      ? undefined
      : requireVersion(input.expectedVersion, "workspace expected version");
  return Object.freeze({
    attemptId: parseAttemptId(input.attemptId, "attempt ID"),
    nodeId: parseNodeId(input.nodeId, "node ID"),
    treeId: parseTreeId(input.treeId, "tree ID"),
    hostId: parseHostId(input.hostId, "host ID"),
    repositoryId: parseRepositoryId(input.repositoryId, "repository ID"),
    workspacePath: requireText(input.workspacePath, "workspace path"),
    sourcePath: requireText(input.sourcePath, "source path"),
    branchName: requireText(input.branchName, "branch name"),
    baseCommit: parseGitSha(input.baseCommit, "base commit"),
    createdAt: parseTimestamp(input.createdAt, "workspace creation timestamp"),
    ownerId: requireOwnerIdForWorkspace(input.ownerId),
    fencingToken: requireWorkspaceFence(input.fencingToken),
    observedAt: parseTimestamp(input.observedAt, "workspace lease observation timestamp"),
    expectedVersion,
  });
}

function validateReadyInput(input: WorkspaceReadyInput): ValidatedReadyInput {
  return Object.freeze({
    attemptId: parseAttemptId(input.attemptId, "attempt ID"),
    expectedVersion: requireVersion(input.expectedVersion, "workspace expected version"),
    headCommit: parseGitSha(input.headCommit, "head commit"),
    readyAt: parseTimestamp(input.readyAt, "workspace ready timestamp"),
    ownerId: requireOwnerIdForWorkspace(input.ownerId),
    fencingToken: requireWorkspaceFence(input.fencingToken),
    observedAt: parseTimestamp(input.observedAt, "workspace lease observation timestamp"),
  });
}

function validateCleanupInput(input: WorkspaceCleanupInput): ValidatedCleanupInput {
  return Object.freeze({
    attemptId: parseAttemptId(input.attemptId, "attempt ID"),
    expectedVersion: requireVersion(input.expectedVersion, "workspace expected version"),
    cleanupRequestedAt: parseTimestamp(input.cleanupRequestedAt, "workspace cleanup timestamp"),
    ownerId: requireOwnerIdForWorkspace(input.ownerId),
    fencingToken: requireWorkspaceFence(input.fencingToken),
    observedAt: parseTimestamp(input.observedAt, "workspace lease observation timestamp"),
  });
}

function validateCleanedInput(input: WorkspaceCleanedInput): ValidatedCleanedInput {
  return Object.freeze({
    attemptId: parseAttemptId(input.attemptId, "attempt ID"),
    expectedVersion: requireVersion(input.expectedVersion, "workspace expected version"),
    cleanedAt: parseTimestamp(input.cleanedAt, "workspace cleaned timestamp"),
    ownerId: requireOwnerIdForWorkspace(input.ownerId),
    fencingToken: requireWorkspaceFence(input.fencingToken),
    observedAt: parseTimestamp(input.observedAt, "workspace lease observation timestamp"),
  });
}

function validateFailedInput(input: WorkspaceFailedInput): ValidatedFailedInput {
  return Object.freeze({
    attemptId: parseAttemptId(input.attemptId, "attempt ID"),
    expectedVersion: requireVersion(input.expectedVersion, "workspace expected version"),
    failureCode: requireText(input.failureCode, "workspace failure code"),
    ownerId: requireOwnerIdForWorkspace(input.ownerId),
    fencingToken: requireWorkspaceFence(input.fencingToken),
    observedAt: parseTimestamp(input.observedAt, "workspace lease observation timestamp"),
  });
}

function validateLeaseAcquireInput(
  input: GitMutationLeaseAcquireInput,
): ValidatedLeaseAcquireInput {
  const repository = parseLeaseRepositoryId(input.repositoryId, "repository ID");
  const ownerId = requireOwnerId(input.ownerId);
  const acquiredAt = parseLeaseTimestamp(
    input.acquiredAt,
    "Git mutation lease acquisition timestamp",
  );
  return Object.freeze({
    repositoryId: repository,
    ownerId,
    acquiredAt,
    expiresAt: calculateLeaseExpiry(acquiredAt, input.leaseDurationMs),
  });
}

function validateLeaseRenewInput(input: GitMutationLeaseRenewInput): ValidatedLeaseRenewInput {
  const repository = parseLeaseRepositoryId(input.repositoryId, "repository ID");
  const ownerId = requireOwnerId(input.ownerId);
  const fencing = requireLeaseFence(input.fencingToken);
  const renewedAt = parseLeaseTimestamp(input.renewedAt, "Git mutation lease renewal timestamp");
  const expiresAt = calculateLeaseExpiry(renewedAt, input.leaseDurationMs);
  return Object.freeze({
    repositoryId: repository,
    ownerId,
    fencingToken: fencing,
    renewedAt,
    expiresAt,
  });
}

function validateLeaseAssertHeldInput(
  input: GitMutationLeaseAssertHeldInput,
): ValidatedLeaseAssertHeldInput {
  return Object.freeze({
    repositoryId: parseLeaseRepositoryId(input.repositoryId, "repository ID"),
    ownerId: requireOwnerId(input.ownerId),
    fencingToken: requireLeaseFence(input.fencingToken),
    observedAt: parseLeaseTimestamp(input.observedAt, "Git mutation lease observation timestamp"),
  });
}

function validateLeaseReleaseInput(
  input: GitMutationLeaseReleaseInput,
): ValidatedLeaseReleaseInput {
  return Object.freeze({
    repositoryId: parseLeaseRepositoryId(input.repositoryId, "repository ID"),
    ownerId: requireOwnerId(input.ownerId),
    fencingToken: requireLeaseFence(input.fencingToken),
    releasedAt: parseLeaseTimestamp(input.releasedAt, "Git mutation lease release timestamp"),
  });
}

function assertMutationLeaseHeld(
  transaction: SqliteTransaction,
  repository: RepositoryId,
  ownerId: string,
  fence: bigint,
  observedAt: Timestamp,
): void {
  const row = transaction.get(
    `SELECT repository_id, owner_id, fencing_token, state_kind,
            acquired_at_ms, renewed_at_ms, expires_at_ms, released_at_ms
       FROM git_mutation_leases
      WHERE repository_id = ?`,
    [repository],
  );
  if (row === undefined) {
    throw new GitMutationLeaseError("not_found", "Git mutation lease does not exist");
  }
  const lease = toLease(row);
  if (
    lease.ownerId !== ownerId ||
    lease.fencingToken !== fence ||
    lease.releasedAt !== undefined ||
    observedAt >= lease.expiresAt
  ) {
    throw new GitMutationLeaseError("stale_lease", "Git mutation lease is not held");
  }
  if (observedAt < lease.acquiredAt) {
    throw new GitMutationLeaseError(
      "invalid_input",
      "Git mutation lease observation predates acquisition",
    );
  }
}

function assertMutationFence(existing: WorkspaceReceipt, incomingFence: bigint): void {
  if (incomingFence < existing.mutationFencingToken) {
    throw new WorkspaceRegistryError("stale_lease", "workspace mutation fencing token is stale");
  }
}

function assertWorkspaceOwnership(
  transaction: SqliteTransaction,
  input: ValidatedBeginInput,
): void {
  const row = transaction.get(
    `SELECT a.node_id, a.tree_id, a.repository_id, a.host_id,
            r.host_id AS repository_host_id,
            rr.canonical_root AS registration_root,
            CASE WHEN EXISTS (
              SELECT 1
                FROM workspace_bindings AS parent
               WHERE parent.workspace_path = ?
                 AND parent.repository_id = a.repository_id
                 AND parent.host_id = a.host_id
                 AND parent.state_kind = 'ready'
            ) THEN 1 ELSE 0 END AS ready_source_workspace
       FROM attempts AS a
       LEFT JOIN repositories AS r ON r.id = a.repository_id
       LEFT JOIN repository_registrations AS rr
         ON rr.repository_id = a.repository_id AND rr.host_id = a.host_id
      WHERE a.id = ?`,
    [input.sourcePath, input.attemptId],
  );
  if (row === undefined) {
    throw new WorkspaceRegistryError("not_found", "workspace attempt does not exist");
  }
  const node = requiredText(row, "node_id");
  const tree = requiredText(row, "tree_id");
  const repository = requiredText(row, "repository_id");
  const host = requiredText(row, "host_id");
  const repositoryHost = optionalText(row, "repository_host_id");
  const registrationRoot = optionalText(row, "registration_root");
  const readySourceWorkspace = row["ready_source_workspace"];
  const hasReadySourceWorkspace = readySourceWorkspace === 1 || readySourceWorkspace === 1n;
  const sourceMatchesRegistration =
    registrationRoot !== undefined && registrationRoot === input.sourcePath;
  if (
    repositoryHost === undefined ||
    registrationRoot === undefined ||
    node !== input.nodeId ||
    tree !== input.treeId ||
    repository !== input.repositoryId ||
    host !== input.hostId ||
    repositoryHost !== input.hostId ||
    (!sourceMatchesRegistration && !hasReadySourceWorkspace)
  ) {
    throw new WorkspaceRegistryError(
      "ownership_conflict",
      "workspace ownership does not match the registered attempt and repository",
    );
  }
}

function assertIdentityMatches(existing: WorkspaceReceipt, input: ValidatedBeginInput): void {
  if (
    existing.attemptId !== input.attemptId ||
    existing.nodeId !== input.nodeId ||
    existing.treeId !== input.treeId ||
    existing.hostId !== input.hostId ||
    existing.repositoryId !== input.repositoryId ||
    existing.workspacePath !== input.workspacePath ||
    existing.sourcePath !== input.sourcePath ||
    existing.branchName !== input.branchName ||
    existing.baseCommit !== input.baseCommit ||
    existing.createdAt !== input.createdAt
  ) {
    throw new WorkspaceRegistryError(
      "conflict",
      "workspace begin conflicts with the existing receipt",
    );
  }
}

function assertExpectedVersion(existing: WorkspaceReceipt, expectedVersion: number): void {
  if (existing.version !== expectedVersion) {
    throw new WorkspaceRegistryError(
      "version_conflict",
      `workspace receipt expected version ${String(expectedVersion)} but is ${String(existing.version)}`,
    );
  }
}

function requireWorkspaceByAttempt(reader: SqliteReader, attempt: AttemptId): WorkspaceReceipt {
  const receipt = readWorkspaceByAttempt(reader, attempt);
  if (receipt === undefined) {
    throw new WorkspaceRegistryError("not_found", "workspace receipt does not exist");
  }
  return receipt;
}

function readWorkspaceByAttempt(
  reader: SqliteReader,
  attempt: AttemptId,
): WorkspaceReceipt | undefined {
  const row = reader.get(
    `SELECT attempt_id, node_id, tree_id, repository_id, host_id,
            workspace_path, source_path, branch_name, base_commit, head_commit,
            state_kind, created_at_ms, ready_at_ms, cleanup_requested_at_ms,
            cleaned_at_ms, failure_code, version, mutation_fencing_token
       FROM workspace_bindings
      WHERE attempt_id = ?`,
    [attempt],
  );
  return row === undefined ? undefined : toWorkspaceReceipt(row);
}

function toWorkspaceReceipt(row: SqliteRow): WorkspaceReceipt {
  const state = requiredText(row, "state_kind");
  if (!isWorkspaceState(state)) {
    throw new WorkspaceRegistryError("corrupt", "workspace receipt contains an invalid state");
  }
  const readyAt = optionalTimestamp(row, "ready_at_ms");
  const cleanupRequestedAt = optionalTimestamp(row, "cleanup_requested_at_ms");
  const cleanedAt = optionalTimestamp(row, "cleaned_at_ms");
  const failureCode = optionalText(row, "failure_code");
  const receipt = {
    attemptId: parseReceiptId(row, "attempt_id", attemptId),
    nodeId: parseReceiptId(row, "node_id", taskNodeId),
    treeId: parseReceiptId(row, "tree_id", taskTreeId),
    hostId: parseReceiptId(row, "host_id", hostId),
    repositoryId: parseReceiptId(row, "repository_id", repositoryId),
    workspacePath: requiredText(row, "workspace_path"),
    sourcePath: requiredText(row, "source_path"),
    branchName: requiredText(row, "branch_name"),
    baseCommit: parseReceiptId(row, "base_commit", gitSha),
    headCommit: parseReceiptId(row, "head_commit", gitSha),
    state,
    createdAt: requiredTimestamp(row, "created_at_ms"),
    readyAt,
    cleanupRequestedAt,
    cleanedAt,
    failureCode,
    mutationFencingToken: fencingToken(requiredFence(row, "mutation_fencing_token")),
    version: requiredVersion(row, "version"),
  } satisfies WorkspaceReceipt;
  assertReceiptState(receipt);
  return Object.freeze(receipt);
}

function assertReceiptState(receipt: WorkspaceReceipt): void {
  if (receipt.state === "creating") {
    if (
      receipt.readyAt !== undefined ||
      receipt.cleanupRequestedAt !== undefined ||
      receipt.cleanedAt !== undefined ||
      receipt.failureCode !== undefined
    ) {
      throw new WorkspaceRegistryError("corrupt", "creating workspace receipt has terminal fields");
    }
    return;
  }
  if (receipt.state === "ready") {
    if (
      receipt.readyAt === undefined ||
      receipt.cleanupRequestedAt !== undefined ||
      receipt.cleanedAt !== undefined ||
      receipt.failureCode !== undefined
    ) {
      throw new WorkspaceRegistryError(
        "corrupt",
        "ready workspace receipt fields are inconsistent",
      );
    }
    return;
  }
  if (receipt.state === "cleanup_pending") {
    if (
      receipt.readyAt === undefined ||
      receipt.cleanupRequestedAt === undefined ||
      receipt.cleanedAt !== undefined ||
      receipt.failureCode !== undefined
    ) {
      throw new WorkspaceRegistryError(
        "corrupt",
        "cleanup-pending workspace receipt fields are inconsistent",
      );
    }
    return;
  }
  if (receipt.state === "cleaned") {
    if (
      receipt.readyAt === undefined ||
      receipt.cleanupRequestedAt === undefined ||
      receipt.cleanedAt === undefined ||
      receipt.failureCode !== undefined
    ) {
      throw new WorkspaceRegistryError(
        "corrupt",
        "cleaned workspace receipt fields are inconsistent",
      );
    }
    return;
  }
  if (receipt.cleanedAt !== undefined || receipt.failureCode === undefined) {
    throw new WorkspaceRegistryError("corrupt", "failed workspace receipt fields are inconsistent");
  }
}

function isFailureSource(state: WorkspaceState): boolean {
  return state === "creating" || state === "ready" || state === "cleanup_pending";
}

function isWorkspaceState(value: string): value is WorkspaceState {
  return (
    value === "creating" ||
    value === "ready" ||
    value === "cleanup_pending" ||
    value === "cleaned" ||
    value === "failed"
  );
}

function requireRepository(transaction: SqliteTransaction, repository: RepositoryId): void {
  const row = transaction.get("SELECT id FROM repositories WHERE id = ?", [repository]);
  if (row === undefined) {
    throw new GitMutationLeaseError("not_found", "repository does not exist");
  }
}

function requireLease(transaction: SqliteTransaction, repository: RepositoryId): GitMutationLease {
  const row = transaction.get(
    `SELECT repository_id, owner_id, fencing_token, state_kind,
            acquired_at_ms, renewed_at_ms, expires_at_ms, released_at_ms
       FROM git_mutation_leases
      WHERE repository_id = ?`,
    [repository],
  );
  if (row === undefined) {
    throw new GitMutationLeaseError("corrupt", "Git mutation lease disappeared during transaction");
  }
  return toLease(row);
}

function toLease(row: SqliteRow): GitMutationLease {
  const state = requiredText(row, "state_kind");
  if (state !== "active" && state !== "released") {
    throw new GitMutationLeaseError("corrupt", "Git mutation lease contains an invalid state");
  }
  const releasedAt = optionalTimestamp(row, "released_at_ms");
  if (
    (state === "active" && releasedAt !== undefined) ||
    (state === "released" && releasedAt === undefined)
  ) {
    throw new GitMutationLeaseError(
      "corrupt",
      "Git mutation lease state and release timestamp disagree",
    );
  }
  const lease = {
    repositoryId: parseReceiptId(row, "repository_id", repositoryId),
    ownerId: requireOwnerId(requiredText(row, "owner_id")),
    fencingToken: requiredFence(row, "fencing_token"),
    acquiredAt: requiredTimestamp(row, "acquired_at_ms"),
    renewedAt: requiredTimestamp(row, "renewed_at_ms"),
    expiresAt: requiredTimestamp(row, "expires_at_ms"),
    releasedAt,
  } satisfies GitMutationLease;
  if (
    lease.renewedAt < lease.acquiredAt ||
    lease.expiresAt <= lease.renewedAt ||
    (releasedAt !== undefined && (releasedAt < lease.renewedAt || releasedAt > lease.expiresAt))
  ) {
    throw new GitMutationLeaseError("corrupt", "Git mutation lease timestamps are invalid");
  }
  return Object.freeze(lease);
}

function changes(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function parseAttemptId(value: string, field: string): AttemptId {
  return parseInputValue(value, attemptId, field, WorkspaceRegistryError);
}

function parseNodeId(value: string, field: string): TaskNodeId {
  return parseInputValue(value, taskNodeId, field, WorkspaceRegistryError);
}

function parseTreeId(value: string, field: string): TaskTreeId {
  return parseInputValue(value, taskTreeId, field, WorkspaceRegistryError);
}

function parseHostId(value: string, field: string): HostId {
  return parseInputValue(value, hostId, field, WorkspaceRegistryError);
}

function parseRepositoryId(value: string, field: string): RepositoryId {
  return parseInputValue(value, repositoryId, field, WorkspaceRegistryError);
}

function parseLeaseRepositoryId(value: string, field: string): RepositoryId {
  if (typeof value !== "string") {
    throw new GitMutationLeaseError("invalid_input", `${field} is invalid`);
  }
  try {
    return repositoryId(value);
  } catch (error) {
    throw new GitMutationLeaseError("invalid_input", `${field} is invalid`, { cause: error });
  }
}
function parseGitSha(value: string, field: string): GitSha {
  return parseInputValue(value, gitSha, field, WorkspaceRegistryError);
}

function parseReceiptId<T extends string>(
  row: SqliteRow,
  key: string,
  parser: (value: string) => T,
): T {
  const value = row[key];
  if (typeof value !== "string") {
    throw new WorkspaceRegistryError("corrupt", `workspace receipt ${key} is invalid`);
  }
  try {
    return parser(value);
  } catch (error) {
    throw new WorkspaceRegistryError("corrupt", `workspace receipt ${key} is invalid`, {
      cause: error,
    });
  }
}

function parseInputValue<T extends string>(
  value: string,
  parser: (value: string) => T,
  field: string,
  errorClass: typeof WorkspaceRegistryError,
): T {
  if (typeof value !== "string") {
    throw new errorClass("invalid_input", `${field} is invalid`);
  }
  try {
    return parser(value);
  } catch (error) {
    throw new errorClass("invalid_input", `${field} is invalid`, { cause: error });
  }
}

function parseTimestamp(value: number, field: string): Timestamp {
  try {
    return timestampFromEpochMilliseconds(value);
  } catch (error) {
    throw new WorkspaceRegistryError("invalid_input", `${field} is invalid`, { cause: error });
  }
}

function parseLeaseTimestamp(value: number, field: string): Timestamp {
  try {
    return timestampFromEpochMilliseconds(value);
  } catch (error) {
    throw new GitMutationLeaseError("invalid_input", `${field} is invalid`, { cause: error });
  }
}

function requireVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceRegistryError("invalid_input", `${field} is invalid`);
  }
  return value;
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceRegistryError("invalid_input", `${field} must not be empty`);
  }
  return value;
}

function requireOwnerId(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new GitMutationLeaseError("invalid_input", "Git mutation lease owner ID must be a UUID");
  }
  return value;
}

function requireOwnerIdForWorkspace(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new WorkspaceRegistryError("invalid_input", "workspace mutation owner ID must be a UUID");
  }
  return value;
}

function requireWorkspaceFence(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_FENCING_TOKEN) {
    throw new WorkspaceRegistryError(
      "invalid_input",
      "workspace mutation fencing token is invalid",
    );
  }
  return value;
}

function requireLeaseFence(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_FENCING_TOKEN) {
    throw new GitMutationLeaseError("invalid_input", "Git mutation lease fencing token is invalid");
  }
  return value;
}

function calculateLeaseExpiry(at: Timestamp, durationMs: number): Timestamp {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new GitMutationLeaseError(
      "invalid_input",
      "Git mutation lease duration must be a positive safe integer",
    );
  }
  const expiresAt = at + durationMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new GitMutationLeaseError(
      "arithmetic_overflow",
      "Git mutation lease expiry exceeds the safe timestamp range",
    );
  }
  return timestampFromEpochMilliseconds(expiresAt);
}

function requiredText(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceRegistryError("corrupt", `SQLite row ${key} is invalid`);
  }
  return value;
}

function optionalText(row: SqliteRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceRegistryError("corrupt", `SQLite row ${key} is invalid`);
  }
  return value;
}

function requiredTimestamp(row: SqliteRow, key: string): Timestamp {
  const value = integerValue(row, key);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WorkspaceRegistryError("corrupt", `SQLite row ${key} is outside the safe range`);
  }
  return timestampFromEpochMilliseconds(Number(value));
}

function optionalTimestamp(row: SqliteRow, key: string): Timestamp | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return requiredTimestamp(row, key);
}

function requireTimestamp(value: Timestamp | undefined, field: string): Timestamp {
  if (value === undefined) {
    throw new WorkspaceRegistryError("corrupt", `SQLite row ${field} is missing`);
  }
  return value;
}

function requiredVersion(row: SqliteRow, key: string): number {
  const value = integerValue(row, key);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WorkspaceRegistryError("corrupt", `SQLite row ${key} is outside the safe range`);
  }
  return Number(value);
}

function requiredFence(row: SqliteRow, key: string): bigint {
  const value = integerValue(row, key);
  if (value <= 0n || value > MAX_FENCING_TOKEN) {
    throw new GitMutationLeaseError("corrupt", `SQLite row ${key} is outside the safe range`);
  }
  return value;
}

function integerValue(row: SqliteRow, key: string): bigint {
  const value = row[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new WorkspaceRegistryError("corrupt", `SQLite row ${key} is not an integer`);
}

function normalizeWorkspaceError(error: unknown): WorkspaceRegistryError {
  if (error instanceof WorkspaceRegistryError) return error;
  if (error instanceof GitMutationLeaseError) {
    const code =
      error.code === "invalid_input"
        ? "invalid_input"
        : error.code === "not_found"
          ? "not_found"
          : error.code === "stale_lease"
            ? "stale_lease"
            : "corrupt";
    return new WorkspaceRegistryError(code, error.message, { cause: error });
  }
  return new WorkspaceRegistryError("corrupt", "workspace registry transaction failed", {
    cause: error,
  });
}

function normalizeLeaseError(error: unknown): GitMutationLeaseError {
  if (error instanceof GitMutationLeaseError) return error;
  return new GitMutationLeaseError("corrupt", "Git mutation lease transaction failed", {
    cause: error,
  });
}
