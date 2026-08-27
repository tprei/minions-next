import {
  contentHash,
  gitSha,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  buildRevisionRevset,
  validateNoUnexpectedMutation,
  type ContentHash,
  type GateCommandDescriptor,
  type GitSha,
  type RevisionIdSnapshot,
  type TaskNodeId,
  type VcsChangeBinding,
} from "@minions/core";
import {
  createRevisionGateRunner,
  createSqliteGateReceiptStore,
  createSqliteVcsChangeBindingStore,
  RevisionGateError,
  type RevisionGateJjRunner,
  type RevisionGateRawResult,
} from "@minions/adapters";
import { GateCategory } from "@minions/contracts";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * PR 41 — per-revision gates via `jj run`.
 *
 * The gate receipt store (PR 25) and the change-binding store (PR 29) are the
 * real SQLite implementations; the `jj` binary is a test double
 * ({@link createDouble}) that scripts per-revision gate outcomes, simulates
 * formatter/mutation by rewriting the live change→commit map between the
 * before/after tree snapshots, and tracks concurrency so the bounded-parallelism
 * contract is observable.
 */

// -------------------------------------------------------------------------------------------------
// Constants + value helpers.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TREE = taskTreeId("01900000-0000-7000-8000-000000000041");

const BASE_NODE = taskNodeId("01900000-0000-7000-8000-0000000000b0");
const MID_NODE = taskNodeId("01900000-0000-7000-8000-0000000000b1");
const HEAD_NODE = taskNodeId("01900000-0000-7000-8000-0000000000b2");
const OUTSIDE_NODE = taskNodeId("01900000-0000-7000-8000-0000000000b3");

const PROFILE_HASH = contentHash("b".repeat(64));

/** Repeat a numeric seed's hex unit to exactly `length` lowercase-hex chars. */
function hexRun(seed: number, length: number): string {
  const unit = (seed % 256).toString(16).padStart(2, "0");
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

const change = (seed: number): ContentHash => contentHash(hexRun(seed, 64));
const commit = (seed: number): GitSha => gitSha(hexRun(seed, 40));
const op = (seed: number): ContentHash => contentHash(hexRun(seed + 64, 64));

const BASE_CHANGE = change(1);
const MID_CHANGE = change(2);
const HEAD_CHANGE = change(3);
const OUTSIDE_CHANGE = change(4);

const INTENDED_CHANGES: readonly string[] = [BASE_CHANGE, MID_CHANGE, HEAD_CHANGE];

function binding(
  nodeId: TaskNodeId,
  changeId: ContentHash,
  commitSeed: number,
  parent?: ContentHash,
): VcsChangeBinding {
  return Object.freeze({
    treeId: TREE,
    nodeId,
    jjChangeId: changeId,
    currentCommitId: commit(commitSeed),
    parentChangeId: parent,
    bookmark: undefined,
    rewriteGeneration: 0,
    lastJjOperationId: op(commitSeed),
    lastPushedCommitId: commit(commitSeed),
    lastReviewedCommitId: commit(commitSeed),
    conflictState: "clean",
    recordedAt: timestampFromEpochMilliseconds(BASE_TIME),
  });
}

function gateCmd(name: string, category: GateCategory = GateCategory.LINT): GateCommandDescriptor {
  return Object.freeze({
    name,
    category,
    executable: "echo",
    args: Object.freeze([]),
    envAllowlist: Object.freeze([]),
    timeoutMs: 5_000,
  });
}

// -------------------------------------------------------------------------------------------------
// Harness: temporary host database + real stores per test.
// -------------------------------------------------------------------------------------------------

const clock = new FixedClock(timestampFromEpochMilliseconds(BASE_TIME));

let temporary: TemporarySqliteDatabase | undefined;

beforeEach(async () => {
  temporary = await TemporarySqliteDatabase.create("host", clock);
  const bindings = createSqliteVcsChangeBindingStore({ database: temporary.database });
  await bindings.upsertBinding(binding(BASE_NODE, BASE_CHANGE, 1));
  await bindings.upsertBinding(binding(MID_NODE, MID_CHANGE, 2, BASE_CHANGE));
  await bindings.upsertBinding(binding(HEAD_NODE, HEAD_CHANGE, 3, MID_CHANGE));
  await bindings.upsertBinding(binding(OUTSIDE_NODE, OUTSIDE_CHANGE, 4));
});

afterEach(async () => {
  await temporary?.dispose();
  temporary = undefined;
});

function runner(double: RevisionGateJjRunner) {
  if (temporary === undefined) throw new Error("test database not initialized");
  return createRevisionGateRunner({
    jjBinaryPath: "/nonexistent/jj",
    workingCopyPath: "/nonexistent/repo",
    gateReceiptStore: createSqliteGateReceiptStore({ database: temporary.database }),
    bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
    clock,
    jjRunner: double,
  });
}

function request(
  overrides: {
    parallelism?: number;
    trackedSourceReadOnly?: boolean;
    intendedChangeIds?: readonly string[];
  } = {},
) {
  return Object.freeze({
    treeId: TREE,
    revsetExpression: buildRevisionRevset(overrides.intendedChangeIds ?? INTENDED_CHANGES),
    intendedChangeIds: overrides.intendedChangeIds ?? INTENDED_CHANGES,
    gateCommands: Object.freeze([gateCmd("lint")]),
    parallelism: overrides.parallelism ?? 2,
    trackedSourceReadOnly: overrides.trackedSourceReadOnly ?? true,
    profileHash: PROFILE_HASH,
    environment: Object.freeze({}),
    attemptId: undefined,
  });
}

// -------------------------------------------------------------------------------------------------
// jj test double.
// -------------------------------------------------------------------------------------------------

type DoubleOptions = Readonly<{
  /** Initial live change→commit map (the whole registered tree). */
  commits: ReadonlyMap<string, GitSha>;
  /** Mutations applied during the gate run: change→new commit (formatter/amend). */
  mutations?: ReadonlyMap<string, GitSha>;
  /** Per-change gate exit code; default 0 (pass). The string "throw" fails the jj run. */
  exitByChange?: ReadonlyMap<string, number | "throw">;
}>;

type DoubleHandle = Readonly<{
  runner: RevisionGateJjRunner;
  /** Maximum number of revisions that ran concurrently. */
  maxConcurrency: () => number;
  /** Operation id passed to the last rollback, or undefined when none happened. */
  restoredOperationId: () => string | undefined;
}>;

/**
 * Build a jj double. The live change→commit map starts as `commits`; when the
 * first gate runs, `mutations` are applied so the AFTER tree snapshot observes
 * them (simulating a formatter/amend that happened during `jj run`). The double
 * tracks peak concurrency and the last rollback anchor.
 */
function createDouble(options: DoubleOptions): DoubleHandle {
  const state = new Map<string, GitSha>(options.commits);
  const mutations = options.mutations ?? new Map<string, GitSha>();
  let concurrency = 0;
  let peak = 0;
  let restored: string | undefined;

  const applyMutations = (): void => {
    for (const [changeId, next] of mutations) {
      state.set(changeId, next);
    }
  };

  const parseExpr = (expr: string): readonly string[] => {
    if (expr === "none()" || expr.length === 0) return [];
    return expr
      .split("|")
      .map((part) =>
        part
          .trim()
          .replace(/^\(+|\)+$/gu, "")
          .trim(),
      )
      .filter((token) => token.length > 0);
  };

  const runner: RevisionGateJjRunner = Object.freeze({
    snapshot: (revsetExpression: string) => {
      const ids = parseExpr(revsetExpression);
      const lines: string[] = [];
      for (const id of ids) {
        if (state.has(id)) {
          lines.push(`${id} ${state.get(id) as string}`);
        } else {
          for (const [ch, com] of state) {
            if (com === id) {
              lines.push(`${ch} ${com}`);
              break;
            }
          }
        }
      }
      const stdout = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
      return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
    },
    runRevisionGates: async (
      changeId: string,
      _commitId: string,
      gates: readonly GateCommandDescriptor[],
    ): Promise<readonly RevisionGateRawResult[]> => {
      // A formatter/amend rewrites the repo during the run; apply it now so the
      // after-snapshot observes the new commits.
      applyMutations();
      concurrency += 1;
      if (concurrency > peak) peak = concurrency;
      try {
        await Promise.resolve();
        const scripted = options.exitByChange?.get(changeId) ?? 0;
        if (scripted === "throw") {
          throw new Error(`jj run failed for change ${changeId}`);
        }
        return gates.map((gate) =>
          Object.freeze({
            gate,
            exitCode: scripted,
            signal: null,
            timedOut: false,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            durationMs: 10,
          }),
        );
      } finally {
        concurrency -= 1;
      }
    },
    currentOperationId: () => Promise.resolve("op-0001"),
    restoreOperation: (operationId: string) => {
      restored = operationId;
      return Promise.resolve();
    },
  });

  return Object.freeze({
    runner,
    maxConcurrency: () => peak,
    restoredOperationId: () => restored,
  });
}

function fullTreeCommits(): Map<string, GitSha> {
  return new Map<string, GitSha>([
    [BASE_CHANGE, commit(1)],
    [MID_CHANGE, commit(2)],
    [HEAD_CHANGE, commit(3)],
    [OUTSIDE_CHANGE, commit(4)],
  ]);
}

// -------------------------------------------------------------------------------------------------
// Tests: gate outcomes.
// -------------------------------------------------------------------------------------------------

describe("revision gate runner: every revision passes", () => {
  it("returns allPassed=true and records a receipt per revision", async () => {
    const handle = createDouble({ commits: fullTreeCommits() });
    const result = await runner(handle.runner).runRevisionGates(request());

    expect(result.allPassed).toBe(true);
    expect(result.perRevision.map((o) => o.changeId)).toEqual([
      BASE_CHANGE,
      MID_CHANGE,
      HEAD_CHANGE,
    ]);
    expect(result.perRevision.every((o) => o.passed)).toBe(true);
    expect(result.changedChangeIds).toEqual([]);

    if (temporary === undefined) throw new Error("test database not initialized");
    const receipts = createSqliteGateReceiptStore({ database: temporary.database });
    for (const [node, changeId, seed] of [
      [BASE_NODE, BASE_CHANGE, 1],
      [MID_NODE, MID_CHANGE, 2],
      [HEAD_NODE, HEAD_CHANGE, 3],
    ] as const) {
      const stored = await receipts.listForNode(node);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.gateName).toBe("lint");
      expect(stored[0]?.outcome).toBe("passed");
      expect(stored[0]?.headCommit).toBe(commit(seed));
      expect(result.perRevision.find((o) => o.changeId === changeId)?.commitId).toBe(commit(seed));
    }
  });
});

describe("revision gate runner: intermediate failure fails the stack (QA-04)", () => {
  it("returns allPassed=false when an intermediate fails even though the head is green", async () => {
    const handle = createDouble({
      commits: fullTreeCommits(),
      // MID (intermediate) fails; BASE and HEAD pass.
      exitByChange: new Map([
        [BASE_CHANGE, 0],
        [MID_CHANGE, 1],
        [HEAD_CHANGE, 0],
      ]),
    });
    const result = await runner(handle.runner).runRevisionGates(request());

    expect(result.allPassed).toBe(false);
    const byChange = new Map(result.perRevision.map((o) => [o.changeId, o] as const));
    expect(byChange.get(BASE_CHANGE)?.passed).toBe(true);
    expect(byChange.get(MID_CHANGE)?.passed).toBe(false);
    expect(byChange.get(HEAD_CHANGE)?.passed).toBe(true);
    // The head was green but the intermediate failure still failed the stack.
    expect(byChange.get(MID_CHANGE)?.gateResults[0]?.outcome).toBe("failed");
  });
});

// -------------------------------------------------------------------------------------------------
// Tests: mutation proofs.
// -------------------------------------------------------------------------------------------------

describe("revision gate runner: formatter amends exactly the intended revisions (QA-07)", () => {
  it("records changedChangeIds for intended amendments without failing", async () => {
    const handle = createDouble({
      commits: fullTreeCommits(),
      // Formatter amends MID (an intended revision) only.
      mutations: new Map([[MID_CHANGE, commit(22)]]),
    });
    const result = await runner(handle.runner).runRevisionGates(
      request({ trackedSourceReadOnly: false }),
    );

    expect(result.allPassed).toBe(true);
    expect(result.changedChangeIds).toEqual([MID_CHANGE]);
    expect(handle.restoredOperationId()).toBeUndefined();
  });
});

describe("revision gate runner: unexpected mutation is detected and rolled back (QA-10)", () => {
  it("fails with unexpected_mutation_detected when a change outside the revset mutates", async () => {
    const handle = createDouble({
      commits: fullTreeCommits(),
      // A revision OUTSIDE the intended revset is amended.
      mutations: new Map([[OUTSIDE_CHANGE, commit(44)]]),
    });
    await expect(
      runner(handle.runner).runRevisionGates(request({ trackedSourceReadOnly: false })),
    ).rejects.toMatchObject({
      name: "RevisionGateError",
      code: "unexpected_mutation_detected",
    });
  });

  it("rolls the repo back to the pre-run operation id after an unexpected mutation", async () => {
    const handle = createDouble({
      commits: fullTreeCommits(),
      mutations: new Map([[OUTSIDE_CHANGE, commit(44)]]),
    });
    await expect(
      runner(handle.runner).runRevisionGates(request({ trackedSourceReadOnly: false })),
    ).rejects.toBeInstanceOf(RevisionGateError);
    expect(handle.restoredOperationId()).toBe("op-0001");
  });

  it("fails on ANY mutation when trackedSourceReadOnly is set", async () => {
    const handle = createDouble({
      commits: fullTreeCommits(),
      // Even an INTENDED amendment fails a read-only gate profile.
      mutations: new Map([[MID_CHANGE, commit(22)]]),
    });
    await expect(
      runner(handle.runner).runRevisionGates(request({ trackedSourceReadOnly: true })),
    ).rejects.toMatchObject({
      name: "RevisionGateError",
      code: "unexpected_mutation_detected",
    });
    expect(handle.restoredOperationId()).toBe("op-0001");
  });
});

// -------------------------------------------------------------------------------------------------
// Tests: jj + receipt failures.
// -------------------------------------------------------------------------------------------------

describe("revision gate runner: jj failures surface as jj_run_failed", () => {
  it("maps a thrown jj run to a jj_run_failed error", async () => {
    const handle = createDouble({
      commits: fullTreeCommits(),
      exitByChange: new Map([[BASE_CHANGE, "throw"]]),
    });
    await expect(runner(handle.runner).runRevisionGates(request())).rejects.toMatchObject({
      name: "RevisionGateError",
      code: "jj_run_failed",
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Tests: bounded parallelism.
// -------------------------------------------------------------------------------------------------

describe("revision gate runner: bounded parallelism", () => {
  it("runs revisions concurrently but never above parallelism", async () => {
    const handle = createDouble({ commits: fullTreeCommits() });
    await runner(handle.runner).runRevisionGates(request({ parallelism: 2 }));

    // 3 revisions, parallelism 2: at least two overlapped, never more than two.
    expect(handle.maxConcurrency()).toBeGreaterThanOrEqual(2);
    expect(handle.maxConcurrency()).toBeLessThanOrEqual(2);
  });

  it("respects a parallelism of 1 (fully serial)", async () => {
    const handle = createDouble({ commits: fullTreeCommits() });
    await runner(handle.runner).runRevisionGates(request({ parallelism: 1 }));
    expect(handle.maxConcurrency()).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------------
// Tests: pure helpers.
// -------------------------------------------------------------------------------------------------

describe("revision gate domain: pure helpers", () => {
  it("buildRevisionRevset unions change ids and reduces the empty set to none()", () => {
    expect(buildRevisionRevset([])).toBe("none()");
    expect(buildRevisionRevset([BASE_CHANGE])).toBe(`(${BASE_CHANGE})`);
    expect(buildRevisionRevset([BASE_CHANGE, MID_CHANGE])).toBe(
      `(${BASE_CHANGE}) | (${MID_CHANGE})`,
    );
  });

  it("validateNoUnexpectedMutation flags only changes outside the intended revset", () => {
    const before: readonly RevisionIdSnapshot[] = [
      { changeId: BASE_CHANGE, commitId: "c1" },
      { changeId: MID_CHANGE, commitId: "c2" },
      { changeId: OUTSIDE_CHANGE, commitId: "c4" },
    ];
    // MID (intended) and OUTSIDE (not intended) both amended.
    const after: readonly RevisionIdSnapshot[] = [
      { changeId: BASE_CHANGE, commitId: "c1" },
      { changeId: MID_CHANGE, commitId: "c2-new" },
      { changeId: OUTSIDE_CHANGE, commitId: "c4-new" },
    ];
    const proof = validateNoUnexpectedMutation(INTENDED_CHANGES, before, after);
    expect(proof.changedChangeIds).toEqual([MID_CHANGE, OUTSIDE_CHANGE]);
    expect(proof.unexpectedChangeIds).toEqual([OUTSIDE_CHANGE]);
    expect(proof.unexpectedMutation).toBe(true);
  });

  it("validateNoUnexpectedMutation reports no mutation when nothing changed", () => {
    const snapshot: readonly RevisionIdSnapshot[] = [
      { changeId: BASE_CHANGE, commitId: "c1" },
      { changeId: MID_CHANGE, commitId: "c2" },
    ];
    const proof = validateNoUnexpectedMutation(INTENDED_CHANGES, snapshot, snapshot);
    expect(proof.changedChangeIds).toEqual([]);
    expect(proof.unexpectedMutation).toBe(false);
  });
});
