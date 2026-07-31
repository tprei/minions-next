import { useEffect, useState } from "react";
import { describeConnectError } from "./connect-error.js";

export interface DirectoryPage<TDetail> {
  readonly items: readonly TDetail[];
  readonly nextPageToken: string | undefined;
}

export interface DirectoryDetailState<TDetail> {
  readonly detail: ReadonlyMap<string, TDetail>;
  readonly error: string | undefined;
}

/**
 * Hydrates the rich, non-projected detail for a set of entities behind a paginated `List*`
 * RPC (PR 45 — host-repository-task-ui).
 *
 * `HostSummary`/`RepositorySummary` (the live, event-sourced projection types — see
 * apps/web/src/data/projection-types.ts) are deliberately minimal: they carry only identity,
 * `hostId`/`archived`/`online`, and a version counter, never the full `ExecutionHost`/
 * `RegisteredRepository` fields (kind, state, canonicalRoot, baseCommit, …). The health and
 * capability cards need those richer fields, so this hook fetches them once per distinct
 * `summaries` snapshot via `fetchPage` (small local fleets — a full un-paginated walk is
 * appropriate; see `ListHosts`/`ListRepositories` proto docs). `summaries` is a
 * `ReadonlyMap` from the projection store, which only produces a NEW map reference when an
 * entity is actually added, removed, or changed (see projection-reducer.ts's `withSet`/
 * `withDelete`) — so this effect re-fetches exactly when the live set changes, never on an
 * unrelated re-render.
 */
export function useDirectoryDetail<TSummary, TDetail extends { readonly id: string }>(
  summaries: ReadonlyMap<string, TSummary>,
  fetchPage: (pageToken: string | undefined) => Promise<DirectoryPage<TDetail>>,
): DirectoryDetailState<TDetail> {
  const [detail, setDetail] = useState<ReadonlyMap<string, TDetail>>(new Map());
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const collected = new Map<string, TDetail>();
        let pageToken: string | undefined;
        do {
          const page = await fetchPage(pageToken);
          for (const item of page.items) collected.set(item.id, item);
          pageToken = page.nextPageToken;
        } while (pageToken !== undefined);
        if (!controller.signal.aborted) {
          setDetail(collected);
          setError(undefined);
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(describeConnectError(caught).message);
        }
      }
    })();
    return () => {
      controller.abort();
    };
  }, [summaries, fetchPage]);

  return { detail, error };
}
