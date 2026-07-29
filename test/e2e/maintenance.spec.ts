import { MAINTENANCE_TOOLS } from "@minions/core";
import { expect, test } from "./fixtures.js";

/**
 * Maintenance console scenarios (PR 55 — maintenance-plane-readonly).
 *
 * `/maintenance` is a read-only view of `MAINTENANCE_TOOLS` (packages/core/src/
 * maintenance.ts) — it never invokes a tool, so this suite only exercises what's
 * actually reachable through this daemon revision: the registry rendering and the
 * connection-state indicator.
 */
test.describe("maintenance", () => {
  test("shows the maintenance-tool registry with a read-only badge per tool", async ({ page }) => {
    await page.goto("/maintenance");

    await expect(page.getByTestId("maintenance")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Maintenance" })).toBeVisible();

    const items = page.getByTestId("maintenance-tool");
    await expect(items).toHaveCount(MAINTENANCE_TOOLS.length);

    for (const tool of MAINTENANCE_TOOLS) {
      const item = items.filter({ hasText: tool.name });
      await expect(item).toBeVisible();
      await expect(item).toContainText(tool.description);
      await expect(
        item.getByText(tool.mutating ? "mutating" : "read-only", { exact: true }),
      ).toBeVisible();
    }
  });

  test("every registered tool is read-only in this daemon revision", async ({ page }) => {
    await page.goto("/maintenance");

    await expect(page.getByTestId("maintenance-tool-list")).toBeVisible();
    // Documents the current registry's invariant rather than assuming it — if a mutating
    // tool is ever added, this assertion (not the route) is what should change.
    expect(MAINTENANCE_TOOLS.every((tool) => !tool.mutating)).toBe(true);
    await expect(page.getByText("mutating", { exact: true })).toHaveCount(0);
    const readOnlyBadges = page.getByText("read-only", { exact: true });
    await expect(readOnlyBadges).toHaveCount(MAINTENANCE_TOOLS.length);
  });

  test("shows the daemon connection-state indicator", async ({ page }) => {
    await page.goto("/maintenance");

    const indicator = page.getByTestId("connection-state");
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText("daemon:");
  });

  test("links back to the home screen", async ({ page }) => {
    await page.goto("/maintenance");

    await page.getByRole("link", { name: "← Home" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});
