import { randomUUID } from "node:crypto";

import { hostId, timestampFromEpochMilliseconds, type HostId, type Timestamp } from "@minions/core";

import {
  executeManagedSqliteWrite,
  type ManagedSqliteDatabase,
  type SqliteReader,
  type SqliteRow,
} from "./database.js";

export type ExecutionHostKind = "local" | "ssh" | "wsl2";
export type ExecutionHostState = "degraded" | "offline" | "online" | "pending" | "removed";

export type ExecutionHostRecord = Readonly<{
  id: HostId;
  kind: ExecutionHostKind;
  displayName: string;
  state: ExecutionHostState;
  endpoint: string | undefined;
  version: number;
  registeredAt: Timestamp;
  lastSeenAt: Timestamp | undefined;
}>;

export type EnsureLocalHostInput = Readonly<{
  id: HostId;
  displayName: string;
  observedAt: Timestamp;
}>;

export type RegisterSshHostInput = Readonly<{
  id: HostId;
  displayName: string;
  hostname: string;
  port: number;
  username: string;
  knownHostKeyFingerprint: string;
  registeredAt: Timestamp;
}>;

export type ListExecutionHostsInput = Readonly<{
  afterId: HostId | undefined;
  limit: number;
}>;

export interface SupervisorHostRegistry {
  ensureLocalHost(input: EnsureLocalHostInput): Promise<ExecutionHostRecord>;
  registerSsh(input: RegisterSshHostInput): Promise<ExecutionHostRecord>;
  find(id: HostId): ExecutionHostRecord | undefined;
  /**
   * Fetches a host and asserts it is usable: throws `host_not_found` if no such
   * host was ever registered, `host_revoked` if it was registered and later
   * removed. Every future connection-dispatch path MUST call this (or `find` plus
   * an equivalent check) before attempting to reach a host — this is the guard
   * that makes host removal actually deny use, not just relabel a row.
   */
  requireActive(id: HostId): ExecutionHostRecord;
  markOffline(id: HostId, observedAt: Timestamp): Promise<ExecutionHostRecord>;
  /** Soft-removes a host: `state` becomes `"removed"`, permanently. Idempotent. */
  remove(id: HostId, observedAt: Timestamp): Promise<ExecutionHostRecord>;
  list(input: ListExecutionHostsInput): readonly ExecutionHostRecord[];
}

export type CreateSupervisorHostRegistryOptions = Readonly<{
  database: ManagedSqliteDatabase;
}>;

export function createSupervisorHostRegistry(
  options: CreateSupervisorHostRegistryOptions,
): SupervisorHostRegistry {
  return new DefaultSupervisorHostRegistry(options.database);
}

class DefaultSupervisorHostRegistry implements SupervisorHostRegistry {
  readonly #database: ManagedSqliteDatabase;

  constructor(database: ManagedSqliteDatabase) {
    this.#database = database;
  }

  ensureLocalHost(input: EnsureLocalHostInput): Promise<ExecutionHostRecord> {
    validateDisplayName(input.displayName);
    const observedAt = timestampFromEpochMilliseconds(input.observedAt);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const rows = transaction.all(
        `SELECT id, host_kind, display_name, state_kind, endpoint, version,
                registered_at_ms, last_seen_at_ms
           FROM execution_hosts
          WHERE host_kind = 'local' AND state_kind <> 'removed'
          ORDER BY id`,
      );
      if (rows.length > 1) {
        throw new HostRegistryError(
          "registry_corrupt",
          "supervisor registry contains multiple active local hosts",
        );
      }
      const existing = rows[0];
      if (existing === undefined) {
        transaction.run(
          `INSERT INTO execution_hosts (
             id, host_kind, display_name, state_kind, endpoint, version,
             registered_at_ms, last_seen_at_ms, removed_at_ms
           ) VALUES (?, 'local', ?, 'online', NULL, 0, ?, ?, NULL)`,
          [input.id, input.displayName, observedAt, observedAt],
        );
        return readHostById(transaction, input.id);
      }
      const existingHost = toExecutionHost(existing);
      if (observedAt < existingHost.registeredAt) {
        throw new HostRegistryError(
          "invalid_observation",
          "local host observation predates registration",
        );
      }
      transaction.run(
        `UPDATE execution_hosts
            SET display_name = ?, state_kind = 'online', version = version + 1,
                last_seen_at_ms = ?
          WHERE id = ? AND host_kind = 'local' AND state_kind <> 'removed'`,
        [input.displayName, observedAt, existingHost.id],
      );
      return readHostById(transaction, existingHost.id);
    });
  }

  registerSsh(input: RegisterSshHostInput): Promise<ExecutionHostRecord> {
    validateDisplayName(input.displayName);
    const registeredAt = timestampFromEpochMilliseconds(input.registeredAt);
    const endpoint = `${input.hostname}:${String(input.port)}`;
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      transaction.run(
        `INSERT INTO execution_hosts (
           id, host_kind, display_name, state_kind, endpoint, version,
           registered_at_ms, last_seen_at_ms, removed_at_ms
         ) VALUES (?, 'ssh', ?, 'pending', ?, 0, ?, ?, NULL)`,
        [input.id, input.displayName, endpoint, registeredAt, registeredAt],
      );
      // credential_reference has no client-supplied value yet: SshAdapterOptions
      // authenticates via the host's ambient SSH agent, not an explicit credential
      // submitted through this RPC. Revisit once a vault-backed credential flows here.
      transaction.run(
        `INSERT INTO ssh_profiles (
           id, host_id, host_kind, hostname, port, username, credential_reference,
           host_key_fingerprint, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 'ssh', ?, ?, ?, 'ambient-ssh-agent', ?, ?, ?)`,
        [
          randomUUID(),
          input.id,
          input.hostname,
          input.port,
          input.username,
          input.knownHostKeyFingerprint,
          registeredAt,
          registeredAt,
        ],
      );
      return readHostById(transaction, input.id);
    });
  }

  find(id: HostId): ExecutionHostRecord | undefined {
    return this.#database.read((reader) => findHostById(reader, id));
  }

  requireActive(id: HostId): ExecutionHostRecord {
    const host = this.find(id);
    if (host === undefined) {
      throw new HostRegistryError("host_not_found", "execution host does not exist");
    }
    if (host.state === "removed") {
      throw new HostRegistryError("host_revoked", "execution host has been removed");
    }
    return host;
  }

  markOffline(id: HostId, observedAt: Timestamp): Promise<ExecutionHostRecord> {
    const timestamp = timestampFromEpochMilliseconds(observedAt);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const current = readHostById(transaction, id);
      if (current.kind !== "local" || current.state === "removed") {
        throw new HostRegistryError("host_not_active", "local host is not active");
      }
      if (timestamp < current.registeredAt) {
        throw new HostRegistryError(
          "invalid_observation",
          "local host observation predates registration",
        );
      }
      transaction.run(
        `UPDATE execution_hosts
            SET state_kind = 'offline', version = version + 1, last_seen_at_ms = ?
          WHERE id = ? AND host_kind = 'local' AND state_kind <> 'removed'`,
        [timestamp, id],
      );
      return readHostById(transaction, id);
    });
  }

  remove(id: HostId, observedAt: Timestamp): Promise<ExecutionHostRecord> {
    const timestamp = timestampFromEpochMilliseconds(observedAt);
    return executeManagedSqliteWrite(this.#database, (transaction) => {
      const current = readHostById(transaction, id);
      if (current.state === "removed") {
        // Idempotent: a second removal is a no-op, preserving the original
        // removed_at_ms rather than advancing it on every repeated call.
        return current;
      }
      transaction.run(
        `UPDATE execution_hosts
            SET state_kind = 'removed', version = version + 1, removed_at_ms = ?
          WHERE id = ?`,
        [timestamp, id],
      );
      return readHostById(transaction, id);
    });
  }

  list(input: ListExecutionHostsInput): readonly ExecutionHostRecord[] {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 101) {
      throw new RangeError("host list limit must be between 1 and 101");
    }
    return this.#database.read((reader) => {
      const rows =
        input.afterId === undefined
          ? reader.all(
              `SELECT id, host_kind, display_name, state_kind, endpoint, version,
                      registered_at_ms, last_seen_at_ms
                 FROM execution_hosts
                ORDER BY id
                LIMIT ?`,
              [input.limit],
            )
          : reader.all(
              `SELECT id, host_kind, display_name, state_kind, endpoint, version,
                      registered_at_ms, last_seen_at_ms
                 FROM execution_hosts
                WHERE id > ?
                ORDER BY id
                LIMIT ?`,
              [input.afterId, input.limit],
            );
      return Object.freeze(rows.map(toExecutionHost));
    });
  }
}

export type HostRegistryErrorCode =
  | "host_not_active"
  | "host_not_found"
  | "host_revoked"
  | "invalid_observation"
  | "registry_corrupt";

export class HostRegistryError extends Error {
  readonly code: HostRegistryErrorCode;

  constructor(code: HostRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostRegistryError";
    this.code = code;
  }
}

function findHostById(reader: SqliteReader, id: HostId): ExecutionHostRecord | undefined {
  const row = reader.get(
    `SELECT id, host_kind, display_name, state_kind, endpoint, version,
            registered_at_ms, last_seen_at_ms
       FROM execution_hosts
      WHERE id = ?`,
    [id],
  );
  return row === undefined ? undefined : toExecutionHost(row);
}

function readHostById(reader: SqliteReader, id: HostId): ExecutionHostRecord {
  const host = findHostById(reader, id);
  if (host === undefined) {
    throw new HostRegistryError("host_not_found", "execution host does not exist");
  }
  return host;
}

function toExecutionHost(row: SqliteRow): ExecutionHostRecord {
  return Object.freeze({
    id: hostId(requiredString(row, "id")),
    kind: executionHostKind(requiredString(row, "host_kind")),
    displayName: requiredString(row, "display_name"),
    state: executionHostState(requiredString(row, "state_kind")),
    endpoint: optionalString(row, "endpoint"),
    version: safeNumber(row, "version"),
    registeredAt: timestampFromEpochMilliseconds(safeNumber(row, "registered_at_ms")),
    lastSeenAt: optionalTimestamp(row, "last_seen_at_ms"),
  });
}

function executionHostKind(value: string): ExecutionHostKind {
  if (value === "local" || value === "ssh" || value === "wsl2") {
    return value;
  }
  throw new HostRegistryError("registry_corrupt", "execution host kind is invalid");
}

function executionHostState(value: string): ExecutionHostState {
  if (
    value === "pending" ||
    value === "online" ||
    value === "offline" ||
    value === "degraded" ||
    value === "removed"
  ) {
    return value;
  }
  throw new HostRegistryError("registry_corrupt", "execution host state is invalid");
}

function validateDisplayName(value: string): void {
  if (value.trim().length === 0 || value.length > 128) {
    throw new HostRegistryError(
      "invalid_observation",
      "local host display name must contain 1 to 128 characters",
    );
  }
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HostRegistryError("registry_corrupt", `${key} is not a non-empty string`);
  }
  return value;
}

function optionalString(row: SqliteRow, key: string): string | undefined {
  const value = row[key];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new HostRegistryError("registry_corrupt", `${key} is not null or a non-empty string`);
  }
  return value;
}

function safeNumber(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "bigint" || value < 0n) {
    throw new HostRegistryError("registry_corrupt", `${key} is not a non-negative integer`);
  }
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new HostRegistryError("registry_corrupt", `${key} exceeds the safe integer range`);
  }
  return converted;
}

function optionalTimestamp(row: SqliteRow, key: string): Timestamp | undefined {
  if (row[key] === null) {
    return undefined;
  }
  return timestampFromEpochMilliseconds(safeNumber(row, key));
}
