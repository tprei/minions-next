import {
  NodeCommandTargetError,
  nodeCommandIsSafeToRedeliver,
  type DispatchClaimedNodeCommandRequest,
  type NodeCommandDispatchTarget,
  type NodeCommandDeliveryReference,
  type NodeCommandPayload,
  type NodeCommandRecord,
  type SteeringCommandDispatcher,
  type SteeringCommandStore,
} from "@minions/core";

export function createSteeringCommandDispatcher(
  store: SteeringCommandStore,
): SteeringCommandDispatcher {
  return new DefaultSteeringCommandDispatcher(store);
}

class DefaultSteeringCommandDispatcher implements SteeringCommandDispatcher {
  readonly #store: SteeringCommandStore;

  constructor(store: SteeringCommandStore) {
    this.#store = store;
  }

  async dispatch(request: DispatchClaimedNodeCommandRequest): Promise<NodeCommandRecord> {
    const { command, target, at } = request;
    const deliveryToken = command.deliveryToken;
    if (command.state !== "sent" || deliveryToken === undefined) {
      throw new Error("node command must be sent with a delivery token before dispatch");
    }

    const delivery = {
      commandId: command.commandId,
      deliveryToken,
    };
    assertSupportedPayload(command.payload);
    try {
      await dispatchPayload(target, command.commandId, command.payload);
    } catch (error) {
      const wasRejected =
        error instanceof NodeCommandTargetError && error.disposition === "rejected";
      if (!wasRejected && nodeCommandIsSafeToRedeliver(command.payload)) {
        throw error;
      }
      return recordFailure(this.#store, delivery, at, !wasRejected, error);
    }

    await this.#store.acknowledge({ delivery, at });
    return this.#store.apply({ delivery, at });
  }
}

async function recordFailure(
  store: SteeringCommandStore,
  delivery: NodeCommandDeliveryReference,
  at: DispatchClaimedNodeCommandRequest["at"],
  ambiguous: boolean,
  targetError: unknown,
): Promise<NodeCommandRecord> {
  let recordingError: unknown;
  try {
    return await store.fail({
      delivery,
      at,
      failure: errorMessage(targetError),
      ambiguous,
    });
  } catch (error) {
    recordingError = error;
  }
  throw new AggregateError(
    [targetError, recordingError],
    "node command dispatch and failure recording failed",
    { cause: targetError },
  );
}

function assertSupportedPayload(payload: NodeCommandPayload): void {
  switch (payload.kind) {
    case "message":
    case "steer_after_current_tool":
    case "interrupt_now":
    case "follow_up_after_turn":
    case "pause":
    case "resume":
    case "answer":
    case "approve":
    case "reject":
    case "retry":
    case "cancel_node":
    case "cancel_subtree":
    case "replan_unstarted_subtree":
      return;
  }
  throw new Error("unsupported node command payload");
}

async function dispatchPayload(
  target: NodeCommandDispatchTarget,
  commandId: NodeCommandRecord["commandId"],
  payload: NodeCommandPayload,
): Promise<void> {
  switch (payload.kind) {
    case "message":
      await target.message(commandId, payload.text);
      return;
    case "steer_after_current_tool":
      await target.steerAfterCurrentTool(commandId, payload.text);
      return;
    case "interrupt_now":
      await target.interruptNow(commandId);
      return;
    case "follow_up_after_turn":
      await target.followUpAfterTurn(commandId, payload.text);
      return;
    case "pause":
      await target.pause(commandId);
      return;
    case "resume":
      await target.resume(commandId);
      return;
    case "answer":
      await target.answer(commandId, payload.attentionId, payload.answer);
      return;
    case "approve":
      await target.approve(commandId, payload.attentionId, payload.reason);
      return;
    case "reject":
      await target.reject(commandId, payload.attentionId, payload.reason);
      return;
    case "retry":
      await target.retry(commandId);
      return;
    case "cancel_node":
      await target.cancelNode(commandId);
      return;
    case "cancel_subtree":
      await target.cancelSubtree(commandId);
      return;
    case "replan_unstarted_subtree":
      await target.replanUnstartedSubtree(commandId, payload.objective);
      return;
  }
  throw new Error("unsupported node command payload");
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return String(error);
  } catch {
    return "unknown node command target failure";
  }
}
