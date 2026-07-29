import type {
  Artifact,
  AttentionSummary,
  HostSummary,
  NodeAttention,
  NodeCommand,
  NodeOutcome,
  NodeSummary,
  RepositorySummary,
  TreeSummary,
} from "@minions/contracts";

/**
 * Normalized projection state (PR 44 — browser-projection-store).
 *
 * Every entity keeps its generated wire type verbatim (`HostSummary`, `TreeSummary`, ...) —
 * this module never hand-writes a duplicate shape for something the server already generates.
 * Maps are keyed by each entity's own identity field; `attention` is keyed by `nodeId` (its
 * proto's natural key, per event.proto's `AttentionSummary`).
 */
export interface ProjectionState {
  readonly hosts: ReadonlyMap<string, HostSummary>;
  readonly repositories: ReadonlyMap<string, RepositorySummary>;
  readonly trees: ReadonlyMap<string, TreeSummary>;
  readonly nodes: ReadonlyMap<string, NodeSummary>;
  readonly attention: ReadonlyMap<string, AttentionSummary>;
  readonly artifacts: ReadonlyMap<string, Artifact>;
  readonly nodeOutcomes: ReadonlyMap<string, NodeOutcome>;
  readonly nodeCommands: ReadonlyMap<string, NodeCommand>;
  readonly nodeAttention: ReadonlyMap<string, NodeAttention>;
}

export function emptyProjectionState(): ProjectionState {
  return {
    hosts: new Map(),
    repositories: new Map(),
    trees: new Map(),
    nodes: new Map(),
    attention: new Map(),
    artifacts: new Map(),
    nodeOutcomes: new Map(),
    nodeCommands: new Map(),
    nodeAttention: new Map(),
  };
}
