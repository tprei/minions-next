import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { mkdirSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import {
  acquireLifecycleLock,
  createEventCommitWaiter,
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteCommandStore,
  createSecureIdGenerator,
  createSupervisorHostRegistry,
  daemonLifecyclePath,
  HostRegistryError,
  inspectLifecycleLock,
  openHostDatabase,
  openSupervisorDatabase,
  SqliteDatabaseError,
  type AcquiredLifecycleLock,
  type DaemonLifecycleRecord,
  type DaemonModeName,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
  type PlanRegistry,
  type RepositoryRegistry,
  type SupervisorHostRegistry,
} from "@minions/adapters";
import {
  DaemonMode,
  DoctorCheckKind,
  DoctorCheckSchema,
  DoctorCheckStatus,
  DoctorStatus,
  GetHealthResponseSchema,
  RunDoctorResponseSchema,
  type DoctorCheck,
  type GetHealthResponse,
  type RunDoctorResponse,
} from "@minions/contracts";
import {
  hostId,
  timestampFromEpochMilliseconds,
  type Clock,
  type HostId,
  type IdGenerator,
  type Timestamp,
} from "@minions/core";

import type { StructuredLogger } from "./logger.js";
import { startDaemonServer, type RunningDaemonServer } from "./server.js";

export type DaemonRuntimeOptions = Readonly<{
  home: string;
  mode: DaemonModeName;
  port: number;
  serverVersion: string;
  clock: Clock;
  ids: IdGenerator;
  logger: StructuredLogger;
  hostId?: HostId;
  displayName?: string;
  signal?: AbortSignal;
}>;

export type RunningDaemonRuntime = Readonly<{
  home: string;
  hostId: HostId | undefined;
  lifecycle: DaemonLifecycleRecord;
  server: RunningDaemonServer;
  close: () => Promise<void>;
}>;

export async function startDaemonRuntime(
  options: DaemonRuntimeOptions,
): Promise<RunningDaemonRuntime> {
  validatePort(options.port);
  const home = prepareHome(options.home);
  const startedAt = timestampFromEpochMilliseconds(options.clock.now());
  const lifecycle = lifecycleRecord(options, startedAt);
  const lock = acquireLifecycleLock({
    path: daemonLifecyclePath(home),
    record: lifecycle,
  });
  options.logger.log("info", "lifecycle_lock_acquired", {
    instance_id: lifecycle.instanceId,
    mode: lifecycle.mode,
    stale_lock_reconciled: lock.reconciledStaleLock,
  });

  let supervisorDatabase: ManagedSqliteDatabase | undefined;
  let hostDatabase: ManagedSqliteDatabase | undefined;
  let hostRegistry: SupervisorHostRegistry | undefined;
  let eventWaiter: EventCommitWaiter | undefined;
  let repositoryRegistry: RepositoryRegistry | undefined;
  let planRegistry: PlanRegistry | undefined;
  let localHostId: HostId | undefined;
  let server: RunningDaemonServer | undefined;

  try {
    options.signal?.throwIfAborted();
    if (options.mode !== "host") {
      supervisorDatabase = await openSupervisorDatabase({
        path: join(home, "supervisor.db"),
        backupPath: backupPath(home, lifecycle.instanceId, "supervisor"),
        clock: options.clock,
      });
      hostRegistry = createSupervisorHostRegistry({ database: supervisorDatabase });
    }
    options.signal?.throwIfAborted();

    if (options.mode === "local") {
      const candidateId = hostId(options.ids.nextId());
      const registered = await requireRegistry(hostRegistry).ensureLocalHost({
        id: candidateId,
        displayName: displayName(options.displayName),
        observedAt: startedAt,
      });
      localHostId = registered.id;
    } else if (options.mode === "host") {
      if (options.hostId === undefined) {
        throw new TypeError("host daemon mode requires a host ID");
      }
      localHostId = options.hostId;
    }
    options.signal?.throwIfAborted();

    if (options.mode !== "supervisor") {
      const activeHostId = requireHostId(localHostId);
      const hostDirectory = join(home, "hosts", activeHostId);
      mkdirSync(hostDirectory, { recursive: true, mode: 0o700 });
      hostDatabase = await openHostDatabase({
        path: join(hostDirectory, "host.db"),
        backupPath: backupPath(home, lifecycle.instanceId, `host-${activeHostId}`),
        clock: options.clock,
      });
      eventWaiter = createEventCommitWaiter();
      const commandStore = createSqliteCommandStore({
        database: hostDatabase,
        ports: { clock: options.clock, ids: options.ids },
        notifier: eventWaiter,
      });
      repositoryRegistry = createRepositoryRegistry({
        database: hostDatabase,
        commandStore,
        hostId: activeHostId,
      });
      planRegistry = createPlanRegistry({
        database: hostDatabase,
        commandStore,
        hostId: activeHostId,
      });
    }
    options.signal?.throwIfAborted();

    const health = createHealth(lifecycle, localHostId, startedAt);
    const runDoctor = createDoctor({
      mode: options.mode,
      lock,
      supervisorDatabase,
      hostDatabase,
      registry: hostRegistry,
      hostId: localHostId,
    });
    if (options.mode === "local") {
      server = await startDaemonServer({
        mode: "local",
        port: options.port,
        system: { serverVersion: options.serverVersion, health, runDoctor },
        database: requireDatabase(hostDatabase),
        eventWaiter: requireWaiter(eventWaiter),
        eventPollIntervalMs: 1_000,
        planRegistry: requirePlanRegistry(planRegistry),
        clock: options.clock,
        repository: {
          registry: requireRepositoryRegistry(repositoryRegistry),
          home,
          clock: options.clock,
        },
        hostRegistry: requireRegistry(hostRegistry),
      });
    } else if (options.mode === "host") {
      server = await startDaemonServer({
        mode: "host",
        port: options.port,
        system: { serverVersion: options.serverVersion, health, runDoctor },
        database: requireDatabase(hostDatabase),
        eventWaiter: requireWaiter(eventWaiter),
        eventPollIntervalMs: 1_000,
        planRegistry: requirePlanRegistry(planRegistry),
        clock: options.clock,
        repository: {
          registry: requireRepositoryRegistry(repositoryRegistry),
          home,
          clock: options.clock,
        },
      });
    } else {
      server = await startDaemonServer({
        mode: "supervisor",
        port: options.port,
        system: { serverVersion: options.serverVersion, health, runDoctor },
        hostRegistry: requireRegistry(hostRegistry),
      });
    }
    options.signal?.throwIfAborted();

    options.logger.log("info", "daemon_started", {
      instance_id: lifecycle.instanceId,
      mode: lifecycle.mode,
      host_id: localHostId,
      port: server.port,
    });

    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      home,
      hostId: localHostId,
      lifecycle,
      server,
      close: () => {
        closePromise ??= closeRuntime({
          server: requireServer(server),
          registry: hostRegistry,
          hostId: localHostId,
          observedAt: timestampFromEpochMilliseconds(options.clock.now()),
          hostDatabase,
          supervisorDatabase,
          eventWaiter,
          lock,
          logger: options.logger,
          instanceId: lifecycle.instanceId,
        });
        return closePromise;
      },
    });
  } catch (error) {
    let failure = error;
    try {
      await cleanupFailedStart({
        server,
        eventWaiter,
        hostDatabase,
        supervisorDatabase,
        registry: hostRegistry,
        hostId: localHostId,
        observedAt: timestampFromEpochMilliseconds(options.clock.now()),
        lock,
      });
    } catch (cleanupError) {
      failure = new AggregateError([error, cleanupError], "daemon startup and cleanup failed");
    }
    options.logger.log("error", "daemon_start_failed", {
      instance_id: lifecycle.instanceId,
      error_code: errorCode(error),
    });
    throw failure;
  }
}

export function defaultRuntimeOptions(
  input: Readonly<{
    home: string;
    mode: DaemonModeName;
    port: number;
    serverVersion: string;
    logger: StructuredLogger;
    hostId?: HostId;
    signal?: AbortSignal;
  }>,
): DaemonRuntimeOptions {
  const clock: Clock = { now: () => timestampFromEpochMilliseconds(Date.now()) };
  return {
    ...input,
    clock,
    ids: createSecureIdGenerator(clock),
  };
}

async function closeRuntime(
  input: Readonly<{
    server: RunningDaemonServer;
    registry: SupervisorHostRegistry | undefined;
    hostId: HostId | undefined;
    observedAt: Timestamp;
    hostDatabase: ManagedSqliteDatabase | undefined;
    supervisorDatabase: ManagedSqliteDatabase | undefined;
    eventWaiter: EventCommitWaiter | undefined;
    lock: AcquiredLifecycleLock;
    logger: StructuredLogger;
    instanceId: string;
  }>,
): Promise<void> {
  const errors: unknown[] = [];
  await captureFailure(errors, async () => input.server.close());
  if (input.registry !== undefined && input.hostId !== undefined) {
    await captureFailure(errors, async () =>
      input.registry?.markOffline(requireHostId(input.hostId), input.observedAt),
    );
  }
  captureSynchronousFailure(errors, () => input.eventWaiter?.close());
  await captureFailure(errors, async () => input.hostDatabase?.close());
  await captureFailure(errors, async () => input.supervisorDatabase?.close());
  captureSynchronousFailure(errors, input.lock.release);
  if (errors.length > 0) {
    throw new AggregateError(errors, "daemon shutdown did not release every resource cleanly");
  }
  input.logger.log("info", "daemon_stopped", { instance_id: input.instanceId });
}

async function cleanupFailedStart(
  input: Readonly<{
    server: RunningDaemonServer | undefined;
    eventWaiter: EventCommitWaiter | undefined;
    hostDatabase: ManagedSqliteDatabase | undefined;
    supervisorDatabase: ManagedSqliteDatabase | undefined;
    registry: SupervisorHostRegistry | undefined;
    hostId: HostId | undefined;
    observedAt: Timestamp;
    lock: AcquiredLifecycleLock;
  }>,
): Promise<void> {
  const errors: unknown[] = [];
  await captureFailure(errors, async () => input.server?.close());
  if (input.registry !== undefined && input.hostId !== undefined) {
    await captureFailure(errors, async () =>
      input.registry?.markOffline(requireHostId(input.hostId), input.observedAt),
    );
  }
  captureSynchronousFailure(errors, () => input.eventWaiter?.close());
  await captureFailure(errors, async () => input.hostDatabase?.close());
  await captureFailure(errors, async () => input.supervisorDatabase?.close());
  captureSynchronousFailure(errors, input.lock.release);
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed daemon startup could not release every resource");
  }
}

function lifecycleRecord(
  options: DaemonRuntimeOptions,
  startedAt: Timestamp,
): DaemonLifecycleRecord {
  return Object.freeze({
    instanceId: options.ids.nextId(),
    mode: options.mode,
    pid: process.pid,
    port: options.port,
    startedAtMs: startedAt,
  });
}

async function captureFailure(errors: unknown[], operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

function captureSynchronousFailure(errors: unknown[], operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}

function createHealth(
  lifecycle: DaemonLifecycleRecord,
  currentHostId: HostId | undefined,
  startedAt: Timestamp,
): GetHealthResponse {
  return create(GetHealthResponseSchema, {
    instanceId: lifecycle.instanceId,
    mode: daemonMode(lifecycle.mode),
    hostId: currentHostId,
    startedAt: protobufTimestamp(startedAt),
  });
}

type DoctorProbe = Readonly<{
  check: DoctorCheck;
  status: DoctorStatus;
}>;

function createDoctor(
  input: Readonly<{
    mode: DaemonModeName;
    lock: AcquiredLifecycleLock;
    supervisorDatabase: ManagedSqliteDatabase | undefined;
    hostDatabase: ManagedSqliteDatabase | undefined;
    registry: SupervisorHostRegistry | undefined;
    hostId: HostId | undefined;
  }>,
): () => Promise<RunDoctorResponse> {
  return () => {
    const probes: DoctorProbe[] = [probeLifecycle(input.lock)];
    if (input.mode !== "host") {
      probes.push(
        probeDatabase(
          DoctorCheckKind.SUPERVISOR_DATABASE,
          requireDatabase(input.supervisorDatabase),
        ),
      );
    }
    if (input.mode !== "supervisor") {
      probes.push(
        probeDatabase(DoctorCheckKind.HOST_DATABASE, requireDatabase(input.hostDatabase)),
      );
    }
    if (input.mode === "local") {
      probes.push(probeRegistration(requireRegistry(input.registry), requireHostId(input.hostId)));
    }
    return Promise.resolve(
      create(RunDoctorResponseSchema, {
        status: aggregateDoctorStatus(probes),
        checks: probes.map((probe) => probe.check),
      }),
    );
  };
}

function probeLifecycle(lock: AcquiredLifecycleLock): DoctorProbe {
  const inspection = inspectLifecycleLock(lock.path);
  const passed =
    inspection.state === "active" && inspection.record.instanceId === lock.record.instanceId;
  return doctorProbe(
    DoctorCheckKind.LIFECYCLE_LOCK,
    passed,
    inspection.state === "corrupt" ? DoctorStatus.CORRUPT : DoctorStatus.UNAVAILABLE,
  );
}

function probeDatabase(kind: DoctorCheckKind, database: ManagedSqliteDatabase): DoctorProbe {
  try {
    database.checkIntegrity();
    const schemaQueries = expectedSchemaQueries(kind);
    const passed = database.read((reader) => {
      for (const query of schemaQueries) {
        reader.all(query);
      }
      return true;
    });
    return doctorProbe(kind, passed, DoctorStatus.CORRUPT);
  } catch (error) {
    return doctorProbe(kind, false, databaseFailureStatus(error));
  }
}

function expectedSchemaQueries(kind: DoctorCheckKind): readonly string[] {
  if (kind === DoctorCheckKind.SUPERVISOR_DATABASE) {
    return supervisorSchemaQueries;
  }
  return hostSchemaQueries;
}

function probeRegistration(registry: SupervisorHostRegistry, currentHostId: HostId): DoctorProbe {
  try {
    const registered = registry.find(currentHostId);
    const passed = registered?.state === "online";
    return doctorProbe(DoctorCheckKind.LOCAL_HOST_REGISTRATION, passed, DoctorStatus.UNAVAILABLE);
  } catch (error) {
    if (error instanceof HostRegistryError || error instanceof SqliteDatabaseError) {
      return doctorProbe(DoctorCheckKind.LOCAL_HOST_REGISTRATION, false, DoctorStatus.UNAVAILABLE);
    }
    throw error;
  }
}

function doctorProbe(
  kind: DoctorCheckKind,
  passed: boolean,
  failureStatus: DoctorStatus,
): DoctorProbe {
  return Object.freeze({
    check: create(DoctorCheckSchema, {
      kind,
      status: passed ? DoctorCheckStatus.PASSED : DoctorCheckStatus.FAILED,
    }),
    status: passed ? DoctorStatus.HEALTHY : failureStatus,
  });
}

function databaseFailureStatus(error: unknown): DoctorStatus {
  if (error instanceof SqliteDatabaseError) {
    if (
      error.code === "checksum_mismatch" ||
      error.code === "database_newer" ||
      error.code === "invalid_migration_history"
    ) {
      return DoctorStatus.INCOMPATIBLE;
    }
    if (error.code === "database_corrupt" || error.code === "read_failed") {
      return DoctorStatus.CORRUPT;
    }
  }
  return DoctorStatus.UNAVAILABLE;
}

function aggregateDoctorStatus(probes: readonly DoctorProbe[]): DoctorStatus {
  if (probes.some((probe) => probe.status === DoctorStatus.CORRUPT)) {
    return DoctorStatus.CORRUPT;
  }
  if (probes.some((probe) => probe.status === DoctorStatus.INCOMPATIBLE)) {
    return DoctorStatus.INCOMPATIBLE;
  }
  if (probes.some((probe) => probe.status === DoctorStatus.UNAVAILABLE)) {
    return DoctorStatus.UNAVAILABLE;
  }
  return DoctorStatus.HEALTHY;
}

function daemonMode(mode: DaemonModeName): DaemonMode {
  switch (mode) {
    case "local":
      return DaemonMode.LOCAL;
    case "supervisor":
      return DaemonMode.SUPERVISOR;
    case "host":
      return DaemonMode.HOST;
  }
}

function protobufTimestamp(milliseconds: Timestamp) {
  return create(TimestampSchema, {
    seconds: BigInt(Math.floor(milliseconds / 1_000)),
    nanos: (milliseconds % 1_000) * 1_000_000,
  });
}

function prepareHome(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return realpathSync(absolute);
}

function backupPath(home: string, instanceId: string, database: string): string {
  const directory = join(home, "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${instanceId}-${database}.db`);
}

function displayName(configured: string | undefined): string {
  const value = (configured ?? hostname()).trim();
  if (value.length === 0 || value.length > 128) {
    throw new TypeError("local host display name must contain 1 to 128 characters");
  }
  return value;
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("daemon port must be between 1 and 65535");
  }
}

function requireRegistry(value: SupervisorHostRegistry | undefined): SupervisorHostRegistry {
  if (value === undefined) {
    throw new Error("supervisor host registry is not initialized");
  }
  return value;
}

function requireDatabase(value: ManagedSqliteDatabase | undefined): ManagedSqliteDatabase {
  if (value === undefined) {
    throw new Error("host database is not initialized");
  }
  return value;
}

function requireWaiter(value: EventCommitWaiter | undefined): EventCommitWaiter {
  if (value === undefined) {
    throw new Error("event commit waiter is not initialized");
  }
  return value;
}

function requireHostId(value: HostId | undefined): HostId {
  if (value === undefined) {
    throw new Error("host identity is not initialized");
  }
  return value;
}

function requireRepositoryRegistry(value: RepositoryRegistry | undefined): RepositoryRegistry {
  if (value === undefined) {
    throw new Error("repository registry is not initialized");
  }
  return value;
}

function requirePlanRegistry(value: PlanRegistry | undefined): PlanRegistry {
  if (value === undefined) {
    throw new Error("plan registry is not initialized");
  }
  return value;
}

function requireServer(value: RunningDaemonServer | undefined): RunningDaemonServer {
  if (value === undefined) {
    throw new Error("daemon server is not initialized");
  }
  return value;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && /^[A-Za-z0-9_]+$/u.test(code)) {
      return code;
    }
  }
  return "unknown_error";
}

const supervisorSchemaQueries = [
  "SELECT version FROM schema_migrations LIMIT 0",
  "SELECT id FROM execution_hosts LIMIT 0",
  "SELECT id FROM ssh_profiles LIMIT 0",
  "SELECT host_id FROM host_projection_cache LIMIT 0",
  "SELECT id FROM paired_devices LIMIT 0",
  "SELECT id FROM device_sessions LIMIT 0",
  "SELECT id FROM maintenance_sessions LIMIT 0",
  "SELECT id FROM maintenance_actions LIMIT 0",
  "SELECT sequence FROM maintenance_events LIMIT 0",
] as const;

const hostSchemaQueries = [
  "SELECT version FROM schema_migrations LIMIT 0",
  "SELECT id FROM repositories LIMIT 0",
  "SELECT repository_id FROM repository_registrations LIMIT 0",
  "SELECT repository_id FROM repository_features LIMIT 0",
  "SELECT id FROM trees LIMIT 0",
  "SELECT id FROM plan_revisions LIMIT 0",
  "SELECT id FROM nodes LIMIT 0",
  "SELECT node_id FROM node_acceptance_criteria LIMIT 0",
  "SELECT node_id FROM node_artifact_inputs LIMIT 0",
  "SELECT id FROM attempts LIMIT 0",
  "SELECT digest FROM content_blobs LIMIT 0",
  "SELECT id FROM artifacts LIMIT 0",
  "SELECT attempt_id FROM harness_bindings LIMIT 0",
  "SELECT attempt_id FROM workspace_bindings LIMIT 0",
  "SELECT id FROM gate_runs LIMIT 0",
  "SELECT id FROM pull_request_observations LIMIT 0",
  "SELECT id FROM restack_runs LIMIT 0",
  "SELECT id FROM operator_commands LIMIT 0",
  "SELECT id FROM external_operations LIMIT 0",
  "SELECT command_id FROM idempotency_records LIMIT 0",
  "SELECT sequence FROM events LIMIT 0",
  "SELECT id FROM outbox LIMIT 0",
] as const;
