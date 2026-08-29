import { DomainError } from "./domain-error.js";

import type {
  AttemptId,
  ContentHash,
  HostId,
  RepositoryId,
  TaskNodeId,
  TaskTreeId,
  Timestamp,
} from "./value-objects.js";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

export const harnessCapabilities = [
  "steer",
  "follow_up",
  "interrupt",
  "abort",
  "resume",
  "snapshot",
] as const;

export type HarnessCapability = (typeof harnessCapabilities)[number];

export type HarnessHandshake = Readonly<{
  harnessKind: string;
  harnessVersion: string;
  providerKind: string;
  model: string;
  reasoningLevel: string;
  capabilities: readonly HarnessCapability[];
  tools: readonly string[];
  securityPolicyDigest: ContentHash;
}>;

export type HarnessAttemptContext = Readonly<{
  attemptId: AttemptId;
  attemptOrdinal: number;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
}>;

export type HarnessSessionIdentity = Readonly<{
  durableHarnessId: string;
  sessionId: string;
}>;

export type HarnessUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}>;

export type HarnessEventPayload =
  | Readonly<{ kind: "message"; role: "assistant" | "system" | "user"; text: string }>
  | Readonly<{ kind: "thinking"; text: string }>
  | Readonly<{ kind: "tool_call"; callId: string; tool: string; input: JsonValue }>
  | Readonly<{ kind: "tool_result"; callId: string; output: JsonValue; failed: boolean }>
  | Readonly<{ kind: "prompt_started"; promptId: string }>
  | Readonly<{ kind: "prompt_finished"; promptId: string }>
  | Readonly<{ kind: "turn_started"; turnId: string }>
  | Readonly<{ kind: "turn_finished"; turnId: string }>
  | Readonly<{ kind: "usage"; usage: HarnessUsage }>
  | Readonly<{
      kind: "retry";
      providerRequestOrdinal: number;
      reason: string;
    }>
  | Readonly<{
      kind: "question";
      questionId: string;
      prompt: string;
      choices: readonly string[];
    }>
  | Readonly<{ kind: "error"; code: string; message: string; retryable: boolean }>
  | Readonly<{ kind: "result"; outcome: "succeeded" | "failed" | "cancelled"; text: string }>;

export type HarnessEvent = Readonly<{
  sequence: bigint;
  occurredAt: Timestamp;
  payload: HarnessEventPayload;
}>;

export type HarnessSessionSnapshot = Readonly<{
  identity: HarnessSessionIdentity;
  nextEventSequence: bigint;
  state: "idle" | "running" | "interrupted" | "finished" | "aborted";
}>;

export type StartHarnessSessionRequest = Readonly<{
  context: HarnessAttemptContext;
  durableHarnessId: string;
  /** Absolute path of the per-attempt working copy; the harness must spawn and run the agent there. */
  workspacePath?: string;
}>;

export type ResumeHarnessSessionRequest = Readonly<{
  context: HarnessAttemptContext;
  identity: HarnessSessionIdentity;
  afterSequence: bigint;
  /** Absolute path of the per-attempt working copy; the harness must spawn and run the agent there. */
  workspacePath?: string;
}>;

export interface HarnessSession {
  readonly identity: HarnessSessionIdentity;
  events(afterSequence: bigint): AsyncIterable<HarnessEvent>;
  prompt(promptId: string, text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(promptId: string, text: string): Promise<void>;
  interrupt(): Promise<void>;
  abort(): Promise<void>;
  snapshot(): Promise<HarnessSessionSnapshot>;
  dispose(): void;
}

export interface HarnessAdapter {
  handshake(): Promise<HarnessHandshake>;
  start(request: StartHarnessSessionRequest): Promise<HarnessSession>;
  resume(request: ResumeHarnessSessionRequest): Promise<HarnessSession>;
}

export function missingHarnessCapabilities(
  handshake: HarnessHandshake,
  required: readonly HarnessCapability[],
): readonly HarnessCapability[] {
  const available = new Set(handshake.capabilities);
  return required.filter((capability) => !available.has(capability));
}

export function requireHarnessCapabilities(
  handshake: HarnessHandshake,
  required: readonly HarnessCapability[],
): void {
  const missing = missingHarnessCapabilities(handshake, required);
  if (missing.length > 0) {
    throw new DomainError(
      "invalid_value",
      `harness is missing required capabilities: ${missing.join(", ")}`,
    );
  }
}
