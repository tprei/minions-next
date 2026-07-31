/**
 * Stack-parentage manager (PR 33, deliverable 2).
 *
 * Composes the GitHub PR client (PR 31/32 surface) + the vcs-change binding
 * store (PR 29) + the pure stack-parentage domain (stack-parentage.ts) into the
 * operations that keep a stack consistent on GitHub:
 *
 * - {@link StackParentageManager.ensureStackParentage}: build the stack path from
 *   the domain, then retarget any PR whose base has drifted off its parent.
 * - {@link StackParentageManager.retargetAfterParentLanding}: when a parent
 *   lands, repoint its children at the grandparent's branch (parent-first).
 * - {@link StackParentageManager.verifyNoFanIn}: cross-check the live GitHub PR
 *   bases against the expected topology; reject drift / fan-in (GIT-06).
 *
 * Every branch has exactly one parent. No Graphite metadata is required — the
 * branch names and PR bases recover the stack.
 */
import {
  buildStackPath,
  determineBranchName,
  retargetAfterLanding,
  STACK_TRUNK_BRANCH,
  StackParentageError,
  type ContentHash,
  type RetargetPlan,
  type StackNode,
  type StackPosition,
  type TaskNodeId,
  type TaskTreeId,
  type VcsChangeBinding,
  type VcsChangeBindingStore,
} from "@minions/core";
import type { GitHubClient, GitHubPullRequest } from "./github-client.js";

// -------------------------------------------------------------------------------------------------
// Public surface.
// -------------------------------------------------------------------------------------------------

export interface StackParentageManagerOptions {
  /** GitHub REST client (PR 31) used to read + retarget PR bases. */
  readonly client: GitHubClient;
  /** Durable node↔change bindings (PR 29), the source of tree parentage. */
  readonly bindingStore: VcsChangeBindingStore;
  /** `owner/repo` the stack lives on. */
  readonly repositoryFullName: string;
  /** Trunk a root node targets. Defaults to `main`. */
  readonly trunk?: string;
}

export interface StackParentageManager {
  /**
   * Build the stack path for `nodes` and retarget any PR whose base has drifted
   * off its expected parent branch. Returns the canonical positions (root-first).
   * PRs that do not yet exist are left to PR 32's createOrUpdatePR.
   */
  ensureStackParentage(
    treeId: TaskTreeId,
    nodes: readonly StackNode[],
  ): Promise<readonly StackPosition[]>;

  /**
   * After `landedNodeId` merges, retarget every direct child's PR at the
   * grandparent's branch (or the trunk). Returns the plans applied, parent-first.
   */
  retargetAfterParentLanding(
    treeId: TaskTreeId,
    landedNodeId: TaskNodeId,
  ): Promise<readonly RetargetPlan[]>;

  /**
   * Cross-check the live GitHub PR bases against the expected stack topology and
   * reject drift / fan-in. Acceptance (GIT-06): every branch has one parent.
   */
  verifyNoFanIn(treeId: TaskTreeId): Promise<void>;
}

export function createStackParentageManager(
  options: StackParentageManagerOptions,
): StackParentageManager {
  const trunk = options.trunk ?? STACK_TRUNK_BRANCH;
  const repositoryFullName = options.repositoryFullName;
  if (repositoryFullName.length === 0) {
    throw new StackParentageError("invalid_input", "repositoryFullName must be non-empty");
  }
  if (trunk.length === 0) {
    throw new StackParentageError("invalid_input", "trunk must be non-empty");
  }
  ownerOf(repositoryFullName); // validate format up front
  return new StackParentageManagerImpl(
    options.client,
    options.bindingStore,
    repositoryFullName,
    trunk,
  );
}

// -------------------------------------------------------------------------------------------------
// Implementation.
// -------------------------------------------------------------------------------------------------

const repositoryFullNamePattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

class StackParentageManagerImpl implements StackParentageManager {
  constructor(
    private readonly client: GitHubClient,
    private readonly bindingStore: VcsChangeBindingStore,
    private readonly repositoryFullName: string,
    private readonly trunk: string,
  ) {}

  async ensureStackParentage(
    treeId: TaskTreeId,
    nodes: readonly StackNode[],
  ): Promise<readonly StackPosition[]> {
    const positions = buildStackPath(nodes, this.trunk);
    const nodesTreeId = positions[0]?.treeId;
    if (nodesTreeId !== undefined && nodesTreeId !== treeId) {
      throw new StackParentageError(
        "invalid_input",
        `nodes belong to tree '${nodesTreeId}', not '${treeId}'`,
      );
    }
    for (const pos of positions) {
      await this.retargetIfDrifted(pos.branch, pos.baseBranch);
    }
    return positions;
  }

  async retargetAfterParentLanding(
    treeId: TaskTreeId,
    landedNodeId: TaskNodeId,
  ): Promise<readonly RetargetPlan[]> {
    const nodes = await this.loadStackNodes(treeId);
    const plans: RetargetPlan[] = [];
    for (const node of nodes) {
      if (!node.parentIds.includes(landedNodeId)) {
        continue;
      }
      const plan = retargetAfterLanding(landedNodeId, node.nodeId, nodes, this.trunk);
      plans.push(plan);
      await this.retargetIfDrifted(
        determineBranchName(plan.treeId, plan.childNodeId),
        plan.newBaseBranch,
      );
    }
    return Object.freeze(plans);
  }

  async verifyNoFanIn(treeId: TaskTreeId): Promise<void> {
    const nodes = await this.loadStackNodes(treeId);
    // Domain-level topology check: rejects fan-in, orphan, cycle, duplicate.
    const positions = buildStackPath(nodes, this.trunk);
    const expectedBranches = new Set<string>();
    for (const pos of positions) {
      expectedBranches.add(pos.branch);
    }

    // Cross-check live GitHub bases against the expected parent for each branch.
    for (const pos of positions) {
      const pr = await this.findOpenPr(pos.branch);
      if (pr === undefined) {
        continue; // no PR open yet — nothing to cross-check
      }
      if (pr.baseRefName === pos.baseBranch) {
        continue; // healthy: base matches the expected single parent
      }
      // Drifted base. If it points at another stack branch, the branch now has an
      // unexpected parent within the stack (fan-in); otherwise it is orphaned.
      const code = expectedBranches.has(pr.baseRefName) ? "fan_in" : "drift";
      throw new StackParentageError(
        code,
        `PR #${String(pr.number)} (branch '${pos.branch}') base '${pr.baseRefName}' ` +
          `does not match expected parent '${pos.baseBranch}'`,
      );
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Internals.
  // -----------------------------------------------------------------------------------------------

  private async loadStackNodes(treeId: TaskTreeId): Promise<readonly StackNode[]> {
    let bindings: readonly VcsChangeBinding[];
    try {
      bindings = await this.bindingStore.listForTree(treeId);
    } catch (error: unknown) {
      throw new StackParentageError(
        "binding_lookup_failed",
        `failed to load bindings for tree '${treeId}': ${errorMessage(error)}`,
        error,
      );
    }
    if (bindings.length === 0) {
      throw new StackParentageError(
        "node_not_found",
        `no vcs change bindings found for tree '${treeId}'`,
      );
    }
    return bindingsToStackNodes(bindings);
  }

  private async retargetIfDrifted(branch: string, expectedBase: string): Promise<void> {
    const pr = await this.findOpenPr(branch);
    if (pr === undefined || pr.baseRefName === expectedBase) {
      return;
    }
    try {
      await this.client.updatePullRequest(this.repositoryFullName, pr.number, {
        title: undefined,
        body: undefined,
        base: expectedBase,
        state: undefined,
      });
    } catch (error: unknown) {
      throw wrapApi(error, `retarget PR #${String(pr.number)} base to '${expectedBase}'`);
    }
  }

  private async findOpenPr(branch: string): Promise<GitHubPullRequest | undefined> {
    const headFilter = `${ownerOf(this.repositoryFullName)}:${branch}`;
    let prs: readonly GitHubPullRequest[];
    try {
      prs = await this.client.listPullRequests(this.repositoryFullName, {
        head: headFilter,
        state: "open",
      });
    } catch (error: unknown) {
      throw wrapApi(error, `list open PRs for head '${headFilter}'`);
    }
    if (prs.length > 1) {
      throw new StackParentageError(
        "fan_in",
        `found ${String(prs.length)} open PRs for branch '${branch}'; ` +
          `expected at most one (one-PR-per-branch, GIT-03)`,
      );
    }
    return prs[0];
  }
}

// -------------------------------------------------------------------------------------------------
// Binding → stack-node projection + helpers.
// -------------------------------------------------------------------------------------------------

/**
 * Project durable bindings into stack nodes. Each binding carries a single
 * `parentChangeId`; a parent change that resolves to no node in the tree is an
 * orphan (fail-closed). One parent per node by construction — fan-in cannot
 * arise from bindings, only from drifted GitHub bases (caught by verifyNoFanIn).
 */
function bindingsToStackNodes(bindings: readonly VcsChangeBinding[]): readonly StackNode[] {
  const nodeByChange = new Map<ContentHash, TaskNodeId>();
  for (const binding of bindings) {
    nodeByChange.set(binding.jjChangeId, binding.nodeId);
  }

  return bindings.map((binding) => {
    const parentIds: TaskNodeId[] = [];
    const parentChangeId = binding.parentChangeId;
    if (parentChangeId !== undefined) {
      const parentNodeId = nodeByChange.get(parentChangeId);
      if (parentNodeId === undefined) {
        throw new StackParentageError(
          "orphan",
          `binding for node '${binding.nodeId}' references parent change '${parentChangeId}' ` +
            `that is not bound to any node in tree '${binding.treeId}'`,
        );
      }
      parentIds.push(parentNodeId);
    }
    return Object.freeze({
      treeId: binding.treeId,
      nodeId: binding.nodeId,
      parentIds: Object.freeze(parentIds),
    });
  });
}

function ownerOf(repositoryFullName: string): string {
  if (!repositoryFullNamePattern.test(repositoryFullName)) {
    throw new StackParentageError(
      "invalid_input",
      `invalid repository full name '${repositoryFullName}' (expected 'owner/repo')`,
    );
  }
  const slashIndex = repositoryFullName.indexOf("/");
  return repositoryFullName.slice(0, slashIndex);
}

function wrapApi(error: unknown, context: string): StackParentageError {
  if (error instanceof StackParentageError) {
    return error;
  }
  return new StackParentageError("api_error", `${context}: ${errorMessage(error)}`, error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
