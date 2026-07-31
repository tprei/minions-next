import { DatabaseSync } from "node:sqlite";

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type DaemonModeName = "host" | "local" | "supervisor";

export type DaemonLifecycleRecord = Readonly<{
  instanceId: string;
  mode: DaemonModeName;
  pid: number;
  port: number;
  startedAtMs: number;
}>;

export type LifecycleLockInspection =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "active" | "stale"; record: DaemonLifecycleRecord }>
  | Readonly<{ state: "corrupt" }>;

export type AcquireLifecycleLockOptions = Readonly<{
  path: string;
  record: DaemonLifecycleRecord;
}>;

export type AcquiredLifecycleLock = Readonly<{
  path: string;
  record: DaemonLifecycleRecord;
  reconciledStaleLock: boolean;
  release: () => void;
}>;

export type LifecycleLockErrorCode = "active_daemon" | "lock_corrupt" | "lock_operation_failed";

export class LifecycleLockError extends Error {
  readonly code: LifecycleLockErrorCode;
  readonly record: DaemonLifecycleRecord | undefined;

  constructor(
    code: LifecycleLockErrorCode,
    message: string,
    options?: ErrorOptions & Readonly<{ record?: DaemonLifecycleRecord }>,
  ) {
    super(message, options);
    this.name = "LifecycleLockError";
    this.code = code;
    this.record = options?.record;
  }
}

export function daemonLifecyclePath(home: string): string {
  return join(home, "run", "daemon.lock");
}

export function inspectLifecycleLock(path: string): LifecycleLockInspection {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return Object.freeze({ state: "absent" });
    }
    throw new LifecycleLockError("lock_operation_failed", "daemon lifecycle lock cannot be read", {
      cause: error,
    });
  }
  let record: DaemonLifecycleRecord;
  try {
    record = parseLifecycleRecord(content);
  } catch {
    return Object.freeze({ state: "corrupt" });
  }
  return Object.freeze({
    state: isOperatingSystemLockHeld(path) ? "active" : "stale",
    record,
  });
}

export function acquireLifecycleLock(options: AcquireLifecycleLockOptions): AcquiredLifecycleLock {
  validateLifecycleRecord(options.record);
  const directory = dirname(options.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ownership = acquireOperatingSystemLock(options.path);
  const inspection = inspectLifecycleLock(options.path);
  if (inspection.state === "corrupt") {
    releaseOperatingSystemLock(ownership);
    throw new LifecycleLockError("lock_corrupt", "daemon lifecycle lock is corrupt");
  }
  const reconciledStaleLock = inspection.state !== "absent";
  if (inspection.state !== "absent") {
    unlinkLock(options.path);
  }

  const temporaryPath = `${options.path}.${options.record.instanceId}.tmp`;
  try {
    writeSynchronizedRecord(temporaryPath, options.record);
    linkSync(temporaryPath, options.path);
    unlinkSync(temporaryPath);
    synchronizeDirectory(directory);
    let released = false;
    return Object.freeze({
      path: options.path,
      record: options.record,
      reconciledStaleLock,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        let failure: Error | undefined;
        try {
          releaseOwnedLock(options.path, options.record.instanceId);
        } catch (error) {
          failure =
            error instanceof Error
              ? error
              : new LifecycleLockError("lock_operation_failed", "lifecycle release failed");
        } finally {
          releaseOperatingSystemLock(ownership);
        }
        if (failure !== undefined) {
          throw failure;
        }
      },
    });
  } catch (error) {
    removeIfPresent(temporaryPath);
    releaseOperatingSystemLock(ownership);
    throw new LifecycleLockError(
      "lock_operation_failed",
      "daemon lifecycle lock cannot be acquired",
      {
        cause: error,
      },
    );
  }
}

function isOperatingSystemLockHeld(path: string): boolean {
  const ownershipPath = `${path}.sqlite`;
  if (!existsSync(ownershipPath)) {
    return false;
  }
  const database = new DatabaseSync(ownershipPath);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK");
    return false;
  } catch (error) {
    if (isDatabaseLockedError(error)) {
      return true;
    }
    throw new LifecycleLockError(
      "lock_operation_failed",
      "operating system lifecycle lock cannot be inspected",
      { cause: error },
    );
  } finally {
    database.close();
  }
}

function acquireOperatingSystemLock(path: string): DatabaseSync {
  const database = new DatabaseSync(`${path}.sqlite`);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    return database;
  } catch (error) {
    database.close();
    if (isDatabaseLockedError(error)) {
      const inspection = inspectLifecycleLock(path);
      if (inspection.state === "active") {
        throw new LifecycleLockError("active_daemon", "another daemon owns the lifecycle lock", {
          record: inspection.record,
          cause: error,
        });
      }
      throw new LifecycleLockError("active_daemon", "another daemon is starting", {
        cause: error,
      });
    }
    throw new LifecycleLockError(
      "lock_operation_failed",
      "operating system lifecycle lock cannot be acquired",
      { cause: error },
    );
  }
}

function isDatabaseLockedError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("database is locked");
}

function releaseOperatingSystemLock(database: DatabaseSync): void {
  try {
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

function synchronizeDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeSynchronizedRecord(path: string, record: DaemonLifecycleRecord): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function releaseOwnedLock(path: string, instanceId: string): void {
  const inspection = inspectLifecycleLock(path);
  if (inspection.state === "absent") {
    return;
  }
  if (inspection.state === "corrupt" || inspection.record.instanceId !== instanceId) {
    throw new LifecycleLockError(
      "lock_operation_failed",
      "daemon lifecycle lock ownership changed",
    );
  }
  unlinkLock(path);
  synchronizeDirectory(dirname(path));
}

function unlinkLock(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw new LifecycleLockError(
        "lock_operation_failed",
        "daemon lifecycle lock cannot be removed",
        {
          cause: error,
        },
      );
    }
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function parseLifecycleRecord(content: string): DaemonLifecycleRecord {
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null) {
    throw new TypeError("lifecycle record must be an object");
  }
  const record = Object.freeze({
    instanceId: property(value, "instanceId"),
    mode: property(value, "mode"),
    pid: property(value, "pid"),
    port: property(value, "port"),
    startedAtMs: property(value, "startedAtMs"),
  });
  validateLifecycleRecord(record);
  return record;
}

type UnvalidatedLifecycleRecord = Readonly<{
  instanceId: unknown;
  mode: unknown;
  pid: unknown;
  port: unknown;
  startedAtMs: unknown;
}>;

function validateLifecycleRecord(
  value: UnvalidatedLifecycleRecord,
): asserts value is DaemonLifecycleRecord {
  if (typeof value.instanceId !== "string" || !uuidV7Pattern.test(value.instanceId)) {
    throw new TypeError("lifecycle instance ID is invalid");
  }
  if (value.mode !== "local" && value.mode !== "supervisor" && value.mode !== "host") {
    throw new TypeError("lifecycle daemon mode is invalid");
  }
  if (!Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid <= 0) {
    throw new TypeError("lifecycle PID is invalid");
  }
  if (
    !Number.isSafeInteger(value.port) ||
    typeof value.port !== "number" ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    throw new TypeError("lifecycle port is invalid");
  }
  if (
    !Number.isSafeInteger(value.startedAtMs) ||
    typeof value.startedAtMs !== "number" ||
    value.startedAtMs < 0
  ) {
    throw new TypeError("lifecycle start time is invalid");
  }
}

function property(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === code
  );
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
