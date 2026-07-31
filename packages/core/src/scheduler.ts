import { DomainError } from "./domain-error.js";
import type {
  AttemptId,
  EvidenceId,
  HostId,
  RepositoryId,
  TaskNodeId,
  TaskTreeId,
  Timestamp,
} from "./value-objects.js";

declare const schedulerLeaseIdBrand: unique symbol;
declare const schedulerOwnerIdBrand: unique symbol;
declare const fencingTokenBrand: unique symbol;

export type SchedulerLeaseId = string & { readonly [schedulerLeaseIdBrand]: true };
export type SchedulerOwnerId = string & { readonly [schedulerOwnerIdBrand]: true };
export type FencingToken = bigint & { readonly [fencingTokenBrand]: true };

export type SchedulerCapacityPolicy = Readonly<{
  maxActiveGlobal: number;
  maxActivePerTree: number;
}>;

export type SchedulerLease = Readonly<{
  id: SchedulerLeaseId;
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  repositoryId: RepositoryId;
  hostId: HostId;
  ownerId: SchedulerOwnerId;
  fencingToken: FencingToken;
  acquiredAt: Timestamp;
  heartbeatAt: Timestamp;
  expiresAt: Timestamp;
}>;

export type SchedulerLeaseReference = Readonly<{
  id: SchedulerLeaseId;
  ownerId: SchedulerOwnerId;
  fencingToken: FencingToken;
}>;

export type ClaimSchedulerLeaseRequest = Readonly<{
  ownerId: SchedulerOwnerId;
  at: Timestamp;
  leaseDurationMs: number;
  capacity: SchedulerCapacityPolicy;
}>;

export type HeartbeatSchedulerLeaseRequest = Readonly<{
  lease: SchedulerLeaseReference;
  at: Timestamp;
  leaseDurationMs: number;
}>;

export type ReleaseSchedulerLeaseRequest = Readonly<{
  lease: SchedulerLeaseReference;
  at: Timestamp;
}>;

export type CancelScheduledNodeRequest = Readonly<{
  nodeId: TaskNodeId;
  evidenceId: EvidenceId;
  at: Timestamp;
}>;

export type ExpiredSchedulerLeaseRecovery = Readonly<{
  leaseId: SchedulerLeaseId | undefined;
  attemptId: AttemptId | undefined;
  nodeId: TaskNodeId | undefined;
  recovered: boolean;
  retryScheduled: boolean;
  error: string | undefined;
}>;

export interface SchedulerStore {
  claimNext(request: ClaimSchedulerLeaseRequest): Promise<SchedulerLease | undefined>;
  heartbeat(request: HeartbeatSchedulerLeaseRequest): Promise<SchedulerLease>;
  release(request: ReleaseSchedulerLeaseRequest): Promise<void>;
  cancelNode(request: CancelScheduledNodeRequest): Promise<void>;
  recoverExpired(at: Timestamp): Promise<readonly ExpiredSchedulerLeaseRecovery[]>;
}

export interface SchedulerDispatcher {
  dispatch(lease: SchedulerLease): Promise<void>;
}

export type SchedulerLoopOptions = Readonly<{
  ownerId: SchedulerOwnerId;
  capacity: SchedulerCapacityPolicy;
  leaseDurationMs: number;
  pollIntervalMs: number;
}>;

export interface SchedulerLoop {
  start(): void;
  wake(): void;
  runOnce(): Promise<number>;
  stop(): Promise<void>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function schedulerLeaseId(value: string): SchedulerLeaseId {
  if (!uuidPattern.test(value)) {
    throw new DomainError("invalid_value", "scheduler lease ID must be a lowercase UUID");
  }
  return value as SchedulerLeaseId;
}

export function schedulerOwnerId(value: string): SchedulerOwnerId {
  if (value.trim().length === 0) {
    throw new DomainError("invalid_value", "scheduler owner ID must not be empty");
  }
  return value as SchedulerOwnerId;
}

export function fencingToken(value: bigint): FencingToken {
  if (value <= 0n) {
    throw new DomainError("invalid_value", "scheduler fencing token must be positive");
  }
  return value as FencingToken;
}

export function schedulerCapacityPolicy(
  maxActiveGlobal: number,
  maxActivePerTree: number,
): SchedulerCapacityPolicy {
  requirePositiveSafeInteger(maxActiveGlobal, "global scheduler capacity");
  requirePositiveSafeInteger(maxActivePerTree, "per-tree scheduler capacity");
  return Object.freeze({ maxActiveGlobal, maxActivePerTree });
}

export function validateSchedulerTiming(leaseDurationMs: number, pollIntervalMs: number): void {
  requirePositiveSafeInteger(leaseDurationMs, "scheduler lease duration");
  requirePositiveSafeInteger(pollIntervalMs, "scheduler poll interval");
  if (pollIntervalMs >= leaseDurationMs) {
    throw new DomainError(
      "invalid_value",
      "scheduler poll interval must be shorter than the lease duration",
    );
  }
}

function requirePositiveSafeInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError("invalid_value", `${fieldName} must be a positive safe integer`);
  }
}
