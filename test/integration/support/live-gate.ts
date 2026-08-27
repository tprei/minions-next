/**
 * Live dependency gate (Remediation Plan Section 7a).
 *
 * `LIVE_DEPS` declares which external live dependencies the current environment
 * guarantees (comma-separated, e.g. `LIVE_DEPS=omp`). CI declares the ones its
 * setup steps install; local development declares none and skips cleanly. A
 * dependency that is declared but unavailable fails at collection time, so a
 * broken CI setup step can never silently downgrade live tests to skips.
 */

export function requireLiveDependency(name: string, available: boolean): boolean {
  const declared = (process.env["LIVE_DEPS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!declared.includes(name)) return available;
  if (!available) {
    throw new Error(`live dependency "${name}" is declared in LIVE_DEPS but unavailable`);
  }
  return true;
}
