import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";
import { createNonRepositoryFixture, removeFixture } from "./git-fixture.js";

/**
 * Repository registration scenarios (PR 45 — host-repository-task-ui). Both drive the real
 * `RegisterRepository` RPC end to end against a real daemon and a real filesystem path — no
 * mocked transport.
 */
test.describe("repository registration", () => {
  test("registers a safe repository and it appears under its host", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    await expect(
      page.getByTestId("repository-card").filter({ hasText: gitFixtureRepo.root }),
    ).toBeVisible();
  });

  test("surfaces the daemon's typed error for an unsafe (non-git) path, not a generic failure", async ({
    page,
  }) => {
    const nonRepo = await createNonRepositoryFixture();
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Register repository" }).click();
      await page.getByLabel("Repository path").fill(nonRepo.root);
      await page.getByRole("button", { name: "Register" }).click();

      // apps/daemon/src/repository-service.ts's toConnectError maps this exact failure
      // (packages/adapters/src/repository-inspector.ts's verifyRepositoryRoot) to
      // Code.FailedPrecondition with this exact message — asserting on both the code label
      // and the real server message, not a generic "something went wrong" string.
      const dialog = page.getByRole("dialog", { name: "Register repository" });
      const errorBanner = dialog.getByRole("alert");
      await expect(errorBanner).toContainText("FailedPrecondition");
      await expect(errorBanner).toContainText("Repository root has no .git directory");

      // Registration did not silently succeed: the dialog stays open and no card exists for
      // this path.
      await expect(dialog).toBeVisible();
      await expect(
        page.getByTestId("repository-card").filter({ hasText: nonRepo.root }),
      ).toHaveCount(0);
    } finally {
      await removeFixture(nonRepo.root);
    }
  });
});
