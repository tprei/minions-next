import { createHash } from "node:crypto";

import {
  actorSessionId,
  artifactId,
  attemptId,
  buildContextPackInput,
  computeContextPackDigest,
  contentHash,
  fencingToken,
  gitSha,
  hostId,
  nonEmptyText,
  repositoryId,
  schedulerCapacityPolicy,
  schedulerLeaseId,
  schedulerOwnerId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  ExecutionCoordinatorError,
  type ArtifactRecord,
  type AttemptId,
  type ContentHash,
  type CreateArtifactRequest,
  type CreateSandboxRequest,
  type CreateWorkingCopyAtCommitInput,
  type ExpectedBlob,
  type ExpiredSchedulerLeaseRecovery,
  type ExecuteSandboxRequest,
  type GitSha,
  type HeartbeatSchedulerLeaseRequest,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessEventPayload,
  type HarnessHandshake,
  type HarnessSession,
  type HarnessSessionIdentity,
  type HarnessSessionSnapshot,
  type JsonValue,
  type NodeExecutionRequest,
  type NodeOutcomeRecord,
  type RecordNodeOutcomeRequest,
  type ReleaseSchedulerLeaseRequest,
  type ResumeHarnessSessionRequest,
  type SandboxCapabilityProbe,
  type SandboxExecutionResult,
  type SandboxInstance,
  type SandboxLifecycle,
  type SandboxPolicy,
  type SandboxPolicyFingerprint,
  type SchedulerLease,
  type SchedulerLeaseId,
  type SchedulerStore,
  type StartHarnessSessionRequest,
  type TaskNodeId,
  type Timestamp,
  type VcsBackend,
  type VcsCommitInput,
  type VcsCommitReceipt,
  type VcsConflictState,
  type VcsDescendants,
  type VcsDiff,
  type VcsPushReceipt,
  type VcsRestackReceipt,
  type VcsWorkingCopyRef,
  type WorkspaceReceipt,
  type WorkspaceStatus,
} from "@minions/core";
import {
  createExecutionCoordinator,
  createSandboxPolicyFingerprinter,
  createSqliteCheckpointStore,
  createSqliteTranscriptStore,
} from "@minions/adapters";
import { createTestSandboxLifecycle, FixedClock, SequenceIdGenerator } from "@minions/testkit";
import type { TestSandboxLifecycle } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ArtifactRegistry,
  CheckpointStore,
  ExecutionCoordinator,
  TranscriptStore,
} from "@minions/core";

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const HOST_ID = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY_ID = repositoryId("01900000-0000-7000-8000-000000000002");
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000003");
const ACTOR_ID = actorSessionId("01900000-0000-7000-8000-000000000004");
const OWNER_ID = schedulerOwnerId("01900000-0000-7000-8000-000000000005");
const NODE_X = taskNodeId("01900000-0000-7000-8000-000000000006");
const DURABLE_HARNESS_ID = "durable-harness-0001";
const DEFAULT_HEAD = gitSha("a".repeat(40));
const ARTIFACT_REF_ID = artifactId("01900000-0000-7000-8000-000000000abc");
const ARTIFACT_REF_DIGEST = contentHash("d".repeat(64));
const SECURITY_POLICY_DIGEST = contentHash("e".repeat(64));
const EMPTY_BYTES = new Uint8Array();
const NOOP_LOGGER = Object.freeze({ log: () => undefined });

function id(value: number): string {
  return `01900000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function at(offset: number): Timestamp {
  return timestampFromEpochMilliseconds(BASE_TIME + offset);
}

function generatedIds(start: number, count = 1024): readonly string[] {
  return Array.from({ length: count }, (_, index) => id(start + index));
}

/** Distinct 40-hex sha derived from an integer (never collides with DEFAULT_HEAD). */
function commitSha(n: number): GitSha {
  const suffix = n.toString(16);
  return gitSha(`${"c".repeat(40 - suffix.length)}${suffix}`);
}

function sha256Digest(utf8: string): ContentHash {
  return contentHash(createHash("sha256").update(utf8).digest("hex"));
}

let idSeed = 0x100;
function freshAttempt(): AttemptId {
  idSeed += 1;
  return attemptId(id(idSeed));
}
function freshNode(): TaskNodeId {
  idSeed += 1;
  return taskNodeId(id(idSeed));
}
let leaseSeed = 0x3000;

// -------------------------------------------------------------------------------------------------
// Deterministic harness event payload builders.
// -------------------------------------------------------------------------------------------------

const message = (text: string): HarnessEventPayload => ({
  kind: "message",
  role: "assistant",
  text,
});
const thinking = (text: string): HarnessEventPayload => ({ kind: "thinking", text });
const usageEvent = (inputTokens: number, outputTokens: number): HarnessEventPayload => ({
  kind: "usage",
  usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
});
const toolCall = (callId: string, tool: string, input: JsonValue): HarnessEventPayload => ({
  kind: "tool_call",
  callId,
  tool,
  input,
});
const toolResult = (callId: string, output: JsonValue): HarnessEventPayload => ({
  kind: "tool_result",
  callId,
  output,
  failed: false,
});
const result = (
  outcome: "succeeded" | "failed" | "cancelled",
  text: string,
): HarnessEventPayload => ({ kind: "result", outcome, text });

const artifactOutput = (): JsonValue => ({
  artifactId: ARTIFACT_REF_ID,
  contentDigest: ARTIFACT_REF_DIGEST,
});

// -------------------------------------------------------------------------------------------------
// A deterministic in-process harness test double.
//
// The coordinator drives a harness through handshake -> start/resume -> prompt ->
// events(). This adapter scripts a stable event sequence (sequence 1..n) and supports
// three modes: complete (yield all events incl. the terminal result), crash (yield up
// to `crashAfterSequence`, then throw — simulating harness process death mid-stream),
// and block (yield the scripted events, then await interrupt() — modelling an
// in-flight session). One adapter binds one durable session identity (HAR-01).
// -------------------------------------------------------------------------------------------------

type ScriptedHarnessOptions = Readonly<{
  handshake: HarnessHandshake;
  payloads: readonly HarnessEventPayload[];
  sessionId: string;
  /** Throw when the stream would yield an event with sequence greater than this. */
  crashAfterSequence?: bigint;
  /** After yielding all scripted payloads, block until interrupt() is called. */
  blockUntilInterrupted?: boolean;
  /** When set, handshake() rejects (fail-closed harness-unavailable scenario). */
  handshakeError?: Error;
}>;

function identitiesEqual(a: HarnessSessionIdentity, b: HarnessSessionIdentity): boolean {
  return a.durableHarnessId === b.durableHarnessId && a.sessionId === b.sessionId;
}

class ScriptedHarnessSession implements HarnessSession {
  readonly identity: HarnessSessionIdentity;
  readonly #events: readonly HarnessEvent[];
  readonly #crashAfterSequence: bigint | undefined;
  readonly #blockUntilInterrupted: boolean;
  readonly #onBlocked: () => void;
  #releaseGate: (() => void) | undefined;
  #disposed = false;
  disposeCount = 0;

  constructor(
    identity: HarnessSessionIdentity,
    payloads: readonly HarnessEventPayload[],
    options: Pick<ScriptedHarnessOptions, "crashAfterSequence" | "blockUntilInterrupted">,
    onBlocked: () => void,
  ) {
    this.identity = identity;
    this.#events = payloads.map((payload, index) =>
      Object.freeze({ sequence: BigInt(index + 1), occurredAt: at(0), payload }),
    );
    this.#crashAfterSequence = options.crashAfterSequence;
    this.#blockUntilInterrupted = options.blockUntilInterrupted ?? false;
    this.#onBlocked = onBlocked;
  }

  async *events(afterSequence: bigint): AsyncIterable<HarnessEvent> {
    for (const event of this.#events) {
      if (event.sequence <= afterSequence) continue;
      if (this.#crashAfterSequence !== undefined && event.sequence > this.#crashAfterSequence) {
        throw new Error(`scripted harness crashed before event ${event.sequence.toString()}`);
      }
      yield event;
    }
    if (this.#blockUntilInterrupted) {
      this.#onBlocked();
      await new Promise<void>((resolve) => {
        this.#releaseGate = resolve;
      });
    }
  }

  prompt(): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  steer(): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  followUp(): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    this.ensureOpen();
    this.#releaseGate?.();
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.ensureOpen();
    this.#releaseGate?.();
    return Promise.resolve();
  }

  snapshot(): Promise<HarnessSessionSnapshot> {
    this.ensureOpen();
    return Promise.resolve(
      Object.freeze({
        identity: this.identity,
        nextEventSequence: BigInt(this.#events.length + 1),
        state: "running",
      }),
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.disposeCount += 1;
    this.#releaseGate?.();
  }

  private ensureOpen(): void {
    if (this.#disposed) {
      throw new Error("harness session is closed");
    }
  }
}

class ScriptedHarnessAdapter implements HarnessAdapter {
  readonly #options: ScriptedHarnessOptions;
  readonly whenBlocked: Promise<void>;
  #whenBlockedResolve: (() => void) | undefined;
  readonly startWorkspacePaths: (string | undefined)[] = [];
  readonly resumeWorkspacePaths: (string | undefined)[] = [];
  #session: ScriptedHarnessSession | undefined;
  get session(): ScriptedHarnessSession | undefined {
    return this.#session;
  }

  constructor(options: ScriptedHarnessOptions) {
    this.#options = options;
    this.whenBlocked = new Promise<void>((resolve) => {
      this.#whenBlockedResolve = resolve;
    });
  }

  handshake(): Promise<HarnessHandshake> {
    if (this.#options.handshakeError !== undefined) {
      return Promise.reject(this.#options.handshakeError);
    }
    return Promise.resolve(this.#options.handshake);
  }

  start(request: StartHarnessSessionRequest): Promise<HarnessSession> {
    this.startWorkspacePaths.push(request.workspacePath);
    return Promise.resolve(
      this.bind({ durableHarnessId: request.durableHarnessId, sessionId: this.#options.sessionId }),
    );
  }

  resume(request: ResumeHarnessSessionRequest): Promise<HarnessSession> {
    this.resumeWorkspacePaths.push(request.workspacePath);
    return Promise.resolve(this.bind(request.identity));
  }

  private bind(identity: HarnessSessionIdentity): ScriptedHarnessSession {
    if (this.#session === undefined) {
      this.#session = new ScriptedHarnessSession(
        identity,
        this.#options.payloads,
        this.#options,
        () => {
          this.#whenBlockedResolve?.();
        },
      );
      return this.#session;
    }
    if (!identitiesEqual(this.#session.identity, identity)) {
      throw new Error("scripted harness bound a different durable identity");
    }
    return this.#session;
  }
}

// -------------------------------------------------------------------------------------------------
// Focused fakes for the ports the coordinator composes but which are not themselves
// under test here (the scheduler, VCS, and artifact registry each have their own suites).
// -------------------------------------------------------------------------------------------------

class FakeSchedulerStore implements SchedulerStore {
  private readonly queue: SchedulerLease[] = [];
  private readonly byId = new Map<SchedulerLeaseId, SchedulerLease>();
  readonly releases: ReleaseSchedulerLeaseRequest[] = [];

  enqueue(lease: SchedulerLease): void {
    this.queue.push(lease);
    this.byId.set(lease.id, lease);
  }

  claimNext(): Promise<SchedulerLease | undefined> {
    return Promise.resolve(this.queue.shift());
  }

  heartbeat(request: HeartbeatSchedulerLeaseRequest): Promise<SchedulerLease> {
    const lease = this.byId.get(request.lease.id);
    if (lease === undefined) {
      return Promise.reject(new Error("fake scheduler heartbeat for unknown lease"));
    }
    return Promise.resolve(lease);
  }

  release(request: ReleaseSchedulerLeaseRequest): Promise<void> {
    this.releases.push(request);
    return Promise.resolve();
  }

  cancelNode(): Promise<void> {
    return Promise.resolve();
  }

  recoverExpired(): Promise<readonly ExpiredSchedulerLeaseRecovery[]> {
    return Promise.resolve([]);
  }
}

class FakeArtifactRegistry implements ArtifactRegistry {
  readonly outcomes = new Map<TaskNodeId, NodeOutcomeRecord>();
  readonly creates: CreateArtifactRequest[] = [];
  readonly calls: string[] = [];

  create(request: CreateArtifactRequest): Promise<ArtifactRecord> {
    this.creates.push(request);
    return Promise.reject(
      new Error("fake artifact registry create is not used by the coordinator"),
    );
  }

  get(): ArtifactRecord | undefined {
    return undefined;
  }

  list(): readonly ArtifactRecord[] {
    return [];
  }

  expectedBlobs(): readonly ExpectedBlob[] {
    return [];
  }

  recordOutcome(request: RecordNodeOutcomeRequest): Promise<NodeOutcomeRecord> {
    this.calls.push("recordOutcome");
    const record = Object.freeze({
      nodeId: request.nodeId,
      outcome: request.outcome,
      createdAt: request.at,
    });
    this.outcomes.set(request.nodeId, record);
    return Promise.resolve(record);
  }

  getOutcome(nodeId: TaskNodeId): NodeOutcomeRecord | undefined {
    return this.outcomes.get(nodeId);
  }
}

class FakeVcsBackend implements VcsBackend {
  private readonly heads = new Map<string, GitSha>();
  private readonly diffs = new Map<string, Uint8Array>();
  readonly commits: Readonly<{ attemptId: AttemptId; headCommit: GitSha }>[] = [];
  readonly workspaces: CreateWorkingCopyAtCommitInput[] = [];
  private nextCommitOrdinal = 0;

  setDiff(attemptIdValue: AttemptId, diff: Uint8Array): void {
    this.diffs.set(attemptIdValue, diff);
  }

  createWorkingCopyAtCommit(input: CreateWorkingCopyAtCommitInput): Promise<WorkspaceReceipt> {
    this.workspaces.push(input);
    const base = input.baseCommit ?? DEFAULT_HEAD;
    this.heads.set(input.attemptId, base);
    return Promise.resolve(workspaceReceipt(input, base));
  }

  captureStatus(ref: VcsWorkingCopyRef): Promise<WorkspaceStatus> {
    const head = this.heads.get(ref.attemptId) ?? DEFAULT_HEAD;
    return Promise.resolve(
      Object.freeze({
        attemptId: ref.attemptId,
        headCommit: head,
        porcelainV2: EMPTY_BYTES,
        diff: this.diffs.get(ref.attemptId) ?? EMPTY_BYTES,
        capturedAt: at(0),
      }),
    );
  }

  captureDiff(ref: VcsWorkingCopyRef): Promise<VcsDiff> {
    const head = this.heads.get(ref.attemptId) ?? DEFAULT_HEAD;
    return Promise.resolve(
      Object.freeze({
        attemptId: ref.attemptId,
        headCommit: head,
        diff: this.diffs.get(ref.attemptId) ?? EMPTY_BYTES,
        capturedAt: at(0),
      }),
    );
  }

  commit(input: VcsCommitInput): Promise<VcsCommitReceipt> {
    const parent = this.heads.get(input.attemptId) ?? DEFAULT_HEAD;
    const head = commitSha(this.nextCommitOrdinal);
    this.nextCommitOrdinal += 1;
    this.heads.set(input.attemptId, head);
    this.diffs.set(input.attemptId, EMPTY_BYTES);
    this.commits.push(Object.freeze({ attemptId: input.attemptId, headCommit: head }));
    return Promise.resolve(
      Object.freeze({
        receipt: Object.freeze({
          operation: "commit",
          contentHash: contentHash("0".repeat(64)),
          attemptId: input.attemptId,
          recordedAt: at(0),
        }),
        parentCommit: parent,
        headCommit: head,
      }),
    );
  }

  resolveHead(ref: VcsWorkingCopyRef): Promise<GitSha> {
    return Promise.resolve(this.heads.get(ref.attemptId) ?? DEFAULT_HEAD);
  }

  enumerateDescendants(): Promise<VcsDescendants> {
    return Promise.reject(
      new Error("fake vcs enumerateDescendants is not used by the coordinator"),
    );
  }

  restack(): Promise<VcsRestackReceipt> {
    return Promise.reject(new Error("fake vcs restack is not used by the coordinator"));
  }

  conflictState(ref: VcsWorkingCopyRef): Promise<VcsConflictState> {
    return Promise.resolve(
      Object.freeze({ attemptId: ref.attemptId, inConflict: false, unmergedPaths: [] }),
    );
  }

  pushBookmark(): Promise<VcsPushReceipt> {
    return Promise.reject(new Error("fake vcs pushBookmark is not used by the coordinator"));
  }

  cleanup(ref: VcsWorkingCopyRef): Promise<WorkspaceReceipt> {
    return Promise.resolve(
      workspaceReceipt(
        fallbackWorkspaceInput(ref.attemptId),
        this.heads.get(ref.attemptId) ?? DEFAULT_HEAD,
      ),
    );
  }

  recover(): Promise<readonly WorkspaceReceipt[]> {
    return Promise.resolve([]);
  }
}

function fallbackWorkspaceInput(attemptIdValue: AttemptId): CreateWorkingCopyAtCommitInput {
  return Object.freeze({
    attemptId: attemptIdValue,
    nodeId: taskNodeId("01900000-0000-7000-8000-000000000fff"),
    treeId: TREE_ID,
    hostId: HOST_ID,
    repositoryId: REPOSITORY_ID,
    ordinal: 1,
  });
}

function workspaceReceipt(input: CreateWorkingCopyAtCommitInput, head: GitSha): WorkspaceReceipt {
  return Object.freeze({
    attemptId: input.attemptId,
    nodeId: input.nodeId,
    treeId: input.treeId,
    hostId: input.hostId,
    repositoryId: input.repositoryId,
    workspacePath: "/workspace",
    sourcePath: input.sourcePath ?? "/workspace",
    branchName: "main",
    baseCommit: input.baseCommit ?? DEFAULT_HEAD,
    headCommit: head,
    state: "ready",
    createdAt: at(0),
    readyAt: at(0),
    cleanupRequestedAt: undefined,
    cleanedAt: undefined,
    mutationFencingToken: fencingToken(1n),
    failureCode: undefined,
    version: 1,
  });
}

/** Wraps {@link TestSandboxLifecycle} to observe create/destroy for leak assertions. */
class RecordingSandbox implements SandboxLifecycle {
  readonly backendKind: TestSandboxLifecycle["backendKind"];
  readonly creates: string[] = [];
  readonly destroys: string[] = [];
  private readonly inner: TestSandboxLifecycle;

  constructor(inner: TestSandboxLifecycle) {
    this.inner = inner;
    this.backendKind = inner.backendKind;
  }

  probe(): Promise<SandboxCapabilityProbe> {
    return this.inner.probe();
  }

  async create(request: CreateSandboxRequest): Promise<SandboxInstance> {
    const instance = await this.inner.create(request);
    this.creates.push(instance.instanceId);
    return instance;
  }

  execute(request: ExecuteSandboxRequest): Promise<SandboxExecutionResult> {
    return this.inner.execute(request);
  }

  stop(instanceId: string, fingerprint: SandboxPolicyFingerprint): Promise<void> {
    return this.inner.stop(instanceId, fingerprint);
  }

  async destroy(instanceId: string, fingerprint: SandboxPolicyFingerprint): Promise<void> {
    this.destroys.push(instanceId);
    await this.inner.destroy(instanceId, fingerprint);
  }
}

// -------------------------------------------------------------------------------------------------
// Fixture.
// -------------------------------------------------------------------------------------------------

type CoordinatorFactory = (harness: HarnessAdapter) => ExecutionCoordinator;

type NodeExecutionFixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  sandbox: RecordingSandbox;
  scheduler: FakeSchedulerStore;
  vcs: FakeVcsBackend;
  artifacts: FakeArtifactRegistry;
  transcripts: TranscriptStore;
  checkpoints: CheckpointStore;
  clock: FixedClock;
  ids: SequenceIdGenerator;
  policy: SandboxPolicy;
  policyFingerprint: SandboxPolicyFingerprint;
  coordinator: CoordinatorFactory;
}>;

const fixtures: NodeExecutionFixture[] = [];

async function createFixture(probe?: SandboxCapabilityProbe): Promise<NodeExecutionFixture> {
  const clock = new FixedClock(at(0));
  const ids = new SequenceIdGenerator(generatedIds(0x2000));
  const temporary = await TemporarySqliteDatabase.create("host", clock);
  const fingerprinter = createSandboxPolicyFingerprinter();
  const lifecycle =
    probe === undefined
      ? createTestSandboxLifecycle({ fingerprinter })
      : createTestSandboxLifecycle({ fingerprinter, probe });
  const sandbox = new RecordingSandbox(lifecycle);
  const scheduler = new FakeSchedulerStore();
  const vcs = new FakeVcsBackend();
  const artifacts = new FakeArtifactRegistry();
  const transcripts = createSqliteTranscriptStore({ database: temporary.database });
  const realCheckpoints = createSqliteCheckpointStore({ database: temporary.database });
  const checkpoints: CheckpointStore = {
    record: (checkpoint) => {
      artifacts.calls.push(`checkpoint:${checkpoint.phase}`);
      return realCheckpoints.record(checkpoint);
    },
    latest: (attemptIdValue) => realCheckpoints.latest(attemptIdValue),
  };
  const policy = sandboxPolicy();
  const policyFingerprint = fingerprinter.fingerprint(policy);
  const sharedPorts = { scheduler, sandbox, vcs, artifacts, transcripts, checkpoints, clock, ids };
  const coordinator: CoordinatorFactory = (harness) =>
    createExecutionCoordinator({ ...sharedPorts, harness, logger: NOOP_LOGGER });
  const fixture: NodeExecutionFixture = {
    temporary,
    ...sharedPorts,
    policy,
    policyFingerprint,
    coordinator,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0, fixtures.length).map((fixture) => fixture.temporary.dispose()),
  );
});

// -------------------------------------------------------------------------------------------------
// Request + lease builders.
// -------------------------------------------------------------------------------------------------

function sandboxPolicy(): SandboxPolicy {
  const policy: SandboxPolicy = {
    version: 1,
    rootFilesystemDigest: contentHash("0".repeat(64)),
    templateDigest: contentHash("0".repeat(64)),
    mounts: [
      {
        kind: "workspace",
        sourcePath: "/tmp/minions/workspace",
        targetPath: "/workspace",
        access: "read_write",
      },
    ],
    network: {
      profile: "implementation",
      allowedHosts: ["github.com"],
      allowProviderGateway: false,
    },
    tools: {
      allowedExecutables: ["git", "node"],
      allowedGitSubcommands: ["status"],
      blockedGitSubcommands: ["push"],
    },
    resources: {
      cpuCount: 1,
      memoryMiB: 512,
      processLimit: 32,
      storageMiB: 1024,
      executionTimeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
    },
  };
  return Object.freeze(policy);
}

function handshake(spawnTool = false): HarnessHandshake {
  const hs: HarnessHandshake = {
    harnessKind: "test",
    harnessVersion: "1.0.0",
    providerKind: "test",
    model: "test-model",
    reasoningLevel: "high",
    capabilities: ["interrupt", "abort", "snapshot", "resume", "steer", "follow_up"],
    tools: spawnTool ? ["read", "write", "task"] : ["read", "write", "edit"],
    securityPolicyDigest: SECURITY_POLICY_DIGEST,
  };
  return Object.freeze(hs);
}

function stageLease(
  fixture: NodeExecutionFixture,
  attemptIdValue: AttemptId,
  nodeId: TaskNodeId,
): SchedulerLease {
  const lease: SchedulerLease = Object.freeze({
    id: schedulerLeaseId(id(leaseSeed)),
    attemptId: attemptIdValue,
    nodeId,
    treeId: TREE_ID,
    repositoryId: REPOSITORY_ID,
    hostId: HOST_ID,
    ownerId: OWNER_ID,
    fencingToken: fencingToken(1n),
    acquiredAt: at(0),
    heartbeatAt: at(0),
    expiresAt: at(10_000),
  });
  leaseSeed += 1;
  fixture.scheduler.enqueue(lease);
  return lease;
}

function nodeRequest(
  fixture: NodeExecutionFixture,
  attemptIdValue: AttemptId,
  nodeId: TaskNodeId,
  lease: SchedulerLease,
  overrides: Readonly<{ goal?: string; baseCommit?: GitSha }> = {},
): NodeExecutionRequest {
  const base = overrides.baseCommit ?? DEFAULT_HEAD;
  return Object.freeze({
    context: Object.freeze({
      attemptId: attemptIdValue,
      attemptOrdinal: 1,
      nodeId,
      treeId: TREE_ID,
      repositoryId: REPOSITORY_ID,
      hostId: HOST_ID,
    }),
    lease,
    ownerId: OWNER_ID,
    leaseDurationMs: 10_000,
    capacity: schedulerCapacityPolicy(4, 2),
    durableHarnessId: DURABLE_HARNESS_ID,
    goal: nonEmptyText(overrides.goal ?? "implement the assigned node", "goal"),
    plan: Object.freeze({
      planGoal: nonEmptyText("ship the planned feature", "plan goal"),
      parentGoal: undefined,
      siblingSummaries: [],
    }),
    workspace: Object.freeze({
      repositoryId: REPOSITORY_ID,
      hostId: HOST_ID,
      workspacePath: "/workspace",
      baseCommit: base,
      headCommit: base,
    }),
    sandboxPolicy: fixture.policy,
    policyFingerprint: fixture.policyFingerprint,
    model: Object.freeze({ model: "test-model", reasoningLevel: "high" }),
    recording: Object.freeze({ actorSessionId: ACTOR_ID, expectedNodeVersion: undefined }),
  });
}

function expectCoordinatorError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ExecutionCoordinatorError);
  expect((error as ExecutionCoordinatorError).code).toBe(code);
}

// -------------------------------------------------------------------------------------------------
// Tests.
// -------------------------------------------------------------------------------------------------

describe("execution coordinator (node-execution pipeline)", () => {
  it("runs an artifact node end to end (succeeded + artifact + transcript + checkpoints)", async () => {
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-artifact",
      payloads: [
        message("creating the artifact"),
        toolCall("c1", "write", { path: "out.txt" }),
        toolResult("c1", artifactOutput()),
        result("succeeded", "artifact written"),
      ],
    });
    const request = nodeRequest(fixture, attempt, node, lease);

    const outcome = await fixture.coordinator(harness).runNode(request);

    expect(outcome.outcome.kind).toBe("succeeded");
    expect(outcome.outcome.attemptId).toBe(attempt);
    expect(outcome.outcome.nodeId).toBe(node);
    expect(outcome.outcome.artifacts).toHaveLength(1);
    expect(outcome.outcome.artifacts[0]?.artifactId).toBe(ARTIFACT_REF_ID);
    expect(outcome.outcome.artifacts[0]?.contentDigest).toBe(ARTIFACT_REF_DIGEST);

    expect(fixture.artifacts.getOutcome(node)?.outcome.kind).toBe("artifact");

    const transcript = await fixture.transcripts.readAll(attempt);
    expect(transcript).toHaveLength(4);
    expect(transcript[0]?.sequence).toBe(1n);
    expect(transcript[3]?.sequence).toBe(4n);

    expect(outcome.checkpoints.initial.phase).toBe("context_sent");
    expect(outcome.checkpoints.final.phase).toBe("finalizing");
    expect(outcome.checkpoints.final.sequence).toBe(4n);
    expect(outcome.checkpoints.final.identity.harnessIdentity.sessionId).toBe("session-artifact");

    // Sandbox created then destroyed on clean completion; lease released exactly once.
    expect(fixture.sandbox.creates).toHaveLength(1);
    expect(fixture.sandbox.destroys).toHaveLength(1);
    expect(fixture.scheduler.releases).toHaveLength(1);

    // REC-03..06: the surfaced context digest equals the deterministic pack digest.
    expect(outcome.contextDigest).toBe(
      computeContextPackDigest(buildContextPackInput(request, handshake()), sha256Digest),
    );

    // Harness session disposed exactly once on success.
    expect(harness.session?.disposeCount).toBe(1);
  });

  it("writes the final checkpoint before recording the node outcome", async () => {
    // A crash between recording the outcome and writing the final
    // checkpoint previously left the node durably 'succeeded' with no
    // final checkpoint - unrecoverable. The final checkpoint must be
    // durable BEFORE the outcome is recorded, so a crash instead leaves
    // the node without a durable outcome (still retry/resume-eligible).
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-order",
      payloads: [message("nothing to do"), result("succeeded", "no changes needed")],
    });

    await fixture.coordinator(harness).runNode(nodeRequest(fixture, attempt, node, lease));

    const checkpointIndex = fixture.artifacts.calls.indexOf("checkpoint:finalizing");
    const outcomeIndex = fixture.artifacts.calls.indexOf("recordOutcome");
    expect(checkpointIndex).toBeGreaterThanOrEqual(0);
    expect(outcomeIndex).toBeGreaterThanOrEqual(0);
    expect(checkpointIndex).toBeLessThan(outcomeIndex);
  });

  it("runs a no-change node (succeeded, no artifacts, no commit)", async () => {
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-nochange",
      payloads: [message("nothing to do"), result("succeeded", "no changes needed")],
    });

    const outcome = await fixture
      .coordinator(harness)
      .runNode(nodeRequest(fixture, attempt, node, lease));

    expect(outcome.outcome.kind).toBe("succeeded");
    expect(outcome.outcome.artifacts).toHaveLength(0);
    expect(outcome.outcome.revision).toBe(DEFAULT_HEAD);
    expect(fixture.artifacts.getOutcome(node)?.outcome.kind).toBe("no_change");
    expect(fixture.vcs.commits).toHaveLength(0);
    expect(fixture.sandbox.destroys).toHaveLength(1);
  });

  it("runs a file-change node (succeeded + vcs commit captured)", async () => {
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    fixture.vcs.setDiff(
      attempt,
      new TextEncoder().encode("diff --git a/src/a.ts b/src/a.ts\n+export const x = 1;\n"),
    );
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-filechange",
      payloads: [
        message("editing the working copy"),
        toolCall("c1", "edit", { path: "src/a.ts" }),
        toolResult("c1", { ok: true }),
        result("succeeded", "edited src/a.ts"),
      ],
    });

    const outcome = await fixture
      .coordinator(harness)
      .runNode(nodeRequest(fixture, attempt, node, lease));

    expect(outcome.outcome.kind).toBe("succeeded");
    expect(outcome.outcome.revision).toBe(commitSha(0));
    expect(fixture.vcs.commits).toHaveLength(1);
    expect(fixture.vcs.commits[0]?.headCommit).toBe(commitSha(0));
    expect(fixture.artifacts.getOutcome(node)?.outcome.kind).toBe("commit");
  });

  it("checkpoints and resumes only the affected node after a mid-stream harness crash", async () => {
    const fixture = await createFixture();
    const siblingAttempt = freshAttempt();
    const siblingNode = freshNode();
    const attempt = freshAttempt();
    const node = freshNode();

    const crashPayloads = [
      message("starting work"),
      thinking("planning the edit"),
      usageEvent(120, 40),
      result("succeeded", "resumed work completed"),
    ];

    // (1) A completed sibling: its transcript + outcome must survive the crash/resume.
    const siblingLease = stageLease(fixture, siblingAttempt, siblingNode);
    await fixture
      .coordinator(
        new ScriptedHarnessAdapter({
          handshake: handshake(),
          sessionId: "session-sibling",
          payloads: [message("sibling done"), result("succeeded", "sibling completed")],
        }),
      )
      .runNode(nodeRequest(fixture, siblingAttempt, siblingNode, siblingLease));

    const siblingTranscriptBefore = await fixture.transcripts.readAll(siblingAttempt);
    const siblingOutcomeBefore = fixture.artifacts.getOutcome(siblingNode);
    const siblingReleases = fixture.scheduler.releases.length;

    // (2) The affected node crashes mid-stream (harness process death) at sequence 3.
    const crashLease = stageLease(fixture, attempt, node);
    const crashHarness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-resume",
      payloads: crashPayloads,
      crashAfterSequence: 3n,
    });
    await expect(
      fixture.coordinator(crashHarness).runNode(nodeRequest(fixture, attempt, node, crashLease)),
    ).rejects.toSatisfy((error: unknown) => {
      expectCoordinatorError(error, "harness_unavailable");
      return true;
    });

    // Fail-closed: lease released; sandbox RETAINED for resume (HAR-01); 3 chunks persisted.
    expect(fixture.scheduler.releases).toHaveLength(siblingReleases + 1);
    expect(fixture.sandbox.creates).toHaveLength(2);
    expect(fixture.sandbox.destroys).toHaveLength(1); // sibling only
    const partialTranscript = await fixture.transcripts.readAll(attempt);
    expect(partialTranscript).toHaveLength(3);
    const checkpoint = await fixture.checkpoints.latest(attempt);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.sequence).toBe(3n);
    expect(checkpoint?.identity.harnessIdentity.sessionId).toBe("session-resume");
    // Harness session disposed exactly once on crash failure.
    expect(crashHarness.session?.disposeCount).toBe(1);
    expect(crashHarness.startWorkspacePaths).toEqual(["/workspace"]);

    // (3) A restarted coordinator re-binds the SAME identity + sandbox and replays
    // from the checkpoint sequence, resuming ONLY this node.
    const resumeLease = stageLease(fixture, attempt, node);
    const resumeHarness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-resume",
      payloads: crashPayloads,
    });
    if (checkpoint === undefined) throw new Error("checkpoint expected after crash");
    const outcome = await fixture
      .coordinator(resumeHarness)
      .resumeFromCheckpoint(checkpoint, nodeRequest(fixture, attempt, node, resumeLease));

    expect(outcome.outcome.kind).toBe("succeeded");
    const resumedTranscript = await fixture.transcripts.readAll(attempt);
    expect(resumedTranscript).toHaveLength(4);
    expect(resumedTranscript[3]?.payload.kind).toBe("result");
    expect(fixture.sandbox.destroys).toHaveLength(2); // sibling + resumed node
    expect(fixture.scheduler.releases).toHaveLength(siblingReleases + 2);
    expect(resumeHarness.session?.disposeCount).toBe(1);
    expect(resumeHarness.resumeWorkspacePaths).toEqual(["/workspace"]);

    // Sibling is untouched: same transcript length + same recorded outcome.
    const siblingTranscriptAfter = await fixture.transcripts.readAll(siblingAttempt);
    expect(siblingTranscriptAfter).toHaveLength(siblingTranscriptBefore.length);
    expect(siblingTranscriptAfter[0]?.sequence).toBe(siblingTranscriptBefore[0]?.sequence);
    expect(fixture.artifacts.getOutcome(siblingNode)).toEqual(siblingOutcomeBefore);
  });

  it("interrupts an in-flight attempt (cancelled + lease released + sandbox destroyed)", async () => {
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-interrupt",
      payloads: [message("working")],
      blockUntilInterrupted: true,
    });
    const coordinator = fixture.coordinator(harness);

    const done = coordinator.runNode(nodeRequest(fixture, attempt, node, lease));
    await harness.whenBlocked;
    const outcome = await coordinator.interrupt(attempt);
    await done;

    expect(outcome.outcome.kind).toBe("cancelled");
    expect(fixture.scheduler.releases).toHaveLength(1);
    expect(fixture.sandbox.destroys).toHaveLength(1);
    expect(fixture.sandbox.creates).toHaveLength(1);
  });

  it("fails closed when the harness is unavailable (typed error, lease released, sandbox destroyed)", async () => {
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-handshake-fail",
      payloads: [result("succeeded", "never reached")],
      handshakeError: new Error("harness offline"),
    });

    await expect(
      fixture.coordinator(harness).runNode(nodeRequest(fixture, attempt, node, lease)),
    ).rejects.toSatisfy((error: unknown) => {
      expectCoordinatorError(error, "harness_unavailable");
      return true;
    });

    expect(fixture.scheduler.releases).toHaveLength(1);
    expect(fixture.sandbox.creates).toHaveLength(1);
    expect(fixture.sandbox.destroys).toHaveLength(1);
  });

  it("fails closed when the sandbox backend is unavailable (typed error, lease released)", async () => {
    const unavailable: SandboxCapabilityProbe = Object.freeze({
      available: false,
      backendKind: "test",
      failureCode: "backend_down",
      message: "sandbox backend is offline",
    });
    const fixture = await createFixture(unavailable);
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-sandbox-fail",
      payloads: [result("succeeded", "never reached")],
    });

    await expect(
      fixture.coordinator(harness).runNode(nodeRequest(fixture, attempt, node, lease)),
    ).rejects.toSatisfy((error: unknown) => {
      expectCoordinatorError(error, "sandbox_unavailable");
      return true;
    });

    expect(fixture.scheduler.releases).toHaveLength(1);
    expect(fixture.sandbox.creates).toHaveLength(0);
  });

  it("rejects a harness advertising a spawn tool (HAR-04)", async () => {
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(true),
      sessionId: "session-spawn",
      payloads: [result("succeeded", "never reached")],
    });

    await expect(
      fixture.coordinator(harness).runNode(nodeRequest(fixture, attempt, node, lease)),
    ).rejects.toSatisfy((error: unknown) => {
      expectCoordinatorError(error, "policy_violation");
      return true;
    });

    expect(fixture.scheduler.releases).toHaveLength(1);
    expect(fixture.sandbox.creates).toHaveLength(1);
    expect(fixture.sandbox.destroys).toHaveLength(1);
  });
  it("disposes the harness session exactly once on failed node execution outcome", async () => {
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const lease = stageLease(fixture, attempt, node);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-failed",
      payloads: [message("failing"), result("failed", "execution failed")],
    });

    const outcome = await fixture
      .coordinator(harness)
      .runNode(nodeRequest(fixture, attempt, node, lease));

    expect(outcome.outcome.kind).toBe("failed");
    expect(harness.session?.disposeCount).toBe(1);
  });
  it("rejects execution when the lease does not match the request context (not_leased)", async () => {
    const fixture = await createFixture();
    const attempt = freshAttempt();
    const node = freshNode();
    const otherNode = freshNode();
    const mismatchedLease = stageLease(fixture, attempt, otherNode);
    const harness = new ScriptedHarnessAdapter({
      handshake: handshake(),
      sessionId: "session-mismatched",
      payloads: [result("succeeded", "never reached")],
    });

    await expect(
      fixture.coordinator(harness).runNode(nodeRequest(fixture, attempt, node, mismatchedLease)),
    ).rejects.toSatisfy((error: unknown) => {
      expectCoordinatorError(error, "not_leased");
      return true;
    });

    expect(fixture.scheduler.releases).toHaveLength(0);
    expect(fixture.sandbox.creates).toHaveLength(0);
  });

  it("renders a deterministic context pack (REC-03..06)", () => {
    const fingerprinter = createSandboxPolicyFingerprinter();
    const policy = sandboxPolicy();
    const fingerprint = fingerprinter.fingerprint(policy);
    const buildInput = (attemptIdValue: AttemptId): NodeExecutionRequest => {
      const lease: SchedulerLease = Object.freeze({
        id: schedulerLeaseId(id(0x4001)),
        attemptId: attemptIdValue,
        nodeId: NODE_X,
        treeId: TREE_ID,
        repositoryId: REPOSITORY_ID,
        hostId: HOST_ID,
        ownerId: OWNER_ID,
        fencingToken: fencingToken(1n),
        acquiredAt: at(0),
        heartbeatAt: at(0),
        expiresAt: at(10_000),
      });
      return Object.freeze({
        context: Object.freeze({
          attemptId: attemptIdValue,
          attemptOrdinal: 1,
          nodeId: NODE_X,
          treeId: TREE_ID,
          repositoryId: REPOSITORY_ID,
          hostId: HOST_ID,
        }),
        lease,
        ownerId: OWNER_ID,
        leaseDurationMs: 10_000,
        capacity: schedulerCapacityPolicy(4, 2),
        durableHarnessId: DURABLE_HARNESS_ID,
        goal: nonEmptyText("implement the assigned node", "goal"),
        plan: Object.freeze({
          planGoal: nonEmptyText("ship the planned feature", "plan goal"),
          parentGoal: undefined,
          siblingSummaries: [],
        }),
        workspace: Object.freeze({
          repositoryId: REPOSITORY_ID,
          hostId: HOST_ID,
          workspacePath: "/workspace",
          baseCommit: DEFAULT_HEAD,
          headCommit: DEFAULT_HEAD,
        }),
        sandboxPolicy: policy,
        policyFingerprint: fingerprint,
        model: Object.freeze({ model: "test-model", reasoningLevel: "high" }),
        recording: Object.freeze({ actorSessionId: ACTOR_ID, expectedNodeVersion: undefined }),
      });
    };

    const hs = handshake();
    const first = computeContextPackDigest(
      buildContextPackInput(buildInput(attemptId(id(0x4011))), hs),
      sha256Digest,
    );
    // Same node + plan + workspace + handshake -> identical digest, independent of attemptId.
    expect(
      computeContextPackDigest(
        buildContextPackInput(buildInput(attemptId(id(0x4012))), hs),
        sha256Digest,
      ),
    ).toBe(first);
    // A reordered tool surface is canonicalized to the same digest.
    const reordered = Object.freeze({ ...hs, tools: ["write", "read", "edit"] });
    expect(
      computeContextPackDigest(
        buildContextPackInput(buildInput(attemptId(id(0x4011))), reordered),
        sha256Digest,
      ),
    ).toBe(first);
    // A different tool surface changes the digest.
    const withSpawn = Object.freeze({ ...hs, tools: ["read", "task"] });
    expect(
      computeContextPackDigest(
        buildContextPackInput(buildInput(attemptId(id(0x4011))), withSpawn),
        sha256Digest,
      ),
    ).not.toBe(first);
  });
});
