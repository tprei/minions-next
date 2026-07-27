import {
  actorSessionId,
  attemptId,
  contentHash,
  gitSha,
  hostId,
  nonEmptyText,
  repositoryId,
  schedulerCapacityPolicy,
  schedulerOwnerId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  classifyFailure,
  consume,
  createRetryBudget,
  decideRepair,
  ExecutionCoordinatorError,
  SandboxDeniedError,
  validateGateReceipts,
  type AttemptCheckpoint,
  type ExecutionCoordinator,
  type FailureClass,
  type GateReceipt,
  type GateReceiptExpectation,
  type GateRunRequest,
  type GateRunner,
  type GateValidation,
  type GitSha,
  type HarnessUsage,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeOutcome,
  type NodeOutcomeKind,
  type NoProgressSignature,
  type RepairAttention,
  type SandboxPolicy,
  type SandboxPolicyFingerprint,
  type TaskNodeId,
  type VcsBackend,
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
  createRepairCoordinator,
  type AttemptRepairInput,
  type RepairAttentionSink,
  type RepairCoordinator,
} from "@minions/adapters";
import { describe, expect, it } from "vitest";

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = timestampFromEpochMilliseconds(1_700_000_000_000);
const HOST_ID = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY_ID = repositoryId("01900000-0000-7000-8000-000000000002");
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000003");
const ACTOR_ID = actorSessionId("01900000-0000-7000-8000-000000000004");
const OWNER_ID = schedulerOwnerId("01900000-0000-7000-8000-000000000005");
const NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000006");
const ATTEMPT_ID = attemptId("01900000-0000-7000-8000-000000000007");
const WORKING_COPY: VcsWorkingCopyRef = Object.freeze({ attemptId: ATTEMPT_ID });
const DURABLE_HARNESS_ID = "durable-harness-0001";
const CONTEXT_DIGEST = contentHash("a".repeat(64));
const PROFILE_HASH = contentHash("b".repeat(64));
const ENV_DIGEST = contentHash("c".repeat(64));
const EMPTY_DIGEST = contentHash("d".repeat(64));
const POLICY_FINGERPRINT: SandboxPolicyFingerprint = Object.freeze({
  policyVersion: 1,
  digest: contentHash("e".repeat(64)),
});
const ZERO_USAGE: HarnessUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});
const ENCODER = new TextEncoder();

/** Distinct 40-hex sha derived from an integer. */
function sha(n: number): GitSha {
  const suffix = n.toString(16);
  return gitSha(`${"a".repeat(40 - suffix.length)}${suffix}`);
}

const HEAD_1 = sha(1);
const HEAD_2 = sha(2);
const HEAD_3 = sha(3);

// -------------------------------------------------------------------------------------------------
// Fixtures: outcomes, results, receipts, status.
// -------------------------------------------------------------------------------------------------

function outcome(kind: NodeOutcomeKind, text: string, revision?: GitSha): NodeOutcome {
  return Object.freeze({
    nodeId: NODE_ID,
    attemptId: ATTEMPT_ID,
    kind,
    text,
    artifacts: [],
    revision,
    usage: ZERO_USAGE,
  });
}

function checkpoint(): AttemptCheckpoint {
  return Object.freeze({
    attemptId: ATTEMPT_ID,
    nodeId: NODE_ID,
    sequence: 0n,
    phase: "finalizing",
    identity: Object.freeze({
      harnessIdentity: Object.freeze({
        durableHarnessId: DURABLE_HARNESS_ID,
        sessionId: "session-1",
      }),
      sandboxInstanceId: "sandbox-1",
      sandboxBackendKind: "test",
      sandboxPolicyDigest: POLICY_FINGERPRINT.digest,
      sandboxState: "stopped",
    }),
    contextDigest: CONTEXT_DIGEST,
    recordedAt: BASE_TIME,
  });
}

function executionResult(outcomeValue: NodeOutcome): NodeExecutionResult {
  return Object.freeze({
    attemptId: ATTEMPT_ID,
    nodeId: NODE_ID,
    outcome: outcomeValue,
    transcript: Object.freeze({ firstSequence: 0n, lastSequence: 0n, chunkCount: 0 }),
    checkpoints: Object.freeze({ initial: checkpoint(), final: checkpoint() }),
    contextDigest: CONTEXT_DIGEST,
    recordedAt: BASE_TIME,
  });
}

function receipt(
  gateOutcome: GateReceipt["outcome"],
  sequence: number,
  name = "lint",
): GateReceipt {
  return Object.freeze({
    gateName: name,
    category: 1,
    outcome: gateOutcome,
    exitCode: gateOutcome === "passed" ? 0 : 1,
    durationMs: 0,
    stdoutDigest: EMPTY_DIGEST,
    stderrDigest: EMPTY_DIGEST,
    headCommit: HEAD_1,
    profileHash: PROFILE_HASH,
    environmentDigest: ENV_DIGEST,
    capturedAt: BASE_TIME,
    sequence,
  });
}

function status(head: GitSha, porcelain: string, diff: string): WorkspaceStatus {
  return Object.freeze({
    attemptId: ATTEMPT_ID,
    headCommit: head,
    porcelainV2: ENCODER.encode(porcelain),
    diff: ENCODER.encode(diff),
    capturedAt: BASE_TIME,
  });
}

function sandboxPolicy(): SandboxPolicy {
  return Object.freeze({
    version: 1,
    rootFilesystemDigest: EMPTY_DIGEST,
    templateDigest: EMPTY_DIGEST,
    mounts: Object.freeze([
      Object.freeze({
        kind: "workspace",
        sourcePath: "/tmp/workspace",
        targetPath: "/workspace",
        access: "read_write",
      }),
    ]),
    network: Object.freeze({
      profile: "implementation",
      allowedHosts: Object.freeze(["github.com"]),
      allowProviderGateway: false,
    }),
    tools: Object.freeze({
      allowedExecutables: Object.freeze(["git", "node"]),
      allowedGitSubcommands: Object.freeze(["status"]),
      blockedGitSubcommands: Object.freeze(["push"]),
    }),
    resources: Object.freeze({
      cpuCount: 1,
      memoryMiB: 512,
      processLimit: 64,
      storageMiB: 2048,
      executionTimeoutMs: 600_000,
      maxOutputBytes: 65_536,
    }),
  });
}

function nodeRequest(): NodeExecutionRequest {
  return Object.freeze({
    context: Object.freeze({
      attemptId: ATTEMPT_ID,
      attemptOrdinal: 1,
      nodeId: NODE_ID,
      treeId: TREE_ID,
      repositoryId: REPOSITORY_ID,
      hostId: HOST_ID,
    }),
    ownerId: OWNER_ID,
    leaseDurationMs: 10_000,
    capacity: schedulerCapacityPolicy(4, 2),
    durableHarnessId: DURABLE_HARNESS_ID,
    goal: nonEmptyText("implement the assigned node", "goal"),
    plan: Object.freeze({
      planGoal: nonEmptyText("ship the planned feature", "plan goal"),
      parentGoal: undefined,
      siblingSummaries: Object.freeze([]),
    }),
    workspace: Object.freeze({
      repositoryId: REPOSITORY_ID,
      hostId: HOST_ID,
      workspacePath: "/workspace",
      baseCommit: HEAD_1,
      headCommit: HEAD_1,
    }),
    sandboxPolicy: sandboxPolicy(),
    policyFingerprint: POLICY_FINGERPRINT,
    model: Object.freeze({ model: "test-model", reasoningLevel: "high" }),
    recording: Object.freeze({ actorSessionId: ACTOR_ID, expectedNodeVersion: undefined }),
  });
}

function gateRunRequest(): GateRunRequest {
  return Object.freeze({
    nodeId: NODE_ID,
    attemptId: ATTEMPT_ID,
    headCommit: HEAD_1,
    profileHash: PROFILE_HASH,
    environment: Object.freeze({}),
    sandboxInstanceId: "sandbox-1",
    expectedPolicyFingerprint: POLICY_FINGERPRINT,
    workingDirectory: "/workspace",
    maxOutputBytes: 65_536,
    signal: undefined,
    gates: Object.freeze([]),
  });
}

function repairInput(overrides: Partial<AttemptRepairInput> = {}): AttemptRepairInput {
  return Object.freeze({
    nodeId: NODE_ID,
    treeId: TREE_ID,
    request: nodeRequest(),
    workingCopy: WORKING_COPY,
    ...overrides,
  });
}

// -------------------------------------------------------------------------------------------------
// Test doubles.
// -------------------------------------------------------------------------------------------------

type ScriptedRun =
  | Readonly<{ kind: "result"; result: NodeExecutionResult }>
  | Readonly<{ kind: "throw"; error: Error }>;

/** Fake execution coordinator: scripts runNode by call index. */
class FakeExecutionCoordinator implements ExecutionCoordinator {
  runCount = 0;
  readonly nodeIds: TaskNodeId[] = [];
  readonly #script: readonly ScriptedRun[];

  constructor(script: readonly ScriptedRun[]) {
    this.#script = script;
  }

  runNode(request: NodeExecutionRequest): Promise<NodeExecutionResult> {
    const entry = this.#script[this.runCount];
    this.runCount += 1;
    this.nodeIds.push(request.context.nodeId);
    if (entry === undefined) {
      return Promise.reject(new Error("FakeExecutionCoordinator script exhausted"));
    }
    if (entry.kind === "throw") {
      return Promise.reject(entry.error);
    }
    return Promise.resolve(entry.result);
  }

  interrupt(): Promise<NodeExecutionResult> {
    return Promise.reject(new Error("FakeExecutionCoordinator.interrupt not used"));
  }

  resumeFromCheckpoint(): Promise<NodeExecutionResult> {
    return Promise.reject(new Error("FakeExecutionCoordinator.resumeFromCheckpoint not used"));
  }
}

/** Fake gate runner: scripts runGates by call index. */
class FakeGateRunner implements GateRunner {
  runCount = 0;
  readonly #script: readonly (readonly GateReceipt[])[];

  constructor(script: readonly (readonly GateReceipt[])[]) {
    this.#script = script;
  }

  runGates(): Promise<readonly GateReceipt[]> {
    const receipts = this.#script[this.runCount] ?? [];
    this.runCount += 1;
    return Promise.resolve(receipts);
  }

  validateReceipts(
    receipts: readonly GateReceipt[],
    expected: GateReceiptExpectation,
  ): GateValidation {
    return validateGateReceipts(receipts, expected);
  }
}

/** Fake VCS backend: scripts captureStatus by call index; other ops reject. */
class FakeVcsBackend implements VcsBackend {
  statusCount = 0;
  readonly #statuses: readonly WorkspaceStatus[];

  constructor(statuses: readonly WorkspaceStatus[]) {
    this.#statuses = statuses;
  }

  captureStatus(): Promise<WorkspaceStatus> {
    const value = this.#statuses[this.statusCount];
    this.statusCount += 1;
    if (value === undefined) {
      return Promise.reject(new Error("FakeVcsBackend statuses exhausted"));
    }
    return Promise.resolve(value);
  }

  // The repair coordinator never invokes the remaining VCS operations.
  createWorkingCopyAtCommit(): Promise<WorkspaceReceipt> {
    return Promise.reject(new Error("not used"));
  }
  captureDiff(): Promise<VcsDiff> {
    return Promise.reject(new Error("not used"));
  }
  commit(): Promise<VcsCommitReceipt> {
    return Promise.reject(new Error("not used"));
  }
  resolveHead(): Promise<GitSha> {
    return Promise.reject(new Error("not used"));
  }
  enumerateDescendants(): Promise<VcsDescendants> {
    return Promise.reject(new Error("not used"));
  }
  restack(): Promise<VcsRestackReceipt> {
    return Promise.reject(new Error("not used"));
  }
  conflictState(): Promise<VcsConflictState> {
    return Promise.reject(new Error("not used"));
  }
  pushBookmark(): Promise<VcsPushReceipt> {
    return Promise.reject(new Error("not used"));
  }
  cleanup(): Promise<WorkspaceReceipt> {
    return Promise.reject(new Error("not used"));
  }
  recover(): Promise<readonly WorkspaceReceipt[]> {
    return Promise.reject(new Error("not used"));
  }
}

/** In-memory attention sink: records escalations for assertion. */
class InMemoryAttentionSink implements RepairAttentionSink {
  readonly records: RepairAttention[] = [];

  record(attention: RepairAttention): Promise<RepairAttention> {
    this.records.push(attention);
    return Promise.resolve(attention);
  }
}

interface RepairHarness {
  coordinator: FakeExecutionCoordinator;
  gateRunner: FakeGateRunner;
  vcs: FakeVcsBackend;
  sink: InMemoryAttentionSink;
  repair: RepairCoordinator;
}

function harness(
  runs: readonly ScriptedRun[],
  gateScripts: readonly (readonly GateReceipt[])[],
  statuses: readonly WorkspaceStatus[],
): RepairHarness {
  const coordinator = new FakeExecutionCoordinator(runs);
  const gateRunner = new FakeGateRunner(gateScripts);
  const vcs = new FakeVcsBackend(statuses);
  const sink = new InMemoryAttentionSink();
  const repair = createRepairCoordinator({ coordinator, gateRunner, vcs, attentionSink: sink });
  return { coordinator, gateRunner, vcs, sink, repair };
}

// -------------------------------------------------------------------------------------------------
// Pure domain (unit-level coverage of the classification + decision core).
// -------------------------------------------------------------------------------------------------

describe("repair domain: classifyFailure", () => {
  it("maps a sandbox credential denial to an auth blocker", () => {
    const denied = new SandboxDeniedError("home_credentials", "execute", "no creds");
    expect(classifyFailure(outcome("failed", "x"), [], denied)).toBe<FailureClass>("auth_blocker");
  });

  it("maps a sandbox isolation denial to an isolation blocker", () => {
    const denied = new SandboxDeniedError("process_escape", "execute", "escape");
    expect(classifyFailure(outcome("failed", "x"), [], denied)).toBe<FailureClass>(
      "isolation_blocker",
    );
  });

  it("classifies a failing gate as a gate failure and missing_executable as a config blocker", () => {
    expect(classifyFailure(outcome("succeeded", "ok"), [receipt("failed", 1)])).toBe<FailureClass>(
      "gate_failure",
    );
    expect(
      classifyFailure(outcome("succeeded", "ok"), [receipt("missing_executable", 1)]),
    ).toBe<FailureClass>("config_blocker");
  });

  it("classifies a failed harness outcome (no failing gate) as a harness failure", () => {
    expect(classifyFailure(outcome("failed", "boom"), [receipt("passed", 1)])).toBe<FailureClass>(
      "harness_failure",
    );
  });
});

describe("repair domain: retry budget", () => {
  it("tracks consumed vs remaining up to the ceiling", () => {
    const budget = createRetryBudget(3);
    expect(budget.remaining).toBe(3);
    expect(budget.nodeBudget).toBe(3);
    const afterOne = consume(budget);
    expect(afterOne.consumed).toBe(1);
    expect(afterOne.remaining).toBe(2);
  });

  it("refuses a negative ceiling", () => {
    expect(() => createRetryBudget(-1)).toThrow(RangeError);
  });
});

describe("repair domain: decideRepair", () => {
  const budget = createRetryBudget(3);
  const sig: NoProgressSignature = Object.freeze({
    failureClass: "gate_failure",
    changedPathsDigest: EMPTY_DIGEST,
    headCommit: HEAD_1,
    outputDigest: EMPTY_DIGEST,
  });

  it("escalates blocker classes immediately", () => {
    const decision = decideRepair("auth_blocker", budget, [], sig, false);
    expect(decision.action).toBe("escalate");
  });

  it("retries a retryable failure within budget", () => {
    const decision = decideRepair("gate_failure", budget, [], sig, false);
    expect(decision.action).toBe("retry");
  });

  it("escalates on no-progress (repeated signature)", () => {
    const decision = decideRepair("gate_failure", budget, [sig], sig, false);
    expect(decision.action).toBe("escalate");
    expect(decision.noProgress).toBe(true);
  });

  it("escalates on human-change between attempts", () => {
    const decision = decideRepair("gate_failure", budget, [], sig, true);
    expect(decision.action).toBe("escalate");
  });
});

// -------------------------------------------------------------------------------------------------
// Repair coordinator: integration scenarios with test doubles.
// -------------------------------------------------------------------------------------------------

describe("repair coordinator", () => {
  it("repairs when a failing gate passes on retry", async () => {
    const failed = outcome("succeeded", "implemented");
    const fixed = outcome("succeeded", "implemented", HEAD_2);
    const h = harness(
      [
        { kind: "result", result: executionResult(failed) },
        { kind: "result", result: executionResult(fixed) },
      ],
      [[receipt("failed", 1)], [receipt("passed", 2)]],
      // post1, pre2(==post1: no human change), post2
      [status(HEAD_1, "p1", "d1"), status(HEAD_1, "p1", "d1"), status(HEAD_2, "p2", "d2")],
    );

    const result = await h.repair.attemptRepair({ ...repairInput(), gates: gateRunRequest() });

    expect(result.status).toBe("repaired");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.failureClass).toBe<FailureClass>("gate_failure");
    expect(result.budget.consumed).toBe(1);
    expect(result.decision).toBeUndefined();
    expect(result.attention).toBeUndefined();
    // Single-node scope: only the failed node was re-run.
    expect(h.coordinator.runCount).toBe(2);
    expect(h.coordinator.nodeIds).toEqual([NODE_ID, NODE_ID]);
    expect(h.gateRunner.runCount).toBe(2);
  });

  it("escalates with budget_exhausted after distinct failures reach the ceiling", async () => {
    const failing = (text: string) => outcome("failed", text);
    const h = harness(
      [
        { kind: "result", result: executionResult(failing("fail-1")) },
        { kind: "result", result: executionResult(failing("fail-2")) },
        { kind: "result", result: executionResult(failing("fail-3")) },
      ],
      [],
      // post1, pre2(==post1), post2, pre3(==post2), post3 — distinct heads each attempt.
      [
        status(HEAD_1, "p1", "d1"),
        status(HEAD_1, "p1", "d1"),
        status(HEAD_2, "p2", "d2"),
        status(HEAD_2, "p2", "d2"),
        status(HEAD_3, "p3", "d3"),
      ],
    );

    const result = await h.repair.attemptRepair({ ...repairInput(), ceiling: 3 });

    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(3);
    expect(result.budget.remaining).toBe(0);
    expect(result.budget.consumed).toBe(3);
    expect(result.attention?.attentionKind).toBe("budget_exhausted");
    expect(result.decision?.action).toBe("escalate");
    // No 4th attempt: the budget guard fired before running.
    expect(h.coordinator.runCount).toBe(3);
  });

  it("escalates with no_progress on an identical repeated failure signature", async () => {
    const h = harness(
      [
        { kind: "result", result: executionResult(outcome("failed", "same")) },
        { kind: "result", result: executionResult(outcome("failed", "same")) },
      ],
      [],
      // post1, pre2(==post1), post2(==post1): identical signature → no progress.
      [status(HEAD_1, "p", "d"), status(HEAD_1, "p", "d"), status(HEAD_1, "p", "d")],
    );

    const result = await h.repair.attemptRepair({ ...repairInput(), ceiling: 3 });

    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(2);
    expect(result.attention?.attentionKind).toBe("no_progress");
    expect(result.decision?.noProgress).toBe(true);
    expect(h.coordinator.runCount).toBe(2);
  });

  it("escalates with human_change when the working copy is edited between attempts", async () => {
    const h = harness(
      [{ kind: "result", result: executionResult(outcome("failed", "fail")) }],
      [],
      // post1, pre2 (!= post1: human edited) → escalate before the 2nd attempt.
      [status(HEAD_1, "p1", "d1"), status(HEAD_2, "p2", "d2")],
    );

    const result = await h.repair.attemptRepair({ ...repairInput(), ceiling: 3 });

    expect(result.status).toBe("escalated");
    expect(result.attention?.attentionKind).toBe("human_change");
    expect(result.attempts).toHaveLength(1);
    // No coding tokens spent on a second attempt: runNode was not called again.
    expect(h.coordinator.runCount).toBe(1);
  });

  it("escalates an isolation blocker immediately (no coding retry)", async () => {
    const h = harness(
      [
        {
          kind: "throw",
          error: new SandboxDeniedError("backend_unavailable", "create", "backend down"),
        },
      ],
      [],
      [status(HEAD_1, "p", "d")],
    );

    const result = await h.repair.attemptRepair(repairInput());

    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.failureClass).toBe<FailureClass>("isolation_blocker");
    expect(result.attention?.attentionKind).toBe("blocked");
    expect(result.decision?.action).toBe("escalate");
    expect(h.coordinator.runCount).toBe(1);
  });

  it("escalates an auth blocker immediately (sandbox credential denial)", async () => {
    const h = harness(
      [
        {
          kind: "throw",
          error: new SandboxDeniedError("home_credentials", "mount", "creds blocked"),
        },
      ],
      [],
      [status(HEAD_1, "p", "d")],
    );

    const result = await h.repair.attemptRepair(repairInput());

    expect(result.attempts[0]?.failureClass).toBe<FailureClass>("auth_blocker");
    expect(result.attention?.attentionKind).toBe("blocked");
    expect(h.coordinator.runCount).toBe(1);
  });

  it("escalates a config blocker immediately (coordinator policy violation)", async () => {
    const h = harness(
      [
        {
          kind: "throw",
          error: new ExecutionCoordinatorError("policy_violation", "bad policy", ATTEMPT_ID),
        },
      ],
      [],
      [status(HEAD_1, "p", "d")],
    );

    const result = await h.repair.attemptRepair(repairInput());

    expect(result.attempts[0]?.failureClass).toBe<FailureClass>("config_blocker");
    expect(result.attention?.attentionKind).toBe("blocked");
    expect(h.coordinator.runCount).toBe(1);
  });

  it("preserves every prior attempt's evidence on escalation (never erases)", async () => {
    const h = harness(
      [
        { kind: "result", result: executionResult(outcome("failed", "fail-1")) },
        { kind: "result", result: executionResult(outcome("failed", "fail-2")) },
        { kind: "result", result: executionResult(outcome("failed", "fail-3")) },
      ],
      [],
      [
        status(HEAD_1, "p1", "d1"),
        status(HEAD_1, "p1", "d1"),
        status(HEAD_2, "p2", "d2"),
        status(HEAD_2, "p2", "d2"),
        status(HEAD_3, "p3", "d3"),
      ],
    );

    const result = await h.repair.attemptRepair({ ...repairInput(), ceiling: 3 });

    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(3);
    const texts = result.attempts.map((attempt) => attempt.outcome?.text);
    expect(texts).toEqual(["fail-1", "fail-2", "fail-3"]);
    // Distinct signatures (no no-progress) preserved in order.
    const sigs = result.attempts.map((attempt) => attempt.signature);
    expect(new Set(sigs.map((sig) => signatureKey(sig))).size).toBe(3);
    // Attention evidence refs cover every preserved attempt.
    expect(result.attention?.evidenceRefs).toHaveLength(3);
    expect(result.attention?.evidenceRefs.map((ref) => ref.outcomeText)).toEqual([
      "fail-1",
      "fail-2",
      "fail-3",
    ]);
    // The sink received the same attention.
    expect(h.sink.records).toHaveLength(1);
    expect(h.sink.records[0]).toBe(result.attention);
  });

  it("scopes repair to the single failed node (no ancestor/sibling rerun)", async () => {
    const h = harness(
      [
        { kind: "result", result: executionResult(outcome("failed", "fail-1")) },
        { kind: "result", result: executionResult(outcome("failed", "fail-2")) },
      ],
      [],
      [status(HEAD_1, "p1", "d1"), status(HEAD_1, "p1", "d1"), status(HEAD_2, "p2", "d2")],
    );

    const result = await h.repair.attemptRepair({ ...repairInput(), ceiling: 2 });

    // Every runNode call targeted the same failed node — never another node.
    expect(h.coordinator.nodeIds.every((id) => id === NODE_ID)).toBe(true);
    expect(h.coordinator.runCount).toBe(result.attempts.length);
    expect(result.status).toBe("escalated");
  });
});

/** Stable string key for a signature (set-based distinctness checks). */
function signatureKey(sig: NoProgressSignature): string {
  return `${sig.failureClass}:${sig.changedPathsDigest}:${sig.headCommit}:${sig.outputDigest}`;
}
