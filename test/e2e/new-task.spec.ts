import { registerRepositoryViaUi, tabUntilFocused } from "./actions.js";
import { expect, test } from "./fixtures.js";

test.describe("new task", () => {
  test("creates a templated tree (EXPLAIN) via default path and verifies auto-approval", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    let createTemplatedTreeCalled = false;
    await page.route("**/minions.v1.TreeService/CreateTemplatedTree", async (route) => {
      createTemplatedTreeCalled = true;
      await route.continue();
    });

    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog).toBeVisible();

    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRepo.root });

    const prompt = `explain-task-${Date.now().toString()}`;
    await page.locator("#new-task-prompt").fill(prompt);
    await page.getByRole("button", { name: "Create task" }).click();

    await expect(page.getByText("Task created.")).toBeVisible();
    await expect(dialog.getByText(prompt)).toBeVisible();
    await expect(dialog.getByText("approved", { exact: true })).toBeVisible();
    expect(createTemplatedTreeCalled).toBe(true);
  });

  test("blocks submission on template path with client-side validation and never calls CreateTemplatedTree", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    let createTemplatedTreeCalled = false;
    await page.route("**/minions.v1.TreeService/CreateTemplatedTree", async (route) => {
      createTemplatedTreeCalled = true;
      await route.continue();
    });

    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog).toBeVisible();

    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRepo.root });
    await page.getByRole("button", { name: "Create task" }).click();

    await expect(page.getByText("Prompt must not be empty.")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(createTemplatedTreeCalled).toBe(false);
  });

  test("creates a templated tree using the keyboard only", async ({ page, gitFixtureRepo }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    await page.getByRole("button", { name: "New task" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog).toBeVisible();

    await tabUntilFocused(page, "new-task-template");
    await tabUntilFocused(page, "new-task-prompt");
    const prompt = `keyboard-template-task-${Date.now().toString()}`;
    await page.keyboard.type(prompt);

    await tabUntilFocused(page, "new-task-repository");
    await expect(
      page.locator("#new-task-repository option", { hasText: gitFixtureRepo.root }),
    ).toHaveCount(1);
    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRepo.root });

    await tabUntilFocused(page, "new-task-submit");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Task created.")).toBeVisible();
    await expect(dialog.getByText(prompt)).toBeVisible();
    await expect(dialog.getByText("approved", { exact: true })).toBeVisible();
  });

  test("creates a tree via advanced path using CreateTree", async ({ page, gitFixtureRepo }) => {
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

    await page.getByText("Advanced options (custom tree & budgets)").click();

    await page.locator("#new-task-host").selectOption({ index: 1 });
    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRepo.root });
    const goal = `advanced-tree-${Date.now().toString()}`;
    await page.locator("#new-task-goal").fill(goal);

    await page.getByRole("button", { name: "Create task" }).click();

    await expect(page.getByText("Task created.")).toBeVisible();
    await expect(dialog.getByText(goal)).toBeVisible();
    expect(createTreeCalled).toBe(true);
  });

  test("blocks submission in advanced mode when goal or budget is invalid", async ({
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

    await page.getByText("Advanced options (custom tree & budgets)").click();

    await page.locator("#new-task-host").selectOption({ index: 1 });
    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRepo.root });
    await page.locator("#new-task-max-depth").fill("0");
    await page.getByRole("button", { name: "Create task" }).click();

    await expect(page.getByText("Goal must not be empty.")).toBeVisible();
    await expect(page.getByText("Max depth must be between 1 and 4294967295.")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(createTreeCalled).toBe(false);
  });
});
