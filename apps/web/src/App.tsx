import type { ReactNode } from "react";
import { StatusBadge, ThemeProvider, useTheme, type StatusKind } from "@minions/ui-kit";
import { useEventClient } from "./data/use-event-client.js";
import { FixturesRoute } from "./routes/Fixtures.js";

/**
 * Application shell (PR 43 — ui-design-system-shell; PR 44 — browser-projection-store).
 *
 * This is intentionally minimal: the real host/repository/tree/node screens land in PR 45
 * onward. This PR only proves the design-system shell renders, themes, and is installable
 * (PR 43), plus that the generated Connect transport and projection store connect to a real
 * daemon and surface connection state honestly (PR 44, PRD UI-08) — it does not yet render
 * any host/tree data beyond a connection-state indicator and host count.
 */
export function App(): ReactNode {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function Shell(): ReactNode {
  if (typeof window !== "undefined" && window.location.pathname === "/fixtures") {
    return <FixturesRoute />;
  }
  return <Home />;
}

const connectionStatus: Record<string, StatusKind> = {
  connecting: "neutral",
  live: "success",
  reconnecting: "warning",
  offline: "danger",
};

function Home(): ReactNode {
  const { mode, resolved, setMode } = useTheme();
  const { projection, connectionState } = useEventClient();
  return (
    <main className="mn-app-shell">
      <h1>Minions</h1>
      <p>Local-first command center for supervising coding agents.</p>
      <StatusBadge status="info" label={`theme: ${mode} (${resolved})`} />
      <StatusBadge
        status={connectionStatus[connectionState] ?? "neutral"}
        label={`daemon: ${connectionState}`}
      />
      <StatusBadge status="neutral" label={`hosts: ${String(projection.hosts.size)}`} />
      <div role="group" aria-label="Theme">
        <button
          type="button"
          onClick={() => {
            setMode("light");
          }}
        >
          Light
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("dark");
          }}
        >
          Dark
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("system");
          }}
        >
          System
        </button>
      </div>
    </main>
  );
}
