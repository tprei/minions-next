import type { ReactNode } from "react";
import { ThemeProvider } from "@minions/ui-kit";
import { FixturesRoute } from "./routes/Fixtures.js";
import { HomeRoute } from "./routes/Home.js";
import { InboxRoute } from "./routes/Inbox.js";
import { MaintenanceRoute } from "./routes/Maintenance.js";
import { NodeConsole } from "./routes/node/NodeConsole.js";
import { TreeRoute } from "./routes/tree/TreeRoute.js";

/**
 * Application shell (PR 43 — ui-design-system-shell; PR 44 — browser-projection-store;
 * PR 45 — host-repository-task-ui; PR 46 — plan-tree-editor-approval; PR 47 —
 * live-node-console-steering; PR 50 — attention-and-recovery-ux; PR 55 —
 * maintenance-plane-readonly).
 *
 * Routing stays deliberately simple — a `window.location.pathname` check, no router
 * dependency. Routes: the deterministic `/fixtures` dev/visual-regression route (PR 43,
 * untouched by real data), `/inbox` (PR 50's global attention inbox), `/maintenance`
 * (PR 55's read-only maintenance-tool registry view), `/tree/<treeId>/node/<nodeId>`
 * (PR 47's live node console — reached by selecting a node in the tree outline),
 * `/tree/<id>` (PR 46's plan editor/approval screen, reached from a "New task"
 * confirmation or a task link on the home screen), and the real operator app at every
 * other path (the host/repository home screen, PR 45).
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
  if (pathname === "/inbox") {
    return <InboxRoute />;
  }
  if (pathname === "/maintenance") {
    return <MaintenanceRoute />;
  }
  const nodeMatch = /^\/tree\/([^/]+)\/node\/([^/]+)$/.exec(pathname);
  if (nodeMatch?.[1] !== undefined && nodeMatch[2] !== undefined) {
    return (
      <NodeConsole
        treeId={decodeURIComponent(nodeMatch[1])}
        nodeId={decodeURIComponent(nodeMatch[2])}
      />
    );
  }
  const treeMatch = /^\/tree\/([^/]+)$/.exec(pathname);
  if (treeMatch?.[1] !== undefined) {
    return <TreeRoute treeId={decodeURIComponent(treeMatch[1])} />;
  }
  return <HomeRoute />;
}
