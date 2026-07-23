import { createProviderAdmissionProxy, ProviderAdmissionError } from "@minions/adapters";
import {
  credentialId,
  defaultAdmissionPolicy,
  timestampFromEpochMilliseconds,
  validateAdmissionPolicy,
  type AdmissionEventPayload,
  type AdmissionPermit,
  type AdmissionPolicy,
} from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { describe, expect, it } from "vitest";

const NOW_MS = 1_700_000_000_000;
const CREDENTIAL = credentialId("anthropic:codex");

function createProxy(
  policy: AdmissionPolicy,
  options?: {
    maxQueuePerCredential?: number;
    maxEventHistory?: number;
    defaultPauseBackoffMs?: number;
  },
) {
  return createProviderAdmissionProxy({
    policy,
    clock: new FixedClock(timestampFromEpochMilliseconds(0)),
    ...(options?.maxQueuePerCredential !== undefined
      ? { maxQueuePerCredential: options.maxQueuePerCredential }
      : {}),
    ...(options?.maxEventHistory !== undefined ? { maxEventHistory: options.maxEventHistory } : {}),
    ...(options?.defaultPauseBackoffMs !== undefined
      ? { defaultPauseBackoffMs: options.defaultPauseBackoffMs }
      : {}),
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Gate {
  readonly promise: Promise<undefined>;
  resolve: () => void;
}

function gate(): Gate {
  const controls = Promise.withResolvers<undefined>();
  return {
    promise: controls.promise,
    resolve: () => {
      controls.resolve(undefined);
    },
  };
}

interface EventCollector {
  readonly events: AdmissionEventPayload[];
  stop(): Promise<void>;
}

function collectEvents(proxy: ReturnType<typeof createProxy>): EventCollector {
  const events: AdmissionEventPayload[] = [];
  const done = (async () => {
    for await (const event of proxy.events()) {
      events.push(event);
    }
  })();
  return {
    events,
    async stop() {
      await proxy.shutdown();
      await done;
    },
  };
}

function ok(attemptId: string) {
  return { result: { statusCode: 200, headers: {} }, value: attemptId };
}

describe("ProviderAdmissionProxy", () => {
  it("admits at most the per-credential limit concurrently (default one)", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    let active = 0;
    let maxActive = 0;
    const gates: [Gate, Gate, Gate] = [gate(), gate(), gate()];
    const forwards = gates.map((held, index) =>
      proxy.execute(
        { credentialId: CREDENTIAL, attemptId: `a-${String(index + 1)}` },
        async (permit) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await held.promise;
          active -= 1;
          return ok(permit.attemptId);
        },
      ),
    );

    await flush();
    expect(active).toBe(1);
    expect(maxActive).toBe(1);
    expect(proxy.snapshot()[0]?.inFlight).toBe(1);
    expect(proxy.snapshot()[0]?.queued).toBe(2);

    gates[0].resolve();
    await flush();
    expect(active).toBe(1);
    gates[1].resolve();
    await flush();
    expect(active).toBe(1);
    gates[2].resolve();
    await Promise.all(forwards);

    expect(maxActive).toBe(1);
    expect(proxy.outstandingPermitCount).toBe(0);
  });

  it("cancels a queued request without admitting it or leaking a permit", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    const permitA = (await proxy.acquire({ credentialId: CREDENTIAL, attemptId: "b-a" })).permit;
    const controller = new AbortController();
    const queuedAcquire = proxy.acquire({
      credentialId: CREDENTIAL,
      attemptId: "b-b",
      signal: controller.signal,
    });
    await flush();
    expect(proxy.snapshot()[0]?.queued).toBe(1);

    controller.abort();
    await expect(queuedAcquire).rejects.toBeInstanceOf(ProviderAdmissionError);
    await expect(queuedAcquire).rejects.toMatchObject({ code: "cancelled" });

    // The cancelled request never held a permit; A still does, the queue is empty.
    expect(proxy.snapshot()[0]?.inFlight).toBe(1);
    expect(proxy.snapshot()[0]?.queued).toBe(0);
    proxy.release(permitA);
    expect(proxy.outstandingPermitCount).toBe(0);
  });

  it("frees the permit immediately when an in-flight request is cancelled", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    const controller = new AbortController();
    const permitA = (
      await proxy.acquire({ credentialId: CREDENTIAL, attemptId: "c-a", signal: controller.signal })
    ).permit;
    expect(proxy.outstandingPermitCount).toBe(1);

    const queuedAcquire = proxy.acquire({ credentialId: CREDENTIAL, attemptId: "c-b" });
    await flush();
    expect(proxy.snapshot()[0]?.queued).toBe(1);

    controller.abort();
    await flush();
    // A's permit was freed by the abort; B was admitted in its place.
    expect(proxy.outstandingPermitCount).toBe(1);
    const permitB = (await queuedAcquire).permit;
    expect(permitB.attemptId).toBe("c-b");

    // A subsequent explicit release of the already-cancelled permit is a safe no-op.
    proxy.release(permitA);
    proxy.release(permitB);
    expect(proxy.outstandingPermitCount).toBe(0);
  });

  it("pauses the credential on a rate-limited response and drains the queue on resume", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    const collector = collectEvents(proxy);

    await proxy.execute({ credentialId: CREDENTIAL, attemptId: "d-1" }, () =>
      Promise.resolve({ result: { statusCode: 429, headers: {} }, value: 1 }),
    );
    expect(proxy.pausedCredentials).toContain(CREDENTIAL);

    let admitted = false;
    const queuedAcquire = proxy
      .acquire({ credentialId: CREDENTIAL, attemptId: "d-2" })
      .then(({ permit }) => {
        admitted = true;
        return permit;
      });
    await flush();
    expect(admitted).toBe(false);
    expect(proxy.snapshot()[0]?.queued).toBe(1);

    proxy.resumeCredential(CREDENTIAL);
    const permit = await queuedAcquire;
    expect(admitted).toBe(true);
    expect(permit.attemptId).toBe("d-2");
    proxy.release(permit);
    expect(proxy.outstandingPermitCount).toBe(0);

    const kinds = collector.events.map((event) => event.kind);
    expect(kinds).toContain("quota_signal");
    expect(kinds).toContain("credential_paused");
    expect(kinds).toContain("credential_resumed");
    await collector.stop();
  });

  it("pauses on a quota-exceeded response with a distinct signal", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    await proxy.execute({ credentialId: CREDENTIAL, attemptId: "e-1" }, () =>
      Promise.resolve({
        result: { statusCode: 429, headers: {}, body: { error: { code: "insufficient_quota" } } },
        value: 1,
      }),
    );
    expect(proxy.pausedCredentials).toContain(CREDENTIAL);
    expect(proxy.snapshot()[0]?.pauseReason).toBe("quota_exceeded");
    proxy.resumeCredential(CREDENTIAL);
    expect(proxy.outstandingPermitCount).toBe(0);
  });

  it("drains all queued sessions on resume without discarding any (restart-during-pause)", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    proxy.pauseCredential(CREDENTIAL);
    expect(proxy.pausedCredentials).toContain(CREDENTIAL);

    const attempts = ["f-1", "f-2", "f-3"];
    const pending = attempts.map((attemptId) =>
      proxy.acquire({ credentialId: CREDENTIAL, attemptId }),
    );
    await flush();
    expect(proxy.snapshot()[0]?.queued).toBe(3);

    proxy.resumeCredential(CREDENTIAL);
    const collected: AdmissionPermit[] = [];
    for (const acquire of pending) {
      const permit = (await acquire).permit;
      collected.push(permit);
      proxy.release(permit);
    }
    expect(collected.map((permit) => permit.attemptId)).toEqual(attempts);
    expect(proxy.outstandingPermitCount).toBe(0);
  });

  it("auto-resumes after the retry-after window elapses", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    await proxy.execute({ credentialId: CREDENTIAL, attemptId: "g-1" }, () =>
      Promise.resolve({ result: { statusCode: 429, headers: {}, retryAfterMs: 15 }, value: 1 }),
    );
    expect(proxy.pausedCredentials).toContain(CREDENTIAL);

    let admitted = false;
    const queuedAcquire = proxy
      .acquire({ credentialId: CREDENTIAL, attemptId: "g-2" })
      .then(({ permit }) => {
        admitted = true;
        return permit;
      });
    await flush();
    expect(admitted).toBe(false);

    const permit = await queuedAcquire;
    expect(admitted).toBe(true);
    expect(proxy.pausedCredentials).not.toContain(CREDENTIAL);
    proxy.release(permit);
    expect(proxy.outstandingPermitCount).toBe(0);
  });

  it("raises the per-credential limit only via an audited override", async () => {
    const policy = validateAdmissionPolicy({
      defaultLimit: 1,
      overrides: [
        {
          credentialId: "anthropic:codex",
          limit: 2,
          reason: "operator-approved paired streaming",
          configuredBy: "ops@example.com",
          configuredAt: NOW_MS,
        },
      ],
    });
    const proxy = createProxy(policy);
    let active = 0;
    let maxActive = 0;
    const gates: [Gate, Gate, Gate] = [gate(), gate(), gate()];
    const forwards = gates.map((held, index) =>
      proxy.execute(
        { credentialId: CREDENTIAL, attemptId: `h-${String(index + 1)}` },
        async (permit) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await held.promise;
          active -= 1;
          return ok(permit.attemptId);
        },
      ),
    );

    await flush();
    expect(active).toBe(2);
    expect(maxActive).toBe(2);
    expect(proxy.snapshot()[0]?.queued).toBe(1);

    for (const gateHandle of gates) {
      gateHandle.resolve();
    }
    await Promise.all(forwards);
    expect(maxActive).toBe(2);
    expect(proxy.outstandingPermitCount).toBe(0);
  });

  it("rejects acquire when the per-credential queue is full (bounded backpressure)", async () => {
    const proxy = createProxy(defaultAdmissionPolicy(), { maxQueuePerCredential: 2 });
    const permit = (await proxy.acquire({ credentialId: CREDENTIAL, attemptId: "i-1" })).permit;
    const queuedOne = proxy.acquire({ credentialId: CREDENTIAL, attemptId: "i-2" });
    const queuedTwo = proxy.acquire({ credentialId: CREDENTIAL, attemptId: "i-3" });
    await flush();
    expect(proxy.snapshot()[0]?.queued).toBe(2);

    await expect(
      proxy.acquire({ credentialId: CREDENTIAL, attemptId: "i-4" }),
    ).rejects.toMatchObject({
      code: "queue_full",
    });

    proxy.release(permit);
    const permitTwo = (await queuedOne).permit;
    proxy.release(permitTwo);
    const permitThree = (await queuedTwo).permit;
    proxy.release(permitThree);
    expect(proxy.outstandingPermitCount).toBe(0);
  });

  it("reports per-credential usage and reconciles permits to zero", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    await proxy.execute({ credentialId: CREDENTIAL, attemptId: "j-1" }, () =>
      Promise.resolve({
        result: { statusCode: 200, headers: {}, inputTokens: 12, outputTokens: 34 },
        value: 1,
      }),
    );
    await proxy.execute({ credentialId: CREDENTIAL, attemptId: "j-2" }, () =>
      Promise.resolve({ result: { statusCode: 429, headers: {} }, value: 2 }),
    );

    const usage = proxy.usage(CREDENTIAL);
    expect(usage.requests).toBe(2);
    expect(usage.inputTokens).toBe(12);
    expect(usage.outputTokens).toBe(34);
    expect(usage.rateLimitedCount).toBe(1);

    proxy.resumeCredential(CREDENTIAL);
    expect(proxy.outstandingPermitCount).toBe(0);

    expect(() => proxy.usage(credentialId("never-seen"))).toThrow(ProviderAdmissionError);
  });

  it("emits a stable, strictly-monotonic event sequence", async () => {
    const proxy = createProxy(defaultAdmissionPolicy());
    const collector = collectEvents(proxy);
    const permit = (await proxy.acquire({ credentialId: CREDENTIAL, attemptId: "k-1" })).permit;
    proxy.release(permit, { statusCode: 429, headers: {} });
    proxy.resumeCredential(CREDENTIAL);
    await flush();

    const sequences = collector.events.map((event) => event.sequence);
    expect(sequences.length).toBeGreaterThan(0);
    for (let index = 1; index < sequences.length; index += 1) {
      const previous = sequences[index - 1];
      const current = sequences[index];
      if (previous !== undefined && current !== undefined) {
        expect(current).toBeGreaterThan(previous);
      }
    }
    expect(new Set(sequences).size).toBe(sequences.length);
    await collector.stop();
  });

  it("never receives provider credentials (only attempt identity + response)", async () => {
    // The admission request/result surface carries no refresh/access credential field;
    // the proxy is constructed from a policy + clock and forwards only attempt identity.
    const proxy = createProxy(defaultAdmissionPolicy());
    const permit = (await proxy.acquire({ credentialId: CREDENTIAL, attemptId: "l-1" })).permit;
    expect(Object.keys(permit).sort()).toEqual([
      "acquiredAtMs",
      "attemptId",
      "credentialId",
      "sequence",
    ]);
    proxy.release(permit);
    expect(proxy.outstandingPermitCount).toBe(0);
  });
  it("auto-resumes after the default backoff when retry-after is absent or zero (no indefinite pause)", async () => {
    // H-1 / L-4: a 429 with no retry-after (and one with `retry-after: "0"`) previously
    // paused the credential forever (self-DoS). Both now install a resume timer using the
    // default backoff, so the credential auto-resumes and queued requests drain — without
    // a manual resumeCredential call.
    const proxy = createProxy(defaultAdmissionPolicy(), { defaultPauseBackoffMs: 15 });

    await proxy.execute({ credentialId: CREDENTIAL, attemptId: "m-1" }, () =>
      Promise.resolve({ result: { statusCode: 429, headers: {} }, value: 1 }),
    );
    expect(proxy.pausedCredentials).toContain(CREDENTIAL);

    let admitted = false;
    const queuedAcquire = proxy
      .acquire({ credentialId: CREDENTIAL, attemptId: "m-2" })
      .then(({ permit }) => {
        admitted = true;
        return permit;
      });
    await flush();
    expect(admitted).toBe(false); // still paused immediately after queueing

    const permit = await queuedAcquire; // resolves once the default backoff auto-resumes
    expect(admitted).toBe(true);
    expect(proxy.pausedCredentials).not.toContain(CREDENTIAL);
    proxy.release(permit);
    expect(proxy.outstandingPermitCount).toBe(0);
    await proxy.shutdown();

    // `retry-after: "0"` means retry-now → parseRetryAfterMs yields 0, which is not a
    // usable delay; the default backoff must still resume it.
    const proxyTwo = createProxy(defaultAdmissionPolicy(), { defaultPauseBackoffMs: 15 });
    await proxyTwo.execute({ credentialId: CREDENTIAL, attemptId: "m-3" }, () =>
      Promise.resolve({ result: { statusCode: 429, headers: { "retry-after": "0" } }, value: 1 }),
    );
    expect(proxyTwo.pausedCredentials).toContain(CREDENTIAL);
    const result = await proxyTwo.acquire({ credentialId: CREDENTIAL, attemptId: "m-4" });
    expect(proxyTwo.pausedCredentials).not.toContain(CREDENTIAL);
    proxyTwo.release(result.permit);
    expect(proxyTwo.outstandingPermitCount).toBe(0);
    await proxyTwo.shutdown();
  });

  it("pauses the credential when a 429 resolves concurrently with an abort (no swallowed backpressure)", async () => {
    // M-1: when the abort path frees the permit just before a 429 forward result is
    // released, the cancel no-op previously swallowed the quota signal. The result must
    // still be classified so the credential pauses.
    const proxy = createProxy(defaultAdmissionPolicy());
    const collector = collectEvents(proxy);
    const controller = new AbortController();

    const value = await proxy.execute(
      { credentialId: CREDENTIAL, attemptId: "n-1", signal: controller.signal },
      async () => {
        // Yield so the abort listener is wired, then abort synchronously right before
        // resolving a 429 — the cancel path frees the permit first.
        await flush();
        controller.abort();
        return { result: { statusCode: 429, headers: {} }, value: "n-1" };
      },
    );
    expect(value).toBe("n-1");

    // The 429 backpressure must NOT be swallowed even though the request was cancelled.
    expect(proxy.pausedCredentials).toContain(CREDENTIAL);
    expect(proxy.snapshot()[0]?.pauseReason).toBe("rate_limited");

    // Let the async event stream drain (events are delivered across microtask turns).
    await flush();
    const kinds = collector.events.map((event) => event.kind);
    expect(kinds).toContain("quota_signal");
    expect(kinds).toContain("credential_paused");

    proxy.resumeCredential(CREDENTIAL);
    expect(proxy.outstandingPermitCount).toBe(0);
    await collector.stop();
  });
});
