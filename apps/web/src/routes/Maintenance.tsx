import type { ReactNode } from "react";
import { Fact, NavBar, StateView, StatusBadge } from "@minions/ui-kit";
import { useEventClient } from "../data/use-event-client.js";
import { WEB_MAINTENANCE_TOOLS } from "./maintenance-tools.js";
import "./Maintenance.css";

/**
 * Maintenance console (PR 55 — maintenance-plane-readonly).
 *
 * Read-only view of the maintenance plane's tool registry (`WEB_MAINTENANCE_TOOLS`, a
 * browser-safe mirror of `@minions/core`'s `MAINTENANCE_TOOLS` — see maintenance-tools.ts's
 * doc comment for why apps/web can't import that package directly). The maintenance plane
 * starts its own diagnostic session on a separate supervisor database and event stream from
 * the primary host.db — by design it stays reachable even when the primary host API,
 * scheduler, or projections are unhealthy — but this route does not invoke that session or
 * any tool; it only lists what the registry currently exposes so an operator can see, at a
 * glance, which tools exist and whether each is safe to run without confirmation
 * (`read-only`) or changes state (`mutating`) once invocation lands. Reached at
 * `/maintenance`.
 */
export function MaintenanceRoute(): ReactNode {
  const { connectionState } = useEventClient();

  return (
    <>
      <NavBar brand="Minions">
        <a className="mn-maintenance__back" href="/">
          ← Home
        </a>
        <StatusBadge
          status={connectionState === "live" ? "success" : "warning"}
          label={`daemon: ${connectionState}`}
          data-testid="connection-state"
        />
      </NavBar>

      <main className="mn-maintenance" data-testid="maintenance">
        <div className="mn-maintenance__header">
          <h1>Maintenance</h1>
          <Fact>{String(WEB_MAINTENANCE_TOOLS.length)} tools</Fact>
          <a className="mn-maintenance__audit-link" href="/recovery-audit">
            Recovery audit →
          </a>
        </div>

        {WEB_MAINTENANCE_TOOLS.length === 0 ? (
          <StateView
            kind="empty"
            title="No maintenance tools registered"
            description="The maintenance plane has no tools available."
          />
        ) : (
          <ul className="mn-maintenance__list" data-testid="maintenance-tool-list">
            {WEB_MAINTENANCE_TOOLS.map((tool) => (
              <li key={tool.name} className="mn-maintenance__item" data-testid="maintenance-tool">
                <StatusBadge
                  status={tool.mutating ? "danger" : "success"}
                  label={tool.mutating ? "mutating" : "read-only"}
                />
                <div className="mn-maintenance__item-body">
                  <p className="mn-maintenance__name">{tool.name}</p>
                  <Fact>{tool.description}</Fact>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
