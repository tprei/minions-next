import type {
  AttemptId,
  GitSha,
  HostId,
  RepositoryId,
  TaskNodeId,
  TaskTreeId,
  Timestamp,
} from "./value-objects.js";

import type { FencingToken } from "./scheduler.js";

export type WorkspaceState = "creating" | "ready" | "cleanup_pending" | "cleaned" | "failed";

export type WorkspaceReceipt = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  hostId: HostId;
  repositoryId: RepositoryId;
  workspacePath: string;
  sourcePath: string;
  branchName: string;
  baseCommit: GitSha;
  headCommit: GitSha;
  state: WorkspaceState;
  createdAt: Timestamp;
  readyAt: Timestamp | undefined;
  cleanupRequestedAt: Timestamp | undefined;
  cleanedAt: Timestamp | undefined;
  mutationFencingToken: FencingToken;
  failureCode: string | undefined;
  version: number;
}>;

export type WorkspaceStatus = Readonly<{
  attemptId: AttemptId;
  headCommit: GitSha;
  porcelainV2: Uint8Array;
  diff: Uint8Array;
  capturedAt: Timestamp;
}>;
