import { createSchedulerLoop } from "@minions/daemon";
import {
  attemptId,
  fencingToken,
  hostId,
  repositoryId,
  schedulerCapacityPolicy,
  schedulerLeaseId,
  schedulerOwnerId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type CancelScheduledNodeRequest,
  type ClaimSchedulerLeaseRequest,
  type Clock,
  type ExpiredSchedulerLeaseRecovery,
  type HeartbeatSchedulerLeaseRequest,
  type ReleaseSchedulerLeaseRequest,
  type SchedulerDispatcher,
  type SchedulerLease,
  type SchedulerLoop,
  type SchedulerStore,
  type Timestamp,
} from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = schedulerOwnerId("scheduler-loop-test");
const POLL_INTERVAL_MS = 10;
const LEASE_DURATION_MS = 100;
const FIXED_TIME = 1_700_000_000_000;
const FIXED_CLOCK = new FixedClock(timestampFromEpochMilliseconds(FIXED_TIME));

type SchedulerLoopEvent =
  | Readonly<{ kind: "recover"; at: Timestamp }>
  | Readonly<{ kind: "claim"; request: ClaimSchedulerLeaseRequest }>
  | Readonly<{ kind: "dispatch"; lease: SchedulerLease }>
  | Readonly<{ kind: "release"; request: ReleaseSchedulerLeaseRequest }>;

type StrictSchedulerStoreOptions = Readonly<{
  events: SchedulerLoopEvent[];
  claims: readonly (SchedulerLease | undefined)[];
  recoveries: readonly ExpiredSchedulerLeaseRecovery[];
  recoveryGate?: Promise<readonly ExpiredSchedulerLeaseRecovery[]>;
  releaseError?: Error;
}>;

class StrictSchedulerStore implements SchedulerStore {
  readonly calls: SchedulerLoopEvent[] = [];
  readonly recoveryTimes: Timestamp[] = [];
  readonly claimRequests: ClaimSchedulerLeaseRequest[] = [];
  readonly releaseRequests: ReleaseSchedulerLeaseRequest[] = [];
  readonly #events: SchedulerLoopEvent[];
  readonly #claims: readonly (SchedulerLease | undefined)[];
  readonly #recoveries: readonly ExpiredSchedulerLeaseRecovery[];
  readonly #recoveryGate: Promise<readonly ExpiredSchedulerLeaseRecovery[]> | undefined;
  readonly #releaseError: Error | undefined;
  #claimIndex = 0;

  constructor(input: StrictSchedulerStoreOptions) {
    this.#events = input.events;
    this.#claims = input.claims;
    this.#recoveries = input.recoveries;
    this.#recoveryGate = input.recoveryGate;
    this.#releaseError = input.releaseError;
  }

  async recoverExpired(at: Timestamp): Promise<readonly ExpiredSchedulerLeaseRecovery[]> {
    const event: SchedulerLoopEvent = { kind: "recover", at };
    this.calls.push(event);
    this.#events.push(event);
    this.recoveryTimes.push(at);
    if (this.#recoveryGate !== undefined) {
      return this.#recoveryGate;
    }
    return this.#recoveries;
  }

  claimNext(request: ClaimSchedulerLeaseRequest): Promise<SchedulerLease | undefined> {
    const event: SchedulerLoopEvent = { kind: "claim", request };
    this.calls.push(event);
    this.#events.push(event);
    this.claimRequests.push(request);
    if (this.#claimIndex >= this.#claims.length) {
      throw new Error("strict scheduler claim script exhausted");
    }
    const claim = this.#claims[this.#claimIndex];
    this.#claimIndex += 1;
    return Promise.resolve(claim);
  }

  release(request: ReleaseSchedulerLeaseRequest): Promise<void> {
    const event: SchedulerLoopEvent = { kind: "release", request };
    this.calls.push(event);
    this.#events.push(event);
    this.releaseRequests.push(request);
    if (this.#releaseError !== undefined) {
      return Promise.reject(this.#releaseError);
    }
    return Promise.resolve();
  }

  heartbeat(request: HeartbeatSchedulerLeaseRequest): Promise<SchedulerLease> {
    throw new Error(`strict scheduler fixture received heartbeat for ${request.lease.id}`);
  }

  cancelNode(request: CancelScheduledNodeRequest): Promise<void> {
    throw new Error(`strict scheduler fixture received cancellation for ${request.nodeId}`);
  }
}

type DispatcherOutcome =
  | Readonly<{ kind: "resolve" }>
  | Readonly<{ kind: "wait"; promise: Promise<void> }>
  | Readonly<{ kind: "reject"; error: Error }>;

type StrictSchedulerDispatcherOptions = Readonly<{
  events: SchedulerLoopEvent[];
  outcomes: readonly DispatcherOutcome[];
}>;

class StrictSchedulerDispatcher implements SchedulerDispatcher {
  readonly leases: SchedulerLease[] = [];
  readonly #events: SchedulerLoopEvent[];
  readonly #outcomes: readonly DispatcherOutcome[];
  #dispatchIndex = 0;

  constructor(input: StrictSchedulerDispatcherOptions) {
    this.#events = input.events;
    this.#outcomes = input.outcomes;
  }

  async dispatch(lease: SchedulerLease): Promise<void> {
    const event: SchedulerLoopEvent = { kind: "dispatch", lease };
    this.#events.push(event);
    this.leases.push(lease);
    if (this.#dispatchIndex >= this.#outcomes.length) {
      throw new Error("strict scheduler dispatcher script exhausted");
    }
    const outcome = this.#outcomes[this.#dispatchIndex];
    this.#dispatchIndex += 1;
    if (outcome === undefined) {
      throw new Error("strict scheduler dispatcher script exhausted");
    }
    if (outcome.kind === "wait") {
      await outcome.promise;
      return;
    }
    if (outcome.kind === "reject") {
      throw outcome.error;
    }
  }
}

class SequenceClock implements Clock {
  readonly calls: Timestamp[] = [];
  readonly #timestamps: readonly Timestamp[];
  #index = 0;

  constructor(timestamps: readonly Timestamp[]) {
    this.#timestamps = timestamps;
  }

  now(): Timestamp {
    if (this.#index >= this.#timestamps.length) {
      throw new Error("strict scheduler clock script exhausted");
    }
    const timestamp = this.#timestamps[this.#index];
    this.#index += 1;
    if (timestamp === undefined) {
      throw new Error("strict scheduler clock script contained an undefined timestamp");
    }
    this.calls.push(timestamp);
    return timestamp;
  }
}

function uuid(seed: number): string {
  return `01900000-0000-7000-8000-${seed.toString(16).padStart(12, "0")}`;
}

function lease(seed: number): SchedulerLease {
  const acquiredAt = timestampFromEpochMilliseconds(FIXED_TIME + seed);
  return {
    id: schedulerLeaseId(uuid(seed)),
    attemptId: attemptId(uuid(seed + 0x1000)),
    nodeId: taskNodeId(uuid(seed + 0x2000)),
    treeId: taskTreeId(uuid(seed + 0x3000)),
    repositoryId: repositoryId(uuid(seed + 0x4000)),
    hostId: hostId(uuid(seed + 0x5000)),
    ownerId: OWNER,
    fencingToken: fencingToken(BigInt(seed)),
    acquiredAt,
    heartbeatAt: acquiredAt,
    expiresAt: timestampFromEpochMilliseconds(FIXED_TIME + seed + LEASE_DURATION_MS),
  };
}

function recovery(
  value: SchedulerLease,
  recovered: boolean,
  retryScheduled: boolean,
  error: string | undefined,
): ExpiredSchedulerLeaseRecovery {
  return {
    leaseId: value.id,
    attemptId: value.attemptId,
    nodeId: value.nodeId,
    recovered,
    retryScheduled,
    error,
  };
}

function timestamp(value: number): Timestamp {
  return timestampFromEpochMilliseconds(value);
}

function eventKinds(events: readonly SchedulerLoopEvent[]): readonly string[] {
  return events.map((event) => event.kind);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createLoop(
  input: Readonly<{
    store: SchedulerStore;
    dispatcher: SchedulerDispatcher;
    clock?: Clock;
    onError?: (error: unknown) => void;
  }>,
): SchedulerLoop {
  const options = {
    ownerId: OWNER,
    capacity: schedulerCapacityPolicy(2, 1),
    leaseDurationMs: LEASE_DURATION_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
  const base = {
    store: input.store,
    dispatcher: input.dispatcher,
    clock: input.clock ?? FIXED_CLOCK,
    options,
  };
  if (input.onError === undefined) {
    return createSchedulerLoop(base);
  }
  return createSchedulerLoop({ ...base, onError: input.onError });
}

describe("scheduler loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls without a wake notification", async () => {
    const events: SchedulerLoopEvent[] = [];
    const store = new StrictSchedulerStore({ events, claims: [undefined], recoveries: [] });
    const dispatcher = new StrictSchedulerDispatcher({ events, outcomes: [] });
    const loop = createLoop({ store, dispatcher });

    loop.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(eventKinds(events)).toEqual(["recover", "claim"]);
    expect(dispatcher.leases).toHaveLength(0);
    await loop.stop();
  });

  it("starts idempotently without adding polling timers", async () => {
    const events: SchedulerLoopEvent[] = [];
    const store = new StrictSchedulerStore({
      events,
      claims: [undefined, undefined],
      recoveries: [],
    });
    const dispatcher = new StrictSchedulerDispatcher({ events, outcomes: [] });
    const loop = createLoop({ store, dispatcher });

    loop.start();
    loop.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

    expect(eventKinds(events)).toEqual(["recover", "claim", "recover", "claim"]);
    expect(vi.getTimerCount()).toBe(1);
    await loop.stop();
  });

  it("coalesces wake notifications before a cycle starts", async () => {
    const events: SchedulerLoopEvent[] = [];
    const store = new StrictSchedulerStore({ events, claims: [undefined], recoveries: [] });
    const dispatcher = new StrictSchedulerDispatcher({ events, outcomes: [] });
    const loop = createLoop({ store, dispatcher });

    loop.wake();
    loop.wake();
    loop.wake();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();

    expect(eventKinds(events)).toEqual(["recover", "claim"]);
    await loop.stop();
  });

  it("does not overlap cycles and runs one coalesced wake after an in-flight cycle", async () => {
    const events: SchedulerLoopEvent[] = [];
    const dispatchGate = Promise.withResolvers<undefined>();
    const first = lease(1);
    const store = new StrictSchedulerStore({
      events,
      claims: [first, undefined, undefined],
      recoveries: [],
    });
    const dispatcher = new StrictSchedulerDispatcher({
      events,
      outcomes: [{ kind: "wait", promise: dispatchGate.promise }],
    });
    const loop = createLoop({ store, dispatcher });

    const firstCycle = loop.runOnce();
    await flushMicrotasks();
    expect(eventKinds(events)).toEqual(["recover", "claim", "dispatch"]);

    loop.wake();
    loop.wake();
    loop.wake();
    await vi.runOnlyPendingTimersAsync();
    expect(eventKinds(events)).toEqual(["recover", "claim", "dispatch"]);

    dispatchGate.resolve(undefined);
    await expect(firstCycle).resolves.toBe(1);
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(eventKinds(events)).toEqual([
      "recover",
      "claim",
      "dispatch",
      "claim",
      "recover",
      "claim",
    ]);
    expect(dispatcher.leases[0]).toBe(first);
    await loop.stop();
  });

  it("recovers before claiming and reports failed recovery without stopping claims", async () => {
    const events: SchedulerLoopEvent[] = [];
    const first = lease(2);
    const second = lease(3);
    const failedRecovery = recovery(first, false, false, "recovery conflict");
    const successfulRecovery = recovery(second, true, true, undefined);
    const reportedErrors: unknown[] = [];
    const store = new StrictSchedulerStore({
      events,
      claims: [first, second, undefined],
      recoveries: [failedRecovery, successfulRecovery],
    });
    const dispatcher = new StrictSchedulerDispatcher({
      events,
      outcomes: [{ kind: "resolve" }, { kind: "resolve" }],
    });
    const loop = createLoop({
      store,
      dispatcher,
      onError: (error: unknown) => {
        reportedErrors.push(error);
      },
    });

    await expect(loop.runOnce()).resolves.toBe(2);

    expect(eventKinds(events)).toEqual([
      "recover",
      "claim",
      "dispatch",
      "claim",
      "dispatch",
      "claim",
    ]);
    expect(store.recoveryTimes).toEqual([timestamp(FIXED_TIME)]);
    expect(dispatcher.leases).toEqual([first, second]);
    expect(dispatcher.leases[0]).toBe(first);
    expect(dispatcher.leases[1]).toBe(second);
    expect(reportedErrors).toHaveLength(1);
    const reported = reportedErrors[0];
    if (!(reported instanceof Error)) {
      throw new Error("scheduler recovery error was not reported as an Error");
    }
    expect(reported.message).toBe("recovery conflict");
    expect(reported.cause).toBe(failedRecovery);
  });

  it("uses a fresh clock value for every claim until the store returns undefined", async () => {
    const events: SchedulerLoopEvent[] = [];
    const first = lease(4);
    const second = lease(5);
    const clock = new SequenceClock([
      timestamp(100),
      timestamp(101),
      timestamp(102),
      timestamp(103),
    ]);
    const store = new StrictSchedulerStore({
      events,
      claims: [first, second, undefined],
      recoveries: [],
    });
    const dispatcher = new StrictSchedulerDispatcher({
      events,
      outcomes: [{ kind: "resolve" }, { kind: "resolve" }],
    });
    const loop = createLoop({ store, dispatcher, clock });

    await expect(loop.runOnce()).resolves.toBe(2);

    expect(clock.calls).toEqual([timestamp(100), timestamp(101), timestamp(102), timestamp(103)]);
    expect(store.recoveryTimes).toEqual([timestamp(100)]);
    expect(store.claimRequests.map((request) => request.at)).toEqual([
      timestamp(101),
      timestamp(102),
      timestamp(103),
    ]);
    expect(store.claimRequests.every((request) => request.ownerId === OWNER)).toBe(true);
  });

  it("releases a failed dispatch with the exact fenced reference and surfaces its error", async () => {
    const events: SchedulerLoopEvent[] = [];
    const value = lease(6);
    const dispatchError = new Error("dispatcher unavailable");
    const clock = new SequenceClock([timestamp(200), timestamp(201), timestamp(202)]);
    const store = new StrictSchedulerStore({
      events,
      claims: [value],
      recoveries: [],
    });
    const dispatcher = new StrictSchedulerDispatcher({
      events,
      outcomes: [{ kind: "reject", error: dispatchError }],
    });
    const loop = createLoop({ store, dispatcher, clock });

    await expect(loop.runOnce()).rejects.toBe(dispatchError);

    expect(eventKinds(events)).toEqual(["recover", "claim", "dispatch", "release"]);
    expect(dispatcher.leases[0]).toBe(value);
    const released = store.releaseRequests[0];
    if (released === undefined) {
      throw new Error("scheduler did not release the failed dispatch lease");
    }
    expect(released.at).toBe(timestamp(202));
    expect(released.lease).toEqual({
      id: value.id,
      ownerId: value.ownerId,
      fencingToken: value.fencingToken,
    });
    expect(Object.keys(released.lease).sort()).toEqual(["fencingToken", "id", "ownerId"]);
    expect(clock.calls).toEqual([timestamp(200), timestamp(201), timestamp(202)]);
  });

  it("surfaces an AggregateError when fenced release also fails", async () => {
    const events: SchedulerLoopEvent[] = [];
    const value = lease(7);
    const dispatchError = new Error("dispatcher failed");
    const releaseError = new Error("release failed");
    const store = new StrictSchedulerStore({
      events,
      claims: [value],
      recoveries: [],
      releaseError,
    });
    const dispatcher = new StrictSchedulerDispatcher({
      events,
      outcomes: [{ kind: "reject", error: dispatchError }],
    });
    const loop = createLoop({ store, dispatcher });

    let caught: unknown;
    try {
      await loop.runOnce();
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof AggregateError)) {
      throw new Error("scheduler did not aggregate dispatch and release errors");
    }
    expect(caught.errors).toEqual([dispatchError, releaseError]);
    expect(caught.cause).toBe(releaseError);
    expect(eventKinds(events)).toEqual(["recover", "claim", "dispatch", "release"]);
  });

  it("stops by clearing timers, awaiting in-flight work, and remaining idempotent", async () => {
    const events: SchedulerLoopEvent[] = [];
    const recoveryGate = Promise.withResolvers<readonly ExpiredSchedulerLeaseRecovery[]>();
    const store = new StrictSchedulerStore({
      events,
      claims: [undefined],
      recoveries: [],
      recoveryGate: recoveryGate.promise,
    });
    const dispatcher = new StrictSchedulerDispatcher({ events, outcomes: [] });
    const loop = createLoop({ store, dispatcher });

    loop.start();
    loop.wake();
    const cycle = loop.runOnce();
    await flushMicrotasks();
    expect(eventKinds(events)).toEqual(["recover"]);
    expect(vi.getTimerCount()).toBe(2);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    recoveryGate.resolve([]);
    await expect(cycle).resolves.toBe(0);
    await stopping;
    expect(stopped).toBe(true);
    await loop.stop();

    loop.wake();
    loop.start();
    expect(vi.getTimerCount()).toBe(0);
  });
});
