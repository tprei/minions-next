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
    name: "Tree correctness: 100% valid one-root/one-parent trees before writable execution",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 2,
    name: "Node ownership: one durable harness identity, one isolated workspace, one active process",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 3,
    name: "Repository confinement: adversarial tests cannot escape the assigned boundary",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 4,
    name: "Deterministic gates: missing or invalid evidence fails closed",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 5,
    name: "Incremental recovery: forced crashes never rerun successful ancestors or siblings",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 6,
    name: "Git correctness: one recorded parent, restack on parent movement, expected-head landing",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 7,
    name: "Human review: current approval from an eligible human, invalidated by new push, no auto-merge",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 8,
    name: "Output correctness: typed output contracts, no empty unexplained work",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 9,
    name: "Steering: any live or resumable node addressable with visible delivery/ack state",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 10,
    name: "Contract integrity: server, generated client, UI, and event replay pass Protobuf E2E",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 11,
    name: "Credential durability: one interactive login survives broker, daemon, worker, machine restarts",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 12,
    name: "Provider admission: concurrent nodes respect the per-credential limit and resume after pause",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 13,
    name: "Remote execution: a complete tree runs and recovers on an SSH-attached WSL2 host",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 14,
    name: "Break-glass recovery: maintenance agent starts unavailable-primary, requires explicit elevation",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 15,
    name: "UI quality: desktop/phone synthetic flows, visual regression, and a11y pass as blocking gates",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 16,
    name: "Dogfood: Minions completes the release qualification self-change end to end",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 17,
    name: "No silent fallback: unsupported capability or policy fails visibly before code execution",
    demonstrated: false,
    evidenceSha: undefined,
  },
  {
    id: 18,
    name: "Auditability: every landed line and non-code outcome is traceable end to end",
    demonstrated: false,
    evidenceSha: undefined,
  },
]);

export type ReleaseReadiness = Readonly<{
  readonly ready: boolean;
  readonly pending: readonly ReleaseCriterion[];
}>;

/**
 * Check release readiness against the canonical criteria list (pure). Fails
 * closed: any criterion missing from `criteria`, undemonstrated, or lacking a
 * non-empty `evidenceSha` is reported pending. Empty or partial input can
 * never report ready — every one of the 18 canonical criteria must be
 * present and satisfied.
 */
export function checkReleaseReadiness(criteria: readonly ReleaseCriterion[]): ReleaseReadiness {
  const byId = new Map(criteria.map((c) => [c.id, c] as const));
  const pending = RELEASE_CRITERIA_DEFINITIONS.filter((definition) => {
    const actual = byId.get(definition.id);
    return (
      actual === undefined ||
      !actual.demonstrated ||
      actual.evidenceSha === undefined ||
      actual.evidenceSha.length === 0
    );
  }).map((definition) => byId.get(definition.id) ?? definition);
  return Object.freeze({ ready: pending.length === 0, pending: Object.freeze(pending) });
}
