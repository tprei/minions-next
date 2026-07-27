/**
 * Stacked-PR parentage domain (PR 33).
 *
 * Pure domain logic for representing every root-to-leaf implementation path as
 * one unambiguous PR stack: deterministic branch/base naming derived from the
 * (tree, node) identity, one-parent-per-branch (no fan-in), parent-before-child
 * landing order, and Graphite-compatible base retargeting. NO I/O.
 *
 * Acceptance (GIT-05/06/13): native Git/GitHub records recover the stack with no
 * Graphite metadata — the branch names and PR bases alone encode the topology —
 * and every branch has exactly one parent.
 */
import { taskNodeId, taskTreeId, type TaskNodeId, type TaskTreeId } from "./value-objects.js";

// -------------------------------------------------------------------------------------------------
// Value shapes.
// -------------------------------------------------------------------------------------------------

/**
 * A node's place in a stack, as pure domain. Built deterministically from the
 * tree+node identity; never read from the network.
 */
export type StackPosition = Readonly<{
  treeId: TaskTreeId;
  nodeId: TaskNodeId;
  /** Deterministic head branch for this node (the pushed bookmark). */
  branch: string;
  /** Base branch the node's PR targets: the parent's branch, or the trunk. */
  baseBranch: string;
  /** Root-relative depth: 0 for a root, 1 for its child, and so on. */
  depth: number;
}>;

/**
 * A node plus its parentage, the raw input to stack construction. `parentIds`
 * carries the tree parent; more than one entry is fan-in, which the stack
 * invariant forbids (GIT-06: every branch has exactly one parent).
 */
export type StackNode = Readonly<{
  treeId: TaskTreeId;
  nodeId: TaskNodeId;
  /**
   * Parent node identities, in tree order. Empty ⇒ root (base = trunk). Exactly
   * one ⇒ a normal stacked child. More than one ⇒ fan-in.
   */
  parentIds: readonly TaskNodeId[];
}>;

/** Retarget plan produced when a parent lands: the child repoints at the grandparent. */
export type RetargetPlan = Readonly<{
  treeId: TaskTreeId;
  /** Child whose parent just landed; its PR base must be retargeted. */
  childNodeId: TaskNodeId;
  /** New base = the landed parent's own base (grandparent branch, or trunk). */
  newBaseBranch: string;
  /** Previous base = the landed parent's branch (now merged / landing). */
  previousBaseBranch: string;
}>;

// -------------------------------------------------------------------------------------------------
// Errors. Codes span both pure-domain breaches (fan_in, orphan, cycle, ...) and
// the I/O failures the adapter (stack-parentage-adapter.ts) raises against the
// GitHub PR client + binding store — one shared error type, fail-closed.
// -------------------------------------------------------------------------------------------------

export type StackParentageErrorCode =
  | "invalid_input"
  | "fan_in"
  | "orphan"
  | "cycle"
  | "duplicate_branch"
  | "node_not_found"
  | "drift"
  | "api_error"
  | "binding_lookup_failed";

/** Typed stack-parentage error. Fail-closed: every invariant breach surfaces. */
export class StackParentageError extends Error {
  readonly code: StackParentageErrorCode;
  override readonly cause: unknown;

  constructor(code: StackParentageErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StackParentageError";
    this.code = code;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------------------
// Naming.
// -------------------------------------------------------------------------------------------------

/** Branch-name prefix for every stack branch. */
export const STACK_BRANCH_PREFIX = "minions";

/** Default trunk a root node targets when no trunk is supplied. */
export const STACK_TRUNK_BRANCH = "main";

/** Length of the identity short used for the tree segment of a branch name. */
export const STACK_TREE_SHORT_LENGTH = 8;

/** Length of the identity short used for the node segment of a branch name. */
export const STACK_NODE_SHORT_LENGTH = 12;

/**
 * Deterministic short for a branded identity. Strips the UUIDv7 dashes and takes
 * the trailing random segment, which identifies uniquely regardless of creation
 * timing: two nodes minted in the same millisecond share their timestamp prefix
 * but never their random tail, so the short is collision-resistant in practice.
 * `validateStackTopology` is the absolute backstop for any residual collision.
 *
 * Pure and stable across processes.
 */
export function shortIdentity(identity: string, length: number): string {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new StackParentageError(
      "invalid_input",
      `short identity length must be a positive integer (got ${String(length)})`,
    );
  }
  const compact = identity.replace(/-/gu, "");
  if (length >= compact.length) {
    return compact;
  }
  return compact.slice(compact.length - length);
}

/**
 * Deterministic, collision-resistant head branch for a node: `minions/<treeShort>/<nodeShort>`.
 * The name is a pure function of the (tree, node) identity, so native Git/GitHub
 * records recover the stack with no side table. Collision-freedom across a tree
 * is enforced by {@link validateStackTopology}.
 */
export function determineBranchName(treeId: TaskTreeId, nodeId: TaskNodeId): string {
  taskTreeId(treeId);
  taskNodeId(nodeId);
  const treeShort = shortIdentity(treeId, STACK_TREE_SHORT_LENGTH);
  const nodeShort = shortIdentity(nodeId, STACK_NODE_SHORT_LENGTH);
  return `${STACK_BRANCH_PREFIX}/${treeShort}/${nodeShort}`;
}

/**
 * Base branch a node's PR targets. For a root (`parentNodeId === null`) it is the
 * trunk; otherwise it is the parent node's branch, so the child PR stacks on its
 * parent — Graphite-compatible, one parent per branch.
 */
export function determineBaseBranch(
  treeId: TaskTreeId,
  nodeId: TaskNodeId,
  parentNodeId: TaskNodeId | null,
  trunk: string = STACK_TRUNK_BRANCH,
): string {
  taskTreeId(treeId);
  taskNodeId(nodeId);
  if (trunk.length === 0) {
    throw new StackParentageError("invalid_input", "trunk branch must be non-empty");
  }
  if (parentNodeId === null) {
    return trunk;
  }
  taskNodeId(parentNodeId);
  return determineBranchName(treeId, parentNodeId);
}

// -------------------------------------------------------------------------------------------------
// Stack construction + topology validation.
// -------------------------------------------------------------------------------------------------

/**
 * Build the stack positions for a node set: one {@link StackPosition} per node,
 * root-first, with each base pointing at its single parent's branch (or trunk).
 * Rejects fan-in (a node with >1 parent), orphans (a parent missing from the
 * set), cycles, and duplicate branches. Every root-to-leaf walk is then one
 * unambiguous PR stack.
 *
 * Pure: no I/O.
 */
export function buildStackPath(
  nodes: readonly StackNode[],
  trunk: string = STACK_TRUNK_BRANCH,
): readonly StackPosition[] {
  validateStackInput(nodes, trunk);
  const byNode = indexNodes(nodes);

  const positions: StackPosition[] = [];
  for (const node of nodes) {
    if (node.parentIds.length > 1) {
      throw new StackParentageError(
        "fan_in",
        `node '${node.nodeId}' has ${String(node.parentIds.length)} parents; ` +
          `every branch must have exactly one parent (GIT-06)`,
      );
    }
    const parent = node.parentIds[0] ?? null;
    const branch = determineBranchName(node.treeId, node.nodeId);
    const baseBranch = determineBaseBranch(node.treeId, node.nodeId, parent, trunk);
    const depth = resolveDepth(node, byNode);
    positions.push(
      Object.freeze({ treeId: node.treeId, nodeId: node.nodeId, branch, baseBranch, depth }),
    );
  }

  validateStackTopology(positions, trunk);
  return Object.freeze(positions.sort(byDepthThenNode));
}

/**
 * Validate a stack topology. Rejects:
 * - duplicate branch names (two nodes owning one branch — the fan-in surface),
 * - orphan (a base that resolves to neither the trunk nor a stack branch),
 * - cycle (a base chain that loops before reaching the trunk).
 *
 * Pure: no I/O.
 */
export function validateStackTopology(
  positions: readonly StackPosition[],
  trunk: string = STACK_TRUNK_BRANCH,
): void {
  if (positions.length === 0) {
    throw new StackParentageError("invalid_input", "stack topology requires at least one position");
  }
  if (trunk.length === 0) {
    throw new StackParentageError("invalid_input", "trunk branch must be non-empty");
  }

  const seenBranches = new Set<string>();
  for (const pos of positions) {
    if (seenBranches.has(pos.branch)) {
      throw new StackParentageError(
        "duplicate_branch",
        `branch '${pos.branch}' is owned by more than one node (node '${pos.nodeId}')`,
      );
    }
    seenBranches.add(pos.branch);
  }

  const byBranch = new Map<string, StackPosition>();
  for (const pos of positions) {
    byBranch.set(pos.branch, pos);
  }

  for (const pos of positions) {
    const visited = new Set<string>();
    let cursor: StackPosition = pos;
    // Follow bases until we reach the trunk. A finite node set means this either
    // roots at the trunk, hits an off-stack base (orphan), or revisits a branch
    // (cycle) — all terminal within |positions|+1 steps.
    for (let step = 0; step <= positions.length; step += 1) {
      if (cursor.baseBranch === trunk) {
        break;
      }
      if (visited.has(cursor.branch)) {
        throw new StackParentageError(
          "cycle",
          `cycle detected following bases from node '${pos.nodeId}' (branch '${pos.branch}')`,
        );
      }
      visited.add(cursor.branch);
      const next = byBranch.get(cursor.baseBranch);
      if (next === undefined) {
        throw new StackParentageError(
          "orphan",
          `node '${pos.nodeId}' base '${cursor.baseBranch}' resolves to neither ` +
            `the trunk ('${trunk}') nor any stack branch`,
        );
      }
      cursor = next;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Landing retarget.
// -------------------------------------------------------------------------------------------------

/**
 * Plan the retarget when a parent lands: its child repoints at the landed
 * parent's own base — the grandparent's branch, or the trunk if the parent was a
 * root. Parent-before-child landing order: call this once the parent's PR has
 * merged, before landing the child. Pure: no I/O.
 */
export function retargetAfterLanding(
  landedNodeId: TaskNodeId,
  childNodeId: TaskNodeId,
  nodes: readonly StackNode[],
  trunk: string = STACK_TRUNK_BRANCH,
): RetargetPlan {
  validateStackInput(nodes, trunk);
  taskNodeId(landedNodeId);
  taskNodeId(childNodeId);
  const byNode = indexNodes(nodes);

  const landed = byNode.get(landedNodeId);
  if (landed === undefined) {
    throw new StackParentageError(
      "node_not_found",
      `landed node '${landedNodeId}' is not in the stack`,
    );
  }
  const child = byNode.get(childNodeId);
  if (child === undefined) {
    throw new StackParentageError(
      "node_not_found",
      `child node '${childNodeId}' is not in the stack`,
    );
  }
  if (!child.parentIds.includes(landedNodeId)) {
    throw new StackParentageError(
      "invalid_input",
      `node '${childNodeId}' is not a child of landed node '${landedNodeId}'`,
    );
  }

  const landedParent = landed.parentIds[0] ?? null;
  const newBaseBranch = determineBaseBranch(landed.treeId, landed.nodeId, landedParent, trunk);
  const previousBaseBranch = determineBranchName(landed.treeId, landed.nodeId);
  return Object.freeze({ treeId: landed.treeId, childNodeId, newBaseBranch, previousBaseBranch });
}

// -------------------------------------------------------------------------------------------------
// Internal helpers.
// -------------------------------------------------------------------------------------------------

function validateStackInput(nodes: readonly StackNode[], trunk: string): void {
  if (nodes.length === 0) {
    throw new StackParentageError("invalid_input", "stack requires at least one node");
  }
  if (trunk.length === 0) {
    throw new StackParentageError("invalid_input", "trunk branch must be non-empty");
  }
  const treeId = nodes[0]?.treeId;
  if (treeId === undefined) {
    throw new StackParentageError("invalid_input", "stack nodes must carry a tree id");
  }
  taskTreeId(treeId);
  for (const node of nodes) {
    if (node.treeId !== treeId) {
      throw new StackParentageError(
        "invalid_input",
        `stack nodes must share a tree id ('${treeId}' vs '${node.treeId}')`,
      );
    }
  }
}

function indexNodes(nodes: readonly StackNode[]): ReadonlyMap<TaskNodeId, StackNode> {
  const map = new Map<TaskNodeId, StackNode>();
  for (const node of nodes) {
    taskTreeId(node.treeId);
    taskNodeId(node.nodeId);
    for (const parentId of node.parentIds) {
      taskNodeId(parentId);
    }
    if (map.has(node.nodeId)) {
      throw new StackParentageError(
        "invalid_input",
        `duplicate node '${node.nodeId}' appears more than once in the stack input`,
      );
    }
    map.set(node.nodeId, node);
  }
  return map;
}

function resolveDepth(node: StackNode, byNode: ReadonlyMap<TaskNodeId, StackNode>): number {
  let depth = 0;
  let current: StackNode = node;
  const visited = new Set<TaskNodeId>();
  visited.add(node.nodeId);
  while (current.parentIds.length === 1) {
    const parentId = current.parentIds[0];
    if (parentId === undefined) {
      break;
    }
    if (visited.has(parentId)) {
      throw new StackParentageError(
        "cycle",
        `cycle detected resolving depth at node '${node.nodeId}'`,
      );
    }
    visited.add(parentId);
    const parent = byNode.get(parentId);
    if (parent === undefined) {
      throw new StackParentageError(
        "orphan",
        `node '${node.nodeId}' references parent '${parentId}' not present in the stack`,
      );
    }
    if (parent.parentIds.length > 1) {
      throw new StackParentageError(
        "fan_in",
        `node '${parent.nodeId}' has ${String(parent.parentIds.length)} parents (fan-in)`,
      );
    }
    depth += 1;
    current = parent;
  }
  return depth;
}

function byDepthThenNode(a: StackPosition, b: StackPosition): number {
  if (a.depth !== b.depth) {
    return a.depth - b.depth;
  }
  if (a.nodeId < b.nodeId) {
    return -1;
  }
  if (a.nodeId > b.nodeId) {
    return 1;
  }
  return 0;
}
