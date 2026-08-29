import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { AddressInfo } from "node:net";

import {
  createSqliteEventStore,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
  type PlanRegistry,
  type SupervisorHostRegistry,
  type RepositoryRegistry,
  type VcsChangeBindingStore,
} from "@minions/adapters";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import {
  ServerCapability,
  type GetHealthResponse,
  type RunDoctorResponse,
} from "@minions/contracts";
import type {
  ArtifactRegistry,
  Clock,
  ContentBlobStore,
  IdGenerator,
  RecoveryGateProfile,
  RecoveryStore,
  SteeringCommandStore,
  VcsBackend,
} from "@minions/core";
import { createErrorDetailInterceptor } from "./error-detail-interceptor.js";
import { registerArtifactService } from "./artifact-service.js";
import { registerEventService } from "./event-service.js";
import { registerHostService } from "./host-service.js";
import { registerMaintenanceService } from "./maintenance-service.js";
import { registerRepositoryService } from "./repository-service.js";
import { registerPairingService } from "./pairing-service.js";
import { registerPushService } from "./push-service.js";
import { registerSteeringService } from "./steering-service.js";
import { registerSystemService } from "./system-service.js";
import { registerTreeService, type TreeServiceRevsetOptions } from "./tree-service.js";
import { registerWslHostService } from "./wsl-service.js";
import { registerRecoveryService } from "./recovery-service.js";
import { registerChangeService } from "./change-service.js";
import { createUnknownFieldInterceptor } from "./unknown-field-interceptor.js";
import type { DeviceSessionStore } from "./device-session-store.js";
import type { RecoveryRestarter } from "./recovery-restart.js";
import { createRemoteAccessInterceptor } from "./remote-access-interceptor.js";

type DaemonSystemOptions = Readonly<{
  serverVersion: string;
  health: GetHealthResponse;
  runDoctor: () => Promise<RunDoctorResponse>;
}>;

type DaemonRepositoryOptions = Readonly<{
  registry: RepositoryRegistry;
  home: string;
  clock: Clock;
}>;

type BaseDaemonServerOptions = Readonly<{
  port: number;
  system: DaemonSystemOptions;
  /** PR 52: when set, serve the built web app from this directory for non-RPC paths. */
  webDistDir?: string;
  /**
   * OPTIONAL remote (phone) access surface (PR 57 — private-phone-pairing,
   * REMOTE-01/REMOTE-02). When set, the daemon starts a SECOND http.Server (in addition
   * to the trusted loopback listener on `port`) bound to `remoteAccess.bindHost` (default
   * `127.0.0.1`) on its own port. Both listeners serve the SAME RPC routes; they differ
   * only in their interceptor chain — the remote listener prepends
   * `createRemoteAccessInterceptor`, which ALWAYS enforces the phone policy
   * (`PHONE_REMOTE_ACCESS_POLICY`) plus a valid device session. Trust therefore derives
   * from WHICH listener accepted the connection, never from the peer address: the
   * documented `tailscale serve` deployment proxies the phone onto
   * `http://127.0.0.1:<remotePort>`, so phone requests arrive with a loopback
   * `remoteAddress` yet are still gated on the remote listener, while the desktop UI's
   * own `127.0.0.1` connections to the trusted listener stay completely unaffected.
   * Omitted, the daemon binds loopback only (REMOTE-01's default) and no session check
   * runs — desktop-UI behaviour is unchanged.
   */
  remoteAccess?: RemoteAccessServerOptions;
}>;

export type RemoteAccessServerOptions = Readonly<{
  sessionStore: DeviceSessionStore;
  /**
   * Host the remote (phone) listener binds. Defaults to `127.0.0.1` — the daemon never
   * binds a non-loopback interface itself; an operator exposes the remote port over an
   * authenticated private network (e.g. `tailscale serve http://127.0.0.1:<port>`).
   */
  bindHost?: string;
  /** Specific port to bind on (defaults to 0 for ephemeral port). */
  port?: number;
}>;

export type DaemonServerOptions =
  | (BaseDaemonServerOptions &
      Readonly<{
        mode: "host";
        database: ManagedSqliteDatabase;
        eventWaiter: EventCommitWaiter;
        eventPollIntervalMs: number;
        planRegistry: PlanRegistry;
        clock: Clock;
        vcsChangeBindingStore: VcsChangeBindingStore;
        steeringStore: SteeringCommandStore;
        artifactRegistry: ArtifactRegistry;
        blobStore: ContentBlobStore;
        recoveryStore: RecoveryStore;
        recoveryGateProfile: RecoveryGateProfile;
        recoveryIds: IdGenerator;
        recoveryRestart: RecoveryRestarter;
        repository?: DaemonRepositoryOptions;
        revset?: TreeServiceRevsetOptions;
        /** The composed VCS backend; present only when node execution is composed. */
        vcs?: VcsBackend;
      }>)
  | (BaseDaemonServerOptions &
      Readonly<{
        mode: "supervisor";
        hostRegistry: SupervisorHostRegistry;
      }>)
  | (BaseDaemonServerOptions &
      Readonly<{
        mode: "local";
        database: ManagedSqliteDatabase;
        eventWaiter: EventCommitWaiter;
        eventPollIntervalMs: number;
        planRegistry: PlanRegistry;
        clock: Clock;
        vcsChangeBindingStore: VcsChangeBindingStore;
        steeringStore: SteeringCommandStore;
        artifactRegistry: ArtifactRegistry;
        blobStore: ContentBlobStore;
        recoveryStore: RecoveryStore;
        recoveryGateProfile: RecoveryGateProfile;
        recoveryIds: IdGenerator;
        recoveryRestart: RecoveryRestarter;
        repository?: DaemonRepositoryOptions;
        revset?: TreeServiceRevsetOptions;
        hostRegistry: SupervisorHostRegistry;
        /** The composed VCS backend; present only when node execution is composed. */
        vcs?: VcsBackend;
      }>);

export type RunningDaemonServer = Readonly<{
  baseUrl: string;
  port: number;
  /**
   * Port of the remote (phone) listener, present only when `remoteAccess` is enabled.
   * Distinct from `port` (the trusted loopback listener); the remote listener's adapter
   * enforces the phone policy + device-session auth.
   */
  remotePort?: number;
  close: () => Promise<void>;
}>;

export async function startDaemonServer(
  options: DaemonServerOptions,
): Promise<RunningDaemonServer> {
  const shutdownController = new AbortController();
  const pendingBodyRequests = new Set<PendingBodyRequest>();
  const inFlightHandlers = new Set<Promise<unknown>>();
  const inFlightInterceptor = createInFlightInterceptor(inFlightHandlers);

  // Identical RPC routes for every listener — the ONLY thing that differs between the
  // trusted loopback (desktop) listener and the remote (phone) listener is the
  // interceptor chain (see below). Registering the same services on both keeps the wire
  // surface identical; the remote listener's interceptor gates WHICH of those RPCs a
  // phone may actually reach.
  const registerRoutes = (router: ConnectRouter): void => {
    registerSystemService(router, {
      ...options.system,
      capabilities: capabilitiesForOptions(options),
    });
    if (options.mode !== "supervisor") {
      registerArtifactService(router, {
        registry: options.artifactRegistry,
        blobStore: options.blobStore,
        clock: options.clock,
      });
      registerEventService(router, {
        store: createSqliteEventStore({ database: options.database }),
        waiter: options.eventWaiter,
        pollIntervalMs: options.eventPollIntervalMs,
      });
      registerTreeService(router, {
        planRegistry: options.planRegistry,
        clock: options.clock,
        ...(options.repository === undefined
          ? {}
          : { repositoryRegistry: options.repository.registry }),
        vcsChangeBindingStore: options.vcsChangeBindingStore,
        ...(options.revset === undefined ? {} : { revset: options.revset }),
      });
      registerSteeringService(router, {
        store: options.steeringStore,
        clock: options.clock,
      });
      if (options.repository !== undefined) {
        registerRepositoryService(router, options.repository);
      }
      registerMaintenanceService(router, { database: options.database });
      registerWslHostService(router, {});
      registerRecoveryService(router, {
        store: options.recoveryStore,
        gateProfile: options.recoveryGateProfile,
        clock: options.clock,
        ids: options.recoveryIds,
        restart: options.recoveryRestart,
      });
      registerPairingService(
        router,
        options.remoteAccess === undefined
          ? {}
          : { sessionStore: options.remoteAccess.sessionStore },
      );
      registerPushService(router, {});
      registerChangeService(router, {
        planRegistry: options.planRegistry,
        clock: options.clock,
        ...(options.repository === undefined
          ? {}
          : { repositoryRegistry: options.repository.registry }),
        vcsChangeBindingStore: options.vcsChangeBindingStore,
        database: options.database,
        ...(options.vcs !== undefined ? { vcs: options.vcs } : {}),
      });
    }
    if (options.mode !== "host") {
      registerHostService(router, options.hostRegistry);
    }
  };

  // Trusted loopback (desktop UI) listener: the SAME interceptor chain the daemon has
  // always run, WITHOUT createRemoteAccessInterceptor. Behaviour is unchanged whether or
  // not remote access is enabled — the desktop UI never depends on a peer-address check.
  const trustedHandler = connectNodeAdapter({
    readMaxBytes: DAEMON_MESSAGE_MAX_BYTES,
    writeMaxBytes: DAEMON_MESSAGE_MAX_BYTES,
    jsonOptions: { ignoreUnknownFields: false },
    shutdownSignal: shutdownController.signal,
    routes: registerRoutes,
    interceptors: [
      createErrorDetailInterceptor(),
      createUnknownFieldInterceptor(),
      createValidateInterceptor(),
      inFlightInterceptor,
    ],
  });

  const trustedServer = createServer((request, response) => {
    if (shutdownController.signal.aborted) {
      request.destroy();
      return;
    }
    trackPendingBodyRequest(request, pendingBodyRequests);
    const path = request.url?.split("?")[0] ?? "/";
    if (options.webDistDir !== undefined && !path.startsWith("/minions.")) {
      serveStaticWeb(request, response, options.webDistDir);
      return;
    }
    trustedHandler(request, response);
  });

  await listenOnce(trustedServer, options.port, "127.0.0.1");
  const address = trustedServer.address();
  if (address === null || typeof address === "string") {
    trustedServer.close();
    throw new Error("daemon server did not bind to a TCP address");
  }

  // Optional remote (phone) listener: a SEPARATE http.Server with the SAME routes but a
  // different interceptor chain that prepends createRemoteAccessInterceptor. The
  // interceptor now ONLY runs on this listener, so it ALWAYS enforces the phone policy +
  // device-session auth for every request that reaches it — trust derives from THIS
  // listener, never from the peer address. The documented `tailscale serve` deployment
  // proxies the phone onto http://127.0.0.1:<remotePort>, so phone requests arrive with
  // a loopback remoteAddress yet are still gated here.
  let remoteServer: Server | undefined;
  let remotePort: number | undefined;
  if (options.remoteAccess !== undefined) {
    const remoteHandler = connectNodeAdapter({
      readMaxBytes: DAEMON_MESSAGE_MAX_BYTES,
      writeMaxBytes: DAEMON_MESSAGE_MAX_BYTES,
      jsonOptions: { ignoreUnknownFields: false },
      shutdownSignal: shutdownController.signal,
      routes: registerRoutes,
      interceptors: [
        createErrorDetailInterceptor(),
        createRemoteAccessInterceptor({ sessionStore: options.remoteAccess.sessionStore }),
        createUnknownFieldInterceptor(),
        createValidateInterceptor(),
        inFlightInterceptor,
      ],
    });
    remoteServer = createServer((request, response) => {
      if (shutdownController.signal.aborted) {
        request.destroy();
        return;
      }
      trackPendingBodyRequest(request, pendingBodyRequests);
      const path = request.url?.split("?")[0] ?? "/";
      if (options.webDistDir !== undefined && !path.startsWith("/minions.")) {
        serveStaticWeb(request, response, options.webDistDir);
        return;
      }
      remoteHandler(request, response);
    });
    await listenOnce(
      remoteServer,
      options.remoteAccess.port ?? 0,
      options.remoteAccess.bindHost ?? "127.0.0.1",
    );
    const remoteAddress = remoteServer.address();
    if (remoteAddress === null || typeof remoteAddress === "string") {
      trustedServer.close();
      remoteServer.close();
      throw new Error("remote-access server did not bind to a TCP address");
    }
    remotePort = remoteAddress.port;
  }

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: toBaseUrl(address),
    port: address.port,
    ...(remotePort === undefined ? {} : { remotePort }),
    close: () => {
      closePromise ??= (async () => {
        shutdownController.abort();
        closeEventWaiter(options);
        abortPendingBodyRequests(pendingBodyRequests);
        await closeServer(trustedServer);
        if (remoteServer !== undefined) {
          await closeServer(remoteServer);
        }
        await drainInFlightHandlers(inFlightHandlers);
        trustedServer.closeIdleConnections();
        remoteServer?.closeIdleConnections();
      })();
      return closePromise;
    },
  };
}

type PendingBodyRequest = Readonly<{
  request: IncomingMessage;
}>;

function trackPendingBodyRequest(
  request: IncomingMessage,
  pendingRequests: Set<PendingBodyRequest>,
): void {
  if (request.complete) {
    return;
  }
  const pending = { request };
  pendingRequests.add(pending);
  const clear = (): void => {
    pendingRequests.delete(pending);
  };
  request.once("end", clear);
  request.once("close", clear);
}

function abortPendingBodyRequests(pendingRequests: ReadonlySet<PendingBodyRequest>): void {
  for (const pending of pendingRequests) {
    pending.request.destroy();
  }
}

function createInFlightInterceptor(inFlight: Set<Promise<unknown>>): Interceptor {
  return (next) => (request) => {
    const promise = Promise.resolve().then(() => next(request));
    inFlight.add(promise);
    void promise.then(
      () => {
        inFlight.delete(promise);
      },
      () => {
        inFlight.delete(promise);
      },
    );
    return promise;
  };
}

async function drainInFlightHandlers(inFlight: Set<Promise<unknown>>): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

function capabilitiesForOptions(options: DaemonServerOptions): readonly ServerCapability[] {
  const capabilities: ServerCapability[] = [
    ServerCapability.SYSTEM_INFO,
    ServerCapability.HEALTH_DOCTOR,
  ];
  if (options.mode !== "supervisor") {
    capabilities.push(
      ServerCapability.EVENT_STREAM,
      ServerCapability.TREE_PLANNING,
      ServerCapability.STEERING,
      ServerCapability.ARTIFACTS,
    );
    if (options.repository !== undefined) {
      capabilities.push(ServerCapability.REPOSITORY_REGISTRY);
    }
  }
  if (options.mode !== "host") {
    capabilities.push(ServerCapability.HOST_REGISTRY);
  }
  return Object.freeze(capabilities);
}

const DAEMON_MESSAGE_MAX_BYTES = 86 * 1024 * 1024;

function closeEventWaiter(options: DaemonServerOptions): void {
  if (options.mode !== "supervisor") {
    options.eventWaiter.close();
  }
}

function toBaseUrl(address: AddressInfo): string {
  return `http://127.0.0.1:${String(address.port)}`;
}

function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rejectOnError = (error: Error): void => {
      reject(error);
    };
    server.once("error", rejectOnError);
    server.listen(port, host, () => {
      server.off("error", rejectOnError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * PR 52 — distribution-service-lifecycle. Serves the built web app (apps/web/dist)
 * from the daemon's own origin so the PWA and the RPC API are same-origin. Non-RPC
 * GET requests fall through to static file serving with SPA fallback to index.html.
 */
function serveStaticWeb(req: IncomingMessage, res: ServerResponse, distDir: string): void {
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  const rawUrl = req.url ?? "/";
  const pathOnly = rawUrl.split("?")[0] ?? "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const resolvedDist = normalize(distDir);
  const candidate = normalize(join(resolvedDist, relativePath));

  if (
    (candidate === resolvedDist || candidate.startsWith(resolvedDist + sep)) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) {
    res.writeHead(200, {
      "content-type": STATIC_CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
    });
    createReadStream(candidate).pipe(res);
    return;
  }

  // SPA fallback: serve index.html for client-side routes.
  const lastSegment = decodedPath.split("/").pop() ?? "";
  if (!lastSegment.includes(".")) {
    const indexPath = join(resolvedDist, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(indexPath).pipe(res);
      return;
    }
  }

  res.writeHead(404);
  res.end();
}
