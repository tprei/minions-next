import { registerRepositoryViaUi, tabUntilFocused } from "./actions.js";
import { expect, test } from "./fixtures.js";

/**
 * New-task (tree creation) form scenarios (PR 45 — host-repository-task-ui). Each test
 * registers its own fresh repository rather than depending on another spec file having done
 * so — Playwright discovers/orders spec files independently of authoring order, and this
 * harness's daemon is shared (one real process) across the whole run, so state accumulates.
 */
test.describe("new task", () => {
  test("blocks submission with client-side validation and never calls CreateTree", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    let createTreeCalled = false;
    await page.route("**/minions.v1.TreeService/CreateTree", async (route) => {
      createTreeCalled = true;
      await route.continue();
    });

    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog).toBeVisible();

    await page.locator("#new-task-host").selectOption({ index: 1 });
    await expect(
      page.locator("#new-task-repository option", { hasText: gitFixtureRepo.root }),
    ).toHaveCount(1);
    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRepo.root });
    // Goal left empty; max depth set to an out-of-range value — both must be rejected
    // client-side, before any request is sent.
    await page.locator("#new-task-max-depth").fill("0");
    await page.getByRole("button", { name: "Create task" }).click();

    await expect(page.getByText("Goal must not be empty.")).toBeVisible();
    await expect(page.getByText("Max depth must be between 1 and 4294967295.")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(createTreeCalled).toBe(false);
  });

  test("creates a tree using the keyboard only", async ({ page, gitFixtureRepo }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    await page.getByRole("button", { name: "New task" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog).toBeVisible();

    await tabUntilFocused(page, "new-task-host");
    await page.locator("#new-task-host").selectOption({ index: 1 });

    await tabUntilFocused(page, "new-task-repository");
    await expect(
      page.locator("#new-task-repository option", { hasText: gitFixtureRepo.root }),
    ).toHaveCount(1);
    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRepo.root });

    const goal = `keyboard-only task ${Date.now().toString()}`;
    await tabUntilFocused(page, "new-task-goal");
    await page.keyboard.type(goal);

    // Base commit and root allowed path are pre-filled (base commit from the selected
    // repository, root allowed path defaults to "."); tab through without changing them.
    await tabUntilFocused(page, "new-task-base-commit");
    await tabUntilFocused(page, "new-task-root-allowed-path");

    // Budget fields already carry sane defaults; tab through every one of them so the whole
    // form's tab order is exercised end to end, not just the fields that need typing.
    await tabUntilFocused(page, "new-task-max-depth");
    await tabUntilFocused(page, "new-task-max-fan-out");
    await tabUntilFocused(page, "new-task-max-nodes");
    await tabUntilFocused(page, "new-task-max-concurrency");
    await tabUntilFocused(page, "new-task-max-attempts-per-node");

    await tabUntilFocused(page, "new-task-submit");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Task created.")).toBeVisible();
    await expect(dialog.getByText(goal)).toBeVisible();
  });
});
