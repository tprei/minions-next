/**
 * Explicit-landing domain (PR 36).
 *
 * Pure, I/O-free types + helpers for landing a single pull request only after a
 * fresh human action. Landing is the one mutation that consumes the whole
 * preflight pipeline — head/parent/check/review/ruleset/gates — and it is the
 * single point at which a stack node becomes part of the trunk.
 *
 * ## Only a human initiates (GIT-03, GIT-04, GIT-08, GIT-12)
 * A landing is authorized solely by a {@link HumanApproval} — an opaque
 * capability issued at the authenticated boundary from a transport-derived
 * principal. No timer, queue, webhook, or model can forge one: the capability
 * tag is a module-private symbol, so a request body or cast lacks it and
 * {@link validateLandingIntent} fails closed. The legacy `requestedBy` field is
 * retained for wire-compat but is never a trust input. There is no auto-merge:
 * every landing begins with an explicit human command that names exactly one PR.
 *
 * ## Fail-closed preflight (PR 32 / PR 35 / PR 31 / PR 25)
 * {@link LandingPreflight} is six booleans, each fail-closed: the corresponding
 * preflight signal must be affirmatively `true`. {@link evaluatePreflight}
 * reduces them to a typed {@link LandingVerdict} in specificity order — a moved
 * head is `ambiguous_remote`, an unlanded parent is `parent_not_landed`, any
 * other failed gate is `preflight_failed`. Only all-six-true yields `landed`.
 *
 * ## Durable receipts + crash reconciliation
 * {@link LandingReceipt} is the durable proof a landing happened. It carries the
 * merged SHA, the merge method, and the parent-retarget plan applied to the
 * landed node's children. The receipt is reconstructable from GitHub state
 * (PR `merged` + `merge_commit_sha`), so a crash between merge and receipt
 * recording reconciles on restart — see {@link isAlreadyLanded}.
 */
import type { RetargetPlan } from "./stack-parentage.js";
import type { ActorSessionId, GitSha, Timestamp } from "./value-objects.js";

// -------------------------------------------------------------------------------------------------
// Initiator + merge method.
// -------------------------------------------------------------------------------------------------

/**
 * Wire-compat initiator literal. RETAINED ONLY for backward request-body
 * compatibility — it is NOT a trust input and is never consulted for
 * authorization. The actual trust gate is {@link HumanApproval}, which cannot be
 * self-asserted.
 */
export type LandingRequestedBy = "human";

/**
 * Module-private capability tag. Not exported: external code (request bodies,
 * `JSON.parse`, casts) cannot construct an object keyed by this symbol, so a
 * {@link HumanApproval} can originate only from {@link humanApproval} at the
 * authenticated boundary. Forged provenance — `requestedBy: "human"` sent by a
 * webhook/timer/model — lacks the tag and fails closed.
 */
const humanApprovalTag: unique symbol = Symbol("minions.HumanApproval");

/**
 * Opaque capability proving the landing was triggered by a verified human
 * principal. Construct ONLY via {@link humanApproval} from a transport-derived
 * authenticated principal (an {@link ActorSessionId} established at the request
 * boundary). Because the tag is a module-private symbol, an automated
 * webhook/timer/model cannot forge one from a request body; this is the sole
 * trust gate that lets a landing proceed (GIT-03/04/08/12).
 */
export type HumanApproval = Readonly<{ readonly [humanApprovalTag]: ActorSessionId }>;

/**
 * The single construction site for a {@link HumanApproval}. The caller MUST be
 * the authenticated boundary: `principal` is a transport-derived actor session,
 * never a value read from the request body. Pure.
 */
export function humanApproval(principal: ActorSessionId): HumanApproval {
  return { [humanApprovalTag]: principal };
}

/**
 * Type guard for a genuine {@link HumanApproval} issued by {@link humanApproval}.
 * A plain object (request body, cast, or forged provenance) fails: it cannot
 * carry the module-private tag. Pure.
 */
function isHumanApproval(value: unknown): value is HumanApproval {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return humanApprovalTag in value;
}

/**
 * Typed merge method. Engine commits always squash (GIT-12): one commit per
 * landed node on the trunk, no merge bubbles.
 */
export type LandingMergeMethod = "squash" | "merge" | "rebase";

// -------------------------------------------------------------------------------------------------
// Intent.
// -------------------------------------------------------------------------------------------------

/**
 * One explicit human command landing exactly one named PR. Carries a verified
 * {@link HumanApproval} (the trust gate, supplied at the authenticated boundary)
 * and the expected head SHA so the preflight can detect that the remote head
 * moved between the command and execution.
 */
export type LandingIntent = Readonly<{
  readonly prNumber: number;
  readonly repositoryFullName: string;
  /**
   * Verified human principal capability. The SOLE trust input: it must be a
   * genuine {@link HumanApproval} issued at the authenticated boundary. An
   * intent lacking one is rejected by {@link validateLandingIntent}.
   */
  readonly humanApproval: HumanApproval;
  /**
   * Wire-compat initiator literal; NOT consulted for trust (see
   * {@link humanApproval}). Optional so untyped callers still parse, but it can
   * never authorize a landing on its own.
   */
  readonly requestedBy?: LandingRequestedBy;
  /** Head SHA the human reviewed; preflight rejects if the live head differs. */
  readonly expectedHeadSha: GitSha;
  /** When the human issued the command (epoch ms). */
  readonly requestedAt: Timestamp;
}>;

// -------------------------------------------------------------------------------------------------
// Verdict + preflight.
// -------------------------------------------------------------------------------------------------

/**
 * Terminal outcome of a land attempt.
 * - `landed` — fresh merge executed this call.
 * - `already_landed` — PR merged (reconstructed from GitHub state); idempotent.
 * - `duplicate_command` — a receipt for this exact intent already exists.
 * - `ambiguous_remote` — the live head moved since the command; reconcile first.
 * - `parent_not_landed` — a stacked parent must land first (parent-before-child).
 * - `preflight_failed` — a check/review/ruleset/gate signal was not satisfied.
 */
export type LandingVerdict =
  | "landed"
  | "preflight_failed"
  | "already_landed"
  | "parent_not_landed"
  | "ambiguous_remote"
  | "duplicate_command";

/**
 * The six fail-closed preflight signals. Each must be affirmatively `true`;
 * `evaluatePreflight` reduces them to a verdict in specificity order.
 */
export type LandingPreflight = Readonly<{
  /** The live PR head equals the intent's expected head. */
  readonly headMatches: boolean;
  /** The parent node already landed (true for a root). */
  readonly parentLanded: boolean;
  /** Every required CI check passed (success-only, PR 35). */
  readonly checksPass: boolean;
  /** A fresh eligible human approval exists after the latest push (PR 32). */
  readonly reviewFresh: boolean;
  /** The branch ruleset enforces independent human review (PR 31). */
  readonly rulesetEnforced: boolean;
  /** Every required local gate category has a fresh passing receipt (PR 25). */
  readonly allGatesPassed: boolean;
}>;

// -------------------------------------------------------------------------------------------------
// Receipt.
// -------------------------------------------------------------------------------------------------

/**
 * Durable proof a landing happened. Reconstructable from GitHub state (merged +
 * merge-commit SHA + merged-at + merge method); the `parentRetargetPlan` records
 * the retargets applied to the landed node's children (PR 33).
 */
export type LandingReceipt = Readonly<{
  readonly prNumber: number;
  readonly repositoryFullName: string;
  /** SHA of the commit landed on the trunk. */
  readonly mergedSha: string;
  /** When the merge committed (epoch ms). */
  readonly landedAt: Timestamp;
  readonly mergeMethod: LandingMergeMethod;
  /** Retarget plans applied to the landed node's direct children. */
  readonly parentRetargetPlan: readonly RetargetPlan[];
  readonly verdict: LandingVerdict;
}>;

// -------------------------------------------------------------------------------------------------
// Receipt store port (durable archive). The implementation lives in adapters;
// this is the pure typed surface — no I/O here, mirroring GateReceiptStore.
// -------------------------------------------------------------------------------------------------

export type LandingReceiptStoreErrorCode = "invalid_input" | "write_failed" | "corrupt";

/** Typed landing-receipt-store error. Fail-closed: every write failure surfaces. */
export class LandingReceiptStoreError extends Error {
  readonly code: LandingReceiptStoreErrorCode;

  constructor(code: LandingReceiptStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LandingReceiptStoreError";
    this.code = code;
  }
}

/**
 * Durable archive of {@link LandingReceipt}s, keyed by (repository, PR). A
 * recorded receipt is the idempotency marker: a duplicate land command for the
 * same PR returns the stored receipt rather than re-merging.
 */
export interface LandingReceiptStore {
  /** Persist a receipt (crash-safe; idempotent for the same key). */
  recordReceipt(receipt: LandingReceipt): Promise<void>;
  /** The receipt for a (repository, PR), if any. */
  getReceipt(repositoryFullName: string, prNumber: number): Promise<LandingReceipt | undefined>;
}

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

const repositoryFullNamePattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

/**
 * Validate a {@link LandingIntent} structurally. Throws on any invariant breach
 * — most importantly when a genuine {@link HumanApproval} is absent, which is the
 * acceptance guard (no timer/queue/webhook/model can initiate). `requestedBy`,
 * if present, is ignored for trust. Pure, fail-closed.
 */
export function validateLandingIntent(intent: LandingIntent): void {
  // The SOLE trust gate: a genuine HumanApproval can only be produced by
  // humanApproval() from a transport-derived authenticated principal. A request
  // body, cast, or forged provenance (e.g. `requestedBy: "human"` from a
  // webhook) lacks the module-private tag — fail closed so no automated actor
  // can land.
  if (!isHumanApproval(intent.humanApproval)) {
    throw new Error(
      "landing requires a verified human principal (HumanApproval); an automated " +
        "webhook, timer, queue, or model cannot initiate a landing",
    );
  }
  if (!Number.isInteger(intent.prNumber) || intent.prNumber <= 0) {
    throw new Error(`invalid prNumber: ${String(intent.prNumber)} (must be a positive integer)`);
  }
  if (!repositoryFullNamePattern.test(intent.repositoryFullName)) {
    throw new Error(
      `invalid repositoryFullName '${intent.repositoryFullName}' (expected 'owner/repo')`,
    );
  }
  // expectedHeadSha / requestedAt are branded value objects (validated at
  // construction); nothing further to assert here. `requestedBy` is retained for
  // wire-compat and is deliberately NOT consulted for trust.
}

/**
 * Reduce the six preflight signals to a verdict in specificity order:
 * 1. `ambiguous_remote` — head moved since the command (reconcile before retry).
 * 2. `parent_not_landed` — parent-before-child: the parent must land first.
 * 3. `preflight_failed` — any check/review/ruleset/gate signal not satisfied.
 * 4. `landed` — every signal affirmatively true.
 *
 * Pure. The coordinator gathers the signals from its ports then calls this.
 */
export function evaluatePreflight(preflight: LandingPreflight): LandingVerdict {
  if (!preflight.headMatches) {
    return "ambiguous_remote";
  }
  if (!preflight.parentLanded) {
    return "parent_not_landed";
  }
  if (
    !preflight.checksPass ||
    !preflight.reviewFresh ||
    !preflight.rulesetEnforced ||
    !preflight.allGatesPassed
  ) {
    return "preflight_failed";
  }
  return "landed";
}

/**
 * True iff the PR is already landed: either a durable receipt exists for it, or
 * GitHub reports it merged. This is the crash-reconciliation predicate — a
 * process that crashed between merge and receipt recording reconciles here.
 * Pure.
 */
export function isAlreadyLanded(
  input: Readonly<{
    readonly receipt: LandingReceipt | undefined;
    readonly merged: boolean;
  }>,
): boolean {
  return input.receipt !== undefined || input.merged;
}
