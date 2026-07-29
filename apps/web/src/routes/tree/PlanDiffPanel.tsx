import type { ReactNode } from "react";
import { DiffList, type DiffListEntry } from "@minions/ui-kit";
import type { PlanDiffEntry } from "./tree-model.js";

/**
 * Renders the working copy's diff against the tree's current persisted shape (PR 46 —
 * plan-tree-editor-approval) via ui-kit's generic {@link DiffList}. Purely presentational —
 * all diff computation lives in tree-model.ts's `computePlanDiff`.
 */
export interface PlanDiffPanelProps {
  readonly entries: readonly PlanDiffEntry[];
}

export function PlanDiffPanel({ entries }: PlanDiffPanelProps): ReactNode {
  const listEntries: DiffListEntry[] = entries.map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    label: entry.objective || "(untitled node)",
    detail: entry.changes.length > 0 ? entry.changes.join(", ") : undefined,
  }));
  return (
    <div data-testid="plan-diff-panel">
      <DiffList entries={listEntries} emptyMessage="No pending changes against the current plan." />
    </div>
  );
}
