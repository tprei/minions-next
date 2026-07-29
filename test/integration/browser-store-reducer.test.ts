import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AggregateKind,
  ArtifactRetention,
  ArtifactSchema,
  AttentionKind,
  AttentionRemovedSchema,
  AttentionSummarySchema,
  CommitOutcomeSchema,
  GetSnapshotResponseSchema,
  HostSummarySchema,
  NodeAttentionKind,
  NodeAttentionSchema,
  NodeAttentionState,
  NodeCommandDeliveryState,
  NodeCommandPayloadSchema,
  NodeCommandRecoveryDisposition,
  NodeCommandSchema,
  NodeOutcomeSchema,
  NodeState,
  NodeSummarySchema,
  ProjectionBatchSchema,
  ProjectionChangeSchema,
  ProjectionRemovedSchema,
  RepositorySummarySchema,
  TreeState,
  TreeSummarySchema,
  type ProjectionChange,
} from "@minions/contracts";
import { describe, expect, it } from "vitest";
import {
  applyProjectionChange,
  emptyProjectionState,
  NestedProjectionBatchError,
  projectionStateFromSnapshot,
} from "../../apps/web/src/data/index.js";

const now = timestampFromDate(new Date("2026-07-29T00:00:00Z"));
const HOST_ID = "01900000-0000-7000-8000-000000000001";
const REPO_ID = "01900000-0000-7000-8000-000000000002";
const TREE_ID = "01900000-0000-7000-8000-000000000003";
const NODE_ID = "01900000-0000-7000-8000-000000000004";
const NODE_ID_2 = "01900000-0000-7000-8000-000000000005";
const COMMAND_ID = "01900000-0000-7000-8000-000000000006";
const NODE_ATTENTION_ID = "01900000-0000-7000-8000-000000000007";
const ARTIFACT_ID = "01900000-0000-7000-8000-000000000008";

function change(payload: ProjectionChange["change"]): ProjectionChange {
  return create(ProjectionChangeSchema, { change: payload });
}

describe("applyProjectionChange", () => {
  it("upserts a host", () => {
    const host = create(HostSummarySchema, { id: HOST_ID, online: true, version: 1n });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "hostUpserted", value: host }),
    );
    expect(next.hosts.get(HOST_ID)).toEqual(host);
  });

  it("upserts a repository", () => {
    const repository = create(RepositorySummarySchema, {
      id: REPO_ID,
      hostId: HOST_ID,
      version: 1n,
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "repositoryUpserted", value: repository }),
    );
    expect(next.repositories.get(REPO_ID)).toEqual(repository);
  });

  it("upserts a tree", () => {
    const tree = create(TreeSummarySchema, {
      id: TREE_ID,
      repositoryId: REPO_ID,
      hostId: HOST_ID,
      rootNodeId: NODE_ID,
      activePlanRevisionId: TREE_ID,
      state: TreeState.ACTIVE,
      version: 1n,
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "treeUpserted", value: tree }),
    );
    expect(next.trees.get(TREE_ID)).toEqual(tree);
  });

  it("upserts a node", () => {
    const node = create(NodeSummarySchema, {
      id: NODE_ID,
      treeId: TREE_ID,
      ordinal: 0n,
      objective: "do work",
      state: NodeState.READY,
      version: 1n,
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "nodeUpserted", value: node }),
    );
    expect(next.nodes.get(NODE_ID)).toEqual(node);
  });

  it("upserts attention keyed by nodeId", () => {
    const attention = create(AttentionSummarySchema, {
      nodeId: NODE_ID,
      kind: AttentionKind.HUMAN_INPUT,
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "attentionUpserted", value: attention }),
    );
    expect(next.attention.get(NODE_ID)).toEqual(attention);
  });

  it("removes a repository/tree/node by aggregate kind", () => {
    const repository = create(RepositorySummarySchema, {
      id: REPO_ID,
      hostId: HOST_ID,
      version: 1n,
    });
    const seeded = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "repositoryUpserted", value: repository }),
    );
    const removed = create(ProjectionRemovedSchema, {
      aggregateKind: AggregateKind.REPOSITORY,
      aggregateId: REPO_ID,
    });
    const next = applyProjectionChange(seeded, change({ case: "removed", value: removed }));
    expect(next.repositories.has(REPO_ID)).toBe(false);
  });

  it("ignores removal of an aggregate kind with no tracked map (ATTEMPT/UNSPECIFIED)", () => {
    const state = emptyProjectionState();
    const removed = create(ProjectionRemovedSchema, {
      aggregateKind: AggregateKind.ATTEMPT,
      aggregateId: NODE_ID,
    });
    expect(applyProjectionChange(state, change({ case: "removed", value: removed }))).toBe(state);
  });

  it("removes attention via attentionRemoved", () => {
    const attention = create(AttentionSummarySchema, {
      nodeId: NODE_ID,
      kind: AttentionKind.QUOTA,
    });
    const seeded = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "attentionUpserted", value: attention }),
    );
    const next = applyProjectionChange(
      seeded,
      change({
        case: "attentionRemoved",
        value: create(AttentionRemovedSchema, { nodeId: NODE_ID }),
      }),
    );
    expect(next.attention.has(NODE_ID)).toBe(false);
  });

  it("upserts a node command keyed by commandId", () => {
    const command = create(NodeCommandSchema, {
      commandId: COMMAND_ID,
      actorSessionId: COMMAND_ID,
      nodeId: NODE_ID,
      ordinal: 1n,
      payload: create(NodeCommandPayloadSchema, { command: { case: "pause", value: {} } }),
      deliveryState: NodeCommandDeliveryState.QUEUED,
      recoveryDisposition: NodeCommandRecoveryDisposition.RESUME_SESSION,
      createdAt: now,
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "nodeCommandUpserted", value: command }),
    );
    expect(next.nodeCommands.get(COMMAND_ID)).toEqual(command);
  });

  it("upserts node attention keyed by id", () => {
    const nodeAttention = create(NodeAttentionSchema, {
      id: NODE_ATTENTION_ID,
      nodeId: NODE_ID,
      kind: NodeAttentionKind.QUESTION,
      prompt: "which approach?",
      state: NodeAttentionState.OPEN,
      createdAt: now,
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "nodeAttentionUpserted", value: nodeAttention }),
    );
    expect(next.nodeAttention.get(NODE_ATTENTION_ID)).toEqual(nodeAttention);
  });

  it("upserts an artifact keyed by artifactId", () => {
    const artifact = create(ArtifactSchema, {
      artifactId: ARTIFACT_ID,
      nodeId: NODE_ID,
      treeId: TREE_ID,
      repositoryId: REPO_ID,
      hostId: HOST_ID,
      contentDigest: "a".repeat(64),
      sizeBytes: 1n,
      mediaType: "text/plain",
      artifactType: "log",
      evidenceId: ARTIFACT_ID,
      retention: ArtifactRetention.ACTIVE,
      createdAt: now,
      verifiedAt: now,
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "artifactUpserted", value: artifact }),
    );
    expect(next.artifacts.get(ARTIFACT_ID)).toEqual(artifact);
  });

  it("upserts a node outcome keyed by nodeId", () => {
    const outcome = create(NodeOutcomeSchema, {
      nodeId: NODE_ID,
      outcome: {
        case: "commit",
        value: create(CommitOutcomeSchema, { revision: "b".repeat(40), evidenceId: ARTIFACT_ID }),
      },
      createdAt: now,
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "nodeOutcomeUpserted", value: outcome }),
    );
    expect(next.nodeOutcomes.get(NODE_ID)).toEqual(outcome);
  });

  it("applies every change in a batch, in order", () => {
    const nodeA = create(NodeSummarySchema, {
      id: NODE_ID,
      treeId: TREE_ID,
      ordinal: 0n,
      objective: "a",
      state: NodeState.READY,
      version: 1n,
    });
    const nodeB = create(NodeSummarySchema, {
      id: NODE_ID_2,
      treeId: TREE_ID,
      ordinal: 1n,
      objective: "b",
      state: NodeState.PLANNED,
      version: 1n,
    });
    const batch = create(ProjectionBatchSchema, {
      changes: [
        change({ case: "nodeUpserted", value: nodeA }),
        change({ case: "nodeUpserted", value: nodeB }),
      ],
    });
    const next = applyProjectionChange(
      emptyProjectionState(),
      change({ case: "batch", value: batch }),
    );
    expect(next.nodes.get(NODE_ID)).toEqual(nodeA);
    expect(next.nodes.get(NODE_ID_2)).toEqual(nodeB);
  });

  it("rejects a nested batch instead of looping", () => {
    const innerBatch = create(ProjectionBatchSchema, { changes: [] });
    const outerBatch = create(ProjectionBatchSchema, {
      changes: [change({ case: "batch", value: innerBatch })],
    });
    expect(() =>
      applyProjectionChange(emptyProjectionState(), change({ case: "batch", value: outerBatch })),
    ).toThrow(NestedProjectionBatchError);
  });

  it("leaves state unchanged for an unset oneof case", () => {
    const state = emptyProjectionState();
    expect(applyProjectionChange(state, create(ProjectionChangeSchema, {}))).toBe(state);
  });

  it("seeds a full state from a GetSnapshot response", () => {
    const host = create(HostSummarySchema, { id: HOST_ID, online: true, version: 1n });
    const snapshot = create(GetSnapshotResponseSchema, {
      hosts: [host],
      lastSequence: 5n,
      minimumAvailableSequence: 1n,
    });
    const state = projectionStateFromSnapshot(snapshot);
    expect(state.hosts.get(HOST_ID)).toEqual(host);
    expect(state.trees.size).toBe(0);
  });
});
