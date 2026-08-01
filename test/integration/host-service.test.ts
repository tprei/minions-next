import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import { createSupervisorHostRegistry, type SupervisorHostRegistry } from "@minions/adapters";
import { ExecutionHostState, HostService } from "@minions/contracts";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerHostService } from "@minions/daemon";

/**
 * Host service integration tests (PR 53 — ssh-execution-hosts).
 *
 * Uses Connect's in-memory `createRouterTransport` (see pairing-service.test.ts's doc
 * comment for why this is a faithful integration test, not a mock) against a real,
 * temporary supervisor SQLite database — RegisterSshHost and RemoveHost persist for
 * real, closing the `ssh_revocation` security boundary's "a matching key is always
 * trusted" gap: a removed host's state is durably `REMOVED`, not merely absent from an
 * in-memory map. Real remote connection dispatch (bootstrap/ControlMaster/tunnel) needs
 * a real remote host and is out of scope here — see host-registry.test.ts for the
 * underlying registry unit coverage.
 */
const CLOCK = new FixedClock(timestampFromEpochMilliseconds(1_735_689_600_000));

let temporary: TemporarySqliteDatabase;
let registry: SupervisorHostRegistry;

beforeEach(async () => {
  temporary = await TemporarySqliteDatabase.create("supervisor", CLOCK);
  registry = createSupervisorHostRegistry({ database: temporary.database });
});

afterEach(async () => {
  await temporary.dispose();
});

function hostClient() {
  const transport = createRouterTransport((router) => {
    registerHostService(router, registry);
  });
  return createClient(HostService, transport);
}

const PROFILE = {
  alias: "builder-a",
  hostname: "builder-a.internal",
  port: 22,
  user: "minions",
  knownHostKey: "b".repeat(64),
  controlMasterPath: "/tmp/minions-ssh-control-builder-a",
  localForwardPort: 41200,
};

describe("HostService integration", () => {
  it("registerSshHost persists a real host, visible through listHosts", async () => {
    const hosts = hostClient();
    const { host } = await hosts.registerSshHost({ profile: PROFILE });
    expect(host?.displayName).toBe("builder-a");
    expect(host?.endpoint).toBe("builder-a.internal:22");
    expect(host?.state).toBe(ExecutionHostState.PENDING);

    const { hosts: listed } = await hosts.listHosts({ pageSize: 10 });
    expect(listed.map((h) => h.id)).toContain(host?.id);
  });

  it("rejects registerSshHost with no profile", async () => {
    const hosts = hostClient();
    await expect(hosts.registerSshHost({})).rejects.toThrow(ConnectError);
  });

  it("rejects registerSshHost with an empty alias", async () => {
    const hosts = hostClient();
    await expect(hosts.registerSshHost({ profile: { ...PROFILE, alias: "" } })).rejects.toThrow(
      ConnectError,
    );
  });

  it("removeHost durably revokes trust — the host reads back REMOVED, not merely absent", async () => {
    const hosts = hostClient();
    const { host } = await hosts.registerSshHost({ profile: PROFILE });
    const id = host?.id ?? "";

    await hosts.removeHost({ id });

    const { hosts: listed } = await hosts.listHosts({ pageSize: 10 });
    const found = listed.find((h) => h.id === id);
    expect(found).toBeDefined();
    expect(found?.state).toBe(ExecutionHostState.REMOVED);

    // Not a transient effect — every subsequent RPC read confirms removal stays durable.
    for (let i = 0; i < 3; i += 1) {
      const { hosts: reread } = await hosts.listHosts({ pageSize: 10 });
      expect(reread.find((h) => h.id === id)?.state).toBe(ExecutionHostState.REMOVED);
    }
  });

  it("removeHost is idempotent for an unknown host id (postcondition holds either way)", async () => {
    const hosts = hostClient();
    await hosts.removeHost({ id: "01900000-0000-7000-8000-000000000099" });
  });

  it("removeHost is idempotent when called twice on the same host", async () => {
    const hosts = hostClient();
    const { host } = await hosts.registerSshHost({ profile: PROFILE });
    const id = host?.id ?? "";

    await hosts.removeHost({ id });
    await hosts.removeHost({ id });
  });

  it("rejects removeHost with a malformed id", async () => {
    const hosts = hostClient();
    try {
      await hosts.removeHost({ id: "not-a-uuid" });
      expect.unreachable("removeHost must reject a malformed id");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.InvalidArgument);
    }
  });
});
