import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  contentHash,
  gitSha,
  nonEmptyText,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type ContentHash,
  type GitSha,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
} from "@minions/core";
import {
  createFixupCoordinator,
  createJjCentralRepoManager,
  createJjWorkingCopyManager,
  createProductionFixupWorkingCopy,
  createSqliteVcsChangeBindingStore,
  ensureJjCapability,
  type FixupCoordinator,
  type JjWorkingCopyManager,
  type ProductionFixupWorkingCopy,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * PR 39 — fixup targeting via jj absorb, exercised through a REAL, jj-backed
 * {@link ProductionFixupWorkingCopy} (fixup-working-copy.ts) against a real
 * git+jj repo, instead of fixup.test.ts's test-local `FakeWorkingCopy`. Same
 * behavioral contract (fold into the originating change, restack the
 * descendant, detect a conflicting fold as mis-targeting) proven end to end
 * with the real pinned jj v0.43.0 binary and a real SQLite binding store —
 * not just that the fake keeps returning whatever it is scripted to return.
 *
 * Stack built for every test: A (originating) commits `shared.txt` (3 lines)
 * and `a.ts`. C (descendant, built on A) commits a change to `shared.txt`
 * line 2 only, leaving `a.ts` untouched. A fixup child of C can then target
 * either file: a fix to `a.ts` (never touched by C) folds cleanly into A; a
 * fix that ALSO touches `shared.txt` line 2 (which C already changed, so the
 * fixup's diff assumes C's line 2, not A's original) conflicts when squashed
 * into A, whose line 2 never moved — the same mechanics verified against the
 * real binary in jj-working-copy.test.ts's squashInto conflict test.
 */

const downloadTimeoutMs = 180_000;
const BASE_TIME = 1_700_000_000_000;
const TREE_ID: TaskTreeId = taskTreeId("01900000-0000-7000-8000-000000000139");
const ORIGIN_NODE_ID: TaskNodeId = taskNodeId("01900000-0000-7000-8000-000000000140");
const DESCENDANT_NODE_ID: TaskNodeId = taskNodeId("01900000-0000-7000-8000-000000000141");

const temporaryDirectories: string[] = [];
let jjBinaryPath: string;

beforeAll(async () => {
  const toolsDirectory = await makeDirectory("fixup-wc-tools-");
  const probe = await ensureJjCapability({ toolsDirectory });
  expect(probe.available).toBe(true);
  if (!probe.available) {
    throw new Error(`jj capability unavailable: ${probe.message}`);
  }
  jjBinaryPath = probe.binaryPath;
}, downloadTimeoutMs);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

let stackCounter = 0;

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Host-side raw jj invocation for seeding the central repo (bypasses the broker deliberately). */
function runJj(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      jjBinaryPath,
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`jj ${args.join(" ")} failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function firstNonEmptyLine(value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

// -------------------------------------------------------------------------------------------------
// Real jj scaffold: a central repo + one node working copy, with A and C committed on top.
// -------------------------------------------------------------------------------------------------

interface RealStack {
  readonly jjManager: JjWorkingCopyManager;
  readonly fixupWorkingCopy: ProductionFixupWorkingCopy;
  readonly workingCopyId: string;
  readonly originChangeId: ContentHash;
  readonly originCommit: GitSha;
  readonly descendantChangeId: ContentHash;
  readonly descendantCommit: GitSha;
}

/**
 * Bootstrap a real central jj repo (PR 27), a real per-node working copy
 * (PR 28), then commit A (originating: `shared.txt` + `a.ts`) and C
 * (descendant, built on A: `shared.txt` line 2 changed only) through the
 * broker. Registers both raw change ids with the production fixup adapter and
 * returns their `ContentHash` fingerprints, ready to seed real bindings.
 */
async function buildRealStack(clock: FixedClock): Promise<RealStack> {
  stackCounter += 1;
  const prefix = `fixup-wc-${String(stackCounter)}`;
  const centralHostRoot = await makeDirectory(`${prefix}-central-host-`);
  const centralSourceRoot = await makeDirectory(`${prefix}-central-source-`);
  const wcHostRoot = await makeDirectory(`${prefix}-wc-host-`);
  const centralIds = new SequenceIdGenerator([
    `01900000-0000-7000-8000-0000000${String(stackCounter).padStart(5, "0")}`,
  ]);
  const centralManager = createJjCentralRepoManager({
    jjBinaryPath,
    hostRoot: centralHostRoot,
    clock,
    ids: centralIds,
  });
  const centralRepo = await centralManager.bootstrap(
    centralSourceRoot,
    repositoryId(`01900000-0000-7000-8000-0000001${String(stackCounter).padStart(5, "0")}`),
  );

  // Host-side seeding: a real base commit + bookmark, directly through jj (the
  // sandboxed harness is barred from jj; the host broker owns bootstrapping).
  await writeFile(join(centralRepo.jjRepoPath, "README.md"), "central workspace\n", "utf8");
  await runJj(centralRepo.jjRepoPath, ["file", "track", "README.md"]);
  await runJj(centralRepo.jjRepoPath, ["commit", "-m", "base commit"]);
  const baseChangeId = firstNonEmptyLine(
    await runJj(centralRepo.jjRepoPath, [
      "log",
      "--no-graph",
      "-r",
      "@-",
      "-T",
      'change_id ++ "\n"',
    ]),
  );
  const baseCommit = firstNonEmptyLine(
    await runJj(centralRepo.jjRepoPath, [
      "log",
      "--no-graph",
      "-r",
      "@-",
      "-T",
      'commit_id ++ "\n"',
    ]),
  );
  await runJj(centralRepo.jjRepoPath, ["bookmark", "create", "main", "-r", baseChangeId]);

  const wcIds = new SequenceIdGenerator([
    `01900000-0000-7000-8000-0000002${String(stackCounter).padStart(5, "0")}`,
  ]);
  const jjManager = createJjWorkingCopyManager({
    jjBinaryPath,
    centralRepoPath: centralRepo.jjRepoPath,
    hostRoot: wcHostRoot,
    clock,
    ids: wcIds,
  });

  const wc = await jjManager.createWorkingCopy(
    taskNodeId(`01900000-0000-7000-8000-0000003${String(stackCounter).padStart(5, "0")}`),
    gitSha(baseCommit),
  );

  await writeFile(join(wc.workingCopyPath, "shared.txt"), "one\ntwo\nthree\n", "utf8");
  await writeFile(join(wc.workingCopyPath, "a.ts"), "export const a = 1;\n", "utf8");
  const originReceipt = await jjManager.commit(
    wc.workingCopyId,
    nonEmptyText("A: shared.txt + a.ts", "m"),
  );

  await writeFile(join(wc.workingCopyPath, "shared.txt"), "one\nTWO-C\nthree\n", "utf8");
  const descendantReceipt = await jjManager.commit(
    originReceipt.newWorkingCopyId,
    nonEmptyText("C: shared.txt line 2", "m"),
  );

  const fixupWorkingCopy = createProductionFixupWorkingCopy(jjManager);
  const originChangeId = fixupWorkingCopy.registerChange(
    descendantReceipt.newWorkingCopyId,
    originReceipt.workingCopyId,
  );
  const descendantChangeId = fixupWorkingCopy.registerChange(
    descendantReceipt.newWorkingCopyId,
    descendantReceipt.workingCopyId,
  );

  return {
    jjManager,
    fixupWorkingCopy,
    workingCopyId: descendantReceipt.newWorkingCopyId,
    originChangeId,
    originCommit: originReceipt.commitSha,
    descendantChangeId,
    descendantCommit: descendantReceipt.commitSha,
  };
}

function binding(
  nodeId: TaskNodeId,
  changeId: ContentHash,
  commitId: GitSha,
  parentChangeId: ContentHash | undefined,
  clock: FixedClock,
): VcsChangeBinding {
  return Object.freeze({
    treeId: TREE_ID,
    nodeId,
    jjChangeId: changeId,
    currentCommitId: commitId,
    parentChangeId,
    bookmark: undefined,
    rewriteGeneration: 0,
    lastJjOperationId: contentHash("0".repeat(64)),
    lastPushedCommitId: undefined,
    lastReviewedCommitId: undefined,
    conflictState: "clean",
    recordedAt: clock.now(),
  });
}

// -------------------------------------------------------------------------------------------------
// Harness: fresh host database + fixup coordinator per test.
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

function coordinatorFor(stack: RealStack): FixupCoordinator {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createFixupCoordinator({
    workingCopy: stack.fixupWorkingCopy,
    bindingStore: createSqliteVcsChangeBindingStore({ database: temporary.database }),
    clock,
    ids: new SequenceIdGenerator(["fixup-real-1", "fixup-real-2"]),
  });
}

async function seedStack(stack: RealStack): Promise<void> {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  const store = createSqliteVcsChangeBindingStore({ database: temporary.database });
  await store.upsertBinding(
    binding(ORIGIN_NODE_ID, stack.originChangeId, stack.originCommit, undefined, clock),
  );
  await store.upsertBinding(
    binding(
      DESCENDANT_NODE_ID,
      stack.descendantChangeId,
      stack.descendantCommit,
      stack.originChangeId,
      clock,
    ),
  );
}

async function readBinding(nodeId: TaskNodeId): Promise<VcsChangeBinding> {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  const store = createSqliteVcsChangeBindingStore({ database: temporary.database });
  const result = await store.getBinding(TREE_ID, nodeId);
  if (result === undefined) {
    throw new Error(`no binding found for node ${nodeId}`);
  }
  return result;
}

// -------------------------------------------------------------------------------------------------
// Clean absorb — real jj squash, real restack, real binding updates.
// -------------------------------------------------------------------------------------------------

describe("production FixupWorkingCopy — clean absorb via real jj squash", () => {
  it("folds the fix into A, restacks C, and records real commit ids in the bindings", async () => {
    const stack = await buildRealStack(clock);
    await seedStack(stack);

    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1,2 @@",
      " export const a = 1;",
      "+export const fixed = true;",
      "",
    ].join("\n");

    const result = await coordinatorFor(stack).absorbFixup(
      {
        treeId: TREE_ID,
        fixNodeId: ORIGIN_NODE_ID,
        originatingChangeId: stack.originChangeId,
        descendantChangeId: stack.descendantChangeId,
      },
      { patch: nonEmptyText(patch, "patch") },
    );

    expect(result.absorbed).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.restackedNodes).toStrictEqual([String(DESCENDANT_NODE_ID)]);
    expect(result.invalidatedEvidence).toStrictEqual([String(DESCENDANT_NODE_ID)]);

    // The originating binding's commit genuinely changed (real jj squash landed).
    const origin = await readBinding(ORIGIN_NODE_ID);
    expect(origin.currentCommitId).not.toBe(stack.originCommit);
    expect(origin.rewriteGeneration).toBe(1);
    expect(origin.conflictState).toBe("clean");
    // The change id is stable across a clean squash --into (jj's own guarantee).
    expect(origin.jjChangeId).toBe(stack.originChangeId);

    // The descendant was genuinely restacked: new commit, re-parented onto A.
    const descendant = await readBinding(DESCENDANT_NODE_ID);
    expect(descendant.currentCommitId).not.toBe(stack.descendantCommit);
    expect(descendant.parentChangeId).toBe(stack.originChangeId);
    expect(descendant.rewriteGeneration).toBe(1);
    expect(descendant.conflictState).toBe("clean");

    // Independent confirmation directly against the real jj binary: the
    // originating change's new commit actually contains the fix, has exactly
    // one parent, and is not conflicted.
    const described = await stack.jjManager.describeRevision(
      stack.workingCopyId,
      origin.currentCommitId,
    );
    expect(described.parentCount).toBe(1);
    expect(described.conflicted).toBe(false);
    const diffText = new TextDecoder().decode(
      await stack.jjManager.diffRevision(stack.workingCopyId, origin.currentCommitId),
    );
    expect(diffText).toContain("fixed = true");
  }, 120_000);
});

// -------------------------------------------------------------------------------------------------
// Mis-targeted absorb — a real conflicting fold is detected and blocked.
// -------------------------------------------------------------------------------------------------

describe("production FixupWorkingCopy — mis-targeted absorb via a real conflicting fold", () => {
  it("blocks a fix that does not fold cleanly into the originating change (conflict_in_absorb)", async () => {
    const stack = await buildRealStack(clock);
    await seedStack(stack);

    // The fixup (child of C) touches shared.txt line 2 AGAIN, on top of C's
    // own "TWO-C" (so the fixup's diff assumes "TWO-C" as line 2's prior
    // state) — but A (the absorb target) never saw C's change; A's line 2 is
    // still the original "two". Squashing this fixup into A conflicts.
    const patch = [
      "diff --git a/shared.txt b/shared.txt",
      "--- a/shared.txt",
      "+++ b/shared.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-TWO-C",
      "+TWO-FIXUP",
      " three",
      "",
    ].join("\n");

    await expect(
      coordinatorFor(stack).absorbFixup(
        {
          treeId: TREE_ID,
          fixNodeId: ORIGIN_NODE_ID,
          originatingChangeId: stack.originChangeId,
          descendantChangeId: stack.descendantChangeId,
        },
        { patch: nonEmptyText(patch, "patch") },
      ),
    ).rejects.toMatchObject({ name: "FixupError", code: "conflict_in_absorb" });

    // The originating binding is untouched (the coordinator rejects before
    // rewriting bindings on a conflicted fold).
    const origin = await readBinding(ORIGIN_NODE_ID);
    expect(origin.currentCommitId).toBe(stack.originCommit);
    expect(origin.rewriteGeneration).toBe(0);
  }, 120_000);
});
