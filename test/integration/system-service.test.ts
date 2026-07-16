import { createServer, type Server } from "node:http";

import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { WireType } from "@bufbuild/protobuf/wire";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createEventCommitWaiter,
  createPlanRegistry,
  createSqliteCommandStore,
  createSqliteSteeringCommandStore,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
} from "@minions/adapters";
import {
  ApiVersionSchema,
  DaemonMode,
  DoctorCheckKind,
  DoctorCheckSchema,
  DoctorCheckStatus,
  DoctorStatus,
  ErrorDetailSchema,
  GetServerInfoRequestSchema,
  GetHealthResponseSchema,
  ServerCapability,
  SystemService,
  RunDoctorResponseSchema,
  type ValidationError,
} from "@minions/contracts";
import { hostId, timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startDaemonServer, type RunningDaemonServer } from "@minions/daemon";

let systemServer: RunningDaemonServer | undefined;
let systemClient: Client<typeof SystemService> | undefined;
let temporaryDatabase: TemporarySqliteDatabase | undefined;
const hostIdentifier = "01900000-0000-7000-8000-000000000002";
const health = create(GetHealthResponseSchema, {
  instanceId: "01900000-0000-7000-8000-000000000001",
  mode: DaemonMode.HOST,
  hostId: hostIdentifier,
  startedAt: create(TimestampSchema, { seconds: 1_700_000_000n }),
});
const doctor = create(RunDoctorResponseSchema, {
  status: DoctorStatus.HEALTHY,
  checks: [
    create(DoctorCheckSchema, {
      kind: DoctorCheckKind.LIFECYCLE_LOCK,
      status: DoctorCheckStatus.PASSED,
    }),
  ],
});
const fixtureNow = timestampFromEpochMilliseconds(1_700_000_000_000);
const trustedHostId = hostId(hostIdentifier);

function createHostServices(
  database: ManagedSqliteDatabase,
  eventWaiter: EventCommitWaiter,
  clock: FixedClock,
) {
  const ports = { clock, ids: new SequenceIdGenerator([health.instanceId]) };
  const commandStore = createSqliteCommandStore({
    database,
    ports,
    notifier: eventWaiter,
  });
  return {
    planRegistry: createPlanRegistry({
      database,
      commandStore,
      hostId: trustedHostId,
    }),
    steeringStore: createSqliteSteeringCommandStore({ database, commandStore, ports }),
  };
}

function getSystemClient(): Client<typeof SystemService> {
  if (systemClient === undefined) {
    throw new Error("SystemService client is not initialized");
  }
  return systemClient;
}

async function expectConnectError(call: () => Promise<unknown>): Promise<ConnectError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ConnectError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the request to fail");
}

function getValidationError(error: ConnectError): ValidationError {
  expect(error.details).toHaveLength(1);
  const details = error.findDetails(ErrorDetailSchema);
  expect(details).toHaveLength(1);
  const detail = details[0]?.detail;
  expect(detail?.case).toBe("validation");
  if (detail?.case !== "validation") {
    throw new Error("expected a validation ErrorDetail");
  }
  return detail.value;
}
async function listenOnLoopback(server: Server, port: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const rejectOnError = (error: Error): void => {
    reject(error);
  };
  server.once("error", rejectOnError);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", rejectOnError);
    resolve(undefined);
  });
  await promise;
}

async function closeServer(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  server.close((error) => {
    if (error === undefined) {
      resolve(undefined);
      return;
    }
    reject(error);
  });
  await promise;
}

describe("SystemService integration", () => {
  beforeAll(async () => {
    const clock = new FixedClock(fixtureNow);
    temporaryDatabase = await TemporarySqliteDatabase.create("host", clock);
    const eventWaiter = createEventCommitWaiter();
    const { planRegistry, steeringStore } = createHostServices(
      temporaryDatabase.database,
      eventWaiter,
      clock,
    );
    systemServer = await startDaemonServer({
      mode: "host",
      port: 0,
      database: temporaryDatabase.database,
      eventWaiter,
      eventPollIntervalMs: 10,
      planRegistry,
      clock,
      steeringStore,
      system: { serverVersion: "0.0.0", health, runDoctor: () => Promise.resolve(doctor) },
    });
    systemClient = createClient(
      SystemService,
      createConnectTransport({
        baseUrl: systemServer.baseUrl,
        httpVersion: "1.1",
        useBinaryFormat: true,
      }),
    );
  });

  afterAll(async () => {
    if (systemServer !== undefined) {
      await systemServer.close();
    }
    if (temporaryDatabase !== undefined) {
      await temporaryDatabase.dispose();
    }
  });

  it("returns the server version, API version, and capability", async () => {
    const response = await getSystemClient().getServerInfo(
      create(GetServerInfoRequestSchema, {
        clientName: "integration-test",
        apiVersion: create(ApiVersionSchema, {
          major: 1,
          minor: 0,
          patch: 0,
        }),
      }),
    );

    expect(response.serverVersion).toBe("0.0.0");
    expect(response.apiVersion).toEqual(
      create(ApiVersionSchema, {
        major: 1,
        minor: 0,
        patch: 0,
      }),
    );
    expect(response.capabilities).toEqual([
      ServerCapability.SYSTEM_INFO,
      ServerCapability.HEALTH_DOCTOR,
      ServerCapability.EVENT_STREAM,
      ServerCapability.TREE_PLANNING,
      ServerCapability.STEERING,
    ]);
  });
  it("returns typed daemon health identity", async () => {
    const response = await getSystemClient().getHealth({});

    expect(response).toEqual(health);
  });

  it("returns blocking typed doctor checks", async () => {
    const response = await getSystemClient().runDoctor({});

    expect(response).toEqual(doctor);
  });

  it("rejects an empty client name with validation violations", async () => {
    const error = await expectConnectError(() =>
      getSystemClient().getServerInfo(
        create(GetServerInfoRequestSchema, {
          clientName: "",
          apiVersion: create(ApiVersionSchema, {
            major: 1,
            minor: 0,
            patch: 0,
          }),
        }),
      ),
    );

    expect(error.code).toBe(Code.InvalidArgument);
    const validation = getValidationError(error);
    expect(validation.violations.length).toBeGreaterThan(0);
    expect(validation.violations[0]?.field?.elements[0]?.fieldName).toBe("client_name");
  });

  it("rejects a missing API version with validation violations", async () => {
    const error = await expectConnectError(() =>
      getSystemClient().getServerInfo(
        create(GetServerInfoRequestSchema, {
          clientName: "integration-test",
        }),
      ),
    );

    expect(error.code).toBe(Code.InvalidArgument);
    const validation = getValidationError(error);
    expect(validation.violations.length).toBeGreaterThan(0);
    expect(validation.violations[0]?.field?.elements[0]?.fieldName).toBe("api_version");
  });

  it("rejects unknown binary fields instead of ignoring them", async () => {
    const request = create(GetServerInfoRequestSchema, {
      clientName: "integration-test",
      apiVersion: create(ApiVersionSchema, {
        major: 1,
        minor: 0,
        patch: 0,
      }),
    });
    request.$unknown = [
      {
        no: 99,
        wireType: WireType.Varint,
        data: new Uint8Array([1]),
      },
    ];

    const error = await expectConnectError(() => getSystemClient().getServerInfo(request));

    expect(error.code).toBe(Code.InvalidArgument);
    const validation = getValidationError(error);
    expect(validation.violations).toHaveLength(1);
    expect(validation.violations[0]?.ruleId).toBe("minions.request.known_fields");
    expect(validation.violations[0]?.message).toContain("unknown field 99");
  });

  it("rejects an unsupported API major with requested and supported versions", async () => {
    const error = await expectConnectError(() =>
      getSystemClient().getServerInfo(
        create(GetServerInfoRequestSchema, {
          clientName: "integration-test",
          apiVersion: create(ApiVersionSchema, {
            major: 2,
            minor: 0,
            patch: 0,
          }),
        }),
      ),
    );

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.details).toHaveLength(1);
    const details = error.findDetails(ErrorDetailSchema);
    expect(details).toHaveLength(1);
    const detail = details[0]?.detail;
    expect(detail?.case).toBe("unsupportedApiVersion");
    if (detail?.case !== "unsupportedApiVersion") {
      throw new Error("expected an unsupported API version ErrorDetail");
    }
    expect(detail.value.requested).toEqual(
      create(ApiVersionSchema, {
        major: 2,
        minor: 0,
        patch: 0,
      }),
    );
    expect(detail.value.supported).toEqual(
      create(ApiVersionSchema, {
        major: 1,
        minor: 0,
        patch: 0,
      }),
    );
  });
  it("rejects an invalid server version before binding", async () => {
    const portProbe = createServer();
    await listenOnLoopback(portProbe, 0);
    const address = portProbe.address();
    if (address === null || typeof address === "string") {
      await closeServer(portProbe);
      throw new Error("port probe did not bind to a TCP address");
    }
    const port = address.port;
    await closeServer(portProbe);

    const eventWaiter = createEventCommitWaiter();
    const clock = new FixedClock(fixtureNow);
    const { planRegistry, steeringStore } = createHostServices(
      getTemporaryDatabase().database,
      eventWaiter,
      clock,
    );
    const startup = await startDaemonServer({
      mode: "host",
      port,
      database: getTemporaryDatabase().database,
      eventWaiter,
      eventPollIntervalMs: 10,
      planRegistry,
      clock,
      steeringStore,
      system: {
        serverVersion: "not-a-semantic-version",
        health,
        runDoctor: () => Promise.resolve(doctor),
      },
    }).then(
      (server) => ({ case: "started", server }) as const,
      (error: unknown) => ({ case: "rejected", error }) as const,
    );
    eventWaiter.close();
    if (startup.case === "started") {
      await startup.server.close();
      throw new Error("invalid server version started a listener");
    }
    expect(startup.error).toBeInstanceOf(Error);
    expect(String(startup.error)).toContain("server_version");

    const rebound = createServer();
    await listenOnLoopback(rebound, port);
    await closeServer(rebound);
  });

  function getTemporaryDatabase(): TemporarySqliteDatabase {
    if (temporaryDatabase === undefined) {
      throw new Error("temporary database is not initialized");
    }
    return temporaryDatabase;
  }
});
