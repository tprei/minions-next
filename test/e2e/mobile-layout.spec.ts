import { devices, type Page } from "@playwright/test";
import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";

// PR 45 — host-repository-task-ui; extended by PR 58 — mobile-pwa-push-offline for the
// attention/tree/node/check-review surfaces. Reuses the same `devices["Pixel 7"]` preset
// playwright.config.ts's `mobile-chromium` project already uses for the visual-regression
// suite — a structural/interaction assertion, not a pixel screenshot (PR 51's job).
test.use({ ...devices["Pixel 7"] });

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflowsHorizontally = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflowsHorizontally).toBe(false);
}

/**
 * Shared setup: registers a repo, creates a single-root tree via the "New task" dialog, and
 * navigates to its editor route. Mirrors tree-editor.spec.ts/node-console.spec.ts's own local
 * `openFreshTree` helper — each E2E spec file keeps its own copy rather than sharing one, the
 * established convention in this suite (see those files).
 */
async function openFreshTree(page: Page, gitFixtureRoot: string, goal: string): Promise<void> {
  await page.goto("/");
  await registerRepositoryViaUi(page, gitFixtureRoot);
  await page.getByRole("button", { name: "New task" }).click();
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
  await page.locator("#new-task-host").selectOption({ index: 1 });
  await page.locator("#new-task-repository").selectOption({ label: gitFixtureRoot });
  await page.locator("#new-task-goal").fill(goal);
  await page.locator("#new-task-root-check-profile").fill("lint");
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByText("Task created.")).toBeVisible();
  await page.getByRole("link", { name: "Open tree" }).click();
  await expect(page.getByTestId("tree-root")).toBeVisible();
}

test.describe("mobile read layout", () => {
  test("hosts and repositories are legible and reachable with no horizontal scroll", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);

    await expectNoHorizontalOverflow(page);

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

  test("attention inbox is legible and reachable with no horizontal scroll", async ({
    page,
    gitFixtureRepo,
  }) => {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRepo.root);
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox")).toBeVisible();

    await expectNoHorizontalOverflow(page);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    // The typed attention filters (PRD UI-05) stay reachable, not clipped or pushed
    // off-screen, on a narrow viewport.
    for (const name of ["All (0)", "Questions", "Approvals"]) {
      const button = page.getByRole("button", { name });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      if (box !== null && viewport !== null) {
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    }

    await expect(page.getByRole("link", { name: "← Home" })).toBeVisible();
  });

  test("tree editor is legible and reachable with no horizontal scroll across every tab", async ({
    page,
    gitFixtureRepo,
  }) => {
    test.setTimeout(60_000);
    const goal = `mobile-tree-e2e-${Date.now().toString()}`;
    await openFreshTree(page, gitFixtureRepo.root, goal);
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    await expectNoHorizontalOverflow(page);

    // The plan-required attention banner (every fresh tree starts here) is fully legible and
    // reachable, not clipped by the narrow viewport.
    const banner = page.getByTestId("tree-attention-banner");
    await expect(banner).toBeVisible();
    const bannerBox = await banner.boundingBox();
    expect(bannerBox).not.toBeNull();
    if (bannerBox !== null && viewport !== null) {
      expect(bannerBox.x + bannerBox.width).toBeLessThanOrEqual(viewport.width);
    }

    // Every tab trigger is visible and reachable (the outline/canvas/diff/revisions switcher
    // never gets pushed off-screen).
    for (const tabName of ["Outline", "Canvas", "Diff", "Revisions"]) {
      const tab = page.getByRole("tab", { name: tabName });
      await expect(tab).toBeVisible();
      const box = await tab.boundingBox();
      expect(box).not.toBeNull();
      if (box !== null && viewport !== null) {
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    }

    // Outline tab: selecting the root and opening its edit form (the densest content on this
    // route — parent/objective/mode/criteria/paths/check-profile/output-contract/inputs)
    // never causes horizontal overflow, and its primary actions stay reachable.
    await page.getByTestId("tree-add-child").click();
    await expectNoHorizontalOverflow(page);
    const addChildButtons = page.getByTestId("tree-add-child");
    await expect(addChildButtons.first()).toBeVisible();

    // Canvas tab: the node-link diagram fits its container with no clipped nodes — a
    // regression guard for tree-layout.ts's viewBox bounds actually enclosing every rendered
    // node rect (previously the leftmost node's rect and label were clipped by ~56px because
    // the viewBox bounds were computed from a different constant than the rendered rect size).
    await page.getByRole("tab", { name: "Canvas" }).click();
    const canvas = page.getByTestId("tree-canvas");
    await expect(canvas).toBeVisible();
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    const nodeRects = page.getByTestId("tree-canvas-node");
    await expect(nodeRects.first()).toBeVisible();
    const nodeCount = await nodeRects.count();
    expect(nodeCount).toBeGreaterThan(0);
    for (let i = 0; i < nodeCount; i += 1) {
      const nodeBox = await nodeRects.nth(i).boundingBox();
      expect(nodeBox).not.toBeNull();
      if (nodeBox !== null && canvasBox !== null) {
        expect(nodeBox.x).toBeGreaterThanOrEqual(canvasBox.x - 1);
        expect(nodeBox.x + nodeBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1);
      }
    }
    await expectNoHorizontalOverflow(page);

    // Diff and Revisions tabs also stay overflow-free.
    await page.getByRole("tab", { name: "Diff" }).click();
    await expect(page.getByTestId("plan-diff-panel")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("tab", { name: "Revisions" }).click();
    await expect(page.getByTestId("revision-history")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Plan actions (save/approve/reject) stay reachable at the bottom of the screen.
    await expect(page.getByRole("button", { name: /Save plan|Repair plan/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve plan" })).toBeVisible();
  });

  test("node console is legible and reachable with no horizontal scroll", async ({
    page,
    gitFixtureRepo,
  }) => {
    test.setTimeout(60_000);
    const goal = `mobile-node-e2e-${Date.now().toString()}`;
    await openFreshTree(page, gitFixtureRepo.root, goal);
    await page.getByRole("link", { name: /Open node console/ }).click();
    await expect(page.getByTestId("node-console")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    await expectNoHorizontalOverflow(page);
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    // Every steering action in the composer's button row fits within the viewport width —
    // regardless of how many wrap onto their own line, none is ever wider than the screen or
    // pushed off it (PRD UI-04's full steering vocabulary stays reachable on mobile).
    const composer = page.getByTestId("composer");
    await expect(composer).toBeVisible();
    for (const name of [
      "Send",
      "Steer after tool",
      "Follow-up",
      "Interrupt",
      "Pause",
      "Resume",
      "Retry",
      "Cancel node",
      "Cancel subtree",
      "Replan",
    ]) {
      const button = page.getByRole("button", { name });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      if (box !== null && viewport !== null) {
        expect(box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    }

    // The command receipt timeline (PRD UI-10) fits the viewport and stays reachable once
    // populated.
    await page.locator("#composer-text").fill("mobile e2e steering message");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("message: mobile e2e steering message")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const timeline = page.locator(".mn-command-timeline");
    const timelineBox = await timeline.boundingBox();
    expect(timelineBox).not.toBeNull();
    if (timelineBox !== null && viewport !== null) {
      expect(timelineBox.width).toBeLessThanOrEqual(viewport.width);
    }

    // Context and Evidence tabs also stay overflow-free.
    await page.getByRole("tab", { name: "Context" }).click();
    await expect(page.getByTestId("context-panel")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("tab", { name: "Evidence" }).click();
    await expect(page.getByTestId("evidence-panel")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await expect(page.getByTestId("node-back-link")).toBeVisible();
  });
});
