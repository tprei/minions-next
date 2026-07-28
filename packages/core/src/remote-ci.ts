/**
 * Remote-CI evidence domain (PR 35) — pure, I/O-free classification of GitHub
 * CI checks as deterministic evidence for an exact head SHA.
 *
 * ## Fail-closed verdict (QA-06..QA-10, acceptance)
 * A check counts as passing ONLY when its verdict is `success`. Every other
 * verdict — `failure`, `neutral`, `skipped`, `cancelled`, `timed_out`,
 * `action_required`, `stale`, `missing`, `in_progress`, `unknown` — is NOT
 * passing. Missing/skipped/neutral/cancelled/timed-out/stale/unknown checks
 * never count as success.
 *
 * ## Overall aggregation
 * `classifyOverall` reduces a set of observations against a required check set
 * to one of three overall states: `success` (every required check present and
 * green), `failure` (a required check is hard-red), or `incomplete` (a required
 * check is missing, stale, still running, or merely soft/non-green). Only an
 * all-green required set is `success`.
 *
 * ## Base-failure detection
 * `isBaseFailure` flags a check that is hard-red on BOTH the head under review
 * and the PR base — an infrastructure/flaky signal that is NOT a node defect,
 * so the caller escalates instead of repairing the node.
 *
 * This module performs NO I/O and depends only on the {@link GitSha}
 * value object. The adapter ({@link createRemoteCiManager}) wires it to the
 * GitHub REST API.
 */
import type { GitSha } from "./value-objects.js";

// -------------------------------------------------------------------------------------------------
// Verdicts.
// -------------------------------------------------------------------------------------------------

/**
 * Per-check verdict. Mirrors GitHub's check-run conclusions plus the synthetic
 * states the evidence model needs (`missing`, `in_progress`, `stale`, `unknown`).
 * `success` is the ONLY passing verdict.
 */
export type CheckVerdict =
  | "success"
  | "failure"
  | "neutral"
  | "skipped"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "stale"
  | "missing"
  | "in_progress"
  | "unknown";

/**
 * Aggregated CI state for one head SHA. `success` requires every required
 * check to be green; `failure` means a required check is hard-red; `incomplete`
 * means a required check is absent/stale/running/soft — never countable as
 * success.
 */
export type CiOverallVerdict = "success" | "incomplete" | "failure";

/**
 * Hard-red verdicts — a completed check that definitively did not pass. These
 * drive both overall `failure` classification and base-failure detection. Soft
 * non-green verdicts (`neutral`, `skipped`) are NOT here: they make the overall
 * `incomplete` rather than `failure`.
 */
export const FAILURE_VERDICTS: Readonly<Record<CheckVerdict, boolean>> = Object.freeze({
  success: false,
  failure: true,
  neutral: false,
  skipped: false,
  cancelled: true,
  timed_out: true,
  action_required: true,
  stale: false,
  missing: false,
  in_progress: false,
  unknown: false,
});

/**
 * Terminal verdicts — the check has reached a final state and need not be
 * polled further. `missing` and `in_progress` are NON-terminal (the check may
 * still appear or finish); every other verdict is terminal.
 */
export const TERMINAL_VERDICTS: Readonly<Record<CheckVerdict, boolean>> = Object.freeze({
  success: true,
  failure: true,
  neutral: true,
  skipped: true,
  cancelled: true,
  timed_out: true,
  action_required: true,
  stale: true,
  missing: false,
  in_progress: false,
  unknown: true,
});

// -------------------------------------------------------------------------------------------------
// Evidence records.
// -------------------------------------------------------------------------------------------------

/**
 * One observed CI check for an exact head SHA. `headSha` is the commit the
 * check actually ran against; when it differs from the PR head the observation
 * is stale. `conclusion` is the raw GitHub conclusion (or `null`) preserved for
 * diagnostics.
 */
export interface CheckObservation {
  readonly name: string;
  readonly headSha: GitSha;
  readonly verdict: CheckVerdict;
  /** ISO-8601 completion timestamp, or `null` while the check is still running. */
  readonly completedAt: string | null;
  /** HTML URL for the check run log, or `null` when GitHub did not provide one. */
  readonly logUrl: string | null;
  /** Raw GitHub conclusion string (e.g. `"success"`), or `null` while running. */
  readonly conclusion: string | null;
}

/**
 * Aggregated CI evidence for one head SHA. `overallVerdict` is the
 * {@link classifyOverall} reduction of `checks` against the required set; only
 * `"success"` is mergeable.
 */
export interface CiEvidence {
  readonly headSha: GitSha;
  readonly checks: readonly CheckObservation[];
  readonly overallVerdict: CiOverallVerdict;
  /** True iff every required check is present (not missing, not stale). */
  readonly allRequiredPresent: boolean;
}

/**
 * The required-check policy: the named checks that MUST pass for evidence to
 * count as success. Names match GitHub check-run `name` values.
 */
export interface RequiredCheckSet {
  readonly requiredChecks: readonly string[];
}

// -------------------------------------------------------------------------------------------------
// Pure classifiers.
// -------------------------------------------------------------------------------------------------

/**
 * True ONLY when the observation is `success`. Every other verdict fails closed
 * (QA-06..QA-10). This is the single source of truth for "is this check green".
 */
export function isCheckPassing(observation: CheckObservation): boolean {
  return observation.verdict === "success";
}

/** True for hard-red verdicts (`failure`/`cancelled`/`timed_out`/`action_required`). */
export function isFailureVerdict(verdict: CheckVerdict): boolean {
  return FAILURE_VERDICTS[verdict];
}

/** True once the check has reached a final state (no further polling needed). */
export function isTerminalVerdict(verdict: CheckVerdict): boolean {
  return TERMINAL_VERDICTS[verdict];
}

/** Find a check observation by name, or `undefined` when absent. */
export function findCheck(
  checks: readonly CheckObservation[],
  name: string,
): CheckObservation | undefined {
  return checks.find((check) => check.name === name);
}

/**
 * True iff the observation is stale: it ran against a different head SHA, or
 * GitHub itself concluded `stale`. Stale checks never count as success.
 */
export function isStaleCheck(observation: CheckObservation, currentHeadSha: GitSha): boolean {
  return observation.verdict === "stale" || observation.headSha !== currentHeadSha;
}

/**
 * Aggregate observations against the required set:
 * - `success` — every required check is present AND `success`.
 * - `failure` — at least one required check is hard-red (and none are
 *   missing/stale/running/soft, which take precedence as `incomplete`).
 * - `incomplete` — at least one required check is missing, stale, still
 *   running, unknown, or merely soft (neutral/skipped).
 *
 * Only an all-green required set yields `success`.
 */
export function classifyOverall(
  checks: readonly CheckObservation[],
  required: RequiredCheckSet,
): CiOverallVerdict {
  let incomplete = false;
  let failure = false;
  for (const name of required.requiredChecks) {
    const observation = findCheck(checks, name);
    if (observation === undefined) {
      // A required check with no observation at all is missing.
      incomplete = true;
      continue;
    }
    const verdict = observation.verdict;
    if (
      verdict === "missing" ||
      verdict === "stale" ||
      verdict === "in_progress" ||
      verdict === "unknown"
    ) {
      incomplete = true;
    } else if (verdict !== "success") {
      // Hard-red verdicts are failures; soft non-green (neutral/skipped) make
      // the set incomplete — CI did not confirm a pass.
      if (isFailureVerdict(verdict)) {
        failure = true;
      } else {
        incomplete = true;
      }
    }
  }
  if (incomplete) {
    return "incomplete";
  }
  if (failure) {
    return "failure";
  }
  return "success";
}

/**
 * True iff every required check is present (found, not missing, not stale).
 * A check that is still `in_progress` counts as present — it exists and is
 * running; the set is just not yet complete.
 */
export function allRequiredPresent(
  checks: readonly CheckObservation[],
  required: RequiredCheckSet,
): boolean {
  return required.requiredChecks.every((name) => {
    const observation = findCheck(checks, name);
    return (
      observation !== undefined &&
      observation.verdict !== "missing" &&
      observation.verdict !== "stale"
    );
  });
}

/**
 * Detect a base failure: the named check is hard-red on BOTH the head under
 * review and the PR base. A check that is red on the base too is an
 * infrastructure/flaky signal rather than a defect introduced by this node, so
 * the caller escalates instead of repairing.
 *
 * Returns `false` when the check is not hard-red on the head, or when base
 * evidence is missing/absent for that name (fail-closed toward repair: without
 * base confirmation, treat it as a node failure).
 */
export function isBaseFailure(
  checkName: string,
  headEvidence: CiEvidence,
  baseEvidence: CiEvidence,
): boolean {
  const headObs = findCheck(headEvidence.checks, checkName);
  if (headObs === undefined || !isFailureVerdict(headObs.verdict)) {
    return false;
  }
  const baseObs = findCheck(baseEvidence.checks, checkName);
  if (baseObs === undefined) {
    return false;
  }
  return isFailureVerdict(baseObs.verdict);
}
