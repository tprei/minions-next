import {
  defaultSecretPatterns,
  redactObject,
  redactSecrets,
  scanForSecrets,
  type KnownSecret,
} from "@minions/adapters";
import { describe, expect, it } from "vitest";

/**
 * Unit tests for secret-redaction (PR 19, deliverable 8). Covers known-secret
 * literal redaction, default provider token shapes (sk-…, sk-ant-…, JWT, sha256,
 * long hex, opaque base64url), the focused-verification scanForSecrets surface,
 * and the no-crash-on-malformed-input contract.
 */

const knownBearer: KnownSecret = {
  name: "broker_control_bearer",
  value: "CXLhiaunG7fLIlQm38JkiM9UvhIyNsObn5FRPlshBLY",
};
const knownRefresh = "refresh-token-abcdef0123456789";

describe("redactSecrets", () => {
  it("redacts exact known secrets by literal match", () => {
    const text = `broker=${knownBearer.value} refresh=${knownRefresh}`;
    expect(redactSecrets(text, [knownBearer, knownRefresh])).toBe(
      "broker=[REDACTED] refresh=[REDACTED]",
    );
  });

  it("supports bare-string known secrets", () => {
    expect(redactSecrets("abc my-raw-secret-12345 xyz", ["my-raw-secret-12345"])).toBe(
      "abc [REDACTED] xyz",
    );
  });

  it("does not redact trivially short known secrets", () => {
    expect(redactSecrets("short abc", ["abc"])).toBe("short abc");
  });
  it.each([
    ["openai_api_key", "key=sk-proj-abcdefghijklmnop"],
    ["anthropic_api_key", "key=sk-ant-api03-abcdefghijklmnop"],
    ["google_api_key", "key=AIzaSyAabcdefghijklmnopqrstuvwxyz0123456"],
    ["jwt", "Bearer eyJhbGciOiJIUzI1Ni9.eyJzdWIiOiIx.c2lnbmF0dXJl"],
    [
      "sha256_digest",
      "fingerprint sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    ],
    ["long_hex", "hash=abcdef0123456789abcdef0123456789abcdef01234567"],
    ["opaque_base64url", "tok=zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM"],
  ])("redacts the %s provider token shape", (name, text) => {
    const redacted = redactSecrets(text);
    expect(redacted).toContain("[REDACTED]");
    // The redacted output MUST NOT contain the original token shape; we check
    // the distinctive prefix of each pattern (the body is `[REDACTED]`).
    if (name === "openai_api_key") expect(redacted).not.toContain("sk-proj-");
    if (name === "anthropic_api_key") expect(redacted).not.toContain("sk-ant-");
    if (name === "google_api_key") expect(redacted).not.toContain("AIza");
    if (name === "jwt") expect(redacted).not.toContain("eyJ");
    if (name === "sha256_digest") expect(redacted).not.toContain("sha256:");
    if (name === "opaque_base64url") expect(redacted).not.toContain("zMzM");
  });

  it("supports a configurable replacement", () => {
    expect(
      redactSecrets("abc my-raw-secret-12345", ["my-raw-secret-12345"], {
        replacement: "<hidden>",
      }),
    ).toBe("abc <hidden>");
  });

  it("supports extra caller-supplied patterns", () => {
    const out = redactSecrets("client-id=12345 secret=zufälle", [], {
      extraPatterns: [{ name: "client_id", pattern: /\bclient-id=\d+\b/u }],
    });
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("client-id=12345");
  });

  it("does not crash on malformed input", () => {
    expect(redactSecrets(null)).toBe("null");
    expect(redactSecrets(undefined)).toBe("undefined");
    expect(redactSecrets(42)).toBe("42");
    expect(redactSecrets({ a: 1 })).toBe('{"a":1}');
    expect(redactSecrets(() => "x")).toMatch(/=>/u);
  });

  it("preserves non-secret content verbatim", () => {
    const text = "the user jane@example.com ran tree create --max-depth=3";
    expect(redactSecrets(text, [])).toBe(text);
  });
});

describe("redactObject", () => {
  it("redacts values under secret-named keys recursively", () => {
    const value = {
      token: "sk-proj-abcdefghijklmnop",
      nested: { password: "hunter2", data: { auth: "zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM" } },
      keep: "ok",
    };
    const out = redactObject(value, []) as Record<string, unknown>;
    expect(out["token"]).toBe("[REDACTED]");
    expect((out["nested"] as Record<string, unknown>)["password"]).toBe("[REDACTED]");
    expect(
      ((out["nested"] as Record<string, unknown>)["data"] as Record<string, unknown>)["auth"],
    ).toBe("[REDACTED]");
    expect(out["keep"]).toBe("ok");
  });

  it("handles cyclic structures without crashing", () => {
    const cyclic: Record<string, unknown> = { token: "sk-proj-abcdefghijklmnop" };
    cyclic["self"] = cyclic;
    const out = redactObject(cyclic, []) as Record<string, unknown>;
    expect(out["token"]).toBe("[REDACTED]");
    expect(out["self"]).toBe("[REDACTED]");
  });
});

describe("scanForSecrets", () => {
  const targets = (content: unknown) => [
    { kind: "transcript" as const, label: "t1", content },
    {
      kind: "environment" as const,
      label: "env",
      content: "OMP_AUTH_BROKER_TOKEN=" + knownBearer.value,
    },
    { kind: "logs" as const, label: "log", content: "ok" },
  ];

  it("reports hits per (target, pattern) with redacted snippets", () => {
    const hits = scanForSecrets(
      [
        ...targets("Bearer sk-proj-abcdefghijklmnop1234567890"),
        { kind: "workspace" as const, label: "ws", content: "no secrets here" },
      ],
      [knownBearer, knownRefresh],
    );
    const names = hits.map((h) => `${h.kind}:${h.label}:${h.patternName}`).sort();
    expect(names).toContain("transcript:t1:openai_api_key");
    expect(names).toContain("environment:env:known_secret");
    for (const hit of hits) {
      expect(hit.snippet).not.toContain(knownBearer.value);
      expect(hit.snippet).not.toContain("sk-proj-abcdefghijklmnop");
    }
  });

  it("returns no hits when the targets are clean", () => {
    const hits = scanForSecrets(
      [{ kind: "transcript" as const, label: "t1", content: "all clear" }],
      [],
    );
    expect(hits).toEqual([]);
  });

  it("respects extra caller-supplied patterns", () => {
    const hits = scanForSecrets(
      [{ kind: "artifacts" as const, label: "a1", content: "MY-CUSTOM-TOKEN-12345" }],
      [],
      { extraPatterns: [{ name: "custom", pattern: /\bMY-CUSTOM-TOKEN-\d+\b/u }] },
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.patternName).toBe("custom");
  });

  it("does not crash on malformed target content", () => {
    const hits = scanForSecrets(
      [
        { kind: "logs" as const, label: "l1", content: undefined },
        { kind: "logs" as const, label: "l2", content: { broken: true } },
      ],
      [],
    );
    expect(Array.isArray(hits)).toBe(true);
  });
});

describe("defaultSecretPatterns", () => {
  it("exports the expected provider token shapes", () => {
    const names = defaultSecretPatterns.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "openai_api_key",
        "anthropic_api_key",
        "google_api_key",
        "jwt",
        "sha256_digest",
        "long_hex",
        "opaque_base64url",
      ]),
    );
  });
});
