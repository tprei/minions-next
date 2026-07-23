import {
  admissionPolicy,
  classifyQuotaSignal,
  credentialId,
  defaultAdmissionPolicy,
  DomainError,
  effectiveLimit,
  parseRetryAfterMs,
  timestampFromEpochMilliseconds,
  validateAdmissionPolicy,
  type AdmissionPolicy,
  type AuditedOverride,
  type QuotaSignal,
} from "@minions/core";
import { describe, expect, it } from "vitest";

const NOW_MS = 1_700_000_000_000;

describe("classifyQuotaSignal", () => {
  it("classifies HTTP 429 without a quota body as rate_limited", () => {
    expect(classifyQuotaSignal(429, {})).toBe<QuotaSignal>("rate_limited");
    expect(classifyQuotaSignal(429, { "retry-after": "30" })).toBe<QuotaSignal>("rate_limited");
  });

  it("classifies a 429 carrying a provider quota body as quota_exceeded", () => {
    expect(
      classifyQuotaSignal(429, {}, { error: { code: "insufficient_quota" } }),
    ).toBe<QuotaSignal>("quota_exceeded");
    expect(classifyQuotaSignal(429, {}, { error: { type: "billing_disabled" } })).toBe<QuotaSignal>(
      "quota_exceeded",
    );
  });

  it("classifies OpenAI-style 429 quota messages as quota_exceeded", () => {
    expect(
      classifyQuotaSignal(
        429,
        { "x-ratelimit-remaining-requests": "0" },
        JSON.stringify({ error: { message: "You exceeded your current quota" } }),
      ),
    ).toBe<QuotaSignal>("quota_exceeded");
  });

  it("classifies provider-overloaded 529 as rate_limited", () => {
    expect(classifyQuotaSignal(529, {})).toBe<QuotaSignal>("rate_limited");
  });

  it("classifies a 403 quota/rate body but treats a bare 403 (even with retry-after) as ok", () => {
    expect(classifyQuotaSignal(403, {}, { error: "insufficient_quota" })).toBe<QuotaSignal>(
      "quota_exceeded",
    );
    expect(classifyQuotaSignal(403, { "retry-after": "10" }, "slow_down please")).toBe<QuotaSignal>(
      "rate_limited",
    );
    // A bare 403 (no rate/quota body marker) is normally auth/permission, not
    // backpressure — do not auto-pause it even when retry-after is present.
    expect(classifyQuotaSignal(403, { "retry-after": "10" })).toBe<QuotaSignal>("ok");
    expect(classifyQuotaSignal(403, {})).toBe<QuotaSignal>("ok");
  });

  it("treats successful and unrelated error statuses as ok (no backpressure)", () => {
    expect(classifyQuotaSignal(200, {})).toBe<QuotaSignal>("ok");
    expect(classifyQuotaSignal(500, {})).toBe<QuotaSignal>("ok");
    expect(classifyQuotaSignal(400, {}, { error: "invalid_request" })).toBe<QuotaSignal>("ok");
  });

  it("matches headers case-insensitively", () => {
    expect(classifyQuotaSignal(429, { "Retry-After": "5" })).toBe<QuotaSignal>("rate_limited");
  });

  it("ignores malformed status codes", () => {
    expect(classifyQuotaSignal(Number.NaN, {})).toBe<QuotaSignal>("ok");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses integer seconds into milliseconds", () => {
    expect(parseRetryAfterMs({ "retry-after": "30" })).toBe(30_000);
    expect(parseRetryAfterMs({ "RETRY-AFTER": "2" })).toBe(2_000);
  });

  it("returns undefined when absent or non-numeric", () => {
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "Wed, 21 Oct 2025 07:28:00 GMT" })).toBeUndefined();
  });
});

describe("effectiveLimit", () => {
  const override: AuditedOverride = {
    credentialId: credentialId("anthropic:codex"),
    limit: 2,
    reason: "operator-approved paired streaming",
    configuredBy: "ops@example.com",
    configuredAt: timestampFromEpochMilliseconds(NOW_MS),
  };
  const policy = admissionPolicy(1, [override]);

  it("returns the default limit for a credential without an override", () => {
    expect(effectiveLimit(policy, credentialId("openai:codex"))).toBe(1);
  });

  it("returns the audited override limit for the configured credential", () => {
    expect(effectiveLimit(policy, credentialId("anthropic:codex"))).toBe(2);
  });

  it("returns the default for an empty-override policy", () => {
    expect(effectiveLimit(defaultAdmissionPolicy(), credentialId("anthropic:codex"))).toBe(1);
  });
});

describe("admissionPolicy", () => {
  const base: AuditedOverride = {
    credentialId: credentialId("anthropic:codex"),
    limit: 2,
    reason: "operator-approved paired streaming",
    configuredBy: "ops@example.com",
    configuredAt: timestampFromEpochMilliseconds(NOW_MS),
  };

  it("rejects duplicate overrides for the same credential (consistency with validateAdmissionPolicy)", () => {
    expect(() => admissionPolicy(1, [base, { ...base, limit: 3 }])).toThrow(DomainError);
  });

  it("accepts distinct credential overrides", () => {
    const policy = admissionPolicy(1, [
      base,
      { ...base, credentialId: credentialId("openai:codex") },
    ]);
    expect(policy.overrides).toHaveLength(2);
  });
});

describe("validateAdmissionPolicy", () => {
  it("accepts a minimal default policy and freezes it", () => {
    const policy = validateAdmissionPolicy({ defaultLimit: 1 });
    expect(policy.defaultLimit).toBe(1);
    expect(policy.overrides).toEqual([]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.overrides)).toBe(true);
  });

  it("brands override credential ids and preserves audit metadata", () => {
    const policy = validateAdmissionPolicy({
      defaultLimit: 1,
      overrides: [
        {
          credentialId: "anthropic:codex",
          limit: 3,
          reason: "approved",
          configuredBy: "ops",
          configuredAt: NOW_MS,
        },
      ],
    });
    expect(policy.overrides[0]?.limit).toBe(3);
    expect(policy.overrides[0]?.configuredBy).toBe("ops");
  });

  it("rejects a default limit below one (fail-closed)", () => {
    expect(() => validateAdmissionPolicy({ defaultLimit: 0 })).toThrow(DomainError);
  });

  it("rejects an un-audited limit raise (override missing audit fields)", () => {
    expect(() =>
      validateAdmissionPolicy({
        defaultLimit: 1,
        overrides: [
          { credentialId: "anthropic:codex", limit: 5 } as unknown as Record<string, unknown>,
        ],
      }),
    ).toThrow(DomainError);
  });

  it("rejects an override with an empty credential id", () => {
    expect(() =>
      validateAdmissionPolicy({
        defaultLimit: 1,
        overrides: [
          { credentialId: "  ", limit: 2, reason: "x", configuredBy: "y", configuredAt: NOW_MS },
        ],
      }),
    ).toThrow(DomainError);
  });

  it("rejects duplicate overrides for the same credential", () => {
    expect(() =>
      validateAdmissionPolicy({
        defaultLimit: 1,
        overrides: [
          {
            credentialId: "anthropic:codex",
            limit: 2,
            reason: "a",
            configuredBy: "ops",
            configuredAt: NOW_MS,
          },
          {
            credentialId: "anthropic:codex",
            limit: 3,
            reason: "b",
            configuredBy: "ops",
            configuredAt: NOW_MS,
          },
        ],
      }),
    ).toThrow(DomainError);
  });

  it("rejects non-object input", () => {
    expect(() => validateAdmissionPolicy("not-a-policy")).toThrow(DomainError);
    expect(() => validateAdmissionPolicy(null)).toThrow(DomainError);
  });
});

describe("credentialId / defaultAdmissionPolicy", () => {
  it("rejects empty credential ids", () => {
    expect(() => credentialId("")).toThrow(DomainError);
    expect(() => credentialId("   ")).toThrow(DomainError);
  });

  it("yields a V1 default of one in-flight request", () => {
    const policy: AdmissionPolicy = defaultAdmissionPolicy();
    expect(policy.defaultLimit).toBe(1);
    expect(policy.overrides).toEqual([]);
  });
});
