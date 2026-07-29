/**
 * Browser-safe UUIDv7 generator (PR 45), matching packages/adapters/src/secure-id-generator.ts
 * byte-for-byte (48-bit millisecond timestamp + version/variant bits + secure random) but built
 * on the Web Crypto API instead of `node:crypto` — `@minions/adapters` is not importable from
 * `apps/web`. Every command/entity id the operator's browser mints (repository ids, tree ids,
 * command ids) uses this so the whole system shares one UUIDv7 identity scheme.
 */
export function generateUuidV7(): string {
  const milliseconds = Date.now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xffffffffffff) {
    throw new RangeError("UUIDv7 timestamp is outside the 48-bit range");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let remaining = milliseconds;
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
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
