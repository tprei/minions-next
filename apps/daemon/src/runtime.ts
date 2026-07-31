import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import {
  acquireLifecycleLock,
  AuthBrokerError,
  AuthGatewayError,
  createAuthBrokerManager,
  createAuthGatewayManager,
  createCredentialVault,
  createEventCommitWaiter,
  createExecutionCoordinator,
  createFileContentBlobStore,
  createPlanRegistry,
  createProviderAdmissionProxy,
  createRepositoryRegistry,
  createSqliteArtifactRegistry,
  createSqliteCheckpointStore,
  createSqliteCommandStore,
  createSqliteRecoveryStore,
  createSqliteSteeringCommandStore,
  createSqliteTranscriptStore,
  createSqliteVcsChangeBindingStore,
  createSecureIdGenerator,
  createSupervisorHostRegistry,
  daemonLifecyclePath,
  ensureJjCapability,
  createJjCentralRepoManager,
  HostRegistryError,
  inspectLifecycleLock,
  openHostDatabase,
  openSupervisorDatabase,
  resolveOmpPath,
  SqliteDatabaseError,
  type AcquiredLifecycleLock,
  type AuthBrokerManager,
  type AuthGatewayManager,
  type CredentialVault,
  type DaemonLifecycleRecord,
  type DaemonModeName,
  type EventCommitWaiter,
  type JjCapabilityErrorCode,
  type JjCentralRepoManager,
  type ManagedSqliteDatabase,
  type PlanRegistry,
  type ProviderAdmissionProxy,
  type RepositoryRegistry,
  type SupervisorHostRegistry,
  type SystemdCredsKeyMode,
  type VcsChangeBindingStore,
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
  validateAdmissionPolicy,
  type AdmissionEventPayload,
  type AdmissionPolicyConfig,
  type ArtifactRegistry,
  type Clock,
  type ContentBlobStore,
  type ContentHash,
  type ExecutionCoordinator,
  type HarnessAdapter,
  type HostId,
  type IdGenerator,
  type RecoveryGateProfile,
  type RecoveryStore,
  type SandboxLifecycle,
  type SchedulerStore,
  type SteeringCommandStore,
  type Timestamp,
  type VcsBackend,
} from "@minions/core";

import type { StructuredLogger } from "./logger.js";
import { startDaemonServer, type RunningDaemonServer } from "./server.js";
import type { TreeServiceRevsetOptions } from "./tree-service.js";
import { createDeviceSessionStore } from "./device-session-store.js";
import { createSystemRecoveryRestarter, type RecoveryRestarter } from "./recovery-restart.js";

/**
 * Default gate profile for the `restart` recovery-action kind (PR 56 —
 * maintenance-elevation-recovery). Fail-closed: only `restart` is grantable — every
 * other {@link RecoveryActionKind} is honestly rejected by the service as having no
 * adapter in this revision (spec-sanctioned incremental delivery). A single human
 * approval is sufficient, and a grant is valid for 15 minutes.
 */
const RECOVERY_GATE_PROFILE: RecoveryGateProfile = Object.freeze({
  allowedKinds: ["restart"] as const,
  requiredApprovals: 1,
  maxGrantDurationMs: 900_000,
});

export type DaemonStartupErrorCode = "blob_reconciliation_failed" | "auth_runtime_failed";

/**
 * PR 19 auth-broker/gateway startup failure. Carries a stable `code` so the daemon
 * start-failed log line distinguishes vault- unavailable from broker-spawn-failed.
 */
export class AuthRuntimeStartupError extends Error {
  readonly code: AuthRuntimeStartupErrorCode;

  constructor(code: AuthRuntimeStartupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthRuntimeStartupError";
    this.code = code;
  }
}

export type AuthRuntimeStartupErrorCode = "vault_unavailable" | "broker_failed" | "gateway_failed";

export class DaemonStartupError extends Error {
  readonly code: DaemonStartupErrorCode;
  readonly missingDigests: readonly ContentHash[];
  readonly corruptDigests: readonly ContentHash[];

  constructor(
    missingDigests: readonly ContentHash[],
    corruptDigests: readonly ContentHash[],
    options?: ErrorOptions,
  ) {
    super(
      `content blob reconciliation failed (missing: ${missingDigests.join(", ") || "none"}; corrupt: ${corruptDigests.join(", ") || "none"})`,
      options,
    );
    this.name = "DaemonStartupError";
    this.code = "blob_reconciliation_failed";
    this.missingDigests = Object.freeze([...missingDigests]);
    this.corruptDigests = Object.freeze([...corruptDigests]);
  }
}

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
  /**
   * OPTIONAL per-host OMP auth-broker + auth-gateway startup ordering (PR 19).
   * When enabled, the daemon boots the broker → gateway → harnesses sequence and
   * recovers the control bearer noninteractively from the credential vault. If
   * the vault backend is unavailable the daemon fails closed BEFORE accepting any
   * harness session (acceptance 11: missing secure storage fails registration).
   * When omitted/`enabled === false`, daemon behaviour is unchanged.
   */
  authBroker?: AuthBrokerRuntimeOptions;
  /**
   * OPTIONAL per-credential provider admission proxy (PR 20). When enabled, the daemon
   * constructs a {@link ProviderAdmissionProxy} in front of the auth gateway on the
   * attempt-execution path and emits admission events (pause/resume/queued/…) into the
   * daemon log surface. Default policy is one in-flight request per credential; raising
   * a limit requires an explicit audited override (HAR-09/HAR-10/OPS-05). When omitted,
   * daemon behaviour is unchanged.
   */
  providerAdmission?: ProviderAdmissionRuntimeOptions;
  /**
   * OPTIONAL per-host engine-managed jj capability probe (PR 21 / GIT-14). When enabled, the
   * daemon doctor runs {@link ensureJjCapability} against the host tools directory (downloading
   * and digest-verifying the pinned jj binary on demand) and reports jj health. The probe is
   * opt-in; omitted, daemon and doctor behaviour is unchanged. Node-start gating lands in a
   * later PR — for PR 21 this only reports health via the doctor.
   */
  jjCapability?: JjCapabilityRuntimeOptions;
  /**
   * OPTIONAL opt-in node-execution coordinator (PR 23). When enabled, the daemon
   * composes an {@link ExecutionCoordinator} from its host database (transcript +
   * checkpoint stores), its artifact registry, and its clock/ids/logger over the
   * host-injected scheduler, harness, sandbox, and VCS ports, then exposes it on
   * the running runtime. Omitted, daemon behaviour is unchanged. Full RPC service
   * exposure is deferred — callers drive {@link ExecutionCoordinator.runNode}.
   */
  nodeExecution?: NodeExecutionRuntimeOptions;
  /**
   * PR 52: when set, the daemon serves the built web app (apps/web/dist) from this
   * directory for non-RPC GET requests, making the PWA and RPC API same-origin.
   */
  webDistDir?: string;
  /**
   * OPTIONAL remote (phone) access surface (PR 57 — private-phone-pairing). When
   * enabled, the daemon constructs a process-lifetime {@link DeviceSessionStore},
   * shares it between the pairing RPCs and the remote-access interceptor, and binds
   * every interface instead of loopback only (see `server.ts`'s `remoteAccess` doc for
   * the full security model). Only meaningful for "local"/"host" mode, which is where
   * the mutation RPCs a phone session gates actually live; ignored for "supervisor"
   * mode. Omitted, daemon behaviour is unchanged (REMOTE-01's loopback-only default).
   */
  remoteAccess?: RemoteAccessRuntimeOptions;
}>;

export type RemoteAccessRuntimeOptions = Readonly<{
  enabled: true;
}>;

export type ProviderAdmissionRuntimeOptions = Readonly<{
  enabled: true;
  /** Unvalidated policy config; validated (fail-closed) at construction. */
  policy: AdmissionPolicyConfig;
  /** Max queued requests per credential (proxy default 64). */
  maxQueuePerCredential?: number;
  /** Retained admission event history for late subscribers (proxy default 1024). */
  maxEventHistory?: number;
}>;

export type AuthBrokerRuntimeOptions = Readonly<{
  enabled: true;
  /** Host identifier whose vault namespace holds the control bearer. */
  hostId: HostId;
  /** Absolute path to the `omp` executable. */
  ompPath: string;
  /** Optional vault store directory override (systemd-creds backend). */
  vaultStoreDirectory?: string;
  /** Optional override for the systemd-creds binary path (testing/diagnostics). */
  vaultSystemdCredsPath?: string;
  /** Optional `systemd-creds --with-key=` mode override (default `host`). */
  vaultKeyMode?: SystemdCredsKeyMode;
  /** Bind host for the broker + gateway loopback listeners (default 127.0.0.1). */
  bindHost?: string;
}>;

export type JjCapabilityRuntimeOptions = Readonly<{
  enabled: true;
  /** Absolute host-local directory the engine owns for the pinned jj tool install. */
  toolsDirectory: string;
}>;

/**
 * Host-injected ports for the opt-in node-execution coordinator (PR 23). The
 * daemon owns its host database + artifact registry + clock/ids/logger; the
 * scheduler, harness, sandbox, and VCS backend are injected because the daemon
 * does not manage their lifecycles in PR 23.
 */
export type NodeExecutionRuntimeOptions = Readonly<{
  enabled: true;
  /** Host-injected scheduler store (the daemon does not own its lifecycle). */
  scheduler: SchedulerStore;
  /** Host-injected harness adapter (the OMP adapter or a test double). */
  harness: HarnessAdapter;
  /** Host-injected sandbox lifecycle. */
  sandbox: SandboxLifecycle;
  /** Host-injected VCS backend. */
  vcs: VcsBackend;
  /** Optional bounded-output capture limit override in bytes (HAR-08). */
  outputCaptureLimitBytes?: number;
}>;

/** Auth subsystem handles held by {@link startDaemonRuntime} for graceful close. */
export type RunningAuthRuntime = Readonly<{
  broker: AuthBrokerManager;
  gateway: AuthGatewayManager;
  close: () => Promise<void>;
}>;

export type RunningDaemonRuntime = Readonly<{
  home: string;
  hostId: HostId | undefined;
  lifecycle: DaemonLifecycleRecord;
  server: RunningDaemonServer;
  /** The admission proxy when enabled; `undefined` when admission is disabled. */
  providerAdmission: ProviderAdmissionProxy | undefined;
  /** The node-execution coordinator when enabled; `undefined` when disabled. */
  executionCoordinator: ExecutionCoordinator | undefined;
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
  let steeringStore: SteeringCommandStore | undefined;
  let artifactRegistry: ArtifactRegistry | undefined;
  let vcsChangeBindingStore: VcsChangeBindingStore | undefined;
  let blobStore: ContentBlobStore | undefined;
  let recoveryStore: RecoveryStore | undefined;
  let recoveryRestart: RecoveryRestarter | undefined;
  let localHostId: HostId | undefined;
  let server: RunningDaemonServer | undefined;
  let authRuntime: RunningAuthRuntime | undefined;
  let authVault: CredentialVault | undefined;
  let authBrokerHealth: (() => Promise<unknown>) | undefined;
  let authGatewayHealth: (() => Promise<unknown>) | undefined;
  let providerAdmission: ProviderAdmissionProxy | undefined;
  let executionCoordinator: ExecutionCoordinator | undefined;
  let admissionEventLoop: Promise<void> | undefined;

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
      const hostDirectory = ensureHostDirectorySync(home, activeHostId);
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
      blobStore = createFileContentBlobStore({
        rootPath: join(hostDirectory, "blobs"),
        clock: options.clock,
        ids: options.ids,
      });
      artifactRegistry = createSqliteArtifactRegistry({
        database: hostDatabase,
        commandStore,
        hostId: activeHostId,
      });
      steeringStore = createSqliteSteeringCommandStore({
        database: hostDatabase,
        commandStore,
        ports: { clock: options.clock, ids: options.ids },
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
      vcsChangeBindingStore = createSqliteVcsChangeBindingStore({ database: hostDatabase });
      recoveryStore = createSqliteRecoveryStore({ database: hostDatabase });
      recoveryRestart = createSystemRecoveryRestarter({ logger: options.logger });
      if (options.nodeExecution?.enabled) {
        const nodeExecution = options.nodeExecution;
        executionCoordinator = createExecutionCoordinator({
          scheduler: nodeExecution.scheduler,
          sandbox: nodeExecution.sandbox,
          harness: nodeExecution.harness,
          vcs: nodeExecution.vcs,
          artifacts: requireArtifactRegistry(artifactRegistry),
          transcripts: createSqliteTranscriptStore({ database: requireDatabase(hostDatabase) }),
          checkpoints: createSqliteCheckpointStore({ database: requireDatabase(hostDatabase) }),
          clock: options.clock,
          ids: options.ids,
          logger: options.logger,
          ...(nodeExecution.outputCaptureLimitBytes === undefined
            ? {}
            : { outputCaptureLimitBytes: nodeExecution.outputCaptureLimitBytes }),
        });
      }
    }
    options.signal?.throwIfAborted();
    if (options.mode !== "supervisor") {
      const reconciliation = await requireBlobStore(blobStore).reconcile(
        requireArtifactRegistry(artifactRegistry).expectedBlobs(),
      );
      if (reconciliation.missingDigests.length > 0 || reconciliation.corruptDigests.length > 0) {
        throw new DaemonStartupError(reconciliation.missingDigests, reconciliation.corruptDigests);
      }
      options.signal?.throwIfAborted();
    }

    options.signal?.throwIfAborted();
    if (options.authBroker?.enabled) {
      // PR 19: per-host broker → gateway → harnesses startup ordering. The vault
      // must be available BEFORE we touch harness sessions — acceptance 11 fail-closed.
      const authOptions = options.authBroker;
      const vaultOptions: {
        storeDirectory?: string;
        systemdCredsPath?: string;
        systemdCredsKeyMode?: SystemdCredsKeyMode;
      } = {};
      if (authOptions.vaultStoreDirectory !== undefined) {
        vaultOptions.storeDirectory = authOptions.vaultStoreDirectory;
      }
      if (authOptions.vaultSystemdCredsPath !== undefined) {
        vaultOptions.systemdCredsPath = authOptions.vaultSystemdCredsPath;
      }
      if (authOptions.vaultKeyMode !== undefined) {
        vaultOptions.systemdCredsKeyMode = authOptions.vaultKeyMode;
      }
      const vault = createCredentialVault(authOptions.hostId, vaultOptions);
      authVault = vault;
      const probe = vault.probe();
      if (!probe.available) {
        throw new AuthRuntimeStartupError(
          "vault_unavailable",
          `credential vault unavailable for host ${authOptions.hostId}: ${probe.detail}`,
        );
      }
      try {
        const brokerOptions: {
          ompPath: string;
          hostId: HostId;
          vault: CredentialVault;
          readinessTimeoutMs: number;
          bindHost?: string;
        } = {
          ompPath: authOptions.ompPath,
          hostId: authOptions.hostId,
          vault,
          readinessTimeoutMs: 30_000,
        };
        if (authOptions.bindHost !== undefined) {
          brokerOptions.bindHost = authOptions.bindHost;
        }
        const broker = createAuthBrokerManager(brokerOptions);
        await broker.start();
        options.logger.log("info", "auth_broker_started", {
          host_id: authOptions.hostId,
          endpoint: broker.endpoint,
        });
        const controlBearer = await vault.get("auth-broker.token");
        const controlBearerText = new TextDecoder().decode(controlBearer);
        const gatewayOptions: {
          ompPath: string;
          brokerEndpoint: string;
          brokerControlToken: string;
          readinessTimeoutMs: number;
          bindHost?: string;
        } = {
          ompPath: authOptions.ompPath,
          brokerEndpoint: broker.endpoint ?? "",
          brokerControlToken: controlBearerText,
          readinessTimeoutMs: 30_000,
        };
        if (authOptions.bindHost !== undefined) {
          gatewayOptions.bindHost = authOptions.bindHost;
        }
        const gateway = createAuthGatewayManager(gatewayOptions);
        try {
          await gateway.start();
        } catch (gatewayError) {
          // Best-effort: stop the broker before propagating so we leave no orphan.
          await broker.stop().catch(() => undefined);
          throw gatewayError instanceof AuthGatewayError
            ? new AuthRuntimeStartupError(
                "gateway_failed",
                `auth-gateway failed to start: ${gatewayError.message}`,
                { cause: gatewayError },
              )
            : gatewayError;
        }
        options.logger.log("info", "auth_gateway_started", {
          host_id: authOptions.hostId,
          endpoint: gateway.endpoint,
        });
        authBrokerHealth = () => broker.health();
        authGatewayHealth = () => gateway.health();
        authRuntime = Object.freeze({
          broker,
          gateway,
          close: () => Promise.all([gateway.stop(), broker.stop()]).then(() => undefined),
        });
        // F2: ensure the detached auth subprocesses are signaled when the daemon
        // itself exits (hard crash, uncaught throw, or `process.exit` from a
        // downstream library). `stop()` is async and cannot run inside the exit
        // handler, so we register a one-shot SYNC SIGKILL of both process groups.
        // Best-effort and idempotent at the process level.
        registerAuthExitCleanup(authRuntime);
      } catch (brokerError) {
        if (brokerError instanceof AuthRuntimeStartupError) throw brokerError;
        if (brokerError instanceof AuthBrokerError) {
          throw new AuthRuntimeStartupError(
            "broker_failed",
            `auth-broker failed to start: ${brokerError.message}`,
            { cause: brokerError },
          );
        }
        throw brokerError;
      }
    }
    options.signal?.throwIfAborted();
    if (options.providerAdmission?.enabled) {
      // PR 20: construct the per-credential admission proxy in front of the auth
      // gateway. The policy is validated fail-closed here; an un-audited limit raise
      // is rejected before the daemon accepts any harness provider request.
      const admissionOptions = options.providerAdmission;
      providerAdmission = createProviderAdmissionProxy({
        policy: validateAdmissionPolicy(admissionOptions.policy),
        clock: options.clock,
        ...(admissionOptions.maxQueuePerCredential !== undefined
          ? { maxQueuePerCredential: admissionOptions.maxQueuePerCredential }
          : {}),
        ...(admissionOptions.maxEventHistory !== undefined
          ? { maxEventHistory: admissionOptions.maxEventHistory }
          : {}),
      });
      admissionEventLoop = pumpAdmissionEvents(providerAdmission, options.logger);
      options.logger.log("info", "provider_admission_enabled", {
        default_limit: admissionOptions.policy.defaultLimit,
        overrides: admissionOptions.policy.overrides?.length ?? 0,
      });
    }

    const health = createHealth(lifecycle, localHostId, startedAt);
    const runDoctor = createDoctor({
      mode: options.mode,
      lock,
      supervisorDatabase,
      hostDatabase,
      registry: hostRegistry,
      hostId: localHostId,
      authVault,
      authBrokerHealth,
      authGatewayHealth,
      authEnabled: options.authBroker?.enabled ?? false,
      jjToolsDirectory: options.jjCapability?.enabled
        ? options.jjCapability.toolsDirectory
        : undefined,
    });
    let jjCentralRepo: Readonly<{ manager: JjCentralRepoManager }> | undefined;
    let revset: TreeServiceRevsetOptions | undefined;
    if (options.jjCapability?.enabled) {
      // Fail-closed (GIT-14): the operator enabled jj gating, so the pinned jj binary MUST be
      // available before the daemon will accept repository registrations. An unavailable probe
      // aborts startup rather than running in a half-gated state.
      const probe = await ensureJjCapability({
        toolsDirectory: options.jjCapability.toolsDirectory,
      });
      if (!probe.available) {
        throw new Error(
          `jj capability unavailable (${probe.failureCode}); cannot enable repository jj gating: ${probe.message}`,
        );
      }
      const jjReposRoot = join(home, "jj-repos");
      jjCentralRepo = {
        manager: createJjCentralRepoManager({
          jjBinaryPath: probe.binaryPath,
          hostRoot: jjReposRoot,
          clock: options.clock,
          ids: options.ids,
        }),
      };
      // The review-header projection (PR 48) needs the host database to persist its
      // node<->change bindings; supervisor mode has no host database, so revset stays
      // unconfigured there (mirroring jjCentralRepo, which is likewise unused for supervisor).
      if (hostDatabase !== undefined) {
        revset = {
          jjBinaryPath: probe.binaryPath,
          hostRoot: jjReposRoot,
          bindingStore: createSqliteVcsChangeBindingStore({ database: hostDatabase }),
        };
      }
      options.logger.log("info", "jj_central_repo_enabled", {
        jj_binary: probe.binaryPath,
        jj_version: probe.version,
      });
    }
    const remoteAccess =
      options.remoteAccess?.enabled === true
        ? { sessionStore: createDeviceSessionStore() }
        : undefined;

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
        vcsChangeBindingStore: requireVcsChangeBindingStore(vcsChangeBindingStore),
        steeringStore: requireSteeringStore(steeringStore),
        artifactRegistry: requireArtifactRegistry(artifactRegistry),
        blobStore: requireBlobStore(blobStore),
        recoveryStore: requireRecoveryStore(recoveryStore),
        recoveryGateProfile: RECOVERY_GATE_PROFILE,
        recoveryIds: options.ids,
        recoveryRestart: requireRecoveryRestart(recoveryRestart),
        repository: {
          registry: requireRepositoryRegistry(repositoryRegistry),
          home,
          clock: options.clock,
          ...(jjCentralRepo !== undefined ? { jjCentralRepo } : {}),
        },
        hostRegistry: requireRegistry(hostRegistry),
        ...(revset !== undefined ? { revset } : {}),
        ...(options.webDistDir !== undefined ? { webDistDir: options.webDistDir } : {}),
        ...(remoteAccess !== undefined ? { remoteAccess } : {}),
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
        vcsChangeBindingStore: requireVcsChangeBindingStore(vcsChangeBindingStore),
        steeringStore: requireSteeringStore(steeringStore),
        artifactRegistry: requireArtifactRegistry(artifactRegistry),
        blobStore: requireBlobStore(blobStore),
        recoveryStore: requireRecoveryStore(recoveryStore),
        recoveryGateProfile: RECOVERY_GATE_PROFILE,
        recoveryIds: options.ids,
        recoveryRestart: requireRecoveryRestart(recoveryRestart),
        repository: {
          registry: requireRepositoryRegistry(repositoryRegistry),
          home,
          clock: options.clock,
          ...(jjCentralRepo !== undefined ? { jjCentralRepo } : {}),
        },
        ...(revset !== undefined ? { revset } : {}),
        ...(remoteAccess !== undefined ? { remoteAccess } : {}),
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
      providerAdmission,
      executionCoordinator,
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
          authRuntime,
          providerAdmission,
          admissionEventLoop,
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
        authRuntime,
        providerAdmission,
        admissionEventLoop,
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
    jjCapability?: JjCapabilityRuntimeOptions;
    remoteAccess?: RemoteAccessRuntimeOptions;
  }>,
): DaemonRuntimeOptions {
  const clock: Clock = { now: () => timestampFromEpochMilliseconds(Date.now()) };
  const authBroker = defaultAuthBrokerOptions(input.mode, input.hostId);
  return {
    ...input,
    clock,
    ids: createSecureIdGenerator(clock),
    ...(authBroker === undefined ? {} : { authBroker }),
  };
}

/**
 * PR 19: derive per-host auth-broker options for the ONE bounded case where the host ID
 * is known before {@link startDaemonRuntime} runs — `mode === "host"` (remote SSH/WSL2-
 * attached execution hosts; PR53/PR54's domain, exactly the security boundary this PR
 * exists to protect). Both production entrypoints that call this function
 * (`apps/daemon/src/index.ts`'s `main()` and, transitively, `apps/cli/src/index.ts`'s
 * `start`) already require `--host-id` for host mode before `defaultRuntimeOptions` is
 * ever reached, so `hostIdOption` is defined on any real `minions start --mode host`
 * invocation.
 *
 * `mode === "local"` is deliberately left unwired here: its host ID is a fresh UUID
 * minted INSIDE {@link startDaemonRuntime} itself (`hostId(options.ids.nextId())`) — there
 * is no host ID to hand the broker before startup, a genuine chicken-and-egg problem — and
 * node-execution/harnesses do not activate in local mode today regardless of auth-broker
 * wiring, so there is no credential boundary to protect there yet. `mode === "supervisor"`
 * never runs harnesses either.
 *
 * Throws (via {@link resolveOmpPath}) when host mode is otherwise ready to run but no OMP
 * binary can be found anywhere — fail-closed, since a host daemon with no OMP available
 * cannot run any harness safely regardless of auth-broker wiring (acceptance 11: missing
 * secure credential storage fails host registration).
 */
function defaultAuthBrokerOptions(
  mode: DaemonModeName,
  hostIdOption: HostId | undefined,
): AuthBrokerRuntimeOptions | undefined {
  if (mode !== "host" || hostIdOption === undefined) return undefined;
  return {
    enabled: true,
    hostId: hostIdOption,
    ompPath: resolveOmpPath(),
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
    authRuntime: RunningAuthRuntime | undefined;
    providerAdmission: ProviderAdmissionProxy | undefined;
    admissionEventLoop: Promise<void> | undefined;
  }>,
): Promise<void> {
  const errors: unknown[] = [];
  await captureFailure(errors, async () => input.server.close());
  if (input.authRuntime !== undefined) {
    unregisterAuthExitCleanup(input.authRuntime);
    await captureFailure(errors, input.authRuntime.close);
  }
  if (input.providerAdmission !== undefined) {
    await captureFailure(errors, async () => {
      await input.providerAdmission?.shutdown();
    });
  }
  const admissionLoop = input.admissionEventLoop;
  if (admissionLoop !== undefined) {
    await captureFailure(errors, async () => admissionLoop);
  }
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
    authRuntime: RunningAuthRuntime | undefined;
    providerAdmission: ProviderAdmissionProxy | undefined;
    admissionEventLoop: Promise<void> | undefined;
  }>,
): Promise<void> {
  const errors: unknown[] = [];
  if (input.authRuntime !== undefined) {
    unregisterAuthExitCleanup(input.authRuntime);
    await captureFailure(errors, input.authRuntime.close);
  }
  if (input.providerAdmission !== undefined) {
    await captureFailure(errors, async () => {
      await input.providerAdmission?.shutdown();
    });
  }
  const admissionLoop = input.admissionEventLoop;
  if (admissionLoop !== undefined) {
    await captureFailure(errors, async () => admissionLoop);
  }
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

/**
 * Pumps the admission proxy's stable-sequence event stream into the daemon log surface
 * (PR 20 scheduler/UI event wiring). Fire-and-forget: a failure here is logged and the
 * loop ends — it must never crash the daemon. The loop exits when the proxy is shut down
 * (the event iterable completes) during {@link closeRuntime}.
 */
function pumpAdmissionEvents(
  proxy: ProviderAdmissionProxy,
  logger: StructuredLogger,
): Promise<void> {
  const loop = proxy.events();
  return (async () => {
    try {
      for await (const event of loop) {
        logAdmissionEvent(logger, event);
      }
    } catch (error) {
      logger.log("error", "admission_event_stream_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

function logAdmissionEvent(logger: StructuredLogger, event: AdmissionEventPayload): void {
  const level =
    event.kind === "credential_paused" || event.kind === "quota_signal" ? "warn" : "info";
  const fields: Record<string, unknown> = {
    credential_id: event.credentialId,
    attempt_id: event.attemptId,
    sequence: event.sequence,
  };
  if (event.nodeId !== undefined) {
    fields["node_id"] = event.nodeId;
  }
  if (event.kind === "credential_paused") {
    fields["reason"] = event.reason;
    if (event.retryAfterMs !== undefined) {
      fields["retry_after_ms"] = event.retryAfterMs;
    }
  }
  if (event.kind === "quota_signal") {
    fields["signal"] = event.signal;
    if (event.retryAfterMs !== undefined) {
      fields["retry_after_ms"] = event.retryAfterMs;
    }
  }
  logger.log(level, `admission_${event.kind}`, fields);
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
    authVault: CredentialVault | undefined;
    authBrokerHealth: (() => Promise<unknown>) | undefined;
    authGatewayHealth: (() => Promise<unknown>) | undefined;
    authEnabled: boolean;
    jjToolsDirectory: string | undefined;
  }>,
): () => Promise<RunDoctorResponse> {
  return async () => {
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
    if (input.authEnabled) {
      if (input.authVault !== undefined) {
        probes.push(probeAuthVault(input.authVault));
      }
      if (input.authBrokerHealth !== undefined) {
        probes.push(await probeAuthBroker(input.authBrokerHealth));
      }
      if (input.authGatewayHealth !== undefined) {
        probes.push(await probeAuthGateway(input.authGatewayHealth));
      }
    }
    if (input.jjToolsDirectory !== undefined) {
      probes.push(await probeJjCapability(input.jjToolsDirectory));
    }
    return create(RunDoctorResponseSchema, {
      status: aggregateDoctorStatus(probes),
      checks: probes.map((probe) => probe.check),
    });
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

function probeAuthVault(vault: CredentialVault): DoctorProbe {
  try {
    const probe = vault.probe();
    return doctorProbe(DoctorCheckKind.CREDENTIAL_VAULT, probe.available, DoctorStatus.UNAVAILABLE);
  } catch {
    return doctorProbe(DoctorCheckKind.CREDENTIAL_VAULT, false, DoctorStatus.UNAVAILABLE);
  }
}

async function probeAuthBroker(health: () => Promise<unknown>): Promise<DoctorProbe> {
  try {
    const result = await health();
    const ok =
      typeof result === "object" && result !== null && "ok" in result ? result.ok === true : false;
    return doctorProbe(DoctorCheckKind.AUTH_BROKER, ok, DoctorStatus.UNAVAILABLE);
  } catch {
    return doctorProbe(DoctorCheckKind.AUTH_BROKER, false, DoctorStatus.UNAVAILABLE);
  }
}

async function probeAuthGateway(health: () => Promise<unknown>): Promise<DoctorProbe> {
  try {
    const result = await health();
    const ok =
      typeof result === "object" && result !== null && "ready" in result
        ? result.ready === true
        : false;
    return doctorProbe(DoctorCheckKind.AUTH_GATEWAY, ok, DoctorStatus.UNAVAILABLE);
  } catch {
    return doctorProbe(DoctorCheckKind.AUTH_GATEWAY, false, DoctorStatus.UNAVAILABLE);
  }
}

async function probeJjCapability(toolsDirectory: string): Promise<DoctorProbe> {
  try {
    const probe = await ensureJjCapability({ toolsDirectory });
    if (probe.available) {
      return doctorProbe(DoctorCheckKind.JJ_CAPABILITY, true, DoctorStatus.HEALTHY);
    }
    return doctorProbe(DoctorCheckKind.JJ_CAPABILITY, false, jjFailureStatus(probe.failureCode));
  } catch {
    return doctorProbe(DoctorCheckKind.JJ_CAPABILITY, false, DoctorStatus.UNAVAILABLE);
  }
}

function jjFailureStatus(code: JjCapabilityErrorCode): DoctorStatus {
  switch (code) {
    case "corrupt_binary":
      return DoctorStatus.CORRUPT;
    case "digest_mismatch":
    case "version_mismatch":
    case "capability_missing":
      return DoctorStatus.INCOMPATIBLE;
    case "invalid_options":
    case "download_failed":
    case "extract_failed":
    case "probe_failed":
    case "filesystem_error":
      return DoctorStatus.UNAVAILABLE;
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

/**
 * Create `<home>/hosts/<hostId>` (the artifact blob store's rootPath parent),
 * rejecting a symlinked ancestor at every segment instead of following it. P1
 * (review #13): the previous `mkdirSync(hostDirectory, { recursive: true })`
 * creates/traverses through a preexisting symlinked ancestor (e.g. a
 * `hosts/<hostId>` symlink planted before this daemon start), so canonical
 * blob writes/reads/deletes could escape the host artifact boundary. `home`
 * is already realpath-resolved by `prepareHome`; this walks only the two new
 * segments this call owns ("hosts" and the host id).
 */
function ensureHostDirectorySync(home: string, hostId: string): string {
  let current = home;
  for (const segment of ["hosts", hostId]) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      mkdirSync(current, { mode: 0o700 });
      metadata = lstatSync(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError(`refusing to use non-directory or symlinked host path '${current}'`);
    }
  }
  return current;
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

function requireSteeringStore(value: SteeringCommandStore | undefined): SteeringCommandStore {
  if (value === undefined) {
    throw new Error("steering command store is not initialized");
  }
  return value;
}

function requirePlanRegistry(value: PlanRegistry | undefined): PlanRegistry {
  if (value === undefined) {
    throw new Error("plan registry is not initialized");
  }
  return value;
}

function requireArtifactRegistry(value: ArtifactRegistry | undefined): ArtifactRegistry {
  if (value === undefined) {
    throw new Error("artifact registry is not initialized");
  }
  return value;
}

function requireVcsChangeBindingStore(
  value: VcsChangeBindingStore | undefined,
): VcsChangeBindingStore {
  if (value === undefined) {
    throw new Error("vcs change binding store is not initialized");
  }
  return value;
}

function requireBlobStore(value: ContentBlobStore | undefined): ContentBlobStore {
  if (value === undefined) {
    throw new Error("content blob store is not initialized");
  }
  return value;
}

function requireRecoveryStore(value: RecoveryStore | undefined): RecoveryStore {
  if (value === undefined) {
    throw new Error("recovery store is not initialized");
  }
  return value;
}

function requireRecoveryRestart(value: RecoveryRestarter | undefined): RecoveryRestarter {
  if (value === undefined) {
    throw new Error("recovery restarter is not initialized");
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

// -------------------------------------------------------------------------------------------------
// F2: process-level cleanup for detached auth subprocesses.
// -------------------------------------------------------------------------------------------------

/**
 * Live auth runtimes whose broker/gateway process groups must be signaled when
 * the daemon exits. The broker + gateway spawn with `detached: true` so the
 * daemon can signal their whole process group; without this best-effort exit
 * handler a hard crash (uncaught throw, OOM kill of a child leaving the daemon
 * in a half-down state, or a downstream `process.exit`) would orphan them.
 */
const authExitCleanups = new Set<RunningAuthRuntime>();
let authExitHandlerInstalled = false;

function registerAuthExitCleanup(runtime: RunningAuthRuntime): void {
  authExitCleanups.add(runtime);
  if (authExitHandlerInstalled) return;
  authExitHandlerInstalled = true;
  process.on("exit", () => {
    for (const entry of authExitCleanups) {
      try {
        entry.broker.killSync();
      } catch {
        // best-effort: keep going so we still signal the other subprocess
      }
      try {
        entry.gateway.killSync();
      } catch {
        // best-effort
      }
    }
  });
}

function unregisterAuthExitCleanup(runtime: RunningAuthRuntime): void {
  authExitCleanups.delete(runtime);
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
