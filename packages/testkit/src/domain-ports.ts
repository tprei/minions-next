import {
  timestampFromEpochMilliseconds,
  type Clock,
  type IdGenerator,
  type Timestamp,
} from "@minions/core";

export class FixedClock implements Clock {
  private readonly timestamp: Timestamp;

  constructor(timestamp: Timestamp) {
    this.timestamp = timestamp;
  }

  now(): Timestamp {
    return this.timestamp;
  }
}

export class AdvancingClock implements Clock {
  private timestamp: Timestamp;

  constructor(timestamp: Timestamp) {
    this.timestamp = timestamp;
  }

  now(): Timestamp {
    return this.timestamp;
  }

  advance(milliseconds: number): Timestamp {
    if (!Number.isSafeInteger(milliseconds)) {
      throw new RangeError("clock advancement must be a safe integer");
    }
    this.timestamp = timestampFromEpochMilliseconds(Number(this.timestamp) + milliseconds);
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
