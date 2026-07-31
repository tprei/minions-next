import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";

/**
 * Focus and keyboard navigation tests (PR 51 — browser-e2e-visual-accessibility,
 * PRD UI-12: every interactive element reachable by keyboard alone).
 */
test.describe("keyboard navigation", () => {
  test("Tab reaches interactive elements from the home screen", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);
    await expect(page.getByTestId("home-root")).toBeVisible();

    // Tab from the top of the page — focus must land on interactive elements.
    const inboxLink = page.getByTestId("inbox-link");
    const newTaskButton = page.getByRole("button", { name: "New task" });

    // Tab through until the inbox link is focused.
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press("Tab");
      const isInboxFocused = await inboxLink.evaluate((el) => el === document.activeElement);
      const isButtonFocused = await newTaskButton.evaluate((el) => el === document.activeElement);
      if (isInboxFocused || isButtonFocused) return;
    }
    expect(true, "Tab did not reach inbox link or New task button within 20 presses").toBe(false);
  });

  test("Enter activates the New task button from the keyboard", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    await page.getByRole("button", { name: "New task" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "New task" })).toBeHidden();
  });
});
