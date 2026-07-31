import {
  actorSessionId,
  commandId,
  nodeAttentionId,
  nodeCommandDeliveryToken,
  NodeCommandTargetError,
  taskNodeId,
  timestampFromEpochMilliseconds,
  type NodeCommandDeliveryState,
  type NodeCommandDispatchTarget,
  type NodeCommandPayload,
  type NodeCommandRecord,
  type SteeringCommandStore,
} from "@minions/core";
import { createSteeringCommandDispatcher } from "../../packages/adapters/src/steering-command-dispatcher.js";
import { describe, expect, it } from "vitest";

const at = timestampFromEpochMilliseconds(1_700_000_000_000);
const commandIdentifier = commandId("01900000-0000-7000-8000-000000000001");
const actorIdentifier = actorSessionId("01900000-0000-7000-8000-000000000002");
const nodeIdentifier = taskNodeId("01900000-0000-7000-8000-000000000003");
const attentionIdentifier = nodeAttentionId("01900000-0000-7000-8000-000000000004");
const deliveryToken = nodeCommandDeliveryToken("01900000-0000-7000-8000-000000000005");

type TargetCall = Readonly<{
  method: string;
  args: readonly unknown[];
}>;

type StoreHarness = Readonly<{
  store: SteeringCommandStore;
  acknowledgements: readonly unknown[];
  applications: readonly unknown[];
  failures: readonly unknown[];
  setFailureError(error: Error): void;
}>;

function makeCommand(
  payload: NodeCommandPayload,
  state: NodeCommandDeliveryState = "sent",
  token: typeof deliveryToken | undefined = deliveryToken,
): NodeCommandRecord {
  return {
    commandId: commandIdentifier,
    actorSessionId: actorIdentifier,
    nodeId: nodeIdentifier,
    ordinal: 1n,
    payload,
    state,
    recoveryDisposition: "resume_session",
    deliveryAttempts: 1,
    deliveryToken: token,
    createdAt: at,
    sentAt: state === "sent" ? at : undefined,
    acknowledgedAt: undefined,
    appliedAt: undefined,
    failedAt: state === "failed" || state === "review_required" ? at : undefined,
    failure: state === "failed" || state === "review_required" ? "target failure" : undefined,
  };
}

function createTarget(calls: TargetCall[]): NodeCommandDispatchTarget {
  return {
    message(commandIdValue, text) {
      calls.push({ method: "message", args: [commandIdValue, text] });
      return Promise.resolve();
    },
    steerAfterCurrentTool(commandIdValue, text) {
      calls.push({ method: "steerAfterCurrentTool", args: [commandIdValue, text] });
      return Promise.resolve();
    },
    interruptNow(commandIdValue) {
      calls.push({ method: "interruptNow", args: [commandIdValue] });
      return Promise.resolve();
    },
    followUpAfterTurn(commandIdValue, text) {
      calls.push({ method: "followUpAfterTurn", args: [commandIdValue, text] });
      return Promise.resolve();
    },
    pause(commandIdValue) {
      calls.push({ method: "pause", args: [commandIdValue] });
      return Promise.resolve();
    },
    resume(commandIdValue) {
      calls.push({ method: "resume", args: [commandIdValue] });
      return Promise.resolve();
    },
    answer(commandIdValue, attentionId, answer) {
      calls.push({ method: "answer", args: [commandIdValue, attentionId, answer] });
      return Promise.resolve();
    },
    approve(commandIdValue, attentionId, reason) {
      calls.push({ method: "approve", args: [commandIdValue, attentionId, reason] });
      return Promise.resolve();
    },
    reject(commandIdValue, attentionId, reason) {
      calls.push({ method: "reject", args: [commandIdValue, attentionId, reason] });
      return Promise.resolve();
    },
    retry(commandIdValue) {
      calls.push({ method: "retry", args: [commandIdValue] });
      return Promise.resolve();
    },
    cancelNode(commandIdValue) {
      calls.push({ method: "cancelNode", args: [commandIdValue] });
      return Promise.resolve();
    },
    cancelSubtree(commandIdValue) {
      calls.push({ method: "cancelSubtree", args: [commandIdValue] });
      return Promise.resolve();
    },
    replanUnstartedSubtree(commandIdValue, objective) {
      calls.push({ method: "replanUnstartedSubtree", args: [commandIdValue, objective] });
      return Promise.resolve();
    },
  };
}

function createStore(result: NodeCommandRecord, failureResult = result): StoreHarness {
  const acknowledgements: unknown[] = [];
  const applications: unknown[] = [];
  const failures: unknown[] = [];
  let failureError: Error | undefined;
  const store: SteeringCommandStore = {
    queue: () => Promise.resolve(result),
    get: () => undefined,
    list: () => [],
    claimNext: () => Promise.resolve(undefined),
    acknowledge: (request) => {
      acknowledgements.push(request);
      return Promise.resolve(result);
    },
    apply: (request) => {
      applications.push(request);
      return Promise.resolve(result);
    },
    fail: (request) => {
      failures.push(request);
      if (failureError !== undefined) {
        return Promise.reject(failureError);
      }
      return Promise.resolve(failureResult);
    },
    createAttention: (request) =>
      Promise.resolve({
        id: request.id,
        nodeId: request.nodeId,
        kind: request.kind,
        prompt: request.prompt,
        choices: request.choices,
        state: "open",
        resolutionCommandId: undefined,
        resolution: undefined,
        createdAt: request.at,
        resolvedAt: undefined,
      }),
    listAttention: () => [],
  };
  return {
    store,
    acknowledgements,
    applications,
    failures,
    setFailureError(error) {
      failureError = error;
    },
  };
}

const mappingCases: readonly Readonly<{
  name: string;
  payload: NodeCommandPayload;
  method: string;
  args: readonly unknown[];
}>[] = [
  {
    name: "message",
    payload: { kind: "message", text: "hello" },
    method: "message",
    args: [commandIdentifier, "hello"],
  },
  {
    name: "steer after current tool",
    payload: { kind: "steer_after_current_tool", text: "steer" },
    method: "steerAfterCurrentTool",
    args: [commandIdentifier, "steer"],
  },
  {
    name: "interrupt now",
    payload: { kind: "interrupt_now" },
    method: "interruptNow",
    args: [commandIdentifier],
  },
  {
    name: "follow up after turn",
    payload: { kind: "follow_up_after_turn", text: "follow" },
    method: "followUpAfterTurn",
    args: [commandIdentifier, "follow"],
  },
  {
    name: "pause",
    payload: { kind: "pause" },
    method: "pause",
    args: [commandIdentifier],
  },
  {
    name: "resume",
    payload: { kind: "resume" },
    method: "resume",
    args: [commandIdentifier],
  },
  {
    name: "answer",
    payload: { kind: "answer", attentionId: attentionIdentifier, answer: "yes" },
    method: "answer",
    args: [commandIdentifier, attentionIdentifier, "yes"],
  },
  {
    name: "approve",
    payload: { kind: "approve", attentionId: attentionIdentifier, reason: "approved" },
    method: "approve",
    args: [commandIdentifier, attentionIdentifier, "approved"],
  },
  {
    name: "reject",
    payload: { kind: "reject", attentionId: attentionIdentifier, reason: undefined },
    method: "reject",
    args: [commandIdentifier, attentionIdentifier, undefined],
  },
  {
    name: "retry",
    payload: { kind: "retry" },
    method: "retry",
    args: [commandIdentifier],
  },
  {
    name: "cancel node",
    payload: { kind: "cancel_node" },
    method: "cancelNode",
    args: [commandIdentifier],
  },
  {
    name: "cancel subtree",
    payload: { kind: "cancel_subtree" },
    method: "cancelSubtree",
    args: [commandIdentifier],
  },
  {
    name: "replan unstarted subtree",
    payload: { kind: "replan_unstarted_subtree", objective: "new objective" },
    method: "replanUnstartedSubtree",
    args: [commandIdentifier, "new objective"],
  },
];

describe("steering command dispatcher", () => {
  it.each(mappingCases)("dispatches $name with its exact target arguments", async (testCase) => {
    const command = makeCommand(testCase.payload);
    const calls: TargetCall[] = [];
    const harness = createStore(command);
    const dispatcher = createSteeringCommandDispatcher(harness.store);

    await expect(dispatcher.dispatch({ command, target: createTarget(calls), at })).resolves.toBe(
      command,
    );

    expect(calls).toEqual([{ method: testCase.method, args: testCase.args }]);
    expect(harness.acknowledgements).toEqual([
      { delivery: { commandId: commandIdentifier, deliveryToken }, at },
    ]);
    expect(harness.applications).toEqual([
      { delivery: { commandId: commandIdentifier, deliveryToken }, at },
    ]);
    expect(harness.failures).toHaveLength(0);
  });

  it("requires a sent command and delivery token before dispatch", async () => {
    const command = makeCommand({ kind: "message", text: "hello" }, "queued", undefined);
    const calls: TargetCall[] = [];
    const harness = createStore(command);
    const dispatcher = createSteeringCommandDispatcher(harness.store);

    await expect(dispatcher.dispatch({ command, target: createTarget(calls), at })).rejects.toThrow(
      "sent with a delivery token",
    );
    expect(calls).toHaveLength(0);
    expect(harness.acknowledgements).toHaveLength(0);
    expect(harness.applications).toHaveLength(0);
    expect(harness.failures).toHaveLength(0);
  });

  it("records an explicit rejected target outcome as failed without ambiguity", async () => {
    const command = makeCommand({ kind: "message", text: "hello" });
    const failed = makeCommand(command.payload, "failed");
    const targetError = new NodeCommandTargetError("rejected", "target rejected");
    const calls: TargetCall[] = [];
    const harness = createStore(command, failed);
    const target: NodeCommandDispatchTarget = {
      ...createTarget(calls),
      message: () => Promise.reject(targetError),
    };
    const dispatcher = createSteeringCommandDispatcher(harness.store);

    await expect(dispatcher.dispatch({ command, target, at })).resolves.toBe(failed);
    expect(harness.failures).toEqual([
      {
        delivery: { commandId: commandIdentifier, deliveryToken },
        at,
        failure: "target rejected",
        ambiguous: false,
      },
    ]);
    expect(harness.acknowledgements).toHaveLength(0);
    expect(harness.applications).toHaveLength(0);
  });

  it.each([
    new Error("generic safe failure"),
    new NodeCommandTargetError("delivery_unknown", "unknown safe failure"),
  ])("rethrows an unknown safe outcome without recording it", async (targetError) => {
    const command = makeCommand({ kind: "message", text: "hello" });
    const calls: TargetCall[] = [];
    const harness = createStore(command);
    const target: NodeCommandDispatchTarget = {
      ...createTarget(calls),
      message: () => Promise.reject(targetError),
    };
    const dispatcher = createSteeringCommandDispatcher(harness.store);

    await expect(dispatcher.dispatch({ command, target, at })).rejects.toBe(targetError);
    expect(harness.failures).toHaveLength(0);
    expect(harness.acknowledgements).toHaveLength(0);
    expect(harness.applications).toHaveLength(0);
  });

  it.each([
    new Error("generic unsafe failure"),
    new NodeCommandTargetError("delivery_unknown", "unknown unsafe failure"),
  ])("records an unknown unsafe outcome for review", async (targetError) => {
    const command = makeCommand({
      kind: "answer",
      attentionId: attentionIdentifier,
      answer: "yes",
    });
    const review = makeCommand(command.payload, "review_required");
    const calls: TargetCall[] = [];
    const harness = createStore(command, review);
    const target: NodeCommandDispatchTarget = {
      ...createTarget(calls),
      answer: () => Promise.reject(targetError),
    };
    const dispatcher = createSteeringCommandDispatcher(harness.store);

    await expect(dispatcher.dispatch({ command, target, at })).resolves.toBe(review);
    expect(harness.failures).toEqual([
      {
        delivery: { commandId: commandIdentifier, deliveryToken },
        at,
        failure: targetError.message,
        ambiguous: true,
      },
    ]);
    expect(harness.acknowledgements).toHaveLength(0);
    expect(harness.applications).toHaveLength(0);
  });

  it("aggregates a target rejection and failure-recording error", async () => {
    const command = makeCommand({ kind: "message", text: "hello" });
    const targetError = new NodeCommandTargetError("rejected", "target rejected");
    const recordingError = new Error("failure record unavailable");
    const calls: TargetCall[] = [];
    const harness = createStore(command);
    harness.setFailureError(recordingError);
    const target: NodeCommandDispatchTarget = {
      ...createTarget(calls),
      message: () => Promise.reject(targetError),
    };
    const dispatcher = createSteeringCommandDispatcher(harness.store);

    let caught: unknown;
    try {
      await dispatcher.dispatch({ command, target, at });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    if (caught instanceof AggregateError) {
      expect(caught.errors).toEqual([targetError, recordingError]);
      expect(caught.cause).toBe(targetError);
    }
  });

  it("rejects unsupported payloads before target or store effects", async () => {
    const command = makeCommand({ kind: "message", text: "hello" });
    expect(Reflect.set(command, "payload", { kind: "future_kind" })).toBe(true);
    const calls: TargetCall[] = [];
    const harness = createStore(command);
    const dispatcher = createSteeringCommandDispatcher(harness.store);

    await expect(dispatcher.dispatch({ command, target: createTarget(calls), at })).rejects.toThrow(
      "unsupported node command payload",
    );
    expect(calls).toHaveLength(0);
    expect(harness.acknowledgements).toHaveLength(0);
    expect(harness.applications).toHaveLength(0);
    expect(harness.failures).toHaveLength(0);
  });
});
