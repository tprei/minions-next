import { devices, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";

/**
 * Automated accessibility scans (PR 51 — browser-e2e-visual-accessibility, PRD UI-09;
 * extended by PR 58 — mobile-pwa-push-offline for the tree/node "check/review" surfaces).
 *
 * Runs @axe-core/playwright against every route to catch WCAG violations automatically.
 * Every violation fails the test — accessibility is a blocking contract, not advisory.
 */
test.describe("accessibility", () => {
  test("home screen passes axe scan", async ({ page, gitFixtureRepo }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);
    await expect(page.getByTestId("home-root")).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("fixtures route passes axe scan", async ({ page }) => {
    await page.goto("/fixtures");
    await expect(page).toHaveTitle(/Minions/);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("inbox page passes axe scan", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox")).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("recovery audit route passes axe scan", async ({ page }) => {
    await page.goto("/recovery-audit");
    await expect(page.getByTestId("recovery-audit")).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  // PR 58 — mobile-pwa-push-offline. The tree/node "check/review" surfaces are scanned at
  // the same `devices["Pixel 7"]` viewport mobile-layout.spec.ts uses — accessibility MUST
  // hold at the narrow viewport these routes are read at just as much as desktop, and axe
  // itself flags viewport-dependent issues (e.g. touch-target/reflow-driven overlap) that a
  // desktop-viewport scan alone would miss. `defaultBrowserType` from `devices["Pixel 7"]` is
  // deliberately left out — Playwright forbids it in a per-describe `test.use` (it would
  // force a new worker) — this file already only runs under the `chromium` project, which is
  // what it would select anyway.
  test.describe("mobile viewport", () => {
    test.use({
      viewport: devices["Pixel 7"].viewport,
      userAgent: devices["Pixel 7"].userAgent,
      deviceScaleFactor: devices["Pixel 7"].deviceScaleFactor,
      isMobile: devices["Pixel 7"].isMobile,
      hasTouch: devices["Pixel 7"].hasTouch,
    });

    /**
     * Shared setup: registers a repo, creates a single-root tree via the "New task" dialog,
     * and navigates to its editor route. Mirrors tree-editor.spec.ts/node-console.spec.ts's
     * own local `openFreshTree` helper — each E2E spec file keeps its own copy, this suite's
     * established convention, rather than sharing one across files.
     */
    async function openFreshTree(page: Page, gitFixtureRoot: string, goal: string): Promise<void> {
      await page.goto("/");
      await registerRepositoryViaUi(page, gitFixtureRoot);
      await page.getByRole("button", { name: "New task" }).click();
      await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
      await page.locator("#new-task-host").selectOption({ index: 1 });
      await page.locator("#new-task-repository").selectOption({ label: gitFixtureRoot });
      await page.locator("#new-task-goal").fill(goal);
      await page.locator("#new-task-root-check-profile").fill("lint");
      await page.getByRole("button", { name: "Create task" }).click();
      await expect(page.getByText("Task created.")).toBeVisible();
      await page.getByRole("link", { name: "Open tree" }).click();
      await expect(page.getByTestId("tree-root")).toBeVisible();
    }

    test("tree editor route passes axe scan", async ({ page, gitFixtureRepo }) => {
      const goal = `a11y-tree-e2e-${Date.now().toString()}`;
      await openFreshTree(page, gitFixtureRepo.root, goal);

      const outlineResults = await new AxeBuilder({ page }).analyze();
      expect(outlineResults.violations).toEqual([]);

      // The working-node edit form (parent/objective/mode/criteria/paths/inputs) is the
      // densest content on this route — scan it too, not just the initial locked-root view.
      await page.getByTestId("tree-add-child").click();
      await expect(page.getByTestId("node-editor-panel")).toBeVisible();
      const editFormResults = await new AxeBuilder({ page }).analyze();
      expect(editFormResults.violations).toEqual([]);

      await page.getByRole("tab", { name: "Canvas" }).click();
      await expect(page.getByTestId("tree-canvas")).toBeVisible();
      const canvasResults = await new AxeBuilder({ page }).analyze();
      expect(canvasResults.violations).toEqual([]);
    });

    test("node console route passes axe scan", async ({ page, gitFixtureRepo }) => {
      const goal = `a11y-node-e2e-${Date.now().toString()}`;
      await openFreshTree(page, gitFixtureRepo.root, goal);
      await page.getByRole("link", { name: /Open node console/ }).click();
      await expect(page.getByTestId("node-console")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

      const consoleResults = await new AxeBuilder({ page }).analyze();
      expect(consoleResults.violations).toEqual([]);

      await page.getByRole("tab", { name: "Context" }).click();
      await expect(page.getByTestId("context-panel")).toBeVisible();
      const contextResults = await new AxeBuilder({ page }).analyze();
      expect(contextResults.violations).toEqual([]);
    });
  });
});
