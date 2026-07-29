import { describe, it, expect } from "vitest";
import { validatePushPayload, redactPushPayload, type PushPayload } from "@minions/core";

function payload(overrides: Partial<PushPayload> = {}): PushPayload {
  return Object.freeze({
    treeId: "tree-001",
    nodeId: "node-001",
    kind: "attention",
    title: "Node needs your answer",
    ...overrides,
  });
}

describe("validatePushPayload", () => {
  it("accepts a valid payload for each kind", () => {
    for (const kind of ["attention", "outcome", "command_receipt"] as const) {
      expect(validatePushPayload(payload({ kind })).valid).toBe(true);
    }
  });

  it("rejects empty treeId", () => {
    const v = validatePushPayload(payload({ treeId: "  " }));
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("treeId");
  });

  it("rejects empty nodeId", () => {
    const v = validatePushPayload(payload({ nodeId: "" }));
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("nodeId");
  });

  it("checks treeId before nodeId", () => {
    const v = validatePushPayload(payload({ treeId: "", nodeId: "" }));
    expect(v.reason).toContain("treeId");
  });

  it("rejects unknown kind", () => {
    const v = validatePushPayload(payload({ kind: "evil" as unknown as PushPayload["kind"] }));
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("unknown kind");
  });

  it("returns frozen verdicts", () => {
    const v = validatePushPayload(payload());
    expect(Object.isFrozen(v)).toBe(true);
  });
});

describe("redactPushPayload", () => {
  it("strips the title", () => {
    const r = redactPushPayload(payload({ title: "secret content" }));
    expect(r.title).toBe("[REDACTED]");
  });

  it("preserves routing ids and kind", () => {
    const r = redactPushPayload(payload());
    expect(r.treeId).toBe("tree-001");
    expect(r.nodeId).toBe("node-001");
    expect(r.kind).toBe("attention");
  });

  it("returns frozen output", () => {
    expect(Object.isFrozen(redactPushPayload(payload()))).toBe(true);
  });
});
