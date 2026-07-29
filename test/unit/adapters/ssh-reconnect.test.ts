import { describe, it, expect, vi } from "vitest";
import { createReconnectStrategy } from "@minions/adapters";

/**
 * Unit tests for the SSH reconnect/backoff strategy (PR 53 — ssh-execution-hosts).
 * The strategy is a pure state machine, so `now` and `random` are injected throughout
 * instead of relying on real timers or `Math.random` — no test needs fake timers.
 */

describe("createReconnectStrategy", () => {
  it("starts at attempt 0 and permits a retry before any failures", () => {
    const strategy = createReconnectStrategy();
    expect(strategy.attempt).toBe(0);
    expect(strategy.shouldRetry()).toBe(true);
  });

  it("computes an exponential backoff cap, jittered by the injected random source", () => {
    const strategy = createReconnectStrategy({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      factor: 2,
      random: () => 0.5,
    });
    // cap = min(maxDelayMs, base * factor^attempt); delay = floor(random() * cap).
    expect(strategy.nextDelayMs()).toBe(500); // cap 1_000
    expect(strategy.nextDelayMs()).toBe(1_000); // cap 2_000
    expect(strategy.nextDelayMs()).toBe(2_000); // cap 4_000
    expect(strategy.nextDelayMs()).toBe(4_000); // cap 8_000
  });

  it("plateaus the cap at maxDelayMs once exponential growth exceeds it", () => {
    const strategy = createReconnectStrategy({
      baseDelayMs: 1_000,
      maxDelayMs: 3_000,
      factor: 2,
      maxRetries: 10,
      random: () => 1, // pin delay == cap to expose the plateau directly
    });
    expect(strategy.nextDelayMs()).toBe(1_000);
    expect(strategy.nextDelayMs()).toBe(2_000);
    expect(strategy.nextDelayMs()).toBe(3_000); // capped, would be 4_000 uncapped
    expect(strategy.nextDelayMs()).toBe(3_000); // capped, would be 8_000 uncapped
  });

  it("increments the attempt counter on every nextDelayMs call", () => {
    const strategy = createReconnectStrategy({ random: () => 0 });
    expect(strategy.attempt).toBe(0);
    strategy.nextDelayMs();
    expect(strategy.attempt).toBe(1);
    strategy.nextDelayMs();
    expect(strategy.attempt).toBe(2);
  });

  it("stops permitting retries once maxRetries is reached", () => {
    const strategy = createReconnectStrategy({ maxRetries: 3, random: () => 0 });
    expect(strategy.shouldRetry()).toBe(true);
    strategy.nextDelayMs();
    strategy.nextDelayMs();
    expect(strategy.shouldRetry()).toBe(true);
    strategy.nextDelayMs();
    expect(strategy.attempt).toBe(3);
    expect(strategy.shouldRetry()).toBe(false);
  });

  it("throws if nextDelayMs is called after the retry budget is exhausted", () => {
    const strategy = createReconnectStrategy({ maxRetries: 1, random: () => 0 });
    strategy.nextDelayMs();
    expect(strategy.shouldRetry()).toBe(false);
    expect(() => strategy.nextDelayMs()).toThrow(/retry budget exhausted/);
  });

  it("reset clears the attempt counter and re-enables retries", () => {
    const strategy = createReconnectStrategy({ maxRetries: 2, random: () => 0 });
    strategy.nextDelayMs();
    strategy.nextDelayMs();
    expect(strategy.shouldRetry()).toBe(false);
    strategy.reset();
    expect(strategy.attempt).toBe(0);
    expect(strategy.shouldRetry()).toBe(true);
  });

  it("falls back to Math.random and keeps the jittered delay within [0, cap)", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.3);
    const strategy = createReconnectStrategy({ baseDelayMs: 1_000, maxRetries: 1 });
    expect(strategy.nextDelayMs()).toBe(300);
    randomSpy.mockRestore();
  });

  it("automatically resets an idle attempt count using the injectable clock", () => {
    let time = 0;
    const strategy = createReconnectStrategy({
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      maxRetries: 2,
      now: () => time,
      random: () => 0,
    });
    strategy.nextDelayMs();
    strategy.nextDelayMs();
    expect(strategy.shouldRetry()).toBe(false);

    // Idle threshold is 4 * maxDelayMs (8_000ms here) — advance just past it.
    time += 8_001;
    expect(strategy.shouldRetry()).toBe(true);
    expect(strategy.attempt).toBe(0);
  });

  it("does not reset an in-progress backoff sequence before the idle threshold elapses", () => {
    let time = 0;
    const strategy = createReconnectStrategy({
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      maxRetries: 2,
      now: () => time,
      random: () => 0,
    });
    strategy.nextDelayMs();
    time += 7_000; // still under the 8_000ms idle threshold
    expect(strategy.attempt).toBe(1);
    expect(strategy.shouldRetry()).toBe(true);
  });

  it("uses base=1s, max=30s, factor=2, and maxRetries=5 by default", () => {
    const strategy = createReconnectStrategy({ random: () => 1 }); // pin delay == cap
    expect(strategy.nextDelayMs()).toBe(1_000);
    expect(strategy.nextDelayMs()).toBe(2_000);
    expect(strategy.nextDelayMs()).toBe(4_000);
    expect(strategy.nextDelayMs()).toBe(8_000);
    expect(strategy.nextDelayMs()).toBe(16_000);
    expect(strategy.attempt).toBe(5);
    expect(strategy.shouldRetry()).toBe(false);
  });

  it("rejects invalid configuration up front", () => {
    expect(() => createReconnectStrategy({ baseDelayMs: 0 })).toThrow(RangeError);
    expect(() => createReconnectStrategy({ baseDelayMs: -1 })).toThrow(RangeError);
    expect(() => createReconnectStrategy({ baseDelayMs: 2_000, maxDelayMs: 1_000 })).toThrow(
      RangeError,
    );
    expect(() => createReconnectStrategy({ factor: 1 })).toThrow(RangeError);
    expect(() => createReconnectStrategy({ maxRetries: -1 })).toThrow(RangeError);
    expect(() => createReconnectStrategy({ maxRetries: 1.5 })).toThrow(RangeError);
  });
});
