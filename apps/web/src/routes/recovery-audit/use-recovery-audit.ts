import { useEffect, useState } from "react";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import {
  ListRecoveryActionsRequestSchema,
  type RecoveryAction,
  type RecoveryService,
} from "@minions/contracts";
import { describeConnectError } from "../home/connect-error.js";

export interface RecoveryAuditState {
  readonly actions: readonly RecoveryAction[];
  readonly loading: boolean;
  readonly error: string | undefined;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Loads the recovery elevation audit trail via `RecoveryService.ListRecoveryActions`
 * (PR 56 — maintenance-elevation-recovery, PRD REC-*). Every executed, rejected, or expired
 * recovery action is durable and immutable (see `packages/core/src/recovery-action.ts`'s
 * `createAuditEntry`) — this hook polls the full history on a fixed interval so an operator
 * watching this screen sees new grants/executions without a manual refresh, mirroring
 * `useHostList`'s polling rationale (no event-sourced projection for this aggregate).
 */
export function useRecoveryAudit(
  recoveryClient: Client<typeof RecoveryService>,
): RecoveryAuditState {
  const [actions, setActions] = useState<readonly RecoveryAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchActions(): Promise<void> {
      try {
        const collected: RecoveryAction[] = [];
        let pageToken: string | undefined;
        do {
          const response = await recoveryClient.listRecoveryActions(
            create(ListRecoveryActionsRequestSchema, { pageSize: 100, pageToken }),
          );
          collected.push(...response.actions);
          pageToken = response.nextPageToken;
        } while (pageToken !== undefined);
        if (!controller.signal.aborted) {
          setActions(collected);
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

    void fetchActions();
    const interval = setInterval(() => {
      void fetchActions();
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [recoveryClient]);

  return { actions, loading, error };
}
