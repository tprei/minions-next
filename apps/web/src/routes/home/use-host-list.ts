import { useEffect, useState } from "react";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { ListHostsRequestSchema, type ExecutionHost, type HostService } from "@minions/contracts";
import { describeConnectError } from "./connect-error.js";

export interface HostListState {
  readonly hosts: readonly ExecutionHost[];
  readonly loading: boolean;
  readonly error: string | undefined;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Loads the fleet's hosts via `HostService.ListHosts` (PR 45 — host-repository-task-ui).
 *
 * This is the host list's ONLY source — unlike repositories/trees, hosts have no
 * `AggregateKind` at all (proto/minions/v1/event.proto's enum is
 * `REPOSITORY | TREE | NODE | ATTEMPT`, no `HOST`) and never appear in
 * `EventService.GetSnapshot`/`WatchEvents` in this revision of the daemon (verified against
 * a real running daemon: a freshly booted local host registers into
 * `HostService.ListHosts` immediately but `GetSnapshot().hosts` stays permanently empty).
 * Cross-host fleet projection is future work (see the PRD's "macOS supervisor... cross-host
 * fleet projections" note) — for now this hook polls `ListHosts` on a fixed interval so a
 * host's displayed state doesn't go permanently stale for the life of the page, which is the
 * closest honest approximation of "live" available without a projected event stream to
 * follow (PRD UI-08).
 */
export function useHostList(hostClient: Client<typeof HostService>): HostListState {
  const [hosts, setHosts] = useState<readonly ExecutionHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchHosts(): Promise<void> {
      try {
        const collected: ExecutionHost[] = [];
        let pageToken: string | undefined;
        do {
          const response = await hostClient.listHosts(
            create(ListHostsRequestSchema, { pageSize: 100, pageToken }),
          );
          collected.push(...response.hosts);
          pageToken = response.nextPageToken;
        } while (pageToken !== undefined);
        if (!controller.signal.aborted) {
          setHosts(collected);
          setError(undefined);
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(describeConnectError(caught).message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void fetchHosts();
    const interval = setInterval(() => {
      void fetchHosts();
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [hostClient]);

  return { hosts, loading, error };
}
