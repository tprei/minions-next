import type { Timestamp } from "./value-objects.js";

export interface Clock {
  now(): Timestamp;
}

export interface IdGenerator {
  nextId(): string;
}

export type DomainPorts = Readonly<{
  clock: Clock;
  ids: IdGenerator;
}>;
