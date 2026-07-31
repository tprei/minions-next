import type { ReactNode } from "react";
import { StatusBadge, ThemeProvider, useTheme } from "@minions/ui-kit";
import { FixturesRoute } from "./routes/Fixtures.js";

/**
 * Application shell (PR 43 — ui-design-system-shell).
 *
 * This is intentionally minimal: the real host/repository/tree/node screens land in PR 45
 * onward, once the generated Connect transport and projection store exist (PR 44). PR 43
 * only proves the design-system shell renders, themes, and is installable — plus exposes the
 * deterministic `/fixtures` route the visual-regression synthetic drives.
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

function Home(): ReactNode {
  const { mode, resolved, setMode } = useTheme();
  return (
    <main className="mn-app-shell">
      <h1>Minions</h1>
      <p>Local-first command center for supervising coding agents.</p>
      <StatusBadge status="info" label={`theme: ${mode} (${resolved})`} />
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
