import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveLoopbackPort } from "@minions/adapters";
import { createStructuredLogger, defaultRuntimeOptions, startDaemonRuntime } from "@minions/daemon";
import { PREVIEW_HOST, PREVIEW_PORT } from "./constants.js";
import { startPreviewServer } from "./preview-server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const WEB_DIST_DIR = join(REPO_ROOT, "apps", "web", "dist");
const DAEMON_DISPLAY_NAME = "minions-e2e-host";

/**
 * Playwright global setup for the real-daemon E2E suite (PR 45 — host-repository-task-ui).
 *
 * Boots one real `@minions/daemon` runtime in-process (mode "local", so it auto-registers
 * exactly one local `ExecutionHost` — see test/integration/daemon-runtime.test.ts) on a
 * dynamically reserved loopback port, then serves the already-built `apps/web/dist` PWA from
 * a fixed, well-known port via a small same-origin static+reverse-proxy server
 * (preview-server.ts). The proxy exists because the daemon's plain `node:http` server sends
 * no CORS headers at all (see apps/daemon/src/server.ts) — a genuinely cross-origin browser
 * fetch from the preview server's origin to the daemon's own port would be blocked by the
 * browser before ever reaching the daemon. Routing same-origin sidesteps that without
 * touching daemon server code, while still exercising a real two-process, two-port topology.
 *
 * Returning a function makes Playwright treat it as global teardown (closes the preview
 * server, then the daemon, then removes its temp home directory) — see
 * node_modules/playwright/lib/runner/index.js's `createGlobalSetupTask`.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), "minions-e2e-daemon-"));
  const logDirectory = join(REPO_ROOT, "test-results", "e2e");
  await mkdir(logDirectory, { recursive: true });
  const logStream = createWriteStream(join(logDirectory, "daemon.log"), { flags: "a" });
  const logger = createStructuredLogger({ stream: logStream, now: () => Date.now() });

  const daemonPort = await reserveLoopbackPort("127.0.0.1");
  const runtime = await startDaemonRuntime({
    ...defaultRuntimeOptions({
      home,
      mode: "local",
      port: daemonPort,
      serverVersion: "1.0.0",
      logger,
    }),
    displayName: DAEMON_DISPLAY_NAME,
  });

  const preview = await startPreviewServer({
    distDir: WEB_DIST_DIR,
    port: PREVIEW_PORT,
    host: PREVIEW_HOST,
    daemonBaseUrl: runtime.server.baseUrl,
  });

  return async () => {
    await preview.close();
    await runtime.close();
    await new Promise<void>((resolve) => {
      logStream.end(() => {
        resolve();
      });
    });
    await rm(home, { recursive: true, force: true });
  };
}
