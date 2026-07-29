import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";

/**
 * Global attention inbox scenarios (PR 50 — attention-and-recovery-ux).
 */
test.describe("inbox", () => {
  test("shows the inbox page with empty state and inbox link from home", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    // The inbox link must be present on the home screen.
    await expect(page.getByTestId("inbox-link")).toBeVisible();
    await page.getByTestId("inbox-link").click();

    // The inbox page loads.
    await expect(page.getByTestId("inbox")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Attention inbox" })).toBeVisible();

    // With no open attention items, the empty state shows.
    await expect(page.getByText("No open attention")).toBeVisible();
  });

  test("filter buttons are present and switchable", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox")).toBeVisible();

    // All three filter buttons must be present (PRD UI-05: typed filters).
    await expect(page.getByRole("button", { name: /All/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Questions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approvals" })).toBeVisible();

    // Clicking Questions filter works.
    await page.getByRole("button", { name: "Questions" }).click();
    await expect(page.getByText("No open attention")).toBeVisible();
  });
});
