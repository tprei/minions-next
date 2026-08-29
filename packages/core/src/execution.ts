/**
 * Execution coordinator domain (PR 23).
 *
 * Pure domain types + helpers for the local node-execution pipeline. This module
 * composes existing value objects and ports (`HarnessAdapter`, `SandboxLifecycle`,
 * `SchedulerStore`, `VcsBackend`, `ArtifactRegistry`) into the self-contained
 * context pack, transcript chunk, attempt checkpoint, and outcome vocabulary used
 * by the coordinator. It performs NO I/O and imports no `node:` modules; the
 * SHA-256 digest is injected as a {@link DigestFunction} so reproducibility
 * (REC-03..06) stays deterministic without pulling a crypto dependency into core.
 */
import { DomainError } from "./domain-error.js";
import type {
  ActorSessionId,
  ArtifactId,
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
import type { Clock, IdGenerator } from "./ports.js";
import type {
  HarnessAdapter,
  HarnessAttemptContext,
  HarnessEvent,
  HarnessEventPayload,
  HarnessHandshake,
  HarnessSessionIdentity,
  HarnessUsage,
} from "./harness.js";
import type {
  SandboxBackendKind,
  SandboxInstance,
  SandboxLifecycle,
  SandboxPolicy,
  SandboxPolicyFingerprint,
} from "./sandbox.js";
import type { ArtifactRegistry, RecordedNodeOutcome } from "./artifact.js";
import type {
  SchedulerCapacityPolicy,
  SchedulerLease,
  SchedulerOwnerId,
  SchedulerStore,
} from "./scheduler.js";
import type { VcsBackend } from "./vcs-backend.js";

/**
 * Pure SHA-256-style digest over UTF-8 bytes. Injected (never imported from
 * `node:crypto` in core) so the same canonical text always yields the same
 * {@link ContentHash}.
 */
export type DigestFunction = (utf8: string) => ContentHash;

// -------------------------------------------------------------------------------------------------
// Context pack (REC-03..06 — deterministic, stable digest).
// -------------------------------------------------------------------------------------------------

/** Tree/plan context surrounding a node, captured for reproducibility. */
export type NodePlanContext = Readonly<{
  planGoal: NonEmptyText;
  parentGoal: string | undefined;
  /** Ordered summaries of completed sibling nodes (oldest first). */
  siblingSummaries: readonly string[];
}>;

/** The working copy the node operates over. */
export type NodeWorkspaceContext = Readonly<{
  repositoryId: RepositoryId;
  hostId: HostId;
  workspacePath: string;
  baseCommit: GitSha;
  headCommit: GitSha;
}>;

/** Tool surface exposed to the harness (recorded per attempt, REC-04). */
export type NodeToolsContext = Readonly<{
  /** Tools the harness advertised in its handshake. */
  allowedTools: readonly string[];
  toolPolicy: Readonly<{
    allowedExecutables: readonly string[];
    allowedGitSubcommands: readonly string[];
    blockedGitSubcommands: readonly string[];
  }>;
}>;

/** Recorded policy surface (REC-04: capabilities/tools/policy per attempt). */
export type NodePolicyContext = Readonly<{
  securityPolicyDigest: ContentHash;
  sandboxPolicyFingerprint: SandboxPolicyFingerprint;
}>;

/** Recorded model surface. */
export type NodeModelContext = Readonly<{
  model: string;
  reasoningLevel: string;
}>;

/**
 * Fully-resolved, deterministic input for a {@link ContextPack}. Every field is
 * time-invariant: the same node + plan + handshake always yields the same input,
 * hence the same digest.
 */
export type ContextPackInput = Readonly<{
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  attemptOrdinal: number;
  goal: NonEmptyText;
  plan: NodePlanContext;
  workspace: NodeWorkspaceContext;
  tools: NodeToolsContext;
  policy: NodePolicyContext;
  model: NodeModelContext;
}>;

/** The self-contained context pack rendered and sent to the harness. */
export type ContextPack = Readonly<{
  input: ContextPackInput;
  /** Stable digest over the canonical pack (REC-03..06). */
  digest: ContentHash;
}>;

/** Derive the tool surface from the sandbox policy + advertised handshake tools. */
export function nodeToolsContext(
  policy: SandboxPolicy,
  advertisedTools: readonly string[],
): NodeToolsContext {
  return Object.freeze({
    allowedTools: [...advertisedTools],
    toolPolicy: Object.freeze({
      allowedExecutables: [...policy.tools.allowedExecutables],
      allowedGitSubcommands: [...policy.tools.allowedGitSubcommands],
      blockedGitSubcommands: [...policy.tools.blockedGitSubcommands],
    }),
  });
}

/** Build a fully-resolved {@link ContextPackInput} from a request + handshake. */
export function buildContextPackInput(
  request: NodeExecutionRequest,
  handshake: HarnessHandshake,
): ContextPackInput {
  return Object.freeze({
    nodeId: request.context.nodeId,
    treeId: request.context.treeId,
    repositoryId: request.context.repositoryId,
    hostId: request.context.hostId,
    attemptOrdinal: request.context.attemptOrdinal,
    goal: request.goal,
    plan: request.plan,
    workspace: request.workspace,
    tools: nodeToolsContext(request.sandboxPolicy, handshake.tools),
    policy: Object.freeze({
      securityPolicyDigest: handshake.securityPolicyDigest,
      sandboxPolicyFingerprint: request.policyFingerprint,
    }),
    model: request.model,
  });
}

/**
 * Canonical, deterministic JSON for a context pack. Object keys are emitted in
 * sorted order and string collections are sorted, so byte-identical content is
 * guaranteed for the same logical pack regardless of construction order.
 */
export function canonicalContextPackJson(input: ContextPackInput): string {
  const document = {
    attemptOrdinal: input.attemptOrdinal,
    goal: input.goal,
    hostId: input.hostId,
    model: { model: input.model.model, reasoningLevel: input.model.reasoningLevel },
    nodeId: input.nodeId,
    plan: {
      parentGoal: input.plan.parentGoal ?? "",
      planGoal: input.plan.planGoal,
      siblingSummaries: [...input.plan.siblingSummaries].sort(),
    },
    policy: {
      sandboxPolicyFingerprint: {
        digest: input.policy.sandboxPolicyFingerprint.digest,
        policyVersion: input.policy.sandboxPolicyFingerprint.policyVersion,
      },
      securityPolicyDigest: input.policy.securityPolicyDigest,
    },
    repositoryId: input.repositoryId,
    tools: {
      allowedTools: [...input.tools.allowedTools].sort(),
      toolPolicy: {
        allowedExecutables: [...input.tools.toolPolicy.allowedExecutables].sort(),
        allowedGitSubcommands: [...input.tools.toolPolicy.allowedGitSubcommands].sort(),
        blockedGitSubcommands: [...input.tools.toolPolicy.blockedGitSubcommands].sort(),
      },
    },
    treeId: input.treeId,
    workspace: {
      baseCommit: input.workspace.baseCommit,
      headCommit: input.workspace.headCommit,
      hostId: input.workspace.hostId,
      repositoryId: input.workspace.repositoryId,
      workspacePath: input.workspace.workspacePath,
    },
  };
  return JSON.stringify(document);
}

/** Compute the stable digest over a context pack input. */
export function computeContextPackDigest(
  input: ContextPackInput,
  digest: DigestFunction,
): ContentHash {
  return digest(canonicalContextPackJson(input));
}

/** Render a deterministic {@link ContextPack} (input + computed digest). */
export function renderContextPack(input: ContextPackInput, digest: DigestFunction): ContextPack {
  return Object.freeze({ input, digest: computeContextPackDigest(input, digest) });
}

// -------------------------------------------------------------------------------------------------
// Transcript chunk (HAR-05 — stable sequence ordering).
// -------------------------------------------------------------------------------------------------

/** A streamed {@link HarnessEvent} persisted with stable sequence ordering. */
export type TranscriptChunk = Readonly<{
  attemptId: AttemptId;
  sequence: bigint;
  occurredAt: Timestamp;
  payload: HarnessEventPayload;
}>;

/** Project a harness event into a persistable transcript chunk. */
export function toTranscriptChunk(attemptIdValue: AttemptId, event: HarnessEvent): TranscriptChunk {
  return Object.freeze({
    attemptId: attemptIdValue,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
}

// -------------------------------------------------------------------------------------------------
// Attempt checkpoint (durable progress marker for resume).
// -------------------------------------------------------------------------------------------------

/** Coordinator phase captured by a checkpoint. */
export type NodeExecutionPhase =
  | "claimed"
  | "sandbox_created"
  | "workspace_prepared"
  | "harness_started"
  | "context_sent"
  | "streaming"
  | "finalizing";

/** Stable harness + sandbox identity snapshot persisted for resume (HAR-01). */
export type AttemptCheckpointIdentity = Readonly<{
  harnessIdentity: HarnessSessionIdentity;
  sandboxInstanceId: string;
  sandboxBackendKind: SandboxBackendKind;
  sandboxPolicyDigest: ContentHash;
  sandboxState: SandboxInstance["state"];
}>;

/**
 * Durable progress marker. Carries enough to resume ONLY the affected node after
 * a harness/daemon kill: the last persisted transcript sequence, the stable
 * harness identity + sandbox instance to re-bind, and the context digest.
 */
export type AttemptCheckpoint = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  sequence: bigint;
  phase: NodeExecutionPhase;
  identity: AttemptCheckpointIdentity;
  contextDigest: ContentHash;
  recordedAt: Timestamp;
}>;

// -------------------------------------------------------------------------------------------------
// Outcome + result.
// -------------------------------------------------------------------------------------------------

export type NodeOutcomeKind = "succeeded" | "failed" | "cancelled";

/** A reference to an artifact produced during the attempt. */
export type ArtifactRef = Readonly<{
  artifactId: ArtifactId;
  contentDigest: ContentHash;
}>;

/** Coordinator-level outcome for a node attempt. */
export type NodeOutcome = Readonly<{
  nodeId: TaskNodeId;
  attemptId: AttemptId;
  kind: NodeOutcomeKind;
  text: string;
  artifacts: readonly ArtifactRef[];
  /** New head revision for file-change nodes; `undefined` otherwise. */
  revision: GitSha | undefined;
  usage: HarnessUsage;
}>;

/** Summary of the persisted transcript for a completed attempt. */
export type TranscriptSummary = Readonly<{
  firstSequence: bigint;
  lastSequence: bigint;
  chunkCount: number;
}>;

/**
 * Which success shape a completed attempt resolved to; `undefined` when the
 * attempt did not succeed (failed/cancelled). Public so a caller that defers
 * outcome recording (see {@link ExecutionCoordinator.runNode}'s `options`) can
 * later hand the result back to {@link ExecutionCoordinator.recordDeferredOutcome}
 * without the coordinator re-deriving it.
 */
export type NodeExecutionSuccessKind = "commit" | "artifact" | "no_change";

/** The full result of a node execution attempt. */
export type NodeExecutionResult = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  outcome: NodeOutcome;
  successKind: NodeExecutionSuccessKind | undefined;
  transcript: TranscriptSummary;
  checkpoints: Readonly<{ initial: AttemptCheckpoint; final: AttemptCheckpoint }>;
  contextDigest: ContentHash;
  recordedAt: Timestamp;
}>;

// -------------------------------------------------------------------------------------------------
// Request + validation.
// -------------------------------------------------------------------------------------------------

/** Inputs the coordinator needs to record a node outcome via the registry. */
export type NodeOutcomeRecording = Readonly<{
  actorSessionId: ActorSessionId;
  /** Node version the coordinator observed when claiming the lease. */
  expectedNodeVersion: number | undefined;
}>;

/** Request to run a single node attempt end to end. */
export type NodeExecutionRequest = Readonly<{
  context: HarnessAttemptContext;
  lease: SchedulerLease;
  ownerId: SchedulerOwnerId;
  leaseDurationMs: number;
  capacity: SchedulerCapacityPolicy;
  durableHarnessId: string;
  goal: NonEmptyText;
  plan: NodePlanContext;
  workspace: NodeWorkspaceContext;
  sandboxPolicy: SandboxPolicy;
  policyFingerprint: SandboxPolicyFingerprint;
  model: NodeModelContext;
  recording: NodeOutcomeRecording;
}>;

/** Fail-closed validation of an execution request. */
export function validateNodeExecutionRequest(request: NodeExecutionRequest): void {
  if (request.context.attemptId.length === 0) {
    throw new DomainError("invalid_value", "execution request attempt id is required");
  }
  if (request.ownerId.length === 0) {
    throw new DomainError("invalid_value", "execution request owner id is required");
  }
  if (!Number.isSafeInteger(request.leaseDurationMs) || request.leaseDurationMs <= 0) {
    throw new DomainError("invalid_value", "execution request lease duration must be positive");
  }
  if (
    !Number.isSafeInteger(request.capacity.maxActiveGlobal) ||
    request.capacity.maxActiveGlobal <= 0 ||
    !Number.isSafeInteger(request.capacity.maxActivePerTree) ||
    request.capacity.maxActivePerTree <= 0
  ) {
    throw new DomainError("invalid_value", "execution request capacity policy must be positive");
  }
  if (request.durableHarnessId.length === 0) {
    throw new DomainError("invalid_value", "execution request durable harness id is required");
  }
  if (request.goal.length === 0) {
    throw new DomainError("invalid_value", "execution request goal is required");
  }
  if (request.plan.planGoal.length === 0) {
    throw new DomainError("invalid_value", "execution request plan goal is required");
  }
  if (request.workspace.workspacePath.length === 0) {
    throw new DomainError("invalid_value", "execution request workspace path is required");
  }
  if (request.recording.actorSessionId.length === 0) {
    throw new DomainError("invalid_value", "execution request actor session id is required");
  }
  if (
    request.recording.expectedNodeVersion !== undefined &&
    !Number.isSafeInteger(request.recording.expectedNodeVersion)
  ) {
    throw new DomainError(
      "invalid_value",
      "execution request expected node version must be an integer",
    );
  }
}

// -------------------------------------------------------------------------------------------------
// Stores (ports — implementations live in adapters).
// -------------------------------------------------------------------------------------------------

/** Append-only transcript store keyed by attempt, ordered by stable sequence. */
export interface TranscriptStore {
  /** Persist a chunk; idempotent for an already-stored identical sequence. */
  append(chunk: TranscriptChunk): Promise<void>;
  /** Persist many chunks in one crash-safe transaction. */
  appendAll(chunks: readonly TranscriptChunk[]): Promise<void>;
  /** Replay chunks strictly after a sequence (resume replay). */
  readAfter(attemptId: AttemptId, afterSequence: bigint): Promise<readonly TranscriptChunk[]>;
  /** Replay every chunk for an attempt. */
  readAll(attemptId: AttemptId): Promise<readonly TranscriptChunk[]>;
  /** Highest persisted sequence for an attempt (`0n` when none). */
  latestSequence(attemptId: AttemptId): Promise<bigint>;
}

/** Latest-checkpoint store keyed by attempt; idempotent, monotonic writes. */
export interface CheckpointStore {
  /** Record the latest checkpoint for an attempt (idempotent, monotonic). */
  record(checkpoint: AttemptCheckpoint): Promise<void>;
  /** Read the latest checkpoint for an attempt (`undefined` when none). */
  latest(attemptId: AttemptId): Promise<AttemptCheckpoint | undefined>;
}

// -------------------------------------------------------------------------------------------------
// Error + coordinator interface.
// -------------------------------------------------------------------------------------------------

export type ExecutionCoordinatorErrorCode =
  | "not_leased"
  | "sandbox_unavailable"
  | "harness_unavailable"
  | "policy_violation"
  | "checkpoint_failed"
  | "transcript_failed"
  | "outcome_failed"
  | "interrupted";

/** Typed coordinator error. Fail-closed: every port failure surfaces one. */
export class ExecutionCoordinatorError extends Error {
  readonly code: ExecutionCoordinatorErrorCode;
  readonly attemptId: AttemptId | undefined;

  constructor(code: ExecutionCoordinatorErrorCode, message: string, attemptIdValue?: AttemptId) {
    super(message);
    this.name = "ExecutionCoordinatorError";
    this.code = code;
    this.attemptId = attemptIdValue;
  }
}

/** Minimal structured logger the coordinator logs lifecycle events to. */
export type ExecutionCoordinatorLogger = Readonly<{
  log(
    level: "info" | "warn" | "error",
    event: string,
    fields?: Readonly<Record<string, string | number | boolean | null>>,
  ): void;
}>;

/** Ports the execution coordinator composes. None are concrete adapters. */
export type ExecutionCoordinatorPorts = Readonly<{
  scheduler: SchedulerStore;
  sandbox: SandboxLifecycle;
  harness: HarnessAdapter;
  vcs: VcsBackend;
  artifacts: ArtifactRegistry;
  transcripts: TranscriptStore;
  checkpoints: CheckpointStore;
  clock: Clock;
  ids: IdGenerator;
  logger: ExecutionCoordinatorLogger;
}>;

/**
 * Connects scheduling, sandbox, harness, VCS, artifacts, transcripts, and
 * checkpoints into a single local node run. The coordinator depends only on
 * ports — the OMP adapter and concrete sandbox are injected, never imported.
 */
export interface ExecutionCoordinator {
  /**
   * Run a node attempt end to end (claim → sandbox → harness → outcome).
   *
   * `options.deferOutcomeRecording`: when `true`, a successful attempt's
   * outcome is resolved and returned but NOT durably recorded — the node
   * stays ineligible-for-children/not-`succeeded` until the caller explicitly
   * calls {@link recordDeferredOutcome}. A failed/cancelled attempt is
   * unaffected (nothing is recorded for those either way). Used by callers
   * that must gate a result (e.g. bounded repair-retry) before the success
   * becomes visible to the scheduler/tree — recording success before that
   * gate runs is a fail-open hole (a node the gate would reject is already
   * `succeeded` and unblocking children).
   */
  runNode(
    request: NodeExecutionRequest,
    options?: Readonly<{ deferOutcomeRecording?: boolean }>,
  ): Promise<NodeExecutionResult>;
  /** Interrupt an in-flight attempt: cancelled outcome, lease released, sandbox destroyed. */
  interrupt(attemptId: AttemptId): Promise<NodeExecutionResult>;
  /**
   * Durably record a `result` previously returned by `runNode` with
   * `deferOutcomeRecording: true`. No-ops if `result.successKind` is
   * `undefined` (the attempt did not succeed — nothing to record). Callers
   * MUST call this AT MOST ONCE per deferred `result`: it is not verified
   * idempotent against the underlying artifact registry's optimistic
   * concurrency check (`expectedNodeVersion`), so a second call for the same
   * node may be rejected as a version conflict rather than no-op.
   */
  recordDeferredOutcome(request: NodeExecutionRequest, result: NodeExecutionResult): Promise<void>;
  /**
   * Resume an attempt from a checkpoint. Re-binds the SAME harness identity +
   * sandbox instance (HAR-01) and replays from the checkpoint sequence, resuming
   * ONLY the affected node (siblings' transcripts/workspaces/usage untouched).
   *
   * The caller re-supplies the request: after a daemon restart the request is
   * re-derived from the durable plan/workspace registries (it cannot live in the
   * checkpoint without duplicating that state).
   */
  resumeFromCheckpoint(
    checkpoint: AttemptCheckpoint,
    request: NodeExecutionRequest,
  ): Promise<NodeExecutionResult>;
}

/** Re-export the recorded-outcome vocabulary the coordinator maps onto. */
export type { RecordedNodeOutcome };
