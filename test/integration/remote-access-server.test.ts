import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createEventCommitWaiter,
  createPlanRegistry,
  createSqliteCommandStore,
  createSqliteRecoveryStore,
  createSqliteSteeringCommandStore,
  createSqliteVcsChangeBindingStore,
} from "@minions/adapters";
import {
  DaemonMode,
  DoctorStatus,
  GetHealthResponseSchema,
  PairingService,
  RunDoctorResponseSchema,
} from "@minions/contracts";
import {
  hostId,
  timestampFromEpochMilliseconds,
  type ArtifactRegistry,
  type ContentBlobStore,
  type RecoveryGateProfile,
} from "@minions/core";
import { SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDeviceSessionStore,
  startDaemonServer,
  type RunningDaemonServer,
} from "@minions/daemon";

/**
 * `startDaemonServer` two-listener remote-access model (PR 57 — private-phone-pairing,
 * REMOTE-01/REMOTE-02, P0 fix). Trust derives from WHICH listener accepted the
 * connection, never the peer address: the trusted loopback listener (`options.port`) has
 * NO remote-access interceptor; the remote (phone) listener (its own port) ALWAYS
 * enforces the phone policy + device-session auth. The documented `tailscale serve`
 * deployment proxies the phone onto `http://127.0.0.1:<remotePort>`, so phone requests
 * arrive with a loopback `remoteAddress` — a cookieless request to the remote listener
 * must STILL be rejected, and a cookieless desktop request to the trusted listener must
 * STILL succeed. Both assertions fail on the pre-fix single-listener code (no `remotePort`,
 * loopback bypass on a peer address).
 */
const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const HOST_ID = hostId("01900000-0000-7000-8000-0000000000f1");
const INSTANCE_ID = "01900000-0000-7000-8000-0000000000f2";
const RECOVERY_TEST_GATE_PROFILE: RecoveryGateProfile = {
  allowedKinds: ["restart"],
  requiredApprovals: 1,
  maxGrantDurationMs: 900_000,
};

type Fixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  server: RunningDaemonServer;
}>;

describe("startDaemonServer remote access", () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture !== undefined) {
      await fixture.server.close();
      await fixture.temporary.dispose();
      fixture = undefined;
    }
  });

  it("rejects a cookieless phone-shaped request on the remote listener even from 127.0.0.1", async () => {
    fixture = await createFixture({ withRemoteAccess: true });
    const remotePort = fixture.server.remotePort;
    if (typeof remotePort !== "number") {
      throw new Error("remote listener did not bind (no remotePort on RunningDaemonServer)");
    }
    // The remote listener is a distinct port from the trusted loopback listener.
    expect(remotePort).not.toBe(fixture.server.port);
    const client = createClient(
      PairingService,
      createConnectTransport({
        baseUrl: `http://127.0.0.1:${String(remotePort)}`,
        httpVersion: "1.1",
        useBinaryFormat: true,
        nodeOptions: { agent: false },
      }),
    );
    // ListDevices is absent from PHONE_REMOTE_ACCESS_POLICY, so the remote listener's
    // always-enforcing interceptor rejects it with PermissionDenied — even though this
    // request arrives from 127.0.0.1, exactly how the tailscale-serve deployment proxies
    // a phone onto the remote port. Pre-fix the single listener treated 127.0.0.1 as a
    // trusted loopback caller and bypassed every check, returning { devices: [] }.
    const caught = await client.listDevices({}).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ConnectError);
    expect((caught as ConnectError).code).toBe(Code.PermissionDenied);
  });

  it("still serves the trusted loopback listener with no interceptor (desktop UI unchanged)", async () => {
    fixture = await createFixture({ withRemoteAccess: true });
    // Remote access is enabled (a second listener exists), yet the trusted loopback
    // listener (baseUrl/port) is untouched by the remote-access interceptor.
    expect(fixture.server.remotePort).toBeTypeOf("number");
    const client = createClient(
      PairingService,
      createConnectTransport({
        baseUrl: fixture.server.baseUrl,
        httpVersion: "1.1",
        useBinaryFormat: true,
        nodeOptions: { agent: false },
      }),
    );
    // A cookieless desktop request reaches PairingService unchanged and succeeds.
    await expect(client.listDevices({})).resolves.toMatchObject({ devices: [] });
  });

  it("exposes no remote listener when remoteAccess is omitted", async () => {
    fixture = await createFixture({ withRemoteAccess: false });
    expect(fixture.server.remotePort).toBeUndefined();
    const client = createClient(
      PairingService,
      createConnectTransport({
        baseUrl: fixture.server.baseUrl,
        httpVersion: "1.1",
        useBinaryFormat: true,
        nodeOptions: { agent: false },
      }),
    );
    await expect(client.listDevices({})).resolves.toMatchObject({ devices: [] });
  });
});

async function createFixture(options: { withRemoteAccess: boolean }): Promise<Fixture> {
  const temporary = await TemporarySqliteDatabase.create("host", { now: () => NOW });
  const database = temporary.database;
  const ids = new SequenceIdGenerator([INSTANCE_ID]);
  const eventWaiter = createEventCommitWaiter();
  const commandStore = createSqliteCommandStore({
    database,
    ports: { clock: { now: () => NOW }, ids },
    notifier: eventWaiter,
  });
  const planRegistry = createPlanRegistry({ database, commandStore, hostId: HOST_ID });
  const steeringStore = createSqliteSteeringCommandStore({
    database,
    commandStore,
    ports: { clock: { now: () => NOW }, ids },
  });
  const artifactRegistry: ArtifactRegistry = {
    create: () => Promise.reject(new Error("not used")),
    get: () => undefined,
    list: () => Object.freeze([]),
    expectedBlobs: () => Object.freeze([]),
    recordOutcome: () => Promise.reject(new Error("not used")),
    getOutcome: () => undefined,
  };
  const blobStore: ContentBlobStore = {
    withPublishedBlob: () => Promise.reject(new Error("not used")),
    readVerified: () => Promise.resolve(new Uint8Array()),
    reconcile: () =>
      Promise.resolve({
        removedTemporaryPaths: [],
        removedOrphanPaths: [],
        missingDigests: [],
        corruptDigests: [],
      }),
  };
  const server = await startDaemonServer({
    mode: "host",
    port: 0,
    database,
    eventWaiter,
    eventPollIntervalMs: 10,
    planRegistry,
    clock: { now: () => NOW },
    vcsChangeBindingStore: createSqliteVcsChangeBindingStore({ database }),
    steeringStore,
    artifactRegistry,
    blobStore,
    recoveryStore: createSqliteRecoveryStore({ database }),
    recoveryGateProfile: RECOVERY_TEST_GATE_PROFILE,
    recoveryIds: new SequenceIdGenerator(["01900000-0000-7000-8000-0000000000f0"]),
    recoveryRestart: { restart: () => Promise.reject(new Error("not used")) },
    system: {
      serverVersion: "0.0.0",
      health: create(GetHealthResponseSchema, {
        instanceId: INSTANCE_ID,
        mode: DaemonMode.HOST,
        hostId: HOST_ID,
        startedAt: create(TimestampSchema, { seconds: 1_700_000_000n }),
      }),
      runDoctor: () =>
        Promise.resolve(
          create(RunDoctorResponseSchema, { status: DoctorStatus.HEALTHY, checks: [] }),
        ),
    },
    ...(options.withRemoteAccess
      ? { remoteAccess: { sessionStore: createDeviceSessionStore() } }
      : {}),
  });
  return { temporary, server };
}
