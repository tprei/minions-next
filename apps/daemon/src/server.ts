import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";

import { createErrorDetailInterceptor } from "./error-detail-interceptor.js";
import { registerSystemService } from "./system-service.js";
import { createUnknownFieldInterceptor } from "./unknown-field-interceptor.js";
import type { DeviceSessionStore } from "./device-session-store.js";
import {
  createRemoteAccessInterceptor,
  isLoopbackAddress,
  isLoopbackContextKey,
} from "./remote-access-interceptor.js";

export type SystemServerOptions = Readonly<{
  port: number;
  serverVersion: string;
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

export type RunningSystemServer = Readonly<{
  baseUrl: string;
  close: () => Promise<void>;
}>;

export async function startSystemServer(
  options: SystemServerOptions,
): Promise<RunningSystemServer> {
  const handler = connectNodeAdapter({
    contextValues: (request) =>
      createContextValues().set(
        isLoopbackContextKey,
        isLoopbackAddress(request.socket.remoteAddress),
      ),
    routes: (router) => {
      registerSystemService(router, options.serverVersion);
    },
    interceptors: [
      createErrorDetailInterceptor(),
      ...(options.remoteAccess === undefined
        ? []
        : [createRemoteAccessInterceptor({ sessionStore: options.remoteAccess.sessionStore })]),
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
    throw new Error("system server did not bind to a TCP address");
  }

  return {
    baseUrl: toBaseUrl(address),
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
    },
  };
}

function toBaseUrl(address: AddressInfo): string {
  return `http://127.0.0.1:${String(address.port)}`;
}
