import type { Page } from "@playwright/test";
import { registerRepositoryViaUi } from "./actions.js";
import { expect, test } from "./fixtures.js";

/**
 * Plan tree editor/approval scenarios (PR 46 — plan-tree-editor-approval).
 *
 * Each test creates its own fresh tree via the "New task" dialog (PR 45) so there is no
 * cross-test coupling — the daemon is shared, but each tree is independent. After creation
 * the test clicks the "Open tree" confirmation link to reach `/tree/<id>` (PR 46's route).
 */
test.describe("tree editor", () => {
  /**
   * Shared helper: registers a repo, creates a single-root tree, and navigates to its
   * editor route. Returns the goal string so individual tests can locate their tree.
   */
  async function openFreshTree(page: Page, gitFixtureRoot: string): Promise<string> {
    await page.goto("/");
    await registerRepositoryViaUi(page, gitFixtureRoot);

    const goal = `editor-e2e-${Date.now().toString()}`;
    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog).toBeVisible();

    await page.getByText("Advanced options (custom tree & budgets)").click();
    await page.locator("#new-task-host").selectOption({ index: 1 });
    await page.locator("#new-task-repository").selectOption({ label: gitFixtureRoot });
    await page.locator("#new-task-goal").fill(goal);
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByText("Task created.")).toBeVisible();

    await page.getByRole("link", { name: "Open tree" }).click();
    await expect(page.getByTestId("tree-root")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: goal })).toBeVisible();
    return goal;
  }

  /**
   * Fills the minimum fields required for validateWorkingTree to accept a newly-added
   * working node (objective, mode, acceptance criteria).
   */
  async function fillRequiredNodeFields(page: Page): Promise<void> {
    await page.locator("#tree-node-objective").fill("Implement the feature end to end");
    await page.locator("#tree-node-mode").selectOption({ label: "implementation" });
    await page.getByRole("button", { name: "Add acceptance criteria" }).click();
    await page.locator("#tree-node-acceptance-criteria-0").fill("All tests pass");
  }

  test("adds a child node, edits it, and saves the plan", async ({ page, gitFixtureRepo }) => {
    await openFreshTree(page, gitFixtureRepo.root);

    // The root is locked (created by CreateTree) — the editor shows read-only details plus
    // an "Add child" button.
    await expect(page.getByTestId("node-editor-panel")).toBeVisible();
    await page.getByTestId("tree-add-child").click();

    // After adding, the new child is auto-selected and the editor switches to edit mode.
    await expect(page.getByRole("heading", { level: 2, name: "Edit node" })).toBeVisible();
    await fillRequiredNodeFields(page);

    // Save the plan — this calls ProposePlan with the full node array.
    await page.getByRole("button", { name: "Save plan" }).click();
    // After saving, the working tree is re-seeded from the server's response, so there are
    // no pending changes — "Reject changes" becomes disabled (it's only enabled when
    // pendingChanges is true). This is the reliable post-save signal: the Save button itself
    // is only disabled during the in-flight request, not after.
    await expect(page.getByRole("button", { name: "Reject changes" })).toBeDisabled({
      timeout: 10_000,
    });

    // The outline shows both the root and the saved child.
    const rows = page.getByTestId("tree-outline-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Implement the feature end to end" })).toHaveCount(1);
  });

  test("adds a research child, couples output contract to mode, and saves the plan", async ({
    page,
    gitFixtureRepo,
  }) => {
    await openFreshTree(page, gitFixtureRepo.root);

    await page.getByTestId("tree-add-child").click();
    await expect(page.getByRole("heading", { level: 2, name: "Edit node" })).toBeVisible();

    await page.locator("#tree-node-objective").fill("Investigate repository structure");
    await page.locator("#tree-node-mode").selectOption({ label: "research" });

    await expect(page.locator("#tree-node-output-kind")).toHaveValue("artifact");
    await expect(page.locator("#tree-node-artifact-type")).toHaveValue("research");

    await page.getByRole("button", { name: "Add acceptance criteria" }).click();
    await page.locator("#tree-node-acceptance-criteria-0").fill("Architecture is documented");

    await page.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByRole("button", { name: "Reject changes" })).toBeDisabled({
      timeout: 10_000,
    });

    const rows = page.getByTestId("tree-outline-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Investigate repository structure" })).toHaveCount(1);
  });

  test("approves a draft plan", async ({ page, gitFixtureRepo }) => {
    await openFreshTree(page, gitFixtureRepo.root);

    // Add a child and fill its required fields so validation passes.
    await page.getByTestId("tree-add-child").click();
    await fillRequiredNodeFields(page);
    await page.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByRole("button", { name: "Approve plan" })).toBeEnabled({
      timeout: 10_000,
    });

    // Approve — this transitions the active revision from DRAFT to APPROVED.
    await page.getByRole("button", { name: "Approve plan" }).click();
    // After approval, the Approve button must be disabled (revision is no longer DRAFT).
    await expect(page.getByRole("button", { name: "Approve plan" })).toBeDisabled({
      timeout: 10_000,
    });
  });

  test("prevents removing or reparenting the locked root node", async ({
    page,
    gitFixtureRepo,
  }) => {
    await openFreshTree(page, gitFixtureRepo.root);

    // The root is locked — the editor must NOT offer a "Remove node" button or a parent
    // select. Only "Add child" is available.
    await expect(page.getByText(/root node.*definition is fixed/)).toBeVisible();
    await expect(page.getByTestId("tree-remove-node")).toHaveCount(0);
    await expect(page.locator("#tree-node-parent")).toHaveCount(0);
    await expect(page.getByTestId("tree-add-child")).toBeVisible();
  });

  test("parent dropdown offers only valid ancestors — no fan-in path exists", async ({
    page,
    gitFixtureRepo,
  }) => {
    await openFreshTree(page, gitFixtureRepo.root);

    // Add child A to the root.
    await page.getByTestId("tree-add-child").click();
    await page.locator("#tree-node-objective").fill("Child A");

    // Add child B as a descendant of child A.
    await page.getByTestId("tree-add-child").click();
    await page.locator("#tree-node-objective").fill("Child B");

    // Select child B in the outline via keyboard navigation.
    const outline = page.getByTestId("tree-outline");
    await outline.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown"); // → Child A
    await page.keyboard.press("ArrowDown"); // → Child B
    await expect(
      page.locator('[data-testid="tree-outline-row"][data-selected="true"]'),
    ).toContainText("Child B");

    // Child B's parent dropdown must list ONLY its current parent (Child A) and the root —
    // never Child B itself or any descendant (that would create a cycle or fan-in).
    const parentSelect = page.locator("#tree-node-parent");
    const options = await parentSelect.locator("option").allTextContents();
    expect(options).toContain("Child A");
    // Root + Child A = 2 options maximum. No siblings or descendants can ever appear.
    expect(options.length).toBeLessThanOrEqual(2);
  });

  test("keyboard navigation traverses all nodes in a virtualized outline", async ({
    page,
    gitFixtureRepo,
  }) => {
    await openFreshTree(page, gitFixtureRepo.root);

    // Add enough children to the root to exceed the outline's viewport (~12 rows at 40px in
    // a 480px container) so virtualization windowing is exercised.
    const CHILD_COUNT = 20;
    for (let i = 0; i < CHILD_COUNT; i += 1) {
      // Re-select the root (adding a child auto-selects the new child).
      const rootRow = page.getByTestId("tree-outline-row").first();
      await rootRow.click();
      await page.getByTestId("tree-add-child").click();
      await page.locator("#tree-node-objective").fill(`Sibling ${String(i + 1)}`);
    }

    // The outline should show CHILD_COUNT + 1 (root) rows in total.
    await expect(page.getByTestId("tree-outline-row")).toHaveCount(CHILD_COUNT + 1);

    // Focus the outline and navigate with ArrowDown from the first row to the last.
    const outline = page.getByTestId("tree-outline");
    await outline.focus();
    await page.keyboard.press("Home");

    let lastText = "";
    for (let i = 0; i < CHILD_COUNT; i += 1) {
      await page.keyboard.press("ArrowDown");
      const selected = page.locator('[data-testid="tree-outline-row"][data-selected="true"]');
      const text = (await selected.textContent()) ?? "";
      // Each ArrowDown must move the selection to a different node — proves traversal works
      // across virtualization boundaries (nodes that were off-screen are scrolled into view).
      expect(text).not.toBe(lastText);
      lastText = text;
    }

    // ArrowUp back to the root — proves reverse traversal.
    for (let i = 0; i < CHILD_COUNT; i += 1) {
      await page.keyboard.press("ArrowUp");
    }
    const rootSelected = page.locator('[data-testid="tree-outline-row"][data-selected="true"]');
    await expect(rootSelected).toHaveAttribute("aria-level", "1");
  });
});
