import { create } from "@bufbuild/protobuf";
import {
  ArtifactInputSchema,
  ArtifactOutputContractSchema,
  ImplementationOutputContractSchema,
  NodeState,
  PlanNodeMode,
  ProposedNodeSchema,
  type ArtifactInput,
  type ProposedNode,
  type TaskNode,
  type TaskTree,
  type TreeBudget,
  type VcsChangeBinding,
} from "@minions/contracts";
import { generateUuidV7 } from "../../data/index.js";
import { validateCanonicalRelativePath } from "../home/validation.js";

/**
 * Client-side strict-tree edit model (PR 46 — plan-tree-editor-approval).
 *
 * This module is the ONLY place the editor's edit semantics live — every view (outline,
 * canvas, diff, node editor) renders a projection of a {@link WorkingTree} and every mutation
 * goes through the pure functions here. It is deliberately framework-free (no React) so the
 * invariants below are easy to audit in isolation:
 *
 * - **No fan-in, structurally.** A {@link WorkingNode} has exactly one `parentKey: string`
 *   field. There is no array/set of parents anywhere in this model, so a second parent is not
 *   a validation rule to remember — it is a type that does not exist.
 * - **No forward/dangling references.** `parentKey` and every `inputs[].sourceKey` are always
 *   resolved against the SAME `WorkingTree` snapshot (root, locked nodes, or other working
 *   rows) — see {@link validParentOptions} / {@link validInputSourceOptions}, the only two
 *   functions that ever enumerate legal targets for those fields.
 * - **Started/terminal nodes are immutable.** Mirrors
 *   packages/adapters/src/sqlite/plan-registry.ts's `retained` filter and `isStartedOrTerminal`
 *   helper EXACTLY, verified against that source: the server always retains the root (any
 *   state) plus every node whose state is ACTIVE, BLOCKED, SUCCEEDED, FAILED, or CANCELLED —
 *   see {@link isLockedState}. Both PLANNED and READY are still fully re-plannable (the server
 *   groups them together as "droppable unless resubmitted"); only the five states above are
 *   genuinely locked. Locked nodes are surfaced as {@link LockedNode}s with no mutator in this
 *   module ever accepting their id as a target to edit or remove.
 * - **Every submitted node id is freshly minted, every time.** The `nodes` table's own
 *   `node_definition_is_immutable` trigger (and the `propose()`/`repair()` validation that
 *   rejects any node id already present in the tree) means a node can never be "updated" —
 *   only superseded by a brand-new id. {@link buildProposedNodes} therefore mints a fresh
 *   UUIDv7 for every working row (and every artifact-output row) at submit time,
 *   unconditionally — never reusing a `sourceNodeId`/prior wire id, even for an otherwise
 *   untouched row.
 *
 * `d3-hierarchy` (see tree-layout.ts) is layout-only: it consumes a read-only
 * {@link CanvasDatum} tree DERIVED from a `WorkingTree` and never feeds back into it.
 */

// ---------------------------------------------------------------------------------------------
// Locked / dead nodes (read-only context around the editable working copy)
// ---------------------------------------------------------------------------------------------

type OutputContractView =
  | Readonly<{ case: "artifact"; artifactId: string; artifactType: string }>
  | Readonly<{ case: "implementation" }>;

interface LockedNode {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly isRoot: boolean;
  readonly mode: PlanNodeMode;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly inputs: readonly ArtifactInput[];
  readonly outputContract: OutputContractView;
  readonly allowedRepositoryPaths: readonly string[];
  readonly state: NodeState;
  readonly maxAttempts: number;
  readonly vcsChangeBinding: VcsChangeBinding | undefined;
}

/** A superseded (dead) node — never rendered in the live tree, kept only so a dangling
 *  reference to it can be explained ("superseded by a later plan revision") instead of just
 *  reported as "missing". */
interface DeadNode {
  readonly id: string;
  readonly objective: string;
  readonly state: NodeState;
}

/**
 * States the server always retains verbatim regardless of what a new plan proposes. See this
 * module's doc comment — verified against plan-registry.ts's `retained` filter, not assumed.
 */
function isLockedState(state: NodeState): boolean {
  switch (state) {
    case NodeState.ACTIVE:
    case NodeState.BLOCKED:
    case NodeState.SUCCEEDED:
    case NodeState.FAILED:
    case NodeState.CANCELLED:
      return true;
    case NodeState.UNSPECIFIED:
    case NodeState.PLANNED:
    case NodeState.READY:
    case NodeState.SUPERSEDED:
      return false;
  }
}

function outputContractView(contract: TaskNode["outputContract"]): OutputContractView {
  if (contract.case === "artifact") {
    return {
      case: "artifact",
      artifactId: contract.value.artifactId,
      artifactType: contract.value.artifactType,
    };
  }
  if (contract.case === "implementation") {
    return { case: "implementation" };
  }
  throw new Error("task node output contract is missing");
}

function outputContractDraft(contract: TaskNode["outputContract"]): OutputContractDraft {
  if (contract.case === "artifact") {
    return { case: "artifact", artifactType: contract.value.artifactType };
  }
  if (contract.case === "implementation") {
    return { case: "implementation" };
  }
  throw new Error("task node output contract is missing");
}

// ---------------------------------------------------------------------------------------------
// Working (editable) nodes
// ---------------------------------------------------------------------------------------------

type OutputContractDraft =
  Readonly<{ case: "artifact"; artifactType: string }> | Readonly<{ case: "implementation" }>;

interface ArtifactInputDraft {
  /** Stable per-row client id, for list rendering/removal — never sent over the wire. */
  readonly key: string;
  /** The producing node's {@link WorkingNode.key} or {@link LockedNode.id}. */
  readonly sourceKey: string;
}

interface WorkingNode {
  /** Stable client-local identity (React key, selection target). Seeded from the original
   *  `TaskNode.id` for rows loaded from the server, or freshly minted for rows added in this
   *  session — either way it is NEVER itself sent as a wire id (see `buildProposedNodes`). */
  readonly key: string;
  /** The `TaskNode.id` this row was seeded from, when it originated from an already-persisted
   *  PLANNED/READY node; `undefined` for a node added in this editing session. Used only for
   *  diffing against the tree's last-fetched shape. */
  readonly sourceNodeId: string | undefined;
  /** {@link LockedNode.id} | another {@link WorkingNode.key}. Always resolvable within the
   *  same `WorkingTree` — see {@link validParentOptions}. */
  readonly parentKey: string;
  readonly mode: PlanNodeMode;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly inputs: readonly ArtifactInputDraft[];
  readonly outputContract: OutputContractDraft;
  readonly allowedRepositoryPaths: readonly string[];
}

export interface WorkingTree {
  readonly rootId: string;
  readonly goal: string;
  /** Root (any state) plus every started/terminal node — see {@link isLockedState}. Keyed by
   *  the node's real, permanent `TaskNode.id`. */
  readonly locked: ReadonlyMap<string, LockedNode>;
  /** Superseded nodes, keyed by id — diagnostics only, never rendered as part of the tree. */
  readonly dead: ReadonlyMap<string, DeadNode>;
  /** Every PLANNED/READY (non-root) node, editable in this session. */
  readonly working: readonly WorkingNode[];
}

/** Builds the initial editable snapshot from a freshly fetched/mutated `TaskTree`. Call again
 *  (discarding the previous `WorkingTree`) whenever a new authoritative `TaskTree` arrives —
 *  from `GetTree` on open, or from a `ProposePlan`/`RepairPlan`/`ApprovePlan` response. */
export function seedWorkingTree(tree: TaskTree): WorkingTree {
  const locked = new Map<string, LockedNode>();
  const dead = new Map<string, DeadNode>();
  const working: WorkingNode[] = [];
  for (const node of tree.nodes) {
    const isRoot = node.id === tree.rootNodeId;
    if (isRoot || isLockedState(node.state)) {
      locked.set(node.id, {
        id: node.id,
        parentId: node.parentNodeId,
        isRoot,
        mode: node.mode,
        objective: node.objective,
        acceptanceCriteria: node.acceptanceCriteria,
        inputs: node.inputs,
        outputContract: outputContractView(node.outputContract),
        allowedRepositoryPaths: node.allowedRepositoryPaths,
        state: node.state,
        maxAttempts: node.budget?.maxAttempts ?? 0,
        vcsChangeBinding: node.vcsChangeBinding,
      });
    } else if (node.state === NodeState.SUPERSEDED) {
      dead.set(node.id, { id: node.id, objective: node.objective, state: node.state });
    } else {
      working.push({
        key: node.id,
        sourceNodeId: node.id,
        parentKey: node.parentNodeId ?? tree.rootNodeId,
        mode: node.mode,
        objective: node.objective,
        acceptanceCriteria: [...node.acceptanceCriteria],
        inputs: node.inputs.map((input) => ({
          key: generateUuidV7(),
          sourceKey: input.sourceNodeId,
        })),
        outputContract: outputContractDraft(node.outputContract),
        allowedRepositoryPaths: [...node.allowedRepositoryPaths],
      });
    }
  }
  return {
    rootId: tree.rootNodeId,
    goal: tree.goal,
    locked,
    dead,
    working: Object.freeze(working),
  };
}

export function indexNodesById(tree: TaskTree): ReadonlyMap<string, TaskNode> {
  return new Map(tree.nodes.map((node) => [node.id, node]));
}

// ---------------------------------------------------------------------------------------------
// Structural queries (parent/child/ancestor/descendant) — the ONLY code that walks the tree
// shape. Every other module asks these functions rather than re-deriving structure itself.
// ---------------------------------------------------------------------------------------------

function findWorking(tree: WorkingTree, key: string): WorkingNode | undefined {
  return tree.working.find((node) => node.key === key);
}

function nodeExists(tree: WorkingTree, key: string): boolean {
  return tree.locked.has(key) || findWorking(tree, key) !== undefined;
}

function nodeLabel(tree: WorkingTree, key: string): string {
  const locked = tree.locked.get(key);
  if (locked !== undefined) return locked.objective;
  const working = findWorking(tree, key);
  if (working !== undefined) return working.objective || "(untitled node)";
  const dead = tree.dead.get(key);
  if (dead !== undefined) return dead.objective;
  return key;
}

function parentKeyOf(tree: WorkingTree, key: string): string | undefined {
  const locked = tree.locked.get(key);
  if (locked !== undefined) return locked.parentId;
  return findWorking(tree, key)?.parentKey;
}

/** Every child of `parentKey` in the CURRENT working tree, locked children (by their fixed,
 *  persisted parent) first in creation order, then working children in add order. */
function childKeys(tree: WorkingTree, parentKey: string): readonly string[] {
  const keys: string[] = [];
  for (const node of tree.locked.values()) {
    if (node.parentId === parentKey) keys.push(node.id);
  }
  for (const node of tree.working) {
    if (node.parentKey === parentKey) keys.push(node.key);
  }
  return keys;
}

/** Immediate parent up through the root, as a list of keys (nearest first). Stops early
 *  (rather than looping forever) if a cycle is somehow already present. */
function ancestorKeys(tree: WorkingTree, key: string): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>([key]);
  let current = parentKeyOf(tree, key);
  while (current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = parentKeyOf(tree, current);
  }
  return chain;
}

export function descendantKeySet(tree: WorkingTree, key: string): ReadonlySet<string> {
  const result = new Set<string>();
  const stack = [key];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const child of childKeys(tree, current)) {
      if (!result.has(child)) {
        result.add(child);
        stack.push(child);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Valid-target enumeration — the editor's ONLY way to offer a parent or an artifact-input
// source is one of these lists, so an invalid choice is never presentable in the first place.
// ---------------------------------------------------------------------------------------------

export interface ParentOption {
  readonly key: string;
  readonly label: string;
  readonly locked: boolean;
}

/** Every legal new parent for `forKey`: root, every started/terminal node (always safe — the
 *  server retains them unconditionally), and every OTHER working node that is not `forKey`
 *  itself or one of its own descendants (cycle prevention). Mirrors plan-registry.ts's
 *  `depthOf` rule that an existing PLANNED/READY node can never be referenced as a parent —
 *  those never appear here because they are represented as working rows, not locked ones. */
export function validParentOptions(tree: WorkingTree, forKey: string): readonly ParentOption[] {
  const descendants = descendantKeySet(tree, forKey);
  const options: ParentOption[] = [];
  for (const node of tree.locked.values()) {
    options.push({ key: node.id, label: node.objective, locked: true });
  }
  for (const node of tree.working) {
    if (node.key === forKey || descendants.has(node.key)) continue;
    options.push({ key: node.key, label: node.objective || "(untitled node)", locked: false });
  }
  return options;
}

export interface InputSourceOption {
  readonly key: string;
  readonly label: string;
  readonly artifactType: string;
}

/** Every legal artifact-input source for `forKey`: strict ancestors (never self, never a
 *  sibling — TREE-05) that currently produce an artifact output. */
export function validInputSourceOptions(
  tree: WorkingTree,
  forKey: string,
): readonly InputSourceOption[] {
  const options: InputSourceOption[] = [];
  for (const ancestorKey of ancestorKeys(tree, forKey)) {
    const locked = tree.locked.get(ancestorKey);
    if (locked !== undefined) {
      if (locked.outputContract.case === "artifact") {
        options.push({
          key: ancestorKey,
          label: locked.objective,
          artifactType: locked.outputContract.artifactType,
        });
      }
      continue;
    }
    const working = findWorking(tree, ancestorKey);
    if (working?.outputContract.case === "artifact") {
      options.push({
        key: ancestorKey,
        label: working.objective || "(untitled node)",
        artifactType: working.outputContract.artifactType,
      });
    }
  }
  return options;
}

// ---------------------------------------------------------------------------------------------
// Stale artifact-input detection (defense in depth — the server has no equivalent check)
// ---------------------------------------------------------------------------------------------

type StaleReason = "missing" | "superseded" | "not_ancestor" | "not_artifact";

export interface StaleInput {
  readonly nodeKey: string;
  readonly inputKey: string;
  readonly reason: StaleReason;
  readonly detail: string;
}

/** Flags every `inputs[]` row whose source is no longer a valid artifact-producing ancestor of
 *  its consuming node — because it was removed from the working copy, belongs to a plan
 *  revision already superseded, was reparented out of the ancestor chain, or had its output
 *  contract switched away from "artifact". Recomputed live on every edit; saving is blocked
 *  while any stale input remains (see `validateWorkingTree`). */
export function computeStaleInputs(tree: WorkingTree): readonly StaleInput[] {
  const stale: StaleInput[] = [];
  for (const node of tree.working) {
    const ancestors = new Set(ancestorKeys(tree, node.key));
    for (const input of node.inputs) {
      const sourceKey = input.sourceKey;
      const lockedSource = tree.locked.get(sourceKey);
      const workingSource = findWorking(tree, sourceKey);
      if (lockedSource === undefined && workingSource === undefined) {
        const deadSource = tree.dead.get(sourceKey);
        stale.push({
          nodeKey: node.key,
          inputKey: input.key,
          reason: deadSource !== undefined ? "superseded" : "missing",
          detail:
            deadSource !== undefined
              ? `"${deadSource.objective}" was superseded by a later plan revision.`
              : "The referenced node no longer exists in this plan.",
        });
        continue;
      }
      if (!ancestors.has(sourceKey)) {
        stale.push({
          nodeKey: node.key,
          inputKey: input.key,
          reason: "not_ancestor",
          detail: "The referenced node is no longer an ancestor of this node.",
        });
        continue;
      }
      const contract = lockedSource?.outputContract ?? workingSource?.outputContract;
      if (contract?.case !== "artifact") {
        stale.push({
          nodeKey: node.key,
          inputKey: input.key,
          reason: "not_artifact",
          detail: "The referenced node no longer produces an artifact output.",
        });
      }
    }
  }
  return stale;
}

// ---------------------------------------------------------------------------------------------
// Budget usage / validation
// ---------------------------------------------------------------------------------------------

export interface BudgetUsage {
  readonly nodeCount: number;
  readonly maxDepthUsed: number;
  readonly maxFanOutUsed: number;
}

/** Mirrors plan-registry.ts's budget accounting exactly: `max_nodes` counts every locked
 *  (retained) node plus every working (proposed) node; `max_fan_out` counts direct children per
 *  parent over that same combined set; `max_depth` counts the root as depth 1. */
export function computeBudgetUsage(tree: WorkingTree): BudgetUsage {
  const allKeys = [...tree.locked.keys(), ...tree.working.map((node) => node.key)];
  const fanOutByParent = new Map<string, number>();
  for (const key of allKeys) {
    const parent = parentKeyOf(tree, key);
    if (parent === undefined) continue;
    fanOutByParent.set(parent, (fanOutByParent.get(parent) ?? 0) + 1);
  }
  let maxDepthUsed = 0;
  for (const key of allKeys) {
    const depth = ancestorKeys(tree, key).length + 1;
    if (depth > maxDepthUsed) maxDepthUsed = depth;
  }
  let maxFanOutUsed = 0;
  for (const count of fanOutByParent.values()) {
    if (count > maxFanOutUsed) maxFanOutUsed = count;
  }
  return { nodeCount: allKeys.length, maxDepthUsed, maxFanOutUsed };
}

export interface ValidationIssue {
  /** `undefined` for a tree-wide (budget) issue. */
  readonly key: string | undefined;
  readonly message: string;
}

/** Client-side validation run before every Save — a strict SUBSET of what the server enforces
 *  (defense in depth, instant feedback), never a superset: nothing accepted here that the
 *  server would reject, and nothing rejected here that a legal plan would need. */
export function validateWorkingTree(
  tree: WorkingTree,
  budget: TreeBudget,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of tree.working) {
    if (node.objective.trim().length === 0) {
      issues.push({ key: node.key, message: "Objective must not be empty." });
    }
    if (
      node.acceptanceCriteria.length === 0 ||
      node.acceptanceCriteria.some((criterion) => criterion.trim().length === 0)
    ) {
      issues.push({
        key: node.key,
        message: "At least one non-empty acceptance criterion is required.",
      });
    }
    if (node.allowedRepositoryPaths.length === 0) {
      issues.push({ key: node.key, message: "At least one allowed repository path is required." });
    }
    for (const path of node.allowedRepositoryPaths) {
      const error = validateCanonicalRelativePath(path, "Allowed repository path");
      if (error !== undefined) issues.push({ key: node.key, message: error });
    }
    if (node.outputContract.case === "artifact") {
      if (node.outputContract.artifactType.trim().length === 0) {
        issues.push({ key: node.key, message: "Artifact type must not be empty." });
      }
      if (node.mode === PlanNodeMode.IMPLEMENTATION) {
        issues.push({
          key: node.key,
          message: "Implementation mode requires an implementation output, not an artifact.",
        });
      }
    } else if (node.mode !== PlanNodeMode.IMPLEMENTATION) {
      issues.push({
        key: node.key,
        message: "Only implementation mode may use an implementation output.",
      });
    }
    if (!nodeExists(tree, node.parentKey)) {
      issues.push({ key: node.key, message: "Parent no longer exists in this plan." });
    }
    const sourceKeys = node.inputs.map((input) => input.sourceKey);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      issues.push({
        key: node.key,
        message: "Each artifact input source may be referenced at most once per node.",
      });
    }
  }
  const usage = computeBudgetUsage(tree);
  if (usage.nodeCount > budget.maxNodes) {
    issues.push({
      key: undefined,
      message: `Plan has ${String(usage.nodeCount)} nodes, exceeding the tree's max_nodes budget of ${String(budget.maxNodes)}.`,
    });
  }
  if (usage.maxDepthUsed > budget.maxDepth) {
    issues.push({
      key: undefined,
      message: `Plan reaches depth ${String(usage.maxDepthUsed)}, exceeding the tree's max_depth budget of ${String(budget.maxDepth)}.`,
    });
  }
  if (usage.maxFanOutUsed > budget.maxFanOut) {
    issues.push({
      key: undefined,
      message: `A node has ${String(usage.maxFanOutUsed)} children, exceeding the tree's max_fan_out budget of ${String(budget.maxFanOut)}.`,
    });
  }
  for (const stale of computeStaleInputs(tree)) {
    issues.push({ key: stale.nodeKey, message: `Stale artifact input: ${stale.detail}` });
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Mutators — every edit the operator can make, expressed as WorkingTree -> WorkingTree
// ---------------------------------------------------------------------------------------------

const DEFAULT_ALLOWED_PATH = ".";

export function addWorkingNode(
  tree: WorkingTree,
  parentKey: string,
): Readonly<{ tree: WorkingTree; key: string }> {
  const key = generateUuidV7();
  const node: WorkingNode = {
    key,
    sourceNodeId: undefined,
    parentKey,
    mode: PlanNodeMode.PLAN,
    objective: "",
    acceptanceCriteria: [""],
    inputs: [],
    outputContract: { case: "implementation" },
    allowedRepositoryPaths: [DEFAULT_ALLOWED_PATH],
  };
  return { tree: { ...tree, working: [...tree.working, node] }, key };
}

export type WorkingNodePatch = Partial<
  Pick<
    WorkingNode,
    | "objective"
    | "mode"
    | "acceptanceCriteria"
    | "inputs"
    | "outputContract"
    | "allowedRepositoryPaths"
  >
>;

export function updateWorkingNode(
  tree: WorkingTree,
  key: string,
  patch: WorkingNodePatch,
): WorkingTree {
  return {
    ...tree,
    working: tree.working.map((node) => (node.key === key ? { ...node, ...patch } : node)),
  };
}

/** Removes a working node AND every working descendant (locked nodes can never be a working
 *  node's descendant — a locked node's parent is always a fixed, already-persisted id, never a
 *  not-yet-submitted working key — so cascading only ever removes other unstarted rows). */
export function removeWorkingNode(tree: WorkingTree, key: string): WorkingTree {
  const toRemove = new Set([key, ...descendantKeySet(tree, key)]);
  return { ...tree, working: tree.working.filter((node) => !toRemove.has(node.key)) };
}

/** Re-parents a working node, throwing if the target is not one of {@link validParentOptions}
 *  — the editor UI only ever offers that list, so this is a defensive re-check, not the
 *  primary gate. */
export function reparentWorkingNode(
  tree: WorkingTree,
  key: string,
  newParentKey: string,
): WorkingTree {
  const options = validParentOptions(tree, key);
  if (!options.some((option) => option.key === newParentKey)) {
    throw new RangeError("selected parent is not a valid choice for this node");
  }
  return {
    ...tree,
    working: tree.working.map((node) =>
      node.key === key ? { ...node, parentKey: newParentKey } : node,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Plan-revision diff (working copy vs. the last-fetched TaskTree)
// ---------------------------------------------------------------------------------------------

type DiffKind = "added" | "removed" | "changed" | "unchanged";

export interface PlanDiffEntry {
  readonly key: string;
  readonly kind: DiffKind;
  readonly objective: string;
  readonly changes: readonly string[];
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function describeFieldChanges(
  original: TaskNode,
  working: WorkingNode,
  rootId: string,
): readonly string[] {
  const changes: string[] = [];
  if (original.objective !== working.objective) changes.push("objective");
  if (original.mode !== working.mode) changes.push("mode");
  if ((original.parentNodeId ?? rootId) !== working.parentKey) changes.push("parent");
  if (!sameStringArray(original.acceptanceCriteria, working.acceptanceCriteria)) {
    changes.push("acceptance criteria");
  }
  if (!sameStringArray(original.allowedRepositoryPaths, working.allowedRepositoryPaths)) {
    changes.push("allowed paths");
  }
  const originalCase = original.outputContract.case;
  if (originalCase !== working.outputContract.case) {
    changes.push("output contract");
  } else if (
    originalCase === "artifact" &&
    working.outputContract.case === "artifact" &&
    original.outputContract.value.artifactType !== working.outputContract.artifactType
  ) {
    changes.push("artifact type");
  }
  const originalInputs = new Set(original.inputs.map((input) => input.sourceNodeId));
  const workingInputs = new Set(working.inputs.map((input) => input.sourceKey));
  if (
    originalInputs.size !== workingInputs.size ||
    [...originalInputs].some((id) => !workingInputs.has(id))
  ) {
    changes.push("inputs");
  }
  return changes;
}

/** Diffs the CURRENT working copy against `originalNodesById` (see `indexNodesById`, built from
 *  the last-fetched/mutated `TaskTree`) — the only diff derivable from the API's data: revision
 *  bodies themselves aren't retained, but every node's own history is (see this module's doc
 *  comment). "added" = a working row with no `sourceNodeId`, or whose `sourceNodeId` no longer
 *  resolves. "removed" = an original unstarted (PLANNED/READY) node no longer kept by any
 *  working row. "changed"/"unchanged" compare a kept row's live fields to its original ones. */
export function computePlanDiff(
  tree: WorkingTree,
  originalNodesById: ReadonlyMap<string, TaskNode>,
): readonly PlanDiffEntry[] {
  const entries: PlanDiffEntry[] = [];
  const keptSourceIds = new Set<string>();
  for (const node of tree.working) {
    if (node.sourceNodeId === undefined) {
      entries.push({ key: node.key, kind: "added", objective: node.objective, changes: [] });
      continue;
    }
    keptSourceIds.add(node.sourceNodeId);
    const original = originalNodesById.get(node.sourceNodeId);
    if (original === undefined) {
      entries.push({ key: node.key, kind: "added", objective: node.objective, changes: [] });
      continue;
    }
    const changes = describeFieldChanges(original, node, tree.rootId);
    entries.push({
      key: node.key,
      kind: changes.length === 0 ? "unchanged" : "changed",
      objective: node.objective,
      changes,
    });
  }
  for (const [id, original] of originalNodesById) {
    if (id === tree.rootId) continue;
    if (isLockedState(original.state)) continue;
    if (!keptSourceIds.has(id)) {
      entries.push({ key: id, kind: "removed", objective: original.objective, changes: [] });
    }
  }
  return entries;
}

export function hasPendingChanges(entries: readonly PlanDiffEntry[]): boolean {
  return entries.some((entry) => entry.kind !== "unchanged");
}

// ---------------------------------------------------------------------------------------------
// Wire payload construction — the ONLY function allowed to produce a `ProposedNode[]`
// ---------------------------------------------------------------------------------------------

function mustGet<V>(map: ReadonlyMap<string, V>, key: string, what: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing ${what} for "${key}"`);
  return value;
}

/** Builds the complete `ProposedNode[]` array for a `ProposePlan`/`RepairPlan` call — the FULL
 *  next shape of the tree's living (locked ∪ working) nodes, per this module's doc comment.
 *  Mints a brand-new UUIDv7 for every working node (and every artifact output) unconditionally,
 *  since the server never allows a node id to be reused. Throws (never silently drops) if a
 *  reference can't be resolved — `validateWorkingTree` is expected to have already blocked the
 *  caller from reaching this with a broken working copy. */
export function buildProposedNodes(tree: WorkingTree): ProposedNode[] {
  const freshNodeIds = new Map<string, string>();
  const freshArtifactIds = new Map<string, string>();
  for (const node of tree.working) {
    freshNodeIds.set(node.key, generateUuidV7());
    if (node.outputContract.case === "artifact") {
      freshArtifactIds.set(node.key, generateUuidV7());
    }
  }
  const resolveNodeId = (key: string): string =>
    tree.locked.get(key)?.id ?? mustGet(freshNodeIds, key, "node id");
  const resolveArtifactId = (key: string): string => {
    const locked = tree.locked.get(key);
    if (locked !== undefined) {
      if (locked.outputContract.case !== "artifact") {
        throw new Error(`node "${key}" has no artifact output to reference`);
      }
      return locked.outputContract.artifactId;
    }
    return mustGet(freshArtifactIds, key, "artifact id");
  };

  return tree.working.map((node) => {
    const fields = {
      nodeId: mustGet(freshNodeIds, node.key, "node id"),
      parentNodeId: resolveNodeId(node.parentKey),
      mode: node.mode,
      objective: node.objective,
      acceptanceCriteria: [...node.acceptanceCriteria],
      inputs: node.inputs.map((input) =>
        create(ArtifactInputSchema, {
          artifactId: resolveArtifactId(input.sourceKey),
          sourceNodeId: resolveNodeId(input.sourceKey),
        }),
      ),
      allowedRepositoryPaths: [...node.allowedRepositoryPaths],
    };
    if (node.outputContract.case === "artifact") {
      return create(ProposedNodeSchema, {
        ...fields,
        outputContract: {
          case: "artifact",
          value: create(ArtifactOutputContractSchema, {
            artifactId: mustGet(freshArtifactIds, node.key, "artifact id"),
            artifactType: node.outputContract.artifactType,
          }),
        },
      });
    }
    return create(ProposedNodeSchema, {
      ...fields,
      outputContract: {
        case: "implementation",
        value: create(ImplementationOutputContractSchema, {}),
      },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Flattened outline order (depth-first) — the shape the virtualized outline and the canvas
// both render from.
// ---------------------------------------------------------------------------------------------

export interface OutlineRow {
  readonly key: string;
  readonly depth: number;
  readonly locked: boolean;
  readonly isRoot: boolean;
  /** `undefined` for a working (not yet submitted) row — it has no server-assigned state. */
  readonly state: NodeState | undefined;
  readonly mode: PlanNodeMode;
  readonly objective: string;
  readonly stale: boolean;
}

export function flattenOutline(
  tree: WorkingTree,
  staleNodeKeys: ReadonlySet<string>,
): readonly OutlineRow[] {
  const rows: OutlineRow[] = [];
  const visit = (key: string, depth: number): void => {
    const locked = tree.locked.get(key);
    if (locked !== undefined) {
      rows.push({
        key,
        depth,
        locked: true,
        isRoot: locked.isRoot,
        state: locked.state,
        mode: locked.mode,
        objective: locked.objective,
        stale: staleNodeKeys.has(key),
      });
    } else {
      const working = findWorking(tree, key);
      if (working === undefined) return;
      rows.push({
        key,
        depth,
        locked: false,
        isRoot: false,
        state: undefined,
        mode: working.mode,
        objective: working.objective,
        stale: staleNodeKeys.has(key),
      });
    }
    for (const child of childKeys(tree, key)) visit(child, depth + 1);
  };
  visit(tree.rootId, 0);
  return rows;
}

export interface CanvasDatum {
  readonly key: string;
  readonly label: string;
  readonly depth: number;
  readonly locked: boolean;
  readonly stale: boolean;
  readonly children: CanvasDatum[];
}

/** A read-only tree view for `tree-layout.ts` to lay out with `d3-hierarchy` — layout only,
 *  never a second source of truth for parent/child relationships (see this module's doc
 *  comment). */
export function buildCanvasTree(
  tree: WorkingTree,
  staleNodeKeys: ReadonlySet<string>,
): CanvasDatum {
  const build = (key: string, depth: number): CanvasDatum => ({
    key,
    label: nodeLabel(tree, key),
    depth,
    locked: tree.locked.has(key),
    stale: staleNodeKeys.has(key),
    children: childKeys(tree, key).map((childKey) => build(childKey, depth + 1)),
  });
  return build(tree.rootId, 0);
}
