import process from "node:process";
import { setImmediate } from "node:timers";

import { createProviderAdmissionProxy } from "@minions/adapters";
import {
  credentialId,
  defaultAdmissionPolicy,
  timestampFromEpochMilliseconds,
} from "@minions/core";

// PR 20 focused synthetic: exercises the provider admission proxy's per-credential
// in-flight limit, cancellation safety, and shared pause/resume with SIMULATED
// gateway forwards (no real provider request). The auth-gated LIVE concurrency run —
// real concurrent provider requests on a maintained authenticated credential through
// the OMP auth gateway — is DEFERRED to the auth gate (mirrors
// scripts/run-codex-auth-synthetic.mjs). To run it live, wire a real gateway forward
// into `proxy.execute(...)` on a maintained disposable host:
//
//   OMP_PATH=/usr/bin/omp OMP_AUTH_HOST_ID=<hostId> \
//     OMP_AUTH_PROVIDER=anthropic OMP_MODEL=<model> pnpm synthetic:codex-concurrency
//
// What this structural run proves today (without a provider):
//   - N concurrent provider requests for one credential admit at most the limit (1),
//   - a rate/quota response publishes a shared credential pause, queued requests wait
//     (never discarded), and resume drains them,
//   - the permit count reconciles to zero across every scenario.

await main();

async function main() {
  try {
    await runSynthetic();
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

function clock() {
  return { now: () => timestampFromEpochMilliseconds(Date.now()) };
}

function gate() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runSynthetic() {
  const credential = credentialId("anthropic:codex");
  const proxy = createProviderAdmissionProxy({
    policy: defaultAdmissionPolicy(),
    clock: clock(),
  });

  // 1. Five concurrent simulated forwards share one credential → exactly one in flight.
  let active = 0;
  let maxActive = 0;
  const gates = Array.from({ length: 5 }, () => gate());
  const forwards = gates.map((held, index) =>
    proxy.execute({ credentialId: credential, attemptId: `synthetic-${index}` }, async (permit) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await held.promise;
      active -= 1;
      return { result: { statusCode: 200, headers: {} }, value: permit.attemptId };
    }),
  );
  await flush();
  assert(maxActive === 1, `expected max one in-flight, saw ${maxActive}`);

  // Complete them one at a time; the limit still holds.
  for (const held of gates) {
    held.resolve();
    await flush();
  }
  await Promise.all(forwards);
  assert(maxActive === 1, `expected max one in-flight across completion, saw ${maxActive}`);

  // 2. A rate-limited response publishes a shared credential pause.
  await proxy.execute({ credentialId: credential, attemptId: "synthetic-rate" }, async () => ({
    result: { statusCode: 429, headers: {} },
    value: "rate",
  }));
  assert(proxy.pausedCredentials.includes(credential), "credential should be paused after 429");

  // 3. Queued requests wait (never discarded); resume drains them (restart-during-pause).
  const queued = proxy.acquire({ credentialId: credential, attemptId: "synthetic-queued" });
  await flush();
  assert(proxy.snapshot()[0].queued === 1, "queued request should wait while paused");
  proxy.resumeCredential(credential);
  const queuedPermit = (await queued).permit;
  assert(queuedPermit.attemptId === "synthetic-queued", "queued session resumed with its identity");
  proxy.release(queuedPermit);

  // 4. No leaked permits across every scenario.
  assert(
    proxy.outstandingPermitCount === 0,
    `permit leak: ${proxy.outstandingPermitCount} outstanding`,
  );
  await proxy.shutdown();

  process.stdout.write(
    `${JSON.stringify({
      backendKind: "provider-admission-proxy",
      credential,
      defaultLimit: 1,
      maxObservedInFlight: maxActive,
      rateLimitedPausesCredential: true,
      queuedSessionsResumeWithoutDiscard: true,
      noPermitLeak: true,
      liveConcurrencyDeferred: true,
    })}\n`,
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`synthetic assertion failed: ${message}`);
  }
}

function formatError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
