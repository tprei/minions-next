import type { Page } from "@playwright/test";
import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";

/**
 * Live node console and steering scenarios (PR 47 — live-node-console-steering).
 *
 * Each test creates a fresh tree, navigates to the root node's console, and exercises the
 * steering composer + command receipt timeline.
 */
test.describe("node console", () => {
  async function openRootNodeConsole(page: Page, gitFixtureRoot: string): Promise<void> {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRoot);

    const goal = `console-e2e-${Date.now().toString()}`;
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRoot });
    await page.locator("#new-task-prompt").fill(goal);
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByText("Task created.")).toBeVisible();

    // Navigate to the tree editor, then to the root node's console.
    await page.getByRole("link", { name: "Open tree" }).click();
    await expect(page.getByTestId("tree-root")).toBeVisible();
    await page.getByRole("link", { name: /Open node console/ }).click();
    await expect(page.getByTestId("node-console")).toBeVisible();
    // Wait for the node to load from the event stream — the loading state has the same
    // testid but no h1 header. The header only renders once the projection store has the node.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
  }

  test("shows the node header, connection state, and empty timeline", async ({
    page,
    gitFixtureRepo,
  }) => {
    await openRootNodeConsole(page, gitFixtureRepo.root);

    // The connection state indicator must be visible (UI-08: never pretend cached state is live).
    await expect(page.getByTestId("connection-state")).toBeVisible();
    await expect(page.getByTestId("connection-state")).toContainText(/daemon:/);

    // The command timeline should start empty with the honest state line for a
    // planned root (no attempt has run; nothing is dispatchable yet).
    await expect(page.getByTestId("command-timeline")).toBeVisible();
    await expect(page.getByText("Node is planned")).toBeVisible();

    // The composer must be visible with all action buttons.
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Interrupt" })).toBeVisible();
  });

  test("queues a message steer and it appears in the receipt timeline", async ({
    page,
    gitFixtureRepo,
  }) => {
    await openRootNodeConsole(page, gitFixtureRepo.root);

    await page.locator("#composer-text").fill("Please focus on the auth module");
    await page.getByRole("button", { name: "Send" }).click();

    // The command should appear in the timeline within a few seconds (the daemon echoes it
    // back via the event stream — the projection store updates live).
    await expect(page.getByTestId("command-row")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("command-row").first()).toContainText("auth module");
    // The delivery state badge should be visible — at minimum "queued".
    await expect(page.getByTestId("command-row").first()).toContainText(
      /queued|sent|acknowledged|applied|failed/,
    );
  });

  test("queues multiple commands and they appear in ordinal order", async ({
    page,
    gitFixtureRepo,
  }) => {
    await openRootNodeConsole(page, gitFixtureRepo.root);

    // Queue three different commands.
    await page.locator("#composer-text").fill("First instruction");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("command-row")).toHaveCount(1, { timeout: 10_000 });

    await page.locator("#composer-text").fill("Second instruction");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("command-row")).toHaveCount(2, { timeout: 10_000 });

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByTestId("command-row")).toHaveCount(3, { timeout: 10_000 });

    // All three should be in the timeline.
    const rows = page.getByTestId("command-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("First instruction");
    await expect(rows.nth(1)).toContainText("Second instruction");
    await expect(rows.nth(2)).toContainText("pause");
  });

  test("back link returns to the tree editor", async ({ page, gitFixtureRepo }) => {
    await openRootNodeConsole(page, gitFixtureRepo.root);

    await page.getByTestId("node-back-link").click();
    await expect(page.getByTestId("tree-root")).toBeVisible();
  });
});
