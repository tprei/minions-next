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
import type { Interceptor } from "@connectrpc/connect";
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
  SteeringCommandStore,
} from "@minions/core";
import { createErrorDetailInterceptor } from "./error-detail-interceptor.js";
import { registerArtifactService } from "./artifact-service.js";
import { registerEventService } from "./event-service.js";
import { registerHostService } from "./host-service.js";
import { registerRepositoryService } from "./repository-service.js";
import { registerSteeringService } from "./steering-service.js";
import { registerSystemService } from "./system-service.js";
import { registerTreeService, type TreeServiceRevsetOptions } from "./tree-service.js";
import { createUnknownFieldInterceptor } from "./unknown-field-interceptor.js";

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
      }
      if (options.mode !== "host") {
        registerHostService(router, options.hostRegistry);
      }
    },
    interceptors: [
      createErrorDetailInterceptor(),
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
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", rejectOnError);
      resolve();
    });
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
