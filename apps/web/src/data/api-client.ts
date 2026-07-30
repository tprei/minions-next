import { createClient, type Client } from "@connectrpc/connect";
import {
  EventService,
  HostService,
  PushService,
  RecoveryService,
  RepositoryService,
  SteeringService,
  TreeService,
} from "@minions/contracts";
import { createDaemonTransport } from "./transport.js";

export interface ApiClients {
  readonly event: Client<typeof EventService>;
  readonly host: Client<typeof HostService>;
  readonly push: Client<typeof PushService>;
  readonly recovery: Client<typeof RecoveryService>;
  readonly repository: Client<typeof RepositoryService>;
  readonly steering: Client<typeof SteeringService>;
  readonly tree: Client<typeof TreeService>;
}

declare global {
  interface Window {
    /**
     * Test-only override (PR 45): E2E fixtures boot a real daemon on a dynamically reserved
     * port and set this before navigation so the built PWA (served by `vite preview` on its
     * own fixed port) talks to that daemon instead of assuming same-origin. Production never
     * sets this — the daemon serves its own PWA build from one origin (PR 52).
     */
    __MINIONS_API_BASE_URL__?: string;
  }
}

/**
 * Builds every generated Connect client the browser needs, sharing one transport (PR 44/45).
 * The daemon serves the built PWA from its own loopback origin, so `window.location.origin`
 * is the correct default; a different `baseUrl` is only needed for local dev/E2E against a
 * separately-running daemon.
 */
export function createApiClients(
  baseUrl: string = window.__MINIONS_API_BASE_URL__ ?? window.location.origin,
): ApiClients {
  const transport = createDaemonTransport({ baseUrl });
  return {
    event: createClient(EventService, transport),
    host: createClient(HostService, transport),
    push: createClient(PushService, transport),
    recovery: createClient(RecoveryService, transport),
    repository: createClient(RepositoryService, transport),
    steering: createClient(SteeringService, transport),
    tree: createClient(TreeService, transport),
  };
}
