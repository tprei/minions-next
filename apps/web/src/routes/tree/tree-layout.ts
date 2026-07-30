import {
  hierarchy,
  tree as d3Tree,
  type HierarchyPointLink,
  type HierarchyPointNode,
} from "d3-hierarchy";
import type { CanvasDatum } from "./tree-model.js";

/**
 * `d3-hierarchy` layout wrapper for the tree canvas (PR 46 — plan-tree-editor-approval).
 *
 * LAYOUT ONLY: this module computes x/y pixel positions for a already-built {@link CanvasDatum}
 * tree (see tree-model.ts's `buildCanvasTree`) and returns them for rendering. It never reads
 * or writes anything about WHICH node is whose parent beyond the `children` array it was
 * handed — `tree-model.ts`'s `WorkingTree` remains the sole source of truth for tree shape.
 */
// Spacing between adjacent node CENTERS in the d3 layout — deliberately wider than the
// rendered rect (see NODE_RECT_WIDTH/NODE_RECT_HEIGHT below) to leave room for edges and
// labels between siblings/depths.
const NODE_WIDTH = 208;
const NODE_HEIGHT = 88;

// Actual rendered node rect size (TreeCanvas.tsx draws each rect centered on its node's
// x/y, i.e. from `x - NODE_RECT_WIDTH / 2` to `x + NODE_RECT_WIDTH / 2`). The viewBox bounds
// below MUST be computed from these, not from NODE_WIDTH/NODE_HEIGHT — using the layout
// spacing constant here previously left only half the rendered rect's width accounted for,
// clipping the leftmost node's rect and label inside the SVG viewBox.
export const NODE_RECT_WIDTH = 176;
export const NODE_RECT_HEIGHT = 52;

export interface CanvasLayout {
  readonly width: number;
  readonly height: number;
  /** Left edge (in layout coordinates) of the tight bounding box around every rendered node
   *  rect — i.e. the leftmost rect's left edge, `node.x - NODE_RECT_WIDTH / 2`. TreeCanvas.tsx
   *  uses this directly as its SVG viewBox's origin (minus its own outer padding), so the
   *  viewBox always fully contains every rect with no clipping. */
  readonly minX: number;
  readonly nodes: readonly HierarchyPointNode<CanvasDatum>[];
  readonly links: readonly HierarchyPointLink<CanvasDatum>[];
}

export function computeCanvasLayout(root: CanvasDatum): CanvasLayout {
  const hierarchyRoot = hierarchy(root, (node) => node.children);
  const layout = d3Tree<CanvasDatum>().nodeSize([NODE_WIDTH, NODE_HEIGHT]);
  const positioned = layout(hierarchyRoot);
  const nodes = positioned.descendants();
  const links = positioned.links();

  let minX = 0;
  let maxX = 0;
  let maxY = 0;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }

  return {
    width: maxX - minX + NODE_RECT_WIDTH,
    height: maxY + NODE_HEIGHT,
    minX: minX - NODE_RECT_WIDTH / 2,
    nodes,
    links,
  };
}
