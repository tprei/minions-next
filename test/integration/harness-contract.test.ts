import {
  attemptId,
  contentHash,
  hostId,
  missingHarnessCapabilities,
  requireHarnessCapabilities,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type HarnessAdapter,
  type HarnessAttemptContext,
  type HarnessCapability,
  type HarnessEvent,
  type HarnessHandshake,
  type HarnessSession,
  type HarnessSessionIdentity,
} from "@minions/core";
import {
  createDeterministicHarnessAdapter,
  type DeterministicHarnessEvent,
  type DeterministicHarnessFixture,
  type DeterministicHarnessFixtureStep,
} from "@minions/testkit";
import { describe, expect, it } from "vitest";

const policyDigest = contentHash("a".repeat(64));
const identity: HarnessSessionIdentity = {
  durableHarnessId: "durable-node-1",
  sessionId: "attempt-session-1",
};
const startContext: HarnessAttemptContext = {
  attemptId: attemptId("01890f00-0000-7000-8000-000000000001"),
  attemptOrdinal: 1,
  nodeId: taskNodeId("01890f00-0000-7000-8000-000000000002"),
  treeId: taskTreeId("01890f00-0000-7000-8000-000000000003"),
  repositoryId: repositoryId("01890f00-0000-7000-8000-000000000004"),
  hostId: hostId("01890f00-0000-7000-8000-000000000005"),
};
const resumedContext: HarnessAttemptContext = {
  ...startContext,
  attemptId: attemptId("01890f00-0000-7000-8000-000000000006"),
  attemptOrdinal: 2,
};
const handshake: HarnessHandshake = {
  harnessKind: "fixture-harness",
  harnessVersion: "1.0.0",
  providerKind: "fixture-provider",
  model: "fixture-model",
  reasoningLevel: "standard",
  capabilities: ["steer", "follow_up", "interrupt", "abort", "resume", "snapshot"],
  tools: ["shell"],
  securityPolicyDigest: policyDigest,
};

function event(
  payload: DeterministicHarnessEvent["payload"],
  offset: number,
): DeterministicHarnessEvent {
  return {
    occurredAt: timestampFromEpochMilliseconds(1_750_000_000_000 + offset),
    payload,
  };
}

function fixtureWithHandshake(
  fixtureHandshake: HarnessHandshake,
  steps: DeterministicHarnessFixture["steps"],
): DeterministicHarnessFixture {
  return { handshake: fixtureHandshake, steps };
}

function baseFixture(steps: DeterministicHarnessFixture["steps"]): DeterministicHarnessFixture {
  return fixtureWithHandshake(handshake, steps);
}

async function collect(
  iterator: AsyncIterator<HarnessEvent>,
  count: number,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await iterator.next();
    if (next.done === true) {
      throw new Error("event stream ended before the requested number of events");
    }
    events.push(next.value);
  }
  return events;
}

describe("deterministic harness contract", () => {
  it("handshakes, matches every operation, emits normalized events, and preserves identity on replay", async () => {
    const adapter = createDeterministicHarnessAdapter(
      baseFixture([
        {
          kind: "start",
          context: startContext,
          durableHarnessId: identity.durableHarnessId,
          identity,
          events: [
            event({ kind: "message", role: "assistant", text: "starting" }, 0),
            event({ kind: "thinking", text: "considering" }, 1),
            event(
              { kind: "tool_call", callId: "call-1", tool: "shell", input: { command: "pwd" } },
              2,
            ),
            event({ kind: "tool_result", callId: "call-1", output: { code: 0 }, failed: false }, 3),
            event({ kind: "prompt_started", promptId: "prompt-1" }, 4),
            event({ kind: "turn_started", turnId: "turn-1" }, 5),
          ],
        },
        {
          kind: "prompt",
          promptId: "prompt-1",
          text: "Implement the change",
          events: [
            event({ kind: "prompt_finished", promptId: "prompt-1" }, 6),
            event(
              { kind: "usage", usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 2 } },
              7,
            ),
            event({ kind: "retry", providerRequestOrdinal: 2, reason: "provider timeout" }, 8),
            event(
              {
                kind: "question",
                questionId: "question-1",
                prompt: "Continue?",
                choices: ["yes", "no"],
              },
              9,
            ),
            event(
              {
                kind: "error",
                code: "crash",
                message: "provider process crashed",
                retryable: true,
              },
              10,
            ),
            event({ kind: "message", role: "assistant", text: "resuming after retry" }, 11),
          ],
        },
        {
          kind: "resume",
          context: resumedContext,
          identity,
          afterSequence: 6n,
          events: [event({ kind: "turn_finished", turnId: "turn-1" }, 12)],
        },
        {
          kind: "steer",
          text: "Use the existing adapter",
          events: [event({ kind: "message", role: "system", text: "steering accepted" }, 13)],
        },
        {
          kind: "follow_up",
          promptId: "prompt-2",
          text: "What remains?",
          events: [event({ kind: "thinking", text: "checking remaining work" }, 14)],
        },
        {
          kind: "snapshot",
          snapshot: { identity, nextEventSequence: 16n, state: "running" },
          events: [],
        },
        {
          kind: "interrupt",
          events: [event({ kind: "message", role: "system", text: "interrupted" }, 15)],
        },
        {
          kind: "snapshot",
          snapshot: { identity, nextEventSequence: 17n, state: "interrupted" },
          events: [],
        },
        {
          kind: "abort",
          events: [event({ kind: "result", outcome: "cancelled", text: "cancelled by test" }, 16)],
        },
      ]),
    );

    await expect(adapter.handshake()).resolves.toEqual(handshake);
    const session = await adapter.start({
      context: startContext,
      durableHarnessId: identity.durableHarnessId,
    });
    expect(session.identity).toEqual(identity);

    const firstStream = session.events(0n);
    expect(() => session.events(0n)).toThrow(/only one active event consumer/u);
    const firstIterator = firstStream[Symbol.asyncIterator]();
    const firstEvents = await collect(firstIterator, 6);
    await firstIterator.return?.();
    expect(firstEvents.map(({ sequence }) => sequence)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(firstEvents.map(({ payload }) => payload.kind)).toEqual([
      "message",
      "thinking",
      "tool_call",
      "tool_result",
      "prompt_started",
      "turn_started",
    ]);

    await session.prompt("prompt-1", "Implement the change");
    const promptStream = session.events(0n)[Symbol.asyncIterator]();
    const retry = (await collect(promptStream, 12)).find(({ payload }) => payload.kind === "retry");
    await promptStream.return?.();
    expect(retry?.payload).toEqual({
      kind: "retry",
      providerRequestOrdinal: 2,
      reason: "provider timeout",
    });
    expect(retry?.sequence).toBe(9n);
    expect(startContext.attemptOrdinal).toBe(1);
    expect(resumedContext.attemptOrdinal).toBe(2);

    const resumed = await adapter.resume({ context: resumedContext, identity, afterSequence: 6n });
    expect(resumed).toBe(session);
    expect(resumed.identity).toEqual(identity);
    const replayStream = resumed.events(6n)[Symbol.asyncIterator]();
    const replayed = await collect(replayStream, 7);
    expect(replayed.map(({ sequence }) => sequence)).toEqual([7n, 8n, 9n, 10n, 11n, 12n, 13n]);
    await replayStream.return?.();

    await session.steer("Use the existing adapter");
    await session.followUp("prompt-2", "What remains?");
    await expect(session.snapshot()).resolves.toEqual({
      identity,
      nextEventSequence: 16n,
      state: "running",
    });
    await session.interrupt();
    await expect(session.snapshot()).resolves.toEqual({
      identity,
      nextEventSequence: 17n,
      state: "interrupted",
    });
    await session.abort();
    await expect(session.snapshot()).rejects.toMatchObject({ code: "session_terminal" });
    const terminalStream = session.events(16n)[Symbol.asyncIterator]();
    const terminalNext = await terminalStream.next();
    expect(terminalNext.done).toBe(false);
    if (terminalNext.done) {
      throw new Error("terminal harness stream ended before the result event");
    }
    expect(terminalNext.value.sequence).toBe(17n);
    expect(terminalNext.value.payload).toEqual({
      kind: "result",
      outcome: "cancelled",
      text: "cancelled by test",
    });
    await expect(terminalStream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("reports missing capabilities and fails closed on required capability checks", async () => {
    const limitedHandshake: HarnessHandshake = {
      ...handshake,
      capabilities: ["resume", "snapshot"],
    };
    expect(missingHarnessCapabilities(limitedHandshake, ["steer", "resume", "interrupt"])).toEqual([
      "steer",
      "interrupt",
    ]);
    expect(() => {
      requireHarnessCapabilities(limitedHandshake, ["steer"]);
    }).toThrow(/missing required capabilities: steer/u);
    expect(() => {
      requireHarnessCapabilities(limitedHandshake, ["resume"]);
    }).not.toThrow();

    const adapter = createDeterministicHarnessAdapter(
      baseFixture([
        {
          kind: "start",
          context: startContext,
          durableHarnessId: identity.durableHarnessId,
          identity,
          events: [],
        },
      ]),
    );
    await expect(adapter.handshake()).resolves.toEqual(handshake);
  });
  it("rejects every control operation that the handshake does not advertise", async () => {
    const expectMissing = async (
      capability: HarnessCapability,
      step: DeterministicHarnessFixtureStep,
      invoke: (adapter: HarnessAdapter, session: HarnessSession) => Promise<unknown>,
    ): Promise<void> => {
      const limitedHandshake: HarnessHandshake = {
        ...handshake,
        capabilities: handshake.capabilities.filter((value) => value !== capability),
      };
      const adapter = createDeterministicHarnessAdapter(
        fixtureWithHandshake(limitedHandshake, [
          {
            kind: "start",
            context: startContext,
            durableHarnessId: identity.durableHarnessId,
            identity,
            events: [],
          },
          step,
        ]),
      );
      const session = await adapter.start({
        context: startContext,
        durableHarnessId: identity.durableHarnessId,
      });
      await expect(invoke(adapter, session)).rejects.toMatchObject({ code: "missing_capability" });
    };

    await expectMissing(
      "steer",
      { kind: "steer", text: "steer", events: [] },
      (_adapter, session) => session.steer("steer"),
    );
    await expectMissing(
      "follow_up",
      { kind: "follow_up", promptId: "follow-up", text: "follow up", events: [] },
      (_adapter, session) => session.followUp("follow-up", "follow up"),
    );
    await expectMissing("interrupt", { kind: "interrupt", events: [] }, (_adapter, session) =>
      session.interrupt(),
    );
    await expectMissing("abort", { kind: "abort", events: [] }, (_adapter, session) =>
      session.abort(),
    );
    await expectMissing(
      "snapshot",
      {
        kind: "snapshot",
        snapshot: { identity, nextEventSequence: 1n, state: "idle" },
        events: [],
      },
      (_adapter, session) => session.snapshot(),
    );
    await expectMissing(
      "resume",
      { kind: "resume", context: startContext, identity, afterSequence: 0n, events: [] },
      (adapter) => adapter.resume({ context: startContext, identity, afterSequence: 0n }),
    );
  });

  it("rejects malformed, out-of-order, unexpected, exhausted, and invalid replay input", async () => {
    const malformed = {
      handshake,
      steps: [{ kind: "prompt", promptId: "p", text: "text", events: [] }],
    } as unknown as DeterministicHarnessFixture;
    expect(() => createDeterministicHarnessAdapter(malformed)).toThrow(/steps\[0\].*start/u);

    const mismatchedIdentity = { ...identity, durableHarnessId: "different-durable-node" };
    expect(() =>
      createDeterministicHarnessAdapter(
        baseFixture([
          {
            kind: "start",
            context: startContext,
            durableHarnessId: identity.durableHarnessId,
            identity: mismatchedIdentity,
            events: [],
          },
        ]),
      ),
    ).toThrow(/durableHarnessId/u);

    const mismatchedNodeContext = {
      ...resumedContext,
      nodeId: taskNodeId("01890f00-0000-7000-8000-000000000007"),
    };
    expect(() =>
      createDeterministicHarnessAdapter(
        baseFixture([
          {
            kind: "start",
            context: startContext,
            durableHarnessId: identity.durableHarnessId,
            identity,
            events: [event({ kind: "message", role: "system", text: "started" }, 0)],
          },
          {
            kind: "resume",
            context: mismatchedNodeContext,
            identity,
            afterSequence: 1n,
            events: [],
          },
        ]),
      ),
    ).toThrow(/node binding/u);
    expect(() =>
      createDeterministicHarnessAdapter(
        baseFixture([
          {
            kind: "start",
            context: startContext,
            durableHarnessId: identity.durableHarnessId,
            identity,
            events: [],
          },
          { kind: "resume", context: resumedContext, identity, afterSequence: 1n, events: [] },
        ]),
      ),
    ).toThrow(/afterSequence.*exceed/u);

    const terminalEvent = event({ kind: "result", outcome: "cancelled", text: "cancelled" }, 0);
    expect(() =>
      createDeterministicHarnessAdapter(
        baseFixture([
          {
            kind: "start",
            context: startContext,
            durableHarnessId: identity.durableHarnessId,
            identity,
            events: [terminalEvent, event({ kind: "message", role: "system", text: "late" }, 1)],
          },
        ]),
      ),
    ).toThrow(/after a terminal result/u);
    expect(() =>
      createDeterministicHarnessAdapter(
        baseFixture([
          {
            kind: "start",
            context: startContext,
            durableHarnessId: identity.durableHarnessId,
            identity,
            events: [terminalEvent],
          },
          { kind: "prompt", promptId: "late", text: "late", events: [] },
        ]),
      ),
    ).toThrow(/follows a terminal/u);

    const terminalAdapter = createDeterministicHarnessAdapter(
      baseFixture([
        {
          kind: "start",
          context: startContext,
          durableHarnessId: identity.durableHarnessId,
          identity,
          events: [terminalEvent],
        },
      ]),
    );
    await terminalAdapter.start({
      context: startContext,
      durableHarnessId: identity.durableHarnessId,
    });
    await expect(
      terminalAdapter.resume({ context: resumedContext, identity, afterSequence: 1n }),
    ).rejects.toMatchObject({ code: "session_terminal" });

    const adapter = createDeterministicHarnessAdapter(
      baseFixture([
        {
          kind: "start",
          context: startContext,
          durableHarnessId: identity.durableHarnessId,
          identity,
          events: [],
        },
        { kind: "prompt", promptId: "p", text: "text", events: [] },
      ]),
    );
    await expect(
      adapter.resume({ context: startContext, identity, afterSequence: 0n }),
    ).rejects.toMatchObject({ code: "session_not_started" });
    const session = await adapter.start({
      context: startContext,
      durableHarnessId: identity.durableHarnessId,
    });
    await expect(session.steer("unexpected")).rejects.toMatchObject({
      code: "unexpected_operation",
    });
    await expect(session.prompt("p", "text")).resolves.toBeUndefined();
    await expect(session.prompt("p", "text")).rejects.toMatchObject({ code: "fixture_exhausted" });
    expect(() => session.events(-1n)).toThrow(/non-negative bigint/u);
  });
});
