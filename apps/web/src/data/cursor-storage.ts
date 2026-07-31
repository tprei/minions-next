/**
 * Storage abstraction for the event cursor and the read-only offline cache (PR 44 —
 * browser-projection-store, PRD UI-11). Injected rather than hardcoded to `window.localStorage`
 * so the event-client and cache can be exercised deterministically under plain Node (no jsdom)
 * in test/integration, and so the browser runtime and tests share one code path.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Wraps `window.localStorage` for real browser use. */
export function createLocalStorageAdapter(): KeyValueStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => {
      window.localStorage.setItem(key, value);
    },
    removeItem: (key) => {
      window.localStorage.removeItem(key);
    },
  };
}

/** In-memory storage for tests and for environments without persistent storage. */
export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}
