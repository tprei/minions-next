import {
  acquireLifecycleLock,
  daemonLifecyclePath,
  inspectLifecycleLock,
  LifecycleLockError,
  type DaemonLifecycleRecord,
} from "@minions/adapters";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strict as assert } from "node:assert";
import { describe, expect, it } from "vitest";

const IMPOSSIBLE_PID = 2_147_483_647;
const STARTED_AT_MS = 1_700_000_000_000;

function lifecycleRecord(instanceId: string, pid = process.pid): DaemonLifecycleRecord {
  return {
    instanceId,
    mode: "local",
    pid,
    port: 38_001,
    startedAtMs: STARTED_AT_MS,
  };
}

function withTemporaryDirectory(operation: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "minions-lifecycle-lock-"));
  try {
    operation(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function expectLifecycleError(
  action: () => unknown,
  code: LifecycleLockError["code"],
): LifecycleLockError {
  let thrown: unknown;
  try {
    action();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LifecycleLockError);
  assert(thrown instanceof LifecycleLockError);
  expect(thrown.code).toBe(code);
  return thrown;
}

describe("lifecycle locks", () => {
  it("acquires a caller-provided lock path and releases it", () => {
    withTemporaryDirectory((directory) => {
      const path = daemonLifecyclePath(directory);
      const record = lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef123456");

      const acquired = acquireLifecycleLock({ path, record });

      expect(acquired.path).toBe(path);
      expect(acquired.record).toEqual(record);
      expect(acquired.reconciledStaleLock).toBe(false);
      expect(inspectLifecycleLock(path)).toEqual({ state: "active", record });

      acquired.release();

      expect(inspectLifecycleLock(path)).toEqual({ state: "absent" });
    });
  });

  it("rejects an active duplicate without replacing its owner", () => {
    withTemporaryDirectory((directory) => {
      const path = join(directory, "custom", "daemon.lock");
      const firstRecord = lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef123457");
      const secondRecord = lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef123458");
      const first = acquireLifecycleLock({ path, record: firstRecord });

      const error = expectLifecycleError(
        () => acquireLifecycleLock({ path, record: secondRecord }),
        "active_daemon",
      );

      expect(error.record).toEqual(firstRecord);
      expect(inspectLifecycleLock(path)).toEqual({ state: "active", record: firstRecord });
      first.release();
    });
  });

  it("rejects a corrupt lock and preserves the corrupt file", () => {
    withTemporaryDirectory((directory) => {
      const path = join(directory, "corrupt", "daemon.lock");
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
      writeFileSync(path, "not-json\n", "utf8");

      expect(inspectLifecycleLock(path)).toEqual({ state: "corrupt" });
      const error = expectLifecycleError(
        () =>
          acquireLifecycleLock({
            path,
            record: lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef123459"),
          }),
        "lock_corrupt",
      );

      expect(error.record).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("not-json\n");
    });
  });

  it("reconciles a lock owned by an impossible process ID", () => {
    withTemporaryDirectory((directory) => {
      const path = join(directory, "stale", "daemon.lock");
      const staleRecord = lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef12345a", IMPOSSIBLE_PID);
      const currentRecord = lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef12345b");
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
      writeFileSync(path, `${JSON.stringify(staleRecord)}\n`, "utf8");

      expect(inspectLifecycleLock(path)).toEqual({ state: "stale", record: staleRecord });
      const acquired = acquireLifecycleLock({ path, record: currentRecord });

      expect(acquired.reconciledStaleLock).toBe(true);
      expect(inspectLifecycleLock(path)).toEqual({ state: "active", record: currentRecord });
      acquired.release();
    });
  });

  it("does not treat a reused live PID as lifecycle ownership", () => {
    withTemporaryDirectory((directory) => {
      const path = join(directory, "reused-pid", "daemon.lock");
      const unrelatedRecord = lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef12345e", process.pid);
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
      writeFileSync(path, `${JSON.stringify(unrelatedRecord)}\n`, "utf8");

      expect(inspectLifecycleLock(path)).toEqual({ state: "stale", record: unrelatedRecord });
    });
  });

  it("does not release a lock after ownership changes", () => {
    withTemporaryDirectory((directory) => {
      const path = join(directory, "ownership", "daemon.lock");
      const ownerRecord = lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef12345c");
      const replacementRecord = lifecycleRecord("018f3a2e-4a20-7b90-8123-abcdef12345d");
      const owner = acquireLifecycleLock({ path, record: ownerRecord });
      writeFileSync(path, `${JSON.stringify(replacementRecord)}\n`, "utf8");

      const error = expectLifecycleError(() => {
        owner.release();
      }, "lock_operation_failed");

      expect(error.record).toBeUndefined();
      expect(inspectLifecycleLock(path)).toEqual({ state: "stale", record: replacementRecord });
      unlinkSync(path);
    });
  });
});
