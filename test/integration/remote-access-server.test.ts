import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createClient } from "@connectrpc/connect";
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
 * `startDaemonServer`'s remote-access bind-host and real-socket loopback detection (PR
 * 57 — private-phone-pairing, REMOTE-01/REMOTE-02). `remote-access.test.ts` proves the
 * interceptor's decision logic against an injected loopback flag; this file proves the
 * one piece that requires a real HTTP server and real `net.Socket`: that
 * `connectNodeAdapter`'s `contextValues` hook, wired to `isLoopbackAddress` in
 * `server.ts`, correctly recognises a genuine `127.0.0.1` connection as loopback even
 * once `remoteAccess` is configured and the interceptor is active — the property that
 * guarantees the desktop UI is never affected by enabling this feature.
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

  it("treats a real 127.0.0.1 HTTP connection as loopback, bypassing the interceptor, once remoteAccess is enabled", async () => {
    fixture = await createFixture({ withRemoteAccess: true });
    const client = createClient(
      PairingService,
      createConnectTransport({
        baseUrl: fixture.server.baseUrl,
        httpVersion: "1.1",
        useBinaryFormat: true,
        nodeOptions: { agent: false },
      }),
    );
    // ListDevices is in the default PHONE_REMOTE_ACCESS_POLICY (read_only) — a
    // non-loopback caller would need a valid session cookie. None is presented here;
    // success proves the real socket was recognised as loopback and bypassed the check.
    await expect(client.listDevices({})).resolves.toMatchObject({ devices: [] });
  });

  it("still serves PairingService with no interceptor at all when remoteAccess is omitted", async () => {
    fixture = await createFixture({ withRemoteAccess: false });
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
