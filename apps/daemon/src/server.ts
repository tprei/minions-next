import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createSqliteEventStore,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
  type SupervisorHostRegistry,
} from "@minions/adapters";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import {
  ServerCapability,
  type GetHealthResponse,
  type RunDoctorResponse,
} from "@minions/contracts";

import { createErrorDetailInterceptor } from "./error-detail-interceptor.js";
import { registerEventService } from "./event-service.js";
import { registerHostService } from "./host-service.js";
import { registerSystemService } from "./system-service.js";
import { createUnknownFieldInterceptor } from "./unknown-field-interceptor.js";

type DaemonSystemOptions = Readonly<{
  serverVersion: string;
  health: GetHealthResponse;
  runDoctor: () => Promise<RunDoctorResponse>;
}>;

type BaseDaemonServerOptions = Readonly<{
  port: number;
  system: DaemonSystemOptions;
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
        capabilities: capabilitiesForMode(options.mode),
      });
      if (options.mode !== "supervisor") {
        registerEventService(router, {
          store: createSqliteEventStore({ database: options.database }),
          waiter: options.eventWaiter,
          pollIntervalMs: options.eventPollIntervalMs,
        });
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

function capabilitiesForMode(mode: DaemonServerOptions["mode"]): readonly ServerCapability[] {
  switch (mode) {
    case "host":
      return [
        ServerCapability.SYSTEM_INFO,
        ServerCapability.HEALTH_DOCTOR,
        ServerCapability.EVENT_STREAM,
      ];
    case "supervisor":
      return [
        ServerCapability.SYSTEM_INFO,
        ServerCapability.HEALTH_DOCTOR,
        ServerCapability.HOST_REGISTRY,
      ];
    case "local":
      return [
        ServerCapability.SYSTEM_INFO,
        ServerCapability.HEALTH_DOCTOR,
        ServerCapability.EVENT_STREAM,
        ServerCapability.HOST_REGISTRY,
      ];
  }
}

function closeEventWaiter(options: DaemonServerOptions): void {
  if (options.mode !== "supervisor") {
    options.eventWaiter.close();
  }
}

function toBaseUrl(address: AddressInfo): string {
  return `http://127.0.0.1:${String(address.port)}`;
}
