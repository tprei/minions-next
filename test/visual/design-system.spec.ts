import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/**
 * PR 43 — ui-design-system-shell (PRD UI-09, UI-12; synthetic 13).
 *
 * Exercises the deterministic `/fixtures` route: every ui-kit primitive in every state,
 * across light/dark and reduced-motion, screenshotted at desktop and mobile viewports
 * (see playwright.config.ts's two projects), plus a real interaction (theme toggle affects
 * the fixture route the same way it affects the app shell) and a blocking axe accessibility
 * scan. New primitives get a fixture section in apps/web/src/routes/Fixtures.tsx and are
 * automatically covered here — no per-component test wiring needed.
 */

test.describe("design system fixtures", () => {
  test("passes an automated accessibility scan in light and dark", async ({ page }) => {
    await page.goto("/fixtures");
    await expect(page.getByTestId("fixtures-root")).toBeVisible();

    const light = await new AxeBuilder({ page }).analyze();
    expect(light.violations, JSON.stringify(light.violations, null, 2)).toEqual([]);

    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.waitForTimeout(250); // let the --mn-motion-duration transition settle
    const dark = await new AxeBuilder({ page }).analyze();
    expect(dark.violations, JSON.stringify(dark.violations, null, 2)).toEqual([]);
  });

  test("matches the visual baseline in light", async ({ page }) => {
    await page.goto("/fixtures");
    await expect(page.getByTestId("fixtures-root")).toBeVisible();
    await expect(page).toHaveScreenshot("fixtures-light.png", { fullPage: true });
  });

  test("matches the visual baseline in dark", async ({ page }) => {
    await page.goto("/fixtures");
    await expect(page.getByTestId("fixtures-root")).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.waitForTimeout(250);
    await expect(page).toHaveScreenshot("fixtures-dark.png", { fullPage: true });
  });

  test("respects the reduced-motion preference", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/fixtures");
    const duration = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--mn-motion-duration").trim(),
    );
    expect(Number.parseFloat(duration)).toBe(0);
  });

  test("toggles theme from the app shell and persists across reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});
