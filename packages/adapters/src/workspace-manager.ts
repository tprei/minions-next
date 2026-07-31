import {
  GitProcessError,
  attemptId,
  gitSha,
  hostId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type AttemptId,
  type Clock,
  type GitProcess,
  type GitSha,
  type HostId,
  type RepositoryId,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
  type WorkspaceReceipt,
  type WorkspaceStatus,
} from "@minions/core";
import type {
  GitMutationLease,
  GitMutationLeaseStore,
  WorkspaceBeginInput,
  WorkspaceRegistry,
} from "./sqlite/workspace-registry.js";
import type { RepositoryRegistration, RepositoryRegistry } from "./sqlite/repository-registry.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

export type WorkspaceCreateInput = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  hostId: HostId;
  repositoryId: RepositoryId;
  ordinal: number;
  baseCommit?: GitSha;
  sourcePath?: string;
  sourceAttemptId?: AttemptId;
}>;

export type WorkspaceStatusInput = Readonly<{
  attemptId: AttemptId;
}>;

export type WorkspaceManagerCleanupInput = Readonly<{
  attemptId: AttemptId;
}>;

export type WorkspaceManagerOptions = Readonly<{
  git: GitProcess;
  workspaceRegistry: WorkspaceRegistry;
  repositoryRegistry: RepositoryRegistry;
  gitMutationLeaseStore: GitMutationLeaseStore;
  clock: Clock;
  ownerId?: string;
  leaseDurationMs?: number;
  leasePollIntervalMs?: number;
  leaseWaitTimeoutMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}>;

export type WorkspaceManagerErrorCode =
  | "invalid_input"
  | "not_found"
  | "repository_invalid"
  | "path_invalid"
  | "source_invalid"
  | "source_changed"
  | "workspace_changed"
  | "workspace_invalid"
  | "workspace_exists"
  | "transition_failed"
  | "lease_failed"
  | "git_failed"
  | "cleanup_failed"
  | "verification_failed"
  | "output_limit";

export class WorkspaceManagerError extends Error {
  readonly code: WorkspaceManagerErrorCode;

  constructor(code: WorkspaceManagerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceManagerError";
    this.code = code;
  }
}

export interface WorkspaceManager {
  create(input: WorkspaceCreateInput): Promise<WorkspaceReceipt>;
  captureStatus(input: WorkspaceStatusInput): Promise<WorkspaceStatus>;
  cleanup(input: WorkspaceManagerCleanupInput): Promise<WorkspaceReceipt>;
  recover(): Promise<readonly WorkspaceReceipt[]>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_LEASE_DURATION_MS = 960_000;
const BRANCH_PREFIX = "minions/";
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export function createWorkspaceManager(options: WorkspaceManagerOptions): WorkspaceManager {
  return new DefaultWorkspaceManager(options);
}

class DefaultWorkspaceManager implements WorkspaceManager {
  readonly #git: GitProcess;
  readonly #workspaceRegistry: WorkspaceRegistry;
  readonly #repositoryRegistry: RepositoryRegistry;
  readonly #leaseStore: GitMutationLeaseStore;
  readonly #clock: Clock;
  readonly #leasePollIntervalMs: number;
  readonly #leaseWaitTimeoutMs: number;
  readonly #ownerId: string;
  readonly #leaseDurationMs: number;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #repositoryTails = new Map<string, Promise<void>>();
  readonly #activeLeases = new Map<RepositoryId, GitMutationLease>();
  readonly #leaseContext = new AsyncLocalStorage<RepositoryId>();

  constructor(options: WorkspaceManagerOptions) {
    this.#git = options.git;
    this.#workspaceRegistry = options.workspaceRegistry;
    this.#repositoryRegistry = options.repositoryRegistry;
    this.#leaseStore = options.gitMutationLeaseStore;
    this.#clock = options.clock;
    this.#ownerId = options.ownerId ?? cryptoRandomUuid();
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#leasePollIntervalMs = options.leasePollIntervalMs ?? 25;
    this.#leaseWaitTimeoutMs = options.leaseWaitTimeoutMs ?? this.#leaseDurationMs;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(this.#ownerId)) {
      throw new WorkspaceManagerError("invalid_input", "workspace manager owner ID must be a UUID");
    }
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new WorkspaceManagerError(
        "invalid_input",
        "workspace manager timeout must be a positive safe integer",
      );
    }
    const minimumLease = this.#timeoutMs * 32;
    if (
      !Number.isSafeInteger(minimumLease) ||
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < minimumLease
    ) {
      throw new WorkspaceManagerError(
        "invalid_input",
        "workspace manager lease duration must be at least 32 command timeouts",
      );
    }
    if (
      !Number.isSafeInteger(this.#leasePollIntervalMs) ||
      this.#leasePollIntervalMs <= 0 ||
      !Number.isSafeInteger(this.#leaseWaitTimeoutMs) ||
      this.#leaseWaitTimeoutMs <= 0
    ) {
      throw new WorkspaceManagerError(
        "invalid_input",
        "workspace lease polling and wait timeouts must be positive safe integers",
      );
    }
    if (!Number.isSafeInteger(this.#maxOutputBytes) || this.#maxOutputBytes <= 0) {
      throw new WorkspaceManagerError(
        "invalid_input",
        "workspace manager output limit must be a positive safe integer",
      );
    }
  }

  async create(input: WorkspaceCreateInput): Promise<WorkspaceReceipt> {
    const candidate = validateCreateInput(input);
    const registration = this.#readRegistration(candidate.repositoryId);
    validateRegistrationContext(registration, candidate);
    return this.#withRepositoryLease(candidate.repositoryId, async () => {
      const existing = this.#readExisting(candidate.attemptId);
      if (existing !== undefined) {
        validateExistingInputIdentity(existing, registration, candidate, this.#workspaceRegistry);
        if (existing.state === "ready") {
          await this.#verifyWorkspace(existing, registration);
          return existing;
        }
        if (existing.state === "creating") {
          let finalExists = false;
          try {
            const metadata = await lstat(existing.workspacePath);
            if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
              throw new WorkspaceManagerError(
                "workspace_invalid",
                "recoverable workspace path is not a directory",
              );
            }
            finalExists = true;
          } catch (error: unknown) {
            if (!isErrno(error, "ENOENT")) throw error;
          }
          if (finalExists) {
            await this.#verifyWorkspace(existing, registration);
            await this.#removeWorkspaceIfPresent(
              temporaryWorkspacePath(
                registration.allowedWorkspaceRoot,
                existing.attemptId,
                existing.mutationFencingToken,
              ),
              registration.allowedWorkspaceRoot,
            );
            await this.#assertAndRenewLeases();
            try {
              return await this.#workspaceRegistry.markReady({
                attemptId: existing.attemptId,
                expectedVersion: existing.version,
                headCommit: existing.baseCommit,
                readyAt: this.#now(),
                ...this.#fence(existing.repositoryId),
              });
            } catch (error: unknown) {
              throw this.#transitionError("workspace replay ready transition failed", error);
            }
          }
        }
      } else {
        await this.#assertCreateTargetsAbsent(
          registration.allowedWorkspaceRoot,
          candidate.attemptId,
        );
      }
      const source = await this.#prepareCreate(candidate, registration);
      if (existing !== undefined) {
        validateExistingReceipt(existing, source, registration, candidate);
      }
      const beginInput: WorkspaceBeginInput = {
        attemptId: candidate.attemptId,
        nodeId: candidate.nodeId,
        treeId: candidate.treeId,
        hostId: candidate.hostId,
        repositoryId: candidate.repositoryId,
        workspacePath: source.workspacePath,
        sourcePath: source.sourcePath,
        branchName: source.branchName,
        baseCommit: source.baseCommit,
        createdAt: existing?.createdAt ?? this.#now(),
        ...this.#fence(candidate.repositoryId),
        ...(existing === undefined ? {} : { expectedVersion: existing.version }),
      };
      let begun: WorkspaceReceipt;
      try {
        begun = await this.#workspaceRegistry.begin(beginInput);
      } catch (error: unknown) {
        throw this.#transitionError("workspace begin failed", error);
      }
      validateReceiptIdentity(begun, source, registration, candidate);
      if (begun.state === "ready") {
        await this.#verifyWorkspace(begun, registration);
        return begun;
      }
      if (begun.state !== "creating") {
        throw new WorkspaceManagerError(
          "transition_failed",
          `workspace begin returned unexpected ${begun.state} state`,
        );
      }

      const temporaryPath = temporaryWorkspacePath(
        registration.allowedWorkspaceRoot,
        candidate.attemptId,
        begun.mutationFencingToken,
      );
      try {
        if (existing?.state === "creating") {
          await this.#removeWorkspaceIfPresent(
            temporaryWorkspacePath(
              registration.allowedWorkspaceRoot,
              existing.attemptId,
              existing.mutationFencingToken,
            ),
            registration.allowedWorkspaceRoot,
          );
        }
        await this.#createWorkspaceDirectory(registration.allowedWorkspaceRoot, temporaryPath);
        await this.#clone(source, temporaryPath);
        await this.#verifyWorkspaceAt(
          temporaryPath,
          source.branchName,
          source.baseCommit,
          source.sourcePath,
          source.objectFormat,
        );
        await this.#verifySourceUnchanged(source);
        await this.#assertAndRenewLeases();
        await this.#assertTargetAbsent(source.workspacePath);
        await rename(temporaryPath, source.workspacePath);
        await this.#verifyWorkspaceAt(
          source.workspacePath,
          source.branchName,
          source.baseCommit,
          source.sourcePath,
          source.objectFormat,
        );
      } catch (error: unknown) {
        await this.#failCreate(begun, registration, temporaryPath, error);
        throw normalizeManagerError(error, "workspace creation failed");
      }

      try {
        const ready = await this.#workspaceRegistry.markReady({
          attemptId: begun.attemptId,
          expectedVersion: begun.version,
          headCommit: source.baseCommit,
          readyAt: this.#now(),
          ...this.#fence(candidate.repositoryId),
        });
        validateReceiptIdentity(ready, source, registration, candidate);
        if (ready.state !== "ready") {
          throw new WorkspaceManagerError(
            "transition_failed",
            "workspace ready transition returned a non-ready state",
          );
        }
        return ready;
      } catch (error: unknown) {
        throw normalizeManagerError(error, "workspace ready transition failed");
      }
    });
  }

  async captureStatus(input: WorkspaceStatusInput): Promise<WorkspaceStatus> {
    const requestedAttempt = parseAttemptId(input.attemptId);
    const receipt = this.#readWorkspace(requestedAttempt);
    if (receipt.state !== "ready") {
      throw new WorkspaceManagerError(
        "transition_failed",
        `workspace status is only available for ready workspaces (state ${receipt.state})`,
      );
    }
    const registration = this.#readRegistration(receipt.repositoryId);
    await this.#verifyWorkspace(receipt, registration);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = await this.#readCapture(receipt.workspacePath);
      const second = await this.#readCapture(receipt.workspacePath);
      if (
        first.head === second.head &&
        bytesEqual(first.status, second.status) &&
        bytesEqual(first.diff, second.diff)
      ) {
        if (first.head !== receipt.headCommit) {
          throw new WorkspaceManagerError(
            "workspace_invalid",
            "workspace HEAD changed while status was captured",
          );
        }
        return Object.freeze({
          attemptId: receipt.attemptId,
          headCommit: receipt.headCommit,
          porcelainV2: new Uint8Array(second.status),
          diff: new Uint8Array(second.diff),
          capturedAt: this.#now(),
        });
      }
    }
    throw new WorkspaceManagerError(
      "workspace_changed",
      "workspace changed continuously while status was captured",
    );
  }

  async cleanup(input: WorkspaceManagerCleanupInput): Promise<WorkspaceReceipt> {
    const requestedAttempt = parseAttemptId(input.attemptId);
    const initial = this.#readWorkspace(requestedAttempt);
    if (initial.state === "cleaned") return initial;
    if (initial.state === "failed") {
      throw new WorkspaceManagerError("transition_failed", "failed workspaces cannot be cleaned");
    }
    const registration = this.#readRegistration(initial.repositoryId);
    return this.#withRepositoryLease(initial.repositoryId, async () => {
      const current = this.#readWorkspace(requestedAttempt);
      if (current.state === "cleaned") return current;
      if (current.state === "failed") {
        throw new WorkspaceManagerError("transition_failed", "failed workspaces cannot be cleaned");
      }
      let pending = current;
      if (current.state === "ready") {
        try {
          pending = await this.#workspaceRegistry.requestCleanup({
            attemptId: current.attemptId,
            expectedVersion: current.version,
            cleanupRequestedAt: this.#now(),
            ...this.#fence(current.repositoryId),
          });
        } catch (error: unknown) {
          throw this.#transitionError("workspace cleanup request failed", error);
        }
      }
      if (pending.state !== "cleanup_pending") {
        if (pending.state === "cleaned") return pending;
        throw new WorkspaceManagerError(
          "transition_failed",
          `workspace cleanup request returned ${pending.state} state`,
        );
      }
      try {
        await this.#removeFencedWorkspace(pending, registration.allowedWorkspaceRoot);
      } catch (error: unknown) {
        throw normalizeManagerError(error, "workspace cleanup failed", "cleanup_failed");
      }
      try {
        return await this.#workspaceRegistry.markCleaned({
          attemptId: pending.attemptId,
          expectedVersion: pending.version,
          cleanedAt: this.#now(),
          ...this.#fence(pending.repositoryId),
        });
      } catch (error: unknown) {
        throw this.#transitionError("workspace cleaned transition failed", error);
      }
    });
  }

  async recover(): Promise<readonly WorkspaceReceipt[]> {
    const recoverable = this.#workspaceRegistry.listRecoverable();
    const recovered = new Array<WorkspaceReceipt | undefined>(recoverable.length);
    const repositories = new Map<
      RepositoryId,
      Readonly<{ index: number; receipt: WorkspaceReceipt }>[]
    >();
    for (const [index, record] of recoverable.entries()) {
      const current = record;
      if (current.state === "ready" || current.state === "cleaned" || current.state === "failed") {
        recovered[index] = current;
        continue;
      }
      const records = repositories.get(current.repositoryId) ?? [];
      records.push({ index, receipt: current });
      repositories.set(current.repositoryId, records);
    }
    const failures: unknown[] = [];
    await Promise.all(
      [...repositories.values()].map(async (records) => {
        for (const record of records) {
          try {
            recovered[record.index] = await this.#recoverOne(record.receipt);
          } catch (error: unknown) {
            failures.push(error);
          }
        }
      }),
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "one or more workspaces could not be recovered");
    }
    return Object.freeze(
      recovered.map((receipt) => {
        if (receipt === undefined) {
          throw new WorkspaceManagerError(
            "transition_failed",
            "workspace recovery did not produce a receipt",
          );
        }
        return receipt;
      }),
    );
  }

  async #recoverOne(current: WorkspaceReceipt): Promise<WorkspaceReceipt> {
    const registration = this.#readRegistration(current.repositoryId);
    return this.#withRepositoryLease(current.repositoryId, async () => {
      const latest = this.#readWorkspace(current.attemptId);
      if (latest.state === "creating") {
        const temporaryPath = temporaryWorkspacePath(
          registration.allowedWorkspaceRoot,
          latest.attemptId,
          latest.mutationFencingToken,
        );
        let finalExists = false;
        try {
          const metadata = await lstat(latest.workspacePath);
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new WorkspaceManagerError(
              "workspace_invalid",
              "recoverable workspace path is not a directory",
            );
          }
          finalExists = true;
        } catch (error: unknown) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
        await this.#removeWorkspaceIfPresent(temporaryPath, registration.allowedWorkspaceRoot);
        if (!finalExists) return latest;
        try {
          await this.#verifyWorkspace(latest, registration);
        } catch (error: unknown) {
          if (!["path_invalid", "workspace_invalid"].includes(errorCode(error) ?? "")) throw error;
          await this.#removeFencedWorkspace(latest, registration.allowedWorkspaceRoot);
          return latest;
        }
        await this.#assertAndRenewLeases();
        try {
          return await this.#workspaceRegistry.markReady({
            attemptId: latest.attemptId,
            expectedVersion: latest.version,
            headCommit: latest.baseCommit,
            readyAt: this.#now(),
            ...this.#fence(latest.repositoryId),
          });
        } catch (error: unknown) {
          throw this.#transitionError("workspace recovery ready transition failed", error);
        }
      }
      if (latest.state === "cleanup_pending") {
        await this.#removeFencedWorkspace(latest, registration.allowedWorkspaceRoot);
        try {
          return await this.#workspaceRegistry.markCleaned({
            attemptId: latest.attemptId,
            expectedVersion: latest.version,
            cleanedAt: this.#now(),
            ...this.#fence(latest.repositoryId),
          });
        } catch (error: unknown) {
          throw this.#transitionError("workspace recovery cleanup transition failed", error);
        }
      }
      return latest;
    });
  }

  #readRegistration(repository: RepositoryId): RepositoryRegistration {
    try {
      return this.#repositoryRegistry.get(repository);
    } catch (error: unknown) {
      throw normalizeManagerError(
        error,
        "repository registration is unavailable",
        "repository_invalid",
      );
    }
  }

  #readWorkspace(requestedAttempt: AttemptId): WorkspaceReceipt {
    try {
      return this.#workspaceRegistry.get(requestedAttempt);
    } catch (error: unknown) {
      throw normalizeManagerError(error, "workspace does not exist", "not_found");
    }
  }

  #readExisting(requestedAttempt: AttemptId): WorkspaceReceipt | undefined {
    try {
      return this.#workspaceRegistry.get(requestedAttempt);
    } catch (error: unknown) {
      if (errorCode(error) === "not_found") return undefined;
      throw normalizeManagerError(error, "workspace lookup failed", "transition_failed");
    }
  }

  async #prepareCreate(
    candidate: ValidCreateInput,
    registration: RepositoryRegistration,
  ): Promise<PreparedSource> {
    let sourcePath = candidate.sourcePath;
    if (sourcePath === undefined && candidate.sourceAttemptId !== undefined) {
      try {
        sourcePath = this.#workspaceRegistry.get(candidate.sourceAttemptId).workspacePath;
      } catch (error: unknown) {
        throw new WorkspaceManagerError(
          "source_invalid",
          "parent workspace source does not exist",
          {
            cause: error,
          },
        );
      }
    }
    sourcePath ??= registration.canonicalRoot;
    const sourceAttempt = candidate.sourceAttemptId;
    const source = await inspectSource(
      sourcePath,
      sourceAttempt,
      registration,
      this.#workspaceRegistry,
      this.#git,
      this.#timeoutMs,
      this.#maxOutputBytes,
      candidate.baseCommit ?? registration.baseCommit,
    );
    const finalPath = workspacePath(registration.allowedWorkspaceRoot, candidate.attemptId);
    const temporaryPath = temporaryWorkspacePath(
      registration.allowedWorkspaceRoot,
      candidate.attemptId,
    );
    validateWorkspacePath(finalPath, registration.allowedWorkspaceRoot);
    validateWorkspacePath(temporaryPath, registration.allowedWorkspaceRoot);
    if (
      pathsOverlap(source.canonicalPath, finalPath) ||
      pathsOverlap(source.canonicalPath, temporaryPath)
    ) {
      throw new WorkspaceManagerError("path_invalid", "workspace path overlaps its source path");
    }
    return Object.freeze({
      sourcePath: source.canonicalPath,
      canonicalPath: source.canonicalPath,
      workspacePath: finalPath,
      branchName: branchName(candidate.treeId, candidate.nodeId, candidate.ordinal),
      baseCommit: source.baseCommit,
      objectFormat: source.objectFormat,
      sourceSnapshot: source.snapshot,
    });
  }

  async #clone(source: PreparedSource, temporaryPath: string): Promise<void> {
    await this.#gitRun(temporaryPath, [
      "init",
      `--object-format=${source.objectFormat}`,
      `--initial-branch=${source.branchName}`,
    ]);
    await this.#gitRun(temporaryPath, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      source.sourcePath,
      source.baseCommit,
    ]);
    const fetched = parseSha(
      await this.#gitText(temporaryPath, [
        "rev-parse",
        "--verify",
        `${source.baseCommit}^{commit}`,
      ]),
      "fetched commit",
    );
    if (fetched !== source.baseCommit) {
      throw new WorkspaceManagerError(
        "verification_failed",
        "local fetch did not produce the requested commit",
      );
    }
    await this.#gitRun(temporaryPath, [
      "checkout",
      "--force",
      "-B",
      source.branchName,
      source.baseCommit,
    ]);
    await this.#pruneRefs(temporaryPath, source.branchName);
  }

  async #pruneRefs(workspace: string, branch: string): Promise<void> {
    const refs = parseLines(
      await this.#gitText(workspace, ["for-each-ref", "--format=%(refname)"]),
    );
    for (const ref of refs) {
      if (ref !== `refs/heads/${branch}`) {
        await this.#gitRun(workspace, ["update-ref", "-d", ref]);
      }
    }
    const remotes = await this.#gitText(workspace, ["remote"]);
    if (remotes.trim().length !== 0) {
      throw new WorkspaceManagerError(
        "verification_failed",
        "workspace unexpectedly contains a Git remote",
      );
    }
  }

  async #verifyWorkspace(
    receipt: WorkspaceReceipt,
    registration: RepositoryRegistration,
  ): Promise<void> {
    validateWorkspacePath(receipt.workspacePath, registration.allowedWorkspaceRoot);
    const objectFormat = objectFormatForSha(receipt.baseCommit);
    await this.#verifyWorkspaceAt(
      receipt.workspacePath,
      receipt.branchName,
      receipt.headCommit,
      receipt.sourcePath,
      objectFormat,
      false,
    );
  }

  async #verifyWorkspaceAt(
    workspace: string,
    branch: string,
    expectedHead: GitSha,
    sourcePath: string,
    expectedObjectFormat: GitObjectFormat,
    checkSourceObjects = true,
  ): Promise<void> {
    await assertDirectoryNoSymlink(workspace, true);
    const gitPath = join(workspace, ".git");
    await assertDirectoryNoSymlink(gitPath, false);
    await assertGitMetadataSafe(gitPath, "workspace_invalid");
    if (await exists(join(gitPath, "commondir"))) {
      throw new WorkspaceManagerError(
        "workspace_invalid",
        "linked Git worktrees are not admissible",
      );
    }
    const commonDir = await this.#gitText(workspace, ["rev-parse", "--git-common-dir"]);
    const gitDir = await this.#gitText(workspace, ["rev-parse", "--git-dir"]);
    if (resolve(workspace, commonDir) !== gitPath || resolve(workspace, gitDir) !== gitPath) {
      throw new WorkspaceManagerError(
        "workspace_invalid",
        "workspace Git metadata is not local to the workspace",
      );
    }
    const objectFormat = await readGitObjectFormat(
      this.#git,
      workspace,
      this.#timeoutMs,
      this.#maxOutputBytes,
    );
    const topLevel = await canonicalExistingDirectory(
      await this.#gitText(workspace, ["rev-parse", "--show-toplevel"]),
      "workspace Git top level",
    );
    if (topLevel !== resolve(workspace)) {
      throw new WorkspaceManagerError(
        "workspace_invalid",
        "workspace Git top level does not match its path",
      );
    }
    if (objectFormat !== expectedObjectFormat) {
      throw new WorkspaceManagerError(
        "workspace_invalid",
        "workspace Git object format does not match its source",
      );
    }
    const branchOutput = await this.#gitText(workspace, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (branchOutput !== branch) {
      throw new WorkspaceManagerError(
        "workspace_invalid",
        "workspace HEAD branch does not match its receipt",
      );
    }
    const head = parseSha(await this.#gitText(workspace, ["rev-parse", "HEAD"]), "workspace HEAD");
    if (head !== expectedHead) {
      throw new WorkspaceManagerError(
        "workspace_invalid",
        "workspace HEAD does not match its receipt",
      );
    }
    const refs = parseLines(
      await this.#gitText(workspace, ["for-each-ref", "--format=%(refname)"]),
    );
    if (refs.some((ref) => ref !== `refs/heads/${branch}`)) {
      throw new WorkspaceManagerError(
        "workspace_invalid",
        "workspace contains an unexpected Git ref",
      );
    }
    if (await exists(join(gitPath, "objects", "info", "alternates"))) {
      throw new WorkspaceManagerError("workspace_invalid", "workspace uses Git object alternates");
    }
    if (checkSourceObjects) {
      const sourceGit = join(sourcePath, ".git");
      await assertNoSharedObjectInodes(sourceGit, gitPath);
    }
  }

  async #verifySourceUnchanged(source: PreparedSource): Promise<void> {
    const current = await captureSourceSnapshot(
      source.sourcePath,
      this.#git,
      this.#timeoutMs,
      this.#maxOutputBytes,
    );
    if (!sameSnapshot(source.sourceSnapshot, current)) {
      throw new WorkspaceManagerError(
        "source_changed",
        "registered source changed during workspace creation",
      );
    }
  }

  async #createWorkspaceDirectory(root: string, temporaryPath: string): Promise<void> {
    await assertDirectoryNoSymlink(root, true);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertDirectoryNoSymlink(root, false);
    await mkdir(temporaryPath, { mode: 0o700 });
    await assertDirectoryNoSymlink(temporaryPath, false);
  }

  async #assertCreateTargetsAbsent(root: string, attempt: AttemptId): Promise<void> {
    const finalPath = workspacePath(root, attempt);
    const temporaryPath = temporaryWorkspacePath(root, attempt);
    validateWorkspacePath(finalPath, root);
    validateWorkspacePath(temporaryPath, root);
    await assertDirectoryNoSymlink(root, true);
    await this.#assertTargetAbsent(finalPath);
    await this.#assertTargetAbsent(temporaryPath);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    const prefix = `${attempt}.`;
    if (entries.some((entry) => entry.startsWith(`${prefix}creating.`))) {
      throw new WorkspaceManagerError(
        "workspace_exists",
        "workspace staging target already exists",
      );
    }
    if (entries.some((entry) => entry.startsWith(`${prefix}cleanup.`))) {
      throw new WorkspaceManagerError(
        "workspace_exists",
        "workspace cleanup staging target already exists",
      );
    }
  }

  async #assertTargetAbsent(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    throw new WorkspaceManagerError("workspace_exists", "workspace target already exists");
  }

  async #removeFencedWorkspace(receipt: WorkspaceReceipt, allowedRoot: string): Promise<void> {
    await this.#assertAndRenewLeases();
    const fence = this.#fence(receipt.repositoryId);
    const currentStagingPath = cleanupWorkspacePath(
      allowedRoot,
      receipt.attemptId,
      fence.fencingToken,
    );
    const priorStagingPath = cleanupWorkspacePath(
      allowedRoot,
      receipt.attemptId,
      receipt.mutationFencingToken,
    );
    validateWorkspacePath(receipt.workspacePath, allowedRoot);
    validateWorkspacePath(currentStagingPath, allowedRoot);
    validateWorkspacePath(priorStagingPath, allowedRoot);
    await assertDirectoryNoSymlink(allowedRoot, false);
    try {
      const metadata = await lstat(receipt.workspacePath);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new WorkspaceManagerError("path_invalid", "workspace path is not a directory");
      }
      await this.#assertTargetAbsent(currentStagingPath);
      if (priorStagingPath !== currentStagingPath) {
        await this.#assertTargetAbsent(priorStagingPath);
      }
      await this.#assertAndRenewLeases();
      await assertDirectoryNoSymlink(allowedRoot, false);
      await rename(receipt.workspacePath, currentStagingPath);
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await this.#assertAndRenewLeases();
    await this.#removeWorkspaceIfPresent(currentStagingPath, allowedRoot);
    if (priorStagingPath !== currentStagingPath) {
      await this.#removeWorkspaceIfPresent(priorStagingPath, allowedRoot);
    }
    await this.#assertAndRenewLeases();
  }

  async #removeWorkspaceIfPresent(path: string, allowedRoot: string): Promise<void> {
    validateWorkspacePath(path, allowedRoot);
    await assertDirectoryNoSymlink(allowedRoot, true);
    try {
      await assertDirectoryNoSymlink(allowedRoot, false);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new WorkspaceManagerError("path_invalid", "workspace path is a symbolic link");
      }
      if (!metadata.isDirectory()) {
        throw new WorkspaceManagerError("path_invalid", "workspace path is not a directory");
      }
      await assertDirectoryNoSymlink(allowedRoot, false);
      await rm(path, { recursive: true, force: false });
      try {
        await lstat(path);
      } catch (error: unknown) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
      }
      throw new WorkspaceManagerError("cleanup_failed", "workspace path remained after deletion");
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  async #failCreate(
    begun: WorkspaceReceipt,
    registration: RepositoryRegistration,
    temporaryPath: string,
    original: unknown,
  ): Promise<void> {
    const current = this.#readExisting(begun.attemptId);
    if (current?.state !== "creating") return;
    try {
      await this.#removeWorkspaceIfPresent(temporaryPath, registration.allowedWorkspaceRoot);
    } catch (error: unknown) {
      throw new WorkspaceManagerError("cleanup_failed", "workspace failure cleanup was unsafe", {
        cause: error,
      });
    }
    try {
      await this.#workspaceRegistry.markFailed({
        attemptId: current.attemptId,
        expectedVersion: current.version,
        failureCode: failureCode(original),
        ...this.#fence(current.repositoryId),
      });
    } catch (error: unknown) {
      throw this.#transitionError("workspace failure transition failed", error);
    }
  }

  async #assertAndRenewLeases(): Promise<void> {
    const repositoryId = this.#leaseContext.getStore();
    if (repositoryId === undefined) return;
    const lease = this.#activeLeases.get(repositoryId);
    if (lease === undefined) {
      throw new WorkspaceManagerError("lease_failed", "repository lease is not active");
    }
    const renewed = await this.#leaseStore.renew({
      repositoryId,
      ownerId: this.#ownerId,
      fencingToken: lease.fencingToken,
      renewedAt: this.#now(),
      leaseDurationMs: this.#leaseDurationMs,
    });
    await this.#leaseStore.assertHeld({
      repositoryId,
      ownerId: this.#ownerId,
      fencingToken: renewed.fencingToken,
      observedAt: this.#now(),
    });
    this.#activeLeases.set(repositoryId, renewed);
  }

  async #readCapture(workspace: string): Promise<CaptureTuple> {
    const head = parseSha(await this.#gitText(workspace, ["rev-parse", "HEAD"]), "workspace HEAD");
    const filterOverrides = await this.#filterOverrides(workspace);
    const status = await this.#gitBytes(workspace, [
      ...filterOverrides,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--",
    ]);
    const diff = await this.#gitBytes(workspace, [
      ...filterOverrides,
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
    ]);
    return { head, status, diff };
  }
  async #filterOverrides(workspace: string): Promise<readonly string[]> {
    return discoverFilterOverrides(this.#git, workspace, this.#timeoutMs, this.#maxOutputBytes);
  }

  async #gitRun(workingDirectory: string, arguments_: readonly string[]): Promise<void> {
    await this.#assertAndRenewLeases();
    await runGit(this.#git, workingDirectory, arguments_, this.#timeoutMs, this.#maxOutputBytes);
  }

  async #gitText(workingDirectory: string, arguments_: readonly string[]): Promise<string> {
    await this.#assertAndRenewLeases();
    return decodeGitOutput(
      await runGit(this.#git, workingDirectory, arguments_, this.#timeoutMs, this.#maxOutputBytes),
      arguments_,
    );
  }

  async #gitBytes(workingDirectory: string, arguments_: readonly string[]): Promise<Uint8Array> {
    await this.#assertAndRenewLeases();
    const output = await runGit(
      this.#git,
      workingDirectory,
      arguments_,
      this.#timeoutMs,
      this.#maxOutputBytes,
    );
    if (output.stdout.byteLength > this.#maxOutputBytes) {
      throw new WorkspaceManagerError("output_limit", "Git output exceeds the configured limit");
    }
    return new Uint8Array(output.stdout);
  }
  #fence(repository: RepositoryId): {
    ownerId: string;
    fencingToken: bigint;
    observedAt: Timestamp;
  } {
    const lease = this.#activeLeases.get(repository);
    if (lease === undefined) {
      throw new WorkspaceManagerError("lease_failed", "repository lease is not active");
    }
    return {
      ownerId: this.#ownerId,
      fencingToken: lease.fencingToken,
      observedAt: this.#now(),
    };
  }

  #transitionError(message: string, error: unknown): WorkspaceManagerError {
    return new WorkspaceManagerError("transition_failed", message, { cause: error });
  }

  #now(): Timestamp {
    try {
      return timestampFromEpochMilliseconds(this.#clock.now());
    } catch (error: unknown) {
      throw new WorkspaceManagerError(
        "invalid_input",
        "workspace manager clock returned an invalid timestamp",
        {
          cause: error,
        },
      );
    }
  }

  async #acquireLease(repository: RepositoryId): Promise<GitMutationLease> {
    const deadline = performance.now() + this.#leaseWaitTimeoutMs;
    for (;;) {
      try {
        return await this.#leaseStore.acquire({
          repositoryId: repository,
          ownerId: this.#ownerId,
          acquiredAt: this.#now(),
          leaseDurationMs: this.#leaseDurationMs,
        });
      } catch (error: unknown) {
        if (errorCode(error) !== "unavailable" || performance.now() >= deadline) {
          throw error;
        }
        const remaining = deadline - performance.now();
        await new Promise<void>((resolveSleep) => {
          setTimeout(resolveSleep, Math.min(this.#leasePollIntervalMs, remaining));
        });
      }
    }
  }

  async #withRepositoryLease<T extends object>(
    repository: RepositoryId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#repositoryTails.get(repository) ?? Promise.resolve();
    const queued = previous.then(async () => {
      let lease: GitMutationLease;
      try {
        lease = await this.#acquireLease(repository);
      } catch (error: unknown) {
        throw new WorkspaceManagerError(
          "lease_failed",
          "repository Git mutation lease cannot be acquired",
          {
            cause: error,
          },
        );
      }
      this.#activeLeases.set(repository, lease);
      let operationResult: T | undefined;
      let operationCompleted = false;
      let operationError: unknown;
      try {
        operationResult = await this.#leaseContext.run(repository, operation);
        operationCompleted = true;
      } catch (error: unknown) {
        operationError = error;
      }
      let releaseError: unknown;
      try {
        await this.#leaseStore.release({
          repositoryId: repository,
          ownerId: this.#ownerId,
          fencingToken: lease.fencingToken,
          releasedAt: this.#now(),
        });
      } catch (error: unknown) {
        releaseError = error;
      }
      this.#activeLeases.delete(repository);
      if (releaseError !== undefined) {
        if (!operationCompleted) {
          throw new WorkspaceManagerError(
            "lease_failed",
            "repository Git mutation lease cannot be released",
            {
              cause: new AggregateError([operationError, releaseError]),
            },
          );
        }
        throw new WorkspaceManagerError(
          "lease_failed",
          "repository Git mutation lease cannot be released",
          {
            cause: releaseError,
          },
        );
      }
      if (!operationCompleted) throw operationError;
      if (operationResult === undefined) {
        throw new WorkspaceManagerError(
          "lease_failed",
          "repository lease operation completed without a result",
        );
      }
      return operationResult;
    });
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.#repositoryTails.set(repository, tail);
    try {
      return await queued;
    } finally {
      if (this.#repositoryTails.get(repository) === tail) this.#repositoryTails.delete(repository);
    }
  }
}

type CaptureTuple = Readonly<{
  head: GitSha;
  status: Uint8Array;
  diff: Uint8Array;
}>;

type ValidCreateInput = Readonly<{
  attemptId: AttemptId;
  nodeId: TaskNodeId;
  treeId: TaskTreeId;
  hostId: HostId;
  repositoryId: RepositoryId;
  ordinal: number;
  baseCommit: GitSha | undefined;
  sourcePath: string | undefined;
  sourceAttemptId: AttemptId | undefined;
}>;

type GitObjectFormat = "sha1" | "sha256";

type PreparedSource = Readonly<{
  sourcePath: string;
  canonicalPath: string;
  workspacePath: string;
  branchName: string;
  baseCommit: GitSha;
  objectFormat: GitObjectFormat;
  sourceSnapshot: SourceSnapshot;
}>;

type SourceSnapshot = Readonly<{
  root: FsIdentity;
  git: FsIdentity;
  config: FsIdentity;
  head: GitSha;
  branch: string | undefined;
  objectFormat: GitObjectFormat;
  status: Uint8Array;
  refs: Uint8Array;
  count: Uint8Array;
}>;

type FsIdentity = Readonly<{
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  digest: string;
}>;

type SourceInspection = Readonly<{
  canonicalPath: string;
  baseCommit: GitSha;
  objectFormat: GitObjectFormat;
  snapshot: SourceSnapshot;
}>;

function validateCreateInput(input: WorkspaceCreateInput): ValidCreateInput {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal <= 0) {
    throw new WorkspaceManagerError("invalid_input", "workspace attempt ordinal must be positive");
  }
  try {
    return Object.freeze({
      attemptId: attemptId(input.attemptId),
      nodeId: taskNodeId(input.nodeId),
      treeId: taskTreeId(input.treeId),
      hostId: hostId(input.hostId),
      repositoryId: repositoryId(input.repositoryId),
      ordinal: input.ordinal,
      baseCommit: input.baseCommit === undefined ? undefined : gitSha(input.baseCommit),
      sourcePath: input.sourcePath,
      sourceAttemptId:
        input.sourceAttemptId === undefined ? undefined : attemptId(input.sourceAttemptId),
    });
  } catch (error: unknown) {
    throw new WorkspaceManagerError("invalid_input", "workspace create input is invalid", {
      cause: error,
    });
  }
}

function validateRegistrationContext(
  registration: RepositoryRegistration,
  input: ValidCreateInput,
): void {
  if (registration.id !== input.repositoryId || registration.hostId !== input.hostId) {
    throw new WorkspaceManagerError(
      "repository_invalid",
      "repository registration identity does not match workspace input",
    );
  }
}

function branchName(tree: TaskTreeId, node: TaskNodeId, ordinal: number): string {
  const branch = `${BRANCH_PREFIX}${tree}/${node}/${String(ordinal)}`;
  if (!/^minions\/[0-9a-f-]+\/[0-9a-f-]+\/[1-9][0-9]*$/u.test(branch)) {
    throw new WorkspaceManagerError("invalid_input", "workspace branch name is invalid");
  }
  return branch;
}

function workspacePath(root: string, attempt: AttemptId): string {
  return join(root, attempt);
}

function temporaryWorkspacePath(root: string, attempt: AttemptId, fencingToken?: bigint): string {
  const suffix = fencingToken === undefined ? "creating" : `creating.${fencingToken.toString()}`;
  return join(root, `${attempt}.${suffix}`);
}

function cleanupWorkspacePath(root: string, attempt: AttemptId, fencingToken: bigint): string {
  return join(root, `${attempt}.cleanup.${fencingToken.toString()}`);
}

function validateWorkspacePath(path: string, allowedRoot: string): void {
  if (!isAbsolute(path) || !isAbsolute(allowedRoot)) {
    throw new WorkspaceManagerError("path_invalid", "workspace paths must be absolute");
  }
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(allowedRoot);
  if (normalizedPath !== path || normalizedRoot !== allowedRoot) {
    throw new WorkspaceManagerError("path_invalid", "workspace paths must be normalized");
  }
  if (!isWithin(normalizedPath, normalizedRoot) || normalizedPath === normalizedRoot) {
    throw new WorkspaceManagerError(
      "path_invalid",
      "workspace path is outside the allowed workspace root",
    );
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(candidate: string, root: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

async function inspectSource(
  requestedPath: string,
  sourceAttempt: AttemptId | undefined,
  registration: RepositoryRegistration,
  workspaceRegistry: WorkspaceRegistry,
  git: GitProcess,
  timeoutMs: number,
  maxOutputBytes: number,
  requestedBase: GitSha,
): Promise<SourceInspection> {
  const sourcePath = await canonicalExistingDirectory(requestedPath, "source path");
  const registrationRoot = await canonicalExistingDirectory(
    registration.canonicalRoot,
    "registered repository root",
  );
  const allowedRoot = normalize(registration.allowedWorkspaceRoot);
  if (pathsOverlap(registrationRoot, allowedRoot)) {
    throw new WorkspaceManagerError(
      "path_invalid",
      "registered repository overlaps its workspace root",
    );
  }
  if (sourceAttempt !== undefined) {
    let parent: WorkspaceReceipt;
    try {
      parent = workspaceRegistry.get(sourceAttempt);
    } catch (error: unknown) {
      throw new WorkspaceManagerError("source_invalid", "parent workspace source does not exist", {
        cause: error,
      });
    }
    if (
      parent.state !== "ready" ||
      parent.repositoryId !== registration.id ||
      parent.hostId !== registration.hostId
    ) {
      throw new WorkspaceManagerError(
        "source_invalid",
        "parent workspace source is not ready for this repository",
      );
    }
    const expectedPath = await canonicalExistingDirectory(
      parent.workspacePath,
      "parent workspace path",
    );
    if (sourcePath !== expectedPath) {
      throw new WorkspaceManagerError(
        "source_invalid",
        "source path does not match the ready parent workspace",
      );
    }
    if (!isWithin(sourcePath, allowedRoot) || sourcePath === allowedRoot) {
      throw new WorkspaceManagerError(
        "source_invalid",
        "parent workspace source is outside the allowed root",
      );
    }
  } else if (sourcePath !== registrationRoot) {
    throw new WorkspaceManagerError(
      "source_invalid",
      "non-registered source paths require a ready parent attempt",
    );
  }
  if (sourceAttempt === undefined && pathsOverlap(sourcePath, allowedRoot)) {
    throw new WorkspaceManagerError("path_invalid", "source path overlaps the workspace root");
  }
  const gitPath = join(sourcePath, ".git");
  await assertDirectoryNoSymlink(gitPath, false);
  await assertGitMetadataSafe(gitPath, "source_invalid");
  if (await exists(join(gitPath, "commondir"))) {
    throw new WorkspaceManagerError(
      "source_invalid",
      "linked Git worktrees are not admissible sources",
    );
  }
  const topLevel = decodeGitOutput(
    await runGit(git, sourcePath, ["rev-parse", "--show-toplevel"], timeoutMs, maxOutputBytes),
    ["rev-parse", "--show-toplevel"],
  );
  if ((await canonicalExistingDirectory(topLevel, "source Git top level")) !== sourcePath) {
    throw new WorkspaceManagerError(
      "source_invalid",
      "source Git top level does not match its path",
    );
  }
  const commonDir = decodeGitOutput(
    await runGit(git, sourcePath, ["rev-parse", "--git-common-dir"], timeoutMs, maxOutputBytes),
    ["rev-parse", "--git-common-dir"],
  );
  if (resolve(sourcePath, commonDir) !== gitPath) {
    throw new WorkspaceManagerError("source_invalid", "source Git common directory is not local");
  }
  const head = parseSha(
    decodeGitOutput(
      await runGit(git, sourcePath, ["rev-parse", "HEAD"], timeoutMs, maxOutputBytes),
      ["rev-parse", "HEAD"],
    ),
    "source HEAD",
  );
  if (head !== requestedBase) {
    throw new WorkspaceManagerError(
      "source_invalid",
      "source HEAD does not equal the requested base commit",
    );
  }
  const verifiedBase = parseSha(
    decodeGitOutput(
      await runGit(
        git,
        sourcePath,
        ["rev-parse", "--verify", `${requestedBase}^{commit}`],
        timeoutMs,
        maxOutputBytes,
      ),
      ["rev-parse", "--verify"],
    ),
    "source base commit",
  );
  if (verifiedBase !== requestedBase) {
    throw new WorkspaceManagerError("source_invalid", "source base commit verification failed");
  }
  const snapshot = await captureSourceSnapshot(sourcePath, git, timeoutMs, maxOutputBytes);
  return Object.freeze({
    canonicalPath: sourcePath,
    baseCommit: requestedBase,
    objectFormat: snapshot.objectFormat,
    snapshot,
  });
}
async function captureSourceSnapshot(
  sourcePath: string,
  git: GitProcess,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SourceSnapshot> {
  const root = await fileIdentity(sourcePath, true);
  const gitMetadata = await fileIdentity(join(sourcePath, ".git"), true);
  const config = await fileIdentity(join(sourcePath, ".git", "config"), false);
  const head = parseSha(
    decodeGitOutput(
      await runGit(git, sourcePath, ["rev-parse", "HEAD"], timeoutMs, maxOutputBytes),
      ["rev-parse", "HEAD"],
    ),
    "source HEAD",
  );
  const branch = await optionalGitText(
    git,
    sourcePath,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    timeoutMs,
    maxOutputBytes,
  );
  const objectFormat = await readGitObjectFormat(git, sourcePath, timeoutMs, maxOutputBytes);
  // P1 (review #14 + Codex inline): source snapshots run `git status` without
  // the same filter overrides #readCapture already applies to workspace
  // captures. A registered source with a local filter.<name>.clean/process
  // config + a tracked .gitattributes entry using it lets `status` execute
  // that filter for modified files - arbitrary commands outside the
  // workspace, bypassing process/path isolation. Discover and disable them
  // here too, exactly like #readCapture does for the workspace side.
  const sourceFilterOverrides = await discoverFilterOverrides(
    git,
    sourcePath,
    timeoutMs,
    maxOutputBytes,
  );
  const status = (
    await runGit(
      git,
      sourcePath,
      [
        ...sourceFilterOverrides,
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
      ],
      timeoutMs,
      maxOutputBytes,
    )
  ).stdout;
  const refs = (
    await runGit(
      git,
      sourcePath,
      ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00"],
      timeoutMs,
      maxOutputBytes,
    )
  ).stdout;
  const count = (await runGit(git, sourcePath, ["count-objects", "-v"], timeoutMs, maxOutputBytes))
    .stdout;
  return Object.freeze({
    root,
    git: gitMetadata,
    config,
    head,
    branch,
    objectFormat,
    status,
    refs,
    count,
  });
}

/**
 * Discover every `filter.<name>.{clean,process,required}` driver configured
 * (repo-local or otherwise visible via `git config --includes`) at
 * `workingDirectory`, and return `-c` overrides that neutralize each one
 * (empty clean/process command, `required=false`) for the NEXT git
 * invocation only. Shared by the class's `#filterOverrides` (workspace
 * captures) and `captureSourceSnapshot` (source captures) so neither can
 * drift out of sync and leave one snapshot path running attacker-controlled
 * filter commands the other already disables.
 */
async function discoverFilterOverrides(
  git: GitProcess,
  workingDirectory: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<readonly string[]> {
  const keys = decodeGitOutput(
    await runGit(
      git,
      workingDirectory,
      ["config", "--includes", "--name-only", "-z", "--list"],
      timeoutMs,
      maxOutputBytes,
    ),
    ["config", "--includes", "--name-only", "-z", "--list"],
  ).split("\0");
  const drivers = new Set<string>();
  for (const key of keys) {
    const match = /^filter\.(.+)\.(?:clean|process|required)$/i.exec(key);
    if (match?.[1] !== undefined) {
      drivers.add(match[1]);
    }
  }
  return [...drivers]
    .sort()
    .flatMap((driver) => [
      "-c",
      `filter.${driver}.clean=`,
      "-c",
      `filter.${driver}.process=`,
      "-c",
      `filter.${driver}.required=false`,
    ]);
}

async function readGitObjectFormat(
  git: GitProcess,
  workingDirectory: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<GitObjectFormat> {
  const value = decodeGitOutput(
    await runGit(
      git,
      workingDirectory,
      ["rev-parse", "--show-object-format"],
      timeoutMs,
      maxOutputBytes,
    ),
    ["rev-parse", "--show-object-format"],
  ).trim();
  if (value !== "sha1" && value !== "sha256") {
    throw new WorkspaceManagerError(
      "verification_failed",
      "Git repository uses an unsupported object format",
    );
  }
  return value;
}

function sameSnapshot(left: SourceSnapshot, right: SourceSnapshot): boolean {
  return (
    sameIdentity(left.root, right.root) &&
    sameIdentity(left.git, right.git) &&
    sameIdentity(left.config, right.config) &&
    left.head === right.head &&
    left.branch === right.branch &&
    left.objectFormat === right.objectFormat &&
    bytesEqual(left.status, right.status) &&
    bytesEqual(left.refs, right.refs) &&
    bytesEqual(left.count, right.count)
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameIdentity(left: FsIdentity, right: FsIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.digest === right.digest
  );
}

async function fileIdentity(path: string, directory: boolean): Promise<FsIdentity> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new WorkspaceManagerError(
      "path_invalid",
      `${path} is not a safe ${directory ? "directory" : "file"}`,
    );
  }
  const bytes = directory ? new Uint8Array() : new Uint8Array(await readFile(path));
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function canonicalExistingDirectory(path: string, field: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new WorkspaceManagerError("path_invalid", `${field} must be absolute`);
  }
  await assertDirectoryNoSymlink(path, false);
  try {
    return await realpath(path);
  } catch (error: unknown) {
    throw new WorkspaceManagerError("path_invalid", `${field} cannot be canonicalized`, {
      cause: error,
    });
  }
}

async function assertDirectoryNoSymlink(path: string, allowMissing: boolean): Promise<void> {
  if (!isAbsolute(path)) throw new WorkspaceManagerError("path_invalid", "path must be absolute");
  const normalized = normalize(path);
  const root = parse(normalized).root;
  const segments = normalized
    .slice(root.length)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error: unknown) {
      if (allowMissing && isErrno(error, "ENOENT")) return;
      throw new WorkspaceManagerError("path_invalid", `path component ${current} is unavailable`, {
        cause: error,
      });
    }
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceManagerError(
        "path_invalid",
        `path component ${current} is a symbolic link`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new WorkspaceManagerError(
        "path_invalid",
        `path component ${current} is not a directory`,
      );
    }
  }
}

async function assertNoSharedObjectInodes(sourceGit: string, workspaceGit: string): Promise<void> {
  const sourceObjects = await objectInodes(join(sourceGit, "objects"), "source_invalid");
  const workspaceObjects = await objectInodes(join(workspaceGit, "objects"), "workspace_invalid");
  for (const identity of workspaceObjects) {
    if (sourceObjects.has(identity)) {
      throw new WorkspaceManagerError(
        "workspace_invalid",
        "workspace Git objects share inodes with its source",
      );
    }
  }
}

async function assertGitMetadataSafe(
  gitPath: string,
  code: "source_invalid" | "workspace_invalid",
): Promise<void> {
  await assertDirectoryNoSymlink(gitPath, false);
  await safeGitMetadataFile(join(gitPath, "HEAD"), code);
  await safeGitMetadataFile(join(gitPath, "config"), code);
  await safeGitMetadataFile(join(gitPath, "config.worktree"), code, true);
  await safeGitMetadataFile(join(gitPath, "index"), code);
  await safeGitMetadataFile(join(gitPath, "packed-refs"), code, true);
  await objectInodes(join(gitPath, "objects"), code);
  // P1 (review #14): objectInodes only rejects a SYMLINKED objects/info/
  // alternates; a regular (non-symlink) alternates file still passes it, but
  // its CONTENTS name an external object database that a later `git fetch`/
  // `git repack` (etc.) would consult, importing/hardlinking objects from
  // outside the registered root - a confinement escape via git's own
  // mechanism, not a filesystem trick. This confinement model has no
  // supported use for alternates, so reject the file outright if present.
  await assertNoGitAlternates(join(gitPath, "objects", "info", "alternates"), code);
  await objectInodes(join(gitPath, "refs"), code);
  await safeOptionalGitMetadataDirectory(join(gitPath, "reftable"), code);
}

async function assertNoGitAlternates(
  path: string,
  code: "source_invalid" | "workspace_invalid",
): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  throw new WorkspaceManagerError(
    code,
    `Git metadata path ${path} configures alternate object databases, which are not confined`,
  );
}

async function safeOptionalGitMetadataDirectory(
  path: string,
  code: "source_invalid" | "workspace_invalid",
): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  await objectInodes(path, code);
}

async function safeGitMetadataFile(
  path: string,
  code: "source_invalid" | "workspace_invalid",
  allowMissing = false,
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    if (allowMissing && isErrno(error, "ENOENT")) return;
    throw new WorkspaceManagerError(code, `Git metadata file ${path} is unavailable`, {
      cause: error,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new WorkspaceManagerError(code, `Git metadata file ${path} is not a regular file`);
  }
}

async function objectInodes(
  path: string,
  code: "source_invalid" | "workspace_invalid",
): Promise<Set<string>> {
  const identities = new Set<string>();
  let rootMetadata: Stats;
  try {
    rootMetadata = await lstat(path);
  } catch (error: unknown) {
    throw new WorkspaceManagerError(code, `Git metadata directory ${path} is unavailable`, {
      cause: error,
    });
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new WorkspaceManagerError(code, `Git metadata directory ${path} is not a directory`);
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    let metadata: Stats;
    try {
      metadata = await lstat(child);
    } catch (error: unknown) {
      throw new WorkspaceManagerError(code, `Git metadata path ${child} is unavailable`, {
        cause: error,
      });
    }
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceManagerError(code, `Git metadata path ${child} is a symbolic link`);
    }
    if (metadata.isDirectory()) {
      const nested = await objectInodes(child, code);
      nested.forEach((identity) => identities.add(identity));
      continue;
    }
    if (!metadata.isFile()) {
      throw new WorkspaceManagerError(code, `Git metadata path ${child} is not a regular file`);
    }
    identities.add(`${String(metadata.dev)}:${String(metadata.ino)}`);
  }
  return identities;
}

async function runGit(
  git: GitProcess,
  workingDirectory: string,
  arguments_: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ readonly stdout: Uint8Array; readonly stderr: Uint8Array }> {
  await assertDirectoryNoSymlink(workingDirectory, false);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(workingDirectory, { bigint: true });
  } catch (error: unknown) {
    throw new WorkspaceManagerError("path_invalid", "Git working directory is unavailable", {
      cause: error,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new WorkspaceManagerError(
      "path_invalid",
      "Git working directory is not a non-symbolic directory",
    );
  }
  const commandArguments = [
    "-c",
    `core.worktree=${workingDirectory}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    ...arguments_,
  ];
  try {
    const result = await git.run({
      workingDirectory,
      workingDirectoryDevice: metadata.dev,
      workingDirectoryInode: metadata.ino,
      arguments: commandArguments,
      timeoutMs,
      maxOutputBytes,
    });
    if (result.stdout.byteLength > maxOutputBytes || result.stderr.byteLength > maxOutputBytes) {
      throw new WorkspaceManagerError("output_limit", "Git output exceeds the configured limit");
    }
    return Object.freeze({
      stdout: new Uint8Array(result.stdout),
      stderr: new Uint8Array(result.stderr),
    });
  } catch (error: unknown) {
    if (error instanceof WorkspaceManagerError) throw error;
    if (error instanceof GitProcessError && error.kind === "output_limit") {
      throw new WorkspaceManagerError("output_limit", "Git output exceeds the configured limit", {
        cause: error,
      });
    }
    throw new WorkspaceManagerError(
      "git_failed",
      `Git command failed: git ${arguments_.join(" ")}`,
      { cause: error },
    );
  }
}

function decodeGitOutput(
  result: { readonly stdout: Uint8Array; readonly stderr: Uint8Array },
  arguments_: readonly string[],
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
  } catch (error: unknown) {
    throw new WorkspaceManagerError(
      "verification_failed",
      `Git output is not valid UTF-8: git ${arguments_.join(" ")}`,
      {
        cause: error,
      },
    );
  }
}

async function optionalGitText(
  git: GitProcess,
  workingDirectory: string,
  arguments_: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string | undefined> {
  try {
    return decodeGitOutput(
      await runGit(git, workingDirectory, arguments_, timeoutMs, maxOutputBytes),
      arguments_,
    );
  } catch (error: unknown) {
    const cause = errorCause(error);
    if (cause instanceof GitProcessError && cause.kind === "exit" && cause.exitCode === 1)
      return undefined;
    throw error;
  }
}

function objectFormatForSha(value: GitSha): GitObjectFormat {
  if (value.length === 40) return "sha1";
  if (value.length === 64) return "sha256";
  throw new WorkspaceManagerError("verification_failed", "Git SHA has an unsupported length");
}

function parseSha(value: string, field: string): GitSha {
  if (!SHA_PATTERN.test(value)) {
    throw new WorkspaceManagerError("verification_failed", `${field} is not a valid Git SHA`);
  }
  return gitSha(value);
}

function parseLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function validateExistingReceipt(
  receipt: WorkspaceReceipt,
  source: PreparedSource,
  registration: RepositoryRegistration,
  input: ValidCreateInput,
): void {
  validateReceiptIdentity(receipt, source, registration, input);
  if (receipt.state === "creating" && receipt.createdAt < 0) {
    throw new WorkspaceManagerError("transition_failed", "workspace creation timestamp is invalid");
  }
}
function validateExistingInputIdentity(
  receipt: WorkspaceReceipt,
  registration: RepositoryRegistration,
  input: ValidCreateInput,
  workspaceRegistry: WorkspaceRegistry,
): void {
  validateWorkspacePath(receipt.workspacePath, registration.allowedWorkspaceRoot);
  if (
    receipt.attemptId !== input.attemptId ||
    receipt.nodeId !== input.nodeId ||
    receipt.treeId !== input.treeId ||
    receipt.hostId !== input.hostId ||
    receipt.repositoryId !== registration.id ||
    receipt.branchName !== branchName(input.treeId, input.nodeId, input.ordinal) ||
    (input.baseCommit !== undefined && receipt.baseCommit !== input.baseCommit)
  ) {
    throw new WorkspaceManagerError(
      "transition_failed",
      "workspace durable identity does not match the request",
    );
  }
  if (input.sourcePath !== undefined && normalize(input.sourcePath) !== receipt.sourcePath) {
    throw new WorkspaceManagerError(
      "transition_failed",
      "workspace source path does not match the request",
    );
  }
  if (input.sourceAttemptId !== undefined) {
    const source = workspaceRegistry.get(input.sourceAttemptId);
    if (source.workspacePath !== receipt.sourcePath) {
      throw new WorkspaceManagerError(
        "transition_failed",
        "workspace source attempt does not match the request",
      );
    }
  }
}

function validateReceiptIdentity(
  receipt: WorkspaceReceipt,
  source: PreparedSource,
  registration: RepositoryRegistration,
  input: ValidCreateInput,
): void {
  if (
    receipt.attemptId !== input.attemptId ||
    receipt.nodeId !== input.nodeId ||
    receipt.treeId !== input.treeId ||
    receipt.hostId !== input.hostId ||
    receipt.repositoryId !== registration.id ||
    receipt.workspacePath !== source.workspacePath ||
    receipt.sourcePath !== source.sourcePath ||
    receipt.branchName !== source.branchName ||
    receipt.baseCommit !== source.baseCommit
  ) {
    throw new WorkspaceManagerError(
      "transition_failed",
      "workspace durable identity does not match the request",
    );
  }
}

function normalizeManagerError(
  error: unknown,
  message: string,
  code: WorkspaceManagerErrorCode = "git_failed",
): WorkspaceManagerError {
  if (error instanceof WorkspaceManagerError) return error;
  return new WorkspaceManagerError(code, message, { cause: error });
}

function failureCode(error: unknown): string {
  if (error instanceof WorkspaceManagerError) return error.code;
  if (error instanceof GitProcessError) return `git_${error.kind}`;
  return "workspace_create_failed";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorCause(error: unknown): unknown {
  if (error instanceof WorkspaceManagerError) return error.cause;
  return error;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === code
  );
}

function parseAttemptId(value: AttemptId): AttemptId {
  try {
    return attemptId(value);
  } catch (error: unknown) {
    throw new WorkspaceManagerError("invalid_input", "workspace attempt ID is invalid", {
      cause: error,
    });
  }
}

function cryptoRandomUuid(): string {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Math.floor(Math.random() * 256);
  const versionByte = bytes[6] ?? 0;
  const variantByte = bytes[8] ?? 0;
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
