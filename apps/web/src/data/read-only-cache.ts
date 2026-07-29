import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { GetSnapshotResponseSchema, type GetSnapshotResponse } from "@minions/contracts";
import type { KeyValueStorage } from "./cursor-storage.js";

/**
 * Read-only offline cache (PR 44, PRD UI-11): the PWA persists the last-known-good snapshot so
 * a reload while offline can render *something*, but that render must be unmistakably a stale
 * cache, never live data (PRD UI-08) — this module never exposes a mutation path, and its
 * output type always carries `source: "cache"` so a consumer can't accidentally treat it as
 * live state.
 */
export interface CachedProjection {
  readonly source: "cache";
  readonly snapshot: GetSnapshotResponse;
  readonly cachedAt: number;
}

export class ReadOnlyCache {
  readonly #storage: KeyValueStorage;
  readonly #key: string;

  constructor(storage: KeyValueStorage, key: string) {
    this.#storage = storage;
    this.#key = key;
  }

  save(snapshot: GetSnapshotResponse, now = Date.now()): void {
    const record = { cachedAt: now, snapshot: toJson(GetSnapshotResponseSchema, snapshot) };
    this.#storage.setItem(this.#key, JSON.stringify(record));
  }

  load(): CachedProjection | undefined {
    const raw = this.#storage.getItem(this.#key);
    if (raw === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed) || typeof parsed["cachedAt"] !== "number") return undefined;
    let snapshot: GetSnapshotResponse;
    try {
      snapshot = fromJson(GetSnapshotResponseSchema, parsed["snapshot"] as JsonValue);
    } catch {
      return undefined;
    }
    return { source: "cache", snapshot, cachedAt: parsed["cachedAt"] };
  }

  clear(): void {
    this.#storage.removeItem(this.#key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
