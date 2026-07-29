import type { HTMLAttributes, ReactNode } from "react";
import "./DiffList.css";

/**
 * Generic diff-list primitive (PR 46 — plan-tree-editor-approval).
 *
 * Renders a list of "added" / "removed" / "changed" / "unchanged" entries with a consistent,
 * color-plus-glyph signature (never color alone — WCAG 2.2 AA) shared by every feature that
 * needs to show a before/after comparison. First consumer is the plan-revision diff (a
 * working copy of proposed tree nodes against the tree's current persisted shape), but the
 * shape carries no tree/plan vocabulary — `label`/`detail` are caller-supplied `ReactNode`s,
 * so a future code or transcript interdiff (see the PRD's PR 48) can reuse it unchanged.
 */
export type DiffEntryKind = "added" | "removed" | "changed" | "unchanged";

export interface DiffListEntry {
  readonly key: string;
  readonly kind: DiffEntryKind;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
}

export interface DiffListProps extends HTMLAttributes<HTMLUListElement> {
  readonly entries: readonly DiffListEntry[];
  /** Shown in place of the list when `entries` is empty. Defaults to "No changes." */
  readonly emptyMessage?: string;
}

const glyphByKind: Readonly<Record<DiffEntryKind, string>> = {
  added: "+",
  removed: "−",
  changed: "~",
  unchanged: "·",
};

export function DiffList({
  entries,
  emptyMessage = "No changes.",
  className,
  ...rest
}: DiffListProps): ReactNode {
  if (entries.length === 0) {
    return <p className="mn-muted">{emptyMessage}</p>;
  }
  const classes = ["mn-diff-list"];
  if (className !== undefined) classes.push(className);
  return (
    <ul className={classes.join(" ")} {...rest}>
      {entries.map((entry) => (
        <li key={entry.key} className={`mn-diff-list__item mn-diff-list__item--${entry.kind}`}>
          <span className="mn-diff-list__glyph" aria-hidden="true">
            {glyphByKind[entry.kind]}
          </span>
          <span className="mn-visually-hidden">{entry.kind}: </span>
          <span className="mn-diff-list__label">{entry.label}</span>
          {entry.detail !== undefined ? (
            <span className="mn-diff-list__detail">{entry.detail}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
