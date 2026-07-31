/**
 * Commit capture + child unblock (PR 30 / GIT-02..05, GIT-09).
 *
 * The commit-capture manager is the single path by which a validated node change
 * becomes an engine-owned jj commit. It composes the masked working-copy broker
 * (PR 28), the change-id binding store (PR 29), and the gate receipts (PR 25):
 *
 * 1. Validate the gate — a node is only captured when its required gate
 *    categories have fresh, passing receipts bound to the captured head
 *    (QA-03). No gate, no commit.
 * 2. Verify the expected workspace head — the working copy's parent commit must
 *    still match the head the gate ran against, so no unexpected change slips
 *    in between gate and capture.
 * 3. Detect prohibited agent commits — the engine owns every commit through the
 *    serialized broker. If the working-copy change id drifted off the registered
 *    id, somebody (the agent) committed out-of-band; reject fail-closed.
 * 4. Validate the diff — a change node must carry actual changes; a no-change
 *    node uses the unchanged revision and is never committed.
 * 5. Commit through the broker with the deterministic engine identity
 *    (GIT-02/GIT-09), record before/after operation ids, and update the binding.
 *
 * Only a locally-gated, engine-captured commit advances a node and unblocks its
 * commit-dependent children. `resolveChildBase` walks non-commit ancestors to
 * find the exact revision a child must stack on; `markStaleDescendants` flags
 * every descendant of a rewritten parent for restacking.
 */

import { createHash } from "node:crypto";

import {
  contentHash,
  isValidConflictTransition,
  nonEmptyText,
  validateGateReceipts,
  type Clock,
  type ConflictState,
  type ContentHash,
  type GateReceipt,
  type GateReceiptExpectation,
  type GitSha,
  type IdGenerator,
  type NonEmptyText,
  type RewriteGeneration,
  type TaskNodeId,
  type TaskTreeId,
  type Timestamp,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";

import type { AuthorIdentity, JjCommitReceipt, JjWorkingCopyHead } from "./jj-working-copy.js";
import type { JjCentralRepo } from "./jj-central-repo.js";

// -------------------------------------------------------------------------------------------------
// Errors.
// -------------------------------------------------------------------------------------------------

export type CommitCaptureErrorCode =
  | "gate_not_passed"
  | "no_change"
  | "unexpected_head"
  | "agent_commit_detected"
  | "commit_failed"
  | "binding_update_failed"
  | "child_base_unresolved"
  | "stale_marking_failed";

/** Typed commit-capture error. Fail-closed: every invariant breach surfaces a typed code. */
export class CommitCaptureError extends Error {
  readonly code: CommitCaptureErrorCode;
  readonly remediation: string;
  override readonly cause: unknown;

  constructor(code: CommitCaptureErrorCode, message: string, remediation: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CommitCaptureError";
    this.code = code;
    this.remediation = remediation;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Ports.
// -------------------------------------------------------------------------------------------------

/**
 * The working-copy surface the capture manager needs. The masked jj working-copy
 * manager (PR 28) satisfies this structurally; tests substitute a focused double.
 * Every call flows through the serialized broker — the capture manager never
 * invokes jj directly.
 */
export interface CommitCaptureWorkingCopy {
  /** Live `@` change id + `@-` parent change id / commit, read through the broker. */
  head(workingCopyId: string): Promise<JjWorkingCopyHead>;
  /** Working-copy cleanliness + changed paths, read through the broker. */
  status(workingCopyId: string): Promise<Readonly<{ readonly clean: boolean }>>;
  /** Describe `@` with `message` and commit it under `author`; returns the receipt. */
  commit(
    workingCopyId: string,
    message: NonEmptyText,
    author: AuthorIdentity,
  ): Promise<JjCommitReceipt>;
  /** Current jj operation-log id of the working copy, read through the broker. */
  currentOperationLogId(workingCopyId: string): Promise<ContentHash>;
}

/**
 * Read-only task-tree ancestry the capture manager walks to resolve child bases
 * and to flag stale descendants. The composite (treeId, nodeId) identity is the
 * key; parent links come from the live task tree the caller already holds.
 */
export interface CommitCaptureTree {
  /** Immediate parent node of `nodeId` in `treeId`, or `null` at the root. */
  getParentNode(treeId: TaskTreeId, nodeId: TaskNodeId): TaskNodeId | null;
}

/** Minimal structured logger. Optional; defaults to a silent sink. */
export interface CommitCaptureLogger {
  debug(message: string, meta?: Readonly<Record<string, unknown>>): void;
  info(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error(message: string, meta?: Readonly<Record<string, unknown>>): void;
}

// -------------------------------------------------------------------------------------------------
// Inputs + receipts.
// -------------------------------------------------------------------------------------------------

/** Kind of node being captured. Drives diff validation and whether a commit is made. */
export type CommitCaptureNodeKind = "change" | "no-change";

/** Input to {@link CommitCaptureManager.captureCommit}. */
export type CommitCaptureInput = Readonly<{
  /** Tree the captured node belongs to. */
  treeId: TaskTreeId;
  /** The node whose validated change is being captured. */
  nodeId: TaskNodeId;
  /** Registered working-copy change id (the `@` id at creation). */
  workingCopyId: string;
  /** Workspace head the gate ran against; the working copy must still match it. */
  expectedHead: GitSha;
  /** Whether this node is expected to produce a change. */
  nodeKind: CommitCaptureNodeKind;
  /** Commit message for a change node (ignored for no-change nodes). */
  message: NonEmptyText;
  /** Gate receipts to validate (from the gate runner / receipt store). */
  gateReceipts: readonly GateReceipt[];
  /** What the gate receipts must satisfy to unblock the node. */
  gateExpectation: GateReceiptExpectation;
}>;

/**
 * Receipt for a captured commit. For a change node `committed` is `true` and
 * `newCommitId` is the fresh engine commit; for a no-change node `committed` is
 * `false` and `newCommitId` is the unchanged parent revision (no commit made).
 */
export type CommitCaptureReceipt = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly treeId: TaskTreeId;
  /** Fingerprint of the captured (or carried) jj change id. */
  readonly jjChangeId: ContentHash;
  /** New engine commit (change node) or the unchanged parent commit (no-change). */
  readonly newCommitId: GitSha;
  /** Fingerprint of the parent change id, or `undefined` for a root change. */
  readonly parentChangeId: ContentHash | undefined;
  readonly beforeOpId: ContentHash;
  readonly afterOpId: ContentHash;
  readonly capturedAt: Timestamp;
  /** The deterministic engine identity attributed to the capture. */
  readonly authorIdentity: AuthorIdentity;
  /** `true` when a new engine commit was created; `false` for the no-change path. */
  readonly committed: boolean;
}>;

/** Result of resolving a child's base commit across non-commit ancestors. */
export type ChildBaseResolution = Readonly<{
  /** The nearest committed ancestor node that provides the base. */
  readonly baseNodeId: TaskNodeId;
  /** The commit the child must stack its working copy on. */
  readonly baseCommitId: GitSha;
  /** Fingerprint of the base change id. */
  readonly baseChangeId: ContentHash;
  /** Rewrite generation of the base binding (monotonic; advances on rewrites). */
  readonly rewriteGeneration: RewriteGeneration;
}>;

/** A descendant marked stale after a parent's commit changed. */
export type StaleDescendant = Readonly<{
  readonly nodeId: TaskNodeId;
  readonly jjChangeId: ContentHash;
  readonly previousConflictState: ConflictState;
  readonly markedAt: Timestamp;
}>;

// -------------------------------------------------------------------------------------------------
// Manager.
// -------------------------------------------------------------------------------------------------

/** Deterministic engine author identity (GIT-02/GIT-09). Never the agent's. */
export const DETERMINISTIC_ENGINE_IDENTITY: AuthorIdentity = Object.freeze({
  name: nonEmptyText("Minions Engine", "engine author name"),
  email: nonEmptyText("engine@minions.local", "engine author email"),
});

export type CommitCaptureManagerOptions = Readonly<{
  /** Serialized working-copy broker (PR 28). */
  workingCopy: CommitCaptureWorkingCopy;
  /** Durable change-id binding store (PR 29). */
  bindingStore: VcsChangeBindingStore;
  /** Bootstrapped central jj repo (PR 27); asserted safe before each capture. */
  centralRepo: JjCentralRepo;
  /** Pinned, digest-verified jj binary path (from `ensureJjCapability`). */
  jjBinaryPath: string;
  /** Task-tree ancestry walker for child-base resolution + stale marking. */
  tree: CommitCaptureTree;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Deterministic engine identity applied to captured commits. */
  readonly engineIdentity?: AuthorIdentity;
  /** Optional structured logger; defaults to a silent sink. */
  readonly logger?: CommitCaptureLogger;
}>;

export interface CommitCaptureManager {
  captureCommit(input: CommitCaptureInput): Promise<CommitCaptureReceipt>;
  resolveChildBase(treeId: TaskTreeId, childNodeId: TaskNodeId): Promise<ChildBaseResolution>;
  markStaleDescendants(
    treeId: TaskTreeId,
    parentNodeId: TaskNodeId,
  ): Promise<readonly StaleDescendant[]>;
}

const silentLogger: CommitCaptureLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Deterministic fingerprint of a jj change id (32-char) into the binding's
 * 64-hex {@link ContentHash} identity space. Stable: the same change id always
 * hashes to the same binding identity.
 */
function changeIdFingerprint(changeId: string): ContentHash {
  return contentHash(createHash("sha256").update(changeId).digest("hex"));
}

function captureError(
  code: CommitCaptureErrorCode,
  message: string,
  remediation: string,
  cause?: unknown,
): CommitCaptureError {
  return new CommitCaptureError(code, message, remediation, cause);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatProblems(problems: readonly { readonly reason: string }[]): string {
  if (problems.length === 0) {
    return "no passing receipt for the required categories";
  }
  return problems.map((problem) => problem.reason).join(", ");
}

/**
 * Create a commit-capture manager. The manager is the single path from a
 * validated node change to an engine-owned jj commit; it never invokes jj
 * directly — every mutation flows through the serialized working-copy broker.
 */
export function createCommitCaptureManager(
  options: CommitCaptureManagerOptions,
): CommitCaptureManager {
  const workingCopy = options.workingCopy;
  const bindingStore = options.bindingStore;
  const centralRepo = options.centralRepo;
  const jjBinaryPath = options.jjBinaryPath;
  const tree = options.tree;
  const clock = options.clock;
  const ids = options.ids;
  const engineIdentity = options.engineIdentity ?? DETERMINISTIC_ENGINE_IDENTITY;
  const logger = options.logger ?? silentLogger;

  if (typeof jjBinaryPath !== "string" || jjBinaryPath.length === 0) {
    throw captureError(
      "commit_failed",
      "jjBinaryPath must be a non-empty path",
      "Pass the binaryPath from an available ensureJjCapability probe.",
    );
  }

  // The central repo's safety invariants (snapshot auto-track locked, hooks
  // absent) are encoded as literal-`true` fields on {@link JjCentralRepo}, so a
  // bootstrapped repo is type-carrying proof it is engine-owned and locked down.
  // Capture is only ever composed against such a repo; `repositoryId` is carried
  // into capture logs for durable lineage.

  async function captureChangeNode(
    input: CommitCaptureInput,
    head: JjWorkingCopyHead,
    captureId: string,
  ): Promise<CommitCaptureReceipt> {
    const status = await workingCopy.status(input.workingCopyId);
    if (status.clean) {
      throw captureError(
        "no_change",
        `change node '${input.nodeId}' has no working-copy changes to commit`,
        "Ensure the node produced changes before capturing, or declare it a no-change node.",
      );
    }

    const beforeOpId = await workingCopy.currentOperationLogId(input.workingCopyId);
    let receipt: JjCommitReceipt;
    try {
      receipt = await workingCopy.commit(input.workingCopyId, input.message, engineIdentity);
    } catch (error: unknown) {
      throw captureError(
        "commit_failed",
        `jj commit failed for node '${input.nodeId}': ${errorMessage(error)}`,
        "Inspect the working copy via the broker; destroy and recreate it if it is corrupt.",
        error,
      );
    }
    // The old working-copy id is now a committed (immutable) change; the broker
    // retired it and surfaced a fresh empty working-copy change on top.
    const afterOpId = await workingCopy.currentOperationLogId(receipt.newWorkingCopyId);

    const jjChangeId = changeIdFingerprint(input.workingCopyId);
    const parentChangeId = changeIdFingerprint(head.parentChangeId);
    const existing = await bindingStore.getBinding(input.treeId, input.nodeId);
    const binding: VcsChangeBinding = Object.freeze({
      treeId: input.treeId,
      nodeId: input.nodeId,
      jjChangeId,
      currentCommitId: receipt.commitSha,
      parentChangeId,
      bookmark: existing?.bookmark,
      // A clean capture is not a rewrite: the generation carries over unchanged.
      rewriteGeneration: existing?.rewriteGeneration ?? 0,
      lastJjOperationId: afterOpId,
      lastPushedCommitId: existing?.lastPushedCommitId,
      lastReviewedCommitId: existing?.lastReviewedCommitId,
      conflictState: "clean",
      recordedAt: clock.now(),
    });
    try {
      await bindingStore.upsertBinding(binding);
    } catch (error: unknown) {
      throw captureError(
        "binding_update_failed",
        `failed to record binding for node '${input.nodeId}': ${errorMessage(error)}`,
        "Inspect the binding store and rerun capture; the commit already landed in the working copy.",
        error,
      );
    }

    logger.info("commit captured", {
      captureId,
      repositoryId: centralRepo.repositoryId,
      nodeId: input.nodeId,
      treeId: input.treeId,
      commitSha: receipt.commitSha,
      jjChangeId,
    });

    return Object.freeze({
      nodeId: input.nodeId,
      treeId: input.treeId,
      jjChangeId,
      newCommitId: receipt.commitSha,
      parentChangeId,
      beforeOpId,
      afterOpId,
      capturedAt: clock.now(),
      authorIdentity: engineIdentity,
      committed: true,
    });
  }

  async function captureNoChangeNode(
    input: CommitCaptureInput,
    head: JjWorkingCopyHead,
    captureId: string,
  ): Promise<CommitCaptureReceipt> {
    // A no-change node makes no commit. Its effective revision is the unchanged
    // parent commit; the operation-log id is stable across the (absent) commit.
    const opId = await workingCopy.currentOperationLogId(input.workingCopyId);
    const parentChangeId = changeIdFingerprint(head.parentChangeId);
    logger.info("no-change node captured (unchanged revision)", {
      captureId,
      repositoryId: centralRepo.repositoryId,
      nodeId: input.nodeId,
      treeId: input.treeId,
      unchangedCommitId: head.parentCommit,
    });

    return Object.freeze({
      nodeId: input.nodeId,
      treeId: input.treeId,
      jjChangeId: parentChangeId,
      newCommitId: head.parentCommit,
      parentChangeId,
      beforeOpId: opId,
      afterOpId: opId,
      capturedAt: clock.now(),
      authorIdentity: engineIdentity,
      committed: false,
    });
  }

  return {
    async captureCommit(input: CommitCaptureInput): Promise<CommitCaptureReceipt> {
      const captureId = ids.nextId();

      // 1. Gate validation — fail-closed unless every required category is unblocked.
      const validation = validateGateReceipts(input.gateReceipts, input.gateExpectation);
      if (!validation.unblocked) {
        throw captureError(
          "gate_not_passed",
          `node '${input.nodeId}' is not unblocked by its gate receipts: ${formatProblems(validation.problems)}`,
          "Run every required gate category to a fresh passing receipt before capturing.",
        );
      }

      // 2. Live head — read once; used for agent-commit detection + expected-head.
      const head = await workingCopy.head(input.workingCopyId);

      // 3. Prohibited agent-commit detection. The engine owns every commit through
      //    the broker; if @ drifted off the registered id, somebody committed
      //    out-of-band. Fail-closed before touching history.
      if (head.workingCopyChangeId !== input.workingCopyId) {
        throw captureError(
          "agent_commit_detected",
          `working-copy change id '${head.workingCopyChangeId}' no longer matches the registered id '${input.workingCopyId}'; the working copy advanced outside the engine broker`,
          "Destroy and recreate the working copy; only the engine may commit through the broker.",
        );
      }

      // 4. Expected workspace head — the working copy's parent must still match the
      //    head the gate ran against, so nothing slipped in between gate and capture.
      if (head.parentCommit !== input.expectedHead) {
        throw captureError(
          "unexpected_head",
          `working-copy parent commit '${head.parentCommit}' does not match the expected head '${input.expectedHead}' captured at gate time`,
          "Re-run the gate against the current working-copy head before capturing.",
        );
      }

      if (input.nodeKind === "no-change") {
        return captureNoChangeNode(input, head, captureId);
      }
      return captureChangeNode(input, head, captureId);
    },

    async resolveChildBase(
      treeId: TaskTreeId,
      childNodeId: TaskNodeId,
    ): Promise<ChildBaseResolution> {
      // Walk up through non-commit ancestors (artifact / read-only nodes that have
      // no binding of their own) until the nearest committed ancestor is found.
      let current = tree.getParentNode(treeId, childNodeId);
      while (current !== null) {
        const binding = await bindingStore.getBinding(treeId, current);
        if (binding !== undefined) {
          return Object.freeze({
            baseNodeId: current,
            baseCommitId: binding.currentCommitId,
            baseChangeId: binding.jjChangeId,
            rewriteGeneration: binding.rewriteGeneration,
          });
        }
        current = tree.getParentNode(treeId, current);
      }
      throw captureError(
        "child_base_unresolved",
        `no committed ancestor found for child node '${childNodeId}' in tree '${treeId}'`,
        "Capture a commit on an ancestor before resolving this child's base.",
      );
    },

    async markStaleDescendants(
      treeId: TaskTreeId,
      parentNodeId: TaskNodeId,
    ): Promise<readonly StaleDescendant[]> {
      // After a parent's commit changed (rewrite), every bound descendant is stale:
      // it was stacked on the old parent and needs restacking. Mark each by moving
      // its conflict state to "conflict" (clean -> conflict is a valid transition).
      const all = await bindingStore.listForTree(treeId);
      const markedAt = clock.now();
      const stale: StaleDescendant[] = [];

      for (const binding of all) {
        if (binding.nodeId === parentNodeId) {
          continue;
        }
        if (!isDescendantOf(tree, treeId, binding.nodeId, parentNodeId)) {
          continue;
        }
        const previous = binding.conflictState;
        if (isValidConflictTransition(previous, "conflict")) {
          const next: VcsChangeBinding = Object.freeze({
            ...binding,
            conflictState: "conflict",
            recordedAt: markedAt,
          });
          try {
            await bindingStore.upsertBinding(next);
          } catch (error: unknown) {
            throw captureError(
              "stale_marking_failed",
              `failed to mark descendant '${binding.nodeId}' stale: ${errorMessage(error)}`,
              "Inspect the binding store and rerun stale marking.",
              error,
            );
          }
        }
        stale.push(
          Object.freeze({
            nodeId: binding.nodeId,
            jjChangeId: binding.jjChangeId,
            previousConflictState: previous,
            markedAt,
          }),
        );
      }

      logger.info("descendants marked stale", {
        treeId,
        parentNodeId,
        count: stale.length,
      });

      return Object.freeze(stale);
    },
  };
}

/**
 * Walk the tree up from `nodeId`: is `nodeId` a descendant of `ancestorId`?
 * Pure over the {@link CommitCaptureTree} parent links.
 */
function isDescendantOf(
  tree: CommitCaptureTree,
  treeId: TaskTreeId,
  nodeId: TaskNodeId,
  ancestorId: TaskNodeId,
): boolean {
  let current: TaskNodeId = nodeId;
  while (current !== ancestorId) {
    const parent = tree.getParentNode(treeId, current);
    if (parent === null) {
      return false;
    }
    current = parent;
  }
  return true;
}
