import { existsSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  createSupervisorHostRegistry,
  daemonLifecyclePath,
  inspectLifecycleLock,
  LifecycleLockError,
  openSupervisorDatabase,
  type ManagedSqliteDatabase,
} from "@minions/adapters";
import {
  DaemonMode,
  DoctorCheckKind,
  DoctorCheckStatus,
  DoctorStatus,
  ExecutionHostKind,
  ExecutionHostState,
  HostService,
  ListHostsRequestSchema,
  SystemService,
} from "@minions/contracts";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { describe, expect, it } from "vitest";

import {
  DaemonStartupError,
  createStructuredLogger,
  startDaemonRuntime,
  type RunningDaemonRuntime,
  type StructuredLogger,
} from "@minions/daemon";

const STARTED_AT_MS = 1_700_000_000_000;
const RESTARTED_AT_MS = STARTED_AT_MS + 1_000;
const FIRST_INSTANCE_ID = "01900000-0000-7000-8000-000000000001";
const FIRST_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000002";
const DUPLICATE_INSTANCE_ID = "01900000-0000-7000-8000-000000000003";
const RESTART_INSTANCE_ID = "01900000-0000-7000-8000-000000000004";
const RECONCILE_INSTANCE_ID = "01900000-0000-7000-8000-00000000000a";
const RECONCILE_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-00000000000b";
const RECONCILE_RESTART_INSTANCE_ID = "01900000-0000-7000-8000-00000000000c";
const MISSING_DIGEST = "ccdd000000000000000000000000000000000000000000000000000000000000";
const CORRUPT_DIGEST = "eeff000000000000000000000000000000000000000000000000000000000000";
const ORPHAN_DIGEST = "aabb000000000000000000000000000000000000000000000000000000000000";
const TEMPORARY_BLOB_ID = "01900000-0000-7000-8000-00000000000d";
const RESTART_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000005";
const FAILED_INSTANCE_ID = "01900000-0000-7000-8000-000000000006";
const FAILED_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000007";
const CORRUPT_INSTANCE_ID = "01900000-0000-7000-8000-000000000008";
const CORRUPT_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000009";
const LOCAL_DISPLAY_NAME = "integration-local-host";
const SECRET_TOKEN = "daemon-runtime-secret-token";
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_DAEMON_MESSAGE_BYTES = 86 * 1024 * 1024;

type RuntimeClients = Readonly<{
  system: Client<typeof SystemService>;
  hosts: Client<typeof HostService>;
}>;

type LogCapture = Readonly<{
  lines: string[];
  stream: Writable;
}>;

function createLogCapture(): LogCapture {
  const lines: string[] = [];
  const stream = new Writable({
    write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { lines, stream };
}

function connectRuntime(baseUrl: string): RuntimeClients {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "1.1",
    useBinaryFormat: true,
    nodeOptions: { agent: false },
  });
  return {
    system: createClient(SystemService, transport),
    hosts: createClient(HostService, transport),
  };
}

function runtimeOptions(
  home: string,
  port: number,
  clock: FixedClock,
  ids: SequenceIdGenerator,
  logger: StructuredLogger,
) {
  return {
    home,
    mode: "local" as const,
    port,
    serverVersion: "1.0.0",
    clock,
    ids,
    logger,
    displayName: LOCAL_DISPLAY_NAME,
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const rejectOnError = (error: Error): void => {
    reject(error);
  };
  server.once("error", rejectOnError);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", rejectOnError);
    resolve(undefined);
  });
  try {
    await promise;
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("loopback port reservation did not bind to a TCP address");
    }
    return address.port;
  } finally {
    server.off("error", rejectOnError);
    if (server.listening) {
      await closeServer(server);
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  server.close((error) => {
    if (error === undefined) {
      resolve(undefined);
      return;
    }
    reject(error);
  });
  server.closeAllConnections();
  await promise;
}

async function closeWritable(stream: Writable): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  stream.end((error?: Error | null) => {
    if (error === undefined || error === null) {
      resolve(undefined);
      return;
    }
    reject(error);
  });
  await promise;
}

async function expectActiveLifecycleLock(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof LifecycleLockError)) {
      throw error;
    }
    expect(error.code).toBe("active_daemon");
    expect(error.record?.instanceId).toBe(FIRST_INSTANCE_ID);
    return;
  }
  throw new Error("expected duplicate daemon startup to fail");
}

describe("daemon runtime integration", () => {
  it("composes local startup, Connect services, locking, shutdown, and restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-runtime-"));
    const port = await reserveLoopbackPort();
    const capture = createLogCapture();
    const logger = createStructuredLogger({
      stream: capture.stream,
      now: () => STARTED_AT_MS,
    });
    const firstClock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    let runtime: RunningDaemonRuntime | undefined;
    let restartedRuntime: RunningDaemonRuntime | undefined;

    try {
      logger.log("info", "credential_probe", {
        details: { request: { access_token: SECRET_TOKEN } },
      });
      expect(capture.lines.join("")).not.toContain(SECRET_TOKEN);
      expect(capture.lines.join("")).toContain('"access_token":"[REDACTED]"');

      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          firstClock,
          new SequenceIdGenerator([FIRST_INSTANCE_ID, FIRST_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const firstHostId = runtime.hostId;
      if (firstHostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }

      expect(runtime.server.baseUrl).toBe(`http://127.0.0.1:${String(port)}`);
      expect(runtime.server.port).toBe(port);
      expect(existsSync(join(home, "supervisor.db"))).toBe(true);
      expect(existsSync(join(home, "hosts", firstHostId, "host.db"))).toBe(true);
      expect(inspectLifecycleLock(daemonLifecyclePath(home)).state).toBe("active");

      const clients = connectRuntime(runtime.server.baseUrl);
      const health = await clients.system.getHealth({});
      expect(health.instanceId).toBe(runtime.lifecycle.instanceId);
      expect(health.mode).toBe(DaemonMode.LOCAL);
      expect(health.hostId).toBe(firstHostId);
      expect(health.startedAt).toEqual(
        create(TimestampSchema, {
          seconds: BigInt(Math.floor(STARTED_AT_MS / 1_000)),
          nanos: (STARTED_AT_MS % 1_000) * 1_000_000,
        }),
      );

      const doctor = await clients.system.runDoctor({});
      expect(doctor.status).toBe(DoctorStatus.HEALTHY);
      expect(doctor.checks).toHaveLength(4);
      expect(doctor.checks.map((check) => [check.kind, check.status])).toEqual([
        [DoctorCheckKind.LIFECYCLE_LOCK, DoctorCheckStatus.PASSED],
        [DoctorCheckKind.SUPERVISOR_DATABASE, DoctorCheckStatus.PASSED],
        [DoctorCheckKind.HOST_DATABASE, DoctorCheckStatus.PASSED],
        [DoctorCheckKind.LOCAL_HOST_REGISTRATION, DoctorCheckStatus.PASSED],
      ]);

      const hosts = await clients.hosts.listHosts(
        create(ListHostsRequestSchema, { pageSize: 100 }),
      );
      expect(hosts.hosts).toHaveLength(1);
      expect(hosts.nextPageToken).toBeUndefined();
      const localHost = hosts.hosts[0];
      expect(localHost?.id).toBe(firstHostId);
      expect(localHost?.kind).toBe(ExecutionHostKind.LOCAL);
      expect(localHost?.state).toBe(ExecutionHostState.ONLINE);

      await expectActiveLifecycleLock(() =>
        startDaemonRuntime(
          runtimeOptions(
            home,
            port,
            firstClock,
            new SequenceIdGenerator([DUPLICATE_INSTANCE_ID]),
            logger,
          ),
        ),
      );

      await runtime.close();
      runtime = undefined;
      expect(inspectLifecycleLock(daemonLifecyclePath(home)).state).toBe("absent");

      let persistedDatabase: ManagedSqliteDatabase | undefined;
      try {
        persistedDatabase = await openSupervisorDatabase({
          path: join(home, "supervisor.db"),
          clock: firstClock,
        });
        const persistedRegistry = createSupervisorHostRegistry({ database: persistedDatabase });
        const offlineHost = persistedRegistry.find(firstHostId);
        expect(offlineHost?.id).toBe(firstHostId);
        expect(offlineHost?.state).toBe("offline");
      } finally {
        await persistedDatabase?.close();
      }

      const restartedClock = new FixedClock(timestampFromEpochMilliseconds(RESTARTED_AT_MS));
      restartedRuntime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          restartedClock,
          new SequenceIdGenerator([RESTART_INSTANCE_ID, RESTART_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      expect(restartedRuntime.hostId).toBe(firstHostId);
      expect(restartedRuntime.server.baseUrl).toBe(`http://127.0.0.1:${String(port)}`);

      const restartedClients = connectRuntime(restartedRuntime.server.baseUrl);
      const restartedHealth = await restartedClients.system.getHealth({});
      expect(restartedHealth.instanceId).toBe(restartedRuntime.lifecycle.instanceId);
      expect(restartedHealth.mode).toBe(DaemonMode.LOCAL);
      expect(restartedHealth.hostId).toBe(firstHostId);

      const restartedHosts = await restartedClients.hosts.listHosts(
        create(ListHostsRequestSchema, { pageSize: 100 }),
      );
      expect(restartedHosts.hosts).toHaveLength(1);
      expect(restartedHosts.hosts[0]?.id).toBe(firstHostId);
      expect(restartedHosts.hosts[0]?.state).toBe(ExecutionHostState.ONLINE);

      await restartedRuntime.close();
      restartedRuntime = undefined;
      expect(inspectLifecycleLock(daemonLifecyclePath(home)).state).toBe("absent");
    } finally {
      await restartedRuntime?.close();
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  });

  it("reconciles temporary and orphan blobs before serving", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-reconcile-"));
    const port = await reserveLoopbackPort();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    let runtime: RunningDaemonRuntime | undefined;
    try {
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([RECONCILE_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const currentHostId = runtime.hostId;
      if (currentHostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      await runtime.close();
      runtime = undefined;

      const digestDirectory = join(home, "hosts", currentHostId, "blobs", "sha256", "aa", "bb");
      const orphanPath = join(digestDirectory, ORPHAN_DIGEST);
      const temporaryPath = join(digestDirectory, `.tmp-${TEMPORARY_BLOB_ID}`);
      await mkdir(digestDirectory, { recursive: true });
      await writeFile(orphanPath, Buffer.from("orphan"));
      await writeFile(temporaryPath, Buffer.from("temporary"));

      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([RECONCILE_RESTART_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      expect(existsSync(orphanPath)).toBe(false);
      expect(existsSync(temporaryPath)).toBe(false);
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  });

  it("refuses to start through a symlinked host directory ancestor", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "minions-daemon-symlink-outside-"));
    const port = await reserveLoopbackPort();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    let runtime: RunningDaemonRuntime | undefined;
    try {
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([RECONCILE_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const currentHostId = runtime.hostId;
      if (currentHostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      await runtime.close();
      runtime = undefined;

      // Replace the already-provisioned host directory with a symlink to an
      // attacker/adversary-controlled directory outside `home`. A restart
      // must refuse to create/traverse through it (P1, review #13: the
      // previous `mkdirSync(hostDirectory, { recursive: true })` would
      // follow it, letting canonical blob writes/reads/deletes escape the
      // host artifact boundary).
      await rm(join(home, "hosts", currentHostId), { recursive: true, force: true });
      symlinkSync(outside, join(home, "hosts", currentHostId));

      await expect(
        startDaemonRuntime(
          runtimeOptions(
            home,
            port,
            clock,
            new SequenceIdGenerator([RECONCILE_RESTART_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
            logger,
          ),
        ),
      ).rejects.toThrow(/symlink/u);
      expect(existsSync(join(outside, "host.db"))).toBe(false);
      expect(existsSync(join(outside, "blobs"))).toBe(false);
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("refuses startup when required blobs are missing or corrupt", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-reconcile-failure-"));
    const port = await reserveLoopbackPort();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    let runtime: RunningDaemonRuntime | undefined;
    try {
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([RECONCILE_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const currentHostId = runtime.hostId;
      if (currentHostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      await runtime.close();
      runtime = undefined;

      const hostDatabase = new DatabaseSync(join(home, "hosts", currentHostId, "host.db"));
      try {
        hostDatabase.exec(`
          INSERT INTO content_blobs (
            digest,
            size_bytes,
            media_type,
            relative_path,
            retention_kind,
            created_at_ms,
            verified_at_ms
          ) VALUES
            ('${MISSING_DIGEST}', 1, 'text/plain', 'sha256/cc/dd/${MISSING_DIGEST}', 'active', 1, 1),
            ('${CORRUPT_DIGEST}', 3, 'text/plain', 'sha256/ee/ff/${CORRUPT_DIGEST}', 'active', 1, 1)
        `);
      } finally {
        hostDatabase.close();
      }
      const corruptPath = join(
        home,
        "hosts",
        currentHostId,
        "blobs",
        "sha256",
        "ee",
        "ff",
        CORRUPT_DIGEST,
      );
      await mkdir(dirname(corruptPath), { recursive: true });
      await writeFile(corruptPath, Buffer.from("bad"));

      const failure = await expectDaemonStartupError(() =>
        startDaemonRuntime(
          runtimeOptions(
            home,
            port,
            clock,
            new SequenceIdGenerator([RECONCILE_RESTART_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
            logger,
          ),
        ),
      );
      expect(failure.code).toBe("blob_reconciliation_failed");
      expect(failure.missingDigests).toEqual([MISSING_DIGEST]);
      expect(failure.corruptDigests).toEqual([CORRUPT_DIGEST]);
      expect(inspectLifecycleLock(daemonLifecyclePath(home)).state).toBe("absent");
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  });

  it("rejects unknown JSON fields at the transport boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-json-fields-"));
    const port = await reserveLoopbackPort();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    let runtime: RunningDaemonRuntime | undefined;
    try {
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([RECONCILE_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const response = await fetch(`${runtime.server.baseUrl}/minions.v1.SystemService/GetHealth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unexpected: true }),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(400);
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  });

  it("accepts a 64 MiB artifact in JSON before strict field rejection", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-json-artifact-limit-"));
    const port = await reserveLoopbackPort();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    let runtime: RunningDaemonRuntime | undefined;
    try {
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([RECONCILE_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const content = Buffer.alloc(MAX_ARTIFACT_BYTES).toString("base64");
      const body = JSON.stringify({ content, unexpected: true });
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_DAEMON_MESSAGE_BYTES);
      const response = await fetch(
        `${runtime.server.baseUrl}/minions.v1.ArtifactService/CreateArtifact`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      );
      await response.arrayBuffer();
      expect(response.status).toBe(400);
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  });

  it("rejects over-limit transport messages before dispatch", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-message-limit-"));
    const port = await reserveLoopbackPort();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    let runtime: RunningDaemonRuntime | undefined;
    try {
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([RECONCILE_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      const incoming = request(
        new URL("/minions.v1.SystemService/GetHealth", runtime.server.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_DAEMON_MESSAGE_BYTES + 1),
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            resolve(response.statusCode ?? 0);
          });
        },
      );
      incoming.once("error", reject);
      incoming.end("{}");
      await expect(promise).resolves.toBe(429);
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  });

  it("drains a partial request body during shutdown", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-partial-request-"));
    const port = await reserveLoopbackPort();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    let runtime: RunningDaemonRuntime | undefined;
    let socket: Socket | undefined;
    try {
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([RECONCILE_INSTANCE_ID, RECONCILE_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const connected = Promise.withResolvers<undefined>();
      socket = createConnection({ host: "127.0.0.1", port: runtime.server.port });
      socket.once("connect", () => {
        connected.resolve(undefined);
      });
      socket.on("error", connected.reject);
      await connected.promise;
      socket.write(
        `POST /minions.v1.SystemService/GetHealth HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: keep-alive\r\n\r\n{`,
      );

      const closePromise = runtime.server.close();
      await closePromise;
    } finally {
      socket?.destroy();
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  }, 15_000);

  it("marks the local host offline when listener startup fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-failed-start-"));
    const occupied = createServer();
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
    await promise;
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("occupied listener did not bind to a TCP address");
    }
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    try {
      await expect(
        startDaemonRuntime(
          runtimeOptions(
            home,
            address.port,
            clock,
            new SequenceIdGenerator([FAILED_INSTANCE_ID, FAILED_HOST_CANDIDATE_ID]),
            logger,
          ),
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(inspectLifecycleLock(daemonLifecyclePath(home)).state).toBe("absent");
      const database = await openSupervisorDatabase({ path: join(home, "supervisor.db"), clock });
      try {
        const hosts = createSupervisorHostRegistry({ database }).list({
          afterId: undefined,
          limit: 1,
        });
        expect(hosts).toHaveLength(1);
        expect(hosts[0]?.state).toBe("offline");
      } finally {
        await database.close();
      }
    } finally {
      await closeServer(occupied);
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  });

  it("reports a replaced required host table as corrupt", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-daemon-corrupt-doctor-"));
    const port = await reserveLoopbackPort();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const capture = createLogCapture();
    const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
    let runtime: RunningDaemonRuntime | undefined;
    try {
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([CORRUPT_INSTANCE_ID, CORRUPT_HOST_CANDIDATE_ID]),
          logger,
        ),
      );
      const currentHostId = runtime.hostId;
      if (currentHostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const database = new DatabaseSync(join(home, "hosts", currentHostId, "host.db"));
      try {
        database.exec(
          "PRAGMA foreign_keys = OFF; ALTER TABLE events RENAME TO displaced_events; CREATE TABLE events (placeholder TEXT)",
        );
      } finally {
        database.close();
      }
      const doctor = await connectRuntime(runtime.server.baseUrl).system.runDoctor({});
      expect(doctor.status).toBe(DoctorStatus.CORRUPT);
      expect(
        doctor.checks.find((check) => check.kind === DoctorCheckKind.HOST_DATABASE)?.status,
      ).toBe(DoctorCheckStatus.FAILED);
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(home, { force: true, recursive: true });
    }
  });

  it("redacts nested token values from structured logs", async () => {
    const capture = createLogCapture();
    try {
      const logger = createStructuredLogger({
        stream: capture.stream,
        now: () => STARTED_AT_MS,
      });
      logger.log("info", "credential_probe", {
        nested: { metadata: { refresh_token: SECRET_TOKEN } },
      });
      const output = capture.lines.join("");
      expect(output).not.toContain(SECRET_TOKEN);
      expect(output).toContain('"refresh_token":"[REDACTED]"');
    } finally {
      await closeWritable(capture.stream);
    }
  });
});

async function expectDaemonStartupError(
  action: () => Promise<unknown>,
): Promise<DaemonStartupError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof DaemonStartupError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected daemon startup to fail");
}
