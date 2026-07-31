import { devices } from "@playwright/test";
import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";

// PR 45 — host-repository-task-ui. Reuses the same `devices["Pixel 7"]` preset
// playwright.config.ts's `mobile-chromium` project already uses for the visual-regression
// suite — a structural/interaction assertion, not a pixel screenshot (PR 51's job).
test.use({ ...devices["Pixel 7"] });

test.describe("mobile read layout", () => {
  test("hosts and repositories are legible and reachable with no horizontal scroll", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    const overflowsHorizontally = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflowsHorizontally).toBe(false);

    const hostCard = page.getByTestId("host-card").first();
    await expect(hostCard).toBeVisible();
    const hostCardBox = await hostCard.boundingBox();
    const viewport = page.viewportSize();
    expect(hostCardBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (hostCardBox !== null && viewport !== null) {
      expect(hostCardBox.width).toBeLessThanOrEqual(viewport.width);
    }

    // The repository just registered is legible without horizontal scrolling — its full
    // canonical path wraps rather than clipping or overflowing (see Home.css's
    // `.mn-repository-card__path`).
    await expect(
      page.getByTestId("repository-card").filter({ hasText: gitFixtureRepo.root }),
    ).toBeVisible();

    // Primary actions stay reachable — not hidden behind a desktop-only affordance.
    await expect(page.getByRole("button", { name: "Register repository" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  });
});
