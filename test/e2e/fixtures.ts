import { test as base, expect } from "@playwright/test";
import { PREVIEW_BASE_URL } from "./constants.js";
import { createGitFixtureRepo, removeFixture, type GitFixtureRepo } from "./git-fixture.js";

// Mirrors the ambient `Window.__MINIONS_API_BASE_URL__` declaration in
// apps/web/src/data/api-client.ts. This file's `addInitScript` callback runs inside the
// browser, type-checked against test/e2e's own (separate) TypeScript program — which never
// includes apps/web's sources — so the global augmentation is declared again here rather
// than imported.
declare global {
  interface Window {
    __MINIONS_API_BASE_URL__?: string;
  }
}

interface Fixtures {
  readonly gitFixtureRepo: GitFixtureRepo;
}

/**
 * Test/expect extension for the real-daemon E2E suite (PR 45 — host-repository-task-ui).
 *
 * - `page`: every test's page gets `window.__MINIONS_API_BASE_URL__` set via
 *   `addInitScript` BEFORE any navigation (`addInitScript` always runs ahead of the page's
 *   own scripts, including on every subsequent reload) — see
 *   apps/web/src/data/api-client.ts's `createApiClients`. It points at the preview server's
 *   own fixed origin (see global-setup.ts/preview-server.ts): every `/minions.*` Connect RPC
 *   path is reverse-proxied to the real daemon from there, so this is same-origin from the
 *   browser's perspective even though the daemon runs as a separate process on its own port.
 * - `gitFixtureRepo`: a fresh, real, `RegisterRepository`-eligible temp Git repo (see
 *   test/e2e/git-fixture.ts), automatically removed after the test — request it by
 *   destructuring `{ gitFixtureRepo }` in a test that needs one.
 */
export const test = base.extend<Fixtures>({
  page: async ({ page }, use) => {
    await page.addInitScript((baseUrl: string) => {
      window.__MINIONS_API_BASE_URL__ = baseUrl;
    }, PREVIEW_BASE_URL);
    await use(page);
  },
  gitFixtureRepo: async ({}, use) => {
    const repo = await createGitFixtureRepo();
    try {
      await use(repo);
    } finally {
      await removeFixture(repo.directory);
    }
  },
});

export { expect };
