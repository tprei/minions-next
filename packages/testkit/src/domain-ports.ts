import type { Clock, IdGenerator, Timestamp } from "@minions/core";

export class FixedClock implements Clock {
  private readonly timestamp: Timestamp;

  constructor(timestamp: Timestamp) {
    this.timestamp = timestamp;
  }

  now(): Timestamp {
    return this.timestamp;
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private readonly ids: readonly string[];
  private nextIndex = 0;

  constructor(ids: readonly string[]) {
    this.ids = [...ids];
  }

  nextId(): string {
    const id = this.ids[this.nextIndex];
    if (id === undefined) {
      throw new Error("SequenceIdGenerator exhausted: no IDs remain");
    }
    this.nextIndex += 1;
    return id;
  }
}
