import { createConnectTransport } from "@connectrpc/connect-web";
import type { Transport } from "@connectrpc/connect";

export interface DaemonTransportOptions {
  readonly baseUrl: string;
  /**
   * Invoked per request to supply authentication headers (PR 44, PRD API-07/API-08).
   * No credential exists yet for the local-loopback v1 case, so this may be omitted or
   * return `undefined`; the mechanism exists so PR 57's device sessions can plug in without
   * touching the transport layer again.
   */
  readonly authHeaders?: () => Record<string, string> | undefined;
}

/**
 * Browser Connect transport (PR 44 — browser-projection-store). Uses `@connectrpc/connect-web`
 * exclusively — `@connectrpc/connect-node` is server-only and must never be imported here.
 * Headers/cookies are the only supported auth channel (PRD API-08): no bearer token is ever
 * placed in a URL.
 */
export function createDaemonTransport(options: DaemonTransportOptions): Transport {
  return createConnectTransport({
    baseUrl: options.baseUrl,
    fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
    interceptors: [
      (next) => async (request) => {
        const headers = options.authHeaders?.();
        if (headers !== undefined) {
          for (const [name, value] of Object.entries(headers)) {
            request.header.set(name, value);
          }
        }
        return next(request);
      },
    ],
  });
}
