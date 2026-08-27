import { describe, expect, it } from "vitest";
import {
  CommandReceiptStore,
  createMemoryStorage,
  type KeyValueStorage,
  type ReceiptState,
} from "../../apps/web/src/data/index.js";

describe("CommandReceiptStore", () => {
  it("tracks the requested -> delivered -> applied lifecycle", () => {
    const store = new CommandReceiptStore();
    store.markRequested("cmd-1", 100);
    expect(store.get("cmd-1")).toEqual({ status: "requested", requestedAt: 100 });

    store.markDelivered("cmd-1", 110);
    expect(store.get("cmd-1")).toEqual({ status: "delivered", requestedAt: 100, deliveredAt: 110 });

    store.markApplied("cmd-1", 120);
    const applied: ReceiptState = {
      status: "applied",
      requestedAt: 100,
      deliveredAt: 110,
      appliedAt: 120,
    };
    expect(store.get("cmd-1")).toEqual(applied);
  });

  it("tracks a failed command with its reason", () => {
    const store = new CommandReceiptStore();
    store.markRequested("cmd-2", 100);
    store.markFailed("cmd-2", "daemon unavailable", 105);
    expect(store.get("cmd-2")).toEqual({
      status: "failed",
      requestedAt: 100,
      failedAt: 105,
      reason: "daemon unavailable",
    });
  });

  it("returns a fresh snapshot reference on every write, and the same reference otherwise", () => {
    const store = new CommandReceiptStore();
    const before = store.getSnapshot();
    store.markRequested("cmd-3", 1);
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(store.getSnapshot()).toBe(after);
  });

  it("notifies subscribers on every state change", () => {
    const store = new CommandReceiptStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.markRequested("cmd-4", 1);
    store.markDelivered("cmd-4", 2);
    unsubscribe();
    store.markApplied("cmd-4", 3);
    expect(notifications).toBe(2);
  });
});

describe("createMemoryStorage", () => {
  it("implements get/set/remove independent of any real browser globals", () => {
    const storage: KeyValueStorage = createMemoryStorage();
    expect(storage.getItem("k")).toBeNull();
    storage.setItem("k", "v");
    expect(storage.getItem("k")).toBe("v");
    storage.removeItem("k");
    expect(storage.getItem("k")).toBeNull();
  });
});
