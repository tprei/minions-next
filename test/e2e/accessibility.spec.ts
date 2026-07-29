import { AxeBuilder } from "@axe-core/playwright";
import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";

/**
 * Automated accessibility scans (PR 51 — browser-e2e-visual-accessibility, PRD UI-09).
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
});
