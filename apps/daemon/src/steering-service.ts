import {
  create,
  type DescMessage,
  type MessageShape,
  type MessageValidType,
} from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { SqliteSteeringError } from "@minions/adapters";
import {
  AnswerNodeCommandSchema,
  EmptyNodeCommandSchema,
  GetNodeCommandResponseSchema,
  ListNodeAttentionResponseSchema,
  ListNodeCommandsResponseSchema,
  NodeAttentionKind,
  NodeAttentionSchema,
  NodeAttentionState,
  NodeCommandDeliveryState,
  NodeCommandPayloadSchema,
  NodeCommandRecoveryDisposition,
  NodeCommandSchema,
  QueueNodeCommandResponseSchema,
  ReplanNodeCommandSchema,
  ResolveApprovalNodeCommandSchema,
  SteeringService,
  TextNodeCommandSchema,
  type NodeCommandPayload as NodeCommandPayloadMessage,
} from "@minions/contracts";
import {
  actorSessionId,
  commandId,
  nodeAttentionId,
  taskNodeId,
  timestampFromEpochMilliseconds,
  DomainError,
  type Clock,
  type NodeAttentionRecord,
  type NodeCommandPayload,
  type NodeCommandRecord,
  type SteeringCommandStore,
  type Timestamp,
} from "@minions/core";

const responseValidator = createValidator();

export type SteeringServiceOptions = Readonly<{
  store: SteeringCommandStore;
  clock: Clock;
}>;

export function registerSteeringService(
  router: ConnectRouter,
  options: SteeringServiceOptions,
): void {
  router.service(SteeringService, {
    async queueNodeCommand(request) {
      try {
        const command = await options.store.queue({
          commandId: commandId(request.commandId),
          actorSessionId: actorSessionId(request.actorSessionId),
          nodeId: taskNodeId(request.nodeId),
          expectedNodeVersion: safeVersion(request.expectedNodeVersion),
          payload: toDomainPayload(request.payload),
          at: timestampFromEpochMilliseconds(options.clock.now()),
        });
        return validateResponse(
          QueueNodeCommandResponseSchema,
          create(QueueNodeCommandResponseSchema, { command: toNodeCommandMessage(command) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    getNodeCommand(request) {
      try {
        const command = options.store.get(commandId(request.commandId));
        if (command === undefined) {
          throw new ConnectError("node command was not found", Code.NotFound);
        }
        return validateResponse(
          GetNodeCommandResponseSchema,
          create(GetNodeCommandResponseSchema, { command: toNodeCommandMessage(command) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    listNodeCommands(request) {
      try {
        const pageSize = request.pageSize;
        const rows = options.store.list({
          nodeId: taskNodeId(request.nodeId),
          afterOrdinal: request.afterOrdinal ?? 0n,
          limit: pageSize + 1,
        });
        const commands = rows.slice(0, pageSize);
        const hasNext = rows.length > commands.length;
        const last = commands.at(-1);
        return validateResponse(
          ListNodeCommandsResponseSchema,
          create(ListNodeCommandsResponseSchema, {
            commands: commands.map(toNodeCommandMessage),
            ...(hasNext && last !== undefined ? { nextOrdinal: last.ordinal } : {}),
          }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    listNodeAttention(request) {
      try {
        const attention = options.store.listAttention(taskNodeId(request.nodeId), request.openOnly);
        return validateResponse(
          ListNodeAttentionResponseSchema,
          create(ListNodeAttentionResponseSchema, {
            attention: attention.map(toNodeAttentionMessage),
          }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
  });
}

function toDomainPayload(payload: NodeCommandPayloadMessage | undefined): NodeCommandPayload {
  if (payload === undefined) {
    throw new ConnectError("node command payload is required", Code.InvalidArgument);
  }
  switch (payload.command.case) {
    case "message":
      return { kind: "message", text: payload.command.value.text };
    case "steerAfterCurrentTool":
      return { kind: "steer_after_current_tool", text: payload.command.value.text };
    case "interruptNow":
      return { kind: "interrupt_now" };
    case "followUpAfterTurn":
      return { kind: "follow_up_after_turn", text: payload.command.value.text };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "answer":
      return {
        kind: "answer",
        attentionId: nodeAttentionId(payload.command.value.attentionId),
        answer: payload.command.value.answer,
      };
    case "approve":
      return {
        kind: "approve",
        attentionId: nodeAttentionId(payload.command.value.attentionId),
        reason: payload.command.value.reason,
      };
    case "reject":
      return {
        kind: "reject",
        attentionId: nodeAttentionId(payload.command.value.attentionId),
        reason: payload.command.value.reason,
      };
    case "retry":
      return { kind: "retry" };
    case "cancelNode":
      return { kind: "cancel_node" };
    case "cancelSubtree":
      return { kind: "cancel_subtree" };
    case "replanUnstartedSubtree":
      return {
        kind: "replan_unstarted_subtree",
        objective: payload.command.value.objective,
      };
    case undefined:
      throw new ConnectError("node command payload command is required", Code.InvalidArgument);
  }
}

function toPayloadMessage(payload: NodeCommandPayload) {
  switch (payload.kind) {
    case "message":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "message",
          value: create(TextNodeCommandSchema, { text: payload.text }),
        },
      });
    case "steer_after_current_tool":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "steerAfterCurrentTool",
          value: create(TextNodeCommandSchema, { text: payload.text }),
        },
      });
    case "interrupt_now":
      return create(NodeCommandPayloadSchema, {
        command: { case: "interruptNow", value: create(EmptyNodeCommandSchema) },
      });
    case "follow_up_after_turn":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "followUpAfterTurn",
          value: create(TextNodeCommandSchema, { text: payload.text }),
        },
      });
    case "pause":
      return create(NodeCommandPayloadSchema, {
        command: { case: "pause", value: create(EmptyNodeCommandSchema) },
      });
    case "resume":
      return create(NodeCommandPayloadSchema, {
        command: { case: "resume", value: create(EmptyNodeCommandSchema) },
      });
    case "answer":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "answer",
          value: create(AnswerNodeCommandSchema, {
            attentionId: payload.attentionId,
            answer: payload.answer,
          }),
        },
      });
    case "approve":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "approve",
          value: create(ResolveApprovalNodeCommandSchema, {
            attentionId: payload.attentionId,
            ...(payload.reason === undefined ? {} : { reason: payload.reason }),
          }),
        },
      });
    case "reject":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "reject",
          value: create(ResolveApprovalNodeCommandSchema, {
            attentionId: payload.attentionId,
            ...(payload.reason === undefined ? {} : { reason: payload.reason }),
          }),
        },
      });
    case "retry":
      return create(NodeCommandPayloadSchema, {
        command: { case: "retry", value: create(EmptyNodeCommandSchema) },
      });
    case "cancel_node":
      return create(NodeCommandPayloadSchema, {
        command: { case: "cancelNode", value: create(EmptyNodeCommandSchema) },
      });
    case "cancel_subtree":
      return create(NodeCommandPayloadSchema, {
        command: { case: "cancelSubtree", value: create(EmptyNodeCommandSchema) },
      });
    case "replan_unstarted_subtree":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "replanUnstartedSubtree",
          value: create(ReplanNodeCommandSchema, { objective: payload.objective }),
        },
      });
  }
}

function toNodeCommandMessage(command: NodeCommandRecord) {
  return create(NodeCommandSchema, {
    commandId: command.commandId,
    actorSessionId: command.actorSessionId,
    nodeId: command.nodeId,
    ordinal: command.ordinal,
    payload: toPayloadMessage(command.payload),
    deliveryState: toDeliveryState(command.state),
    recoveryDisposition: toRecoveryDisposition(command.recoveryDisposition),
    deliveryAttempts: command.deliveryAttempts,
    createdAt: timestampMessage(command.createdAt),
    ...(command.sentAt === undefined ? {} : { sentAt: timestampMessage(command.sentAt) }),
    ...(command.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: timestampMessage(command.acknowledgedAt) }),
    ...(command.appliedAt === undefined ? {} : { appliedAt: timestampMessage(command.appliedAt) }),
    ...(command.failedAt === undefined ? {} : { failedAt: timestampMessage(command.failedAt) }),
    ...(command.failure === undefined ? {} : { failure: command.failure }),
  });
}

function toNodeAttentionMessage(attention: NodeAttentionRecord) {
  return create(NodeAttentionSchema, {
    id: attention.id,
    nodeId: attention.nodeId,
    kind: toAttentionKind(attention.kind),
    prompt: attention.prompt,
    choices: [...attention.choices],
    state: toAttentionState(attention.state),
    ...(attention.resolutionCommandId === undefined
      ? {}
      : { resolutionCommandId: attention.resolutionCommandId }),
    ...(attention.resolution === undefined ? {} : { resolution: attention.resolution }),
    createdAt: timestampMessage(attention.createdAt),
    ...(attention.resolvedAt === undefined
      ? {}
      : { resolvedAt: timestampMessage(attention.resolvedAt) }),
  });
}

function toDeliveryState(state: NodeCommandRecord["state"]): NodeCommandDeliveryState {
  switch (state) {
    case "queued":
      return NodeCommandDeliveryState.QUEUED;
    case "sent":
      return NodeCommandDeliveryState.SENT;
    case "acknowledged":
      return NodeCommandDeliveryState.ACKNOWLEDGED;
    case "applied":
      return NodeCommandDeliveryState.APPLIED;
    case "failed":
      return NodeCommandDeliveryState.FAILED;
    case "review_required":
      return NodeCommandDeliveryState.REVIEW_REQUIRED;
  }
}

function toRecoveryDisposition(
  disposition: NodeCommandRecord["recoveryDisposition"],
): NodeCommandRecoveryDisposition {
  switch (disposition) {
    case "resume_session":
      return NodeCommandRecoveryDisposition.RESUME_SESSION;
    case "fork_session":
      return NodeCommandRecoveryDisposition.FORK_SESSION;
    case "retry_external_action":
      return NodeCommandRecoveryDisposition.RETRY_EXTERNAL_ACTION;
    case "requires_review":
      return NodeCommandRecoveryDisposition.REQUIRES_REVIEW;
  }
}

function toAttentionKind(kind: NodeAttentionRecord["kind"]): NodeAttentionKind {
  switch (kind) {
    case "question":
      return NodeAttentionKind.QUESTION;
    case "approval":
      return NodeAttentionKind.APPROVAL;
  }
}

function toAttentionState(state: NodeAttentionRecord["state"]): NodeAttentionState {
  switch (state) {
    case "open":
      return NodeAttentionState.OPEN;
    case "resolved":
      return NodeAttentionState.RESOLVED;
  }
}

function timestampMessage(milliseconds: Timestamp) {
  const value = BigInt(milliseconds);
  return create(TimestampSchema, {
    seconds: value / 1_000n,
    nanos: Number(value % 1_000n) * 1_000_000,
  });
}

function safeVersion(value: bigint | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectError(
      "expected node version exceeds the supported range",
      Code.InvalidArgument,
    );
  }
  return Number(value);
}

function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    return error;
  }
  if (error instanceof SqliteSteeringError) {
    switch (error.code) {
      case "invalid_command":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "not_found":
      case "attention_not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "stale_delivery":
      case "invalid_transition":
      case "attention_closed":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      case "corrupt":
        return new ConnectError(error.message, Code.DataLoss, undefined, undefined, error);
    }
  }
  if (error instanceof DomainError) {
    switch (error.code) {
      case "invalid_value":
      case "invalid_artifact_input":
      case "invalid_outcome":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "duplicate_id":
      case "invalid_transition":
      case "invalid_tree":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
    }
  }
  return new ConnectError("steering operation failed", Code.Internal, undefined, undefined, error);
}

function validateResponse<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): MessageValidType<Desc> {
  const validation = responseValidator.validate(schema, message);
  if (validation.kind !== "valid") {
    throw new ConnectError(
      "steering service produced an invalid response",
      Code.Internal,
      undefined,
      undefined,
      validation.error,
    );
  }
  return validation.message;
}
