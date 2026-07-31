/**
 * Release dogfood qualification (PR 60 — release-dogfood-qualification).
 *
 * Use Minions to finish Minions and produce the v1 release evidence bundle.
 * Every PRD release criterion is demonstrated end to end. No bootstrap
 * exception remains open, no required check is advisory, every PR has
 * current human approval, and landing occurs only through explicit human actions.
 */
export type ReleaseCriterion = Readonly<{
  readonly id: number;
  readonly name: string;
  readonly demonstrated: boolean;
  readonly evidenceSha: string | undefined;
}>;

export const RELEASE_CRITERIA_COUNT = 18;

export const RELEASE_CRITERIA_DEFINITIONS: readonly ReleaseCriterion[] = Object.freeze([
  {
    id: 1,
    name: "Strict tree lifecycle from plan to landing",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 2,
    name: "Fenced sandbox denies network and filesystem escape",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 3,
    name: "Durable event stream survives daemon restart",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 4,
    name: "Lease-based scheduler prevents double execution",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 5,
    name: "Crash-safe migrations with rollback",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 6,
    name: "Repository confinement with path canonicalization",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 7,
    name: "Command receipts distinguish requested through applied",
    demonstrated: false,
    evidenceSha: undefined,
  },
  { id: 8, name: "Plan approval gates execution", demonstrated: false, evidenceSha: undefined },
  {
    id: 9,
    name: "Artifact content-addressing with digest verification",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 10,
    name: "jj operations: absorb, restack, op-log recovery",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 11,
    name: "Remote SSH host bootstraps and recovers",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 12,
    name: "Phone pairing with revocable sessions",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 13,
    name: "WSL2 host with all four requirements enforced",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 14,
    name: "Maintenance plane independent of host.db",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 15,
    name: "All 20 synthetic security scenarios have blocking tests",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 16,
    name: "No advisory CI gates — every check is blocking",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 17,
    name: "Every PR has current human approval",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 18,
    name: "Landing occurs only through explicit human actions",
    demonstrated: false,
    evidenceSha: undefined,
  },
]);

export type ReleaseReadiness = Readonly<{
  readonly ready: boolean;
  readonly pending: readonly ReleaseCriterion[];
}>;

/** Check release readiness from a list of criteria (pure). */
export function checkReleaseReadiness(criteria: readonly ReleaseCriterion[]): ReleaseReadiness {
  const pending = criteria
    .filter((c) => !c.demonstrated || c.evidenceSha === undefined)
    .sort((a, b) => a.id - b.id);
  return Object.freeze({ ready: pending.length === 0, pending: Object.freeze(pending) });
}
