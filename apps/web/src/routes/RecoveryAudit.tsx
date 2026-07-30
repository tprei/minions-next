import { type ReactNode, useMemo } from "react";
import { createApiClients, type ApiClients } from "../data/index.js";
import { Fact, NavBar, StateView, StatusBadge } from "@minions/ui-kit";
import { formatTimestamp } from "./home/format.js";
import {
  recoveryActionKindLabel,
  recoveryActionStateBadgeKind,
  recoveryActionStateLabel,
} from "./recovery-audit/labels.js";
import { useRecoveryAudit } from "./recovery-audit/use-recovery-audit.js";
import "./RecoveryAudit.css";

/**
 * Recovery elevation audit trail (PR 56 — maintenance-elevation-recovery, PRD REC-*).
 *
 * Read-only view of every recorded `RecoveryAction` — an immutable, append-only audit
 * entry (`packages/core/src/recovery-action.ts`'s `createAuditEntry`) capturing which
 * per-action elevation grant authorized what target/kind, who executed it
 * (`actorSessionId`), and the terminal outcome (executed/failed/rejected/expired). This
 * route only lists history; it never requests, approves, or executes a recovery action —
 * that remains a deliberate, out-of-band human/operator decision per the bounded elevation
 * model. Reached at `/recovery-audit`.
 */
export function RecoveryAuditRoute(): ReactNode {
  const clients = useMemo<ApiClients>(() => createApiClients(), []);
  const { actions, loading, error } = useRecoveryAudit(clients.recovery);

  return (
    <>
      <NavBar brand="Minions">
        <a className="mn-recovery-audit__back" href="/maintenance">
          ← Maintenance
        </a>
      </NavBar>

      <main className="mn-recovery-audit" data-testid="recovery-audit">
        <div className="mn-recovery-audit__header">
          <h1>Recovery audit</h1>
          <Fact>{String(actions.length)} recorded actions</Fact>
        </div>

        {error !== undefined ? (
          <StateView kind="error" title="Failed to load recovery actions" description={error} />
        ) : loading ? (
          <p className="mn-muted">Loading…</p>
        ) : actions.length === 0 ? (
          <StateView
            kind="empty"
            title="No recovery actions recorded yet"
            description="Executed, rejected, and expired elevation actions appear here as they happen."
          />
        ) : (
          <ul className="mn-recovery-audit__list" data-testid="recovery-audit-list">
            {actions.map((action) => (
              <li
                key={action.id}
                className="mn-recovery-audit__item"
                data-testid="recovery-audit-entry"
              >
                <StatusBadge
                  status={recoveryActionStateBadgeKind(action.state)}
                  label={recoveryActionStateLabel(action.state)}
                />
                <div className="mn-recovery-audit__item-body">
                  <p className="mn-recovery-audit__target">{action.target}</p>
                  <Fact>{recoveryActionKindLabel(action.kind)}</Fact>
                  <Fact>expected: {action.expectedState}</Fact>
                  <Fact>created {formatTimestamp(action.createdAt)}</Fact>
                  {action.executedAt !== undefined ? (
                    <Fact>executed {formatTimestamp(action.executedAt)}</Fact>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
