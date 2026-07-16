import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createSqliteEventStore,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
  type PlanRegistry,
  type SupervisorHostRegistry,
  type RepositoryRegistry,
} from "@minions/adapters";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import {
  ServerCapability,
  type GetHealthResponse,
  type RunDoctorResponse,
} from "@minions/contracts";
import type { Clock } from "@minions/core";

import { createErrorDetailInterceptor } from "./error-detail-interceptor.js";
import { registerEventService } from "./event-service.js";
import { registerHostService } from "./host-service.js";
import { registerRepositoryService } from "./repository-service.js";
import { registerSystemService } from "./system-service.js";
import { registerTreeService } from "./tree-service.js";
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
        repository?: DaemonRepositoryOptions;
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
        repository?: DaemonRepositoryOptions;
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
  const handler = connectNodeAdapter({
    routes: (router) => {
      registerSystemService(router, {
        ...options.system,
        capabilities: capabilitiesForOptions(options),
      });
      if (options.mode !== "supervisor") {
        registerEventService(router, {
          store: createSqliteEventStore({ database: options.database }),
          waiter: options.eventWaiter,
          pollIntervalMs: options.eventPollIntervalMs,
        });
        registerTreeService(router, {
          planRegistry: options.planRegistry,
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
    ],
  });
  const server = createServer(handler);

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

  return {
    baseUrl: toBaseUrl(address),
    port: address.port,
    close: async () => {
      closeEventWaiter(options);
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
    },
  };
}

function capabilitiesForOptions(options: DaemonServerOptions): readonly ServerCapability[] {
  const capabilities: ServerCapability[] = [
    ServerCapability.SYSTEM_INFO,
    ServerCapability.HEALTH_DOCTOR,
  ];
  if (options.mode !== "supervisor") {
    capabilities.push(ServerCapability.EVENT_STREAM, ServerCapability.TREE_PLANNING);
    if (options.repository !== undefined) {
      capabilities.push(ServerCapability.REPOSITORY_REGISTRY);
    }
  }
  if (options.mode !== "host") {
    capabilities.push(ServerCapability.HOST_REGISTRY);
  }
  return Object.freeze(capabilities);
}

function closeEventWaiter(options: DaemonServerOptions): void {
  if (options.mode !== "supervisor") {
    options.eventWaiter.close();
  }
}

function toBaseUrl(address: AddressInfo): string {
  return `http://127.0.0.1:${String(address.port)}`;
}
