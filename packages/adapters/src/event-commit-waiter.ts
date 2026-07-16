import type { CommandCommitNotifier } from "./sqlite/command.js";

export type EventCommitWaitResult = "closed" | "notified" | "timeout";

export type EventCommitWaitOptions = Readonly<{
  afterRevision: bigint;
  timeoutMs: number;
  signal: AbortSignal;
}>;

export interface EventCommitWaiter extends CommandCommitNotifier {
  getRevision(): bigint;
  wait(options: EventCommitWaitOptions): Promise<EventCommitWaitResult>;
  close(): void;
}

export function createEventCommitWaiter(): EventCommitWaiter {
  return new DefaultEventCommitWaiter();
}

class DefaultEventCommitWaiter implements EventCommitWaiter {
  readonly #waiters = new Map<symbol, (result: EventCommitWaitResult) => void>();
  #revision = 0n;
  #closed = false;

  getRevision(): bigint {
    return this.#revision;
  }

  commandCommitted(): void {
    if (this.#closed) {
      return;
    }
    this.#revision += 1n;
    this.#resolveAll("notified");
  }

  wait(options: EventCommitWaitOptions): Promise<EventCommitWaitResult> {
    if (options.afterRevision < 0n) {
      return Promise.reject(new RangeError("afterRevision must be non-negative"));
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      return Promise.reject(new RangeError("timeoutMs must be a positive safe integer"));
    }
    if (this.#closed) {
      return Promise.resolve("closed");
    }
    if (options.afterRevision !== this.#revision) {
      return Promise.resolve("notified");
    }
    if (options.signal.aborted) {
      return Promise.resolve("closed");
    }

    return new Promise<EventCommitWaitResult>((resolve) => {
      const key = Symbol("event commit waiter");
      const timeout = setTimeout(() => {
        finish("timeout");
      }, options.timeoutMs);
      const abort = (): void => {
        finish("closed");
      };
      const finish = (result: EventCommitWaitResult): void => {
        if (!this.#waiters.delete(key)) {
          return;
        }
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", abort);
        resolve(result);
      };
      this.#waiters.set(key, finish);
      options.signal.addEventListener("abort", abort, { once: true });

      if (this.#closed) {
        finish("closed");
      } else if (options.afterRevision !== this.#revision) {
        finish("notified");
      }
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#resolveAll("closed");
  }

  #resolveAll(result: EventCommitWaitResult): void {
    for (const resolve of [...this.#waiters.values()]) {
      resolve(result);
    }
  }
}
