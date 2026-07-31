import { createHash } from "node:crypto";

import { GateCategory } from "@minions/contracts";
import {
  attemptId,
  classifyOutcome,
  computeEnvironmentDigest,
  contentHash,
  gitSha,
  isReceiptStale,
  SandboxDeniedError,
  taskNodeId,
  timestampFromEpochMilliseconds,
  validateGateReceipts,
  type ContentHash,
  type GateCommandDescriptor,
  type GateOutcome,
  type GateReceipt,
  type GateReceiptBindings,
  type GateReceiptExpectation,
  type GateRunRequest,
  type SandboxCapabilityProbe,
  type SandboxDenialCode,
  type SandboxExecutionResult,
  type SandboxInstance,
  type SandboxLifecycle,
  type SandboxPolicyFingerprint,
} from "@minions/core";
import { createGateRunner, createSqliteGateReceiptStore } from "@minions/adapters";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000001");
const ATTEMPT_ID = attemptId("01900000-0000-7000-8000-000000000002");
const HEAD_COMMIT = gitSha("a".repeat(40));
const PROFILE_HASH = contentHash("b".repeat(64));
const ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: "test",
  PATH: "/usr/bin:/bin",
});
const POLICY_FINGERPRINT: SandboxPolicyFingerprint = Object.freeze({
  policyVersion: 1,
  digest: contentHash("c".repeat(64)),
});
const SANDBOX_INSTANCE_ID = "test-sandbox-1";
const WORKING_DIRECTORY = "/workspace";
const MAX_OUTPUT_BYTES = 65_536;
const EMPTY_BYTES: Uint8Array = new Uint8Array();

function digest(bytes: Uint8Array | string): ContentHash {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return contentHash(createHash("sha256").update(input).digest("hex"));
}

function gate(
  name: string,
  category: GateCategory,
  executable: string,
  timeoutMs = 5_000,
): GateCommandDescriptor {
  return Object.freeze({
    name,
    category,
    executable,
    args: Object.freeze([]),
    envAllowlist: Object.freeze([]),
    timeoutMs,
  });
}

function bindingsFor(
  headCommit = HEAD_COMMIT,
  profileHash = PROFILE_HASH,
  environment = ENVIRONMENT,
): GateReceiptBindings {
  return Object.freeze({
    headCommit,
    profileHash,
    environmentDigest: computeEnvironmentDigest(environment, digest),
  });
}

function runRequest(
  gates: readonly GateCommandDescriptor[],
  overrides: Partial<GateRunRequest> = {},
): GateRunRequest {
  return Object.freeze({
    nodeId: NODE_ID,
    attemptId: ATTEMPT_ID,
    headCommit: HEAD_COMMIT,
    profileHash: PROFILE_HASH,
    environment: ENVIRONMENT,
    sandboxInstanceId: SANDBOX_INSTANCE_ID,
    expectedPolicyFingerprint: POLICY_FINGERPRINT,
    workingDirectory: WORKING_DIRECTORY,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    signal: undefined,
    gates,
    ...overrides,
  });
}

function passedReceipt(category: GateCategory, sequence: number): GateReceipt {
  return Object.freeze({
    gateName: categoryName(category),
    category,
    outcome: "passed",
    exitCode: 0,
    durationMs: 0,
    stdoutDigest: digest(EMPTY_BYTES),
    stderrDigest: digest(EMPTY_BYTES),
    headCommit: HEAD_COMMIT,
    profileHash: PROFILE_HASH,
    environmentDigest: computeEnvironmentDigest(ENVIRONMENT, digest),
    capturedAt: timestampFromEpochMilliseconds(BASE_TIME),
    sequence,
  });
}

function categoryName(category: GateCategory): string {
  const names: Readonly<Record<number, string>> = {
    [GateCategory.LINT]: "lint",
    [GateCategory.TYPECHECK]: "typecheck",
    [GateCategory.TESTS]: "tests",
    [GateCategory.BUILD]: "build",
    [GateCategory.SECURITY_REVIEW]: "security_review",
  };
  return names[category] ?? "gate";
}

// -------------------------------------------------------------------------------------------------
// Fake sandbox lifecycle: simulates per-gate outcomes keyed off the executable.
// -------------------------------------------------------------------------------------------------

type FakeBehavior =
  | Readonly<{ kind: "exit"; exitCode: number; stdout?: Uint8Array; stderr?: Uint8Array }>
  | Readonly<{ kind: "deny"; code: SandboxDenialCode; message?: string }>
  | Readonly<{ kind: "hang" }>;

const FAKE_PROBE: SandboxCapabilityProbe = {
  available: true,
  backendKind: "test",
  backendVersion: "test-1.0.0",
  templateFingerprint: contentHash("0".repeat(64)),
  capabilities: {
    readOnlyMounts: true,
    processIsolation: true,
    privateNetworkBlocking: true,
    toolFiltering: true,
    nestedContainers: true,
    supportedNetworkProfiles: ["explore"],
  },
};

function createFakeSandbox(behaviors: Readonly<Record<string, FakeBehavior>>): SandboxLifecycle {
  return new FakeSandboxLifecycle(behaviors);
}

class FakeSandboxLifecycle implements SandboxLifecycle {
  readonly backendKind = "test" as const;
  readonly #behaviors: Readonly<Record<string, FakeBehavior>>;

  constructor(behaviors: Readonly<Record<string, FakeBehavior>>) {
    this.#behaviors = behaviors;
  }

  probe(): Promise<SandboxCapabilityProbe> {
    return Promise.resolve(FAKE_PROBE);
  }

  create(): Promise<SandboxInstance> {
    return Promise.resolve(
      Object.freeze({
        instanceId: SANDBOX_INSTANCE_ID,
        context: Object.freeze({
          attemptId: ATTEMPT_ID,
          nodeId: NODE_ID,
          repositoryId: "01900000-0000-7000-8000-000000000003" as never,
          hostId: "01900000-0000-7000-8000-000000000004" as never,
        }),
        backendKind: "test",
        policyFingerprint: POLICY_FINGERPRINT,
        state: "created",
      }),
    );
  }

  execute(request: { readonly executable: string }): Promise<SandboxExecutionResult> {
    const behavior = this.#behaviors[request.executable];
    if (behavior === undefined) {
      return Promise.reject(
        new SandboxDeniedError("executable_not_allowed", "execute", "fake: unknown executable"),
      );
    }
    switch (behavior.kind) {
      case "exit":
        return Promise.resolve(
          Object.freeze({
            exitCode: behavior.exitCode,
            stdout: behavior.stdout ?? EMPTY_BYTES,
            stderr: behavior.stderr ?? EMPTY_BYTES,
          }),
        );
      case "deny":
        return Promise.reject(
          new SandboxDeniedError(behavior.code, "execute", behavior.message ?? "fake denial"),
        );
      case "hang":
        // Never resolves: the runner's bounded-timeout race must fire instead.
        return new Promise<SandboxExecutionResult>(() => {
          /* intentional */
        });
    }
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

// -------------------------------------------------------------------------------------------------
// Harness: opens a temporary host database + SQLite receipt store per test.
// -------------------------------------------------------------------------------------------------

const clock = new FixedClock(timestampFromEpochMilliseconds(BASE_TIME));

let temporary: TemporarySqliteDatabase | undefined;

beforeEach(async () => {
  temporary = await TemporarySqliteDatabase.create("host", clock);
});

afterEach(async () => {
  const current = temporary;
  temporary = undefined;
  if (current !== undefined) {
    await current.dispose();
  }
});

function store() {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createSqliteGateReceiptStore({ database: temporary.database });
}

function runner(behaviors: Readonly<Record<string, FakeBehavior>>) {
  return createGateRunner({
    sandbox: createFakeSandbox(behaviors),
    store: store(),
    clock,

    digest,
  });
}

// -------------------------------------------------------------------------------------------------
// Tests.
// -------------------------------------------------------------------------------------------------

describe("gate runner: outcome classification", () => {
  it("classifies a clean exit (code 0) as passed", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({ eslint: { kind: "exit", exitCode: 0 } }).runGates(
      runRequest(gates),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe<GateOutcome>("passed");
    expect(receipts[0]?.exitCode).toBe(0);
    expect(receipts[0]?.gateName).toBe("lint");
    expect(receipts[0]?.category).toBe(GateCategory.LINT);
  });

  it("classifies a non-zero exit as failed", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({ eslint: { kind: "exit", exitCode: 2 } }).runGates(
      runRequest(gates),
    );
    expect(receipts[0]?.outcome).toBe<GateOutcome>("failed");
    expect(receipts[0]?.exitCode).toBe(2);
  });

  it("classifies an overrunning gate as timeout via the runner's bounded-timeout race", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    try {
      const gates = [gate("lint", GateCategory.LINT, "slow-lint", 20)];
      const pending = runner({ "slow-lint": { kind: "hang" } }).runGates(runRequest(gates));
      await vi.advanceTimersByTimeAsync(20);
      const receipts = await pending;
      expect(receipts[0]?.outcome).toBe<GateOutcome>("timeout");
      expect(receipts[0]?.exitCode).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a sandbox timeout denial as timeout", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({
      eslint: { kind: "deny", code: "timeout_limit" },
    }).runGates(runRequest(gates));
    expect(receipts[0]?.outcome).toBe<GateOutcome>("timeout");
    expect(receipts[0]?.exitCode).toBeNull();
  });

  it("classifies a denied executable as missing_executable", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({
      eslint: { kind: "deny", code: "executable_not_allowed" },
    }).runGates(runRequest(gates));
    expect(receipts[0]?.outcome).toBe<GateOutcome>("missing_executable");
    expect(receipts[0]?.exitCode).toBeNull();
  });

  it("classifies an unrelated sandbox denial as error", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({
      eslint: { kind: "deny", code: "invalid_state" },
    }).runGates(runRequest(gates));
    expect(receipts[0]?.outcome).toBe<GateOutcome>("error");
  });

  it("classifies a structurally invalid command (empty executable) as error", async () => {
    const gates: GateCommandDescriptor[] = [
      Object.freeze({
        name: "lint",
        category: GateCategory.LINT,
        executable: "",
        args: Object.freeze([]),
        envAllowlist: Object.freeze([]),
        timeoutMs: 5_000,
      }),
    ];
    const receipts = await runner({}).runGates(runRequest(gates));
    expect(receipts[0]?.outcome).toBe<GateOutcome>("error");
    expect(receipts[0]?.exitCode).toBeNull();
  });
});

describe("gate runner: cancellation", () => {
  it("classifies a mid-flight abort as cancelled", async () => {
    const controller = new AbortController();
    // The slow gate never resolves; aborting after the runner registers its
    // listener resolves the run deterministically without any timer.
    const gates = [gate("lint", GateCategory.LINT, "slow-lint", 5_000)];
    const pending = runner({ "slow-lint": { kind: "hang" } }).runGates(
      runRequest(gates, { signal: controller.signal }),
    );
    controller.abort();
    const receipts = await pending;
    expect(receipts[0]?.outcome).toBe<GateOutcome>("cancelled");
    expect(receipts[0]?.exitCode).toBeNull();
  });

  it("classifies a pre-aborted signal as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({ eslint: { kind: "exit", exitCode: 0 } }).runGates(
      runRequest(gates, { signal: controller.signal }),
    );
    expect(receipts[0]?.outcome).toBe<GateOutcome>("cancelled");
  });
});

describe("gate runner: bounded output is content-addressed", () => {
  it("digests stdout/stderr into the receipt and stores no raw output", async () => {
    const stdoutBytes = new TextEncoder().encode("all good\n");
    const stderrBytes = new TextEncoder().encode("warning\n");
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({
      eslint: { kind: "exit", exitCode: 0, stdout: stdoutBytes, stderr: stderrBytes },
    }).runGates(runRequest(gates));
    const receipt = receipts[0];
    expect(receipt).toBeDefined();
    expect(receipt?.stdoutDigest).toBe(digest(stdoutBytes));
    expect(receipt?.stderrDigest).toBe(digest(stderrBytes));
    // The receipt type carries digests only — raw stdout/stderr are never on it.
    expect(Object.keys(receipt ?? {})).not.toContain("stdout");
    expect(Object.keys(receipt ?? {})).not.toContain("stderr");
  });

  it("digests empty output deterministically for a passing gate", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({ eslint: { kind: "exit", exitCode: 0 } }).runGates(
      runRequest(gates),
    );
    expect(receipts[0]?.stdoutDigest).toBe(digest(EMPTY_BYTES));
    expect(receipts[0]?.stderrDigest).toBe(digest(EMPTY_BYTES));
  });
});

describe("gate runner: binding + staleness", () => {
  it("binds each receipt to head SHA + profile hash + environment digest", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({ eslint: { kind: "exit", exitCode: 0 } }).runGates(
      runRequest(gates),
    );
    const receipt = receipts[0];
    if (receipt === undefined) {
      throw new Error("expected a gate receipt");
    }
    expect(receipt.headCommit).toBe(HEAD_COMMIT);
    expect(receipt.profileHash).toBe(PROFILE_HASH);
    expect(receipt.environmentDigest).toBe(computeEnvironmentDigest(ENVIRONMENT, digest));
    expect(isReceiptStale(receipt, bindingsFor())).toBe(false);
  });

  it("flags a receipt stale when the head commit changed", () => {
    expect(
      isReceiptStale(passedReceipt(GateCategory.LINT, 0), bindingsFor(gitSha("b".repeat(40)))),
    ).toBe(true);
  });

  it("flags a receipt stale when the profile hash changed", () => {
    expect(
      isReceiptStale(
        passedReceipt(GateCategory.LINT, 0),
        bindingsFor(HEAD_COMMIT, contentHash("d".repeat(64))),
      ),
    ).toBe(true);
  });

  it("flags a receipt stale when the environment changed", () => {
    const mutated = Object.freeze({ ...ENVIRONMENT, NODE_ENV: "production" });
    expect(
      isReceiptStale(
        passedReceipt(GateCategory.LINT, 0),
        bindingsFor(HEAD_COMMIT, PROFILE_HASH, mutated),
      ),
    ).toBe(true);
  });
});

describe("gate runner: required categories are blocking (QA-03)", () => {
  it("unblocks only when every required category has a fresh passing receipt", async () => {
    const gates = [
      gate("lint", GateCategory.LINT, "eslint"),
      gate("typecheck", GateCategory.TYPECHECK, "tsc"),
      gate("tests", GateCategory.TESTS, "vitest"),
    ];
    const receipts = await runner({
      eslint: { kind: "exit", exitCode: 0 },
      tsc: { kind: "exit", exitCode: 0 },
      vitest: { kind: "exit", exitCode: 0 },
    }).runGates(runRequest(gates));

    const expectation: GateReceiptExpectation = Object.freeze({
      bindings: bindingsFor(),
      requiredCategories: [GateCategory.LINT, GateCategory.TYPECHECK, GateCategory.TESTS],
    });
    const validation = validateGateReceipts(receipts, expectation);
    expect(validation.unblocked).toBe(true);
    expect(validation.problems).toHaveLength(0);
  });

  it("stays blocked when a required category has only a failing receipt", async () => {
    const gates = [
      gate("lint", GateCategory.LINT, "eslint"),
      gate("typecheck", GateCategory.TYPECHECK, "tsc"),
    ];
    const receipts = await runner({
      eslint: { kind: "exit", exitCode: 0 },
      tsc: { kind: "exit", exitCode: 1 },
    }).runGates(runRequest(gates));

    const validation = validateGateReceipts(receipts, {
      bindings: bindingsFor(),
      requiredCategories: [GateCategory.LINT, GateCategory.TYPECHECK],
    });
    expect(validation.unblocked).toBe(false);
    expect(validation.problems).toHaveLength(1);
    expect(validation.problems[0]?.category).toBe(GateCategory.TYPECHECK);
    expect(validation.problems[0]?.reason).toBe("missing_passing_receipt");
  });

  it("stays blocked when a required category has no receipt at all", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const receipts = await runner({ eslint: { kind: "exit", exitCode: 0 } }).runGates(
      runRequest(gates),
    );

    const validation = validateGateReceipts(receipts, {
      bindings: bindingsFor(),
      requiredCategories: [GateCategory.LINT, GateCategory.TYPECHECK],
    });
    expect(validation.problems).toHaveLength(1);
    expect(validation.problems[0]?.category).toBe(GateCategory.TYPECHECK);
    expect(validation.problems[0]?.reason).toBe("no_receipt");
  });

  it("never unblocks on stale receipts even when they all passed", async () => {
    const gates = [
      gate("lint", GateCategory.LINT, "eslint"),
      gate("typecheck", GateCategory.TYPECHECK, "tsc"),
    ];
    const receipts = await runner({
      eslint: { kind: "exit", exitCode: 0 },
      tsc: { kind: "exit", exitCode: 0 },
    }).runGates(runRequest(gates));

    // Same receipts, but the head moved: every receipt is now stale.
    const validation = validateGateReceipts(receipts, {
      bindings: bindingsFor(gitSha("f".repeat(40))),
      requiredCategories: [GateCategory.LINT, GateCategory.TYPECHECK],
    });
    expect(validation.unblocked).toBe(false);
    expect(validation.problems).toHaveLength(2);
    expect(validation.problems.every((p) => p.reason === "stale_receipt")).toBe(true);
  });
});

describe("gate runner: durable receipt storage", () => {
  it("persists every receipt and reads it back by node and by gate", async () => {
    const gates = [
      gate("lint", GateCategory.LINT, "eslint"),
      gate("tests", GateCategory.TESTS, "vitest"),
    ];
    const gateRunner = runner({
      eslint: { kind: "exit", exitCode: 0 },
      vitest: { kind: "exit", exitCode: 0 },
    });
    const receipts = await gateRunner.runGates(runRequest(gates));

    const receiptStore = store();
    const byNode = await receiptStore.listForNode(NODE_ID);
    expect(byNode.map((r) => r.gateName)).toEqual(["lint", "tests"]);
    expect(byNode.map((r) => r.outcome)).toEqual(["passed", "passed"]);

    const byGate = await receiptStore.listForGate(NODE_ID, "lint");
    expect(byGate).toHaveLength(1);
    expect(byGate[0]?.stdoutDigest).toBe(receipts[0]?.stdoutDigest);

    // Round-trip preserves the binding triple exactly.
    expect(byNode[0]?.headCommit).toBe(HEAD_COMMIT);
    expect(byNode[0]?.profileHash).toBe(PROFILE_HASH);
    expect(byNode[0]?.environmentDigest).toBe(computeEnvironmentDigest(ENVIRONMENT, digest));
  });
  it("records receipts immutably: the same gate appends a fresh row per run", async () => {
    const gates = [gate("lint", GateCategory.LINT, "eslint")];
    const gateRunner = runner({ eslint: { kind: "exit", exitCode: 0 } });
    await gateRunner.runGates(runRequest(gates));
    await gateRunner.runGates(runRequest(gates));

    const receiptStore = store();
    const byNode = await receiptStore.listForNode(NODE_ID);
    // Two runs → two append-only rows for the same gate (QA-06 evidence).
    expect(byNode).toHaveLength(2);
    expect(byNode.every((r) => r.outcome === "passed")).toBe(true);
    expect(byNode[0]?.sequence).toBe(0);
    expect(byNode[1]?.sequence).toBe(0);
  });
});

describe("gate runner: pure helpers", () => {
  it("classifyOutcome maps exit facts deterministically", () => {
    expect(classifyOutcome(0, null, false)).toBe<GateOutcome>("passed");
    expect(classifyOutcome(1, null, false)).toBe<GateOutcome>("failed");
    expect(classifyOutcome(127, null, false)).toBe<GateOutcome>("failed");
    expect(classifyOutcome(null, null, false)).toBe<GateOutcome>("missing_executable");
    expect(classifyOutcome(0, null, true)).toBe<GateOutcome>("timeout");
    expect(classifyOutcome(0, "SIGTERM", false)).toBe<GateOutcome>("cancelled");
    expect(classifyOutcome(0, "SIGINT", false)).toBe<GateOutcome>("cancelled");
    expect(classifyOutcome(0, "SIGKILL", false)).toBe<GateOutcome>("timeout");
  });

  it("computeEnvironmentDigest is order-independent and deterministic", () => {
    const a = { PATH: "/bin", NODE_ENV: "test" };
    const b = { NODE_ENV: "test", PATH: "/bin" };
    expect(computeEnvironmentDigest(a, digest)).toBe(computeEnvironmentDigest(b, digest));
    expect(computeEnvironmentDigest({ NODE_ENV: "prod", PATH: "/bin" }, digest)).not.toBe(
      computeEnvironmentDigest({ NODE_ENV: "test", PATH: "/bin" }, digest),
    );
  });
});
