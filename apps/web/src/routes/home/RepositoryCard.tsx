import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { RegisteredRepository, RepositorySummary, TreeSummary } from "@minions/contracts";
import { Card, Fact, StatusBadge } from "@minions/ui-kit";
import { formatTimestamp } from "./format.js";
import { shortId, treeStateBadgeKind, treeStateLabel } from "./labels.js";

export interface RepositoryCardProps {
  readonly summary: RepositorySummary;
  readonly detail: RegisteredRepository | undefined;
  readonly trees: readonly TreeSummary[];
}

/**
 * One registered repository's capability card (PR 45 — host-repository-task-ui, PRD UI-01
 * "fleet overview" half). `summary` is the live projection row (id/hostId/archived/version —
 * see event.proto's `RepositorySummary`); `detail` is the richer `RegisteredRepository`
 * hydrated via `ListRepositories` (canonical root/remote, default branch, base commit — see
 * useDirectoryDetail) and may briefly be `undefined` right after a repository first appears,
 * before that fetch resolves. `trees` lists every `TreeSummary` already created here, newest
 * work included the moment the projection's event stream delivers it — only id and state are
 * shown because `TreeSummary` (unlike the full `TaskTree` returned by `CreateTree`/`GetTree`)
 * doesn't carry `goal`; NewTaskDialog shows the goal once, from the authoritative creation
 * response, right after the operator submits it.
 */
export function RepositoryCard({ summary, detail, trees }: RepositoryCardProps): ReactNode {
  return (
    <Card className="mn-repository-card" data-testid="repository-card">
      <div className="mn-repository-card__header">
        <p className="mn-repository-card__title" title={summary.id}>
          {detail?.canonicalRoot ?? `Repository ${shortId(summary.id)}`}
        </p>
        {summary.archived ? <StatusBadge status="warning" label="archived" /> : null}
      </div>
      {detail === undefined ? (
        <p className="mn-muted">Loading repository details…</p>
      ) : (
        <div className="mn-repository-card__facts">
          <Fact className="mn-repository-card__path">{detail.canonicalRoot}</Fact>
          <Fact className="mn-repository-card__path">{detail.canonicalRemote}</Fact>
          <Fact>
            {detail.defaultBranch} @ {shortId(detail.baseCommit)}
          </Fact>
          <Fact>registered {formatTimestamp(detail.registeredAt)}</Fact>
        </div>
      )}
      <div className="mn-repository-card__trees">
        <p className="mn-repository-card__trees-label">Tasks</p>
        {trees.length === 0 ? (
          <p className="mn-muted">No tasks yet.</p>
        ) : (
          <ul className="mn-tree-list">
            {trees.map((tree) => (
              <li key={tree.id} className="mn-tree-list__item">
                <Link className="mn-tree-list__link" to={`/tree/${tree.id}`} title={tree.id}>
                  {shortId(tree.id)}
                </Link>
                <StatusBadge
                  status={treeStateBadgeKind(tree.state)}
                  label={treeStateLabel(tree.state)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
