import { expect, test } from "./fixtures.js";

/**
 * Host health/capability card scenarios (PR 45 — host-repository-task-ui, PRD UI-01, UI-08).
 *
 * "Healthy host" is exercised directly: the daemon this harness boots always runs in mode
 * "local", which auto-registers exactly one `ExecutionHost` at startup (see
 * test/integration/daemon-runtime.test.ts) — the card must show it online with its real
 * kind/state, sourced from `HostService.ListHosts` (see apps/web/src/routes/home/
 * use-host-list.ts's doc comment: hosts have no `AggregateKind` and never appear in
 * `EventService.GetSnapshot`/`WatchEvents` in this daemon revision, verified against a real
 * running daemon).
 *
 * "Unavailable/incompatible host" is deliberately NOT simulated via a second daemon process
 * or a genuine API-version mismatch — this harness boots one real daemon from the same
 * source tree as the web build, so there is no reachable fixture for either without
 * fabricating a fake host record (which would defeat the point of testing against a real
 * daemon). What IS realistically simulable, and is exactly what the PR 45 spec's own wording
 * suggests ("asserting the empty/loading state before a host projects"): deterministically
 * holding the daemon's `ListHosts` response so the home screen's loading state — the state
 * an operator actually sees before any host has ever loaded — is observed rather than raced
 * against real timing.
 */
test.describe("host health", () => {
  test("shows the auto-registered local host as online with its real kind", async ({ page }) => {
    await page.goto("/");

    const hostCard = page.getByTestId("host-card").first();
    await expect(hostCard).toBeVisible();
    await expect(hostCard.getByText("online", { exact: true })).toBeVisible();
    await expect(hostCard.getByText("local", { exact: true })).toBeVisible();
  });

  test("shows a loading state before any host has loaded yet", async ({ page }) => {
    let releaseListHosts: () => void = () => {
      // replaced synchronously below before this can be observed as a no-op
    };
    const gate = new Promise<void>((resolve) => {
      releaseListHosts = resolve;
    });
    await page.route("**/minions.v1.HostService/ListHosts", async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto("/");
    await expect(page.getByText("Connecting to the daemon…")).toBeVisible();
    await expect(page.getByTestId("host-card")).toHaveCount(0);

    releaseListHosts();
    await expect(page.getByTestId("host-card").first()).toBeVisible();
  });
});
