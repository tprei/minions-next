import { join } from "node:path";

import {
  create,
  type DescMessage,
  type MessageShape,
  type MessageValidType,
} from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  createRevsetManager,
  GateProfileError,
  loadGateProfile,
  PlanRegistryError,
  RepositoryRegistryError,
  type ConflictState,
  RevsetManagerError,
  type HostGateMinimum,
  type PlanAttentionRecord,
  type PlanRegistry,
  type PlanRevisionRecord,
  type RepositoryRegistry,
  type RevsetJjRunner,
  type RevsetManager,
  type TaskNodeRecord,
  type TreeRecord,
  type TreeSummaryRecord,
  type VcsChangeBinding,
} from "@minions/adapters";
import {
  ApprovePlanResponseSchema,
  ArtifactInputSchema,
  ArtifactOutputContractSchema,
  CreateTreeResponseSchema,
  ImplementationOutputContractSchema,
  GetReviewHeadersResponseSchema,
  GetTreeResponseSchema,
  ListTreesResponseSchema,
  NodeBudgetSchema,
  PlanAttentionSchema,
  PlanRevisionSchema,
  ProposePlanResponseSchema,
  RepairPlanResponseSchema,
  ReviewFreshness,
  ReviewHeaderSchema,
  TaskNodeSchema,
  TaskTreeSchema,
  TreeBudgetSchema,
  TreeService,
  TreeSummarySchema,
  VcsChangeBindingSchema,
  VcsConflictState,
} from "@minions/contracts";
import {
  repositoryId,
  timestampFromEpochMilliseconds,
  taskTreeId,
  type Clock,
  type ReviewFreshness as ReviewFreshnessDomain,
  type ReviewHeader,
  type VcsChangeBindingStore,
} from "@minions/core";

const responseValidator = createValidator();

/**
 * Optional jj revset capability for the review-header projection (PR 48). When present,
 * `getReviewHeaders` resolves a per-repository {@link RevsetManager} (cached across calls, so
 * its internal jj-invocation serialization holds across requests instead of letting concurrent
 * RPCs interleave on the shared jj op log) bound to `join(hostRoot, repositoryId)` — the same
 * central jj repo path `JjCentralRepoManager` bootstraps. Omitted, `getReviewHeaders` fails
 * closed with `FailedPrecondition`.
 */
export type TreeServiceRevsetOptions = Readonly<{
  /** Absolute path to the pinned, digest-verified jj binary (from ensureJjCapability). */
  jjBinaryPath: string;
  /** Absolute host-local root under which per-repository central jj repos live. */
  hostRoot: string;
  /** Durable node<->change bindings (PR 29); read tree-scoped by the review projection. */
  bindingStore: VcsChangeBindingStore;
  /** Test seam: overrides the jj subprocess runner (see RevsetManagerOptions.runJj). */
  runJj?: RevsetJjRunner;
}>;

export type TreeServiceOptions = Readonly<{
  planRegistry: PlanRegistry;
  clock: Clock;
  vcsChangeBindingStore: VcsChangeBindingStore;
  repositoryRegistry?: RepositoryRegistry;
  hostMinimum?: HostGateMinimum;
  revset?: TreeServiceRevsetOptions;
}>;

export function registerTreeService(router: ConnectRouter, options: TreeServiceOptions): void {
  // Cached per repository: a RevsetManager serializes its own jj invocations against one
  // working copy, so reusing the same instance across calls (rather than constructing a
  // fresh one per request) preserves that serialization instead of letting concurrent RPCs
  // interleave on the shared jj op log.
  const revsetManagers = new Map<string, RevsetManager>();
  function revsetManagerForRepository(repoId: string): RevsetManager {
    const revset = options.revset;
    if (revset === undefined) {
      throw new ConnectError(
        "jj revset capability is not enabled on this daemon",
        Code.FailedPrecondition,
      );
    }
    let manager = revsetManagers.get(repoId);
    if (manager === undefined) {
      manager = createRevsetManager({
        jjBinaryPath: revset.jjBinaryPath,
        workingCopyPath: join(revset.hostRoot, repoId),
        bindingStore: revset.bindingStore,
        ...(revset.runJj === undefined ? {} : { runJj: revset.runJj }),
      });
      revsetManagers.set(repoId, manager);
    }
    return manager;
  }

  router.service(TreeService, {
    async createTree(request) {
      try {
        if (options.repositoryRegistry === undefined) {
          throw new ConnectError(
            "repository registry is required to enforce the gate profile",
            Code.FailedPrecondition,
          );
        }
        const repository = options.repositoryRegistry.get(repositoryId(request.repositoryId));
        await loadGateProfile(repository.canonicalRoot, options.hostMinimum);
        const tree = await options.planRegistry.create({
          request,
          at: timestampFromEpochMilliseconds(options.clock.now()),
        });
        const bindings = await loadBindingsByNodeId(options.vcsChangeBindingStore, tree);
        return validateResponse(
          CreateTreeResponseSchema,
          create(CreateTreeResponseSchema, { tree: toTreeMessage(tree, bindings) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    async getTree(request) {
      try {
        const tree = options.planRegistry.get(parseTreeId(request.treeId));
        const bindings = await loadBindingsByNodeId(options.vcsChangeBindingStore, tree);
        return validateResponse(
          GetTreeResponseSchema,
          create(GetTreeResponseSchema, { tree: toTreeMessage(tree, bindings) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    listTrees(request) {
      try {
        const afterId =
          request.pageToken === undefined ? undefined : parseTreeId(request.pageToken);
        const rows = options.planRegistry.list({ afterId, limit: request.pageSize + 1 });
        const trees = rows.slice(0, request.pageSize);
        const next = rows.at(request.pageSize);
        return validateResponse(
          ListTreesResponseSchema,
          create(ListTreesResponseSchema, {
            trees: trees.map(toTreeSummaryMessage),
            ...(next === undefined ? {} : { nextPageToken: trees.at(-1)?.id }),
          }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    async proposePlan(request) {
      try {
        const tree = await options.planRegistry.propose({
          request,
          at: timestampFromEpochMilliseconds(options.clock.now()),
        });
        const bindings = await loadBindingsByNodeId(options.vcsChangeBindingStore, tree);
        return validateResponse(
          ProposePlanResponseSchema,
          create(ProposePlanResponseSchema, { tree: toTreeMessage(tree, bindings) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    async repairPlan(request) {
      try {
        const tree = await options.planRegistry.repair({
          request,
          at: timestampFromEpochMilliseconds(options.clock.now()),
        });
        const bindings = await loadBindingsByNodeId(options.vcsChangeBindingStore, tree);
        return validateResponse(
          RepairPlanResponseSchema,
          create(RepairPlanResponseSchema, { tree: toTreeMessage(tree, bindings) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    async approvePlan(request) {
      try {
        const tree = await options.planRegistry.approve({
          request,
          at: timestampFromEpochMilliseconds(options.clock.now()),
        });
        const bindings = await loadBindingsByNodeId(options.vcsChangeBindingStore, tree);
        return validateResponse(
          ApprovePlanResponseSchema,
          create(ApprovePlanResponseSchema, { tree: toTreeMessage(tree, bindings) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    async getReviewHeaders(request) {
      try {
        const treeId = parseTreeId(request.treeId);
        const tree = options.planRegistry.get(treeId);
        const manager = revsetManagerForRepository(tree.repositoryId);
        const headers = await manager.reviewHeaders(treeId);
        return validateResponse(
          GetReviewHeadersResponseSchema,
          create(GetReviewHeadersResponseSchema, { headers: headers.map(toReviewHeaderMessage) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
  });
}

function toTreeMessage(tree: TreeRecord, bindings: ReadonlyMap<string, VcsChangeBinding>) {
  return create(TaskTreeSchema, {
    id: tree.id,
    repositoryId: tree.repositoryId,
    hostId: tree.hostId,
    baseCommit: tree.baseCommit,
    goal: tree.goal,
    activePlanRevisionId: tree.activePlanRevisionId,
    rootNodeId: tree.rootNodeId,
    state: tree.state,
    version: BigInt(tree.version),
    createdAt: timestampMessage(tree.createdAt),
    updatedAt: timestampMessage(tree.updatedAt),
    revisions: tree.revisions.map(toPlanRevisionMessage),
    nodes: tree.nodes.map((node) => toTaskNodeMessage(node, bindings.get(node.id))),
    budget: create(TreeBudgetSchema, tree.budget),
    ...(tree.attention === undefined ? {} : { attention: toAttentionMessage(tree.attention) }),
  });
}

function toPlanRevisionMessage(revision: PlanRevisionRecord) {
  return create(PlanRevisionSchema, {
    id: revision.id,
    treeId: revision.treeId,
    ordinal: BigInt(revision.ordinal),
    goal: revision.goal,
    state: revision.state,
    version: BigInt(revision.version),
    createdAt: timestampMessage(revision.createdAt),
    ...(revision.approvedAt === undefined
      ? {}
      : { approvedAt: timestampMessage(revision.approvedAt) }),
    ...(revision.supersededAt === undefined
      ? {}
      : { supersededAt: timestampMessage(revision.supersededAt) }),
  });
}

function toTaskNodeMessage(node: TaskNodeRecord, binding: VcsChangeBinding | undefined) {
  const outputContract =
    node.outputContract.case === "artifact"
      ? {
          case: "artifact" as const,
          value: create(ArtifactOutputContractSchema, node.outputContract.value),
        }
      : {
          case: "implementation" as const,
          value: create(ImplementationOutputContractSchema, {}),
        };
  return create(TaskNodeSchema, {
    id: node.id,
    treeId: node.treeId,
    repositoryId: node.repositoryId,
    hostId: node.hostId,
    ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
    planRevisionId: node.planRevisionId,
    mode: node.mode,
    objective: node.objective,
    acceptanceCriteria: [...node.acceptanceCriteria],
    inputs: node.inputs.map((input) => create(ArtifactInputSchema, input)),
    outputContract,
    allowedRepositoryPaths: [...node.allowedRepositoryPaths],
    budget: create(NodeBudgetSchema, { maxAttempts: node.budget.maxAttempts }),
    state: node.state,
    version: BigInt(node.version),
    createdAt: timestampMessage(node.createdAt),
    updatedAt: timestampMessage(node.updatedAt),
    ...(binding === undefined ? {} : { vcsChangeBinding: toVcsChangeBindingMessage(binding) }),
  });
}

function toVcsChangeBindingMessage(binding: VcsChangeBinding) {
  return create(VcsChangeBindingSchema, {
    jjChangeId: binding.jjChangeId,
    currentCommitId: binding.currentCommitId,
    ...(binding.parentChangeId === undefined ? {} : { parentChangeId: binding.parentChangeId }),
    ...(binding.bookmark === undefined ? {} : { bookmark: binding.bookmark }),
    rewriteGeneration: binding.rewriteGeneration,
    lastJjOperationId: binding.lastJjOperationId,
    ...(binding.lastPushedCommitId === undefined
      ? {}
      : { lastPushedCommitId: binding.lastPushedCommitId }),
    ...(binding.lastReviewedCommitId === undefined
      ? {}
      : { lastReviewedCommitId: binding.lastReviewedCommitId }),
    conflictState: vcsConflictStateMessage(binding.conflictState),
  });
}

function vcsConflictStateMessage(state: ConflictState): VcsConflictState {
  switch (state) {
    case "clean":
      return VcsConflictState.CLEAN;
    case "conflict":
      return VcsConflictState.CONFLICT;
    case "resolved":
      return VcsConflictState.RESOLVED;
  }
}

async function loadBindingsByNodeId(
  store: VcsChangeBindingStore,
  tree: TreeRecord,
): Promise<ReadonlyMap<string, VcsChangeBinding>> {
  const bindings = await store.listForTree(tree.id);
  return new Map(bindings.map((binding) => [binding.nodeId, binding] as const));
}

function toAttentionMessage(attention: PlanAttentionRecord) {
  return create(PlanAttentionSchema, {
    id: attention.id,
    treeId: attention.treeId,
    ...(attention.planRevisionId === undefined ? {} : { planRevisionId: attention.planRevisionId }),
    kind: attention.kind,
    message: attention.message,
    state: attention.state,
    createdAt: timestampMessage(attention.createdAt),
    ...(attention.resolvedAt === undefined
      ? {}
      : { resolvedAt: timestampMessage(attention.resolvedAt) }),
  });
}

function toTreeSummaryMessage(summary: TreeSummaryRecord) {
  return create(TreeSummarySchema, {
    id: summary.id,
    repositoryId: summary.repositoryId,
    hostId: summary.hostId,
    rootNodeId: summary.rootNodeId,
    activePlanRevisionId: summary.activePlanRevisionId,
    state: summary.state,
    version: BigInt(summary.version),
  });
}

function toReviewHeaderMessage(header: ReviewHeader) {
  return create(ReviewHeaderSchema, {
    nodeId: header.nodeId,
    logicalChangeId: header.logicalChangeId,
    rewriteGeneration: header.rewriteGeneration,
    ...(header.parentChangeId === undefined ? {} : { parentChangeId: header.parentChangeId }),
    contentChangedSinceReview: header.contentChangedSinceReview,
    freshness: toReviewFreshnessMessage(header.freshness),
    ...(header.interdiffContent === undefined ? {} : { interdiffContent: header.interdiffContent }),
  });
}

function toReviewFreshnessMessage(freshness: ReviewFreshnessDomain): ReviewFreshness {
  switch (freshness) {
    case "never_reviewed":
      return ReviewFreshness.NEVER_REVIEWED;
    case "fresh":
      return ReviewFreshness.FRESH;
    case "ancestry_only":
      return ReviewFreshness.ANCESTRY_ONLY;
    case "stale_content":
      return ReviewFreshness.STALE_CONTENT;
    case "needs_interdiff":
      // buildReviewHeader always resolves needs_interdiff to ancestry_only/stale_content
      // before returning a ReviewHeader; this pre-resolution state must never reach here.
      throw new ConnectError("review header carries an unresolved freshness state", Code.Internal);
  }
}

function timestampMessage(milliseconds: number) {
  const value = BigInt(milliseconds);
  return create(TimestampSchema, {
    seconds: value / 1_000n,
    nanos: Number(value % 1_000n) * 1_000_000,
  });
}

function parseTreeId(value: string) {
  try {
    return taskTreeId(value);
  } catch (error) {
    throw new PlanRegistryError("invalid_input", "tree ID is invalid", { cause: error });
  }
}

function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    return error;
  }
  if (error instanceof GateProfileError) {
    const code =
      error.code === "missing" || error.code === "invalid"
        ? Code.InvalidArgument
        : Code.FailedPrecondition;
    return new ConnectError(error.message, code, undefined, undefined, error);
  }
  if (error instanceof RepositoryRegistryError) {
    return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
  }
  if (error instanceof RevsetManagerError) {
    const code = error.code === "invalid_options" ? Code.InvalidArgument : Code.FailedPrecondition;
    return new ConnectError(error.message, code, undefined, undefined, error);
  }
  if (error instanceof PlanRegistryError) {
    switch (error.code) {
      case "not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "invalid_input":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "invalid_plan":
      case "identity_conflict":
      case "facts_changed":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      case "corrupt":
        return new ConnectError(error.message, Code.DataLoss, undefined, undefined, error);
    }
  }
  return new ConnectError("tree operation failed", Code.Internal, undefined, undefined, error);
}

function validateResponse<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): MessageValidType<Desc> {
  const validation = responseValidator.validate(schema, message);
  if (validation.kind !== "valid") {
    throw new ConnectError(
      "tree service produced an invalid response",
      Code.Internal,
      undefined,
      undefined,
      validation.error,
    );
  }
  return validation.message;
}
