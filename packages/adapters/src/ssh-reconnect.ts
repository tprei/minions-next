/**
 * SSH reconnect/backoff strategy (PR 53 — ssh-execution-hosts).
 *
 * Computes the delay before the next SSH reconnect attempt using exponential backoff
 * with full jitter, and tracks whether a caller has exhausted its retry budget. This is
 * a pure state machine: it never sleeps, retries, or touches the network — callers (e.g.
 * `createSshConnection`) drive the loop themselves, awaiting `nextDelayMs()` between
 * failed `connect()` attempts and calling `reset()` once a connection succeeds.
 */

// -------------------------------------------------------------------------------------------------
// Types.
// -------------------------------------------------------------------------------------------------

export type ReconnectStrategyOptions = Readonly<{
  /** Delay before the first retry, in milliseconds. Defaults to {@link DEFAULT_BASE_DELAY_MS}. */
  readonly baseDelayMs?: number;
  /** Upper bound on the pre-jitter computed delay, in milliseconds. Defaults to {@link DEFAULT_MAX_DELAY_MS}. */
  readonly maxDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Defaults to {@link DEFAULT_FACTOR}. */
  readonly factor?: number;
  /** Number of retry attempts allowed before `shouldRetry()` returns false. Defaults to {@link DEFAULT_MAX_RETRIES}. */
  readonly maxRetries?: number;
  /**
   * Clock used to timestamp attempts and detect a stale backoff sequence. Test seam —
   * defaults to `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Source of uniform randomness in `[0, 1)` used to jitter each delay. Test seam —
   * defaults to `Math.random`.
   */
  readonly random?: () => number;
}>;

export interface ReconnectStrategy {
  /** Number of failed attempts recorded since the last `reset()` (or since creation). */
  readonly attempt: number;
  /** Whether another retry attempt is permitted given the current attempt count. */
  shouldRetry(): boolean;
  /**
   * Compute the jittered delay (ms) before the next retry attempt and record the
   * attempt. Callers MUST check `shouldRetry()` first — calling this after the retry
   * budget is exhausted throws.
   */
  nextDelayMs(): number;
  /** Clear the attempt counter, e.g. after a successful reconnect. */
  reset(): void;
}

// -------------------------------------------------------------------------------------------------
// Implementation.
// -------------------------------------------------------------------------------------------------

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_FACTOR = 2;
const DEFAULT_MAX_RETRIES = 5;

/**
 * Create an exponential-backoff-with-jitter strategy for SSH reconnect attempts.
 *
 * Backoff follows the "full jitter" shape from the AWS architecture blog: the pre-jitter
 * delay doubles (by default) after each attempt up to `maxDelayMs`, and the actual delay
 * returned is a uniform random value in `[0, cap]`. Full jitter — rather than a fixed or
 * additive jitter window — avoids many clients retrying in lockstep after a shared outage.
 */
export function createReconnectStrategy(options: ReconnectStrategyOptions = {}): ReconnectStrategy {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const factor = options.factor ?? DEFAULT_FACTOR;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
    throw new RangeError(
      `baseDelayMs must be a positive finite number, got ${String(baseDelayMs)}`,
    );
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new RangeError(
      `maxDelayMs must be a finite number >= baseDelayMs, got ${String(maxDelayMs)}`,
    );
  }
  if (!Number.isFinite(factor) || factor <= 1) {
    throw new RangeError(`factor must be a finite number greater than 1, got ${String(factor)}`);
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError(`maxRetries must be a non-negative integer, got ${String(maxRetries)}`);
  }

  // Idle window after which a fresh failure starts a new backoff sequence instead of
  // continuing the previous one. Guards a connection that failed once, stayed healthy
  // for hours, then failed again from being penalized with the tail of the old curve.
  // Set well above maxDelayMs so a genuine retry burst is never affected.
  const idleResetAfterMs = maxDelayMs * 4;

  let attempt = 0;
  let lastAttemptAt: number | null = null;

  function reclaimIfIdle(): void {
    if (lastAttemptAt !== null && now() - lastAttemptAt > idleResetAfterMs) {
      attempt = 0;
      lastAttemptAt = null;
    }
  }

  function shouldRetry(): boolean {
    reclaimIfIdle();
    return attempt < maxRetries;
  }

  function nextDelayMs(): number {
    reclaimIfIdle();
    if (attempt >= maxRetries) {
      throw new Error(
        `SSH reconnect retry budget exhausted after ${String(maxRetries)} attempt(s); call reset() before retrying again.`,
      );
    }
    // cap = min(maxDelayMs, baseDelayMs * factor^attempt), then a uniform jittered delay in [0, cap).
    const cap = Math.min(maxDelayMs, baseDelayMs * factor ** attempt);
    const delay = Math.floor(random() * cap);
    attempt += 1;
    lastAttemptAt = now();
    return delay;
  }

  function reset(): void {
    attempt = 0;
    lastAttemptAt = null;
  }

  return Object.freeze({
    get attempt() {
      return attempt;
    },
    shouldRetry,
    nextDelayMs,
    reset,
  });
}
