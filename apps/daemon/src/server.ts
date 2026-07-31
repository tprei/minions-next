import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";

import { createErrorDetailInterceptor } from "./error-detail-interceptor.js";
import { registerSystemService } from "./system-service.js";
import { createUnknownFieldInterceptor } from "./unknown-field-interceptor.js";

export type SystemServerOptions = Readonly<{
  port: number;
  serverVersion: string;
}>;

export type RunningSystemServer = Readonly<{
  baseUrl: string;
  close: () => Promise<void>;
}>;

export async function startSystemServer(
  options: SystemServerOptions,
): Promise<RunningSystemServer> {
  const handler = connectNodeAdapter({
    routes: (router) => {
      registerSystemService(router, options.serverVersion);
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
