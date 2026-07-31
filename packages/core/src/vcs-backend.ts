/**
 * `VcsBackend` is the reversible, VCS-generic seam behind which native Git
 * (today) and a future engine (later) sit. It is a pure domain port: no I/O,
 * no engine-specific names. Every operation composes the existing domain value
 * objects so no domain type changes when an implementation is swapped.
 *
 * Native Git implements this port via branch/rev-list/rebase/ls-files/push; the
 * generic terms (`bookmark`, `change`, `restack`) are the VCS vocabulary every
 * implementation must satisfy.
 */
import type {
  AttemptId,
  ContentHash,
  GitSha,
  HostId,
  NonEmptyText,
  RepositoryId,
  TaskNodeId,
  TaskTreeId,
  Timestamp,
} from "./value-objects.js";
import type { WorkspaceReceipt, WorkspaceStatus } from "./workspace.js";

/** Identifies a working copy by its owning attempt. */
export type VcsWorkingCopyRef = Readonly<{
  attemptId: AttemptId;
}>;

/**
 * Request a working copy checked out at a base commit. Mirrors the existing
 * workspace-creation input so the native implementation can delegate unchanged.
 */
export type CreateWorkingCopyAtCommitInput = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  hostId: HostId;
  repositoryId: RepositoryId;
  ordinal: number;
  baseCommit?: GitSha;
  sourcePath?: string;
  sourceAttemptId?: AttemptId;
}>;

/** The textual diff of uncommitted working-copy changes against its head. */
export type VcsDiff = Readonly<{
  attemptId: AttemptId;
  headCommit: GitSha;
  diff: Uint8Array;
  capturedAt: Timestamp;
}>;

/** Commit the staged working-copy changes, producing a new head. */
export type VcsCommitInput = Readonly<{
  attemptId: AttemptId;
  message: NonEmptyText;
  authorName?: NonEmptyText;
  authorEmail?: NonEmptyText;
}>;

/** A change whose descendants should be enumerated or restacked. */
export type VcsDescendantsInput = Readonly<{
  attemptId: AttemptId;
  /** The commit whose descendants are requested. */
  change: GitSha;
  /** Optional upper bound on the number of descendants returned. */
  limit?: number;
}>;

/** The descendants of a change, newest first. */
export type VcsDescendants = Readonly<{
  attemptId: AttemptId;
  change: GitSha;
  descendants: readonly GitSha[];
}>;

/** Restack a change's descendants onto a new parent. */
export type VcsRestackInput = Readonly<{
  attemptId: AttemptId;
  /** The change whose descendants are rebased. */
  change: GitSha;
  /** The new parent the descendants are rebased onto. */
  ontoParent: GitSha;
}>;

/** Whether a working copy is in a conflicted (unmerged) state. */
export type VcsConflictState = Readonly<{
  attemptId: AttemptId;
  inConflict: boolean;
  unmergedPaths: readonly string[];
}>;

/** Push a bookmark (branch) to a remote. */
export type VcsPushBookmarkInput = Readonly<{
  attemptId: AttemptId;
  bookmark: NonEmptyText;
  remote?: string;
  force?: boolean;
}>;

/** The mutating operation a {@link VcsOperationReceipt} describes. */
export type VcsOperationKind = "commit" | "restack" | "push_bookmark";

/**
 * A deterministic, content-addressed receipt for a mutating operation. The
 * `contentHash` is a stable digest over the operation's inputs and observed
 * outputs so a replay of the same operation yields the same receipt.
 */
export type VcsOperationReceipt = Readonly<{
  operation: VcsOperationKind;
  contentHash: ContentHash;
  attemptId: AttemptId;
  recordedAt: Timestamp;
}>;

/** Receipt for {@link VcsBackend.commit}. */
export type VcsCommitReceipt = Readonly<{
  receipt: VcsOperationReceipt;
  parentCommit: GitSha;
  headCommit: GitSha;
}>;

/** Receipt for {@link VcsBackend.restack}. */
export type VcsRestackReceipt = Readonly<{
  receipt: VcsOperationReceipt;
  rebasedHead: GitSha;
  conflicts: boolean;
}>;

/** Receipt for {@link VcsBackend.pushBookmark}. */
export type VcsPushReceipt = Readonly<{
  receipt: VcsOperationReceipt;
  bookmark: NonEmptyText;
  remote: string;
  pushedCommit: GitSha;
}>;

export type VcsBackendErrorCode =
  "invalid_input" | "not_found" | "git_failed" | "conflict" | "output_limit";

/** Error raised by a {@link VcsBackend} implementation. */
export class VcsBackendError extends Error {
  readonly code: VcsBackendErrorCode;

  constructor(code: VcsBackendErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VcsBackendError";
    this.code = code;
  }
}

/**
 * The VCS-generic port. Implementations carry the engine (native Git today);
 * domain code depends only on this surface so the engine can be swapped without
 * touching domain logic.
 */
export interface VcsBackend {
  /** Create a working copy checked out at a base commit (lifecycle). */
  createWorkingCopyAtCommit(input: CreateWorkingCopyAtCommitInput): Promise<WorkspaceReceipt>;

  /** Capture porcelain status plus the head diff for a working copy. */
  captureStatus(input: VcsWorkingCopyRef): Promise<WorkspaceStatus>;

  /** Capture only the textual working-copy diff against its head. */
  captureDiff(input: VcsWorkingCopyRef): Promise<VcsDiff>;

  /** Stage and commit working-copy changes, returning the new head. */
  commit(input: VcsCommitInput): Promise<VcsCommitReceipt>;

  /** Resolve the current head commit of a working copy. */
  resolveHead(input: VcsWorkingCopyRef): Promise<GitSha>;

  /** Enumerate the descendants of a change, newest first. */
  enumerateDescendants(input: VcsDescendantsInput): Promise<VcsDescendants>;

  /** Restack a change's descendants onto a new parent. */
  restack(input: VcsRestackInput): Promise<VcsRestackReceipt>;

  /** Report whether a working copy is in a conflicted (unmerged) state. */
  conflictState(input: VcsWorkingCopyRef): Promise<VcsConflictState>;

  /** Push a bookmark (branch) to a remote. */
  pushBookmark(input: VcsPushBookmarkInput): Promise<VcsPushReceipt>;

  /** Release a working copy (lifecycle). */
  cleanup(input: VcsWorkingCopyRef): Promise<WorkspaceReceipt>;

  /** Recover interrupted working copies (lifecycle). */
  recover(): Promise<readonly WorkspaceReceipt[]>;
}
