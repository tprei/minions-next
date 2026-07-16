import {
  schedulerCapacityPolicy,
  schedulerOwnerId,
  validateSchedulerTiming,
  type Clock,
  type SchedulerDispatcher,
  type SchedulerLease,
  type SchedulerLoop,
  type SchedulerLoopOptions,
  type SchedulerStore,
  type Timestamp,
} from "@minions/core";

export type CreateSchedulerLoopOptions = Readonly<{
  store: SchedulerStore;
  dispatcher: SchedulerDispatcher;
  clock: Clock;
  options: SchedulerLoopOptions;
  onError?: (error: unknown) => void;
}>;

export function createSchedulerLoop(input: CreateSchedulerLoopOptions): SchedulerLoop {
  validateSchedulerTiming(input.options.leaseDurationMs, input.options.pollIntervalMs);
  const ownerId = schedulerOwnerId(input.options.ownerId);
  const capacity = schedulerCapacityPolicy(
    input.options.capacity.maxActiveGlobal,
    input.options.capacity.maxActivePerTree,
  );
  return new DefaultSchedulerLoop({
    ...input,
    options: {
      ...input.options,
      ownerId,
      capacity,
    },
  });
}

class DefaultSchedulerLoop implements SchedulerLoop {
  readonly #store: SchedulerStore;
  readonly #dispatcher: SchedulerDispatcher;
  readonly #clock: Clock;
  readonly #options: SchedulerLoopOptions;
  readonly #onError: ((error: unknown) => void) | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #wakeTimer: NodeJS.Timeout | undefined;
  #inFlight: Promise<number> | undefined;
  #pendingWake = false;
  #stopped = false;

  constructor(input: CreateSchedulerLoopOptions) {
    this.#store = input.store;
    this.#dispatcher = input.dispatcher;
    this.#clock = input.clock;
    this.#options = input.options;
    this.#onError = input.onError;
  }

  start(): void {
    if (this.#stopped || this.#pollTimer !== undefined) {
      return;
    }
    this.#pollTimer = setInterval(() => {
      this.#scheduleCycle(false);
    }, this.#options.pollIntervalMs);
  }

  wake(): void {
    if (this.#stopped || this.#wakeTimer !== undefined) {
      return;
    }
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = undefined;
      if (this.#stopped) {
        return;
      }
      this.#scheduleCycle(true);
    }, 0);
  }

  runOnce(): Promise<number> {
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }
    const cycle = this.#runCycle();
    this.#inFlight = cycle;
    void cycle.then(
      () => {
        this.#finishCycle(cycle);
      },
      () => {
        this.#finishCycle(cycle);
      },
    );
    return cycle;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer !== undefined) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#wakeTimer !== undefined) {
      clearTimeout(this.#wakeTimer);
      this.#wakeTimer = undefined;
    }
    this.#pendingWake = false;
    const inFlight = this.#inFlight;
    if (inFlight !== undefined) {
      await inFlight;
    }
  }

  async #runCycle(): Promise<number> {
    const recoveryAt = this.#clock.now();
    const recoveries = await this.#store.recoverExpired(recoveryAt);
    for (const recovery of recoveries) {
      if (recovery.recovered) {
        continue;
      }
      const leaseDescription = recovery.leaseId ?? "unknown";
      const message =
        recovery.error ?? `scheduler lease recovery failed for lease ${leaseDescription}`;
      this.#reportError(new Error(message, { cause: recovery }));
    }

    let dispatched = 0;
    for (;;) {
      const claimAt = this.#clock.now();
      const lease = await this.#store.claimNext({
        ownerId: this.#options.ownerId,
        at: claimAt,
        leaseDurationMs: this.#options.leaseDurationMs,
        capacity: this.#options.capacity,
      });
      if (lease === undefined) {
        return dispatched;
      }
      try {
        await this.#dispatcher.dispatch(lease);
      } catch (error) {
        const releaseAt = this.#clock.now();
        await this.#releaseAfterDispatchFailure(lease, releaseAt, error);
        throw error;
      }
      dispatched += 1;
    }
  }

  async #releaseAfterDispatchFailure(
    lease: SchedulerLease,
    at: Timestamp,
    dispatchError: unknown,
  ): Promise<void> {
    try {
      await this.#store.release({
        lease: {
          id: lease.id,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
        },
        at,
      });
    } catch (releaseError) {
      throw new AggregateError(
        [dispatchError, releaseError],
        "scheduler dispatch failed and its lease could not be released",
        { cause: releaseError },
      );
    }
  }

  #scheduleCycle(fromWake: boolean): void {
    if (this.#stopped) {
      return;
    }
    if (this.#inFlight !== undefined) {
      if (fromWake) {
        this.#pendingWake = true;
      }
      return;
    }
    const cycle = this.runOnce();
    void cycle.catch((error: unknown) => {
      this.#reportError(error);
    });
  }

  #finishCycle(cycle: Promise<number>): void {
    if (this.#inFlight !== cycle) {
      return;
    }
    this.#inFlight = undefined;
    if (this.#pendingWake && !this.#stopped) {
      this.#pendingWake = false;
      this.wake();
    }
  }
  #reportError(error: unknown): void {
    if (this.#onError !== undefined) {
      this.#onError(error);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  }
}
