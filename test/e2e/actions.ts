import type { Page } from "@playwright/test";
import { expect } from "./fixtures.js";

/**
 * Drives the "Register repository" dialog to completion via the UI (PR 45 —
 * host-repository-task-ui) — shared by every spec that needs a real, already-registered
 * repository as a precondition. Waits for the dialog to close, which only happens once
 * `RegisterRepository` has actually succeeded (see RegisterRepositoryDialog.tsx).
 */
export async function registerRepositoryViaUi(page: Page, rootPath: string): Promise<void> {
  await page.getByRole("button", { name: "Register repository" }).click();
  await page.getByLabel("Repository path").fill(rootPath);
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByRole("dialog", { name: "Register repository" })).toBeHidden();
}

/**
 * Presses Tab repeatedly until the given element id is focused, up to `maxPresses` times —
 * robust to wherever a dialog's initial auto-focus lands (Radix Dialog focuses the first
 * focusable descendant on open; this doesn't assume which one), while still proving every
 * field between the current focus and the target is reachable via Tab alone (PR 45's
 * "keyboard-only tree creation" scenario: no `.click()` anywhere in the flow).
 */
export async function tabUntilFocused(
  page: Page,
  elementId: string,
  maxPresses = 20,
): Promise<void> {
  for (let attempt = 0; attempt < maxPresses; attempt += 1) {
    const activeId = await page.evaluate(() => document.activeElement?.id ?? "");
    if (activeId === elementId) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`could not reach #${elementId} within ${String(maxPresses)} Tab presses`);
}
