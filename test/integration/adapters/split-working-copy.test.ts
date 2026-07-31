import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gitSha,
  nonEmptyText,
  planRevisionId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type ContentHash,
  type ExistingTreeNode,
  type PlanRevisionId,
  type TaskNodeId,
  type TaskTreeId,
} from "@minions/core";
import {
  createJjCentralRepoManager,
  createJjWorkingCopyManager,
  createProductionSplitWorkingCopy,
  createSplitCoordinator,
  ensureJjCapability,
  type JjWorkingCopyManager,
  type ProductionSplitWorkingCopy,
  type SplitChildRecord,
  type SplitCoordinator,
  type SplitPlanRegistry,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * PR 40 — plan repair via split, exercised through a REAL, jj-backed
 * {@link ProductionSplitWorkingCopy} (split-working-copy.ts) against a real
 * git+jj repo, instead of node-split.test.ts's `FakeWorkingCopy` ("The
 * working-copy broker is a test double (mocked jj split)"). The plan registry
 * stays a fake here deliberately — recording plan revisions is PR 09's
 * concern, unaffected by this change; only the jj split surface is real.
 */

const downloadTimeoutMs = 180_000;
const TREE_ID: TaskTreeId = taskTreeId("01900000-0000-7000-8000-000000000241");
const NODE_ID: TaskNodeId = taskNodeId("01900000-0000-7000-8000-000000000242");
const PLAN_REVISION: PlanRevisionId = planRevisionId("01900000-0000-7000-8000-000000000243");

const temporaryDirectories: string[] = [];
let jjBinaryPath: string;

beforeAll(async () => {
  const toolsDirectory = await makeDirectory("split-wc-tools-");
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

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

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

interface RealStack {
  readonly jjManager: JjWorkingCopyManager;
  readonly splitWorkingCopy: ProductionSplitWorkingCopy;
  readonly workingCopyId: string;
  readonly workingCopyPath: string;
  readonly originalChangeId: ContentHash;
  readonly originalRawChangeId: string;
}

async function buildRealStack(clock: FixedClock): Promise<RealStack> {
  const centralHostRoot = await makeDirectory("split-wc-central-host-");
  const centralSourceRoot = await makeDirectory("split-wc-central-source-");
  const wcHostRoot = await makeDirectory("split-wc-host-");
  const centralManager = createJjCentralRepoManager({
    jjBinaryPath,
    hostRoot: centralHostRoot,
    clock,
    ids: new SequenceIdGenerator(["01900000-0000-7000-8000-000000000c50"]),
  });
  const centralRepo = await centralManager.bootstrap(
    centralSourceRoot,
    repositoryId("01900000-0000-7000-8000-000000000c51"),
  );

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

  const jjManager = createJjWorkingCopyManager({
    jjBinaryPath,
    centralRepoPath: centralRepo.jjRepoPath,
    hostRoot: wcHostRoot,
    clock,
    ids: new SequenceIdGenerator(["01900000-0000-7000-8000-000000000c52"]),
  });
  const wc = await jjManager.createWorkingCopy(
    taskNodeId("01900000-0000-7000-8000-000000000c53"),
    gitSha(baseCommit),
  );

  await writeFile(join(wc.workingCopyPath, "a.txt"), "a\n", "utf8");
  await writeFile(join(wc.workingCopyPath, "b.txt"), "b\n", "utf8");
  const receipt = await jjManager.commit(wc.workingCopyId, nonEmptyText("oversized node", "m"));

  const splitWorkingCopy = createProductionSplitWorkingCopy(jjManager);
  const originalChangeId = splitWorkingCopy.registerChange(
    receipt.newWorkingCopyId,
    receipt.workingCopyId,
  );

  return {
    jjManager,
    splitWorkingCopy,
    workingCopyId: receipt.newWorkingCopyId,
    workingCopyPath: wc.workingCopyPath,
    originalChangeId,
    originalRawChangeId: receipt.workingCopyId,
  };
}

class FakePlanRegistry implements SplitPlanRegistry {
  readonly recordSplitCalls: { readonly children: readonly SplitChildRecord[] }[] = [];

  getNode(): Promise<ExistingTreeNode | undefined> {
    return Promise.resolve(Object.freeze({ nodeId: NODE_ID, depth: 0, approved: false }));
  }

  recordSplit(input: {
    readonly children: readonly SplitChildRecord[];
  }): Promise<Readonly<{ planRevisionId: PlanRevisionId }>> {
    (this.recordSplitCalls as { readonly children: readonly SplitChildRecord[] }[]).push(
      Object.freeze({ children: input.children }),
    );
    return Promise.resolve(Object.freeze({ planRevisionId: PLAN_REVISION }));
  }
}

function coordinatorFor(
  stack: RealStack,
  planRegistry: SplitPlanRegistry,
  clock: FixedClock,
): SplitCoordinator {
  return createSplitCoordinator({
    workingCopy: stack.splitWorkingCopy,
    bindingStore: {
      upsertBinding: () => Promise.resolve(),
      getBinding: () =>
        Promise.resolve(
          Object.freeze({
            treeId: TREE_ID,
            nodeId: NODE_ID,
            jjChangeId: stack.originalChangeId,
            currentCommitId: gitSha("0".repeat(40)),
            parentChangeId: undefined,
            bookmark: undefined,
            rewriteGeneration: 0,
            lastJjOperationId: stack.originalChangeId,
            lastPushedCommitId: undefined,
            lastReviewedCommitId: undefined,
            conflictState: "clean" as const,
            recordedAt: clock.now(),
          }),
        ),
      getByChangeId: () => Promise.resolve(undefined),
      listForTree: () => Promise.resolve([]),
      assertNoOrphans: () => Promise.resolve(),
      assertNoDuplicates: () => Promise.resolve(),
    },
    planRegistry,
    clock,
    ids: new SequenceIdGenerator([
      "01900000-0000-7000-8000-000000000c60",
      "01900000-0000-7000-8000-000000000c61",
      "01900000-0000-7000-8000-000000000c62",
    ]),
  });
}

describe("production SplitWorkingCopy — N-segment fileset split via real jj split", () => {
  it("produces N children by fileset, each with parent count 1, and records a plan revision", async () => {
    const clock = new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000));
    const stack = await buildRealStack(clock);
    const planRegistry = new FakePlanRegistry();

    const plan = await coordinatorFor(stack, planRegistry, clock).executeSplit({
      treeId: TREE_ID,
      nodeId: NODE_ID,
      splits: [
        { label: nonEmptyText("segment a", "label"), fileset: ["a.txt"] },
        { label: nonEmptyText("segment b", "label"), fileset: ["b.txt"] },
      ],
    });

    expect(plan.resultingNodes).toHaveLength(2);
    expect(plan.planRevisionId).toBe(PLAN_REVISION);
    expect(planRegistry.recordSplitCalls).toHaveLength(1);
    expect(planRegistry.recordSplitCalls[0]?.children).toHaveLength(2);

    // Independently confirm against the real binary (bypassing the ContentHash
    // fingerprint space entirely): exactly two visible children of the
    // original's own parent, each with exactly one parent.
    const changeIds = new Set(plan.resultingNodes.map((node) => node.changeId));
    expect(changeIds.size).toBe(2);
    const originalParent = await runJj(stack.workingCopyPath, [
      "log",
      "--no-graph",
      "-r",
      `${stack.originalRawChangeId}-`,
      "-T",
      'change_id ++ "\n"',
    ]);
    const parent = firstNonEmptyLine(originalParent);
    const childrenLog = await runJj(stack.workingCopyPath, [
      "log",
      "--no-graph",
      "-r",
      `${parent}+`,
      "-T",
      'change_id ++ " parents=" ++ parents.len() ++ "\n"',
    ]);
    const childLines = childrenLog
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // 3 children of the original's parent: the 2 new segments plus the
    // original itself (now emptied, but still present as a sibling — jj split
    // -o <parent> never removes the source, per jj-working-copy.test.ts's own
    // split coverage).
    expect(childLines).toHaveLength(3);
    for (const line of childLines) {
      expect(line.endsWith("parents=1")).toBe(true);
    }
  }, 120_000);

  it("throws a typed error for a hunkRanges-only segment (no scriptable non-interactive jj path)", async () => {
    const clock = new FixedClock(timestampFromEpochMilliseconds(1_700_000_000_000));
    const stack = await buildRealStack(clock);

    await expect(
      stack.splitWorkingCopy.splitSegment(
        stack.originalChangeId,
        Object.freeze({
          label: nonEmptyText("partial", "label"),
          fileset: Object.freeze(["a.txt"]),
          hunkRanges: Object.freeze([Object.freeze({ path: "a.txt", startLine: 1, endLine: 1 })]),
        }),
        0,
      ),
    ).rejects.toMatchObject({
      name: "ProductionSplitWorkingCopyError",
      code: "hunk_ranges_not_supported",
    });
  }, 60_000);
});
