import { Code, ConnectError } from "@connectrpc/connect";
import {
  ErrorDetailSchema,
  type GetSnapshotResponse,
  type WatchEventsResponse,
} from "@minions/contracts";
import type { KeyValueStorage } from "./cursor-storage.js";
import type { ProjectionStore } from "./projection-store.js";

/** The minimal structural surface this module needs from a generated `EventService` client —
 * kept narrow so tests can inject a scripted fake without a real transport or daemon. */
export interface EventServiceClient {
  getSnapshot(request: Record<string, never>): Promise<GetSnapshotResponse>;
  watchEvents(
    request: { readonly afterSequence: bigint },
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<WatchEventsResponse>;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface EventClientOptions {
  readonly client: EventServiceClient;
  readonly store: ProjectionStore;
  readonly storage: KeyValueStorage;
  /** Storage key for the persisted cursor; namespaced so multiple hosts don't collide. */
  readonly cursorKey: string;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Injectable for deterministic tests; defaults to real timers. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const defaultInitialBackoffMs = 500;
const defaultMaxBackoffMs = 30_000;

function realSleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, milliseconds);
  return promise;
}

/**
 * Orchestrates `GetSnapshot` → `WatchEvents(after_sequence)` → live delivery, with gap
 * resnapshot and reconnect backoff (PR 44, PRD API-05/API-06, UI-08).
 *
 * - An expired cursor (`Code.OutOfRange` + `ErrorDetail.eventCursorExpired`) triggers exactly
 *   one full resnapshot: the store is replaced, never merged, and the cursor restarts from the
 *   new `lastSequence`.
 * - Any other stream error is treated as transient (network drop, daemon restart) and retried
 *   with exponential backoff; `connectionState` becomes `"reconnecting"` for the duration so a
 *   UI layer can show the cache is not live (UI-08 — the UI must never pretend cached state is
 *   live).
 * - A duplicate or stale event `sequence` (already applied) is ignored rather than reapplied,
 *   so replays after a reconnect are idempotent.
 */
export class EventClient {
  readonly #client: EventServiceClient;
  readonly #store: ProjectionStore;
  readonly #storage: KeyValueStorage;
  readonly #cursorKey: string;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #listeners = new Set<() => void>();

  #cursor = 0n;
  #state: ConnectionState = "connecting";
  #controller = new AbortController();

  constructor(options: EventClientOptions) {
    this.#client = options.client;
    this.#store = options.store;
    this.#storage = options.storage;
    this.#cursorKey = options.cursorKey;
    this.#initialBackoffMs = options.initialBackoffMs ?? defaultInitialBackoffMs;
    this.#maxBackoffMs = options.maxBackoffMs ?? defaultMaxBackoffMs;
    this.#sleep = options.sleep ?? realSleep;
  }

  subscribeConnectionState = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getConnectionState = (): ConnectionState => this.#state;

  /** Starts the snapshot+stream loop. Resolves once stopped via {@link stop}. */
  async start(): Promise<void> {
    if (this.#controller.signal.aborted) {
      this.#controller = new AbortController();
    }
    const persisted = this.#storage.getItem(this.#cursorKey);
    if (persisted !== null && /^[0-9]+$/u.test(persisted)) {
      this.#cursor = BigInt(persisted);
    } else {
      await this.#resnapshot();
    }
    let backoffMs = this.#initialBackoffMs;
    while (!isAborted(this.#controller)) {
      this.#setState(backoffMs === this.#initialBackoffMs ? "connecting" : "reconnecting");
      try {
        await this.#streamOnce();
        backoffMs = this.#initialBackoffMs;
      } catch (error: unknown) {
        if (isAborted(this.#controller)) return;
        if (isEventCursorExpired(error)) {
          await this.#resnapshot();
          backoffMs = this.#initialBackoffMs;
          continue;
        }
        this.#setState("offline");
        await this.#sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, this.#maxBackoffMs);
      }
    }
  }

  stop(): void {
    this.#controller.abort();
  }

  async #resnapshot(): Promise<void> {
    const snapshot = await this.#client.getSnapshot({});
    this.#store.replaceSnapshot(snapshot);
    this.#cursor = snapshot.lastSequence;
    this.#persistCursor();
  }

  async #streamOnce(): Promise<void> {
    const stream = this.#client.watchEvents(
      { afterSequence: this.#cursor },
      { signal: this.#controller.signal },
    );
    let receivedFirst = false;
    for await (const response of stream) {
      if (isAborted(this.#controller)) return;
      if (!receivedFirst) {
        this.#setState("live");
        receivedFirst = true;
      }
      const sequence = response.event?.sequence;
      if (sequence === undefined) continue;
      if (sequence <= this.#cursor) continue; // duplicate/stale — ignore, don't reapply
      const change =
        response.event?.event.case === "projectionChange" ? response.event.event.value : undefined;
      if (change !== undefined) {
        this.#store.applyChange(change);
      }
      this.#cursor = sequence;
      this.#persistCursor();
    }
  }

  #persistCursor(): void {
    this.#storage.setItem(this.#cursorKey, this.#cursor.toString());
  }

  #setState(next: ConnectionState): void {
    if (this.#state === next) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Reads `controller.signal.aborted` through a function boundary rather than an inline property
 * chain. `stop()` can mutate this asynchronously between an `await` and the next check in
 * {@link EventClient.start}, so it is never actually redundant even though a purely
 * synchronous read of the same expression would be.
 */
function isAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

function isEventCursorExpired(error: unknown): boolean {
  if (!(error instanceof ConnectError)) return false;
  if (error.code !== Code.OutOfRange) return false;
  return error
    .findDetails(ErrorDetailSchema)
    .some((detail) => detail.detail.case === "eventCursorExpired");
}
