import { useCallback, useMemo, type ReactNode } from "react";
import { create } from "@bufbuild/protobuf";
import {
  ListRepositoriesRequestSchema,
  type RepositorySummary,
  type TreeSummary,
} from "@minions/contracts";
import { Button, NavBar, StateView, StatusBadge, useTheme, type StatusKind } from "@minions/ui-kit";
import { createApiClients, type ApiClients, type ConnectionState } from "../data/index.js";
import { useEventClient } from "../data/use-event-client.js";
import { HostCard } from "./home/HostCard.js";
import { NewTaskDialog } from "./home/NewTaskDialog.js";
import { RegisterRepositoryDialog } from "./home/RegisterRepositoryDialog.js";
import { useDirectoryDetail } from "./home/use-directory-detail.js";
import { useHostList } from "./home/use-host-list.js";
import "./Home.css";

const CONNECTION_STATUS: Record<ConnectionState, StatusKind> = {
  connecting: "neutral",
  live: "success",
  reconnecting: "warning",
  offline: "danger",
};

/**
 * Host/repository home screen (PR 45 — host-repository-task-ui, PRD UI-01 "Host and
 * repository home" — the fleet-overview half; the node console is PR 47). Every host from
 * `HostService.ListHosts` (see useHostList) gets a health/capability card; every repository
 * registered under it (from the live projection, `projection.repositories`) gets a nested
 * capability card with its own task list. "Register repository" and "New task" are the two
 * command entry points — both mint their own ids in the browser and never assume a
 * path/status/transition the daemon hasn't confirmed.
 *
 * Hosts and repositories deliberately use DIFFERENT read paths. Repositories and trees are
 * real `AggregateKind`s (proto/minions/v1/event.proto) that flow through the standard
 * command → event → projection pipeline, so `projection.repositories`/`projection.trees` are
 * live and authoritative; `RepositoryService.ListRepositories` only hydrates the richer,
 * slower-changing fields (`canonicalRoot`, `baseCommit`, …) the event-sourced summary omits
 * (see useDirectoryDetail). Hosts have NO `AggregateKind` at all and never appear in
 * `EventService.GetSnapshot`/`WatchEvents` in this daemon revision — verified against a real
 * daemon, not assumed — so `useHostList` polls `HostService.ListHosts` directly as the host
 * list's only source (see that hook's doc comment).
 *
 * Deliberately out of scope for this PR (documented, not silently dropped): per-tree/node
 * "attention" counts and Codex broker/quota status from the PRD's screen sketch belong to
 * PR 47 (live node console/steering) and the auth-broker surface respectively — neither has
 * a proto/RPC contract exposed to this PR's four services (Event/Host/Repository/Tree).
 */
export function HomeRoute(): ReactNode {
  const { projection, connectionState } = useEventClient();
  const clients = useMemo<ApiClients>(() => createApiClients(), []);

  const { hosts, loading: hostsLoading } = useHostList(clients.host);

  const fetchRepositoriesPage = useCallback(
    async (pageToken: string | undefined) => {
      const response = await clients.repository.listRepositories(
        create(ListRepositoriesRequestSchema, { pageSize: 100, pageToken }),
      );
      return { items: response.repositories, nextPageToken: response.nextPageToken };
    },
    [clients.repository],
  );
  const { detail: repositoryDetail } = useDirectoryDetail(
    projection.repositories,
    fetchRepositoriesPage,
  );

  const repositoriesByHost = useMemo(() => {
    const grouped = new Map<string, RepositorySummary[]>();
    for (const repository of projection.repositories.values()) {
      const bucket = grouped.get(repository.hostId);
      if (bucket === undefined) {
        grouped.set(repository.hostId, [repository]);
      } else {
        bucket.push(repository);
      }
    }
    return grouped;
  }, [projection.repositories]);

  const treesByRepository = useMemo(() => {
    const grouped = new Map<string, TreeSummary[]>();
    for (const tree of projection.trees.values()) {
      const bucket = grouped.get(tree.repositoryId);
      if (bucket === undefined) {
        grouped.set(tree.repositoryId, [tree]);
      } else {
        bucket.push(tree);
      }
    }
    return grouped;
  }, [projection.trees]);

  function homeBody(): ReactNode {
    if (hosts.length === 0) {
      return hostsLoading ? (
        <StateView kind="loading" title="Connecting to the daemon…" description="Loading hosts." />
      ) : (
        <StateView
          kind="empty"
          title="No hosts registered"
          description="No execution host has registered with this daemon yet."
        />
      );
    }
    return (
      <div className="mn-home__hosts">
        {hosts.map((host) => (
          <HostCard
            key={host.id}
            host={host}
            repositories={repositoriesByHost.get(host.id) ?? []}
            repositoryDetail={repositoryDetail}
            treesByRepository={treesByRepository}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mn-home" data-testid="home-root">
      <NavBar brand="Minions">
        <a className="mn-home__inbox-link" href="/inbox" data-testid="inbox-link">
          Inbox
        </a>
        <a
          className="mn-home__push-notifications-link"
          href="/push-notifications"
          data-testid="push-notifications-link"
        >
          Push notifications
        </a>
        <StatusBadge
          status={CONNECTION_STATUS[connectionState]}
          label={`daemon: ${connectionState}`}
        />
        <ThemeToggle />
      </NavBar>
      <div className="mn-home__toolbar">
        <RegisterRepositoryDialog client={clients.repository} />
        <NewTaskDialog
          hosts={hosts}
          repositories={[...projection.repositories.values()]}
          repositoryDetail={repositoryDetail}
          treeClient={clients.tree}
        />
      </div>
      <main className="mn-home__content">
        <h1 className="mn-visually-hidden">Minions command center</h1>
        {connectionState === "offline" ? (
          <StateView
            kind="offline"
            title="Daemon unavailable"
            description="Reconnecting… repositories and tasks shown below may be stale."
          />
        ) : null}
        {homeBody()}
      </main>
    </div>
  );
}

function ThemeToggle(): ReactNode {
  const { mode, resolved, setMode } = useTheme();
  return (
    <div role="group" aria-label="Theme" className="mn-theme-toggle">
      <StatusBadge status="neutral" label={`theme: ${mode} (${resolved})`} />
      <Button
        variant={mode === "light" ? "primary" : "secondary"}
        size="sm"
        onClick={() => {
          setMode("light");
        }}
      >
        Light
      </Button>
      <Button
        variant={mode === "dark" ? "primary" : "secondary"}
        size="sm"
        onClick={() => {
          setMode("dark");
        }}
      >
        Dark
      </Button>
      <Button
        variant={mode === "system" ? "primary" : "secondary"}
        size="sm"
        onClick={() => {
          setMode("system");
        }}
      >
        System
      </Button>
    </div>
  );
}
