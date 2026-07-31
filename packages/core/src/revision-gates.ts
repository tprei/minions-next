/**
 * Per-revision gate domain (PR 41, QA-04/07/10).
 *
 * Pure, I/O-free domain for validating EVERY revision in a PR stack
 * independently via `jj run`, not only the stack head. A green head fails when
 * an intermediate revision fails, and a formatter `jj run` may amend exactly
 * the intended revisions — never anything outside them.
 *
 * The runner adapter ({@link createRevisionGateRunner} in `@minions/adapters`)
 * composes this domain with the pinned `jj` binary (PR 21), the gate receipt
 * store (PR 25) and the change-binding store (PR 29). This module performs no
 * I/O and imports no `node:*` modules: the digest is injected by the adapter
 * and the no-mutation proof is a pure function over before/after snapshots.
 */
import { EMPTY_REVSET } from "./revset.js";
import type { AttemptId, ContentHash, TaskTreeId } from "./value-objects.js";
import type { GateCommandDescriptor, GateReceipt } from "./gate-runner.js";

// -------------------------------------------------------------------------------------------------
// Request + result shapes.
// -------------------------------------------------------------------------------------------------

/**
 * Request to run the gate profile over every revision a revset resolves to.
 *
 * - `revsetExpression` is the jj revset the adapter runs `jj run -r '<expr>'`
 *   over (built from the tree's change ids via {@link buildRevisionRevset}).
 * - `intendedChangeIds` is the membership authority for the no-mutation proof:
 *   a formatter may amend exactly these revisions. A commit change for a change
 *   id that is NOT intended is an unexpected mutation (fail + rollback).
 * - `trackedSourceReadOnly` selects the proof strictness. When `true` (lint,
 *   typecheck, tests, build) ANY mutation fails the gate; when `false`
 *   (formatter) only mutations OUTSIDE the intended revset fail.
 */
export type RevisionGateRequest = Readonly<{
  /** Registered tree the revisions belong to (receipt binding scope). */
  treeId: TaskTreeId;
  /** jj revset selecting the revisions to gate. */
  revsetExpression: string;
  /** Change ids the revset is intended to cover (no-mutation authority). */
  intendedChangeIds: readonly string[];
  /** Gate commands executed for every revision in the revset. */
  gateCommands: readonly GateCommandDescriptor[];
  /** Bounded parallelism across revisions (concurrent working copies). */
  parallelism: number;
  /** When true, any tracked-source mutation fails the gate. */
  trackedSourceReadOnly: boolean;
  /** Hash of the gate profile that defined {@link RevisionGateRequest.gateCommands}. */
  profileHash: ContentHash;
  /** Captured environment, hashed into every receipt's environment digest. */
  environment: Readonly<Record<string, string>>;
  /** Attempt the revision gates belong to, or `undefined` when unattributed. */
  attemptId: AttemptId | undefined;
}>;

/** Outcome of running every gate against one revision. */
export type RevisionOutcome = Readonly<{
  /** Stable jj change id of the revision. */
  changeId: string;
  /** Exact commit id the gates ran against. */
  commitId: string;
  /** One durable receipt per gate command. */
  gateResults: readonly GateReceipt[];
  /** `true` only when every gate command passed for this revision. */
  passed: boolean;
}>;

/** Aggregate result of running the gate profile over every revision. */
export type RevisionGateResult = Readonly<{
  /** One outcome per revision, in revset order. */
  perRevision: readonly RevisionOutcome[];
  /** `true` only when EVERY revision passed EVERY gate (QA-04). */
  allPassed: boolean;
  /** Change ids whose commit changed between the before/after snapshots. */
  changedChangeIds: readonly string[];
}>;

// -------------------------------------------------------------------------------------------------
// Snapshot + mutation proof.
// -------------------------------------------------------------------------------------------------

/** A single (change id, commit id) pair captured from `jj log` at one instant. */
export type RevisionIdSnapshot = Readonly<{
  changeId: string;
  commitId: string;
}>;

/**
 * Result of comparing before/after snapshots against the intended revset.
 *
 * - `changedChangeIds` lists every change id whose commit differs (or that
 *   appeared/vanished) between the snapshots — the set a formatter amended.
 * - `unexpectedChangeIds` is the subset of `changedChangeIds` whose change id
 *   is NOT among the intended revisions: a mutation outside the revset.
 * - `unexpectedMutation` is `true` iff `unexpectedChangeIds` is non-empty.
 */
export type MutationProof = Readonly<{
  changedChangeIds: readonly string[];
  unexpectedChangeIds: readonly string[];
  unexpectedMutation: boolean;
}>;

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

/**
 * Build the jj revset that selects exactly `treeChangeIds`. An empty list
 * reduces to {@link EMPTY_REVSET} so a degenerate request can never expand the
 * revset. Each token is wrapped in parentheses so the union composes safely
 * inside a larger expression.
 */
export function buildRevisionRevset(treeChangeIds: readonly string[]): string {
  if (treeChangeIds.length === 0) {
    return EMPTY_REVSET;
  }
  for (const id of treeChangeIds) {
    if (typeof id !== "string" || id.length === 0) {
      throw new RangeError("tree change id must be a non-empty string");
    }
  }
  return treeChangeIds.map((id) => `(${id})`).join(" | ");
}

/**
 * Compare before/after snapshots and detect mutations outside the intended
 * revset. Pure: identical inputs always yield identical proof.
 *
 * A change id is "changed" when its commit differs between snapshots, or when
 * it appears in only one of them (a revision was amended in or removed). A
 * changed id is "unexpected" when it is not a member of `intendedChangeIds`.
 * The caller applies {@link RevisionGateRequest.trackedSourceReadOnly} to
 * decide whether an intended amendment is itself a failure.
 *
 * `before` and `after` MUST be the same scope (the runner snapshots the whole
 * registered tree both times); `intendedChangeIds` is the revset membership.
 */
export function validateNoUnexpectedMutation(
  intendedChangeIds: readonly string[],
  before: readonly RevisionIdSnapshot[],
  after: readonly RevisionIdSnapshot[],
): MutationProof {
  const intended = new Set<string>(intendedChangeIds);
  const beforeCommits = new Map<string, string>();
  for (const snapshot of before) {
    beforeCommits.set(snapshot.changeId, snapshot.commitId);
  }
  const afterChangeIds = new Set<string>();
  const changed: string[] = [];
  const unexpected: string[] = [];

  const record = (changeId: string): void => {
    changed.push(changeId);
    if (!intended.has(changeId)) {
      unexpected.push(changeId);
    }
  };

  for (const snapshot of after) {
    afterChangeIds.add(snapshot.changeId);
    const previous = beforeCommits.get(snapshot.changeId);
    if (previous === undefined || previous !== snapshot.commitId) {
      record(snapshot.changeId);
    }
  }
  // A revision present before but absent after also counts as a mutation.
  for (const snapshot of before) {
    if (!afterChangeIds.has(snapshot.changeId)) {
      record(snapshot.changeId);
    }
  }

  const changedChangeIds = dedupePreserveOrder(changed);
  const unexpectedChangeIds = dedupePreserveOrder(unexpected);
  return Object.freeze({
    changedChangeIds,
    unexpectedChangeIds,
    unexpectedMutation: unexpectedChangeIds.length > 0,
  });
}

/** Deduplicate a list while preserving first-seen order. */
function dedupePreserveOrder(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return Object.freeze(out);
}
