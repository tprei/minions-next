import {
  create,
  type DescMessage,
  type MessageShape,
  type MessageValidType,
} from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import type {
  EventCommitWaiter,
  SqliteAttentionSummary,
  SqliteEventSnapshot,
  SqliteEventStore,
  SqliteHostSummary,
  SqliteNodeSummary,
  SqliteRepositorySummary,
  SqliteStoredEvent,
  SqliteTreeSummary,
} from "@minions/adapters";
import {
  AggregateKind,
  AttentionKind,
  AttentionSummarySchema,
  decodeProjectionChange,
  ErrorDetailSchema,
  EventCursorExpiredSchema,
  EventEnvelopeSchema,
  EventService,
  GetSnapshotResponseSchema,
  HostSummarySchema,
  NodeState,
  NodeSummarySchema,
  ProjectionChangeSchema,
  RepositorySummarySchema,
  TreeState,
  TreeSummarySchema,
  WatchEventsResponseSchema,
} from "@minions/contracts";

const eventTypeName = ProjectionChangeSchema.typeName;
const eventPageSize = 100;
const responseValidator = createValidator();

export type EventServiceOptions = Readonly<{
  store: SqliteEventStore;
  waiter: EventCommitWaiter;
  pollIntervalMs: number;
}>;

export function registerEventService(router: ConnectRouter, options: EventServiceOptions): void {
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new RangeError("pollIntervalMs must be a positive safe integer");
  }
  assertEventHistoryCompatible(options.store);

  router.service(EventService, {
    getSnapshot() {
      return createSnapshotResponse(options.store.getSnapshot());
    },
    async *watchEvents(request, context) {
      let cursor = request.afterSequence;
      assertCursor(options.store.getBounds(), cursor, true);

      while (!context.signal.aborted) {
        const observedRevision = options.waiter.getRevision();
        const bounds = options.store.getBounds();
        assertCursor(bounds, cursor, false);
        const events = options.store.readEvents(cursor, eventPageSize);

        if (events.length > 0) {
          for (const event of events) {
            if (event.sequence !== cursor + 1n) {
              assertCursor(options.store.getBounds(), cursor, false);
              throw new ConnectError("durable event sequence contains a gap", Code.Internal);
            }
            const response = create(WatchEventsResponseSchema, {
              event: createEventEnvelope(event),
            });
            yield validateResponse(WatchEventsResponseSchema, response);
            cursor = event.sequence;
          }
          continue;
        }

        const waitResult = await options.waiter.wait({
          afterRevision: observedRevision,
          timeoutMs: options.pollIntervalMs,
          signal: context.signal,
        });
        if (waitResult === "closed") {
          return;
        }
      }
    },
  });
}

function assertEventHistoryCompatible(store: SqliteEventStore): void {
  const bounds = store.getBounds();
  let cursor = bounds.minimumAvailableSequence - 1n;
  while (cursor < bounds.lastSequence) {
    const events = store.readEvents(cursor, eventPageSize);
    if (events.length === 0) {
      throw new ConnectError(
        "durable event history ends before its high-water mark",
        Code.Internal,
      );
    }
    for (const event of events) {
      if (event.sequence !== cursor + 1n) {
        throw new ConnectError("durable event history contains a sequence gap", Code.Internal);
      }
      createEventEnvelope(event);
      cursor = event.sequence;
    }
  }
}

function createSnapshotResponse(snapshot: SqliteEventSnapshot) {
  const response = create(GetSnapshotResponseSchema, {
    hosts: snapshot.hosts.map(toHostSummary),
    repositories: snapshot.repositories.map(toRepositorySummary),
    trees: snapshot.trees.map(toTreeSummary),
    nodes: snapshot.nodes.map(toNodeSummary),
    attention: snapshot.attention.map(toAttentionSummary),
    lastSequence: snapshot.lastSequence,
    minimumAvailableSequence: snapshot.minimumAvailableSequence,
  });
  return validateResponse(GetSnapshotResponseSchema, response);
}

function createEventEnvelope(event: SqliteStoredEvent) {
  if (event.eventType !== eventTypeName) {
    throw new ConnectError("stored event type is not supported", Code.Internal);
  }
  let projectionChange;
  try {
    projectionChange = decodeProjectionChange(event.eventPayload);
  } catch (error) {
    throw new ConnectError(
      "stored projection event is invalid",
      Code.Internal,
      undefined,
      undefined,
      error,
    );
  }
  const envelope = create(EventEnvelopeSchema, {
    sequence: event.sequence,
    eventId: event.eventId,
    aggregateKind: toAggregateKind(event.aggregateKind),
    aggregateId: event.aggregateId,
    aggregateVersion: BigInt(event.aggregateVersion),
    occurredAt: timestampFromMilliseconds(event.occurredAtMs),
    event: {
      case: "projectionChange",
      value: projectionChange,
    },
  });
  return validateResponse(EventEnvelopeSchema, envelope);
}

function toHostSummary(summary: SqliteHostSummary) {
  return create(HostSummarySchema, {
    id: summary.id,
    online: summary.online,
    version: BigInt(summary.version),
  });
}

function toRepositorySummary(summary: SqliteRepositorySummary) {
  return create(RepositorySummarySchema, {
    id: summary.id,
    hostId: summary.hostId,
    version: BigInt(summary.version),
    archived: summary.archived,
  });
}

function toTreeSummary(summary: SqliteTreeSummary) {
  return create(TreeSummarySchema, {
    id: summary.id,
    repositoryId: summary.repositoryId,
    hostId: summary.hostId,
    rootNodeId: summary.rootNodeId,
    activePlanRevisionId: summary.activePlanRevisionId,
    state: toTreeState(summary.planStateKind, summary.rootStateKind),
    version: BigInt(summary.version),
  });
}

function toNodeSummary(summary: SqliteNodeSummary) {
  return create(NodeSummarySchema, {
    id: summary.id,
    treeId: summary.treeId,
    parentNodeId: summary.parentNodeId,
    ordinal: BigInt(summary.ordinal),
    objective: summary.objective,
    state: toNodeState(summary.stateKind),
    version: BigInt(summary.version),
  });
}

function toAttentionSummary(summary: SqliteAttentionSummary) {
  return create(AttentionSummarySchema, {
    nodeId: summary.nodeId,
    kind: toAttentionKind(summary.kind),
    evidenceId: summary.evidenceId,
  });
}

function toAggregateKind(kind: string): AggregateKind {
  switch (kind) {
    case "repository":
      return AggregateKind.REPOSITORY;
    case "tree":
      return AggregateKind.TREE;
    case "node":
      return AggregateKind.NODE;
    case "attempt":
      return AggregateKind.ATTEMPT;
    default:
      throw new ConnectError("stored aggregate kind is not supported", Code.Internal);
  }
}

function toTreeState(planState: string, rootState: string): TreeState {
  if (planState === "draft") {
    return TreeState.DRAFT;
  }
  if (planState !== "approved") {
    throw new ConnectError("active plan revision is not current", Code.Internal);
  }
  switch (rootState) {
    case "planned":
      return TreeState.APPROVED;
    case "ready":
    case "active":
    case "blocked":
    case "superseded":
      return TreeState.ACTIVE;
    case "succeeded":
      return TreeState.SUCCEEDED;
    case "failed":
      return TreeState.FAILED;
    case "cancelled":
      return TreeState.CANCELLED;
    default:
      throw new ConnectError("stored root node state is not supported", Code.Internal);
  }
}

function toNodeState(state: string): NodeState {
  switch (state) {
    case "planned":
      return NodeState.PLANNED;
    case "ready":
      return NodeState.READY;
    case "active":
      return NodeState.ACTIVE;
    case "blocked":
      return NodeState.BLOCKED;
    case "succeeded":
      return NodeState.SUCCEEDED;
    case "failed":
      return NodeState.FAILED;
    case "cancelled":
      return NodeState.CANCELLED;
    case "superseded":
      return NodeState.SUPERSEDED;
    default:
      throw new ConnectError("stored node state is not supported", Code.Internal);
  }
}

function toAttentionKind(kind: string): AttentionKind {
  switch (kind) {
    case "authentication":
      return AttentionKind.AUTHENTICATION;
    case "ci_failure":
      return AttentionKind.CI_FAILURE;
    case "conflict":
      return AttentionKind.CONFLICT;
    case "gate_failure":
      return AttentionKind.GATE_FAILURE;
    case "plan_required":
    case "plan_invalid":
    case "repair_required":
    case "human_input":
      return AttentionKind.HUMAN_INPUT;
    case "parent":
      return AttentionKind.PARENT;
    case "quota":
      return AttentionKind.QUOTA;
    case "unavailable_host":
      return AttentionKind.UNAVAILABLE_HOST;
    case "node_failed":
      return AttentionKind.NODE_FAILED;
    default:
      throw new ConnectError("stored attention kind is not supported", Code.Internal);
  }
}

function timestampFromMilliseconds(milliseconds: bigint) {
  return create(TimestampSchema, {
    seconds: milliseconds / 1000n,
    nanos: Number(milliseconds % 1000n) * 1_000_000,
  });
}

function assertCursor(
  bounds: Readonly<{ minimumAvailableSequence: bigint; lastSequence: bigint }>,
  cursor: bigint,
  rejectFuture: boolean,
): void {
  if (rejectFuture && cursor > bounds.lastSequence) {
    throw new ConnectError(
      "event cursor is ahead of the durable event sequence",
      Code.InvalidArgument,
    );
  }
  if (cursor + 1n >= bounds.minimumAvailableSequence) {
    return;
  }
  const expired = create(EventCursorExpiredSchema, {
    minimumAvailableSequence: bounds.minimumAvailableSequence,
    lastSequence: bounds.lastSequence,
  });
  const detail = create(ErrorDetailSchema, {
    detail: {
      case: "eventCursorExpired",
      value: expired,
    },
  });
  throw new ConnectError(
    "event cursor is older than retained history",
    Code.OutOfRange,
    undefined,
    [
      {
        desc: ErrorDetailSchema,
        value: detail,
      },
    ],
  );
}

function validateResponse<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): MessageValidType<Desc> {
  const validation = responseValidator.validate(schema, message);
  if (validation.kind !== "valid") {
    throw new ConnectError(
      "event service produced an invalid response",
      Code.Internal,
      undefined,
      undefined,
      validation.error,
    );
  }
  return validation.message;
}
