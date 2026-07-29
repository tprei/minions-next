import type { ReactNode } from "react";
import type {
  ExecutionHost,
  RegisteredRepository,
  RepositorySummary,
  TreeSummary,
} from "@minions/contracts";
import { Card, Fact, StatusBadge } from "@minions/ui-kit";
import { formatTimestamp } from "./format.js";
import { hostKindLabel, hostStateBadgeKind, hostStateLabel } from "./labels.js";
import { RepositoryCard } from "./RepositoryCard.js";

export interface HostCardProps {
  readonly host: ExecutionHost;
  readonly repositories: readonly RepositorySummary[];
  readonly repositoryDetail: ReadonlyMap<string, RegisteredRepository>;
  readonly treesByRepository: ReadonlyMap<string, readonly TreeSummary[]>;
}

/**
 * One execution host's health/capability card (PR 45 — host-repository-task-ui, PRD UI-01,
 * UI-08). `host` comes straight from `HostService.ListHosts` (see useHostList) — hosts have
 * no live event-sourced projection in this daemon revision, so there is no separate
 * "summary vs. detail" split here the way there is for repositories: `ExecutionHost` already
 * carries everything the card shows (`kind`, the real 5-value `state`, `endpoint`,
 * `lastSeenAt`), polled periodically rather than pushed.
 */
export function HostCard({
  host,
  repositories,
  repositoryDetail,
  treesByRepository,
}: HostCardProps): ReactNode {
  return (
    <Card className="mn-host-card" data-testid="host-card">
      <div className="mn-host-card__header">
        <p className="mn-host-card__title" title={host.id}>
          {host.displayName}
        </p>
        <StatusBadge status={hostStateBadgeKind(host.state)} label={hostStateLabel(host.state)} />
      </div>
      <div className="mn-host-card__facts">
        <Fact>{hostKindLabel(host.kind)}</Fact>
        {host.endpoint !== undefined ? <Fact>{host.endpoint}</Fact> : null}
        <Fact>last seen {formatTimestamp(host.lastSeenAt)}</Fact>
      </div>
      <div className="mn-host-card__repositories">
        {repositories.length === 0 ? (
          <p className="mn-muted">No repositories registered on this host yet.</p>
        ) : (
          repositories.map((repository) => (
            <RepositoryCard
              key={repository.id}
              summary={repository}
              detail={repositoryDetail.get(repository.id)}
              trees={treesByRepository.get(repository.id) ?? []}
            />
          ))
        )}
      </div>
    </Card>
  );
}
