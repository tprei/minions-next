/**
 * Client-side field validators (PR 45 — host-repository-task-ui).
 *
 * Every validator returns `undefined` for a valid value or a human-readable error string —
 * never throws. Each mirrors the exact rule apps/cli/src/index.ts enforces for the same
 * `tree create` field, so the browser and the CLI reject the same inputs for the same
 * reasons (`parseBaseCommit`, `parseCanonicalRelativePath`, `parseBudget`, `requiredText`).
 * These run BEFORE any RPC is issued — an invalid form never reaches the network (PR 45
 * acceptance: validation errors block the request client-side).
 */

const GIT_SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;
const BUDGET_PATTERN = /^[0-9]+$/u;
const MAX_BUDGET = 0xffff_ffff;

export function validateRequiredText(value: string, label: string): string | undefined {
  return value.trim().length === 0 ? `${label} must not be empty.` : undefined;
}

export function validateBaseCommit(value: string): string | undefined {
  if (value.trim().length === 0) {
    return "Base commit must not be empty.";
  }
  return GIT_SHA_PATTERN.test(value)
    ? undefined
    : "Base commit must be 40 or 64 lowercase hexadecimal characters.";
}

/** Mirrors apps/cli/src/index.ts's `parseCanonicalRelativePath` exactly: `.` is always
 * accepted; otherwise no leading/trailing slash, no backslash, no Windows drive prefix, no
 * empty/`.`/`..` path segment, and no C0/C1 control characters. */
export function validateCanonicalRelativePath(value: string, label: string): string | undefined {
  if (value.length === 0) {
    return `${label} must be a canonical relative path.`;
  }
  if (value === ".") {
    return undefined;
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:\//u.test(value) ||
    value
      .split("/")
      .some((component) => component === "" || component === "." || component === "..")
  ) {
    return `${label} must be a canonical relative path.`;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return `${label} must be a canonical relative path.`;
    }
  }
  return undefined;
}

/** Mirrors apps/cli/src/index.ts's `parseBudget`: a positive integer from 1 to 4294967295
 * (the uint32 range every `TreeBudget` field is validated against server-side). */
export function validateBudget(value: string, label: string): string | undefined {
  if (!BUDGET_PATTERN.test(value)) {
    return `${label} must be a positive integer.`;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BUDGET) {
    return `${label} must be between 1 and ${String(MAX_BUDGET)}.`;
  }
  return undefined;
}

export function parseBudgetValue(value: string): number {
  const parsed = Number(value);
  if (
    !BUDGET_PATTERN.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_BUDGET
  ) {
    throw new RangeError(`invalid budget value: ${value}`);
  }
  return parsed;
}
