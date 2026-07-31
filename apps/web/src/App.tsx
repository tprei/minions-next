import type { ReactNode } from "react";
import { ThemeProvider } from "@minions/ui-kit";
import { FixturesRoute } from "./routes/Fixtures.js";
import { HomeRoute } from "./routes/Home.js";

/**
 * Application shell (PR 43 — ui-design-system-shell; PR 44 — browser-projection-store;
 * PR 45 — host-repository-task-ui).
 *
 * Routing stays deliberately simple — a single `window.location.pathname` check, no router
 * dependency — because there are exactly two routes: the deterministic `/fixtures` dev/visual-
 * regression route (PR 43, untouched by real data) and the real operator app at every other
 * path, now the host/repository home screen (PR 45; the tree/node screens land in PR 46/47).
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
  return <HomeRoute />;
}
