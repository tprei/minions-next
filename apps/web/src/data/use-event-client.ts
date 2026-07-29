import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createApiClients,
  createLocalStorageAdapter,
  EventClient,
  ProjectionStore,
  type ConnectionState,
  type EventClientOptions,
  type ProjectionState,
} from "./index.js";

/**
 * Starts one {@link EventClient} against the daemon on mount and exposes its live
 * {@link ProjectionState} and {@link ConnectionState} via `useSyncExternalStore` (PR 44/45).
 * Shares its API base URL resolution with every command hook via {@link createApiClients}
 * (including the E2E test override) so reads and writes always target the same daemon.
 */
export function useEventClient(cursorKey = "minions.event-cursor"): {
  readonly projection: ProjectionState;
  readonly connectionState: ConnectionState;
} {
  const store = useMemo(() => new ProjectionStore(), []);
  const eventClient = useMemo(() => {
    const { event } = createApiClients();
    const options: EventClientOptions = {
      client: event,
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
