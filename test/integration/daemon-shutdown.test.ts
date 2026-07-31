import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createEventCommitWaiter,
  createPlanRegistry,
  createSqliteCommandStore,
  createSqliteSteeringCommandStore,
  createSqliteVcsChangeBindingStore,
} from "@minions/adapters";
import {
  ArtifactRetention,
  ArtifactService,
  CreateArtifactRequestSchema,
  DaemonMode,
  DoctorStatus,
  GetHealthResponseSchema,
  RunDoctorResponseSchema,
} from "@minions/contracts";
import {
  contentHash,
  hostId,
  nonEmptyText,
  timestampFromEpochMilliseconds,
  type ArtifactRecord,
  type ArtifactRegistry,
  type ContentBlobStore,
} from "@minions/core";
import { SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemonServer, type RunningDaemonServer } from "@minions/daemon";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const HOST_ID = hostId("01900000-0000-7000-8000-000000000001");
const INSTANCE_ID = "01900000-0000-7000-8000-000000000002";
const COMMAND_ID = "01900000-0000-7000-8000-000000000003";
const ACTOR_SESSION_ID = "01900000-0000-7000-8000-000000000004";
const ARTIFACT_ID = "01900000-0000-7000-8000-000000000005";
const NODE_ID = "01900000-0000-7000-8000-000000000006";
const EVIDENCE_ID = "01900000-0000-7000-8000-000000000007";
const CONTENT_DIGEST = contentHash(
  "0000000000000000000000000000000000000000000000000000000000000000",
);

type ShutdownFixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  server: RunningDaemonServer;
  createPending: PromiseWithResolvers<ArtifactRecord>;
  persistStarted: Promise<undefined>;
}>;

describe("daemon shutdown drain", () => {
  let fixture: ShutdownFixture | undefined;

  afterEach(async () => {
    if (fixture !== undefined) {
      await fixture.server.close();
      await fixture.temporary.dispose();
      fixture = undefined;
    }
  });

  it("waits for a blocked blob publication callback before closing", async () => {
    fixture = await createFixture();
    const activeFixture = fixture;
    const client = createClient(
      ArtifactService,
      createConnectTransport({
        baseUrl: activeFixture.server.baseUrl,
        httpVersion: "1.1",
        useBinaryFormat: true,
        nodeOptions: { agent: false },
      }),
    );
    const request = client.createArtifact(
      create(CreateArtifactRequestSchema, {
        commandId: COMMAND_ID,
        actorSessionId: ACTOR_SESSION_ID,
        artifactId: ARTIFACT_ID,
        nodeId: NODE_ID,
        mediaType: "text/plain",
        artifactType: "plan",
        evidenceId: EVIDENCE_ID,
        retention: ArtifactRetention.ACTIVE,
        content: new Uint8Array([1]),
      }),
    );
    await activeFixture.persistStarted;

    const closePromise = activeFixture.server.close();
    let closeSettled = false;
    void closePromise.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    activeFixture.createPending.reject(new Error("release publication callback"));
    await expect(request).rejects.toThrow();
    await closePromise;
  });
});

async function createFixture(): Promise<ShutdownFixture> {
  const temporary = await TemporarySqliteDatabase.create("host", {
    now: () => NOW,
  });
  const database = temporary.database;
  const ids = new SequenceIdGenerator([INSTANCE_ID, COMMAND_ID, ACTOR_SESSION_ID]);
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
  const createPending = Promise.withResolvers<ArtifactRecord>();
  const persistStarted = Promise.withResolvers<undefined>();
  const artifactRegistry: ArtifactRegistry = {
    create: () => {
      persistStarted.resolve(undefined);
      return createPending.promise;
    },
    get: () => undefined,
    list: () => Object.freeze([]),
    expectedBlobs: () => Object.freeze([]),
    recordOutcome: () => Promise.reject(new Error("not used")),
    getOutcome: () => undefined,
  };
  const blobStore: ContentBlobStore = {
    withPublishedBlob: (content, persist) =>
      persist({
        digest: CONTENT_DIGEST,
        sizeBytes: BigInt(content.byteLength),
        relativePath: nonEmptyText(
          "sha256/00/00/0000000000000000000000000000000000000000000000000000000000000000",
          "blob relative path",
        ),
        verifiedAt: NOW,
        created: true,
      }),
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
          create(RunDoctorResponseSchema, {
            status: DoctorStatus.HEALTHY,
            checks: [],
          }),
        ),
    },
  });
  return {
    temporary,
    server,
    createPending,
    persistStarted: persistStarted.promise,
  };
}
