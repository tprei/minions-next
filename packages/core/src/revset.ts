/**
 * Scoped revset queries (PR 38, UI-02/05 + GIT-05).
 *
 * Pure, I/O-free domain for tree-topology queries over a registered task tree's
 * jj change bindings: descendants, ancestors, heads, conflicted, not-pushed, and
 * bookmarked. The registered tree is the trust boundary:
 *
 * - {@link buildRevsetExpression} intersects the jj revset with the tree's
 *   change-id set, so the produced expression can never reach a change outside
 *   the registered tree. The expression is what the adapter runs through
 *   `jj log`; it is the live layer.
 * - {@link filterBindings} projects the same six queries onto the durable
 *   binding table. Because a binding's `parentChangeId` encodes the tree
 *   topology, the descendants/ancestors/heads answers are computed from the
 *   binding table alone — the live jj answer and the binding table agree
 *   (results match bindings), and the adapter cross-checks one against the
 *   other to drop drift (fail-closed).
 *
 * This module is pure: no I/O. The {@link createRevsetManager} adapter (PR 38)
 * composes it with the pinned jj binary (PR 21) and the binding store (PR 29).
 */
import { DomainError } from "./domain-error.js";
import type { TaskNodeId, TaskTreeId } from "./value-objects.js";
import type { VcsChangeBinding } from "./vcs-change-binding.js";

// -------------------------------------------------------------------------------------------------
// Query + result shapes.
// -------------------------------------------------------------------------------------------------

/**
 * The six tree-topology queries. `descendants`/`ancestors` require a scope node;
 * the rest operate over the whole registered tree.
 */
export type RevsetQueryKind =
  "descendants" | "ancestors" | "heads" | "conflicted" | "not_pushed" | "bookmarked";

/** All recognized query kinds, in canonical order. */
export const REVSET_QUERY_KINDS: readonly RevsetQueryKind[] = Object.freeze([
  "descendants",
  "ancestors",
  "heads",
  "conflicted",
  "not_pushed",
  "bookmarked",
]);

/**
 * A scoped revset query. `treeId` is the registered tree the query is confined
 * to; `scopeNodeId` is required for `descendants`/`ancestors` and ignored
 * otherwise.
 */
export type RevsetQuery = Readonly<{
  readonly treeId: TaskTreeId;
  readonly kind: RevsetQueryKind;
  readonly scopeNodeId?: TaskNodeId;
}>;

/**
 * A scoped revset result. `changeIds` and `bindings` are always consistent:
 * every change id has a binding in the registered tree, and every binding's
 * change id appears in `changeIds` (results match the binding table).
 */
export type RevsetResult = Readonly<{
  readonly changeIds: readonly string[];
  readonly bindings: readonly VcsChangeBinding[];
}>;

// -------------------------------------------------------------------------------------------------
// Expression builder.
// -------------------------------------------------------------------------------------------------

/**
 * Context for {@link buildRevsetExpression}. Carries the revision tokens that
 * define the registered tree (and, for descendants/ancestors, the scope node's
 * revision token). The tokens are opaque to this pure layer: they must be
 * revision ids the underlying `jj` revset can resolve. The production adapter
 * supplies commit ids from `VcsChangeBinding.currentCommitId`, and the
 * caller's cross-check must use the same token space.
 */
export type RevsetExpressionScope = Readonly<{
  /** Change-id tokens that constitute the registered tree. May be empty. */
  readonly treeChangeIds: readonly string[];
  /**
   * Change-id token of the scope node. Required for `descendants`/`ancestors`;
   * ignored otherwise.
   */
  readonly scopeChangeId?: string;
}>;

/** jj revset evaluating to the empty set (no change). */
export const EMPTY_REVSET = "none()";

/**
 * Build a jj revset for `query`, scoped to the registered tree. The expression
 * is ALWAYS intersected with the tree's change-id set, so it can never escape
 * the registered tree. For `descendants`/`ancestors` a `scopeChangeId` is
 * required (fail-closed). An empty tree yields {@link EMPTY_REVSET}.
 */
export function buildRevsetExpression(query: RevsetQuery, scope: RevsetExpressionScope): string {
  assertQueryKind(query.kind);
  const tree = treeUnion(scope.treeChangeIds);
  switch (query.kind) {
    case "descendants":
      return `descendants(${requireScopeChangeId(query, scope)}) & ${tree}`;
    case "ancestors":
      return `ancestors(${requireScopeChangeId(query, scope)}) & ${tree}`;
    case "heads":
      return `heads(${tree})`;
    case "conflicted":
      return `conflict & ${tree}`;
    case "not_pushed":
      // jj has no native "not pushed" predicate; the binding table is
      // authoritative for push state, so the expression is just the tree set
      // and {@link filterBindings} applies the not-pushed filter.
      return tree;
    case "bookmarked":
      return `bookmarks() & ${tree}`;
  }
}

/**
 * Reduce a list of change-id tokens to the jj revset that matches exactly that
 * set. An empty list reduces to {@link EMPTY_REVSET} so a degenerate tree can
 * never expand the revset.
 */
export function treeUnion(changeIds: readonly string[]): string {
  if (changeIds.length === 0) return EMPTY_REVSET;
  return changeIds.map((id) => `(${id})`).join(" | ");
}

// -------------------------------------------------------------------------------------------------
// Binding-table projection.
// -------------------------------------------------------------------------------------------------

/**
 * Project `query` onto the binding table. `bindings` MUST already be scoped to
 * the query's tree (the adapter does this via `listForTree`); this helper never
 * looks beyond the list it is given, so it cannot escape the tree.
 *
 * - `descendants`/`ancestors` require the scope node to be present in
 *   `bindings` (fail-closed otherwise); the topology is recovered from each
 *   binding's `parentChangeId`.
 * - `heads` are the bindings no other binding declares as a parent.
 * - `conflicted`/`not_pushed`/`bookmarked` are direct property filters.
 */
export function filterBindings(
  bindings: readonly VcsChangeBinding[],
  query: RevsetQuery,
): readonly VcsChangeBinding[] {
  assertQueryKind(query.kind);
  switch (query.kind) {
    case "descendants":
      return descendantsOf(bindings, requireScopeBinding(bindings, query));
    case "ancestors":
      return ancestorsOf(bindings, requireScopeBinding(bindings, query));
    case "heads":
      return headsOf(bindings);
    case "conflicted":
      return bindings.filter((binding) => binding.conflictState === "conflict");
    case "not_pushed":
      return bindings.filter((binding) => binding.lastPushedCommitId === undefined);
    case "bookmarked":
      return bindings.filter((binding) => binding.bookmark !== undefined);
  }
}

// -------------------------------------------------------------------------------------------------
// Topology helpers (pure; derived from parentChangeId).
// -------------------------------------------------------------------------------------------------

/** Index bindings by their jj change id. */
function indexByChangeId(
  bindings: readonly VcsChangeBinding[],
): ReadonlyMap<string, VcsChangeBinding> {
  const map = new Map<string, VcsChangeBinding>();
  for (const binding of bindings) {
    map.set(binding.jjChangeId, binding);
  }
  return map;
}

/** Index bindings by the parent change id they declare (children of that parent). */
function indexChildrenByParent(
  bindings: readonly VcsChangeBinding[],
): ReadonlyMap<string, readonly VcsChangeBinding[]> {
  const map = new Map<string, VcsChangeBinding[]>();
  for (const binding of bindings) {
    const parent = binding.parentChangeId;
    if (parent === undefined) continue;
    const list = map.get(parent);
    if (list === undefined) {
      map.set(parent, [binding]);
    } else {
      list.push(binding);
    }
  }
  return map;
}

/** The scope binding plus every transitive descendant (BFS, cycle-guarded). */
function descendantsOf(
  bindings: readonly VcsChangeBinding[],
  scope: VcsChangeBinding,
): readonly VcsChangeBinding[] {
  const childrenByParent = indexChildrenByParent(bindings);
  const result: VcsChangeBinding[] = [scope];
  const seen = new Set<string>([scope.jjChangeId]);
  const queue: VcsChangeBinding[] = [scope];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const children = childrenByParent.get(current.jjChangeId);
    if (children === undefined) continue;
    for (const child of children) {
      if (seen.has(child.jjChangeId)) continue;
      seen.add(child.jjChangeId);
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}

/** The scope binding plus every transitive ancestor (walks parentChangeId). */
function ancestorsOf(
  bindings: readonly VcsChangeBinding[],
  scope: VcsChangeBinding,
): readonly VcsChangeBinding[] {
  const byChangeId = indexByChangeId(bindings);
  const result: VcsChangeBinding[] = [scope];
  const seen = new Set<string>([scope.jjChangeId]);
  let current: VcsChangeBinding | undefined = scope;
  while (current.parentChangeId !== undefined) {
    const parent = byChangeId.get(current.parentChangeId);
    if (parent === undefined) break; // parent lives outside the tree (e.g. trunk) — stop
    if (seen.has(parent.jjChangeId)) break; // cycle guard
    seen.add(parent.jjChangeId);
    result.push(parent);
    current = parent;
  }
  return result;
}

/** Bindings no other binding declares as a parent (the tree's leaves). */
function headsOf(bindings: readonly VcsChangeBinding[]): readonly VcsChangeBinding[] {
  const parented = new Set<string>();
  for (const binding of bindings) {
    if (binding.parentChangeId !== undefined) {
      parented.add(binding.parentChangeId);
    }
  }
  return bindings.filter((binding) => !parented.has(binding.jjChangeId));
}

// -------------------------------------------------------------------------------------------------
// Validation helpers.
// -------------------------------------------------------------------------------------------------

function assertQueryKind(kind: RevsetQueryKind): void {
  if (!REVSET_QUERY_KINDS.includes(kind)) {
    throw new DomainError("invalid_value", `unknown revset query kind: ${kind}`);
  }
}

function requireScopeBinding(
  bindings: readonly VcsChangeBinding[],
  query: RevsetQuery,
): VcsChangeBinding {
  if (query.scopeNodeId === undefined) {
    throw new DomainError("invalid_value", `revset query '${query.kind}' requires a scopeNodeId`);
  }
  const scope = bindings.find((binding) => binding.nodeId === query.scopeNodeId);
  if (scope === undefined) {
    throw new DomainError(
      "not_found",
      `revset scope node '${query.scopeNodeId}' is not bound in the registered tree`,
    );
  }
  return scope;
}

function requireScopeChangeId(query: RevsetQuery, scope: RevsetExpressionScope): string {
  if (scope.scopeChangeId === undefined) {
    throw new DomainError(
      "invalid_value",
      `revset query '${query.kind}' requires a scope change id`,
    );
  }
  return scope.scopeChangeId;
}
