/**
 * Fixed, statically-known port for the E2E preview+proxy server (PR 45 —
 * host-repository-task-ui). Distinct from playwright.config.ts's 4173 (`test:visual`) so the
 * two suites never collide if ever run concurrently. The real daemon binds to a dynamically
 * reserved loopback port instead — nothing outside test/e2e/global-setup.ts needs to know
 * that port ahead of time, since every RPC the browser issues is same-origin, reverse-proxied
 * by the preview server (see preview-server.ts) rather than fetched cross-origin.
 */
export const PREVIEW_HOST = "127.0.0.1";
export const PREVIEW_PORT = 4275;
export const PREVIEW_BASE_URL = `http://${PREVIEW_HOST}:${String(PREVIEW_PORT)}`;
