/**
 * Secret redaction + scanForSecrets. Pure helpers, no I/O, no crashes on malformed
 * input. Used by the doctor probes, the synthetic runner, and any Minions surface
 * that emits potentially secret-bearing text (transcripts, logs, artifacts).
 *
 * ## Scope (SEC-06)
 * `redactSecrets` rewrites:
 *   - exact known secrets (broker control bearer, gateway bearers, attempt caps,
 *     refresh/access tokens handed to the caller as `KnownSecret`),
 *   - common provider token shapes (OpenAI `sk-…`, Anthropic `sk-ant-…`, OAuth
 *     `eyJ…` JWTs, `sha256:` digests, generic hex ≥40, opaque base64url ≥32),
 *   - anything matched by caller-supplied `extraPatterns`.
 *
 * `scanForSecrets` runs the same matching pass across a set of declared scan
 * targets (environment, transcript, workspace, logs, database, artifacts) and
 * returns hits with redacted snippets — the synthetic runner uses it to prove no
 * provider token survives in any scanned surface.
 *
 * `redactObject` recursively redacts object keys whose names match the secret-key
 * pattern (mirrors the daemon structured logger).
 */

const replacementDefault = "[REDACTED]";
const secretKeyPattern =
  /authorization|cookie|credential|password|secret|token|api[_-]?key|bearer/iu;

export type SecretPattern = Readonly<{ name: string; pattern: RegExp }>;

export type KnownSecret = Readonly<{ name: string; value: string }>;

export type RedactOptions = Readonly<{
  extraPatterns?: readonly SecretPattern[];
  replacement?: string;
}>;

/**
 * Default provider token-shape patterns.
 */
export const defaultSecretPatterns: readonly SecretPattern[] = [
  // OpenAI-style API keys (sk-…).
  { name: "openai_api_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/u },
  // Anthropic API keys (sk-ant-…).
  { name: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{30,}/u },
  // Google AI Studio / Gemini keys.
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/u },
  // OAuth / JWT bearer tokens (three base64url segments separated by dots).
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  // `sha256:<hex>` digest (provider fingerprint shape).
  { name: "sha256_digest", pattern: /\bsha256:[0-9a-f]{64}\b/iu },
  // Long opaque hex (>=40 chars) — covers SHA-1/SHA-256 hashes used as bearer keys.
  { name: "long_hex", pattern: /\b[0-9a-f]{40,}\b/iu },
  // Long opaque base64url token (>=32 chars).
  { name: "opaque_base64url", pattern: /\b[A-Za-z0-9_-]{32,}/u },
];

/**
 * Replace every occurrence of a known or shape-matched secret in `text` with the
 * configured replacement (default `[REDACTED]`). Never throws: malformed input is
 * treated as plain text and returned as-is.
 */
export function redactSecrets(
  text: unknown,
  knownSecrets: readonly (KnownSecret | string)[] = [],
  options: RedactOptions = {},
): string {
  const replacement = options.replacement ?? replacementDefault;
  const input = typeof text === "string" ? text : safeStringify(text);
  const literals = compileKnownSecrets(knownSecrets);
  const shapes = [...defaultSecretPatterns, ...(options.extraPatterns ?? [])];

  let output = input;
  for (const entry of literals) {
    output = output.replaceAll(entry.literal, replacement);
  }
  for (const shape of shapes) {
    const global = withGlobal(shape.pattern);
    output = output.replace(global, replacement);
  }
  return output;
}

/**
 * Recursively redact string values of object keys whose names match the daemon's
 * secret-key pattern. Non-string leaves are kept verbatim; cyclic structures fall
 * back to `[REDACTED]`. Never throws.
 */
export function redactObject(
  value: unknown,
  knownSecrets: readonly (KnownSecret | string)[] = [],
): unknown {
  return redactObjectInternal(value, knownSecrets, new WeakSet<object>());
}

export type SecretScanTargetKind =
  "environment" | "transcript" | "workspace" | "logs" | "database" | "artifacts";

export type SecretScanTarget = Readonly<{
  kind: SecretScanTargetKind;
  label: string;
  content: unknown;
}>;

export type SecretScanHit = Readonly<{
  kind: SecretScanTargetKind;
  label: string;
  patternName: string;
  /** Redacted snippet showing the immediate context around the hit. */
  snippet: string;
}>;

export type ScanOptions = Readonly<{
  extraPatterns?: readonly SecretPattern[];
  snippetRadius?: number;
}>;

/**
 * Scan declared targets for any known secret or provider token shape. Returns one
 * hit per (target, pattern) match. Snippets are themselves redacted to avoid
 * leaking the discovered secret through the report. Never throws.
 */
export function scanForSecrets(
  targets: readonly SecretScanTarget[],
  knownSecrets: readonly (KnownSecret | string)[] = [],
  options: ScanOptions = {},
): readonly SecretScanHit[] {
  const radius = options.snippetRadius ?? 24;
  const literals = compileKnownSecrets(knownSecrets);
  const shapes = [...defaultSecretPatterns, ...(options.extraPatterns ?? [])];

  const hits: SecretScanHit[] = [];
  for (const target of targets) {
    const text =
      typeof target.content === "string" ? target.content : safeStringify(target.content);
    for (const entry of literals) {
      for (const match of text.matchAll(entry.global)) {
        const index = match.index;
        hits.push({
          kind: target.kind,
          label: target.label,
          patternName: "known_secret",
          snippet: redactSecrets(snippetAround(text, index, entry.literal.length, radius)),
        });
      }
    }
    for (const shape of shapes) {
      const global = withGlobal(shape.pattern);
      for (const match of text.matchAll(global)) {
        const index = match.index;
        const length = match[0].length;
        hits.push({
          kind: target.kind,
          label: target.label,
          patternName: shape.name,
          snippet: redactSecrets(snippetAround(text, index, length, radius)),
        });
      }
    }
  }
  return hits;
}

// -------------------------------------------------------------------------------------------------
// Internals.
// -------------------------------------------------------------------------------------------------

type CompiledSecret = Readonly<{ literal: string; global: RegExp }>;

function compileKnownSecrets(
  secrets: readonly (KnownSecret | string)[],
): readonly CompiledSecret[] {
  const compiled: CompiledSecret[] = [];
  for (const entry of secrets) {
    const value = typeof entry === "string" ? entry : entry.value;
    if (typeof value !== "string" || value.length < 6) {
      // Skip trivially short values — they would over-redact incidental substrings.
      continue;
    }
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    compiled.push({ literal: value, global: new RegExp(escaped, "gu") });
  }
  return compiled;
}

function snippetAround(text: string, index: number, length: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function withGlobal(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function redactObjectInternal(
  value: unknown,
  knownSecrets: readonly (KnownSecret | string)[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactObjectInternal(entry, knownSecrets, seen));
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[REDACTED]";
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = secretKeyPattern.test(key)
        ? "[REDACTED]"
        : redactObjectInternal(entry, knownSecrets, seen);
    }
    return out;
  }
  return value;
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function") return String(value);
  if (typeof value === "symbol") return value.toString();
  try {
    // JSON.stringify is typed as `string`, but at runtime it returns `undefined`
    // when a top-level object's `toJSON()` returns `undefined`; hold the result as
    // `unknown` and narrow explicitly so the defensive fallback survives.
    const json: unknown = JSON.stringify(value, (_key, replacement) => {
      if (typeof replacement === "bigint") return replacement.toString();
      if (typeof replacement === "function") return "[function]";
      return redactObjectInternal(replacement, [], new WeakSet<object>());
    });
    return typeof json === "string" ? json : Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
