import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createClient } from "@connectrpc/connect";
import { EventService } from "@minions/contracts";
import {
  createDaemonTransport,
  createLocalStorageAdapter,
  EventClient,
  ProjectionStore,
  type ConnectionState,
  type DaemonTransportOptions,
  type EventClientOptions,
  type ProjectionState,
} from "./index.js";

/**
 * Starts one {@link EventClient} against the daemon on mount and exposes its live
 * {@link ProjectionState} and {@link ConnectionState} via `useSyncExternalStore` (PR 44).
 *
 * The daemon serves the built PWA from its own loopback origin (PR 52), so `window.location`
 * is the correct transport target — there is no separate "API host" to discover for the local
 * v1 case. Host-specific auth headers land with PR 57's device sessions.
 */
export function useEventClient(cursorKey = "minions.event-cursor"): {
  readonly projection: ProjectionState;
  readonly connectionState: ConnectionState;
} {
  const store = useMemo(() => new ProjectionStore(), []);
  const eventClient = useMemo(() => {
    const transportOptions: DaemonTransportOptions = { baseUrl: window.location.origin };
    const transport = createDaemonTransport(transportOptions);
    const client = createClient(EventService, transport);
    const options: EventClientOptions = {
      client,
      store,
      storage: createLocalStorageAdapter(),
      cursorKey,
    };
    return new EventClient(options);
  }, [store, cursorKey]);

  useEffect(() => {
    void eventClient.start();
    return () => {
      eventClient.stop();
    };
  }, [eventClient]);

  const projection = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const connectionState = useSyncExternalStore(
    eventClient.subscribeConnectionState,
    eventClient.getConnectionState,
  );

  return { projection, connectionState };
}
