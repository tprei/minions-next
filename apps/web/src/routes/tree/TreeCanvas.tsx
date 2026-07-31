import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import type { CanvasDatum } from "./tree-model.js";
import { computeCanvasLayout } from "./tree-layout.js";
import "./TreeCanvas.css";

/**
 * 2D node-link diagram of the tree (PR 46 — plan-tree-editor-approval, PRD UI-02 "sibling
 * parallelism ... always legible"). `root` is a read-only {@link CanvasDatum} view derived from
 * the current `WorkingTree` (see tree-model.ts's `buildCanvasTree`); `tree-layout.ts` positions
 * it with `d3-hierarchy` for layout ONLY — clicking a node only ever calls `onSelect`, it never
 * mutates tree shape from here. Selecting a node here drives the SAME `selectedKey` state the
 * outline uses, so switching tabs keeps the same node in focus.
 */
export interface TreeCanvasProps {
  readonly root: CanvasDatum;
  readonly selectedKey: string | undefined;
  readonly onSelect: (key: string) => void;
}

const NODE_RECT_WIDTH = 176;
const NODE_RECT_HEIGHT = 52;
const PADDING = 32;

export function TreeCanvas({ root, selectedKey, onSelect }: TreeCanvasProps): ReactNode {
  const layout = useMemo(() => computeCanvasLayout(root), [root]);
  const viewBox = `${String(layout.minX - PADDING)} ${String(-PADDING)} ${String(
    layout.width + PADDING * 2,
  )} ${String(layout.height + PADDING * 2)}`;

  function handleKeyDown(event: KeyboardEvent<SVGRectElement>, key: string): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(key);
    }
  }

  return (
    <svg
      role="img"
      aria-label="Tree canvas"
      className="mn-tree-canvas"
      viewBox={viewBox}
      data-testid="tree-canvas"
    >
      <g>
        {layout.links.map((link) => (
          <line
            key={`${link.source.data.key}->${link.target.data.key}`}
            className="mn-tree-canvas__edge"
            x1={link.source.x}
            y1={link.source.y}
            x2={link.target.x}
            y2={link.target.y}
          />
        ))}
        {layout.nodes.map((node) => {
          const classes = ["mn-tree-canvas__node"];
          if (node.data.locked) classes.push("mn-tree-canvas__node--locked");
          if (node.data.stale) classes.push("mn-tree-canvas__node--stale");
          if (node.data.key === selectedKey) classes.push("mn-tree-canvas__node--selected");
          return (
            <g
              key={node.data.key}
              transform={`translate(${String(node.x)}, ${String(node.y)})`}
              className={classes.join(" ")}
            >
              <rect
                tabIndex={0}
                role="button"
                aria-pressed={node.data.key === selectedKey}
                aria-label={node.data.label}
                data-testid="tree-canvas-node"
                data-node-key={node.data.key}
                width={NODE_RECT_WIDTH}
                height={NODE_RECT_HEIGHT}
                x={-NODE_RECT_WIDTH / 2}
                y={-NODE_RECT_HEIGHT / 2}
                rx={8}
                onClick={() => {
                  onSelect(node.data.key);
                }}
                onKeyDown={(event) => {
                  handleKeyDown(event, node.data.key);
                }}
              />
              <text textAnchor="middle" dy="0.32em">
                {truncateLabel(node.data.label)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function truncateLabel(label: string): string {
  const text = label.length === 0 ? "(untitled node)" : label;
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}
