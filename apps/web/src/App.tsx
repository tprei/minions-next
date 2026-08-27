import type { ReactNode } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { ThemeProvider } from "@minions/ui-kit";
import { EventClientProvider } from "./data/index.js";
import { FixturesRoute } from "./routes/Fixtures.js";
import { HomeRoute } from "./routes/Home.js";
import { InboxRoute } from "./routes/Inbox.js";
import { MaintenanceRoute } from "./routes/Maintenance.js";
import { NodeConsole } from "./routes/node/NodeConsole.js";
import { PushNotificationsRoute } from "./routes/PushNotifications.js";
import { RecoveryAuditRoute } from "./routes/RecoveryAudit.js";
import { TreeRoute } from "./routes/tree/TreeRoute.js";
/**
 * Application shell (PR 43 — ui-design-system-shell; PR 44 — browser-projection-store;
 * PR 45 — host-repository-task-ui; PR 46 — plan-tree-editor-approval; PR 47 —
 * live-node-console-steering; PR 50 — attention-and-recovery-ux; PR 55 —
 * maintenance-plane-readonly; PR 58 — mobile-pwa-push-offline).
 *
 * Routing stays deliberately simple — a `window.location.pathname` check, no router
 * dependency. Routes: the deterministic `/fixtures` dev/visual-regression route (PR 43,
 * untouched by real data), `/inbox` (PR 50's global attention inbox), `/maintenance`
 * (PR 55's read-only maintenance-tool registry view), `/push-notifications` (PR 58's Web
 * Push subscribe/unsubscribe panel), `/tree/<treeId>/node/<nodeId>` (PR 47's live node
 * console — reached by selecting a node in the tree outline), `/tree/<id>` (PR 46's plan
 * editor/approval screen, reached from a "New task" confirmation or a task link on the
 * home screen), and the real operator app at every other path (the host/repository home
 * screen, PR 45).
 */
export function App(): ReactNode {
  return (
    <ThemeProvider>
      <EventClientProvider>
        <Shell />
      </EventClientProvider>
    </ThemeProvider>
  );
}

const router = createBrowserRouter([
  { path: "/", element: <HomeRoute /> },
  { path: "/fixtures", element: <FixturesRoute /> },
  { path: "/inbox", element: <InboxRoute /> },
  { path: "/maintenance", element: <MaintenanceRoute /> },
  { path: "/push-notifications", element: <PushNotificationsRoute /> },
  { path: "/recovery-audit", element: <RecoveryAuditRoute /> },
  { path: "/tree/:treeId", element: <TreeRoute /> },
  { path: "/tree/:treeId/node/:nodeId", element: <NodeConsole /> },
  { path: "*", element: <HomeRoute /> },
]);

function Shell(): ReactNode {
  return <RouterProvider router={router} />;
}
