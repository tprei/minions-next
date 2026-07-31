import { createHash } from "node:crypto";

import {
  artifactId,
  buildContextPackInput,
  canonicalContextPackJson,
  commandId,
  contentHash,
  evidenceId,
  ExecutionCoordinatorError,
  missingHarnessCapabilities,
  nonEmptyText,
  renderContextPack,
  toTranscriptChunk,
  validateNodeExecutionRequest,
  type ArtifactNodeOutcome,
  type ArtifactRegistry,
  type ArtifactRef,
  type AttemptCheckpoint,
  type AttemptCheckpointIdentity,
  type AttemptId,
  type CheckpointStore,
  type Clock,
  type CommitNodeOutcome,
  type ContentHash,
  type ContextPack,
  type DigestFunction,
  type ExecutionCoordinator,
  type ExecutionCoordinatorLogger,
  type GitSha,
  type HarnessAdapter,
  type HarnessCapability,
  type HarnessEventPayload,
  type HarnessHandshake,
  type HarnessSession,
  type HarnessSessionIdentity,
  type HarnessUsage,
  type IdGenerator,
  type JsonValue,
  type NoChangeNodeOutcome,
  type NodeExecutionPhase,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeOutcome,
  type NodeOutcomeKind,
  type RecordedNodeOutcome,
  type SandboxBackendKind,
  type SandboxInstance,
  type SandboxLifecycle,
  type SandboxPolicyFingerprint,
  type SchedulerLease,
  type SchedulerStore,
  type TranscriptChunk,
  type TranscriptStore,
  type VcsBackend,
} from "@minions/core";

export { ExecutionCoordinatorError };
export type { ExecutionCoordinatorErrorCode } from "@minions/core";

export type ExecutionCoordinatorOptions = Readonly<{
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
  /** Overrides the default SHA-256 digest (REC-03..06). */
  digest?: DigestFunction;
  /** Bounded output capture limit in bytes (HAR-08). Default 64 KiB. */
  outputCaptureLimitBytes?: number;
}>;

const DEFAULT_OUTPUT_CAPTURE_LIMIT_BYTES = 65_536;
const REQUIRED_HARNESS_CAPABILITIES: readonly HarnessCapability[] = [
  "interrupt",
  "abort",
  "snapshot",
];
const SPAWN_TOOL_PREFIXES = ["task", "spawn", "subagent", "dispatch", "launch_agent"] as const;

/** Default deterministic digest: SHA-256 over UTF-8. */
function defaultDigest(utf8: string): ContentHash {
  return contentHash(createHash("sha256").update(utf8).digest("hex"));
}

/**
 * Compose the scheduling, sandbox, harness, VCS, artifact, transcript, and
 * checkpoint ports into a single local node-execution coordinator. The
 * coordinator depends ONLY on ports — the OMP adapter and concrete sandbox are
 * injected and never imported.
 */
export function createExecutionCoordinator(
  options: ExecutionCoordinatorOptions,
): ExecutionCoordinator {
  return new DefaultExecutionCoordinator(options);
}

/** Internal sandbox handle: the subset of {@link SandboxInstance} the coordinator needs. */
type SandboxHandle = Readonly<{
  instanceId: string;
  backendKind: SandboxBackendKind;
  policyFingerprint: SandboxPolicyFingerprint;
  state: SandboxInstance["state"];
}>;

function sandboxHandle(instance: SandboxInstance): SandboxHandle {
  return Object.freeze({
    instanceId: instance.instanceId,
    backendKind: instance.backendKind,
    policyFingerprint: instance.policyFingerprint,
    state: instance.state,
  });
}

function checkpointSandboxHandle(identity: AttemptCheckpointIdentity): SandboxHandle {
  return Object.freeze({
    instanceId: identity.sandboxInstanceId,
    backendKind: identity.sandboxBackendKind,
    policyFingerprint: Object.freeze({ policyVersion: 1, digest: identity.sandboxPolicyDigest }),
    state: identity.sandboxState,
  });
}

interface RunHandle {
  readonly abort: AbortController;
  session: HarnessSession | undefined;
  readonly done: Promise<NodeExecutionResult>;
}

type Setup = Readonly<{
  lease: SchedulerLease;
  sandbox: SandboxHandle;
  session: HarnessSession;
  handshake: HarnessHandshake;
  pack: ContextPack;
  initialCheckpoint: AttemptCheckpoint;
}>;

type SuccessKind = "commit" | "artifact" | "no_change";

type ResolvedOutcome = Readonly<{ outcome: NodeOutcome; successKind: SuccessKind | undefined }>;

type StreamOutcome = Readonly<{
  chunks: readonly TranscriptChunk[];
  lastSequence: bigint;
  usage: HarnessUsage;
  output: Readonly<{ bytes: number; truncated: boolean }>;
  result: Extract<HarnessEventPayload, { kind: "result" }> | undefined;
  aborted: boolean;
  resumeFromSequence: bigint;
}>;

const ZERO_USAGE: HarnessUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});

class DefaultExecutionCoordinator implements ExecutionCoordinator {
  readonly #scheduler: SchedulerStore;
  readonly #sandbox: SandboxLifecycle;
  readonly #harness: HarnessAdapter;
  readonly #vcs: VcsBackend;
  readonly #artifacts: ArtifactRegistry;
  readonly #transcripts: TranscriptStore;
  readonly #checkpoints: CheckpointStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #logger: ExecutionCoordinatorLogger;
  readonly #digest: DigestFunction;
  readonly #outputCaptureLimitBytes: number;
  readonly #runs = new Map<AttemptId, RunHandle>();

  constructor(options: ExecutionCoordinatorOptions) {
    this.#scheduler = options.scheduler;
    this.#sandbox = options.sandbox;
    this.#harness = options.harness;
    this.#vcs = options.vcs;
    this.#artifacts = options.artifacts;
    this.#transcripts = options.transcripts;
    this.#checkpoints = options.checkpoints;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#logger = options.logger;
    this.#digest = options.digest ?? defaultDigest;
    this.#outputCaptureLimitBytes =
      options.outputCaptureLimitBytes ?? DEFAULT_OUTPUT_CAPTURE_LIMIT_BYTES;
  }

  runNode(
    request: NodeExecutionRequest,
    options?: Readonly<{ deferOutcomeRecording?: boolean }>,
  ): Promise<NodeExecutionResult> {
    validateNodeExecutionRequest(request);
    const abort = new AbortController();
    const done = this.#runAttempt(request, abort, undefined, options);
    this.#runs.set(request.context.attemptId, { abort, session: undefined, done });
    return done;
  }

  async recordDeferredOutcome(
    request: NodeExecutionRequest,
    result: NodeExecutionResult,
  ): Promise<void> {
    await this.#recordOutcome(request, {
      outcome: result.outcome,
      successKind: result.successKind,
    });
  }

  interrupt(attemptIdValue: AttemptId): Promise<NodeExecutionResult> {
    const handle = this.#runs.get(attemptIdValue);
    if (handle === undefined) {
      return Promise.reject(
        new ExecutionCoordinatorError(
          "not_leased",
          `cannot interrupt attempt ${attemptIdValue}: no active run`,
          attemptIdValue,
        ),
      );
    }
    handle.abort.abort();
    const session = handle.session;
    const sessionInterrupt =
      session === undefined
        ? Promise.resolve()
        : Promise.resolve(session.interrupt()).catch((error: unknown) => {
            this.#logger.log("warn", "harness_interrupt_failed", {
              attempt_id: attemptIdValue,
              error: errorMessage(error),
            });
          });
    return sessionInterrupt.then(() => handle.done);
  }

  resumeFromCheckpoint(
    checkpoint: AttemptCheckpoint,
    request: NodeExecutionRequest,
  ): Promise<NodeExecutionResult> {
    validateNodeExecutionRequest(request);
    if (checkpoint.attemptId !== request.context.attemptId) {
      return Promise.reject(
        new ExecutionCoordinatorError(
          "not_leased",
          "resume checkpoint attempt id does not match request",
          request.context.attemptId,
        ),
      );
    }
    const abort = new AbortController();
    const done = this.#runAttempt(request, abort, checkpoint);
    this.#runs.set(request.context.attemptId, { abort, session: undefined, done });
    return done;
  }

  async #runAttempt(
    request: NodeExecutionRequest,
    abort: AbortController,
    resumeFrom: AttemptCheckpoint | undefined,
    options?: Readonly<{ deferOutcomeRecording?: boolean }>,
  ): Promise<NodeExecutionResult> {
    const attemptIdValue = request.context.attemptId;
    let phase: NodeExecutionPhase = "claimed";
    let setup: Setup | undefined;
    try {
      setup = await this.#setup(request, resumeFrom);
      phase = "streaming";
      const handle = this.#runs.get(attemptIdValue);
      if (handle !== undefined) {
        handle.session = setup.session;
      }
      const stream = await this.#stream(setup, request, abort, resumeFrom);
      phase = "finalizing";
      return await this.#complete(setup, request, stream, options);
    } catch (error) {
      await this.#failClosed(request, setup, phase, error);
      throw toCoordinatorError(error, attemptIdValue);
    } finally {
      this.#runs.delete(attemptIdValue);
    }
  }

  async #setup(
    request: NodeExecutionRequest,
    resumeFrom: AttemptCheckpoint | undefined,
  ): Promise<Setup> {
    const lease = await this.#claimForNode(request);
    let createdInstance: SandboxInstance | undefined;
    let sandbox: SandboxHandle;
    let session: HarnessSession;
    let handshake: HarnessHandshake;
    try {
      if (resumeFrom === undefined) {
        createdInstance = await this.#createSandbox(request);
        await this.#prepareWorkspace(request);
        sandbox = sandboxHandle(createdInstance);
        const started = await this.#startHarness(request);
        handshake = started.handshake;
        session = started.session;
      } else {
        sandbox = checkpointSandboxHandle(resumeFrom.identity);
        session = await this.#resumeHarness(request, resumeFrom);
        handshake = await this.#handshake();
      }
      const pack = renderContextPack(buildContextPackInput(request, handshake), this.#digest);
      if (resumeFrom !== undefined && pack.digest !== resumeFrom.contextDigest) {
        throw new ExecutionCoordinatorError(
          "policy_violation",
          "resumed harness context digest differs from checkpoint; reproducibility broken",
          request.context.attemptId,
        );
      }
      await this.#sendContextPack(session, request, pack);
      const initialCheckpoint = this.#checkpoint(
        request,
        session.identity,
        sandbox,
        pack.digest,
        resumeFrom?.sequence ?? 0n,
        resumeFrom === undefined ? "context_sent" : "streaming",
      );
      await this.#checkpoints.record(initialCheckpoint);
      this.#logger.log("info", "node_execution_context_sent", {
        attempt_id: request.context.attemptId,
        node_id: request.context.nodeId,
        phase: initialCheckpoint.phase,
        context_digest: pack.digest,
        resumed: resumeFrom !== undefined,
      });
      return Object.freeze({ lease, sandbox, session, handshake, pack, initialCheckpoint });
    } catch (error) {
      // Setup-phase failure: fail-closed with no leak. Release the claimed lease
      // and destroy a sandbox created during THIS setup (never the retained resume
      // sandbox — HAR-01 keeps it for rebind). Mid-stream failures are handled by
      // #failClosed, which retains the sandbox for resume.
      if (createdInstance !== undefined) {
        await this.#destroySandbox(sandboxHandle(createdInstance));
      }
      await this.#releaseLease(lease);
      throw error;
    }
  }

  async #claimForNode(request: NodeExecutionRequest): Promise<SchedulerLease> {
    const lease = await this.#scheduler.claimNext({
      ownerId: request.ownerId,
      at: this.#clock.now(),
      leaseDurationMs: request.leaseDurationMs,
      capacity: request.capacity,
    });
    if (lease === undefined) {
      throw new ExecutionCoordinatorError(
        "not_leased",
        `no scheduler lease eligible for node ${request.context.nodeId}`,
        request.context.attemptId,
      );
    }
    if (lease.nodeId !== request.context.nodeId || lease.attemptId !== request.context.attemptId) {
      await this.#releaseLease(lease);
      throw new ExecutionCoordinatorError(
        "not_leased",
        `claimed lease ${lease.nodeId}/${lease.attemptId} does not match request ${request.context.nodeId}/${request.context.attemptId}`,
        request.context.attemptId,
      );
    }
    return lease;
  }

  async #createSandbox(request: NodeExecutionRequest): Promise<SandboxInstance> {
    let probe;
    try {
      probe = await this.#sandbox.probe();
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "sandbox_unavailable",
        `sandbox probe failed: ${errorMessage(error)}`,
        request.context.attemptId,
      );
    }
    if (!probe.available) {
      throw new ExecutionCoordinatorError(
        "sandbox_unavailable",
        `sandbox backend ${probe.backendKind} unavailable: ${probe.message}`,
        request.context.attemptId,
      );
    }
    try {
      return await this.#sandbox.create({
        context: {
          attemptId: request.context.attemptId,
          nodeId: request.context.nodeId,
          repositoryId: request.context.repositoryId,
          hostId: request.context.hostId,
        },
        idempotencyKey: request.context.attemptId,
        policy: request.sandboxPolicy,
        policyFingerprint: request.policyFingerprint,
      });
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "sandbox_unavailable",
        `sandbox create failed: ${errorMessage(error)}`,
        request.context.attemptId,
      );
    }
  }

  async #prepareWorkspace(request: NodeExecutionRequest): Promise<void> {
    await this.#vcs.createWorkingCopyAtCommit({
      attemptId: request.context.attemptId,
      nodeId: request.context.nodeId,
      treeId: request.context.treeId,
      hostId: request.context.hostId,
      repositoryId: request.context.repositoryId,
      ordinal: request.context.attemptOrdinal,
      baseCommit: request.workspace.baseCommit,
      sourcePath: request.workspace.workspacePath,
    });
  }

  async #handshake(): Promise<HarnessHandshake> {
    try {
      return await this.#harness.handshake();
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "harness_unavailable",
        `harness handshake failed: ${errorMessage(error)}`,
      );
    }
  }

  async #startHarness(request: NodeExecutionRequest): Promise<{
    handshake: HarnessHandshake;
    session: HarnessSession;
  }> {
    const handshake = await this.#handshake();
    this.#assertHarnessPolicy(handshake, request);
    try {
      const session = await this.#harness.start({
        context: request.context,
        durableHarnessId: request.durableHarnessId,
      });
      return Object.freeze({ handshake, session });
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "harness_unavailable",
        `harness start failed: ${errorMessage(error)}`,
        request.context.attemptId,
      );
    }
  }

  async #resumeHarness(
    request: NodeExecutionRequest,
    checkpoint: AttemptCheckpoint,
  ): Promise<HarnessSession> {
    try {
      return await this.#harness.resume({
        context: request.context,
        identity: checkpoint.identity.harnessIdentity,
        afterSequence: checkpoint.sequence,
      });
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "harness_unavailable",
        `harness resume failed: ${errorMessage(error)}`,
        request.context.attemptId,
      );
    }
  }

  /**
   * HAR-04: the harness policy forbids subagent spawn — the handshake must not
   * advertise a spawn tool. Required capabilities are feature-detected and
   * fail-closed (HAR: feature-detected capabilities).
   */
  #assertHarnessPolicy(handshake: HarnessHandshake, request: NodeExecutionRequest): void {
    const spawnTool = handshake.tools.find((tool) => isSpawnTool(tool));
    if (spawnTool !== undefined) {
      throw new ExecutionCoordinatorError(
        "policy_violation",
        `harness advertised forbidden spawn tool '${spawnTool}'`,
        request.context.attemptId,
      );
    }
    const missing = missingHarnessCapabilities(handshake, REQUIRED_HARNESS_CAPABILITIES);
    if (missing.length > 0) {
      throw new ExecutionCoordinatorError(
        "harness_unavailable",
        `harness missing required capabilities: ${missing.join(", ")}`,
        request.context.attemptId,
      );
    }
  }

  async #sendContextPack(
    session: HarnessSession,
    request: NodeExecutionRequest,
    pack: ContextPack,
  ): Promise<void> {
    const promptId = this.#ids.nextId();
    try {
      await session.prompt(promptId, canonicalContextPackJson(pack.input));
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "harness_unavailable",
        `failed to send context pack: ${errorMessage(error)}`,
        request.context.attemptId,
      );
    }
  }

  async #stream(
    setup: Setup,
    request: NodeExecutionRequest,
    abort: AbortController,
    resumeFrom: AttemptCheckpoint | undefined,
  ): Promise<StreamOutcome> {
    const attemptIdValue = request.context.attemptId;
    const afterSequence = resumeFrom?.sequence ?? 0n;
    const chunks: TranscriptChunk[] = [];
    let lastSequence = afterSequence;
    let usage: HarnessUsage = ZERO_USAGE;
    const output = new BoundedOutputCapture(this.#outputCaptureLimitBytes);
    let result: Extract<HarnessEventPayload, { kind: "result" }> | undefined;
    try {
      for await (const event of setup.session.events(afterSequence)) {
        if (abort.signal.aborted) break;
        const chunk = toTranscriptChunk(attemptIdValue, event);
        chunks.push(chunk);
        lastSequence = event.sequence;
        usage = accumulateUsage(usage, event.payload);
        output.capture(event.payload);
        await this.#transcripts.append(chunk);
        await this.#checkpoints.record(
          this.#checkpoint(
            request,
            setup.session.identity,
            setup.sandbox,
            setup.pack.digest,
            lastSequence,
            "streaming",
          ),
        );
        if (event.payload.kind === "result") {
          result = event.payload;
          break;
        }
      }
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "harness_unavailable",
        `harness event stream failed: ${errorMessage(error)}`,
        attemptIdValue,
      );
    }
    return Object.freeze({
      chunks,
      lastSequence,
      usage,
      output: output.snapshot(),
      result,
      aborted: abort.signal.aborted,
      resumeFromSequence: afterSequence,
    });
  }

  async #complete(
    setup: Setup,
    request: NodeExecutionRequest,
    stream: StreamOutcome,
    options?: Readonly<{ deferOutcomeRecording?: boolean }>,
  ): Promise<NodeExecutionResult> {
    const attemptIdValue = request.context.attemptId;
    const resolved = await this.#resolveOutcome(request, stream);
    // P1 (review #24): the outcome was previously recorded FIRST, then the
    // final checkpoint written and the lease/sandbox released/destroyed. A
    // crash in that gap left the node durably 'succeeded' with no final
    // checkpoint - an unrecoverable coordinator state (the durable outcome
    // says done, but there is nothing to resume/reconcile from). Write the
    // final checkpoint FIRST, so any later failure leaves the node without
    // a durable outcome (still retry/resume-eligible) rather than
    // succeeded-but-uncheckpointed.
    //
    // P0 fix (review #27): recording success here - before a caller-side gate
    // (e.g. bounded repair-retry) has run - makes the node `succeeded` and
    // unblocks children/exits retry-eligibility before the gate is known to
    // pass. `deferOutcomeRecording` lets such a caller resolve+inspect the
    // outcome without committing it; it must then call
    // `recordDeferredOutcome` itself once its own gate passes. The normal
    // (non-deferred) path is byte-for-byte the previous unconditional call,
    // and still runs AFTER the final checkpoint per the #24 fix above.
    const finalCheckpoint = this.#checkpoint(
      request,
      setup.session.identity,
      setup.sandbox,
      setup.pack.digest,
      stream.lastSequence,
      "finalizing",
    );
    await this.#checkpoints.record(finalCheckpoint);
    if (!options?.deferOutcomeRecording) {
      await this.#recordOutcome(request, resolved);
    }
    await this.#releaseLease(setup.lease);
    await this.#destroySandbox(setup.sandbox);
    const transcript = await this.#transcriptSummary(attemptIdValue);
    this.#logger.log("info", "node_execution_completed", {
      attempt_id: attemptIdValue,
      node_id: request.context.nodeId,
      outcome_kind: resolved.outcome.kind,
      context_digest: setup.pack.digest,
      outcome_recording_deferred: options?.deferOutcomeRecording === true,
    });
    return Object.freeze({
      attemptId: attemptIdValue,
      nodeId: request.context.nodeId,
      outcome: resolved.outcome,
      successKind: resolved.successKind,
      transcript,
      checkpoints: Object.freeze({ initial: setup.initialCheckpoint, final: finalCheckpoint }),
      contextDigest: setup.pack.digest,
      recordedAt: this.#clock.now(),
    });
  }

  async #resolveOutcome(
    request: NodeExecutionRequest,
    stream: StreamOutcome,
  ): Promise<ResolvedOutcome> {
    if (stream.result !== undefined) {
      if (stream.result.outcome === "cancelled") {
        return {
          outcome: this.#outcome(
            request,
            "cancelled",
            stream.result.text,
            [],
            undefined,
            stream.usage,
          ),
          successKind: undefined,
        };
      }
      if (stream.result.outcome === "failed") {
        return {
          outcome: this.#outcome(
            request,
            "failed",
            stream.result.text,
            [],
            undefined,
            stream.usage,
          ),
          successKind: undefined,
        };
      }
    } else if (stream.aborted) {
      return {
        outcome: this.#outcome(
          request,
          "cancelled",
          "node execution interrupted",
          [],
          undefined,
          stream.usage,
        ),
        successKind: undefined,
      };
    } else {
      throw new ExecutionCoordinatorError(
        "harness_unavailable",
        "harness event stream ended without a terminal result",
        request.context.attemptId,
      );
    }
    return this.#resolveSucceededOutcome(request, stream);
  }

  async #resolveSucceededOutcome(
    request: NodeExecutionRequest,
    stream: StreamOutcome,
  ): Promise<ResolvedOutcome> {
    const attemptIdValue = request.context.attemptId;
    const artifacts = collectArtifactRefs(stream.chunks);
    const diff = await this.#captureDiff(attemptIdValue);
    if (diff.length > 0) {
      const head = await this.#commitChanges(request);
      const text = stream.result?.text ?? "node execution produced file changes";
      return {
        outcome: this.#outcome(request, "succeeded", text, artifacts, head, stream.usage),
        successKind: "commit",
      };
    }
    if (artifacts.length > 0) {
      const text = stream.result?.text ?? "node execution produced an artifact";
      return {
        outcome: this.#outcome(request, "succeeded", text, artifacts, undefined, stream.usage),
        successKind: "artifact",
      };
    }
    const head = await this.#resolveHead(attemptIdValue);
    const text = stream.result?.text ?? "node execution produced no changes";
    return {
      outcome: this.#outcome(request, "succeeded", text, artifacts, head, stream.usage),
      successKind: "no_change",
    };
  }

  async #captureDiff(attemptIdValue: AttemptId): Promise<Uint8Array> {
    try {
      const diff = await this.#vcs.captureDiff({ attemptId: attemptIdValue });
      return diff.diff;
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "outcome_failed",
        `vcs captureDiff failed: ${errorMessage(error)}`,
        attemptIdValue,
      );
    }
  }

  async #commitChanges(request: NodeExecutionRequest): Promise<GitSha> {
    try {
      const receipt = await this.#vcs.commit({
        attemptId: request.context.attemptId,
        message: nonEmptyText(`node ${request.context.nodeId} execution commit`, "commit message"),
      });
      return receipt.headCommit;
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "outcome_failed",
        `vcs commit failed: ${errorMessage(error)}`,
        request.context.attemptId,
      );
    }
  }

  async #resolveHead(attemptIdValue: AttemptId): Promise<GitSha> {
    try {
      return await this.#vcs.resolveHead({ attemptId: attemptIdValue });
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "outcome_failed",
        `vcs resolveHead failed: ${errorMessage(error)}`,
        attemptIdValue,
      );
    }
  }

  #outcome(
    request: NodeExecutionRequest,
    kind: NodeOutcomeKind,
    text: string,
    artifacts: readonly ArtifactRef[],
    revision: GitSha | undefined,
    usage: HarnessUsage,
  ): NodeOutcome {
    return Object.freeze({
      nodeId: request.context.nodeId,
      attemptId: request.context.attemptId,
      kind,
      text,
      artifacts: [...artifacts],
      revision,
      usage,
    });
  }

  async #recordOutcome(request: NodeExecutionRequest, resolved: ResolvedOutcome): Promise<void> {
    if (resolved.successKind === undefined) return;
    const recorded = this.#toRecordedOutcome(request, resolved);
    try {
      await this.#artifacts.recordOutcome({
        commandId: commandId(this.#ids.nextId()),
        actorSessionId: request.recording.actorSessionId,
        nodeId: request.context.nodeId,
        expectedNodeVersion: request.recording.expectedNodeVersion ?? 0,
        outcome: recorded,
        at: this.#clock.now(),
      });
    } catch (error) {
      throw new ExecutionCoordinatorError(
        "outcome_failed",
        `recording node outcome failed: ${errorMessage(error)}`,
        request.context.attemptId,
      );
    }
  }

  #toRecordedOutcome(
    request: NodeExecutionRequest,
    resolved: ResolvedOutcome,
  ): RecordedNodeOutcome {
    const outcome = resolved.outcome;
    const evidence = evidenceId(this.#ids.nextId());
    if (resolved.successKind === "commit") {
      const commit: CommitNodeOutcome = Object.freeze({
        kind: "commit",
        revision: outcome.revision ?? request.workspace.headCommit,
        evidenceId: evidence,
      });
      return commit;
    }
    if (resolved.successKind === "artifact") {
      const firstArtifact = outcome.artifacts[0];
      if (firstArtifact === undefined) {
        throw new ExecutionCoordinatorError(
          "outcome_failed",
          "artifact outcome is missing its artifact reference",
          request.context.attemptId,
        );
      }
      const artifact: ArtifactNodeOutcome = Object.freeze({
        kind: "artifact",
        artifactId: firstArtifact.artifactId,
      });
      return artifact;
    }
    const noChange: NoChangeNodeOutcome = Object.freeze({
      kind: "no_change",
      revision: outcome.revision ?? request.workspace.headCommit,
      evidenceId: evidence,
      explanation: nonEmptyText(outcome.text, "no-change explanation"),
    });
    return noChange;
  }

  async #failClosed(
    request: NodeExecutionRequest,
    setup: Setup | undefined,
    phase: NodeExecutionPhase,
    error: unknown,
  ): Promise<void> {
    const attemptIdValue = request.context.attemptId;
    const streamingStarted = setup !== undefined && phase !== "claimed";
    if (setup !== undefined) {
      if (streamingStarted) {
        await this.#recordFailureCheckpoint(setup, request);
      }
      await this.#releaseLease(setup.lease);
      // Retain the sandbox on mid-stream harness death so resume can rebind it
      // (HAR-01); destroy on setup-phase failures (no leaked sandbox/process).
      if (!streamingStarted) {
        await this.#destroySandbox(setup.sandbox);
      }
    }
    this.#logger.log("error", "node_execution_failed_closed", {
      attempt_id: attemptIdValue,
      node_id: request.context.nodeId,
      phase,
      error: errorMessage(error),
      retained_sandbox: streamingStarted,
    });
  }

  async #recordFailureCheckpoint(setup: Setup, request: NodeExecutionRequest): Promise<void> {
    let sequence: bigint;
    try {
      sequence = await this.#transcripts.latestSequence(request.context.attemptId);
    } catch {
      sequence = 0n;
    }
    const checkpoint = this.#checkpoint(
      request,
      setup.session.identity,
      setup.sandbox,
      setup.pack.digest,
      sequence,
      "streaming",
    );
    await this.#checkpoints.record(checkpoint).catch((recordError: unknown) => {
      this.#logger.log("warn", "failure_checkpoint_failed", {
        attempt_id: request.context.attemptId,
        error: errorMessage(recordError),
      });
    });
  }

  #checkpoint(
    request: NodeExecutionRequest,
    identity: HarnessSessionIdentity,
    sandbox: SandboxHandle,
    contextDigest: ContentHash,
    sequence: bigint,
    phase: NodeExecutionPhase,
  ): AttemptCheckpoint {
    const checkpointIdentity: AttemptCheckpointIdentity = Object.freeze({
      harnessIdentity: identity,
      sandboxInstanceId: sandbox.instanceId,
      sandboxBackendKind: sandbox.backendKind,
      sandboxPolicyDigest: sandbox.policyFingerprint.digest,
      sandboxState: sandbox.state,
    });
    return Object.freeze({
      attemptId: request.context.attemptId,
      nodeId: request.context.nodeId,
      sequence,
      phase,
      identity: checkpointIdentity,
      contextDigest,
      recordedAt: this.#clock.now(),
    });
  }

  async #releaseLease(lease: SchedulerLease): Promise<void> {
    await this.#scheduler
      .release({
        lease: { id: lease.id, ownerId: lease.ownerId, fencingToken: lease.fencingToken },
        at: this.#clock.now(),
      })
      .catch((error: unknown) => {
        this.#logger.log("warn", "lease_release_failed", {
          lease_id: lease.id,
          error: errorMessage(error),
        });
      });
  }

  async #destroySandbox(sandbox: SandboxHandle): Promise<void> {
    await this.#sandbox
      .destroy(sandbox.instanceId, sandbox.policyFingerprint)
      .catch((error: unknown) => {
        this.#logger.log("warn", "sandbox_destroy_failed", {
          instance_id: sandbox.instanceId,
          error: errorMessage(error),
        });
      });
  }

  async #transcriptSummary(
    attemptIdValue: AttemptId,
  ): Promise<{ firstSequence: bigint; lastSequence: bigint; chunkCount: number }> {
    const all = await this.#transcripts.readAll(attemptIdValue);
    const first = all[0]?.sequence ?? 0n;
    const last = all[all.length - 1]?.sequence ?? 0n;
    return Object.freeze({ firstSequence: first, lastSequence: last, chunkCount: all.length });
  }
}

/** HAR-08: bounded output capture. */
class BoundedOutputCapture {
  readonly #limit: number;
  #bytes = 0;
  #truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  capture(payload: HarnessEventPayload): void {
    if (this.#truncated) return;
    const text = messageText(payload);
    if (text === undefined) return;
    const remaining = this.#limit - this.#bytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    if (text.length <= remaining) {
      this.#bytes += text.length;
      return;
    }
    this.#bytes = this.#limit;
    this.#truncated = true;
  }

  snapshot(): Readonly<{ bytes: number; truncated: boolean }> {
    return Object.freeze({ bytes: this.#bytes, truncated: this.#truncated });
  }
}

function messageText(payload: HarnessEventPayload): string | undefined {
  switch (payload.kind) {
    case "message":
    case "thinking":
    case "result":
      return payload.text;
    case "tool_result":
      return typeof payload.output === "string" ? payload.output : undefined;
    case "error":
      return payload.message;
    case "tool_call":
    case "prompt_started":
    case "prompt_finished":
    case "turn_started":
    case "turn_finished":
    case "usage":
    case "retry":
    case "question":
      return undefined;
  }
}

function accumulateUsage(current: HarnessUsage, payload: HarnessEventPayload): HarnessUsage {
  if (payload.kind !== "usage") return current;
  return Object.freeze({
    inputTokens: current.inputTokens + payload.usage.inputTokens,
    outputTokens: current.outputTokens + payload.usage.outputTokens,
    cachedInputTokens: current.cachedInputTokens + payload.usage.cachedInputTokens,
  });
}

function collectArtifactRefs(chunks: readonly TranscriptChunk[]): readonly ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const chunk of chunks) {
    const payload = chunk.payload;
    if (payload.kind !== "tool_result") continue;
    const ref = artifactRefFromOutput(payload.output);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function artifactRefFromOutput(output: JsonValue): ArtifactRef | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const record = output as Record<string, JsonValue>;
  const artifactIdValue = record["artifactId"];
  const contentDigestValue = record["contentDigest"];
  if (
    typeof artifactIdValue !== "string" ||
    typeof contentDigestValue !== "string" ||
    !UUID_PATTERN.test(artifactIdValue) ||
    !DIGEST_PATTERN.test(contentDigestValue)
  ) {
    return undefined;
  }
  return Object.freeze({
    artifactId: artifactId(artifactIdValue),
    contentDigest: contentHash(contentDigestValue),
  });
}

function isSpawnTool(tool: string): boolean {
  const name = tool.toLowerCase();
  return SPAWN_TOOL_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}_`));
}

function toCoordinatorError(error: unknown, attemptIdValue: AttemptId | undefined): Error {
  if (error instanceof ExecutionCoordinatorError) return error;
  return new ExecutionCoordinatorError(
    "harness_unavailable",
    `unexpected coordinator failure: ${errorMessage(error)}`,
    attemptIdValue,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
