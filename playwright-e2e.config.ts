import { defineConfig, devices } from "@playwright/test";
import { PREVIEW_BASE_URL } from "./test/e2e/constants.js";

// PR 45 — host-repository-task-ui. Drives the real host/repository/task UI against a real,
// in-process @minions/daemon (booted once by globalSetup — see test/e2e/global-setup.ts),
// never a mock or a scripted fixture server. Deliberately a SEPARATE config from the sibling
// playwright.config.ts (test:visual's deterministic, daemon-free `/fixtures` route) — that
// suite's fixture route must stay real-daemon-free, so the two configs, webServers, and
// global setups are never merged.
//
// `pnpm --filter @minions/web run build` MUST run before this (see `test:e2e` in
// package.json) — globalSetup serves the already-built apps/web/dist, never a dev server, so
// what's checked is what ships. `workers: 1` is deliberate: every test shares the one daemon
// this config boots, so tests run serially rather than racing each other against shared
// daemon/host state.
export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-e2e", open: "never" }]],
  use: {
    baseURL: PREVIEW_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
});
