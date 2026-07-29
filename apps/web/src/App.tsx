import type { ReactNode } from "react";
import { ThemeProvider } from "@minions/ui-kit";
import { FixturesRoute } from "./routes/Fixtures.js";
import { HomeRoute } from "./routes/Home.js";
import { TreeRoute } from "./routes/tree/TreeRoute.js";

/**
 * Application shell (PR 43 — ui-design-system-shell; PR 44 — browser-projection-store;
 * PR 45 — host-repository-task-ui; PR 46 — plan-tree-editor-approval).
 *
 * Routing stays deliberately simple — a `window.location.pathname` check, no router
 * dependency — because there are exactly three routes: the deterministic `/fixtures` dev/
 * visual-regression route (PR 43, untouched by real data), `/tree/<id>` (PR 46's plan
 * editor/approval screen, reached from a "New task" confirmation or a task link on the home
 * screen), and the real operator app at every other path (the host/repository home screen,
 * PR 45; the node console lands in PR 47).
 */
export function App(): ReactNode {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function Shell(): ReactNode {
  if (typeof window === "undefined") {
    return <HomeRoute />;
  }
  const { pathname } = window.location;
  if (pathname === "/fixtures") {
    return <FixturesRoute />;
  }
  const treeMatch = /^\/tree\/([^/]+)$/.exec(pathname);
  if (treeMatch?.[1] !== undefined) {
    return <TreeRoute treeId={decodeURIComponent(treeMatch[1])} />;
  }
  return <HomeRoute />;
}
