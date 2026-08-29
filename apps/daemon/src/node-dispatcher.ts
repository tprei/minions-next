import {
  createSandboxPolicyFingerprinter,
  type ManagedSqliteDatabase,
  type PlanRegistry,
  type RepositoryRegistry,
} from "@minions/adapters";
import { NodeState } from "@minions/contracts";
import {
  actorSessionId,
  contentHash,
  type ExecutionCoordinator,
  type HarnessAttemptContext,
  type IdGenerator,
  type NodeExecutionRequest,
  type NodeModelContext,
  type NodeOutcomeRecording,
  type NodePlanContext,
  type NodeWorkspaceContext,
  type SandboxPolicy,
  type SchedulerCapacityPolicy,
  type SchedulerDispatcher,
  type SchedulerLease,
  type SchedulerOwnerId,
} from "@minions/core";

export type NodeExecutionDispatcherOptions = Readonly<{
  coordinator: ExecutionCoordinator;
  planRegistry: PlanRegistry;
  repositoryRegistry: RepositoryRegistry;
  database: ManagedSqliteDatabase;
  ids: IdGenerator;
  ownerId: SchedulerOwnerId;
  leaseDurationMs: number;
  capacity: SchedulerCapacityPolicy;
  sandboxImageFingerprint: string;
}>;

export function createNodeExecutionDispatcher(
  options: NodeExecutionDispatcherOptions,
): SchedulerDispatcher {
  return {
    async dispatch(lease: SchedulerLease): Promise<void> {
      const attemptRow = options.database.read((reader) =>
        reader.get("SELECT ordinal FROM attempts WHERE id = ?", [lease.attemptId]),
      );
      const attemptOrdinal =
        attemptRow !== undefined && typeof attemptRow["ordinal"] === "number"
          ? attemptRow["ordinal"]
          : 1;

      const nodeRow = options.database.read((reader) =>
        reader.get("SELECT version, objective FROM nodes WHERE id = ?", [lease.nodeId]),
      );
      const expectedNodeVersion =
        nodeRow !== undefined && typeof nodeRow["version"] === "number"
          ? nodeRow["version"]
          : undefined;

      const context: HarnessAttemptContext = Object.freeze({
        attemptId: lease.attemptId,
        attemptOrdinal,
        nodeId: lease.nodeId,
        treeId: lease.treeId,
        repositoryId: lease.repositoryId,
        hostId: lease.hostId,
      });

      const tree = options.planRegistry.get(lease.treeId);
      const currentNode = tree.nodes.find((n) => n.id === lease.nodeId);
      const parentNode =
        currentNode?.parentNodeId !== undefined
          ? tree.nodes.find((n) => n.id === currentNode.parentNodeId)
          : undefined;
      const siblingSummaries = tree.nodes
        .filter(
          (n) =>
            n.id !== lease.nodeId &&
            n.parentNodeId === currentNode?.parentNodeId &&
            n.state === NodeState.SUCCEEDED,
        )
        .map((n) => n.objective);

      const plan: NodePlanContext = Object.freeze({
        planGoal: tree.goal,
        parentGoal: parentNode?.objective,
        siblingSummaries: Object.freeze(siblingSummaries),
      });

      const repository = options.repositoryRegistry.get(lease.repositoryId);
      const workspace: NodeWorkspaceContext = Object.freeze({
        repositoryId: lease.repositoryId,
        hostId: lease.hostId,
        workspacePath: repository.canonicalRoot,
        baseCommit: tree.baseCommit,
        headCommit: tree.baseCommit,
      });

      const templateDigest = contentHash(options.sandboxImageFingerprint);
      const sandboxPolicy: SandboxPolicy = Object.freeze({
        version: 1 as const,
        rootFilesystemDigest: templateDigest,
        templateDigest,
        mounts: Object.freeze([
          Object.freeze({
            kind: "workspace" as const,
            sourcePath: repository.canonicalRoot,
            targetPath: "/workspace",
            access: "read_write" as const,
          }),
        ]),
        network: Object.freeze({
          profile: "implementation" as const,
          allowedHosts: Object.freeze([]),
          allowProviderGateway: false,
        }),
        tools: Object.freeze({
          allowedExecutables: Object.freeze(["node", "git", "omp", "pnpm", "bash", "sh"]),
          allowedGitSubcommands: Object.freeze([
            "status",
            "diff",
            "add",
            "commit",
            "checkout",
            "log",
          ]),
          blockedGitSubcommands: Object.freeze(["push", "fetch", "remote"]),
        }),
        resources: Object.freeze({
          cpuCount: 2,
          memoryMiB: 2048,
          processLimit: 64,
          storageMiB: 4096,
          executionTimeoutMs: 300_000,
          maxOutputBytes: 1_048_576,
        }),
      });

      const fingerprinter = createSandboxPolicyFingerprinter();
      const policyFingerprint = fingerprinter.fingerprint(sandboxPolicy);

      const model: NodeModelContext = Object.freeze({
        model: "omp-default",
        reasoningLevel: "default",
      });

      const recording: NodeOutcomeRecording = Object.freeze({
        actorSessionId: actorSessionId(options.ids.nextId()),
        expectedNodeVersion,
      });

      const request: NodeExecutionRequest = Object.freeze({
        context,
        lease,
        ownerId: options.ownerId,
        leaseDurationMs: options.leaseDurationMs,
        capacity: options.capacity,
        durableHarnessId: lease.nodeId,
        goal: currentNode?.objective ?? tree.goal,
        plan,
        workspace,
        sandboxPolicy,
        policyFingerprint,
        model,
        recording,
      });

      await options.coordinator.runNode(request);
    },
  };
}
