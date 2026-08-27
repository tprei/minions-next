import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ErrorDetailSchema,
  EventCursorExpiredSchema,
  GetSnapshotResponseSchema,
  HostSummarySchema,
  ProjectionChangeSchema,
  WatchEventsResponseSchema,
  type EventEnvelope,
  type GetSnapshotResponse,
  type WatchEventsResponse,
} from "@minions/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStorage,
  EventClient,
  ProjectionStore,
  type EventServiceClient,
} from "../../apps/web/src/data/index.js";

const HOST_A = "01900000-0000-7000-8000-0000000000a1";
const HOST_B = "01900000-0000-7000-8000-0000000000a2";

function snapshot(lastSequence: bigint, minimumAvailableSequence = 1n): GetSnapshotResponse {
  return create(GetSnapshotResponseSchema, {
    hosts: [create(HostSummarySchema, { id: HOST_A, online: true, version: 1n })],
    lastSequence,
    minimumAvailableSequence,
  });
}

function envelope(sequence: bigint, hostId: string): EventEnvelope["event"] {
  return {
    case: "projectionChange" as const,
    value: create(ProjectionChangeSchema, {
      change: {
        case: "hostUpserted",
        value: create(HostSummarySchema, { id: hostId, online: true, version: sequence }),
      },
    }),
  };
}

function watchResponse(sequence: bigint, hostId: string): WatchEventsResponse {
  return create(WatchEventsResponseSchema, {
    event: {
      sequence,
      eventId: `evt-${sequence.toString()}`,
      aggregateKind: 1,
      aggregateId: hostId,
      aggregateVersion: sequence,
      occurredAt: { seconds: 0n, nanos: 0 },
      event: envelope(sequence, hostId),
    },
  });
}

function cursorExpiredError(): ConnectError {
  const detail = create(ErrorDetailSchema, {
    detail: {
      case: "eventCursorExpired",
      value: create(EventCursorExpiredSchema, { minimumAvailableSequence: 5n, lastSequence: 10n }),
    },
  });
  return new ConnectError("expired", Code.OutOfRange, undefined, [
    { desc: ErrorDetailSchema, value: detail },
  ]);
}

/** A scripted fake standing in for a generated `Client<typeof EventService>` — no transport,
 * no daemon. Each test pre-loads exactly the calls it needs. */
class ScriptedClient implements EventServiceClient {
  #snapshots: GetSnapshotResponse[];
  #streams: (() => AsyncGenerator<WatchEventsResponse, void, void>)[];
  getSnapshotCalls = 0;
  watchEventsCalls: bigint[] = [];

  constructor(
    snapshots: GetSnapshotResponse[],
    streams: (() => AsyncGenerator<WatchEventsResponse, void, void>)[],
  ) {
    this.#snapshots = snapshots;
    this.#streams = streams;
  }

  getSnapshot(): Promise<GetSnapshotResponse> {
    const next = this.#snapshots[this.getSnapshotCalls];
    this.getSnapshotCalls += 1;
    if (next === undefined) throw new Error("no more scripted snapshots");
    return Promise.resolve(next);
  }

  watchEvents(request: { readonly afterSequence: bigint }): AsyncIterable<WatchEventsResponse> {
    this.watchEventsCalls.push(request.afterSequence);
    const index = this.watchEventsCalls.length - 1;
    const factory = this.#streams[index];
    if (factory === undefined) throw new Error("no more scripted streams");
    return factory();
  }
}

async function* once<T>(value: T): AsyncGenerator<T, void, void> {
  yield value;
  const { promise } = Promise.withResolvers<undefined>(); // stay open — the real stream never completes
  await promise;
}

// eslint-disable-next-line require-yield -- deliberately throws before ever yielding
async function* throwing(error: unknown): AsyncGenerator<WatchEventsResponse, void, void> {
  await Promise.resolve();
  throw error;
}

describe("EventClient", () => {
  it("seeds from GetSnapshot, applies live events, and persists the cursor", async () => {
    const store = new ProjectionStore();
    const storage = createMemoryStorage();
    const client = new ScriptedClient([snapshot(0n)], [() => once(watchResponse(1n, HOST_B))]);
    const eventClient = new EventClient({ client, store, storage, cursorKey: "cursor" });

    void eventClient.start();
    await vi.waitFor(() => {
      expect(store.getSnapshot().hosts.has(HOST_B)).toBe(true);
    });
    expect(storage.getItem("cursor")).toBe("1");
    eventClient.stop();
  });

  it("seeds the store from a snapshot and resumes from the max cursor", async () => {
    const store = new ProjectionStore();
    const storage = createMemoryStorage();
    storage.setItem("cursor", "7");
    const client = new ScriptedClient([snapshot(5n)], [() => once(watchResponse(8n, HOST_B))]);
    const eventClient = new EventClient({ client, store, storage, cursorKey: "cursor" });

    void eventClient.start();
    await vi.waitFor(() => {
      expect(store.getSnapshot().hosts.has(HOST_A)).toBe(true);
      expect(client.getSnapshotCalls).toBe(1);
      expect(client.watchEventsCalls).toEqual([7n]);
    });
    await vi.waitFor(() => {
      expect(store.getSnapshot().hosts.has(HOST_B)).toBe(true);
    });
    eventClient.stop();
  });

  it("ignores a duplicate or stale sequence instead of reapplying it", async () => {
    const store = new ProjectionStore();
    const storage = createMemoryStorage();
    const applySpy = vi.spyOn(store, "applyChange");
    const client = new ScriptedClient(
      [snapshot(5n)],
      [
        () =>
          (async function* (): AsyncGenerator<WatchEventsResponse, void, void> {
            yield watchResponse(5n, HOST_B); // stale — already at cursor 5
            yield watchResponse(6n, HOST_B);
            await Promise.withResolvers<undefined>().promise;
          })(),
      ],
    );
    const eventClient = new EventClient({ client, store, storage, cursorKey: "cursor" });

    void eventClient.start();
    await vi.waitFor(() => {
      expect(storage.getItem("cursor")).toBe("6");
    });
    expect(applySpy).toHaveBeenCalledTimes(1);
    eventClient.stop();
  });

  it("resnapshots on an expired cursor and resumes from the new sequence", async () => {
    const store = new ProjectionStore();
    const storage = createMemoryStorage();
    storage.setItem("cursor", "2");
    const client = new ScriptedClient(
      [snapshot(0n), snapshot(10n, 5n)],
      [() => throwing(cursorExpiredError()), () => once(watchResponse(11n, HOST_B))],
    );
    const eventClient = new EventClient({ client, store, storage, cursorKey: "cursor" });

    void eventClient.start();
    await vi.waitFor(() => {
      expect(store.getSnapshot().hosts.has(HOST_B)).toBe(true);
    });
    expect(client.getSnapshotCalls).toBe(2);
    expect(client.watchEventsCalls).toEqual([2n, 10n]);
    eventClient.stop();
  });

  it("backs off and retries on a transient error, surfacing reconnecting then live", async () => {
    const store = new ProjectionStore();
    const storage = createMemoryStorage();
    const client = new ScriptedClient(
      [snapshot(0n)],
      [() => throwing(new Error("network drop")), () => once(watchResponse(1n, HOST_B))],
    );
    const seenStates: string[] = [];
    const sleepCalls: number[] = [];
    const eventClient = new EventClient({
      client,
      store,
      storage,
      cursorKey: "cursor",
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });
    eventClient.subscribeConnectionState(() => {
      seenStates.push(eventClient.getConnectionState());
    });

    void eventClient.start();
    await vi.waitFor(() => {
      expect(store.getSnapshot().hosts.has(HOST_B)).toBe(true);
    });
    expect(sleepCalls).toEqual([500]);
    expect(seenStates).toContain("offline");
    expect(seenStates).toContain("live");
    eventClient.stop();
  });

  it("stop() halts the loop without further client calls", async () => {
    const store = new ProjectionStore();
    const storage = createMemoryStorage();
    const client = new ScriptedClient([snapshot(0n)], [() => once(watchResponse(1n, HOST_B))]);
    const eventClient = new EventClient({ client, store, storage, cursorKey: "cursor" });

    void eventClient.start();
    await vi.waitFor(() => {
      expect(store.getSnapshot().hosts.has(HOST_B)).toBe(true);
    });
    eventClient.stop();
    const callsAtStop = client.watchEventsCalls.length;
    await Promise.resolve(); // let any already-queued microtasks settle
    expect(client.watchEventsCalls.length).toBe(callsAtStop);
  });
});
