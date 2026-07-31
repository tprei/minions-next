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
  GateProfileError,
  loadGateProfile,
  PlanRegistryError,
  RepositoryRegistryError,
  type HostGateMinimum,
  type PlanAttentionRecord,
  type PlanRegistry,
  type PlanRevisionRecord,
  type RepositoryRegistry,
  type TaskNodeRecord,
  type TreeRecord,
  type TreeSummaryRecord,
} from "@minions/adapters";
import {
  ApprovePlanResponseSchema,
  ArtifactInputSchema,
  ArtifactOutputContractSchema,
  CreateTreeResponseSchema,
  ImplementationOutputContractSchema,
  GetTreeResponseSchema,
  ListTreesResponseSchema,
  NodeBudgetSchema,
  PlanAttentionSchema,
  PlanRevisionSchema,
  ProposePlanResponseSchema,
  RepairPlanResponseSchema,
  TaskNodeSchema,
  TaskTreeSchema,
  TreeBudgetSchema,
  TreeService,
  TreeSummarySchema,
} from "@minions/contracts";
import {
  repositoryId,
  timestampFromEpochMilliseconds,
  taskTreeId,
  type Clock,
} from "@minions/core";

const responseValidator = createValidator();

export type TreeServiceOptions = Readonly<{
  planRegistry: PlanRegistry;
  clock: Clock;
  repositoryRegistry?: RepositoryRegistry;
  hostMinimum?: HostGateMinimum;
}>;

export function registerTreeService(router: ConnectRouter, options: TreeServiceOptions): void {
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
        return validateResponse(
          CreateTreeResponseSchema,
          create(CreateTreeResponseSchema, { tree: toTreeMessage(tree) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    getTree(request) {
      try {
        const tree = options.planRegistry.get(parseTreeId(request.treeId));
        return validateResponse(
          GetTreeResponseSchema,
          create(GetTreeResponseSchema, { tree: toTreeMessage(tree) }),
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
        return validateResponse(
          ProposePlanResponseSchema,
          create(ProposePlanResponseSchema, { tree: toTreeMessage(tree) }),
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
        return validateResponse(
          RepairPlanResponseSchema,
          create(RepairPlanResponseSchema, { tree: toTreeMessage(tree) }),
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
        return validateResponse(
          ApprovePlanResponseSchema,
          create(ApprovePlanResponseSchema, { tree: toTreeMessage(tree) }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
  });
}

function toTreeMessage(tree: TreeRecord) {
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
    nodes: tree.nodes.map(toTaskNodeMessage),
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

function toTaskNodeMessage(node: TaskNodeRecord) {
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
    checkProfile: node.checkProfile,
    budget: create(NodeBudgetSchema, { maxAttempts: node.budget.maxAttempts }),
    state: node.state,
    version: BigInt(node.version),
    createdAt: timestampMessage(node.createdAt),
    updatedAt: timestampMessage(node.updatedAt),
  });
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
