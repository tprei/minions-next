/**
 * VCS change binding domain (PR 29).
 *
 * A {@link VcsChangeBinding} is the durable identity link between a Minions
 * (tree, node) identity and its jj change identity. Making node identity equal
 * jj change identity is what lets a commit node survive arbitrary rewrites:
 * rewrites advance `rewriteGeneration` and refresh `currentCommitId`, but the
 * composite key (treeId, nodeId) — and therefore the change it represents —
 * never moves (GIT-02). Orphan and duplicate bindings fail closed (GIT-16).
 *
 * This module is pure: no I/O. The SQLite implementation lives in the adapters
 * package (`createSqliteVcsChangeBindingStore`).
 */
import {
  contentHash,
  gitSha,
  taskNodeId,
  taskTreeId,
  type ContentHash,
  type GitSha,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
} from "./value-objects.js";

// -------------------------------------------------------------------------------------------------
// Value shapes.
// -------------------------------------------------------------------------------------------------

/** Monotonically non-decreasing rewrite counter for a binding. Always >= 0. */
export type RewriteGeneration = number;

/** Lifecycle conflict state of a node's jj change binding. */
export type ConflictState = "clean" | "conflict" | "resolved";

/**
 * Durable binding from a (tree, node) identity to its jj change identity. The
 * composite key (treeId, nodeId) maps to exactly one binding (GIT-02); the row
 * is rewritten in place as the change evolves, with `rewriteGeneration`
 * advancing monotonically and never decreasing (GIT-16).
 */
export type VcsChangeBinding = Readonly<{
  /** Tree the bound node belongs to (composite key part 1). */
  treeId: TaskTreeId;
  /** The node this binding belongs to (composite key part 2). Immutable. */
  nodeId: TaskNodeId;
  /** jj change id (64-hex) the node is bound to. */
  jjChangeId: ContentHash;
  /** Current commit the change points at (40- or 64-hex SHA). */
  currentCommitId: GitSha;
  /** Parent change id (64-hex). `undefined` for a root change. */
  parentChangeId: ContentHash | undefined;
  /** Optional bookmark/branch name. Non-empty when present. */
  bookmark: string | undefined;
  /** Number of rewrites applied to this change. Monotonic, >= 0. */
  rewriteGeneration: RewriteGeneration;
  /** Content-addressed id of the last jj operation that touched this binding. */
  lastJjOperationId: ContentHash;
  /** Last commit id that was pushed to a remote, if any. */
  lastPushedCommitId: GitSha | undefined;
  /** Last commit id that was reviewed, if any. */
  lastReviewedCommitId: GitSha | undefined;
  /** Current conflict lifecycle state. */
  conflictState: ConflictState;
  /** Epoch milliseconds the binding was last recorded. */
  recordedAt: Timestamp;
}>;

// -------------------------------------------------------------------------------------------------
// Storage port (implementation lives in adapters).
// -------------------------------------------------------------------------------------------------

export type VcsChangeBindingStoreErrorCode =
  "invalid_input" | "write_failed" | "corrupt" | "orphan_binding" | "duplicate_binding";

/** Typed binding-store error. Fail-closed: every invariant breach surfaces. */
export class VcsChangeBindingStoreError extends Error {
  readonly code: VcsChangeBindingStoreErrorCode;

  constructor(code: VcsChangeBindingStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VcsChangeBindingStoreError";
    this.code = code;
  }
}

/**
 * Durable store for {@link VcsChangeBinding}s, keyed by the composite
 * (treeId, nodeId) identity. Writes are crash-safe upserts; reads project rows
 * back into validated domain values. Orphan and duplicate bindings fail closed.
 */
export interface VcsChangeBindingStore {
  /** Insert or update a binding (idempotent on treeId + nodeId). */
  upsertBinding(binding: VcsChangeBinding): Promise<void>;
  /** The binding for a (tree, node), if any. */
  getBinding(treeId: TaskTreeId, nodeId: TaskNodeId): Promise<VcsChangeBinding | undefined>;
  /** The binding for a (tree, jj change), if any. */
  getByChangeId(treeId: TaskTreeId, jjChangeId: ContentHash): Promise<VcsChangeBinding | undefined>;
  /** Every binding for a tree. */
  listForTree(treeId: TaskTreeId): Promise<readonly VcsChangeBinding[]>;
  /** Fail closed if any binding references a node outside `knownNodeIds`. */
  assertNoOrphans(treeId: TaskTreeId, knownNodeIds: readonly TaskNodeId[]): Promise<void>;
  /** Fail closed if duplicate bindings exist (defensive; PK prevents node dupes). */
  assertNoDuplicates(treeId: TaskTreeId): Promise<void>;
}

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/** Conflict states recognized by the store, keyed by their persisted value. */
export const CONFLICT_STATES: Readonly<Record<string, ConflictState>> = Object.freeze({
  clean: "clean",
  conflict: "conflict",
  resolved: "resolved",
});

/**
 * Valid forward conflict-state transitions. A binding may stay in its current
 * state (idempotent re-record), move `clean -> conflict -> resolved`, drop a
 * conflict (`conflict -> clean`), or reset after resolution (`resolved -> clean`).
 */
const VALID_CONFLICT_TRANSITIONS: Readonly<
  Record<ConflictState, Readonly<Partial<Record<ConflictState, true>>>>
> = Object.freeze({
  clean: Object.freeze({ clean: true, conflict: true }),
  conflict: Object.freeze({ clean: true, conflict: true, resolved: true }),
  resolved: Object.freeze({ clean: true, resolved: true }),
});

/** Whether `from -> to` is an allowed conflict-state transition. Pure. */
export function isValidConflictTransition(from: ConflictState, to: ConflictState): boolean {
  return VALID_CONFLICT_TRANSITIONS[from][to] === true;
}

/**
 * Validate the structural shape of a binding before persistence. Throws on any
 * invariant breach; returns void otherwise. Pure: callers (the store) wrap the
 * thrown error into a typed {@link VcsChangeBindingStoreError}.
 */
export function validateVcsChangeBinding(binding: VcsChangeBinding): void {
  taskTreeId(binding.treeId);
  taskNodeId(binding.nodeId);
  contentHash(binding.jjChangeId);
  gitSha(binding.currentCommitId);
  if (binding.parentChangeId !== undefined) {
    contentHash(binding.parentChangeId);
  }
  if (binding.bookmark?.length === 0) {
    throw new Error("vcs change binding bookmark must be non-empty when present");
  }
  if (!Number.isSafeInteger(binding.rewriteGeneration) || binding.rewriteGeneration < 0) {
    throw new Error("vcs change binding rewriteGeneration must be a non-negative safe integer");
  }
  contentHash(binding.lastJjOperationId);
  if (binding.lastPushedCommitId !== undefined) {
    gitSha(binding.lastPushedCommitId);
  }
  if (binding.lastReviewedCommitId !== undefined) {
    gitSha(binding.lastReviewedCommitId);
  }
  if (CONFLICT_STATES[binding.conflictState] === undefined) {
    throw new Error(`unknown vcs change binding conflict state: ${binding.conflictState}`);
  }
  if (!Number.isSafeInteger(binding.recordedAt) || binding.recordedAt < 0) {
    throw new Error("vcs change binding recordedAt must be a non-negative safe integer");
  }
}

/**
 * Deterministic fingerprint over the mutable identity of a binding. Two
 * bindings with the same fingerprint represent the same change at the same
 * point in its lifecycle, which is what event-replay reconstruction compares.
 * Pure and stable across processes.
 */
export function bindingFingerprint(binding: VcsChangeBinding): string {
  return [
    binding.treeId,
    binding.nodeId,
    binding.jjChangeId,
    binding.currentCommitId,
    binding.parentChangeId ?? "",
    binding.bookmark ?? "",
    binding.rewriteGeneration,
    binding.lastJjOperationId,
    binding.lastPushedCommitId ?? "",
    binding.lastReviewedCommitId ?? "",
    binding.conflictState,
  ].join("\n");
}
