import { defineConfig, devices } from "@playwright/test";

// PR 43 — ui-design-system-shell (PRD UI-12, synthetic 13). Drives the deterministic
// `/fixtures` route (apps/web/src/routes/Fixtures.tsx) through Playwright for interaction,
// accessibility (@axe-core/playwright), and visual-regression checks at desktop and mobile
// viewports. `pnpm --filter @minions/web run build` MUST run before this (see `test:visual`
// in package.json); the config serves the built static output, never the dev server, so
// what's checked is what ships.
export default defineConfig({
  testDir: "test/visual",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  webServer: {
    command: "node_modules/.bin/vite preview --host 127.0.0.1 --port 4173 --strict-port",
    cwd: "apps/web",
    port: 4173,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
