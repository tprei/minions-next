import { createSupervisorHostRegistry, HostRegistryError } from "@minions/adapters";
import { hostId, timestampFromEpochMilliseconds, type HostId } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

const REGISTERED_AT = timestampFromEpochMilliseconds(1_700_000_000_000);
const OFFLINE_AT = timestampFromEpochMilliseconds(1_700_000_000_100);
const ONLINE_AT = timestampFromEpochMilliseconds(1_700_000_000_200);
const REMOVED_AT = timestampFromEpochMilliseconds(1_700_000_000_300);
const CLOCK = new FixedClock(REGISTERED_AT);

const KNOWN_HOST_KEY = "a".repeat(64);

const LOCAL_HOST_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef123456");
const REPLACEMENT_LOCAL_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef123457");
const SSH_HOST_ID_A = hostId("018f3a2e-4a20-7b90-8123-abcdef123458");
const SSH_HOST_ID_B = hostId("018f3a2e-4a20-7b90-8123-abcdef123459");
const WSL_HOST_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef12345a");
const UNKNOWN_HOST_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef1234ff");
const REGISTERED_SSH_HOST_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef1234fe");

async function withSupervisor<T>(
  operation: (temporary: TemporarySqliteDatabase) => Promise<T>,
): Promise<T> {
  const temporary = await TemporarySqliteDatabase.create("supervisor", CLOCK);
  try {
    return await operation(temporary);
  } finally {
    await temporary.dispose();
  }
}

async function insertHost(
  temporary: TemporarySqliteDatabase,
  id: HostId,
  kind: "ssh" | "wsl2",
  displayName: string,
): Promise<void> {
  await temporary.database.write((transaction) => {
    transaction.run(
      `INSERT INTO execution_hosts (
         id, host_kind, display_name, state_kind, endpoint, version,
         registered_at_ms, last_seen_at_ms, removed_at_ms
       ) VALUES (?, ?, ?, 'online', ?, 0, ?, ?, NULL)`,
      [id, kind, displayName, `${kind}://${displayName}`, REGISTERED_AT, REGISTERED_AT],
    );
  });
}

describe("supervisor host registry", () => {
  it("registers one local host and refreshes its identity in place", async () => {
    await withSupervisor(async (temporary) => {
      const registry = createSupervisorHostRegistry({ database: temporary.database });

      const first = await registry.ensureLocalHost({
        id: LOCAL_HOST_ID,
        displayName: "Mac",
        observedAt: REGISTERED_AT,
      });
      const refreshed = await registry.ensureLocalHost({
        id: REPLACEMENT_LOCAL_ID,
        displayName: "MacBook Pro",
        observedAt: OFFLINE_AT,
      });

      expect(first).toEqual({
        id: LOCAL_HOST_ID,
        kind: "local",
        displayName: "Mac",
        state: "online",
        endpoint: undefined,
        version: 0,
        registeredAt: REGISTERED_AT,
        lastSeenAt: REGISTERED_AT,
      });
      expect(refreshed).toEqual({
        id: LOCAL_HOST_ID,
        kind: "local",
        displayName: "MacBook Pro",
        state: "online",
        endpoint: undefined,
        version: 1,
        registeredAt: REGISTERED_AT,
        lastSeenAt: OFFLINE_AT,
      });
      expect(registry.list({ afterId: undefined, limit: 10 }).map((host) => host.id)).toEqual([
        LOCAL_HOST_ID,
      ]);
    });
  });

  it("transitions a local host offline and refreshes it online with new versions", async () => {
    await withSupervisor(async (temporary) => {
      const registry = createSupervisorHostRegistry({ database: temporary.database });
      await registry.ensureLocalHost({
        id: LOCAL_HOST_ID,
        displayName: "Mac",
        observedAt: REGISTERED_AT,
      });

      const offline = await registry.markOffline(LOCAL_HOST_ID, OFFLINE_AT);
      const online = await registry.ensureLocalHost({
        id: REPLACEMENT_LOCAL_ID,
        displayName: "Mac online",
        observedAt: ONLINE_AT,
      });

      expect(offline).toMatchObject({
        id: LOCAL_HOST_ID,
        state: "offline",
        version: 1,
        lastSeenAt: OFFLINE_AT,
      });
      expect(online).toMatchObject({
        id: LOCAL_HOST_ID,
        state: "online",
        displayName: "Mac online",
        version: 2,
        registeredAt: REGISTERED_AT,
        lastSeenAt: ONLINE_AT,
      });
    });
  });

  it("lists hosts in ID order through after-ID pagination", async () => {
    await withSupervisor(async (temporary) => {
      const registry = createSupervisorHostRegistry({ database: temporary.database });
      await registry.ensureLocalHost({
        id: LOCAL_HOST_ID,
        displayName: "Mac",
        observedAt: REGISTERED_AT,
      });
      await insertHost(temporary, SSH_HOST_ID_A, "ssh", "builder-a");
      await insertHost(temporary, SSH_HOST_ID_B, "ssh", "builder-b");
      await insertHost(temporary, WSL_HOST_ID, "wsl2", "windows-linux");

      const firstPage = registry.list({ afterId: undefined, limit: 2 });
      const secondPage = registry.list({ afterId: SSH_HOST_ID_A, limit: 2 });
      const finalPage = registry.list({ afterId: SSH_HOST_ID_B, limit: 2 });

      expect(firstPage.map((host) => host.id)).toEqual([LOCAL_HOST_ID, SSH_HOST_ID_A]);
      expect(secondPage.map((host) => host.id)).toEqual([SSH_HOST_ID_B, WSL_HOST_ID]);
      expect(finalPage.map((host) => host.id)).toEqual([WSL_HOST_ID]);
    });
  });

  it("rejects offline transitions for unknown hosts", async () => {
    await withSupervisor(async (temporary) => {
      const registry = createSupervisorHostRegistry({ database: temporary.database });
      const transition = registry.markOffline(UNKNOWN_HOST_ID, OFFLINE_AT);

      await expect(transition).rejects.toBeInstanceOf(HostRegistryError);
      await expect(transition).rejects.toMatchObject({ code: "host_not_found" });
      expect(registry.list({ afterId: undefined, limit: 10 })).toEqual([]);
    });
  });

  it("registers an SSH host and persists its profile alongside the execution host", async () => {
    await withSupervisor(async (temporary) => {
      const registry = createSupervisorHostRegistry({ database: temporary.database });

      const host = await registry.registerSsh({
        id: REGISTERED_SSH_HOST_ID,
        displayName: "builder-a",
        hostname: "builder-a.internal",
        port: 22,
        username: "minions",
        knownHostKeyFingerprint: KNOWN_HOST_KEY,
        registeredAt: REGISTERED_AT,
      });

      expect(host).toEqual({
        id: REGISTERED_SSH_HOST_ID,
        kind: "ssh",
        displayName: "builder-a",
        state: "pending",
        endpoint: "builder-a.internal:22",
        version: 0,
        registeredAt: REGISTERED_AT,
        lastSeenAt: REGISTERED_AT,
      });
      expect(registry.find(REGISTERED_SSH_HOST_ID)).toEqual(host);

      const profileRows = temporary.database.read((reader) =>
        reader.all(
          "SELECT hostname, port, username, host_key_fingerprint FROM ssh_profiles WHERE host_id = ?",
          [REGISTERED_SSH_HOST_ID],
        ),
      );
      expect(profileRows).toEqual([
        {
          hostname: "builder-a.internal",
          port: 22n,
          username: "minions",
          host_key_fingerprint: KNOWN_HOST_KEY,
        },
      ]);
    });
  });

  it("removes a host permanently and is idempotent on a second removal", async () => {
    await withSupervisor(async (temporary) => {
      const registry = createSupervisorHostRegistry({ database: temporary.database });
      await registry.registerSsh({
        id: REGISTERED_SSH_HOST_ID,
        displayName: "builder-a",
        hostname: "builder-a.internal",
        port: 22,
        username: "minions",
        knownHostKeyFingerprint: KNOWN_HOST_KEY,
        registeredAt: REGISTERED_AT,
      });

      const removed = await registry.remove(REGISTERED_SSH_HOST_ID, REMOVED_AT);
      expect(removed).toMatchObject({
        id: REGISTERED_SSH_HOST_ID,
        state: "removed",
        version: 1,
      });

      // Idempotent: a second removal is a no-op and preserves the original timestamp
      // rather than advancing version or removed_at on every repeated call.
      const removedAgain = await registry.remove(REGISTERED_SSH_HOST_ID, ONLINE_AT);
      expect(removedAgain).toEqual(removed);
    });
  });

  it("rejects removal of unknown hosts", async () => {
    await withSupervisor(async (temporary) => {
      const registry = createSupervisorHostRegistry({ database: temporary.database });
      const removal = registry.remove(UNKNOWN_HOST_ID, REMOVED_AT);

      await expect(removal).rejects.toBeInstanceOf(HostRegistryError);
      await expect(removal).rejects.toMatchObject({ code: "host_not_found" });
    });
  });
});
