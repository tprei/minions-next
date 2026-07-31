import { randomBytes } from "node:crypto";

import type { Clock, IdGenerator } from "@minions/core";

export function createSecureIdGenerator(clock: Clock): IdGenerator {
  return new SecureUuidV7Generator(clock);
}

class SecureUuidV7Generator implements IdGenerator {
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  nextId(): string {
    const milliseconds = this.#clock.now();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xffffffffffff) {
      throw new RangeError("UUIDv7 timestamp is outside the 48-bit range");
    }
    const bytes = randomBytes(16);
    let remaining: number = milliseconds;
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = remaining & 0xff;
      remaining = Math.floor(remaining / 256);
    }
    const byteSix = bytes[6];
    const byteEight = bytes[8];
    if (byteSix === undefined || byteEight === undefined) {
      throw new Error("secure random UUID buffer is incomplete");
    }
    bytes[6] = (byteSix & 0x0f) | 0x70;
    bytes[8] = (byteEight & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
