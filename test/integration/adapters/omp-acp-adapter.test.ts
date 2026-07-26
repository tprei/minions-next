import {
  createOmpAcpHarnessAdapter,
  OmpAcpAdapterError,
  buildSessionNewParams,
  decodeAcpFrame,
  normalizeAcpNotification,
  type OmpAcpAdapterOptions,
} from "@minions/adapters";
import {
  attemptId,
  contentHash,
  hostId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  type HarnessAttemptContext,
  type HarnessCapability,
  type HarnessEvent,
  type HarnessSession,
} from "@minions/core";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Integration tests for the OMP ACP harness adapter. Live cases exercise the installed
 * `omp acp` 17.0.4 `initialize` / `authenticate` / `session/new` / `session/load` /
 * `session/close` lifecycle WITHOUT a provider model prompt (auth is deferred to the
 * `synthetic:omp-rpc` runner). Pure cases cover strict frame decoding and ACP→HarnessEvent
 * normalization with hand-crafted JSON-RPC lines.
 */

const ompPath = resolveOmpPath();
const live = ompPath !== undefined;
const policyDigest = contentHash("5".repeat(64));

const startContext: HarnessAttemptContext = {
  attemptId: attemptId("018f3a2e-4a20-7b90-8123-abcdef000001"),
  attemptOrdinal: 1,
  nodeId: taskNodeId("018f3a2e-4a20-7b90-8123-abcdef000002"),
  treeId: taskTreeId("018f3a2e-4a20-7b90-8123-abcdef000003"),
  repositoryId: repositoryId("018f3a2e-4a20-7b90-8123-abcdef000004"),
  hostId: hostId("018f3a2e-4a20-7b90-8123-abcdef000005"),
};

const resumedContext: HarnessAttemptContext = {
  ...startContext,
  attemptId: attemptId("018f3a2e-4a20-7b90-8123-abcdef000006"),
  attemptOrdinal: 2,
};

type DisposableSession = HarnessSession & {
  dispose(): void;
  stderrSummary(): string;
};

const temporaryDirectories: string[] = [];

function makeSessionDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-acp-session-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporaryDirectories) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function baseOptions(overrides: Partial<OmpAcpAdapterOptions> = {}): OmpAcpAdapterOptions {
  // Construction-validation tests (HAR-04 forbidden-tool rejection) don't spawn omp;
  // use a fallback path so they pass on CI where omp isn't installed. Tests that
  // actually spawn omp are gated by `it.runIf(live)`.
  const resolvedOmpPath = ompPath ?? "/usr/local/bin/omp";
  return {
    ompPath: resolvedOmpPath,
    expectedVersion: "17.0.4",
    cwd: tmpdir(),
    sessionDirectory: makeSessionDirectory(),
    model: "zai/glm-4.6",
    reasoningLevel: "default",
    allowedTools: ["read", "bash", "edit", "write", "grep", "glob"],
    securityPolicyDigest: policyDigest,
    requiredCapabilities: ["resume", "snapshot", "steer", "follow_up", "abort"],
    ...overrides,
  };
}

async function expectErrorCode<T>(
  operation: () => Promise<T>,
  code: OmpAcpAdapterError["code"],
): Promise<OmpAcpAdapterError> {
  try {
    await operation();
    throw new Error(`expected OmpAcpAdapterError with code ${code}, but no error was thrown`);
  } catch (error: unknown) {
    if (!(error instanceof OmpAcpAdapterError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return error;
  }
}

function resolveOmpPath(): string | undefined {
  const fromEnv = process.env["OMP_PATH"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const candidates = ["/home/mbn/.local/bin/omp", "/usr/local/bin/omp", "/usr/bin/omp"];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

describe("omp acp adapter — version probe fail-closed", () => {
  it.runIf(live)(
    "advertises the pinned version and harness kind on a matching initialize",
    async () => {
      const adapter = createOmpAcpHarnessAdapter(baseOptions());
      try {
        const handshake = await adapter.handshake();
        expect(handshake.harnessKind).toBe("omp-acp");
        expect(handshake.harnessVersion).toBe("17.0.4");
        expect(handshake.securityPolicyDigest).toBe(policyDigest);
        expect(handshake.tools).toEqual(["read", "bash", "edit", "write", "grep", "glob"]);
      } finally {
        // handshake probes close their own process; nothing to dispose.
      }
    },
    30_000,
  );

  it.runIf(live)(
    "fails closed with version_mismatch before any session when the version differs",
    async () => {
      const adapter = createOmpAcpHarnessAdapter(baseOptions({ expectedVersion: "0.0.0" }));
      await expectErrorCode(() => adapter.handshake(), "version_mismatch");
    },
    30_000,
  );
});

describe("omp acp adapter — capability mapping + fail-closed (HAR-06)", () => {
  it.runIf(live)(
    "advertises resume/snapshot/steer/follow_up/abort but never interrupt (no session/cancel)",
    async () => {
      const adapter = createOmpAcpHarnessAdapter(baseOptions({ requiredCapabilities: [] }));
      const handshake = await adapter.handshake();
      const capabilities = new Set<HarnessCapability>(handshake.capabilities);
      expect(capabilities.has("resume")).toBe(true);
      expect(capabilities.has("snapshot")).toBe(true);
      expect(capabilities.has("steer")).toBe(true);
      expect(capabilities.has("follow_up")).toBe(true);
      expect(capabilities.has("abort")).toBe(true);
      expect(capabilities.has("interrupt")).toBe(false);
    },
    30_000,
  );

  it.runIf(live)(
    "fails closed with capability_missing when a required capability is unadvertised",
    async () => {
      const adapter = createOmpAcpHarnessAdapter(
        baseOptions({ requiredCapabilities: ["interrupt"] }),
      );
      await expectErrorCode(() => adapter.handshake(), "capability_missing");
    },
    30_000,
  );
});

describe("omp acp adapter — strict JSON-RPC frame decoding", () => {
  it("parses a valid notification", () => {
    const decoded = decodeAcpFrame(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"session_info_update"}}}',
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.frame.kind).toBe("notification");
      if (decoded.frame.kind === "notification") {
        expect(decoded.frame.method).toBe("session/update");
      }
    }
  });

  it("parses a valid successful response", () => {
    const decoded = decodeAcpFrame('{"jsonrpc":"2.0","id":1,"result":{"sessionId":"abc"}}');
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.frame.kind === "response") {
      expect(decoded.frame.id).toBe(1);
    }
  });

  it("parses a valid error response", () => {
    const decoded = decodeAcpFrame(
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"boom","data":"detail"}}',
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.frame.kind === "error_response") {
      expect(decoded.frame.error.code).toBe(-32603);
      expect(decoded.frame.error.message).toBe("boom");
      expect(decoded.frame.error.data).toBe("detail");
    }
  });

  it("rejects malformed JSON as frame_invalid without throwing", () => {
    expect(decodeAcpFrame("this is not json").ok).toBe(false);
    expect(decodeAcpFrame('{"bad":}').ok).toBe(false);
    expect(decodeAcpFrame("").ok).toBe(false);
    expect(decodeAcpFrame("[]").ok).toBe(false);
    expect(decodeAcpFrame("null").ok).toBe(false);
  });

  it("rejects structurally invalid JSON-RPC envelopes as frame_invalid", () => {
    const reject = (line: string, reason: string) => {
      const decoded = decodeAcpFrame(line);
      expect(decoded.ok, reason).toBe(false);
      if (!decoded.ok) {
        expect(decoded.code).toBe("frame_invalid");
      }
    };
    reject('{"id":1,"result":{}}', "missing jsonrpc version");
    reject('{"jsonrpc":"1.0","id":1,"result":{}}', "wrong jsonrpc version");
    reject('{"jsonrpc":"2.0","method":"x","id":1}', "server-to-client request");
    reject('{"jsonrpc":"2.0","method":"x","result":{}}', "notification carrying result");
    reject('{"jsonrpc":"2.0","id":1,"result":{},"error":{}}', "both result and error");
    reject('{"jsonrpc":"2.0","id":1,"error":{"code":"x"}}', "malformed error object");
    reject('{"jsonrpc":"2.0","id":1}', "response with neither result nor error");
  });
});

describe("omp acp adapter — ACP notification → HarnessEvent normalization", () => {
  it("maps session/update metadata to no events", () => {
    expect(
      normalizeAcpNotification("session/update", {
        sessionId: "s1",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      }),
    ).toEqual([]);
    expect(
      normalizeAcpNotification("session/update", {
        sessionId: "s1",
        update: { sessionUpdate: "session_info_update", updatedAt: "2026-01-01T00:00:00Z" },
      }),
    ).toEqual([]);
  });

  it("maps session/update usage to a usage event", () => {
    const [event] = normalizeAcpNotification("session/update", {
      sessionId: "s1",
      update: {
        sessionUpdate: "usage",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 10,
      },
    });
    expect(event).toEqual({
      kind: "usage",
      usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 10 },
    });
  });

  it("maps session/update prompt lifecycle to prompt/turn events", () => {
    const started = normalizeAcpNotification("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "prompt_start", promptId: "p1" },
    });
    expect(started).toEqual([
      { kind: "turn_started", turnId: "p1" },
      { kind: "prompt_started", promptId: "p1" },
    ]);
    const ended = normalizeAcpNotification("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "prompt_end", promptId: "p1" },
    });
    expect(ended).toEqual([
      { kind: "prompt_finished", promptId: "p1" },
      { kind: "turn_finished", turnId: "p1" },
    ]);
  });

  it("maps message/part parts to message/thinking/tool events", () => {
    expect(
      normalizeAcpNotification("message/part", {
        sessionId: "s1",
        part: { type: "text", text: "hello" },
      }),
    ).toEqual([{ kind: "message", role: "assistant", text: "hello" }]);
    expect(
      normalizeAcpNotification("message/part", {
        sessionId: "s1",
        part: { type: "thought", text: "reasoning" },
      }),
    ).toEqual([{ kind: "thinking", text: "reasoning" }]);
    expect(
      normalizeAcpNotification("message/part", {
        sessionId: "s1",
        part: { type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: "/x" } },
      }),
    ).toEqual([{ kind: "tool_call", callId: "c1", tool: "read", input: { path: "/x" } }]);
    expect(
      normalizeAcpNotification("message/part", {
        sessionId: "s1",
        part: { type: "tool_result", toolCallId: "c1", output: "ok", isError: true },
      }),
    ).toEqual([{ kind: "tool_result", callId: "c1", output: "ok", failed: true }]);
  });

  it("surfaces unknown variants as a non-retryable error event without throwing", () => {
    const [unknownUpdate] = normalizeAcpNotification("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "totally_new_thing" },
    });
    expect(unknownUpdate).toMatchObject({ kind: "error", retryable: false });
    const [unknownPart] = normalizeAcpNotification("message/part", {
      sessionId: "s1",
      part: { type: "hologram" },
    });
    expect(unknownPart).toMatchObject({ kind: "error", retryable: false });
    const [unknownMethod] = normalizeAcpNotification("session/whatever", {});
    expect(unknownMethod).toMatchObject({ kind: "error", retryable: false });
  });
});

describe("omp acp adapter — disabled subagent spawning (HAR-04)", () => {
  it("rejects a forbidden subagent-spawning tool in the allowlist at construction", () => {
    expect(() =>
      createOmpAcpHarnessAdapter(baseOptions({ allowedTools: ["read", "subagent"] })),
    ).toThrow(OmpAcpAdapterError);
    expect(() => createOmpAcpHarnessAdapter(baseOptions({ allowedTools: ["task"] }))).toThrow(
      OmpAcpAdapterError,
    );
  });

  it("builds session/new with exactly the allowlist and no spawn/subagent tools", () => {
    const params = buildSessionNewParams("/tmp/work", ["read", "bash", "edit"]);
    const tools = (params["session"] as Readonly<{ tools: readonly string[] }>).tools;
    expect([...tools]).toEqual(["read", "bash", "edit"]);
    const forbidden = ["subagent", "task", "spawn", "delegate", "dispatch"];
    expect(tools.some((tool) => forbidden.includes(tool))).toBe(false);
  });
  it("rejects case-variant spellings of forbidden subagent-spawning tools", () => {
    for (const variant of ["Spawn", "TASK", "Subagent", "NEW_TASK", "Delegate", "SpAwN"]) {
      expect(() =>
        createOmpAcpHarnessAdapter(baseOptions({ allowedTools: ["read", variant] })),
      ).toThrow(OmpAcpAdapterError);
    }
  });
});

describe("omp acp adapter — session lifecycle + restart/resume (HAR-01)", () => {
  const durable = "node-restart-identity";

  it.runIf(live)(
    "starts a session, snapshots, then resumes the SAME sessionId after process restart",
    async () => {
      const sessionDirectory = makeSessionDirectory();
      const options = baseOptions({ sessionDirectory });
      const adapter = createOmpAcpHarnessAdapter(options);
      const session = (await adapter.start({
        context: startContext,
        durableHarnessId: durable,
      })) as DisposableSession;

      let sessionId: string;
      let nextSequence: bigint;
      try {
        sessionId = session.identity.sessionId;
        expect(typeof sessionId).toBe("string");
        expect(sessionId.length).toBeGreaterThan(0);
        const snapshot = await session.snapshot();
        expect(snapshot.identity.sessionId).toBe(sessionId);
        expect(snapshot.identity.durableHarnessId).toBe(durable);
        expect(snapshot.state).toBe("idle");
        expect(snapshot.nextEventSequence).toBe(1n);
        nextSequence = snapshot.nextEventSequence;
      } finally {
        // Simulate process restart: tear down the backing omp acp process.
        session.dispose();
      }

      // A fresh adapter instance (fresh process) must recover the same durable session.
      const adapterTwo = createOmpAcpHarnessAdapter(options);
      const resumed = (await adapterTwo.resume({
        context: resumedContext,
        identity: { durableHarnessId: durable, sessionId },
        afterSequence: nextSequence,
      })) as DisposableSession;
      try {
        expect(resumed.identity.durableHarnessId).toBe(durable);
        expect(resumed.identity.sessionId).toBe(sessionId);
        const resumedSnapshot = await resumed.snapshot();
        expect(resumedSnapshot.identity.sessionId).toBe(sessionId);
        expect(resumedSnapshot.state).toBe("idle");
      } finally {
        resumed.dispose();
      }
    },
    60_000,
  );

  it.runIf(live)(
    "resume fails closed with session_not_found for an unknown durable identity",
    async () => {
      const adapter = createOmpAcpHarnessAdapter(baseOptions());
      await expectErrorCode(
        () =>
          adapter.resume({
            context: resumedContext,
            identity: {
              durableHarnessId: "never-started",
              sessionId: "019f0000-0000-7000-0000-000000000000",
            },
            afterSequence: 0n,
          }),
        "session_not_found",
      );
    },
    30_000,
  );
  it.runIf(live)(
    "rejects a concurrent second session for the same durable identity (HAR-01 race)",
    async () => {
      const adapter = createOmpAcpHarnessAdapter(baseOptions());
      const durableConcurrent = "node-concurrent-identity";
      const results = await Promise.allSettled([
        adapter.start({ context: startContext, durableHarnessId: durableConcurrent }),
        adapter.start({ context: startContext, durableHarnessId: durableConcurrent }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      try {
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const rejectedResult = rejected[0];
        if (rejectedResult === undefined) throw new Error("expected one rejected start()");
        const reason: unknown = rejectedResult.reason;
        expect(reason).toBeInstanceOf(OmpAcpAdapterError);
        expect((reason as OmpAcpAdapterError).code).toBe("session_conflict");
      } finally {
        for (const result of results) {
          if (result.status === "fulfilled") (result.value as DisposableSession).dispose();
        }
      }
    },
    60_000,
  );
});

function writeFakeOmp(directory: string): string {
  const fakeOmpPath = join(directory, "fake-omp.mjs");
  const source = `#!/usr/bin/env node
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handle(line);
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function handle(line) {
  const text = line.trim();
  if (text.length === 0) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentInfo: { name: "fake-omp", title: "Fake OMP", version: "17.0.4" }, authMethods: [{ id: "agent", name: "local" }], agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true }, sessionCapabilities: { close: {} } } } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "authenticate") { send({ jsonrpc: "2.0", id: message.id, result: {} }); return; }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-session-1" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    send({ jsonrpc: "2.0", method: "session/update", params: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
}
process.stdin.on("end", () => process.exit(0));
`;
  writeFileSync(fakeOmpPath, source, { mode: 0o755 });
  chmodSync(fakeOmpPath, 0o755);
  return fakeOmpPath;
}

describe("omp acp adapter — malformed notification resilience", () => {
  it("survives a malformed session/update notification without crashing the process", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omp-acp-crash-"));
    temporaryDirectories.push(scratch);
    const fakeOmp = writeFakeOmp(scratch);
    const adapter = createOmpAcpHarnessAdapter({
      ompPath: fakeOmp,
      expectedVersion: "17.0.4",
      cwd: tmpdir(),
      sessionDirectory: makeSessionDirectory(),
      model: "zai/glm-4.6",
      reasoningLevel: "default",
      allowedTools: ["read"],
      securityPolicyDigest: policyDigest,
      requiredCapabilities: ["resume", "snapshot", "steer", "follow_up", "abort"],
    });
    const session = (await adapter.start({
      context: startContext,
      durableHarnessId: "node-malformed-identity",
    })) as DisposableSession;
    try {
      // Drive a round-trip; the fake omp emits the malformed session/update alongside
      // the session/prompt response, after the session router is wired.
      await session.steer("probe");
      const collected: HarnessEvent[] = [];
      for await (const event of session.events(0n)) {
        collected.push(event);
        if (event.payload.kind === "error" && event.payload.code === "frame_invalid") {
          break;
        }
      }
      expect(
        collected.some(
          (event) => event.payload.kind === "error" && event.payload.code === "frame_invalid",
        ),
      ).toBe(true);
      const snapshot = await session.snapshot();
      expect(snapshot.identity.durableHarnessId).toBe("node-malformed-identity");
      expect(snapshot.identity.sessionId).toBe("fake-session-1");
    } finally {
      session.dispose();
    }
  }, 30_000);
});
