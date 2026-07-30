import { expect, test } from "./fixtures.js";

/**
 * Recovery audit trail scenarios (PR 56 — maintenance-elevation-recovery, PRD REC-*).
 *
 * `/recovery-audit` is a read-only view of `RecoveryService.ListRecoveryActions` — every
 * executed, rejected, or expired elevation action. The real daemon this harness boots has
 * no recovery actions recorded (nothing ever requests/executes an elevation grant in this
 * revision), so the empty state is exercised directly; the populated-list rendering is
 * exercised by route-mocking a schema-accurate `ListRecoveryActionsResponse` (produced by
 * protobuf-es's own `toJson`, not hand-typed), matching test/e2e/host-health.spec.ts's
 * technique for host kinds this harness can't otherwise reach.
 */
test.describe("recovery audit", () => {
  test("shows the empty state when no recovery actions have been recorded", async ({ page }) => {
    await page.goto("/recovery-audit");

    await expect(page.getByTestId("recovery-audit")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recovery audit" })).toBeVisible();
    await expect(page.getByText("No recovery actions recorded yet")).toBeVisible();
    await expect(page.getByTestId("recovery-audit-entry")).toHaveCount(0);
  });

  test("links back to maintenance", async ({ page }) => {
    await page.goto("/recovery-audit");

    await page.getByRole("link", { name: "← Maintenance" }).click();
    await expect(page).toHaveURL(/\/maintenance$/);
  });

  test("maintenance links forward to the recovery audit", async ({ page }) => {
    await page.goto("/maintenance");

    await page.getByRole("link", { name: "Recovery audit →" }).click();
    await expect(page).toHaveURL(/\/recovery-audit$/);
  });

  test("renders executed and rejected actions with their kind and state", async ({ page }) => {
    await page.route("**/minions.v1.RecoveryService/ListRecoveryActions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          actions: [
            {
              id: "01900000-0000-7000-8000-0000000000e1",
              kind: "RECOVERY_ACTION_KIND_RESTART",
              target: "node-42",
              expectedState: "in_progress",
              actorSessionId: "01900000-0000-7000-8000-0000000000e2",
              expiresAt: "2023-11-14T23:13:20Z",
              state: "RECOVERY_ACTION_STATE_EXECUTED",
              createdAt: "2023-11-14T22:13:20Z",
              executedAt: "2023-11-14T22:15:00Z",
            },
            {
              id: "01900000-0000-7000-8000-0000000000e3",
              kind: "RECOVERY_ACTION_KIND_QUARANTINE",
              target: "node-7",
              expectedState: "failed",
              actorSessionId: "01900000-0000-7000-8000-0000000000e4",
              expiresAt: "2023-11-14T23:13:20Z",
              state: "RECOVERY_ACTION_STATE_REJECTED",
              createdAt: "2023-11-14T22:16:40Z",
            },
          ],
        }),
      });
    });

    await page.goto("/recovery-audit");
    const entries = page.getByTestId("recovery-audit-entry");
    await expect(entries).toHaveCount(2);

    const restarted = entries.filter({ hasText: "node-42" });
    await expect(restarted.getByText("restart", { exact: true })).toBeVisible();
    await expect(restarted.getByText("executed", { exact: true })).toBeVisible();

    const quarantined = entries.filter({ hasText: "node-7" });
    await expect(quarantined.getByText("quarantine", { exact: true })).toBeVisible();
    await expect(quarantined.getByText("rejected", { exact: true })).toBeVisible();

    await expect(page.getByText("2 recorded actions")).toBeVisible();
  });
});
