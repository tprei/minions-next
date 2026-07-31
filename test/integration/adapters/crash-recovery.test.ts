import {
  contentHash,
  MILLIS_PER_DAY,
  nonEmptyText,
  orderedPhases,
  recoveryBoundary,
  recoveryError,
  recoveryReport,
  retentionPolicy,
  RECOVERY_PHASE_ORDER,
  shouldCompact,
  shouldPurge,
  timestampFromEpochMilliseconds,
  type ExpectedBlob,
  type ExpiredSchedulerLeaseRecovery,
  type RecoveryBoundary,
  type RecoveryPhase,
  type RetentionPolicy,
  type SchedulerLease,
  type SchedulerStore,
  type WorkspaceReceipt,
  type WorkspaceStatus,
} from "@minions/core";
import {
  blobReconciler,
  createFileContentBlobStore,
  createRecoveryCoordinator,
  schedulerLeaseReconciler,
  workspaceReconciler,
  type CompactionReport,
  type PhaseReconciliation,
  type PurgeReport,
  type RecoveryCompactor,
  type RecoveryCoordinator,
  type RecoveryPurger,
  type RecoveryReconciler,
} from "@minions/adapters";
import type { WorkspaceManager } from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * PR 37 — ordered crash recovery + retention.
 *
 * Covers: the canonical ordered phase sequence; isolated per-phase errors (one
 * corrupt node never blocks unrelated recovery); idempotent recovery (no
 * duplicate effects, no lost completed work); skipped phases; convergence
 * gating scheduling; separate archive (compact) / purge / recovery operations;
 * and the store-backed adapter helpers (real blob store, fake scheduler +
 * workspace ports).
 */

// -------------------------------------------------------------------------------------------------
// Constants.
// -------------------------------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const clock = new FixedClock(timestampFromEpochMilliseconds(BASE_TIME));
const DAY = MILLIS_PER_DAY;
const POLICY: RetentionPolicy = retentionPolicy({
  eventRetentionDays: 14,
  blobRetentionDays: 30,
  transcriptRetentionDays: 60,
  compactionIntervalDays: 7,
  purgeAfterDays: 90,
});

/** Every boundary the brief names, mapped to its recovery phase. */
const BOUNDARY_PHASES: readonly (readonly [string, RecoveryPhase, readonly string[]])[] = [
  ["blob", "blobs", ["blob-orphan-1", "blob-orphan-2"]],
  ["lease", "leases", ["lease-node-1"]],
  ["harness", "sandboxes", ["sandbox-orphan-1"]],
  ["workspace", "workspaces", ["workspace-stopped-1"]],
  ["commit", "vcs_oplog", ["commit-divergent-1"]],
  ["gate", "gates", ["gate-stale-1"]],
  ["push", "pull_requests", ["push-stale-1"]],
  ["PR", "pull_requests", []], // same phase; covered by the push row
  ["CI", "ci", ["ci-stale-1"]],
  ["restack", "restacks", ["restack-incomplete-1"]],
  ["landing", "landing_receipts", ["landing-missing-1"]],
] as const;

// -------------------------------------------------------------------------------------------------
// Test doubles.
// -------------------------------------------------------------------------------------------------

/**
 * An idempotent subsystem simulator. `crashedNodeIds` are the nodes left in a
 * crashed state by a prior run; the first reconcile recovers them and every
 * subsequent reconcile is a no-op (no duplicate effects). Recovered nodes are
 * never lost (only ever added to `recoveredNodeIds`).
 */
class FakeSubsystem implements RecoveryReconciler {
  readonly phase: RecoveryPhase;
  readonly boundary: string;
  private readonly crashedNodeIds: ReadonlySet<string>;
  private readonly callOrder: string[];
  readonly recoveredNodeIds = new Set<string>();
  reconcileCount = 0;

  constructor(opts: {
    readonly phase: RecoveryPhase;
    readonly boundary: string;
    readonly crashedNodeIds: readonly string[];
    readonly callOrder: string[];
  }) {
    this.phase = opts.phase;
    this.boundary = opts.boundary;
    this.crashedNodeIds = new Set(opts.crashedNodeIds);
    this.callOrder = opts.callOrder;
  }

  reconcile(): Promise<PhaseReconciliation> {
    this.reconcileCount += 1;
    this.callOrder.push(this.phase);
    let recovered = 0;
    for (const id of this.crashedNodeIds) {
      if (!this.recoveredNodeIds.has(id)) {
        this.recoveredNodeIds.add(id);
        recovered += 1;
      }
    }
    const recoveredTotal = this.recoveredNodeIds.size;
    return Promise.resolve({
      boundary: this.boundary,
      beforeId: `${this.phase}:recovered=${String(recoveredTotal - recovered)}`,
      afterId: `${this.phase}:recovered=${String(recoveredTotal)}`,
      reconciledCount: recovered,
      divergentCount: 0,
      notes: undefined,
    });
  }

  /** Total nodes recovered across all reconciles (idempotency probe). */
  reconciledTotal(): number {
    return this.recoveredNodeIds.size;
  }
}

/** A subsystem that always fails to reconcile (a corrupt/ambiguous node). */
class CorruptSubsystem implements RecoveryReconciler {
  readonly phase: RecoveryPhase;
  readonly boundary: string;
  readonly nodeId: string;

  constructor(opts: {
    readonly phase: RecoveryPhase;
    readonly boundary: string;
    readonly nodeId: string;
  }) {
    this.phase = opts.phase;
    this.boundary = opts.boundary;
    this.nodeId = opts.nodeId;
  }

  reconcile(): Promise<PhaseReconciliation> {
    return Promise.reject(new CorruptNodeError(this.phase, this.nodeId));
  }
}

class CorruptNodeError extends Error {
  readonly nodeId: string;
  constructor(phase: RecoveryPhase, nodeId: string) {
    super(`corrupt node ${nodeId} in phase ${phase}`);
    this.name = "CorruptNodeError";
    this.nodeId = nodeId;
  }
}

/** A subsystem that reports a non-fatal divergence (e.g. a corrupt digest). */
class DivergentSubsystem implements RecoveryReconciler {
  readonly phase: RecoveryPhase;
  readonly boundary: string;
  constructor(phase: RecoveryPhase, boundary: string) {
    this.phase = phase;
    this.boundary = boundary;
  }
  reconcile(): Promise<PhaseReconciliation> {
    return Promise.resolve({
      boundary: this.boundary,
      beforeId: undefined,
      afterId: undefined,
      reconciledCount: 0,
      divergentCount: 1,
      notes: "1 corrupt digest observed",
    });
  }
}

/** A scheduler store fake that returns canned expired-lease recoveries. */
class FakeSchedulerStore implements SchedulerStore {
  private readonly recoveries: readonly ExpiredSchedulerLeaseRecovery[];
  recoverExpiredCount = 0;
  constructor(recoveries: readonly ExpiredSchedulerLeaseRecovery[]) {
    this.recoveries = recoveries;
  }
  recoverExpired(): Promise<readonly ExpiredSchedulerLeaseRecovery[]> {
    this.recoverExpiredCount += 1;
    return Promise.resolve(this.recoveries);
  }
  claimNext(): Promise<SchedulerLease | undefined> {
    return Promise.reject(new Error("FakeSchedulerStore.claimNext is not used"));
  }
  heartbeat(): Promise<SchedulerLease> {
    return Promise.reject(new Error("FakeSchedulerStore.heartbeat is not used"));
  }
  release(): Promise<void> {
    return Promise.reject(new Error("FakeSchedulerStore.release is not used"));
  }
  cancelNode(): Promise<void> {
    return Promise.reject(new Error("FakeSchedulerStore.cancelNode is not used"));
  }
}

/** A workspace manager fake that returns a canned recover() result. */
class FakeWorkspaceManager implements WorkspaceManager {
  private readonly receipts: readonly WorkspaceReceipt[];
  recoverCount = 0;
  constructor(receipts: readonly WorkspaceReceipt[]) {
    this.receipts = receipts;
  }
  recover(): Promise<readonly WorkspaceReceipt[]> {
    this.recoverCount += 1;
    return Promise.resolve(this.receipts);
  }
  create(): Promise<WorkspaceReceipt> {
    return Promise.reject(new Error("FakeWorkspaceManager.create is not used"));
  }
  captureStatus(): Promise<WorkspaceStatus> {
    return Promise.reject(new Error("FakeWorkspaceManager.captureStatus is not used"));
  }
  cleanup(): Promise<WorkspaceReceipt> {
    return Promise.reject(new Error("FakeWorkspaceManager.cleanup is not used"));
  }
}

/** A compactor fake that mints tombstones (archive markers). */
class FakeCompactor implements RecoveryCompactor {
  readonly tombstones: string[] = [];
  compactCount = 0;
  compact(policy: RetentionPolicy, now: number): Promise<CompactionReport> {
    this.compactCount += 1;
    const created = 3;
    for (let index = 0; index < created; index += 1) {
      this.tombstones.push(`tombstone:${String(now)}:${String(index)}`);
    }
    return Promise.resolve({
      compactedAt: now,
      eventsCompacted: policy.eventRetentionDays > 0 ? 1 : 0,
      blobsCompacted: policy.blobRetentionDays > 0 ? 1 : 0,
      transcriptsCompacted: policy.transcriptRetentionDays > 0 ? 1 : 0,
      tombstonesCreated: created,
    });
  }
}

/** A purger fake that drops tombstones. */
class FakePurger implements RecoveryPurger {
  tombstonesPurged = 0;
  purgeCount = 0;
  purge(policy: RetentionPolicy, now: number): Promise<PurgeReport> {
    void policy;
    this.purgeCount += 1;
    this.tombstonesPurged += 3;
    return Promise.resolve({
      purgedAt: now,
      eventsPurged: 1,
      blobsPurged: 1,
      transcriptsPurged: 1,
      tombstonesPurged: 3,
    });
  }
}

let nowValue = BASE_TIME;
const advanceNow = (deltaMs: number): void => {
  nowValue += deltaMs;
};
const now = (): number => nowValue;

function coordinator(opts: {
  readonly reconcilers?: Partial<Record<RecoveryPhase, RecoveryReconciler>>;
  readonly compactor?: RecoveryCompactor;
  readonly purger?: RecoveryPurger;
  readonly isolateErrors?: boolean;
  readonly failIfNotConverged?: boolean;
}): RecoveryCoordinator {
  return createRecoveryCoordinator({ now, ...opts });
}

/** A SequenceIdGenerator preloaded with valid UUIDv7-format ids. */
function idPool(count: number): SequenceIdGenerator {
  return new SequenceIdGenerator(
    Array.from({ length: count }, (_, index) => {
      const suffix = index.toString(16).padStart(12, "0").slice(-12);
      return `01900000-0000-7000-8000-${suffix}`;
    }),
  );
}

beforeEach(() => {
  nowValue = BASE_TIME;
});

// -------------------------------------------------------------------------------------------------
// Pure domain.
// -------------------------------------------------------------------------------------------------

describe("recovery pure domain: canonical ordered phase sequence", () => {
  it("returns the ten phases in the brief's canonical order", () => {
    expect(orderedPhases()).toEqual([
      "blobs",
      "leases",
      "sandboxes",
      "workspaces",
      "vcs_oplog",
      "gates",
      "pull_requests",
      "ci",
      "restacks",
      "landing_receipts",
    ]);
  });

  it("matches the exported frozen RECOVERY_PHASE_ORDER and is immutable", () => {
    expect(orderedPhases()).toEqual(RECOVERY_PHASE_ORDER);
    expect(Object.isFrozen(RECOVERY_PHASE_ORDER)).toBe(true);
    expect(() => {
      // A frozen array rejects runtime mutation (strict mode throws).
      (RECOVERY_PHASE_ORDER as string[]).push("nope");
    }).toThrow();
    expect(RECOVERY_PHASE_ORDER).toHaveLength(10);
  });
});

describe("recovery pure domain: retention policy + cadence predicates", () => {
  it("validates a well-formed policy", () => {
    expect(POLICY.eventRetentionDays).toBe(14);
    expect(POLICY.compactionIntervalDays).toBe(7);
  });

  it("rejects negative or non-integer retention days", () => {
    expect(() =>
      retentionPolicy({
        eventRetentionDays: -1,
        blobRetentionDays: 30,
        transcriptRetentionDays: 60,
        compactionIntervalDays: 7,
        purgeAfterDays: 90,
      }),
    ).toThrow(TypeError);
    expect(() =>
      retentionPolicy({
        eventRetentionDays: 1.5,
        blobRetentionDays: 30,
        transcriptRetentionDays: 60,
        compactionIntervalDays: 7,
        purgeAfterDays: 90,
      }),
    ).toThrow(TypeError);
  });

  it("shouldCompact: disabled when compactionIntervalDays is 0", () => {
    const disabled = retentionPolicy({
      eventRetentionDays: 1,
      blobRetentionDays: 1,
      transcriptRetentionDays: 1,
      compactionIntervalDays: 0,
      purgeAfterDays: 1,
    });
    expect(shouldCompact(disabled, { now: BASE_TIME, lastRunAtMs: undefined })).toBe(false);
  });

  it("shouldCompact: due when never run, not due within the interval, due after it", () => {
    expect(shouldCompact(POLICY, { now: BASE_TIME, lastRunAtMs: undefined })).toBe(true);
    const last = BASE_TIME;
    expect(shouldCompact(POLICY, { now: last + (DAY * 7 - 1), lastRunAtMs: last })).toBe(false);
    expect(shouldCompact(POLICY, { now: last + DAY * 7, lastRunAtMs: last })).toBe(true);
  });

  it("shouldPurge: disabled when purgeAfterDays is 0 even if compaction is on", () => {
    const noPurge = retentionPolicy({
      eventRetentionDays: 1,
      blobRetentionDays: 1,
      transcriptRetentionDays: 1,
      compactionIntervalDays: 7,
      purgeAfterDays: 0,
    });
    expect(shouldPurge(noPurge, { now: BASE_TIME, lastRunAtMs: undefined })).toBe(false);
  });

  it("shouldPurge: shares the compaction cadence", () => {
    expect(shouldPurge(POLICY, { now: BASE_TIME, lastRunAtMs: undefined })).toBe(true);
    const last = BASE_TIME;
    expect(shouldPurge(POLICY, { now: last + (DAY * 7 - 1), lastRunAtMs: last })).toBe(false);
    expect(shouldPurge(POLICY, { now: last + DAY * 7, lastRunAtMs: last })).toBe(true);
  });
});

describe("recovery pure domain: report + boundary + error builders", () => {
  const boundary = (phase: RecoveryPhase, status: RecoveryBoundary["status"]): RecoveryBoundary =>
    recoveryBoundary({ phase, boundary: phase, beforeId: undefined, afterId: undefined, status });

  it("converges only with zero errors and every executed boundary converged", () => {
    const converged = recoveryReport({
      phases: [boundary("blobs", "converged"), boundary("landing_receipts", "converged")],
      errors: [],
      skippedPhases: ["leases"],
    });
    expect(converged.converged).toBe(true);
  });

  it("does not converge when any boundary is divergent", () => {
    const report = recoveryReport({
      phases: [boundary("blobs", "converged"), boundary("gates", "divergent")],
      errors: [],
      skippedPhases: [],
    });
    expect(report.converged).toBe(false);
  });

  it("does not converge when there are errors, even if boundaries converged", () => {
    const error = recoveryError({
      phase: "vcs_oplog",
      message: "divergent op log",
      remediation: "reconcile jj op log",
    });
    const report = recoveryReport({
      phases: [boundary("blobs", "converged")],
      errors: [error],
      skippedPhases: [],
    });
    expect(report.converged).toBe(false);
    expect(report.errors[0]?.phase).toBe("vcs_oplog");
  });

  it("skipped phases do not count against convergence", () => {
    const report = recoveryReport({
      phases: [boundary("blobs", "converged")],
      errors: [],
      skippedPhases: ["leases", "sandboxes"],
    });
    expect(report.converged).toBe(true);
    expect(report.skippedPhases).toEqual(["leases", "sandboxes"]);
  });

  it("rejects an empty boundary name and empty error text", () => {
    expect(() =>
      recoveryBoundary({
        phase: "blobs",
        boundary: "",
        beforeId: undefined,
        afterId: undefined,
        status: "converged",
      }),
    ).toThrow(TypeError);
    expect(() => recoveryError({ phase: "blobs", message: "", remediation: "fix it" })).toThrow(
      TypeError,
    );
    expect(() => recoveryError({ phase: "blobs", message: "boom", remediation: "" })).toThrow(
      TypeError,
    );
  });
});

// -------------------------------------------------------------------------------------------------
// Ordered recovery: kill at every boundary converges idempotently.
// -------------------------------------------------------------------------------------------------

describe("recovery: ordered phases run in canonical sequence and converge idempotently", () => {
  const callOrder: string[] = [];
  const subsystems = new Map<RecoveryPhase, FakeSubsystem>();
  for (const phase of orderedPhases()) {
    const crashed = BOUNDARY_PHASES.filter((row) => row[1] === phase).flatMap((row) => row[2]);
    const sub = new FakeSubsystem({ phase, boundary: phase, crashedNodeIds: crashed, callOrder });
    subsystems.set(phase, sub);
  }
  const reconcilers: Partial<Record<RecoveryPhase, RecoveryReconciler>> = {};
  for (const [phase, sub] of subsystems) {
    reconcilers[phase] = sub;
  }

  it("runs every phase exactly once, in order, and converges", async () => {
    const report = await coordinator({ reconcilers }).recover();
    expect(callOrder).toEqual([...orderedPhases()]);
    expect(report.phases.map((b) => b.phase)).toEqual([...orderedPhases()]);
    expect(report.phases.every((b) => b.status === "converged")).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.skippedPhases).toEqual([]);
    expect(report.converged).toBe(true);
  });

  it("is idempotent: re-running recovers nothing new (no duplicate effects)", async () => {
    const first = await coordinator({ reconcilers }).recover();
    const firstRecovered = [...subsystems.values()].reduce(
      (sum, sub) => sum + sub.reconciledTotal(),
      0,
    );
    const second = await coordinator({ reconcilers }).recover();
    const secondRecovered = [...subsystems.values()].reduce(
      (sum, sub) => sum + sub.reconciledTotal(),
      0,
    );
    expect(first.converged).toBe(true);
    expect(second.converged).toBe(true);
    expect(secondRecovered).toBe(firstRecovered); // no duplicate effects
    // every boundary is a no-op the second time
    expect(second.phases.every((b) => b.status === "converged")).toBe(true);
  });

  it("loses no completed work: recovered nodes are preserved across runs", async () => {
    await coordinator({ reconcilers }).recover();
    const afterFirst = new Map<RecoveryPhase, ReadonlySet<string>>();
    for (const [phase, sub] of subsystems) {
      afterFirst.set(phase, new Set(sub.recoveredNodeIds));
    }
    await coordinator({ reconcilers }).recover();
    for (const [phase, sub] of subsystems) {
      const before = afterFirst.get(phase);
      expect(before).toBeDefined();
      // every node recovered in the first run is still recovered (a superset)
      for (const id of before ?? []) {
        expect(sub.recoveredNodeIds.has(id)).toBe(true);
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Isolated errors: one corrupt node does not block unrelated recovery.
// -------------------------------------------------------------------------------------------------

describe("recovery: one corrupt node is isolated and does not block others", () => {
  it("records the corrupt phase as an error and still converges every other phase", async () => {
    const callOrder: string[] = [];
    const healthy: Partial<Record<RecoveryPhase, RecoveryReconciler>> = {};
    for (const phase of orderedPhases()) {
      if (phase === "vcs_oplog") {
        continue;
      }
      healthy[phase] = new FakeSubsystem({
        phase,
        boundary: phase,
        crashedNodeIds: [`${phase}-node-1`],
        callOrder,
      });
    }
    healthy.vcs_oplog = new CorruptSubsystem({
      phase: "vcs_oplog",
      boundary: "commit",
      nodeId: "commit-divergent-corrupt",
    });

    const report = await coordinator({ reconcilers: healthy }).recover();

    // the corrupt phase ran but failed
    const oplogBoundary = report.phases.find((b) => b.phase === "vcs_oplog");
    expect(oplogBoundary?.status).toBe("error");
    expect(report.errors).toHaveLength(1);
    const onlyError = report.errors[0];
    expect(onlyError?.phase).toBe("vcs_oplog");
    expect(onlyError?.nodeId).toBe("commit-divergent-corrupt");
    expect(onlyError?.remediation.length).toBeGreaterThan(0);

    // every other phase still ran, in order, and converged
    const healthyPhases = orderedPhases().filter((p) => p !== "vcs_oplog");
    expect(callOrder).toEqual([...healthyPhases]);
    for (const phase of healthyPhases) {
      const boundary = report.phases.find((b) => b.phase === phase);
      expect(boundary?.status).toBe("converged");
    }
    expect(report.converged).toBe(false); // one error => not converged
    expect(report.skippedPhases).toEqual([]);
  });

  it("a divergent (non-fatal) boundary marks the report not converged without an error", async () => {
    const report = await coordinator({
      reconcilers: {
        blobs: new DivergentSubsystem("blobs", "blob"),
        landing_receipts: new FakeSubsystem({
          phase: "landing_receipts",
          boundary: "landing",
          crashedNodeIds: ["landing-missing-1"],
          callOrder: [],
        }),
      },
    }).recover();
    const blobs = report.phases.find((b) => b.phase === "blobs");
    expect(blobs?.status).toBe("divergent");
    expect(report.errors).toEqual([]); // divergence is not a thrown error
    expect(report.converged).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// Skipped phases.
// -------------------------------------------------------------------------------------------------

describe("recovery: phases without a reconciler are skipped, not failed", () => {
  it("skips unwired phases and still converges", async () => {
    const report = await coordinator({
      reconcilers: {
        blobs: new FakeSubsystem({
          phase: "blobs",
          boundary: "blob",
          crashedNodeIds: ["b1"],
          callOrder: [],
        }),
        landing_receipts: new FakeSubsystem({
          phase: "landing_receipts",
          boundary: "landing",
          crashedNodeIds: ["l1"],
          callOrder: [],
        }),
      },
    }).recover();
    expect(report.skippedPhases).toEqual(
      orderedPhases().filter((p) => p !== "blobs" && p !== "landing_receipts"),
    );
    expect(report.converged).toBe(true);
    expect(report.errors).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Convergence gates scheduling + fail-fast mode.
// -------------------------------------------------------------------------------------------------

describe("recovery: convergence gates scheduling", () => {
  it("returns a converged report when everything is healthy (scheduling may proceed)", async () => {
    const report = await coordinator({
      reconcilers: {
        blobs: new FakeSubsystem({
          phase: "blobs",
          boundary: "blob",
          crashedNodeIds: ["b1"],
          callOrder: [],
        }),
      },
      failIfNotConverged: true,
    }).recover();
    expect(report.converged).toBe(true);
  });

  it("throws convergence_failed when not converged and the gate is set", async () => {
    await expect(
      coordinator({
        reconcilers: {
          vcs_oplog: new CorruptSubsystem({
            phase: "vcs_oplog",
            boundary: "commit",
            nodeId: "corrupt-1",
          }),
        },
        failIfNotConverged: true,
      }).recover(),
    ).rejects.toMatchObject({ name: "RecoveryCoordinatorError", code: "convergence_failed" });
  });

  it("isolates by default: a throw is a report error, not a thrown coordinator error", async () => {
    const report = await coordinator({
      reconcilers: {
        gates: new CorruptSubsystem({ phase: "gates", boundary: "gate", nodeId: "g1" }),
      },
    }).recover();
    expect(report.errors).toHaveLength(1);
    expect(report.converged).toBe(false);
  });

  it("fail-fast mode (isolateErrors false) throws phase_failed on the first error", async () => {
    await expect(
      coordinator({
        reconcilers: {
          blobs: new CorruptSubsystem({ phase: "blobs", boundary: "blob", nodeId: "b1" }),
          leases: new FakeSubsystem({
            phase: "leases",
            boundary: "lease",
            crashedNodeIds: ["l1"],
            callOrder: [],
          }),
        },
        isolateErrors: false,
      }).recover(),
    ).rejects.toMatchObject({ name: "RecoveryCoordinatorError", code: "phase_failed" });
  });
});

// -------------------------------------------------------------------------------------------------
// Compact / purge / recovery are distinct operations.
// -------------------------------------------------------------------------------------------------

describe("retention: compact (archive), purge, and recovery are distinct operations", () => {
  it("recover does not compact or purge; compact creates tombstones; purge drops them", async () => {
    const compactor = new FakeCompactor();
    const purger = new FakePurger();
    const sub = new FakeSubsystem({
      phase: "blobs",
      boundary: "blob",
      crashedNodeIds: ["b1"],
      callOrder: [],
    });
    const coord = coordinator({
      reconcilers: { blobs: sub },
      compactor,
      purger,
    });

    const report = await coord.recover();
    expect(report.converged).toBe(true);
    expect(compactor.compactCount).toBe(0);
    expect(purger.purgeCount).toBe(0);

    advanceNow(DAY * 8);
    const compacted = await coord.compact(POLICY);
    expect(compactor.compactCount).toBe(1);
    expect(compacted.tombstonesCreated).toBe(3);
    expect(compactor.tombstones).toHaveLength(3);

    const purged = await coord.purge(POLICY);
    expect(purger.purgeCount).toBe(1);
    expect(purged.tombstonesPurged).toBe(3);
    // the three operations are observably distinct
    expect(compactor.compactCount).toBe(1);
    expect(purger.purgeCount).toBe(1);
    expect(sub.reconcileCount).toBe(1);
  });

  it("compact without a configured compactor throws compaction_failed", async () => {
    const coord = coordinator({ reconcilers: {} });
    await expect(coord.compact(POLICY)).rejects.toMatchObject({
      name: "RecoveryCoordinatorError",
      code: "compaction_failed",
    });
  });

  it("purge without a configured purger throws purge_failed", async () => {
    const coord = coordinator({ reconcilers: {} });
    await expect(coord.purge(POLICY)).rejects.toMatchObject({
      name: "RecoveryCoordinatorError",
      code: "purge_failed",
    });
  });

  it("compact propagates a compactor throw as compaction_failed", async () => {
    const coord = coordinator({
      reconcilers: {},
      compactor: {
        compact(): Promise<CompactionReport> {
          return Promise.reject(new Error("disk full"));
        },
      },
    });
    await expect(coord.compact(POLICY)).rejects.toMatchObject({
      name: "RecoveryCoordinatorError",
      code: "compaction_failed",
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Adapter helpers.
// -------------------------------------------------------------------------------------------------

describe("adapter: schedulerLeaseReconciler maps recoverExpired to a phase result", () => {
  it("counts recovered/retried leases as progress and per-lease errors as divergence", async () => {
    const recoveries: readonly ExpiredSchedulerLeaseRecovery[] = [
      {
        leaseId: undefined,
        attemptId: undefined,
        nodeId: undefined,
        recovered: true,
        retryScheduled: false,
        error: undefined,
      },
      {
        leaseId: undefined,
        attemptId: undefined,
        nodeId: undefined,
        recovered: false,
        retryScheduled: true,
        error: undefined,
      },
      {
        leaseId: undefined,
        attemptId: undefined,
        nodeId: undefined,
        recovered: false,
        retryScheduled: false,
        error: "stale lease owner vanished",
      },
    ];
    const store = new FakeSchedulerStore(recoveries);
    const reconciler = schedulerLeaseReconciler(store, clock);
    const result = await reconciler.reconcile();
    expect(reconciler.phase).toBe("leases");
    expect(result.boundary).toBe("lease");
    expect(result.reconciledCount).toBe(2); // recovered + retried
    expect(result.divergentCount).toBe(1); // one per-lease error
    expect(store.recoverExpiredCount).toBe(1);
  });

  it("is idempotent across repeated reconciles (store is the source of truth)", async () => {
    const store = new FakeSchedulerStore([]);
    const reconciler = schedulerLeaseReconciler(store, clock);
    const first = await reconciler.reconcile();
    const second = await reconciler.reconcile();
    expect(first.reconciledCount).toBe(0);
    expect(second.reconciledCount).toBe(0);
    expect(store.recoverExpiredCount).toBe(2);
  });
});

describe("adapter: workspaceReconciler maps manager.recover to a phase result", () => {
  it("reports the number of recovered workspace receipts", async () => {
    const receipts: readonly WorkspaceReceipt[] = [];
    const manager = new FakeWorkspaceManager(receipts);
    const reconciler = workspaceReconciler(manager);
    const result = await reconciler.reconcile();
    expect(reconciler.phase).toBe("workspaces");
    expect(result.boundary).toBe("workspace");
    expect(result.reconciledCount).toBe(0);
    expect(result.divergentCount).toBe(0);
    expect(manager.recoverCount).toBe(1);
  });
});

describe("adapter: blobReconciler against the real file blob store", () => {
  let rootPath: string | undefined;

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), "minions-recovery-blobs-"));
  });

  afterEach(async () => {
    if (rootPath !== undefined) {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("removes orphan blobs, is idempotent, and converges via the coordinator", async () => {
    const store = createFileContentBlobStore({
      rootPath: rootPath ?? "",
      clock,
      ids: idPool(64),
    });

    // Publish a real blob (goes to sha256/xx/yy/<digest>).
    const payload = new TextEncoder().encode("recovery-orphan-payload");
    const published = await store.withPublishedBlob(payload, (blob) => Promise.resolve(blob));
    const expected: readonly ExpectedBlob[] = [
      {
        digest: published.digest,
        sizeBytes: published.sizeBytes,
        relativePath: published.relativePath,
      },
    ];

    // Referenced blob is preserved.
    const keep = await store.reconcile(expected);
    expect(keep.removedOrphanPaths).toHaveLength(0);

    // Now treat it as orphan (nothing references it) -> removed.
    const orphanSweep = await store.reconcile([]);
    expect(orphanSweep.removedOrphanPaths).toHaveLength(1);

    // Idempotent: a second sweep finds nothing.
    const again = await store.reconcile([]);
    expect(again.removedOrphanPaths).toHaveLength(0);

    // Through the coordinator's blobs phase with the adapter helper.
    const coord = coordinator({
      reconcilers: { blobs: blobReconciler(store, () => []) },
    });
    const report = await coord.recover();
    const blobs = report.phases.find((b) => b.phase === "blobs");
    expect(blobs?.status).toBe("converged");
    expect(blobs?.boundary).toBe("blob");
  });

  it("flags a corrupt blob as divergence (missing digest) without throwing", async () => {
    const store = createFileContentBlobStore({
      rootPath: rootPath ?? "",
      clock,
      ids: idPool(64),
    });
    const phantomDigest = contentHash("a".repeat(64));
    const phantom = {
      digest: phantomDigest,
      sizeBytes: 4n,
      relativePath: nonEmptyText(join("sha256", "aa", "aa", "a".repeat(64)), "relative path"),
    };
    const result = await blobReconciler(store, () => [phantom]).reconcile();
    // The phantom digest is absent on disk -> missing -> divergence.
    expect(result.divergentCount).toBe(1);
    expect(result.reconciledCount).toBe(0);
  });

  it("sweeps a stale temporary blob left by a crashed publish", async () => {
    const store = createFileContentBlobStore({
      rootPath: rootPath ?? "",
      clock,
      ids: idPool(64),
    });
    // Publish once to materialize the digest directory layout, then drop a
    // `.tmp-<uuid>` file inside it to simulate a crashed publish.
    const payload = new TextEncoder().encode("temporary-crash-payload");
    const published = await store.withPublishedBlob(payload, (blob) => Promise.resolve(blob));
    const digestDir = dirname(join(rootPath ?? "", published.relativePath));
    const tempName = `.tmp-00000000-0000-7000-8000-000000000037`;
    await writeFile(join(digestDir, tempName), "leftover");

    const result = await blobReconciler(store, () => []).reconcile();
    expect(result.reconciledCount).toBe(2); // the orphan blob + the temporary file
  });
});
