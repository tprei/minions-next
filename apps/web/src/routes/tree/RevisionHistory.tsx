import type { ReactNode } from "react";
import type { PlanRevision } from "@minions/contracts";
import { Fact, StatusBadge } from "@minions/ui-kit";
import { formatTimestamp } from "../home/format.js";
import { planRevisionStateBadgeKind, planRevisionStateLabel } from "./tree-labels.js";
import "./RevisionHistory.css";

/**
 * Plan revision timeline (PR 46 — plan-tree-editor-approval). `TaskTree.revisions` carries
 * every revision's own metadata (ordinal, goal, state, timestamps) but not a node-level
 * snapshot — see tree-model.ts's doc comment for why the node-level diff (PlanDiffPanel)
 * compares the working copy against the CURRENT tree rather than against a specific prior
 * revision. This panel is the complementary, purely historical view: which revisions existed,
 * in what order, and what happened to each.
 */
export interface RevisionHistoryProps {
  readonly revisions: readonly PlanRevision[];
  readonly activeRevisionId: string;
}

export function RevisionHistory({ revisions, activeRevisionId }: RevisionHistoryProps): ReactNode {
  const ordered = [...revisions].sort((a, b) =>
    a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0,
  );
  return (
    <ul className="mn-revision-history" data-testid="revision-history">
      {ordered.map((revision) => (
        <li key={revision.id} className="mn-revision-history__item">
          <div className="mn-revision-history__header">
            <Fact>revision {revision.ordinal.toString()}</Fact>
            <StatusBadge
              status={planRevisionStateBadgeKind(revision.state)}
              label={planRevisionStateLabel(revision.state)}
            />
            {revision.id === activeRevisionId ? <StatusBadge status="info" label="active" /> : null}
          </div>
          <p className="mn-revision-history__goal">{revision.goal}</p>
          <div className="mn-revision-history__facts">
            <Fact>created {formatTimestamp(revision.createdAt)}</Fact>
            {revision.approvedAt !== undefined ? (
              <Fact>approved {formatTimestamp(revision.approvedAt)}</Fact>
            ) : null}
            {revision.supersededAt !== undefined ? (
              <Fact>superseded {formatTimestamp(revision.supersededAt)}</Fact>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
