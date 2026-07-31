import { createSecureIdGenerator } from "@minions/adapters";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { describe, expect, it } from "vitest";

const NOW_MS = 1_700_000_000_123;

describe("createSecureIdGenerator", () => {
  it("generates UUIDv7 values with the clock timestamp and required bits", () => {
    const generator = createSecureIdGenerator(
      new FixedClock(timestampFromEpochMilliseconds(NOW_MS)),
    );

    const id = generator.nextId();
    const compact = id.replaceAll("-", "");

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(compact).toHaveLength(32);
    expect(Number.parseInt(compact.slice(0, 12), 16)).toBe(NOW_MS);
    expect(compact[12]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(compact[16]);
  });
});
