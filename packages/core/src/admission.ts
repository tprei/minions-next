/**
 * Provider admission domain kernel (PR 20). Pure types + functions only — NO I/O.
 *
 * This module models the *policy* and *classification* of per-credential provider
 * admission: the default in-flight limit (one), audited overrides that raise it,
 * quota/rate classification of a provider response, and the event/usage payloads the
 * admission proxy emits. The {@link ProviderAdmissionProxy} (in `@minions/adapters`)
 * is the only runtime consumer; everything here is deterministic and side-effect free
 * so it is unit-testable without a provider, a clock, or a queue.
 *
 * HAR-09: admission is global per credential, separate from node concurrency.
 * HAR-10: default limit is ONE; a higher limit requires an explicit audited override;
 * provider quota/rate signals pause admission across every node sharing a credential.
 */

import { DomainError } from "./domain-error.js";
import { timestampFromEpochMilliseconds, type Timestamp } from "./value-objects.js";

declare const credentialIdBrand: unique symbol;

/**
 * Per-credential admission key. Branded so it cannot be confused with an attempt id,
 * host id, or any other opaque string at the type level.
 */
export type CredentialId = string & { readonly [credentialIdBrand]: true };

/**
 * Operator setting that RAISES the per-credential in-flight limit above the default.
 * Every field is auditable: raising a limit is never silent (HAR-10 acceptance).
 */
export type AuditedOverride = Readonly<{
  credentialId: CredentialId;
  limit: number;
  reason: string;
  configuredBy: string;
  configuredAt: Timestamp;
}>;

/**
 * Unvalidated configuration shape (plain strings, unbranded) accepted from daemon
 * config / files. {@link validateAdmissionPolicy} brands + freezes it into an
 * {@link AdmissionPolicy}.
 */
export type AdmissionPolicyConfig = Readonly<{
  defaultLimit: number;
  overrides?: readonly Readonly<{
    credentialId: string;
    limit: number;
    reason: string;
    configuredBy: string;
    configuredAt: number;
  }>[];
}>;

/**
 * Validated, frozen admission policy. `defaultLimit` is enforced `>= 1` (the V1
 * default is one in-flight request per credential — HAR-10). Overrides reference
 * real, non-empty credential ids and carry full audit metadata.
 */
export type AdmissionPolicy = Readonly<{
  defaultLimit: number;
  overrides: readonly AuditedOverride[];
}>;

/** Classification of a provider response from the admission perspective. */
export type QuotaSignal = "ok" | "rate_limited" | "quota_exceeded";

/**
 * A request to acquire a per-credential admission permit. The proxy never sees
 * provider refresh/access credentials — only the attempt identity and an optional
 * cancellation signal.
 */
/**
 * Structural abort-signal surface the admission kernel depends on. Declared here so
 * the kernel stays free of `node:` and DOM type dependencies; a runtime `AbortSignal`
 * is structurally assignable (method bivariance) and is what callers pass in practice.
 */
export interface AdmissionAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: AdmissionAbortListener,
    options?: AdmissionAbortOptions,
  ): void;
  removeEventListener(type: "abort", listener: AdmissionAbortListener): void;
}

export type AdmissionAbortListener = () => void;

export type AdmissionAbortOptions = Readonly<{ once?: boolean }>;

export type AdmissionRequest = Readonly<{
  credentialId: CredentialId;
  attemptId: string;
  nodeId?: string;
  signal?: AdmissionAbortSignal;
}>;

/**
 * A granted admission permit. Handed back from {@link ProviderAdmissionProxy.acquire}
 * and surrendered via `release`. The `sequence` shares the proxy's monotonic sequence
 * space with emitted events, so a permit and its lifecycle events correlate exactly.
 */
export type AdmissionPermit = Readonly<{
  credentialId: CredentialId;
  attemptId: string;
  sequence: number;
  acquiredAtMs: number;
  nodeId?: string;
}>;

/** Result of {@link ProviderAdmissionProxy.acquire}: the permit + queueing metadata. */
export type AdmissionAcquireResult = Readonly<{
  permit: AdmissionPermit;
  /** `true` when the request waited in the per-credential queue before admission. */
  queued: boolean;
  /** Milliseconds spent waiting in the queue (0 when admitted immediately). */
  queuedForMs: number;
}>;

/**
 * A provider response handed to `release` so the proxy can classify it, record usage,
 * and (on a quota/rate signal) pause the credential. The proxy inspects only the
 * status/headers/body it needs to classify backpressure — never provider credentials.
 */
export type AdmissionResult = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  /** Optional parsed `retry-after` (ms). Overrides header parsing when provided. */
  retryAfterMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}>;

/** Per-credential usage counters surfaced to doctor/UI reporting. */
export type AdmissionUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /** Completed requests that triggered backpressure (rate-limited or quota-exceeded). */
  rateLimitedCount: number;
}>;

/** Point-in-time view of one credential's admission state (doctor/UI snapshot). */
export type CredentialSnapshot = Readonly<{
  credentialId: CredentialId;
  limit: number;
  inFlight: number;
  queued: number;
  paused: boolean;
  pauseReason?: QuotaSignal;
  pauseRetryAfterMs?: number;
  usage: AdmissionUsage;
}>;

export type AdmissionEventKind =
  | "credential_paused"
  | "credential_resumed"
  | "request_admitted"
  | "request_queued"
  | "request_completed"
  | "request_cancelled"
  | "quota_signal";

type AdmissionEventBase = Readonly<{
  sequence: number;
  credentialId: CredentialId;
  attemptId: string;
  nodeId?: string;
  emittedAtMs: number;
}>;

export type CredentialPausedPayload = AdmissionEventBase &
  Readonly<{ kind: "credential_paused"; reason: QuotaSignal; retryAfterMs?: number }>;

export type CredentialResumedPayload = AdmissionEventBase &
  Readonly<{ kind: "credential_resumed"; reason: "retry_after_elapsed" | "explicit_resume" }>;

export type RequestAdmittedPayload = AdmissionEventBase & Readonly<{ kind: "request_admitted" }>;

export type RequestQueuedPayload = AdmissionEventBase & Readonly<{ kind: "request_queued" }>;

export type RequestCompletedPayload = AdmissionEventBase &
  Readonly<{
    kind: "request_completed";
    signal: QuotaSignal;
    inputTokens: number;
    outputTokens: number;
  }>;

export type RequestCancelledPayload = AdmissionEventBase &
  Readonly<{ kind: "request_cancelled"; phase: "queued" | "in_flight" }>;

export type QuotaSignalPayload = AdmissionEventBase &
  Readonly<{ kind: "quota_signal"; signal: QuotaSignal; retryAfterMs?: number }>;

/**
 * Discriminated union of admission events. Every member carries a stable monotonic
 * `sequence` plus `credentialId`/`attemptId`/`nodeId` for correlation (scheduler/UI).
 */
export type AdmissionEventPayload =
  | CredentialPausedPayload
  | CredentialResumedPayload
  | RequestAdmittedPayload
  | RequestQueuedPayload
  | RequestCompletedPayload
  | RequestCancelledPayload
  | QuotaSignalPayload;

const strongQuotaMarkers: readonly string[] = [
  "insufficient_quota",
  "quota",
  "billing",
  "credit",
  "plan_limit",
  "usage limit",
  "limit_reached",
  "exceeded your current quota",
];

const rateMarkers: readonly string[] = [
  "rate_limit",
  "rate limit",
  "ratelimit",
  "too many requests",
  "overloaded",
  "slow_down",
  "throttl",
];

/**
 * Brand a non-empty string as a {@link CredentialId}. Fail-closed: an empty/whitespace
 * id is rejected because an empty key would collapse distinct credentials.
 */
export function credentialId(value: string): CredentialId {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("invalid_value", "credential id must be a non-empty string");
  }
  return value as CredentialId;
}

/** The V1 default policy: one in-flight request per credential, no overrides. */
export function defaultAdmissionPolicy(): AdmissionPolicy {
  return Object.freeze({ defaultLimit: 1, overrides: Object.freeze([]) });
}

/**
 * Construct an {@link AdmissionPolicy} from validated inputs. Prefer
 * {@link validateAdmissionPolicy} for untrusted config; this is the typed convenience.
 */
export function admissionPolicy(
  defaultLimit: number,
  overrides: readonly AuditedOverride[] = [],
): AdmissionPolicy {
  requirePositiveInteger(defaultLimit, "defaultLimit");
  const seen = new Set<CredentialId>();
  for (const [index, entry] of overrides.entries()) {
    requirePositiveInteger(entry.limit, `overrides[${String(index)}].limit`);
    if (seen.has(entry.credentialId)) {
      throw new DomainError(
        "invalid_value",
        `admission policy has a duplicate override for credential ${entry.credentialId}`,
      );
    }
    seen.add(entry.credentialId);
  }
  return Object.freeze({ defaultLimit, overrides: Object.freeze([...overrides]) });
}

/** The effective in-flight limit for a credential: its audited override, else default. */
export function effectiveLimit(policy: AdmissionPolicy, credential: CredentialId): number {
  for (const override of policy.overrides) {
    if (override.credentialId === credential) {
      return override.limit;
    }
  }
  return policy.defaultLimit;
}

/**
 * Classify a provider response as admission backpressure.
 *
 * - HTTP 429 → `rate_limited`, unless the body carries a strong provider quota marker
 *   (`insufficient_quota`, `billing`, `credit`, …) → `quota_exceeded`.
 * - HTTP 529 (provider overloaded, e.g. Anthropic) → `rate_limited`.
 * - HTTP 400/402/403 with a quota body → `quota_exceeded`; with a rate body → `rate_limited`.
 * - Anything else → `ok` (no backpressure; do not pause on transient/garbage responses).
 *
 * Header lookup is case-insensitive. `body` may be a string or a JSON-parseable value.
 */
export function classifyQuotaSignal(
  statusCode: number,
  headers: Readonly<Record<string, string>>,
  body?: unknown,
): QuotaSignal {
  if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return "ok";
  }
  const text = bodyToText(body);
  if (statusCode === 429) {
    return containsAny(text, strongQuotaMarkers) ? "quota_exceeded" : "rate_limited";
  }
  if (statusCode === 529) {
    return "rate_limited";
  }
  if (
    containsAny(text, strongQuotaMarkers) &&
    (statusCode === 400 || statusCode === 402 || statusCode === 403)
  ) {
    return "quota_exceeded";
  }
  if (containsAny(text, rateMarkers) && (statusCode === 400 || statusCode === 403)) {
    return "rate_limited";
  }
  // A bare 403 is normally an auth/permission failure, not backpressure: do not auto-pause
  // on it even when a retry-after header is present. Only an explicit rate/quota body marker
  // (handled above) classifies a 403 as admission backpressure.
  return "ok";
}

/**
 * Parse an HTTP `retry-after` header into milliseconds. Handles the dominant integer
 * (seconds) form. Pure: does not read the wall clock, so the rare HTTP-date form is
 * not translated (providers send integer seconds; callers may pass `retryAfterMs`
 * directly on {@link AdmissionResult} for date-form values).
 */
export function parseRetryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const raw = readHeader(headers, "retry-after");
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}

/**
 * Validate untrusted policy config into a frozen {@link AdmissionPolicy}. Fail-closed:
 * `defaultLimit` must be a positive integer, overrides must reference non-empty
 * credential ids with complete audit metadata, and no two overrides may target the
 * same credential.
 */
export function validateAdmissionPolicy(value: unknown): AdmissionPolicy {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("invalid_value", "admission policy must be an object");
  }
  const record = value as Record<string, unknown>;
  const defaultLimit = requirePositiveInteger(record["defaultLimit"], "defaultLimit");
  const overridesRaw = record["overrides"];
  const overrides: AuditedOverride[] = [];
  if (overridesRaw !== undefined) {
    if (!Array.isArray(overridesRaw)) {
      throw new DomainError("invalid_value", "admission policy overrides must be an array");
    }
    for (const [index, entry] of overridesRaw.entries()) {
      overrides.push(validateOverride(entry, index));
    }
    const seen = new Set<string>();
    for (const override of overrides) {
      if (seen.has(override.credentialId)) {
        throw new DomainError(
          "invalid_value",
          `admission policy has a duplicate override for credential ${override.credentialId}`,
        );
      }
      seen.add(override.credentialId);
    }
  }
  return Object.freeze({ defaultLimit, overrides: Object.freeze(overrides) });
}

function validateOverride(value: unknown, index: number): AuditedOverride {
  const label = `admission override[${String(index)}]`;
  if (typeof value !== "object" || value === null) {
    throw new DomainError("invalid_value", `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const rawId = record["credentialId"];
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    throw new DomainError("invalid_value", `${label}.credentialId must be a non-empty string`);
  }
  const limit = requirePositiveInteger(record["limit"], `${label}.limit`);
  const reason = record["reason"];
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new DomainError("invalid_value", `${label}.reason must be a non-empty string`);
  }
  const configuredBy = record["configuredBy"];
  if (typeof configuredBy !== "string" || configuredBy.trim().length === 0) {
    throw new DomainError("invalid_value", `${label}.configuredBy must be a non-empty string`);
  }
  const configuredAt = record["configuredAt"];
  if (typeof configuredAt !== "number" || !Number.isSafeInteger(configuredAt) || configuredAt < 0) {
    throw new DomainError(
      "invalid_value",
      `${label}.configuredAt must be a non-negative integer (epoch ms)`,
    );
  }
  return Object.freeze({
    credentialId: credentialId(rawId),
    limit,
    reason,
    configuredBy,
    configuredAt: timestampFromEpochMilliseconds(configuredAt),
  });
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DomainError("invalid_value", `${fieldName} must be a positive integer`);
  }
  return value;
}

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key];
    }
  }
  return undefined;
}

function bodyToText(body: unknown): string {
  if (typeof body === "string") {
    return body.toLowerCase();
  }
  if (body === undefined || body === null) {
    return "";
  }
  try {
    return JSON.stringify(body).toLowerCase();
  } catch {
    // Circular / non-serializable body: no reliable substring to match against.
    return "[object]";
  }
}

function containsAny(text: string, markers: readonly string[]): boolean {
  for (const marker of markers) {
    if (text.includes(marker)) {
      return true;
    }
  }
  return false;
}
