import { DomainError } from "./domain-error.js";
import type { ActorSessionId, CommandId, TaskNodeId, Timestamp } from "./value-objects.js";

declare const nodeAttentionIdBrand: unique symbol;
declare const nodeCommandDeliveryTokenBrand: unique symbol;

export type NodeAttentionId = string & { readonly [nodeAttentionIdBrand]: true };
export type NodeCommandDeliveryToken = string & {
  readonly [nodeCommandDeliveryTokenBrand]: true;
};

export type NodeCommandPayload =
  | Readonly<{ kind: "message"; text: string }>
  | Readonly<{ kind: "steer_after_current_tool"; text: string }>
  | Readonly<{ kind: "interrupt_now" }>
  | Readonly<{ kind: "follow_up_after_turn"; text: string }>
  | Readonly<{ kind: "pause" }>
  | Readonly<{ kind: "resume" }>
  | Readonly<{ kind: "answer"; attentionId: NodeAttentionId; answer: string }>
  | Readonly<{ kind: "approve"; attentionId: NodeAttentionId; reason: string | undefined }>
  | Readonly<{ kind: "reject"; attentionId: NodeAttentionId; reason: string | undefined }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "cancel_node" }>
  | Readonly<{ kind: "cancel_subtree" }>
  | Readonly<{ kind: "replan_unstarted_subtree"; objective: string }>;

export type NodeCommandDeliveryState =
  "queued" | "sent" | "acknowledged" | "applied" | "failed" | "review_required";

export type NodeCommandRecoveryDisposition =
  "resume_session" | "fork_session" | "retry_external_action" | "requires_review";

export type NodeCommandRecord = Readonly<{
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  nodeId: TaskNodeId;
  ordinal: bigint;
  payload: NodeCommandPayload;
  state: NodeCommandDeliveryState;
  recoveryDisposition: NodeCommandRecoveryDisposition;
  deliveryAttempts: number;
  deliveryToken: NodeCommandDeliveryToken | undefined;
  createdAt: Timestamp;
  sentAt: Timestamp | undefined;
  acknowledgedAt: Timestamp | undefined;
  appliedAt: Timestamp | undefined;
  failedAt: Timestamp | undefined;
  failure: string | undefined;
}>;

export type NodeAttentionKind = "question" | "approval";
export type NodeAttentionState = "open" | "resolved";

export type NodeAttentionRecord = Readonly<{
  id: NodeAttentionId;
  nodeId: TaskNodeId;
  kind: NodeAttentionKind;
  prompt: string;
  choices: readonly string[];
  state: NodeAttentionState;
  resolutionCommandId: CommandId | undefined;
  resolution: string | undefined;
  createdAt: Timestamp;
  resolvedAt: Timestamp | undefined;
}>;

export type QueueNodeCommandRequest = Readonly<{
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  nodeId: TaskNodeId;
  expectedNodeVersion: number | undefined;
  payload: NodeCommandPayload;
  at: Timestamp;
}>;

export type ClaimNodeCommandRequest = Readonly<{
  nodeId: TaskNodeId;
  afterOrdinal: bigint;
  at: Timestamp;
  acknowledgementTimeoutMs: number;
  deliveryToken: NodeCommandDeliveryToken;
}>;

export type NodeCommandDeliveryReference = Readonly<{
  commandId: CommandId;
  deliveryToken: NodeCommandDeliveryToken;
}>;

export type AcknowledgeNodeCommandRequest = Readonly<{
  delivery: NodeCommandDeliveryReference;
  at: Timestamp;
}>;

export type ApplyNodeCommandRequest = Readonly<{
  delivery: NodeCommandDeliveryReference;
  at: Timestamp;
}>;

export type FailNodeCommandRequest = Readonly<{
  delivery: NodeCommandDeliveryReference;
  at: Timestamp;
  failure: string;
  ambiguous: boolean;
}>;

export type ListNodeCommandsRequest = Readonly<{
  nodeId: TaskNodeId;
  afterOrdinal: bigint;
  limit: number;
}>;

export type CreateNodeAttentionRequest = Readonly<{
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  id: NodeAttentionId;
  nodeId: TaskNodeId;
  kind: NodeAttentionKind;
  prompt: string;
  choices: readonly string[];
  at: Timestamp;
}>;

export interface SteeringCommandStore {
  queue(request: QueueNodeCommandRequest): Promise<NodeCommandRecord>;
  get(commandId: CommandId): NodeCommandRecord | undefined;
  list(request: ListNodeCommandsRequest): readonly NodeCommandRecord[];
  claimNext(request: ClaimNodeCommandRequest): Promise<NodeCommandRecord | undefined>;
  acknowledge(request: AcknowledgeNodeCommandRequest): Promise<NodeCommandRecord>;
  apply(request: ApplyNodeCommandRequest): Promise<NodeCommandRecord>;
  fail(request: FailNodeCommandRequest): Promise<NodeCommandRecord>;
  createAttention(request: CreateNodeAttentionRequest): Promise<NodeAttentionRecord>;
  listAttention(nodeId: TaskNodeId, openOnly: boolean): readonly NodeAttentionRecord[];
}

export interface NodeCommandDispatchTarget {
  message(commandId: CommandId, text: string): Promise<void>;
  steerAfterCurrentTool(commandId: CommandId, text: string): Promise<void>;
  interruptNow(commandId: CommandId): Promise<void>;
  followUpAfterTurn(commandId: CommandId, text: string): Promise<void>;
  pause(commandId: CommandId): Promise<void>;
  resume(commandId: CommandId): Promise<void>;
  answer(commandId: CommandId, attentionId: NodeAttentionId, answer: string): Promise<void>;
  approve(
    commandId: CommandId,
    attentionId: NodeAttentionId,
    reason: string | undefined,
  ): Promise<void>;
  reject(
    commandId: CommandId,
    attentionId: NodeAttentionId,
    reason: string | undefined,
  ): Promise<void>;
  retry(commandId: CommandId): Promise<void>;
  cancelNode(commandId: CommandId): Promise<void>;
  cancelSubtree(commandId: CommandId): Promise<void>;
  replanUnstartedSubtree(commandId: CommandId, objective: string): Promise<void>;
}

export type DispatchClaimedNodeCommandRequest = Readonly<{
  command: NodeCommandRecord;
  target: NodeCommandDispatchTarget;
  at: Timestamp;
}>;

export interface SteeringCommandDispatcher {
  dispatch(request: DispatchClaimedNodeCommandRequest): Promise<NodeCommandRecord>;
}
export type NodeCommandTargetErrorDisposition = "rejected" | "delivery_unknown";

export class NodeCommandTargetError extends Error {
  readonly disposition: NodeCommandTargetErrorDisposition;

  constructor(
    disposition: NodeCommandTargetErrorDisposition,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeCommandTargetError";
    this.disposition = disposition;
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function nodeAttentionId(value: string): NodeAttentionId {
  if (!uuidPattern.test(value)) {
    throw new DomainError("invalid_value", "node attention ID must be a lowercase UUID");
  }
  return value as NodeAttentionId;
}

export function nodeCommandDeliveryToken(value: string): NodeCommandDeliveryToken {
  if (!uuidPattern.test(value)) {
    throw new DomainError("invalid_value", "node command delivery token must be a lowercase UUID");
  }
  return value as NodeCommandDeliveryToken;
}

export function nodeCommandIsSafeToRedeliver(payload: NodeCommandPayload): boolean {
  switch (payload.kind) {
    case "message":
    case "steer_after_current_tool":
    case "interrupt_now":
    case "follow_up_after_turn":
    case "pause":
    case "resume":
      return true;
    case "answer":
    case "approve":
    case "reject":
    case "retry":
    case "cancel_node":
    case "cancel_subtree":
    case "replan_unstarted_subtree":
      return false;
  }
}
