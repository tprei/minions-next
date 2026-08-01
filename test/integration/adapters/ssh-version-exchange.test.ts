import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  createSshConnection,
  SshAdapterError,
  type SshRunResult,
  type SshRunner,
} from "@minions/adapters";
import { GetHealthResponseSchema, DaemonMode, ServerCapability } from "@minions/contracts";
import type { SshProfile } from "@minions/core";
import { afterEach, describe, expect, it } from "vitest";

import { registerSystemService } from "@minions/daemon";

/**
 * Real end-to-end proof of the SSH adapter's default `queryHostVersion` (PR 53 — ssh-
 * execution-hosts, version skew policy): `ssh-adapter.test.ts` proves `connect()`'s
 * decision logic against an injected `queryHostVersion` seam; this file proves the one
 * piece that requires a real HTTP server: that the production default correctly reaches
 * a real `SystemService.GetServerInfo` over `127.0.0.1:localForwardPort` and feeds its
 * `serverVersion` into `checkVersionSkew`. `runSsh`/`runKeyscan` are still faked here —
 * this is the exact tunnel-forwarded-port destination once a real SSH port forward is
 * up, and standing up a genuine remote SSH server is out of scope for a unit/integration
 * test (see host-service.test.ts's doc comment); `pnpm synthetic:ssh-host` covers that.
 */

function successRunner(): SshRunner {
  return () => Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" });
}

/** A double for `ssh-keyscan` that presents a key hashing to the given pinned fingerprint. */
function keyscanRunnerFor(profile: SshProfile): SshRunner {
  // The adapter only compares the SHA-256 hex digest of the decoded key bytes against
  // `knownHostKey` — the key's own validity/algorithm is irrelevant to this test, so a
  // fixed, arbitrary base64 blob is fine as long as `knownHostKey` is its real digest.
  return () =>
    Promise.resolve<SshRunResult>({
      exitCode: 0,
      stdout: `${profile.hostname} ssh-ed25519 ${PINNED_KEY_BASE64}\n`,
      stderr: "",
    });
}

const PINNED_KEY_BASE64 = "AAAAC3NzaC1lZDI1NTE5AAAAIMWTqRchDqzassJCK+vayKnWxoWIexa3JR6wK//KFe6G";
const PINNED_FINGERPRINT = "9bec24547d896e818b370c5d30bea9c13181b979569e83c584675c34b5462e8e";

type ServerFixture = Readonly<{
  close: () => Promise<void>;
  port: number;
}>;

async function startFakeHostDaemon(serverVersion: string): Promise<ServerFixture> {
  const handler = connectNodeAdapter({
    routes: (router) => {
      registerSystemService(router, {
        serverVersion,
        capabilities: [ServerCapability.SYSTEM_INFO],
        health: create(GetHealthResponseSchema, {
          instanceId: "01900000-0000-7000-8000-000000000001",
          mode: DaemonMode.HOST,
          startedAt: create(TimestampSchema, { seconds: 1_700_000_000n, nanos: 0 }),
        }),
        runDoctor: () => {
          throw new Error("not exercised in this test");
        },
      });
    },
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

function profileForPort(port: number): SshProfile {
  return Object.freeze({
    alias: "fake-host",
    hostname: "127.0.0.1",
    port: 22,
    user: "operator",
    knownHostKey: PINNED_FINGERPRINT as never,
    controlMasterPath: `/tmp/ssh-version-exchange-test-%r@%h:%p-${String(port)}`,
    localForwardPort: port,
  });
}

describe("SSH adapter default version exchange (real HTTP server, PR 53)", () => {
  let fixture: ServerFixture | undefined;

  afterEach(async () => {
    if (fixture !== undefined) {
      await fixture.close();
      fixture = undefined;
    }
  });

  it("connects when the real remote server reports a compatible major version", async () => {
    fixture = await startFakeHostDaemon("1.4.2");
    const profile = profileForPort(fixture.port);
    const conn = createSshConnection({
      profile,
      runSsh: successRunner(),
      runKeyscan: keyscanRunnerFor(profile),
      supervisorVersion: "1.0.0",
    });
    await conn.connect();
    expect(conn.state).toBe("connected");
  });

  it("rejects fail-closed when the real remote server reports an incompatible major version", async () => {
    fixture = await startFakeHostDaemon("2.0.0");
    const profile = profileForPort(fixture.port);
    const teardownCalls: string[][] = [];
    const conn = createSshConnection({
      profile,
      runSsh: (args) => {
        teardownCalls.push([...args]);
        return Promise.resolve<SshRunResult>({ exitCode: 0, stdout: "", stderr: "" });
      },
      runKeyscan: keyscanRunnerFor(profile),
      supervisorVersion: "1.0.0",
    });
    try {
      await conn.connect();
      expect.unreachable("connect() must reject on a version skew");
    } catch (error) {
      expect(error).toBeInstanceOf(SshAdapterError);
      expect(error instanceof SshAdapterError ? error.code : undefined).toBe("version_skew");
      expect(error instanceof Error ? error.message : "").toContain("major version mismatch");
    }
    expect(conn.state).toBe("error");
    // The ControlMaster established for the version probe must be torn back down
    // (`-O exit`), not left dangling once the connection is rejected.
    const teardownArgs = teardownCalls[teardownCalls.length - 1];
    expect(teardownArgs).toContain("-O");
    expect(teardownArgs).toContain("exit");
  });
});
