import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { createContextValues, type Interceptor } from "@connectrpc/connect";
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
} from "@minions/core";
import { createErrorDetailInterceptor } from "./error-detail-interceptor.js";
import { registerArtifactService } from "./artifact-service.js";
import { registerEventService } from "./event-service.js";
import { registerHostService } from "./host-service.js";
import { registerMaintenanceService } from "./maintenance-service.js";
import { registerRepositoryService } from "./repository-service.js";
import { registerPairingService } from "./pairing-service.js";
import { registerSteeringService } from "./steering-service.js";
import { registerSystemService } from "./system-service.js";
import { registerTreeService, type TreeServiceRevsetOptions } from "./tree-service.js";
import { registerWslHostService } from "./wsl-service.js";
import { registerRecoveryService } from "./recovery-service.js";
import { createUnknownFieldInterceptor } from "./unknown-field-interceptor.js";
import type { DeviceSessionStore } from "./device-session-store.js";
import type { RecoveryRestarter } from "./recovery-restart.js";
import {
  createRemoteAccessInterceptor,
  isLoopbackAddress,
  isLoopbackContextKey,
} from "./remote-access-interceptor.js";

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
   * REMOTE-01/REMOTE-02). When set, the daemon binds every interface (not loopback
   * only) so a phone reachable over Tailscale can connect through the same RPC surface
   * the desktop UI already uses, and every RPC in `remote-access-interceptor.ts`'s
   * `PHONE_REMOTE_ACCESS_POLICY` requires a valid device session from a non-loopback
   * caller; every other RPC is unreachable from one. Binding every interface, rather
   * than replacing the loopback bind with one specific address, keeps the desktop UI's
   * own `127.0.0.1` connections working unchanged; the private-network reachability
   * half of REMOTE-01/REMOTE-02 comes from the operator's own Tailscale configuration
   * (e.g. `tailscale serve`), not from this daemon managing a second listener. Omitted,
   * the daemon binds loopback only (REMOTE-01's default) and no session check runs —
   * desktop-UI behaviour is unchanged either way, since loopback callers always skip
   * the check.
   */
  remoteAccess?: RemoteAccessServerOptions;
}>;

export type RemoteAccessServerOptions = Readonly<{
  sessionStore: DeviceSessionStore;
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
      }>);

export type RunningDaemonServer = Readonly<{
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
}>;

export async function startDaemonServer(
  options: DaemonServerOptions,
): Promise<RunningDaemonServer> {
  const shutdownController = new AbortController();
  const pendingBodyRequests = new Set<PendingBodyRequest>();
  const inFlightHandlers = new Set<Promise<unknown>>();
  const handler = connectNodeAdapter({
    readMaxBytes: DAEMON_MESSAGE_MAX_BYTES,
    writeMaxBytes: DAEMON_MESSAGE_MAX_BYTES,
    jsonOptions: { ignoreUnknownFields: false },
    shutdownSignal: shutdownController.signal,
    contextValues: (request) =>
      createContextValues().set(
        isLoopbackContextKey,
        isLoopbackAddress(request.socket.remoteAddress),
      ),
    routes: (router) => {
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
      }
      if (options.mode !== "host") {
        registerHostService(router, options.hostRegistry);
      }
    },
    interceptors: [
      createErrorDetailInterceptor(),
      ...(options.remoteAccess === undefined
        ? []
        : [createRemoteAccessInterceptor({ sessionStore: options.remoteAccess.sessionStore })]),
      createUnknownFieldInterceptor(),
      createValidateInterceptor(),
      createInFlightInterceptor(inFlightHandlers),
    ],
  });
  const server = createServer((request, response) => {
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
    handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    const rejectOnError = (error: Error): void => {
      reject(error);
    };
    server.once("error", rejectOnError);
    server.listen(
      options.port,
      options.remoteAccess === undefined ? "127.0.0.1" : "0.0.0.0",
      () => {
        server.off("error", rejectOnError);
        resolve();
      },
    );
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("daemon server did not bind to a TCP address");
  }

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: toBaseUrl(address),
    port: address.port,
    close: () => {
      closePromise ??= (async () => {
        shutdownController.abort();
        closeEventWaiter(options);
        abortPendingBodyRequests(pendingBodyRequests);
        const { promise, resolve, reject } = Promise.withResolvers<undefined>();
        server.close((error) => {
          if (error === undefined) {
            resolve(undefined);
            return;
          }
          reject(error);
        });
        await promise;
        await drainInFlightHandlers(inFlightHandlers);
        server.closeIdleConnections();
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
  const decodedPath = decodeURIComponent(pathOnly);
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
