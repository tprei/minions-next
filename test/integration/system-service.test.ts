import { createServer, type Server } from "node:http";

import { create } from "@bufbuild/protobuf";
import { WireType } from "@bufbuild/protobuf/wire";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createEventCommitWaiter } from "@minions/adapters";
import {
  ApiVersionSchema,
  ErrorDetailSchema,
  GetServerInfoRequestSchema,
  ServerCapability,
  SystemService,
  type ValidationError,
} from "@minions/contracts";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startSystemServer, type RunningSystemServer } from "../../apps/daemon/src/server.js";

let systemServer: RunningSystemServer | undefined;
let systemClient: Client<typeof SystemService> | undefined;
let temporaryDatabase: TemporarySqliteDatabase | undefined;

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
  await new Promise<void>((resolve, reject) => {
    const rejectOnError = (error: Error): void => {
      reject(error);
    };
    server.once("error", rejectOnError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectOnError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

describe("SystemService integration", () => {
  beforeAll(async () => {
    temporaryDatabase = await TemporarySqliteDatabase.create(
      "host",
      new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000)),
    );
    systemServer = await startSystemServer({
      port: 0,
      database: temporaryDatabase.database,
      eventWaiter: createEventCommitWaiter(),
      eventPollIntervalMs: 10,
      serverVersion: "0.0.0",
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
      ServerCapability.EVENT_STREAM,
    ]);
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
    const startup = await startSystemServer({
      port,
      database: getTemporaryDatabase().database,
      eventWaiter,
      eventPollIntervalMs: 10,
      serverVersion: "not-a-semantic-version",
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
