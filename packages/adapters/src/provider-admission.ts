/**
 * Provider admission proxy (PR 20). Sits in front of the OMP auth gateway (PR 19) and
 * enforces a per-credential in-flight request limit with a fair FIFO permit queue,
 * cancellation-safe acquire/release, and quota/rate-driven shared pause/resume.
 *
 * ## What the proxy sees
 * Only the attempt identity, an optional cancellation signal, and (on release) a
 * provider response status/headers/body. It NEVER sees provider refresh/access
 * credentials — those live behind the gateway↔broker boundary (SEC-06).
 *
 * ## Cancellation safety (no leaked permits)
 * - A request cancelled while QUEUED is removed from the queue and never reaches the
 *   gateway; no permit was held, so `inFlight` is unchanged.
 * - A request cancelled while IN-FLIGHT (its signal aborts) surrenders its permit
 *   immediately and dequeues the next waiter.
 * - Surrender is idempotent: an abort that races an explicit `release` is a no-op for
 *   the loser, so a permit is freed exactly once. `outstandingPermitCount` reconciles
 *   to zero across every scenario.
 *
 * ## Shared pause/resume (HAR-10 / OPS-05)
 * A quota/rate signal on any release pauses the credential for every queued and
 * future request sharing it; in-flight requests drain and are not re-admitted until
 * resume. Pausing never discards a queued request — it awaits, preserving the OMP
 * session/steering (acceptance 12).
 */

import {
  classifyQuotaSignal,
  effectiveLimit,
  parseRetryAfterMs,
  type AdmissionAbortSignal,
  type AdmissionAcquireResult,
  type AdmissionEventPayload,
  type AdmissionPermit,
  type AdmissionPolicy,
  type AdmissionRequest,
  type AdmissionResult,
  type AdmissionUsage,
  type Clock,
  type CredentialId,
  type CredentialSnapshot,
  type QuotaSignal,
} from "@minions/core";

export type ProviderAdmissionErrorCode =
  | "invalid_policy"
  | "invalid_request"
  | "credential_unknown"
  | "permit_leaked"
  | "shutdown"
  /** Per-credential queue is at capacity (bounded backpressure, not OOM). */
  | "queue_full"
  /** The request was cancelled (via its signal) before or during admission. */
  | "cancelled";

export class ProviderAdmissionError extends Error {
  readonly code: ProviderAdmissionErrorCode;

  constructor(code: ProviderAdmissionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderAdmissionError";
    this.code = code;
  }
}

export type ProviderAdmissionProxyOptions = Readonly<{
  policy: AdmissionPolicy;
  clock: Clock;
  /** Max queued requests per credential (default 64). Excess acquires are rejected. */
  maxQueuePerCredential?: number;
  /** Retained event history for late subscribers / replay (default 1024). */
  maxEventHistory?: number;
  /**
   * Backoff applied when a quota/rate signal arrives without a usable retry-after
   * (absent, zero, or non-finite). Guarantees every pause auto-resumes instead of
   * pausing the credential indefinitely. Defaults to {@link DEFAULT_PAUSE_BACKOFF_MS}.
   */
  defaultPauseBackoffMs?: number;
}>;

export interface ProviderAdmissionProxy {
  /**
   * Acquire a per-credential admission permit. Admits immediately when under the limit
   * and the queue is empty (fair); otherwise the request FIFO-queues and the caller
   * awaits. Cancellation via `request.signal` is honored for both queued and in-flight
   * requests without leaking a permit.
   */
  acquire(request: AdmissionRequest): Promise<AdmissionAcquireResult>;
  /**
   * Surrender a permit and record the result. Classifies the response; a quota/rate
   * signal pauses the credential (shared) and dequeues the next waiter. Must be called
   * once per admitted permit; an abort that already freed the permit makes this a no-op.
   */
  release(permit: AdmissionPermit, result?: AdmissionResult): void;
  /**
   * Acquire → `forward(permit)` → release, guaranteeing release even if `forward`
   * throws or is aborted. The convenience seam for "front the gateway forward": the
   * harness forwards through the gateway between acquire and release.
   */
  execute<T>(
    request: AdmissionRequest,
    forward: (permit: AdmissionPermit) => Promise<{ result?: AdmissionResult; value: T }>,
  ): Promise<T>;
  /** Pause admission for a credential (shared across all queued/in-flight requests). */
  pauseCredential(credentialId: CredentialId, retryAfterMs?: number, reason?: QuotaSignal): void;
  /** Resume admission for a paused credential and drain its queue. */
  resumeCredential(credentialId: CredentialId): void;
  /** Per-credential usage counters; throws `credential_unknown` if never admitted. */
  usage(credentialId: CredentialId): AdmissionUsage;
  /** Point-in-time snapshot of every credential's admission state (doctor/UI). */
  snapshot(): readonly CredentialSnapshot[];
  /** Stable-sequence event stream (replays retained history, then live). */
  events(): AsyncIterable<AdmissionEventPayload>;
  /** Held (not-yet-released) permits; reconciles to zero when idle. */
  readonly outstandingPermitCount: number;
  /** Credentials currently paused (shared backpressure). */
  readonly pausedCredentials: readonly CredentialId[];
  /** Reject queued requests, clear timers, end event streams. Idempotent. */
  shutdown(): Promise<void>;
}

const defaultMaxQueuePerCredential = 64;
const defaultMaxEventHistory = 1024;
const permitPruneThreshold = 1024;

/**
 * Default auto-resume backoff (ms) when a quota/rate signal carries no usable
 * retry-after. Prevents the indefinite-pause self-DoS where a 429 with no retry-after
 * (or `retry-after: "0"`) leaves the credential paused forever. Configurable per-proxy
 * via {@link ProviderAdmissionProxyOptions.defaultPauseBackoffMs}.
 */
const DEFAULT_PAUSE_BACKOFF_MS = 60_000;

export function createProviderAdmissionProxy(
  options: ProviderAdmissionProxyOptions,
): ProviderAdmissionProxy {
  return new ProviderAdmissionProxyImpl(options);
}

/** Handle returned by `setTimeout` for an auto-resume; concrete so contracts avoid `ReturnType`. */
type PauseTimerHandle = NodeJS.Timeout;

interface CredentialSlot {
  credentialId: CredentialId;
  limit: number;
  inFlight: number;
  queued: readonly QueuedEntry[];
  paused: boolean;
  pauseReason?: QuotaSignal;
  pauseRetryAfterMs?: number;
  pauseTimer?: PauseTimerHandle;
  usage: AdmissionUsage;
}

interface QueuedEntry {
  attemptId: string;
  nodeId?: string;
  enqueuedAtMs: number;
  resolve: (result: AdmissionAcquireResult) => void;
  reject: (error: unknown) => void;
  signal?: AdmissionAbortSignal;
  onAbort?: () => void;
}

interface PermitRecord {
  sequence: number;
  slot: CredentialSlot;
  attemptId: string;
  nodeId?: string;
  signal?: AdmissionAbortSignal;
  onAbort?: () => void;
  released: boolean;
  releasedBy?: "release" | "cancel";
}

interface EventSubscriber {
  push: (event: AdmissionEventPayload) => void;
  finish: () => void;
}

class ProviderAdmissionProxyImpl implements ProviderAdmissionProxy {
  private readonly policy: AdmissionPolicy;
  private readonly clock: Clock;
  private readonly maxQueuePerCredential: number;
  private readonly maxEventHistory: number;
  private readonly defaultPauseBackoffMs: number;
  private readonly slots = new Map<CredentialId, CredentialSlot>();
  private readonly permits = new Map<number, PermitRecord>();
  private readonly subscribers = new Set<EventSubscriber>();
  private readonly eventHistory: AdmissionEventPayload[] = [];
  private sequence = 0;
  private outstanding = 0;
  private shutdownRequested = false;

  constructor(options: ProviderAdmissionProxyOptions) {
    this.policy = options.policy;
    this.clock = options.clock;
    this.maxQueuePerCredential = options.maxQueuePerCredential ?? defaultMaxQueuePerCredential;
    this.maxEventHistory = options.maxEventHistory ?? defaultMaxEventHistory;
    this.defaultPauseBackoffMs = options.defaultPauseBackoffMs ?? DEFAULT_PAUSE_BACKOFF_MS;
  }

  get outstandingPermitCount(): number {
    return this.outstanding;
  }

  get pausedCredentials(): readonly CredentialId[] {
    const paused: CredentialId[] = [];
    for (const slot of this.slots.values()) {
      if (slot.paused) {
        paused.push(slot.credentialId);
      }
    }
    return paused;
  }

  acquire(request: AdmissionRequest): Promise<AdmissionAcquireResult> {
    this.assertNotShutdown();
    this.validateRequest(request);
    const slot = this.ensureSlot(request.credentialId);
    if (request.signal?.aborted === true) {
      return Promise.reject(cancelledError(request.attemptId, "queued"));
    }
    // Fair admission: admit immediately only when not paused, under the limit, AND no
    // one is queued (a new request never jumps an existing waiter).
    if (!slot.paused && slot.inFlight < slot.limit && slot.queued.length === 0) {
      const permit = this.admit(slot, request);
      return Promise.resolve<AdmissionAcquireResult>({ permit, queued: false, queuedForMs: 0 });
    }
    if (slot.queued.length >= this.maxQueuePerCredential) {
      return Promise.reject(
        new ProviderAdmissionError(
          "queue_full",
          `admission queue full for credential ${request.credentialId} (capacity ${String(this.maxQueuePerCredential)})`,
        ),
      );
    }
    return this.enqueue(slot, request);
  }

  release(permit: AdmissionPermit, result?: AdmissionResult): void {
    this.finish(permit, "release", result);
  }

  async execute<T>(
    request: AdmissionRequest,
    forward: (permit: AdmissionPermit) => Promise<{ result?: AdmissionResult; value: T }>,
  ): Promise<T> {
    const { permit } = await this.acquire(request);
    let outcome: { result?: AdmissionResult; value: T };
    try {
      outcome = await forward(permit);
    } catch (error) {
      // forward threw (abort or transport error). Surrender without quota
      // classification; if the signal already cancelled the in-flight permit this is
      // a no-op (releasedBy === "cancel"). Never leak the permit.
      this.finish(permit, "release", undefined);
      throw error;
    }
    this.finish(permit, "release", outcome.result);
    return outcome.value;
  }

  pauseCredential(
    credentialId: CredentialId,
    retryAfterMs?: number,
    reason: QuotaSignal = "rate_limited",
  ): void {
    this.assertNotShutdown();
    const slot = this.ensureSlot(credentialId);
    this.pauseSlot(slot, reason, retryAfterMs, "", undefined);
  }

  resumeCredential(credentialId: CredentialId): void {
    this.assertNotShutdown();
    const slot = this.slots.get(credentialId);
    if (slot?.paused !== true) {
      return;
    }
    this.resumeSlot(slot, "explicit_resume");
  }

  usage(credentialId: CredentialId): AdmissionUsage {
    const slot = this.slots.get(credentialId);
    if (slot === undefined) {
      throw new ProviderAdmissionError(
        "credential_unknown",
        `no admission state for credential ${credentialId}`,
      );
    }
    return { ...slot.usage };
  }

  snapshot(): readonly CredentialSnapshot[] {
    const result: CredentialSnapshot[] = [];
    for (const slot of this.slots.values()) {
      result.push({
        credentialId: slot.credentialId,
        limit: slot.limit,
        inFlight: slot.inFlight,
        queued: slot.queued.length,
        paused: slot.paused,
        usage: { ...slot.usage },
        ...(slot.pauseReason !== undefined ? { pauseReason: slot.pauseReason } : {}),
        ...(slot.pauseRetryAfterMs !== undefined
          ? { pauseRetryAfterMs: slot.pauseRetryAfterMs }
          : {}),
      });
    }
    return result;
  }

  events(): AsyncIterable<AdmissionEventPayload> {
    const buffer: AdmissionEventPayload[] = [...this.eventHistory];
    let waiter: ((result: IteratorResult<AdmissionEventPayload>) => void) | null = null;
    let finished = false;

    const subscriber: EventSubscriber = {
      push: (event: AdmissionEventPayload): void => {
        if (waiter !== null) {
          const resolve = waiter;
          waiter = null;
          resolve({ value: event, done: false });
        } else {
          buffer.push(event);
        }
      },
      finish: (): void => {
        finished = true;
        if (waiter !== null) {
          const resolve = waiter;
          waiter = null;
          resolve({ value: undefined, done: true });
        }
      },
    };
    this.subscribers.add(subscriber);

    const iterator: AsyncIterator<AdmissionEventPayload> = {
      next: (): Promise<IteratorResult<AdmissionEventPayload>> => {
        const head = buffer.shift();
        if (head !== undefined) {
          return Promise.resolve({ value: head, done: false });
        }
        if (finished) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<AdmissionEventPayload>>((resolve) => {
          waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<AdmissionEventPayload>> => {
        this.subscribers.delete(subscriber);
        finished = true;
        if (waiter !== null) {
          const resolve = waiter;
          waiter = null;
          resolve({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AdmissionEventPayload> => iterator,
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownRequested) {
      return Promise.resolve();
    }
    this.shutdownRequested = true;
    for (const slot of this.slots.values()) {
      clearTimeout(slot.pauseTimer);
      delete slot.pauseTimer;
      const queue = [...slot.queued];
      (slot.queued as QueuedEntry[]).length = 0;
      for (const entry of queue) {
        detachQueuedListener(entry);
        entry.reject(
          new ProviderAdmissionError(
            "shutdown",
            `admission shut down while queued for attempt ${entry.attemptId}`,
          ),
        );
      }
    }
    for (const subscriber of this.subscribers) {
      subscriber.finish();
    }
    this.subscribers.clear();
    return Promise.resolve();
  }

  private validateRequest(request: AdmissionRequest): void {
    if (typeof request.attemptId !== "string" || request.attemptId.length === 0) {
      throw new ProviderAdmissionError(
        "invalid_request",
        "admission request attemptId must be a non-empty string",
      );
    }
    if (request.nodeId !== undefined && typeof request.nodeId !== "string") {
      throw new ProviderAdmissionError(
        "invalid_request",
        "admission request nodeId must be a string",
      );
    }
  }

  private ensureSlot(credentialId: CredentialId): CredentialSlot {
    let slot = this.slots.get(credentialId);
    if (slot === undefined) {
      slot = {
        credentialId,
        limit: effectiveLimit(this.policy, credentialId),
        inFlight: 0,
        queued: [],
        paused: false,
        usage: zeroUsage(),
      };
      this.slots.set(credentialId, slot);
    }
    return slot;
  }

  private admit(slot: CredentialSlot, request: AdmissionRequest): AdmissionPermit {
    slot.inFlight += 1;
    this.outstanding += 1;
    const sequence = this.nextSequence();
    const permit: AdmissionPermit = {
      credentialId: slot.credentialId,
      attemptId: request.attemptId,
      sequence,
      acquiredAtMs: this.msNow(),
      ...(request.nodeId !== undefined ? { nodeId: request.nodeId } : {}),
    };
    const record: PermitRecord = {
      sequence,
      slot,
      attemptId: request.attemptId,
      released: false,
      ...(request.nodeId !== undefined ? { nodeId: request.nodeId } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    };
    let onAbort: (() => void) | undefined;
    if (request.signal !== undefined) {
      const permitCopy = permit;
      onAbort = (): void => {
        this.finish(permitCopy, "cancel", undefined);
      };
      record.onAbort = onAbort;
    }
    // M-2: the permit must be in the map BEFORE the abort listener is attached. A
    // non-standard signal that dispatches its listener synchronously from
    // addEventListener would otherwise fire onAbort → finish → permits.get === undefined
    // (permit_leaked) while inFlight is already incremented and never decremented.
    this.permits.set(sequence, record);
    if (onAbort !== undefined && request.signal !== undefined) {
      request.signal.addEventListener("abort", onAbort, { once: true });
    }
    this.emitBaseEvent("request_admitted", slot.credentialId, request.attemptId, request.nodeId);
    return permit;
  }

  private enqueue(
    slot: CredentialSlot,
    request: AdmissionRequest,
  ): Promise<AdmissionAcquireResult> {
    return new Promise<AdmissionAcquireResult>((resolve, reject) => {
      const entry: QueuedEntry = {
        attemptId: request.attemptId,
        enqueuedAtMs: this.msNow(),
        resolve,
        reject,
      };
      if (request.nodeId !== undefined) {
        entry.nodeId = request.nodeId;
      }
      if (request.signal !== undefined) {
        entry.signal = request.signal;
      }
      const queue = slot.queued as QueuedEntry[];
      queue.push(entry);
      slot.queued = queue;
      this.emitBaseEvent("request_queued", slot.credentialId, request.attemptId, request.nodeId);
      if (request.signal !== undefined) {
        const signal = request.signal;
        const onAbort = (): void => {
          this.cancelQueued(slot, entry);
        };
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private cancelQueued(slot: CredentialSlot, entry: QueuedEntry): void {
    const queue = slot.queued as QueuedEntry[];
    const index = queue.indexOf(entry);
    if (index === -1) {
      return;
    }
    queue.splice(index, 1);
    slot.queued = queue;
    detachQueuedListener(entry);
    this.emitCancelled(slot.credentialId, entry.attemptId, entry.nodeId, "queued");
    entry.reject(cancelledError(entry.attemptId, "queued"));
  }

  private pump(slot: CredentialSlot): void {
    if (this.shutdownRequested) {
      return;
    }
    const queue = slot.queued as QueuedEntry[];
    while (!slot.paused && slot.inFlight < slot.limit && queue.length > 0) {
      const entry = queue[0];
      if (entry === undefined) {
        break;
      }
      // Defensive: if the signal aborted while queued and the synchronous listener has
      // not yet re-entered, treat it as cancelled rather than admitting a dead request.
      if (entry.signal?.aborted === true) {
        queue.shift();
        detachQueuedListener(entry);
        this.emitCancelled(slot.credentialId, entry.attemptId, entry.nodeId, "queued");
        entry.reject(cancelledError(entry.attemptId, "queued"));
        continue;
      }
      queue.shift();
      slot.queued = queue;
      detachQueuedListener(entry);
      const admittedRequest: AdmissionRequest = {
        credentialId: slot.credentialId,
        attemptId: entry.attemptId,
        ...(entry.nodeId !== undefined ? { nodeId: entry.nodeId } : {}),
        ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
      };
      const permit = this.admit(slot, admittedRequest);
      entry.resolve({ permit, queued: true, queuedForMs: this.msNow() - entry.enqueuedAtMs });
    }
  }

  private finish(
    permit: AdmissionPermit,
    by: "release" | "cancel",
    result: AdmissionResult | undefined,
  ): void {
    const record = this.permits.get(permit.sequence);
    if (record === undefined) {
      throw new ProviderAdmissionError(
        "permit_leaked",
        `admission permit ${String(permit.sequence)} is unknown (already released or never admitted)`,
      );
    }
    if (record.released) {
      // An abort that freed the permit first makes a later explicit release a no-op
      // (legitimate race). A second explicit release is a real leak — fail closed.
      if (by === "release" && record.releasedBy === "cancel") {
        // M-1: the concurrent cancel freed the permit before this deferred release could
        // classify the forward result. A real 429/quota signal must still pause the
        // credential, or backpressure is lost and rate-limits pile up unthrottled. Usage
        // accounting and request_completed are intentionally skipped: the request was
        // already accounted for as cancelled by the cancel path.
        if (result !== undefined) {
          const signal = classifyQuotaSignal(result.statusCode, result.headers, result.body);
          if (signal !== "ok") {
            const retryAfterMs = result.retryAfterMs ?? parseRetryAfterMs(result.headers);
            this.emitQuotaSignal(
              record.slot.credentialId,
              permit.attemptId,
              permit.nodeId,
              signal,
              retryAfterMs,
            );
            this.pauseSlot(record.slot, signal, retryAfterMs, permit.attemptId, permit.nodeId);
          }
        }
        return;
      }
      throw new ProviderAdmissionError(
        "permit_leaked",
        `admission permit ${String(permit.sequence)} already released (by ${record.releasedBy ?? "unknown"})`,
      );
    }
    record.released = true;
    record.releasedBy = by;
    if (record.signal !== undefined && record.onAbort !== undefined) {
      record.signal.removeEventListener("abort", record.onAbort);
    }
    const slot = record.slot;
    this.outstanding = Math.max(0, this.outstanding - 1);
    slot.inFlight = Math.max(0, slot.inFlight - 1);
    if (by === "release") {
      const signal =
        result !== undefined
          ? classifyQuotaSignal(result.statusCode, result.headers, result.body)
          : "ok";
      const inputTokens = result?.inputTokens ?? 0;
      const outputTokens = result?.outputTokens ?? 0;
      slot.usage = addUsage(slot.usage, signal, inputTokens, outputTokens);
      this.emitCompleted(
        slot.credentialId,
        permit.attemptId,
        permit.nodeId,
        signal,
        inputTokens,
        outputTokens,
      );
      if (signal !== "ok") {
        const retryAfterMs =
          result !== undefined
            ? (result.retryAfterMs ?? parseRetryAfterMs(result.headers))
            : undefined;
        this.emitQuotaSignal(
          slot.credentialId,
          permit.attemptId,
          permit.nodeId,
          signal,
          retryAfterMs,
        );
        this.pauseSlot(slot, signal, retryAfterMs, permit.attemptId, permit.nodeId);
      }
    } else {
      this.emitCancelled(slot.credentialId, permit.attemptId, permit.nodeId, "in_flight");
    }
    this.pump(slot);
    this.pruneReleasedPermits();
  }

  private pauseSlot(
    slot: CredentialSlot,
    reason: QuotaSignal,
    retryAfterMs: number | undefined,
    attemptId: string,
    nodeId: string | undefined,
  ): void {
    slot.paused = true;
    slot.pauseReason = reason;
    // H-1 / L-4: a usable retry-after (>0, finite) is honored as-advertised; anything
    // else (absent, `0`, non-finite — many providers omit it, "0" means retry-now) falls
    // back to the default backoff so the credential NEVER pauses indefinitely (self-DoS).
    const validatedRetryAfter: number | undefined =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : undefined;
    // Surface only the provider-advertised delay in the snapshot; the default backoff is
    // an internal safety net, not a signal the provider sent.
    if (validatedRetryAfter !== undefined) {
      slot.pauseRetryAfterMs = validatedRetryAfter;
    } else {
      delete slot.pauseRetryAfterMs;
    }
    clearTimeout(slot.pauseTimer);
    if (this.shutdownRequested) {
      // L-3: a pause triggered during/after shutdown would schedule a timer shutdown
      // already cleared (and will never run productively) — don't leak the handle.
      delete slot.pauseTimer;
      this.emitPaused(slot.credentialId, attemptId, nodeId, reason, retryAfterMs);
      return;
    }
    const effectiveRetryAfterMs = validatedRetryAfter ?? this.defaultPauseBackoffMs;
    const target = slot;
    slot.pauseTimer = setTimeout(() => {
      this.resumeSlot(target, "retry_after_elapsed");
    }, effectiveRetryAfterMs);
    this.emitPaused(slot.credentialId, attemptId, nodeId, reason, retryAfterMs);
  }

  private resumeSlot(
    slot: CredentialSlot,
    reason: "retry_after_elapsed" | "explicit_resume",
  ): void {
    slot.paused = false;
    delete slot.pauseReason;
    delete slot.pauseRetryAfterMs;
    clearTimeout(slot.pauseTimer);
    delete slot.pauseTimer;
    this.emitResumed(slot.credentialId, reason);
    this.pump(slot);
  }

  private emitBaseEvent(
    kind: "request_admitted" | "request_queued",
    credentialId: CredentialId,
    attemptId: string,
    nodeId: string | undefined,
  ): void {
    this.dispatch({
      kind,
      sequence: 0,
      credentialId,
      attemptId,
      emittedAtMs: this.msNow(),
      ...(nodeId !== undefined ? { nodeId } : {}),
    });
  }

  private emitCancelled(
    credentialId: CredentialId,
    attemptId: string,
    nodeId: string | undefined,
    phase: "queued" | "in_flight",
  ): void {
    this.dispatch({
      kind: "request_cancelled",
      sequence: 0,
      credentialId,
      attemptId,
      phase,
      emittedAtMs: this.msNow(),
      ...(nodeId !== undefined ? { nodeId } : {}),
    });
  }

  private emitCompleted(
    credentialId: CredentialId,
    attemptId: string,
    nodeId: string | undefined,
    signal: QuotaSignal,
    inputTokens: number,
    outputTokens: number,
  ): void {
    this.dispatch({
      kind: "request_completed",
      sequence: 0,
      credentialId,
      attemptId,
      signal,
      inputTokens,
      outputTokens,
      emittedAtMs: this.msNow(),
      ...(nodeId !== undefined ? { nodeId } : {}),
    });
  }

  private emitQuotaSignal(
    credentialId: CredentialId,
    attemptId: string,
    nodeId: string | undefined,
    signal: QuotaSignal,
    retryAfterMs: number | undefined,
  ): void {
    this.dispatch({
      kind: "quota_signal",
      sequence: 0,
      credentialId,
      attemptId,
      signal,
      emittedAtMs: this.msNow(),
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private emitPaused(
    credentialId: CredentialId,
    attemptId: string,
    nodeId: string | undefined,
    reason: QuotaSignal,
    retryAfterMs: number | undefined,
  ): void {
    this.dispatch({
      kind: "credential_paused",
      sequence: 0,
      credentialId,
      attemptId,
      reason,
      emittedAtMs: this.msNow(),
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private emitResumed(
    credentialId: CredentialId,
    reason: "retry_after_elapsed" | "explicit_resume",
  ): void {
    this.dispatch({
      kind: "credential_resumed",
      sequence: 0,
      credentialId,
      attemptId: "",
      reason,
      emittedAtMs: this.msNow(),
    });
  }

  private dispatch(event: AdmissionEventPayload): void {
    const stamped = {
      ...event,
      sequence: this.nextSequence(),
      emittedAtMs: this.msNow(),
    } as AdmissionEventPayload;
    this.eventHistory.push(stamped);
    if (this.eventHistory.length > this.maxEventHistory) {
      this.eventHistory.splice(0, this.eventHistory.length - this.maxEventHistory);
    }
    for (const subscriber of this.subscribers) {
      subscriber.push(stamped);
    }
  }

  private pruneReleasedPermits(): void {
    if (this.permits.size <= permitPruneThreshold) {
      return;
    }
    for (const [sequence, record] of this.permits) {
      if (this.permits.size <= permitPruneThreshold) {
        break;
      }
      if (record.released) {
        this.permits.delete(sequence);
      }
    }
  }

  private assertNotShutdown(): void {
    if (this.shutdownRequested) {
      throw new ProviderAdmissionError("shutdown", "provider admission proxy is shut down");
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private msNow(): number {
    return Number(this.clock.now());
  }
}

function cancelledError(attemptId: string, phase: "queued" | "in_flight"): ProviderAdmissionError {
  return new ProviderAdmissionError(
    "cancelled",
    `admission ${phase} request cancelled for attempt ${attemptId}`,
  );
}

function detachQueuedListener(entry: QueuedEntry): void {
  if (entry.signal !== undefined && entry.onAbort !== undefined) {
    entry.signal.removeEventListener("abort", entry.onAbort);
    delete entry.onAbort;
  }
}

function zeroUsage(): AdmissionUsage {
  return { inputTokens: 0, outputTokens: 0, requests: 0, rateLimitedCount: 0 };
}

function addUsage(
  current: AdmissionUsage,
  signal: QuotaSignal,
  inputTokens: number,
  outputTokens: number,
): AdmissionUsage {
  return {
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    requests: current.requests + 1,
    rateLimitedCount: current.rateLimitedCount + (signal !== "ok" ? 1 : 0),
  };
}
