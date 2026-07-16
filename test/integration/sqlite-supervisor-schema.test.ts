import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  openSupervisorDatabase,
  SqliteDatabaseError,
  type SqliteDatabaseErrorCode,
  type SqliteTransaction,
} from "@minions/adapters";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase, type TestManagedSqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

const NOW_MS = 1_700_000_000_000;
const CLOCK = new FixedClock(timestampFromEpochMilliseconds(NOW_MS));

const HOST_ID = "018f3a2e-4a20-7b90-8123-abcdef123456";
const SSH_PROFILE_ID = "018f3a2e-4a20-7b90-8123-abcdef123457";
const DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef123458";
const SESSION_ID = "018f3a2e-4a20-7b90-8123-abcdef123459";
const MAINTENANCE_SESSION_ID = "018f3a2e-4a20-7b90-8123-abcdef12345a";
const ACTION_ID = "018f3a2e-4a20-7b90-8123-abcdef12345b";
const EVENT_ID = "018f3a2e-4a20-7b90-8123-abcdef12345c";

const INVALID_LOCAL_HOST_ID = "018f3a2e-4a20-7b90-8123-abcdef123461";
const INVALID_SSH_HOST_ID = "018f3a2e-4a20-7b90-8123-abcdef123462";
const INVALID_TOKEN_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef123463";
const INVALID_REVOKED_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef123464";
const INVALID_HOST_PROFILE_ID = "018f3a2e-4a20-7b90-8123-abcdef123465";
const INVALID_SESSION_ACTION_ID = "018f3a2e-4a20-7b90-8123-abcdef123466";
const INVALID_TERMINAL_ACTION_ID = "018f3a2e-4a20-7b90-8123-abcdef123467";
const INVALID_EVIDENCE_ACTION_ID = "018f3a2e-4a20-7b90-8123-abcdef123468";
const MISSING_HOST_ID = "018f3a2e-4a20-7b90-8123-abcdef123469";
const MISSING_SESSION_ID = "018f3a2e-4a20-7b90-8123-abcdef12346a";

const ROLLBACK_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef12346b";
const AFTER_FAILURE_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef12346c";
const ASYNC_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef12346d";
const AFTER_ASYNC_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef12346e";
const FIRST_EVENT_ID = "018f3a2e-4a20-7b90-8123-abcdef12346f";
const SECOND_EVENT_ID = "018f3a2e-4a20-7b90-8123-abcdef123470";
const READ_ONLY_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef123471";
const THENABLE_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef123472";
const ADMITTED_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef123473";
const PENDING_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef123474";
const TERMINAL_HOST_ID = "018f3a2e-4a20-7b90-8123-abcdef123480";
const TERMINAL_DEVICE_ID = "018f3a2e-4a20-7b90-8123-abcdef123481";
const TERMINAL_ACTION_ID = "018f3a2e-4a20-7b90-8123-abcdef123482";
const LOCAL_PROFILE_HOST_ID = "018f3a2e-4a20-7b90-8123-abcdef123483";
const LOCAL_PROFILE_ID = "018f3a2e-4a20-7b90-8123-abcdef123484";
const WSL_PROFILE_HOST_ID = "018f3a2e-4a20-7b90-8123-abcdef123485";
const WSL_PROFILE_ID = "018f3a2e-4a20-7b90-8123-abcdef123486";

async function withTemporarySupervisorDatabase(
  operation: (
    database: TestManagedSqliteDatabase,
    temporary: TemporarySqliteDatabase,
  ) => Promise<void>,
): Promise<void> {
  const temporary = await TemporarySqliteDatabase.create("supervisor", CLOCK);
  try {
    expect(existsSync(temporary.path)).toBe(true);
    await operation(temporary.database, temporary);
  } finally {
    await temporary.dispose();
    expect(existsSync(temporary.directory)).toBe(false);
    expect(existsSync(temporary.path)).toBe(false);
    expect(existsSync(temporary.backupPath)).toBe(false);
  }
}

async function expectAsyncSqliteError(
  promise: Promise<unknown>,
  code: SqliteDatabaseErrorCode,
): Promise<SqliteDatabaseError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert(error instanceof SqliteDatabaseError);
  expect(error.code).toBe(code);
  return error;
}

function expectNoRow(database: TestManagedSqliteDatabase, table: string, id: string): void {
  expect(database.read((reader) => reader.get(`SELECT id FROM ${table} WHERE id = ?`, [id]))).toBe(
    undefined,
  );
}

function runtimeOwnKeys(value: object): readonly string[] {
  return Reflect.ownKeys(value).map(String).sort();
}

function runtimePrototypeKeys(value: object): readonly string[] {
  const prototype = Reflect.getPrototypeOf(value);
  assert(prototype !== null);
  return runtimeOwnKeys(prototype);
}

function insertPairedDevice(
  transaction: SqliteTransaction,
  id: string,
  displayName = "device",
): void {
  transaction.run(
    "INSERT INTO paired_devices (id, display_name, public_key, state_kind, paired_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
    [id, displayName, `${id}-public-key`, "active", NOW_MS, null],
  );
}

async function expectTransactionFailure(
  database: TestManagedSqliteDatabase,
  operation: (transaction: SqliteTransaction) => unknown,
): Promise<void> {
  await expectAsyncSqliteError(database.write(operation), "transaction_failed");
}

async function expectSshProfileHostKindFailure(
  database: TestManagedSqliteDatabase,
  hostId: string,
  profileId: string,
  hostKind: "local" | "wsl2",
  endpoint: string | null,
): Promise<void> {
  await expectTransactionFailure(database, (transaction) => {
    transaction.run(
      "INSERT INTO execution_hosts (id, host_kind, display_name, state_kind, endpoint, version, registered_at_ms, last_seen_at_ms, removed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [hostId, hostKind, `${hostKind}-host`, "online", endpoint, 0, NOW_MS, NOW_MS, null],
    );
    transaction.run(
      "INSERT INTO ssh_profiles (id, host_id, host_kind, hostname, port, username, credential_reference, host_key_fingerprint, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        profileId,
        hostId,
        "ssh",
        `${hostKind}.example`,
        22,
        "runner",
        `credential/${hostKind}`,
        `SHA256:${hostKind}`,
        NOW_MS,
        NOW_MS,
      ],
    );
  });
  expectNoRow(database, "execution_hosts", hostId);
  expectNoRow(database, "ssh_profiles", profileId);
}

async function insertValidSupervisorState(database: TestManagedSqliteDatabase): Promise<void> {
  await database.write((transaction) => {
    transaction.run(
      "INSERT INTO execution_hosts (id, host_kind, display_name, state_kind, endpoint, version, registered_at_ms, last_seen_at_ms, removed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        HOST_ID,
        "ssh",
        "build-host",
        "online",
        "ssh://build.example",
        3,
        NOW_MS,
        NOW_MS + 1_000,
        null,
      ],
    );
    transaction.run(
      "INSERT INTO ssh_profiles (id, host_id, host_kind, hostname, port, username, credential_reference, host_key_fingerprint, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        SSH_PROFILE_ID,
        HOST_ID,
        "ssh",
        "build.example",
        22,
        "runner",
        "credential/build",
        "SHA256:host-key",
        NOW_MS + 100,
        NOW_MS + 200,
      ],
    );
    transaction.run(
      "INSERT INTO host_projection_cache (host_id, last_sequence, minimum_available_sequence, snapshot_type, snapshot_payload, refreshed_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      [HOST_ID, 5, 2, "execution_host", Uint8Array.of(1, 2, 3), NOW_MS + 300],
    );
    insertPairedDevice(transaction, DEVICE_ID, "operator-device");
    transaction.run(
      "INSERT INTO device_sessions (id, device_id, token_digest, csrf_digest, scope_kind, created_at_ms, expires_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        SESSION_ID,
        DEVICE_ID,
        "a".repeat(64),
        "b".repeat(64),
        "control",
        NOW_MS + 400,
        NOW_MS + 3_600_400,
        null,
      ],
    );
    transaction.run(
      "INSERT INTO maintenance_sessions (id, owner_session_id, state_kind, reason, policy_digest, requested_at_ms, authorized_at_ms, expires_at_ms, closed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        MAINTENANCE_SESSION_ID,
        SESSION_ID,
        "active",
        "routine maintenance",
        "c".repeat(64),
        NOW_MS + 500,
        NOW_MS + 600,
        NOW_MS + 3_600_500,
        null,
      ],
    );
    transaction.run(
      "INSERT INTO maintenance_actions (id, maintenance_session_id, host_id, action_type, request_payload, state_kind, evidence_type, evidence_payload, created_at_ms, finished_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        ACTION_ID,
        MAINTENANCE_SESSION_ID,
        HOST_ID,
        "restart",
        Uint8Array.of(4, 5),
        "succeeded",
        "stdout",
        Uint8Array.of(6, 7),
        NOW_MS + 700,
        NOW_MS + 800,
      ],
    );
    transaction.run(
      "INSERT INTO maintenance_events (event_id, maintenance_session_id, action_id, event_type, event_payload, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      [
        EVENT_ID,
        MAINTENANCE_SESSION_ID,
        ACTION_ID,
        "action_succeeded",
        Uint8Array.of(8, 9),
        NOW_MS + 800,
      ],
    );
  });
}

describe("supervisor SQLite schema integration", () => {
  it("keeps raw SQLite connections out of public runtime objects", async () => {
    await withTemporarySupervisorDatabase(async (database) => {
      expect(runtimeOwnKeys(database)).toEqual(["migration", "path"]);
      expect(runtimePrototypeKeys(database)).toEqual([
        "close",
        "constructor",
        "read",
        "snapshot",
        "write",
      ]);

      database.read((reader) => {
        expect(runtimeOwnKeys(reader)).toEqual([]);
        expect(runtimePrototypeKeys(reader)).toEqual(["all", "constructor", "get"]);
      });
      await database.write((transaction) => {
        expect(runtimeOwnKeys(transaction)).toEqual([]);
        expect(runtimePrototypeKeys(transaction)).toEqual([
          "all",
          "constructor",
          "get",
          "run",
          "withCurrentStateWrites",
        ]);
      });
    });
  });

  it("persists and reads valid supervisor current-state rows", async () => {
    await withTemporarySupervisorDatabase(async (database) => {
      await insertValidSupervisorState(database);

      const rows = database.read((reader) => ({
        hosts: reader.all(
          "SELECT id, host_kind, display_name, state_kind, endpoint, version, registered_at_ms, last_seen_at_ms, removed_at_ms FROM execution_hosts WHERE id = ?",
          [HOST_ID],
        ),
        sshProfile: reader.get(
          "SELECT id, host_id, hostname, port, username, credential_reference, host_key_fingerprint, created_at_ms, updated_at_ms FROM ssh_profiles WHERE id = ?",
          [SSH_PROFILE_ID],
        ),
        projection: reader.get(
          "SELECT host_id, last_sequence, minimum_available_sequence, snapshot_type, length(snapshot_payload) AS payload_length, refreshed_at_ms FROM host_projection_cache WHERE host_id = ?",
          [HOST_ID],
        ),
        device: reader.get(
          "SELECT id, display_name, public_key, state_kind, paired_at_ms, revoked_at_ms FROM paired_devices WHERE id = ?",
          [DEVICE_ID],
        ),
        session: reader.get(
          "SELECT id, device_id, substr(token_digest, 1, 8) AS token_prefix, substr(csrf_digest, 1, 8) AS csrf_prefix, scope_kind, created_at_ms, expires_at_ms, revoked_at_ms FROM device_sessions WHERE id = ?",
          [SESSION_ID],
        ),
        maintenanceSession: reader.get(
          "SELECT id, owner_session_id, state_kind, reason, substr(policy_digest, 1, 8) AS policy_prefix, requested_at_ms, authorized_at_ms, expires_at_ms, closed_at_ms FROM maintenance_sessions WHERE id = ?",
          [MAINTENANCE_SESSION_ID],
        ),
        action: reader.get(
          "SELECT id, maintenance_session_id, host_id, action_type, length(request_payload) AS request_length, state_kind, evidence_type, length(evidence_payload) AS evidence_length, created_at_ms, finished_at_ms FROM maintenance_actions WHERE id = ?",
          [ACTION_ID],
        ),
        event: reader.get(
          "SELECT sequence, event_id, maintenance_session_id, action_id, event_type, length(event_payload) AS payload_length, occurred_at_ms FROM maintenance_events WHERE event_id = ?",
          [EVENT_ID],
        ),
      }));

      expect(rows.hosts).toEqual([
        {
          id: HOST_ID,
          host_kind: "ssh",
          display_name: "build-host",
          state_kind: "online",
          endpoint: "ssh://build.example",
          version: 3n,
          registered_at_ms: BigInt(NOW_MS),
          last_seen_at_ms: BigInt(NOW_MS + 1_000),
          removed_at_ms: null,
        },
      ]);
      expect(rows.sshProfile).toEqual({
        id: SSH_PROFILE_ID,
        host_id: HOST_ID,
        hostname: "build.example",
        port: 22n,
        username: "runner",
        credential_reference: "credential/build",
        host_key_fingerprint: "SHA256:host-key",
        created_at_ms: BigInt(NOW_MS + 100),
        updated_at_ms: BigInt(NOW_MS + 200),
      });
      expect(rows.projection).toEqual({
        host_id: HOST_ID,
        last_sequence: 5n,
        minimum_available_sequence: 2n,
        snapshot_type: "execution_host",
        payload_length: 3n,
        refreshed_at_ms: BigInt(NOW_MS + 300),
      });
      expect(rows.device).toEqual({
        id: DEVICE_ID,
        display_name: "operator-device",
        public_key: `${DEVICE_ID}-public-key`,
        state_kind: "active",
        paired_at_ms: BigInt(NOW_MS),
        revoked_at_ms: null,
      });
      expect(rows.session).toEqual({
        id: SESSION_ID,
        device_id: DEVICE_ID,
        token_prefix: "aaaaaaaa",
        csrf_prefix: "bbbbbbbb",
        scope_kind: "control",
        created_at_ms: BigInt(NOW_MS + 400),
        expires_at_ms: BigInt(NOW_MS + 3_600_400),
        revoked_at_ms: null,
      });
      expect(rows.maintenanceSession).toEqual({
        id: MAINTENANCE_SESSION_ID,
        owner_session_id: SESSION_ID,
        state_kind: "active",
        reason: "routine maintenance",
        policy_prefix: "cccccccc",
        requested_at_ms: BigInt(NOW_MS + 500),
        authorized_at_ms: BigInt(NOW_MS + 600),
        expires_at_ms: BigInt(NOW_MS + 3_600_500),
        closed_at_ms: null,
      });
      expect(rows.action).toEqual({
        id: ACTION_ID,
        maintenance_session_id: MAINTENANCE_SESSION_ID,
        host_id: HOST_ID,
        action_type: "restart",
        request_length: 2n,
        state_kind: "succeeded",
        evidence_type: "stdout",
        evidence_length: 2n,
        created_at_ms: BigInt(NOW_MS + 700),
        finished_at_ms: BigInt(NOW_MS + 800),
      });
      expect(rows.event).toEqual({
        sequence: 1n,
        event_id: EVENT_ID,
        maintenance_session_id: MAINTENANCE_SESSION_ID,
        action_id: ACTION_ID,
        event_type: "action_succeeded",
        payload_length: 2n,
        occurred_at_ms: BigInt(NOW_MS + 800),
      });
    });
  });

  it("binds SSH profiles only to SSH execution hosts", async () => {
    await withTemporarySupervisorDatabase(async (database) => {
      await expectSshProfileHostKindFailure(
        database,
        LOCAL_PROFILE_HOST_ID,
        LOCAL_PROFILE_ID,
        "local",
        null,
      );
      await expectSshProfileHostKindFailure(
        database,
        WSL_PROFILE_HOST_ID,
        WSL_PROFILE_ID,
        "wsl2",
        "wsl://Ubuntu",
      );
    });
  });

  it("requires terminal supervisor timestamps", async () => {
    await withTemporarySupervisorDatabase(async (database) => {
      await insertValidSupervisorState(database);

      await expectTransactionFailure(database, (transaction) => {
        transaction.run(
          "INSERT INTO execution_hosts (id, host_kind, display_name, state_kind, endpoint, version, registered_at_ms, last_seen_at_ms, removed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            TERMINAL_HOST_ID,
            "ssh",
            "removed-host",
            "removed",
            "ssh://removed.example",
            0,
            NOW_MS,
            NOW_MS,
            null,
          ],
        );
      });
      await expectTransactionFailure(database, (transaction) => {
        transaction.run(
          "INSERT INTO paired_devices (id, display_name, public_key, state_kind, paired_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
          [
            TERMINAL_DEVICE_ID,
            "revoked-device",
            `${TERMINAL_DEVICE_ID}-public-key`,
            "revoked",
            NOW_MS,
            null,
          ],
        );
      });
      await expectTransactionFailure(database, (transaction) => {
        transaction.run(
          "INSERT INTO maintenance_actions (id, maintenance_session_id, host_id, action_type, request_payload, state_kind, evidence_type, evidence_payload, created_at_ms, finished_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            TERMINAL_ACTION_ID,
            MAINTENANCE_SESSION_ID,
            HOST_ID,
            "terminal-without-finish",
            Uint8Array.of(1),
            "succeeded",
            "stdout",
            Uint8Array.of(2),
            NOW_MS,
            null,
          ],
        );
      });

      expectNoRow(database, "execution_hosts", TERMINAL_HOST_ID);
      expectNoRow(database, "paired_devices", TERMINAL_DEVICE_ID);
      expectNoRow(database, "maintenance_actions", TERMINAL_ACTION_ID);
    });
  });

  it("keeps maintenance event bytes immutable", async () => {
    await withTemporarySupervisorDatabase(async (database) => {
      await insertValidSupervisorState(database);

      await expectTransactionFailure(database, (transaction) => {
        transaction.run(
          "UPDATE maintenance_events SET event_type = ?, event_payload = ? WHERE event_id = ?",
          ["mutated", Uint8Array.of(0), EVENT_ID],
        );
      });

      expect(
        database.read((reader) =>
          reader.get(
            "SELECT event_type, hex(event_payload) AS event_payload FROM maintenance_events WHERE event_id = ?",
            [EVENT_ID],
          ),
        ),
      ).toEqual({ event_type: "action_succeeded", event_payload: "0809" });
    });
  });

  it("rejects invalid endpoints, digests, timestamps, foreign keys, and terminal evidence atomically", async () => {
    await withTemporarySupervisorDatabase(async (database) => {
      await insertValidSupervisorState(database);

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, "018f3a2e-4a20-7b90-8123-abcdef123472");
        transaction.run(
          "INSERT INTO execution_hosts (id, host_kind, display_name, state_kind, endpoint, version, registered_at_ms, last_seen_at_ms, removed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            INVALID_LOCAL_HOST_ID,
            "local",
            "invalid-local",
            "pending",
            "http://127.0.0.1",
            0,
            NOW_MS,
            null,
            null,
          ],
        );
      });
      expectNoRow(database, "paired_devices", "018f3a2e-4a20-7b90-8123-abcdef123472");
      expectNoRow(database, "execution_hosts", INVALID_LOCAL_HOST_ID);

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, "018f3a2e-4a20-7b90-8123-abcdef123473");
        transaction.run(
          "INSERT INTO execution_hosts (id, host_kind, display_name, state_kind, endpoint, version, registered_at_ms, last_seen_at_ms, removed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [INVALID_SSH_HOST_ID, "ssh", "invalid-ssh", "pending", null, 0, NOW_MS, null, null],
        );
      });
      expectNoRow(database, "paired_devices", "018f3a2e-4a20-7b90-8123-abcdef123473");
      expectNoRow(database, "execution_hosts", INVALID_SSH_HOST_ID);

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, INVALID_TOKEN_DEVICE_ID, "invalid-token-device");
        transaction.run(
          "INSERT INTO device_sessions (id, device_id, token_digest, csrf_digest, scope_kind, created_at_ms, expires_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            "018f3a2e-4a20-7b90-8123-abcdef123474",
            INVALID_TOKEN_DEVICE_ID,
            `${"token".repeat(12)}abcd`,
            "d".repeat(64),
            "read_only",
            NOW_MS,
            NOW_MS + 1_000,
            null,
          ],
        );
      });
      expectNoRow(database, "paired_devices", INVALID_TOKEN_DEVICE_ID);
      expectNoRow(database, "device_sessions", "018f3a2e-4a20-7b90-8123-abcdef123474");

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, "018f3a2e-4a20-7b90-8123-abcdef123475");
        transaction.run(
          "INSERT INTO paired_devices (id, display_name, public_key, state_kind, paired_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
          [
            INVALID_REVOKED_DEVICE_ID,
            "invalid-revoked-device",
            `${INVALID_REVOKED_DEVICE_ID}-public-key`,
            "revoked",
            NOW_MS + 1_000,
            NOW_MS,
          ],
        );
      });
      expectNoRow(database, "paired_devices", "018f3a2e-4a20-7b90-8123-abcdef123475");
      expectNoRow(database, "paired_devices", INVALID_REVOKED_DEVICE_ID);

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, "018f3a2e-4a20-7b90-8123-abcdef123476");
        transaction.run(
          "INSERT INTO ssh_profiles (id, host_id, host_kind, hostname, port, username, credential_reference, host_key_fingerprint, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            INVALID_HOST_PROFILE_ID,
            MISSING_HOST_ID,
            "ssh",
            "missing-host.example",
            22,
            "runner",
            "credential/missing-host",
            "SHA256:missing-host",
            NOW_MS,
            NOW_MS,
          ],
        );
      });
      expectNoRow(database, "paired_devices", "018f3a2e-4a20-7b90-8123-abcdef123476");
      expectNoRow(database, "ssh_profiles", INVALID_HOST_PROFILE_ID);

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, "018f3a2e-4a20-7b90-8123-abcdef123477");
        transaction.run(
          "INSERT INTO maintenance_actions (id, maintenance_session_id, host_id, action_type, request_payload, state_kind, evidence_type, evidence_payload, created_at_ms, finished_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            INVALID_SESSION_ACTION_ID,
            MISSING_SESSION_ID,
            HOST_ID,
            "missing-session",
            Uint8Array.of(1),
            "pending",
            null,
            null,
            NOW_MS,
            null,
          ],
        );
      });
      expectNoRow(database, "paired_devices", "018f3a2e-4a20-7b90-8123-abcdef123477");
      expectNoRow(database, "maintenance_actions", INVALID_SESSION_ACTION_ID);

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, "018f3a2e-4a20-7b90-8123-abcdef123478");
        transaction.run(
          "INSERT INTO maintenance_actions (id, maintenance_session_id, host_id, action_type, request_payload, state_kind, evidence_type, evidence_payload, created_at_ms, finished_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            INVALID_TERMINAL_ACTION_ID,
            MAINTENANCE_SESSION_ID,
            HOST_ID,
            "terminal-without-time",
            Uint8Array.of(2),
            "succeeded",
            null,
            null,
            NOW_MS + 1_000,
            null,
          ],
        );
      });
      expectNoRow(database, "paired_devices", "018f3a2e-4a20-7b90-8123-abcdef123478");
      expectNoRow(database, "maintenance_actions", INVALID_TERMINAL_ACTION_ID);

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, "018f3a2e-4a20-7b90-8123-abcdef123479");
        transaction.run(
          "INSERT INTO maintenance_actions (id, maintenance_session_id, host_id, action_type, request_payload, state_kind, evidence_type, evidence_payload, created_at_ms, finished_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            INVALID_EVIDENCE_ACTION_ID,
            MAINTENANCE_SESSION_ID,
            HOST_ID,
            "terminal-without-evidence",
            Uint8Array.of(3),
            "failed",
            "stderr",
            null,
            NOW_MS + 1_100,
            NOW_MS + 1_200,
          ],
        );
      });
      expectNoRow(database, "paired_devices", "018f3a2e-4a20-7b90-8123-abcdef123479");
      expectNoRow(database, "maintenance_actions", INVALID_EVIDENCE_ACTION_ID);
    });
  });

  it("serializes concurrent writes in call order", async () => {
    await withTemporarySupervisorDatabase(async (database) => {
      await insertValidSupervisorState(database);

      const first = database.write((transaction) => {
        transaction.run(
          "INSERT INTO maintenance_events (event_id, maintenance_session_id, action_id, event_type, event_payload, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
          [
            FIRST_EVENT_ID,
            MAINTENANCE_SESSION_ID,
            null,
            "first_queued_write",
            Uint8Array.of(10),
            NOW_MS + 900,
          ],
        );
        return "first";
      });
      const second = database.write((transaction) => {
        transaction.run(
          "INSERT INTO maintenance_events (event_id, maintenance_session_id, action_id, event_type, event_payload, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
          [
            SECOND_EVENT_ID,
            MAINTENANCE_SESSION_ID,
            null,
            "second_queued_write",
            Uint8Array.of(11),
            NOW_MS + 1_000,
          ],
        );
        return "second";
      });

      await expect(first).resolves.toBe("first");
      await expect(second).resolves.toBe("second");
      expect(
        database.read((reader) =>
          reader.all("SELECT event_id FROM maintenance_events ORDER BY sequence"),
        ),
      ).toEqual([
        { event_id: EVENT_ID },
        { event_id: FIRST_EVENT_ID },
        { event_id: SECOND_EVENT_ID },
      ]);
    });
  });

  it("rolls back failed and async transactions before accepting the next queued write", async () => {
    await withTemporarySupervisorDatabase(async (database) => {
      await insertValidSupervisorState(database);

      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, ROLLBACK_DEVICE_ID, "rolled-back-device");
        insertPairedDevice(transaction, ROLLBACK_DEVICE_ID, "duplicate-device");
      });
      expectNoRow(database, "paired_devices", ROLLBACK_DEVICE_ID);

      await database.write((transaction) => {
        insertPairedDevice(transaction, AFTER_FAILURE_DEVICE_ID, "after-failure-device");
      });
      expectNoRow(database, "paired_devices", ROLLBACK_DEVICE_ID);
      expect(
        database.read((reader) =>
          reader.get("SELECT id FROM paired_devices WHERE id = ?", [AFTER_FAILURE_DEVICE_ID]),
        ),
      ).toEqual({
        id: AFTER_FAILURE_DEVICE_ID,
      });

      await expectAsyncSqliteError(
        database.write(async (transaction) => {
          await Promise.resolve();
          insertPairedDevice(transaction, ASYNC_DEVICE_ID, "async-device");
          return "unexpected";
        }),
        "transaction_async",
      );
      expectNoRow(database, "paired_devices", ASYNC_DEVICE_ID);
      await expectAsyncSqliteError(
        database.write((transaction) => {
          insertPairedDevice(transaction, THENABLE_DEVICE_ID, "thenable-device");
          return {
            then(resolve: (value: string) => void): void {
              resolve("unexpected");
            },
          };
        }),
        "transaction_async",
      );
      expectNoRow(database, "paired_devices", THENABLE_DEVICE_ID);
      const pending = Promise.withResolvers<undefined>();
      await expectAsyncSqliteError(
        database.write((transaction) => {
          insertPairedDevice(transaction, PENDING_DEVICE_ID, "pending-device");
          return pending.promise;
        }),
        "transaction_async",
      );
      expectNoRow(database, "paired_devices", PENDING_DEVICE_ID);
      pending.resolve(undefined);

      await database.write((transaction) => {
        insertPairedDevice(transaction, AFTER_ASYNC_DEVICE_ID, "after-async-device");
      });
      expectNoRow(database, "paired_devices", ASYNC_DEVICE_ID);
      expect(
        database.read((reader) =>
          reader.get("SELECT id FROM paired_devices WHERE id = ?", [AFTER_ASYNC_DEVICE_ID]),
        ),
      ).toEqual({
        id: AFTER_ASYNC_DEVICE_ID,
      });
    });
  });

  it("drains admitted writes before closing the database", async () => {
    await withTemporarySupervisorDatabase(async (database, temporary) => {
      await insertValidSupervisorState(database);

      const admittedWrite = database.write((transaction) => {
        insertPairedDevice(transaction, ADMITTED_DEVICE_ID, "admitted-device");
      });
      const close = database.close();

      await expect(admittedWrite).resolves.toBeUndefined();
      await expect(close).resolves.toBeUndefined();

      const reopened = await openSupervisorDatabase({ path: temporary.path, clock: CLOCK });
      try {
        expect(
          reopened.read((reader) =>
            reader.get("SELECT id FROM paired_devices WHERE id = ?", [ADMITTED_DEVICE_ID]),
          ),
        ).toEqual({ id: ADMITTED_DEVICE_ID });
      } finally {
        await reopened.close();
      }
    });
  });

  it("keeps readers read-only and reports closed boundary failures", async () => {
    await withTemporarySupervisorDatabase(async (database, temporary) => {
      await insertValidSupervisorState(database);

      await expectAsyncSqliteError(
        Promise.resolve().then(() =>
          database.read((reader) =>
            reader.get(
              "INSERT INTO paired_devices (id, display_name, public_key, state_kind, paired_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
              [
                READ_ONLY_DEVICE_ID,
                "read-only-device",
                `${READ_ONLY_DEVICE_ID}-public-key`,
                "active",
                NOW_MS,
                null,
              ],
            ),
          ),
        ),
        "read_failed",
      );
      expectNoRow(database, "paired_devices", READ_ONLY_DEVICE_ID);
      const attachedPath = join(temporary.directory, "reader-attached.db");
      await expectAsyncSqliteError(
        Promise.resolve().then(() =>
          database.read((reader) => reader.get("ATTACH DATABASE ? AS escaped", [attachedPath])),
        ),
        "read_failed",
      );
      expect(existsSync(attachedPath)).toBe(false);
      const writerAttachedPath = join(temporary.directory, "writer-attached.db");
      await expectTransactionFailure(database, (transaction) => {
        transaction.run("ATTACH DATABASE ? AS escaped", [writerAttachedPath]);
      });
      expect(existsSync(writerAttachedPath)).toBe(false);
      await expectTransactionFailure(database, (transaction) => {
        insertPairedDevice(transaction, READ_ONLY_DEVICE_ID, "transaction-control-device");
        transaction.run("COMMIT");
      });
      expectNoRow(database, "paired_devices", READ_ONLY_DEVICE_ID);

      await database.close();
      await expectAsyncSqliteError(
        Promise.resolve().then(() => database.read((reader) => reader.get("SELECT 1 AS present"))),
        "database_closed",
      );
      await expectAsyncSqliteError(
        database.write((transaction) => {
          transaction.run("SELECT 1");
        }),
        "database_closed",
      );
    });
  });
});
