import { AggregateKind, type GetSnapshotResponse, type ProjectionChange } from "@minions/contracts";
import type { ProjectionState } from "./projection-types.js";

export class NestedProjectionBatchError extends Error {
  constructor() {
    super("ProjectionBatch must not contain a nested batch");
    this.name = "NestedProjectionBatchError";
  }
}

/**
 * Seeds a fresh {@link ProjectionState} from a `GetSnapshot` response (PR 44, PRD API-06).
 * Used both for the initial load and for a full resnapshot after an expired cursor.
 */
export function projectionStateFromSnapshot(snapshot: GetSnapshotResponse): ProjectionState {
  return {
    hosts: new Map(snapshot.hosts.map((entity) => [entity.id, entity])),
    repositories: new Map(snapshot.repositories.map((entity) => [entity.id, entity])),
    trees: new Map(snapshot.trees.map((entity) => [entity.id, entity])),
    nodes: new Map(snapshot.nodes.map((entity) => [entity.id, entity])),
    attention: new Map(snapshot.attention.map((entity) => [entity.nodeId, entity])),
    artifacts: new Map(snapshot.artifacts.map((entity) => [entity.artifactId, entity])),
    nodeOutcomes: new Map(snapshot.nodeOutcomes.map((entity) => [entity.nodeId, entity])),
    nodeCommands: new Map(),
    nodeAttention: new Map(),
  };
}

/**
 * Pure reducer applying one `ProjectionChange` to a {@link ProjectionState} (PR 44). Every arm
 * of the 12-case oneof is handled explicitly (`switch-exhaustiveness-check` enforces this at
 * lint time); a `batch` recurses over its `changes` but rejects a nested batch rather than
 * looping, mirroring the server's own `assertNoNestedBatches` in
 * packages/contracts/src/projection-change.ts.
 */
export function applyProjectionChange(
  state: ProjectionState,
  change: ProjectionChange,
  options?: { readonly allowBatch?: boolean },
): ProjectionState {
  const allowBatch = options?.allowBatch ?? true;
  switch (change.change.case) {
    case "hostUpserted": {
      const value = change.change.value;
      return { ...state, hosts: withSet(state.hosts, value.id, value) };
    }
    case "repositoryUpserted": {
      const value = change.change.value;
      return { ...state, repositories: withSet(state.repositories, value.id, value) };
    }
    case "treeUpserted": {
      const value = change.change.value;
      return { ...state, trees: withSet(state.trees, value.id, value) };
    }
    case "nodeUpserted": {
      const value = change.change.value;
      return { ...state, nodes: withSet(state.nodes, value.id, value) };
    }
    case "attentionUpserted": {
      const value = change.change.value;
      return { ...state, attention: withSet(state.attention, value.nodeId, value) };
    }
    case "removed": {
      const value = change.change.value;
      return withRemoval(state, value.aggregateKind, value.aggregateId);
    }
    case "attentionRemoved": {
      const value = change.change.value;
      return { ...state, attention: withDelete(state.attention, value.nodeId) };
    }
    case "batch": {
      if (!allowBatch) {
        throw new NestedProjectionBatchError();
      }
      let next = state;
      for (const nested of change.change.value.changes) {
        next = applyProjectionChange(next, nested, { allowBatch: false });
      }
      return next;
    }
    case "nodeCommandUpserted": {
      const value = change.change.value;
      return { ...state, nodeCommands: withSet(state.nodeCommands, value.commandId, value) };
    }
    case "nodeAttentionUpserted": {
      const value = change.change.value;
      return { ...state, nodeAttention: withSet(state.nodeAttention, value.id, value) };
    }
    case "artifactUpserted": {
      const value = change.change.value;
      return { ...state, artifacts: withSet(state.artifacts, value.artifactId, value) };
    }
    case "nodeOutcomeUpserted": {
      const value = change.change.value;
      return { ...state, nodeOutcomes: withSet(state.nodeOutcomes, value.nodeId, value) };
    }
    case undefined:
      return state;
  }
}

function withSet<V>(map: ReadonlyMap<string, V>, id: string, value: V): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(id, value);
  return next;
}

function withDelete<V>(map: ReadonlyMap<string, V>, id: string): ReadonlyMap<string, V> {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

function withRemoval(
  state: ProjectionState,
  aggregateKind: AggregateKind,
  aggregateId: string,
): ProjectionState {
  switch (aggregateKind) {
    case AggregateKind.REPOSITORY:
      return { ...state, repositories: withDelete(state.repositories, aggregateId) };
    case AggregateKind.TREE:
      return { ...state, trees: withDelete(state.trees, aggregateId) };
    case AggregateKind.NODE:
      return { ...state, nodes: withDelete(state.nodes, aggregateId) };
    case AggregateKind.ATTEMPT:
    case AggregateKind.UNSPECIFIED:
      return state;
  }
}
