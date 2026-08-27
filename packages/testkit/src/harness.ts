import type {
  HarnessAdapter,
  HarnessAttemptContext,
  HarnessCapability,
  HarnessEvent,
  HarnessEventPayload,
  HarnessHandshake,
  HarnessSession,
  HarnessSessionIdentity,
  HarnessSessionSnapshot,
  ResumeHarnessSessionRequest,
  StartHarnessSessionRequest,
  Timestamp,
} from "@minions/core";

export type DeterministicHarnessEvent = Readonly<{
  occurredAt: Timestamp;
  payload: HarnessEventPayload;
}>;

type FixtureStepBase = Readonly<{
  events: readonly DeterministicHarnessEvent[];
}>;

export type DeterministicHarnessStartStep = FixtureStepBase &
  Readonly<{
    kind: "start";
    context: HarnessAttemptContext;
    durableHarnessId: string;
    identity: HarnessSessionIdentity;
  }>;

export type DeterministicHarnessResumeStep = FixtureStepBase &
  Readonly<{
    kind: "resume";
    context: HarnessAttemptContext;
    identity: HarnessSessionIdentity;
    afterSequence: bigint;
  }>;

export type DeterministicHarnessPromptStep = FixtureStepBase &
  Readonly<{
    kind: "prompt";
    promptId: string;
    text: string;
  }>;

export type DeterministicHarnessSteerStep = FixtureStepBase &
  Readonly<{
    kind: "steer";
    text: string;
  }>;

export type DeterministicHarnessFollowUpStep = FixtureStepBase &
  Readonly<{
    kind: "follow_up";
    promptId: string;
    text: string;
  }>;

export type DeterministicHarnessInterruptStep = FixtureStepBase &
  Readonly<{
    kind: "interrupt";
  }>;

export type DeterministicHarnessAbortStep = FixtureStepBase &
  Readonly<{
    kind: "abort";
  }>;

export type DeterministicHarnessSnapshotStep = FixtureStepBase &
  Readonly<{
    kind: "snapshot";
    snapshot: HarnessSessionSnapshot;
  }>;

export type DeterministicHarnessFixtureStep =
  | DeterministicHarnessStartStep
  | DeterministicHarnessResumeStep
  | DeterministicHarnessPromptStep
  | DeterministicHarnessSteerStep
  | DeterministicHarnessFollowUpStep
  | DeterministicHarnessInterruptStep
  | DeterministicHarnessAbortStep
  | DeterministicHarnessSnapshotStep;

export type DeterministicHarnessFixture = Readonly<{
  handshake: HarnessHandshake;
  steps: readonly DeterministicHarnessFixtureStep[];
}>;

export type DeterministicHarnessFixtureErrorCode =
  | "invalid_fixture"
  | "fixture_exhausted"
  | "unexpected_operation"
  | "session_not_started"
  | "session_identity_mismatch"
  | "invalid_cursor"
  | "event_consumer_active"
  | "missing_capability"
  | "session_terminal";
export class DeterministicHarnessFixtureError extends Error {
  readonly code: DeterministicHarnessFixtureErrorCode;

  constructor(code: DeterministicHarnessFixtureErrorCode, message: string) {
    super(message);
    this.name = "DeterministicHarnessFixtureError";
    this.code = code;
  }
}

const harnessCapabilities = new Set([
  "steer",
  "follow_up",
  "interrupt",
  "abort",
  "resume",
  "snapshot",
]);
const sessionStates = new Set(["idle", "running", "interrupted", "finished", "aborted"]);
const payloadKinds = new Set([
  "message",
  "thinking",
  "tool_call",
  "tool_result",
  "prompt_started",
  "prompt_finished",
  "turn_started",
  "turn_finished",
  "usage",
  "retry",
  "question",
  "error",
  "result",
]);
const digestPattern = /^[0-9a-f]{64}$/u;

interface FixtureRecord {
  readonly [key: string]: unknown;
  readonly durableHarnessId?: unknown;
  readonly sessionId?: unknown;
  readonly attemptId?: unknown;
  readonly attemptOrdinal?: unknown;
  readonly nodeId?: unknown;
  readonly treeId?: unknown;
  readonly repositoryId?: unknown;
  readonly hostId?: unknown;
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly cachedInputTokens?: unknown;
  readonly kind?: unknown;
  readonly role?: unknown;
  readonly text?: unknown;
  readonly callId?: unknown;
  readonly tool?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly failed?: unknown;
  readonly promptId?: unknown;
  readonly turnId?: unknown;
  readonly usage?: unknown;
  readonly providerRequestOrdinal?: unknown;
  readonly reason?: unknown;
  readonly questionId?: unknown;
  readonly prompt?: unknown;
  readonly choices?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly retryable?: unknown;
  readonly outcome?: unknown;
  readonly occurredAt?: unknown;
  readonly payload?: unknown;
  readonly identity?: unknown;
  readonly nextEventSequence?: unknown;
  readonly state?: unknown;
  readonly harnessKind?: unknown;
  readonly harnessVersion?: unknown;
  readonly providerKind?: unknown;
  readonly model?: unknown;
  readonly reasoningLevel?: unknown;
  readonly capabilities?: unknown;
  readonly tools?: unknown;
  readonly securityPolicyDigest?: unknown;
  readonly context?: unknown;
  readonly events?: unknown;
  readonly snapshot?: unknown;
  readonly afterSequence?: unknown;
}
type EventStreamResult = IteratorResult<HarnessEvent>;
type EventStreamWaiter = (result: EventStreamResult) => void;

function fixtureError(message: string): DeterministicHarnessFixtureError {
  return new DeterministicHarnessFixtureError("invalid_fixture", message);
}

function asRecord(value: unknown, path: string): FixtureRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw fixtureError(`${path} must be a plain object`);
  }
  return value as FixtureRecord;
}

function requireKeys(record: FixtureRecord, expected: readonly string[], path: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fixtureError(
      `${path} must contain exactly ${wanted.join(", ")} (received ${actual.join(", ")})`,
    );
  }
}

function requireString(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
    throw fixtureError(`${path} must be ${nonEmpty ? "a non-empty" : "a"} string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw fixtureError(`${path} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeBigInt(value: unknown, path: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw fixtureError(`${path} must be a non-negative bigint`);
  }
  return value;
}

function requireTimestamp(value: unknown, path: string): Timestamp {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw fixtureError(`${path} must be a non-negative safe integer timestamp`);
  }
  return value as Timestamp;
}

function validateJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw fixtureError(`${path} must contain only finite JSON numbers`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw fixtureError(`${path} must be a JSON value`);
  }
  if (ancestors.has(value)) {
    throw fixtureError(`${path} must not contain a cycle`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateJsonValue(entry, `${path}[${String(index)}]`, ancestors);
    });
  } else {
    const record = asRecord(value, path);
    Object.keys(record).forEach((key) => {
      validateJsonValue(record[key], `${path}.${key}`, ancestors);
    });
  }
  ancestors.delete(value);
}

function validateIdentity(value: unknown, path: string): void {
  const record = asRecord(value, path);
  requireKeys(record, ["durableHarnessId", "sessionId"], path);
  requireString(record.durableHarnessId, `${path}.durableHarnessId`, true);
  requireString(record.sessionId, `${path}.sessionId`, true);
}

function validateContext(value: unknown, path: string): void {
  const record = asRecord(value, path);
  requireKeys(
    record,
    ["attemptId", "attemptOrdinal", "nodeId", "treeId", "repositoryId", "hostId"],
    path,
  );
  requireString(record.attemptId, `${path}.attemptId`, true);
  requirePositiveInteger(record.attemptOrdinal, `${path}.attemptOrdinal`);
  requireString(record.nodeId, `${path}.nodeId`, true);
  requireString(record.treeId, `${path}.treeId`, true);
  requireString(record.repositoryId, `${path}.repositoryId`, true);
  requireString(record.hostId, `${path}.hostId`, true);
}

function validateUsage(value: unknown, path: string): void {
  const record = asRecord(value, path);
  requireKeys(record, ["inputTokens", "outputTokens", "cachedInputTokens"], path);
  requireNonNegativeInteger(record.inputTokens, `${path}.inputTokens`);
  requireNonNegativeInteger(record.outputTokens, `${path}.outputTokens`);
  requireNonNegativeInteger(record.cachedInputTokens, `${path}.cachedInputTokens`);
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw fixtureError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function validatePayload(value: unknown, path: string): void {
  const record = asRecord(value, path);
  const kind = requireString(record.kind, `${path}.kind`);
  if (!payloadKinds.has(kind)) {
    throw fixtureError(`${path}.kind is not a supported harness event kind: ${kind}`);
  }
  switch (kind) {
    case "message":
      requireKeys(record, ["kind", "role", "text"], path);
      if (record.role !== "assistant" && record.role !== "system" && record.role !== "user") {
        throw fixtureError(`${path}.role must be assistant, system, or user`);
      }
      requireString(record.text, `${path}.text`);
      return;
    case "thinking":
      requireKeys(record, ["kind", "text"], path);
      requireString(record.text, `${path}.text`);
      return;
    case "tool_call":
      requireKeys(record, ["kind", "callId", "tool", "input"], path);
      requireString(record.callId, `${path}.callId`, true);
      requireString(record.tool, `${path}.tool`, true);
      validateJsonValue(record.input, `${path}.input`, new Set());
      return;
    case "tool_result":
      requireKeys(record, ["kind", "callId", "output", "failed"], path);
      requireString(record.callId, `${path}.callId`, true);
      validateJsonValue(record.output, `${path}.output`, new Set());
      if (typeof record.failed !== "boolean") {
        throw fixtureError(`${path}.failed must be a boolean`);
      }
      return;
    case "prompt_started":
    case "prompt_finished":
      requireKeys(record, ["kind", "promptId"], path);
      requireString(record.promptId, `${path}.promptId`, true);
      return;
    case "turn_started":
    case "turn_finished":
      requireKeys(record, ["kind", "turnId"], path);
      requireString(record.turnId, `${path}.turnId`, true);
      return;
    case "usage":
      requireKeys(record, ["kind", "usage"], path);
      validateUsage(record.usage, `${path}.usage`);
      return;
    case "retry":
      requireKeys(record, ["kind", "providerRequestOrdinal", "reason"], path);
      requirePositiveInteger(record.providerRequestOrdinal, `${path}.providerRequestOrdinal`);
      requireString(record.reason, `${path}.reason`);
      return;
    case "question":
      requireKeys(record, ["kind", "questionId", "prompt", "choices"], path);
      requireString(record.questionId, `${path}.questionId`, true);
      requireString(record.prompt, `${path}.prompt`);
      if (!Array.isArray(record.choices)) {
        throw fixtureError(`${path}.choices must be an array`);
      }
      record.choices.forEach((choice, index) =>
        requireString(choice, `${path}.choices[${String(index)}]`),
      );
      return;
    case "error":
      requireKeys(record, ["kind", "code", "message", "retryable"], path);
      requireString(record.code, `${path}.code`, true);
      requireString(record.message, `${path}.message`);
      if (typeof record.retryable !== "boolean") {
        throw fixtureError(`${path}.retryable must be a boolean`);
      }
      return;
    case "result":
      requireKeys(record, ["kind", "outcome", "text"], path);
      if (
        record.outcome !== "succeeded" &&
        record.outcome !== "failed" &&
        record.outcome !== "cancelled"
      ) {
        throw fixtureError(`${path}.outcome must be succeeded, failed, or cancelled`);
      }
      requireString(record.text, `${path}.text`);
      return;
  }
}

function validateEvents(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw fixtureError(`${path} must be an array`);
  }
  value.forEach((entry, index) => {
    const eventPath = `${path}[${String(index)}]`;
    const record = asRecord(entry, eventPath);
    requireKeys(record, ["occurredAt", "payload"], eventPath);
    requireTimestamp(record.occurredAt, `${eventPath}.occurredAt`);
    validatePayload(record.payload, `${eventPath}.payload`);
  });
}

function validateSnapshot(value: unknown, path: string): void {
  const record = asRecord(value, path);
  requireKeys(record, ["identity", "nextEventSequence", "state"], path);
  validateIdentity(record.identity, `${path}.identity`);
  const nextEventSequence = requireNonNegativeBigInt(
    record.nextEventSequence,
    `${path}.nextEventSequence`,
  );
  if (nextEventSequence === 0n) {
    throw fixtureError(`${path}.nextEventSequence must be positive`);
  }
  if (typeof record.state !== "string" || !sessionStates.has(record.state)) {
    throw fixtureError(`${path}.state is not a valid harness session state`);
  }
}

function validateHandshake(value: unknown): void {
  const record = asRecord(value, "fixture.handshake");
  requireKeys(
    record,
    [
      "harnessKind",
      "harnessVersion",
      "providerKind",
      "model",
      "reasoningLevel",
      "capabilities",
      "tools",
      "securityPolicyDigest",
    ],
    "fixture.handshake",
  );
  requireString(record.harnessKind, "fixture.handshake.harnessKind", true);
  requireString(record.harnessVersion, "fixture.handshake.harnessVersion", true);
  requireString(record.providerKind, "fixture.handshake.providerKind", true);
  requireString(record.model, "fixture.handshake.model", true);
  requireString(record.reasoningLevel, "fixture.handshake.reasoningLevel", true);
  if (!Array.isArray(record.capabilities)) {
    throw fixtureError("fixture.handshake.capabilities must be an array");
  }
  const seenCapabilities = new Set<string>();
  record.capabilities.forEach((capability, index) => {
    const path = `fixture.handshake.capabilities[${String(index)}]`;
    const value = requireString(capability, path, true);
    if (!harnessCapabilities.has(value)) {
      throw fixtureError(`${path} is not a supported harness capability`);
    }
    if (seenCapabilities.has(value)) {
      throw fixtureError(`${path} is duplicated`);
    }
    seenCapabilities.add(value);
  });
  if (!Array.isArray(record.tools)) {
    throw fixtureError("fixture.handshake.tools must be an array");
  }
  const seenTools = new Set<string>();
  record.tools.forEach((tool, index) => {
    const path = `fixture.handshake.tools[${String(index)}]`;
    const value = requireString(tool, path, true);
    if (seenTools.has(value)) {
      throw fixtureError(`${path} is duplicated`);
    }
    seenTools.add(value);
  });
  const digest = requireString(
    record.securityPolicyDigest,
    "fixture.handshake.securityPolicyDigest",
    true,
  );
  if (!digestPattern.test(digest)) {
    throw fixtureError("fixture.handshake.securityPolicyDigest must be a lowercase SHA-256 digest");
  }
}

function validateStep(value: unknown, index: number): void {
  const path = `fixture.steps[${String(index)}]`;
  const record = asRecord(value, path);
  const kind = requireString(record.kind, `${path}.kind`);
  switch (kind) {
    case "start":
      requireKeys(record, ["kind", "context", "durableHarnessId", "identity", "events"], path);
      validateContext(record.context, `${path}.context`);
      requireString(record.durableHarnessId, `${path}.durableHarnessId`, true);
      validateIdentity(record.identity, `${path}.identity`);
      validateEvents(record.events, `${path}.events`);
      return;
    case "resume":
      requireKeys(record, ["kind", "context", "identity", "afterSequence", "events"], path);
      validateContext(record.context, `${path}.context`);
      validateIdentity(record.identity, `${path}.identity`);
      requireNonNegativeBigInt(record.afterSequence, `${path}.afterSequence`);
      validateEvents(record.events, `${path}.events`);
      return;
    case "prompt":
      requireKeys(record, ["kind", "promptId", "text", "events"], path);
      requireString(record.promptId, `${path}.promptId`, true);
      requireString(record.text, `${path}.text`);
      validateEvents(record.events, `${path}.events`);
      return;
    case "steer":
      requireKeys(record, ["kind", "text", "events"], path);
      requireString(record.text, `${path}.text`);
      validateEvents(record.events, `${path}.events`);
      return;
    case "follow_up":
      requireKeys(record, ["kind", "promptId", "text", "events"], path);
      requireString(record.promptId, `${path}.promptId`, true);
      requireString(record.text, `${path}.text`);
      validateEvents(record.events, `${path}.events`);
      return;
    case "interrupt":
      requireKeys(record, ["kind", "events"], path);
      validateEvents(record.events, `${path}.events`);
      return;
    case "abort":
      requireKeys(record, ["kind", "events"], path);
      validateEvents(record.events, `${path}.events`);
      return;
    case "snapshot":
      requireKeys(record, ["kind", "snapshot", "events"], path);
      validateSnapshot(record.snapshot, `${path}.snapshot`);
      validateEvents(record.events, `${path}.events`);
      return;
    default:
      throw fixtureError(`${path}.kind is not a supported fixture operation`);
  }
}

function cloneAndFreeze(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    throw fixtureError("fixture must not contain cycles");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const clone = value.map((entry) => cloneAndFreeze(entry, ancestors));
    ancestors.delete(value);
    return Object.freeze(clone);
  }
  const source = asRecord(value, "fixture");
  const clone = Object.create(null) as Record<string, unknown>;
  Object.keys(source).forEach((key) => {
    clone[key] = cloneAndFreeze(source[key], ancestors);
  });
  ancestors.delete(value);
  return Object.freeze(clone);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  const leftRecord = left as FixtureRecord;
  const rightRecord = right as FixtureRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function operationDescription(operation: FixtureOperation): string {
  return operation.kind;
}

type FixtureOperation =
  | Readonly<{
      kind: "start";
      context: HarnessAttemptContext;
      durableHarnessId: string;
    }>
  | Readonly<{
      kind: "resume";
      context: HarnessAttemptContext;
      identity: HarnessSessionIdentity;
      afterSequence: bigint;
    }>
  | Readonly<{
      kind: "prompt";
      promptId: string;
      text: string;
    }>
  | Readonly<{
      kind: "steer";
      text: string;
    }>
  | Readonly<{
      kind: "follow_up";
      promptId: string;
      text: string;
    }>
  | Readonly<{ kind: "interrupt" }>
  | Readonly<{ kind: "abort" }>
  | Readonly<{ kind: "snapshot" }>;
type CapabilityChecker = (capability: HarnessCapability) => void;

function isFixtureStepKind<K extends DeterministicHarnessFixtureStep["kind"]>(
  value: DeterministicHarnessFixtureStep,
  kind: K,
): value is Extract<DeterministicHarnessFixtureStep, Readonly<{ kind: K }>> {
  return value.kind === kind;
}
function validateFixtureLifecycle(
  steps: readonly DeterministicHarnessFixtureStep[],
  start: DeterministicHarnessStartStep,
): void {
  if (start.identity.durableHarnessId !== start.durableHarnessId) {
    throw fixtureError("fixture start identity must preserve durableHarnessId");
  }
  let emittedTail = 0n;
  let terminalSeen = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) {
      throw fixtureError(`fixture.steps[${String(index)}] is missing`);
    }
    if (index > 0 && step.kind === "start") {
      throw fixtureError(`fixture.steps[${String(index)}] must not contain a second start step`);
    }
    if (terminalSeen) {
      throw fixtureError(`fixture.steps[${String(index)}] follows a terminal session result`);
    }
    if (step.kind === "resume") {
      if (!valuesEqual(step.identity, start.identity)) {
        throw fixtureError(
          `fixture.steps[${String(index)}].identity must preserve the start identity`,
        );
      }
      if (
        step.context.nodeId !== start.context.nodeId ||
        step.context.treeId !== start.context.treeId ||
        step.context.repositoryId !== start.context.repositoryId ||
        step.context.hostId !== start.context.hostId
      ) {
        throw fixtureError(
          `fixture.steps[${String(index)}].context must preserve the start node binding`,
        );
      }
      if (step.afterSequence > emittedTail) {
        throw fixtureError(
          `fixture.steps[${String(index)}].afterSequence must not exceed emitted event sequence ${String(emittedTail)}`,
        );
      }
    }
    if (step.kind === "snapshot" && !valuesEqual(step.snapshot.identity, start.identity)) {
      throw fixtureError(
        `fixture.steps[${String(index)}].snapshot.identity must preserve the start identity`,
      );
    }
    let resultSeen = false;
    for (let eventIndex = 0; eventIndex < step.events.length; eventIndex += 1) {
      const fixtureEvent = step.events[eventIndex];
      if (fixtureEvent === undefined) {
        throw fixtureError(
          `fixture.steps[${String(index)}].events[${String(eventIndex)}] is missing`,
        );
      }
      if (resultSeen) {
        throw fixtureError(
          `fixture.steps[${String(index)}].events must not emit events after a terminal result`,
        );
      }
      if (fixtureEvent.payload.kind === "result") {
        if (eventIndex !== step.events.length - 1) {
          throw fixtureError(
            `fixture.steps[${String(index)}].events must not emit events after a terminal result`,
          );
        }
        resultSeen = true;
      }
    }
    emittedTail += BigInt(step.events.length);
    if (resultSeen || step.kind === "abort") {
      terminalSeen = true;
    }
  }
}

class DeterministicHarnessEventStream implements AsyncIterableIterator<HarnessEvent> {
  readonly #session: DeterministicHarnessSession;
  #cursor: number;
  #done = false;
  #waiter: EventStreamWaiter | undefined;

  constructor(session: DeterministicHarnessSession, afterSequence: bigint) {
    this.#session = session;
    this.#cursor = session.firstEventAfter(afterSequence);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<HarnessEvent> {
    return this;
  }

  next(): Promise<EventStreamResult> {
    if (this.#done) {
      return Promise.resolve({ done: true, value: undefined });
    }
    if (this.#waiter !== undefined) {
      return Promise.reject(new Error("harness event stream next() is already pending"));
    }
    const result = this.pull();
    if (result !== undefined) {
      return Promise.resolve(result);
    }
    return new Promise<EventStreamResult>((resolve) => {
      this.#waiter = resolve;
    });
  }

  return(): Promise<EventStreamResult> {
    this.finish();
    return Promise.resolve({ done: true, value: undefined });
  }

  throw(error?: unknown): Promise<EventStreamResult> {
    this.finish();
    const reason = error instanceof Error ? error : new Error(String(error));
    return Promise.reject(reason);
  }

  wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter === undefined) {
      return;
    }
    const result = this.pull();
    if (result === undefined) {
      this.#waiter = waiter;
      return;
    }
    waiter(result);
  }

  finishFromSession(): void {
    this.finish();
  }

  private pull(): EventStreamResult | undefined {
    const event = this.#session.eventAt(this.#cursor);
    if (event !== undefined) {
      this.#cursor += 1;
      return { done: false, value: event };
    }
    if (this.#session.eventStreamClosed) {
      this.finish();
      return { done: true, value: undefined };
    }
    return undefined;
  }

  private finish(): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#session.releaseEventStream(this);
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }
}

class DeterministicHarnessSession implements HarnessSession {
  readonly identity: HarnessSessionIdentity;
  readonly #consumeStep: (operation: FixtureOperation) => DeterministicHarnessFixtureStep;
  readonly #requireCapability: CapabilityChecker;
  readonly #events: HarnessEvent[] = [];
  #nextEventSequence = 1n;
  #state: HarnessSessionSnapshot["state"] = "idle";
  #eventStreamClosed = false;
  #eventStream: DeterministicHarnessEventStream | undefined;
  #disposed = false;

  constructor(
    identity: HarnessSessionIdentity,
    consumeStep: (operation: FixtureOperation) => DeterministicHarnessFixtureStep,
    requireCapability: CapabilityChecker,
    initialStep: DeterministicHarnessStartStep,
  ) {
    this.identity = identity;
    this.#consumeStep = consumeStep;
    this.#requireCapability = requireCapability;
    this.applyStep(initialStep);
  }

  events(afterSequence: bigint): AsyncIterable<HarnessEvent> {
    if (typeof afterSequence !== "bigint" || afterSequence < 0n) {
      throw new DeterministicHarnessFixtureError(
        "invalid_cursor",
        "harness event replay cursor must be a non-negative bigint",
      );
    }
    if (this.#eventStream !== undefined) {
      throw new DeterministicHarnessFixtureError(
        "event_consumer_active",
        "harness sessions allow only one active event consumer",
      );
    }
    const stream = new DeterministicHarnessEventStream(this, afterSequence);
    this.#eventStream = stream;
    return stream;
  }

  prompt(promptId: string, text: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.ensureOpen();
      this.applyStep(this.#consumeStep({ kind: "prompt", promptId, text }));
    });
  }

  steer(text: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.ensureOpen();
      this.#requireCapability("steer");
      this.applyStep(this.#consumeStep({ kind: "steer", text }));
    });
  }

  followUp(promptId: string, text: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.ensureOpen();
      this.#requireCapability("follow_up");
      this.applyStep(this.#consumeStep({ kind: "follow_up", promptId, text }));
    });
  }

  interrupt(): Promise<void> {
    return Promise.resolve().then(() => {
      this.ensureOpen();
      this.#requireCapability("interrupt");
      this.applyStep(this.#consumeStep({ kind: "interrupt" }));
    });
  }

  abort(): Promise<void> {
    return Promise.resolve().then(() => {
      this.ensureOpen();
      this.#requireCapability("abort");
      this.applyStep(this.#consumeStep({ kind: "abort" }));
    });
  }

  snapshot(): Promise<HarnessSessionSnapshot> {
    return Promise.resolve().then(() => {
      this.ensureOpen();
      this.#requireCapability("snapshot");
      const step = this.#consumeStep({ kind: "snapshot" });
      this.applyStep(step);
      if (!isFixtureStepKind(step, "snapshot")) {
        throw new DeterministicHarnessFixtureError(
          "unexpected_operation",
          `fixture step ${step.kind} did not produce a snapshot`,
        );
      }
      return step.snapshot;
    });
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#state = "aborted";
    this.#eventStreamClosed = true;
    this.#eventStream?.finishFromSession();
  }

  resumeFromAdapter(request: ResumeHarnessSessionRequest): HarnessSession {
    this.ensureOpen();
    this.#requireCapability("resume");
    const step = this.#consumeStep({
      kind: "resume",
      context: request.context,
      identity: request.identity,
      afterSequence: request.afterSequence,
    });
    this.applyStep(step);
    return this;
  }

  get eventStreamClosed(): boolean {
    return this.#eventStreamClosed;
  }

  firstEventAfter(afterSequence: bigint): number {
    const index = this.#events.findIndex((event) => event.sequence > afterSequence);
    return index === -1 ? this.#events.length : index;
  }

  eventAt(index: number): HarnessEvent | undefined {
    return this.#events[index];
  }

  releaseEventStream(stream: DeterministicHarnessEventStream): void {
    if (this.#eventStream === stream) {
      this.#eventStream = undefined;
    }
  }

  private ensureOpen(): void {
    if (this.#state === "finished" || this.#state === "aborted") {
      throw new DeterministicHarnessFixtureError(
        "session_terminal",
        "terminal harness sessions cannot accept more operations",
      );
    }
  }

  private applyStep(step: DeterministicHarnessFixtureStep): void {
    switch (step.kind) {
      case "start":
        this.#state = "idle";
        break;
      case "resume":
        if (this.#state !== "finished" && this.#state !== "aborted") {
          this.#state = "running";
        }
        break;
      case "prompt":
      case "steer":
      case "follow_up":
        this.#state = "running";
        break;
      case "interrupt":
        this.#state = "interrupted";
        break;
      case "abort":
        this.#state = "aborted";
        this.#eventStreamClosed = true;
        break;
      case "snapshot":
        break;
    }
    for (const fixtureEvent of step.events) {
      const event: HarnessEvent = Object.freeze({
        sequence: this.#nextEventSequence,
        occurredAt: fixtureEvent.occurredAt,
        payload: fixtureEvent.payload,
      });
      this.#events.push(event);
      this.#nextEventSequence += 1n;
      if (fixtureEvent.payload.kind === "result") {
        this.#state = fixtureEvent.payload.outcome === "cancelled" ? "aborted" : "finished";
        this.#eventStreamClosed = true;
      }
      this.#eventStream?.wake();
    }
    if (step.kind === "snapshot") {
      const actual = this.currentSnapshot();
      if (!valuesEqual(actual, step.snapshot)) {
        throw new DeterministicHarnessFixtureError(
          "invalid_fixture",
          `fixture snapshot does not match session state at step ${step.kind}`,
        );
      }
    }
  }

  private currentSnapshot(): HarnessSessionSnapshot {
    return Object.freeze({
      identity: this.identity,
      nextEventSequence: this.#nextEventSequence,
      state: this.#state,
    });
  }
}

export class DeterministicHarnessAdapter implements HarnessAdapter {
  readonly #handshake: HarnessHandshake;
  readonly #steps: readonly DeterministicHarnessFixtureStep[];
  #stepIndex = 0;
  #session: DeterministicHarnessSession | undefined;

  constructor(fixture: DeterministicHarnessFixture) {
    validateHandshake(fixture.handshake);
    const rawSteps: unknown = fixture.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      throw fixtureError("fixture.steps must contain at least a start step");
    }
    const steps = rawSteps as readonly DeterministicHarnessFixtureStep[];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (step === undefined) {
        throw fixtureError(`fixture.steps[${String(index)}] is missing`);
      }
      validateStep(step, index);
    }
    const first = steps[0];
    if (first?.kind !== "start") {
      throw fixtureError("fixture.steps[0] must be a start step");
    }
    validateFixtureLifecycle(steps, first);
    const cloned = cloneAndFreeze(fixture, new Set());
    const clonedFixture = cloned as DeterministicHarnessFixture;
    this.#handshake = clonedFixture.handshake;
    this.#steps = clonedFixture.steps;
  }

  handshake(): Promise<HarnessHandshake> {
    return Promise.resolve(this.#handshake);
  }

  start(request: StartHarnessSessionRequest): Promise<HarnessSession> {
    return Promise.resolve().then(() => {
      if (this.#session !== undefined) {
        throw new DeterministicHarnessFixtureError(
          "unexpected_operation",
          "harness adapter allows only one durable session binding",
        );
      }
      const step = this.consumeStep({
        kind: "start",
        context: request.context,
        durableHarnessId: request.durableHarnessId,
      });
      if (!isFixtureStepKind(step, "start")) {
        throw new DeterministicHarnessFixtureError(
          "unexpected_operation",
          `fixture step ${step.kind} did not produce a start session`,
        );
      }
      const session = new DeterministicHarnessSession(
        step.identity,
        (operation) => this.consumeStep(operation),
        (capability) => {
          this.requireCapability(capability);
        },
        step,
      );
      this.#session = session;

      return session;
    });
  }
  resume(request: ResumeHarnessSessionRequest): Promise<HarnessSession> {
    return Promise.resolve().then(() => {
      if (this.#session === undefined) {
        throw new DeterministicHarnessFixtureError(
          "session_not_started",
          "cannot resume a harness session before start",
        );
      }
      if (!valuesEqual(this.#session.identity, request.identity)) {
        throw new DeterministicHarnessFixtureError(
          "session_identity_mismatch",
          "resume identity does not match the durable harness session",
        );
      }
      return this.#session.resumeFromAdapter(request);
    });
  }

  private requireCapability(capability: HarnessCapability): void {
    if (!this.#handshake.capabilities.includes(capability)) {
      throw new DeterministicHarnessFixtureError(
        "missing_capability",
        `harness handshake does not advertise required capability ${capability}`,
      );
    }
  }

  private consumeStep(operation: FixtureOperation): DeterministicHarnessFixtureStep {
    const step = this.#steps[this.#stepIndex];
    if (step === undefined) {
      throw new DeterministicHarnessFixtureError(
        "fixture_exhausted",
        `fixture exhausted after ${String(this.#stepIndex)} operations; received ${operationDescription(operation)}`,
      );
    }
    if (!this.matchesOperation(step, operation)) {
      throw new DeterministicHarnessFixtureError(
        "unexpected_operation",
        `fixture step ${String(this.#stepIndex + 1)} expected ${step.kind} but received ${operationDescription(operation)}`,
      );
    }
    this.#stepIndex += 1;
    return step;
  }

  private matchesOperation(
    step: DeterministicHarnessFixtureStep,
    operation: FixtureOperation,
  ): boolean {
    switch (operation.kind) {
      case "start":
        return (
          step.kind === "start" &&
          valuesEqual(step.context, operation.context) &&
          step.durableHarnessId === operation.durableHarnessId
        );
      case "resume":
        return (
          step.kind === "resume" &&
          valuesEqual(step.context, operation.context) &&
          valuesEqual(step.identity, operation.identity) &&
          step.afterSequence === operation.afterSequence
        );
      case "prompt":
        return (
          step.kind === "prompt" &&
          step.promptId === operation.promptId &&
          step.text === operation.text
        );
      case "steer":
        return step.kind === "steer" && step.text === operation.text;
      case "follow_up":
        return (
          step.kind === "follow_up" &&
          step.promptId === operation.promptId &&
          step.text === operation.text
        );
      case "interrupt":
        return step.kind === "interrupt";
      case "abort":
        return step.kind === "abort";
      case "snapshot":
        return step.kind === "snapshot";
    }
  }
}

export function createDeterministicHarnessAdapter(
  fixture: DeterministicHarnessFixture,
): DeterministicHarnessAdapter {
  return new DeterministicHarnessAdapter(fixture);
}
