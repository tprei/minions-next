import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createApiClients } from "./api-client.js";
import { createLocalStorageAdapter } from "./cursor-storage.js";
import { EventClient, type ConnectionState, type EventClientOptions } from "./event-client.js";
import { ProjectionStore } from "./projection-store.js";
import type { ProjectionState } from "./projection-types.js";

interface EventClientContextValue {
  readonly store: ProjectionStore;
  readonly eventClient: EventClient;
}

const EventClientContext = createContext<EventClientContextValue | undefined>(undefined);

export interface EventClientProviderProps {
  readonly children: ReactNode;
  readonly cursorKey?: string;
}

/**
 * Provides a single shared {@link EventClient} and {@link ProjectionStore} across the entire
 * application, keeping the event stream live across client-side route navigations.
 */
export function EventClientProvider({
  children,
  cursorKey = "minions.event-cursor",
}: EventClientProviderProps): ReactNode {
  const value = useMemo<EventClientContextValue>(() => {
    const store = new ProjectionStore();
    const { event } = createApiClients();
    const options: EventClientOptions = {
      client: event,
      store,
      storage: createLocalStorageAdapter(),
      cursorKey,
    };
    return {
      store,
      eventClient: new EventClient(options),
    };
  }, [cursorKey]);

  useEffect(() => {
    void value.eventClient.start();
    return () => {
      value.eventClient.stop();
    };
  }, [value]);

  return createElement(EventClientContext.Provider, { value }, children);
}

/**
 * Accesses the shared live {@link ProjectionState} and {@link ConnectionState} via `useSyncExternalStore`.
 */
export function useEventClient(): {
  readonly projection: ProjectionState;
  readonly connectionState: ConnectionState;
} {
  const context = useContext(EventClientContext);
  if (context === undefined) {
    throw new Error("useEventClient must be used within an EventClientProvider");
  }
  const projection = useSyncExternalStore(context.store.subscribe, context.store.getSnapshot);
  const connectionState = useSyncExternalStore(
    context.eventClient.subscribeConnectionState,
    context.eventClient.getConnectionState,
  );

  return { projection, connectionState };
}
