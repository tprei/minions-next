import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { StatusBadge } from "@minions/ui-kit";
import type { OutlineRow } from "./tree-model.js";
import { nodeStateBadgeKind, nodeStateLabel, planNodeModeLabel } from "./tree-labels.js";
import "./TreeOutline.css";

/**
 * Virtualized, keyboard-navigable tree outline (PR 46 — plan-tree-editor-approval, PRD UI-10).
 *
 * `rows` is the full flattened depth-first order (see tree-model.ts's `flattenOutline`) — for a
 * large tree this can be hundreds of entries, but only the rows within (and a small overscan
 * around) the scrolled viewport are ever mounted. This is a manual windowed render — track
 * scroll position, slice the visible index range — rather than a virtualization library: the
 * row height is fixed and uniform, so the math is a few lines, and it keeps the dependency list
 * lean (per this PR's own guidance) for a "dozens to low hundreds of nodes" scale.
 *
 * `role="tree"`/`role="treeitem"` plus `aria-activedescendant` (rather than full roving
 * tabindex) is the correct ARIA composite-widget pattern for a virtualized list: the "active"
 * row only needs to be addressable by id, not literally focused, and `scrollSelectedIntoView`
 * guarantees the referenced id is always actually mounted when it's referenced.
 */
export interface TreeOutlineProps {
  readonly rows: readonly OutlineRow[];
  readonly selectedKey: string | undefined;
  readonly onSelect: (key: string) => void;
}

const ROW_HEIGHT = 40;
const OVERSCAN = 8;
const ROW_ID_PREFIX = "tree-outline-row-";

export function TreeOutline({ rows, selectedKey, onSelect }: TreeOutlineProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    setViewportHeight(node.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const visibleRows = useMemo(() => rows.slice(startIndex, endIndex), [rows, startIndex, endIndex]);

  function scrollIndexIntoView(index: number): void {
    const node = containerRef.current;
    if (node === null) return;
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < node.scrollTop) {
      node.scrollTop = top;
    } else if (bottom > node.scrollTop + node.clientHeight) {
      node.scrollTop = bottom - node.clientHeight;
    }
  }

  function selectByOffset(offset: number): void {
    if (rows.length === 0) return;
    const currentIndex = rows.findIndex((row) => row.key === selectedKey);
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = Math.min(Math.max(baseIndex + offset, 0), rows.length - 1);
    const next = rows[nextIndex];
    if (next !== undefined) {
      onSelect(next.key);
      scrollIndexIntoView(nextIndex);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        selectByOffset(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        selectByOffset(-1);
        break;
      case "Home":
        event.preventDefault();
        selectByOffset(-rows.length);
        break;
      case "End":
        event.preventDefault();
        selectByOffset(rows.length);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={containerRef}
      className="mn-tree-outline"
      role="tree"
      aria-label="Task tree outline"
      tabIndex={0}
      data-testid="tree-outline"
      aria-activedescendant={
        selectedKey !== undefined ? `${ROW_ID_PREFIX}${selectedKey}` : undefined
      }
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="mn-tree-outline__spacer" style={{ height: rows.length * ROW_HEIGHT }}>
        <div
          className="mn-tree-outline__window"
          style={{ transform: `translateY(${String(startIndex * ROW_HEIGHT)}px)` }}
        >
          {visibleRows.map((row) => (
            <OutlineRowView
              key={row.key}
              row={row}
              selected={row.key === selectedKey}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function OutlineRowView({
  row,
  selected,
  onSelect,
}: {
  readonly row: OutlineRow;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
}): ReactNode {
  const classes = ["mn-tree-outline__row"];
  if (selected) classes.push("mn-tree-outline__row--selected");
  if (row.locked) classes.push("mn-tree-outline__row--locked");
  return (
    <div
      id={`${ROW_ID_PREFIX}${row.key}`}
      role="treeitem"
      aria-selected={selected}
      aria-level={row.depth + 1}
      data-testid="tree-outline-row"
      data-node-key={row.key}
      data-selected={selected ? "true" : "false"}
      className={classes.join(" ")}
      style={{ height: ROW_HEIGHT, paddingLeft: `${String(row.depth * 16 + 8)}px` }}
      onClick={() => {
        onSelect(row.key);
      }}
    >
      <span className="mn-tree-outline__objective">{row.objective || "(untitled node)"}</span>
      <span className="mn-tree-outline__badges">
        <StatusBadge status="neutral" label={planNodeModeLabel(row.mode)} />
        {row.state !== undefined ? (
          <StatusBadge status={nodeStateBadgeKind(row.state)} label={nodeStateLabel(row.state)} />
        ) : (
          <StatusBadge status="neutral" label="pending" />
        )}
        {row.stale ? <StatusBadge status="warning" label="stale input" /> : null}
      </span>
    </div>
  );
}
