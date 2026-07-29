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
const NODE_WIDTH = 208;
const NODE_HEIGHT = 88;

export interface CanvasLayout {
  readonly width: number;
  readonly height: number;
  /** Horizontal offset to add to every `node.x`/`link.source.x`/`link.target.x` so the
   *  leftmost node sits at x = 0 (d3's `nodeSize` layout centers siblings around x = 0, which
   *  can be negative). */
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
    width: maxX - minX + NODE_WIDTH,
    height: maxY + NODE_HEIGHT,
    minX,
    nodes,
    links,
  };
}
