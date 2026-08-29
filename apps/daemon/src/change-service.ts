import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ChangeService,
  CreatePullRequestResponseSchema,
  GetNodeDiffResponseSchema,
  GetStackStatusResponseSchema,
  LandPullRequestResponseSchema,
  ListPullRequestsResponseSchema,
  PlanNodeMode,
  PullRequestInfoSchema,
  StackPositionInfoSchema,
  type PullRequestInfo,
  type StackPositionInfo,
} from "@minions/contracts";
import {
  GitHubAppAuthError,
  LandingError,
  PullRequestError,
  PushError,
  type LandingCoordinator,
  type ManagedSqliteDatabase,
  type PlanRegistry,
  type PullRequestManager,
  type PushManager,
  type RepositoryRegistry,
  type SqliteRow,
  type VcsChangeBindingStore,
} from "@minions/adapters";
import {
  DomainError,
  actorSessionId,
  attemptId,
  gitSha,
  humanApproval,
  repositoryId,
  taskNodeId,
  taskTreeId,
  type Clock,
  type IdGenerator,
  type VcsBackend,
  VcsBackendError,
} from "@minions/core";

interface StackItem {
  readonly number?: number;
  readonly branch: string;
  readonly title: string;
}

export interface StackedPrBodyInput {
  readonly position: number;
  readonly total: number;
  readonly stack: readonly StackItem[];
  readonly scope: string;
  readonly dependsOn?: string;
  readonly intentionallyLeftOut?: string;
}

export function buildStackedPrBody(input: StackedPrBodyInput): string {
  const stackLines = input.stack.map((item, idx) => {
    const num = item.number !== undefined ? `#${String(item.number)}` : item.branch;
    return `${String(idx + 1)}. ${num} [${String(idx + 1)}/${String(input.total)}] ${item.title}`;
  });
  const reviewOrder = input.stack
    .map((item) => (item.number !== undefined ? `#${String(item.number)}` : item.branch))
    .join(" -> ");

  const sections = [
    "## Stack",
    "",
    ...stackLines,
    "",
    `This PR is: ${String(input.position)} of ${String(input.total)}.`,
    `Review order: ${reviewOrder}.`,
    "",
    "## Scope",
    "",
    input.scope.length > 0 ? input.scope : "No scope provided.",
    "",
    "## Depends On",
    "",
    input.dependsOn !== undefined && input.dependsOn.length > 0 ? input.dependsOn : "None.",
    "",
    "## Intentionally Left Out",
    "",
    input.intentionallyLeftOut !== undefined && input.intentionallyLeftOut.length > 0
      ? input.intentionallyLeftOut
      : "None.",
  ];

  return sections.join("\n");
}

/**
 * The GitHub mutation surface, composed once at daemon startup from the credential
 * vault. Absent, the service refuses every GitHub-mutating RPC instead of
 * simulating one.
 */
interface GitHubChangeStack {
  readonly pullRequests: PullRequestManager;
  readonly push: PushManager;
  readonly landing: LandingCoordinator;
}

export interface ChangeServiceOptions {
  readonly repositoryRegistry?: RepositoryRegistry;
  readonly planRegistry: PlanRegistry;
  readonly vcsChangeBindingStore?: VcsChangeBindingStore;
  readonly database?: ManagedSqliteDatabase;
  readonly vcs?: VcsBackend;
  readonly github?: GitHubChangeStack;
  readonly clock: Clock;
  readonly ids?: IdGenerator;
}

const GITHUB_UNCONFIGURED_MESSAGE =
  "GitHub is not configured on this host; add the GitHub App credentials to the vault and restart";
const EXECUTION_NOT_COMPOSED_MESSAGE =
  "node execution is not composed on this host; run minions execution prepare and restart";

const githubFullNamePattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

export function registerChangeService(router: ConnectRouter, options: ChangeServiceOptions): void {
  router.service(ChangeService, {
    async createPullRequest(request) {
      try {
        const github = requireGitHubStack(options);
        const registry = requireRepositoryRegistry(options);
        const store = requireBindingStore(options);
        const repo = registry.get(repositoryId(request.repositoryId));
        const treeId = taskTreeId(request.treeId);
        const tree = options.planRegistry.get(treeId);
        const repositoryFullName = githubRepositoryFullName(repo.canonicalRemote);

        const node = tree.nodes.find((n) => n.id === request.nodeId);
        if (node === undefined) {
          throw new ConnectError(`node ${request.nodeId} not found in tree`, Code.NotFound);
        }
        const implementationNodes = tree.nodes.filter(
          (n) => n.mode === PlanNodeMode.IMPLEMENTATION,
        );
        const position = implementationNodes.findIndex((n) => n.id === request.nodeId);
        if (position < 0) {
          throw new ConnectError(
            `node ${request.nodeId} is not an implementation node; pull requests are created for implementation nodes only`,
            Code.InvalidArgument,
          );
        }
        const total = implementationNodes.length;
        const prefix = `[${String(position + 1)}/${String(total)}] `;
        const title = request.title.startsWith(prefix)
          ? request.title
          : `${prefix}${request.title}`;
        const baseBranch =
          request.baseBranchName.length > 0 ? request.baseBranchName : repo.defaultBranch;

        const stack: StackItem[] = [];
        for (let index = 0; index < position; index += 1) {
          const ancestor = implementationNodes[index];
          if (ancestor === undefined) continue;
          const binding = await store.getBinding(treeId, taskNodeId(ancestor.id));
          // An ancestor without a captured change has no branch: listing a branch
          // that does not exist would fabricate the stack shape.
          if (binding?.bookmark === undefined) continue;
          stack.push({ branch: binding.bookmark, title: ancestor.objective });
        }
        stack.push({ branch: request.branchName, title });

        const body =
          request.body.length > 0
            ? request.body
            : buildStackedPrBody({
                position: position + 1,
                total,
                stack,
                scope: node.objective,
              });

        const binding = await store.getBinding(treeId, taskNodeId(request.nodeId));
        if (binding === undefined) {
          throw new ConnectError(
            `node ${request.nodeId} has no captured commit to push; the node must complete before its pull request is created`,
            Code.FailedPrecondition,
          );
        }

        await github.push.push({
          repositoryFullName,
          bookmark: request.branchName,
          jjChangeId: binding.jjChangeId,
          expectedRemoteHeadSha: binding.lastPushedCommitId,
        });
        const receipt = await github.pullRequests.createOrUpdatePR({
          repositoryFullName,
          bookmark: request.branchName,
          baseBranch,
          title,
          body,
          draft: false,
        });
        return create(CreatePullRequestResponseSchema, {
          pr: create(PullRequestInfoSchema, {
            prNumber: receipt.prNumber,
            nodeId: request.nodeId,
            treeId: request.treeId,
            branchName: receipt.bookmark,
            baseBranchName: receipt.baseBranch,
            title: receipt.title,
            body,
            htmlUrl: receipt.htmlUrl,
            state: "open",
          }),
        });
      } catch (error) {
        throw toConnectError(error);
      }
    },

    getPullRequest(request) {
      requireGitHubStack(options);
      void request;
      // The composed PullRequestManager exposes no read-by-number surface; a
      // metadata-shaped answer built without one would be fabricated.
      throw new ConnectError(
        "reading pull request metadata by number is not available from the composed GitHub managers; use ListPullRequests",
        Code.FailedPrecondition,
      );
    },

    async getNodeDiff(request) {
      try {
        if (options.database === undefined || options.vcs === undefined) {
          throw new ConnectError(EXECUTION_NOT_COMPOSED_MESSAGE, Code.FailedPrecondition);
        }
        const row = options.database.read((reader) =>
          reader.get(
            "SELECT id, tree_id, repository_id FROM attempts WHERE node_id = ? ORDER BY ordinal DESC LIMIT 1",
            [request.nodeId],
          ),
        );
        if (row === undefined) {
          throw new ConnectError(`node ${request.nodeId} has no recorded attempt`, Code.NotFound);
        }
        const attempt = attemptId(requiredRowText(row, "id"));
        if (requiredRowText(row, "repository_id") !== request.repositoryId) {
          throw new ConnectError(
            `node ${request.nodeId} does not belong to repository ${request.repositoryId}`,
            Code.NotFound,
          );
        }
        const tree = options.planRegistry.get(taskTreeId(requiredRowText(row, "tree_id")));
        const diff = await options.vcs.captureDiff({ attemptId: attempt });
        return create(GetNodeDiffResponseSchema, {
          nodeId: request.nodeId,
          attemptId: attempt,
          diff: diff.diff,
          baseCommit: tree.baseCommit,
          headCommit: diff.headCommit,
          isEmpty: diff.diff.length === 0,
        });
      } catch (error) {
        throw toConnectError(error);
      }
    },

    async listPullRequests(request) {
      try {
        const registry = requireRepositoryRegistry(options);
        const store = requireBindingStore(options);
        const treeId = taskTreeId(request.treeId);
        const tree = options.planRegistry.get(treeId);
        const repo = registry.get(repositoryId(request.repositoryId));
        const implementationNodes = tree.nodes.filter(
          (n) => n.mode === PlanNodeMode.IMPLEMENTATION,
        );
        const prs: PullRequestInfo[] = [];
        let previousBookmark: string | undefined;
        for (const node of implementationNodes) {
          const binding = await store.getBinding(treeId, taskNodeId(node.id));
          if (binding?.bookmark === undefined) continue;
          prs.push(
            create(PullRequestInfoSchema, {
              nodeId: node.id,
              treeId: request.treeId,
              branchName: binding.bookmark,
              baseBranchName: previousBookmark ?? repo.defaultBranch,
              title: node.objective,
            }),
          );
          previousBookmark = binding.bookmark;
        }
        return create(ListPullRequestsResponseSchema, { prs });
      } catch (error) {
        throw toConnectError(error);
      }
    },

    async landPullRequest(request) {
      try {
        const github = requireGitHubStack(options);
        const registry = requireRepositoryRegistry(options);
        const repo = registry.get(repositoryId(request.repositoryId));
        const repositoryFullName = githubRepositoryFullName(repo.canonicalRemote);
        // The landing preflight pins the merge to the head SHA the human reviewed;
        // observeChecks reads the PR's live head from GitHub.
        const checks = await github.pullRequests.observeChecks(
          repositoryFullName,
          request.prNumber,
        );
        const receipt = await github.landing.land({
          prNumber: request.prNumber,
          repositoryFullName,
          humanApproval: humanApproval(actorSessionId(request.actorSessionId)),
          requestedBy: "human",
          expectedHeadSha: gitSha(checks.headSha),
          requestedAt: options.clock.now(),
        });
        return create(LandPullRequestResponseSchema, {
          status: receipt.verdict,
          commitSha: receipt.mergedSha,
          landedAt: create(TimestampSchema, {
            seconds: BigInt(Math.floor(receipt.landedAt / 1_000)),
            nanos: (receipt.landedAt % 1_000) * 1_000_000,
          }),
        });
      } catch (error) {
        throw toConnectError(error);
      }
    },

    async getStackStatus(request) {
      try {
        const registry = requireRepositoryRegistry(options);
        const store = requireBindingStore(options);
        const treeId = taskTreeId(request.treeId);
        const tree = options.planRegistry.get(treeId);
        const repo = registry.get(repositoryId(request.repositoryId));
        const implementationNodes = tree.nodes.filter(
          (n) => n.mode === PlanNodeMode.IMPLEMENTATION,
        );
        const positions: StackPositionInfo[] = [];
        let previousBookmark: string | undefined;
        let previousNodeId: string | undefined;
        for (const node of implementationNodes) {
          const binding = await store.getBinding(treeId, taskNodeId(node.id));
          if (binding?.bookmark === undefined) continue;
          positions.push(
            create(StackPositionInfoSchema, {
              nodeId: node.id,
              parentNodeId: previousNodeId ?? "",
              branchName: binding.bookmark,
              parentBranchName: previousBookmark ?? repo.defaultBranch,
              depth: positions.length + 1,
            }),
          );
          previousBookmark = binding.bookmark;
          previousNodeId = node.id;
        }
        return create(GetStackStatusResponseSchema, { treeId: request.treeId, positions });
      } catch (error) {
        throw toConnectError(error);
      }
    },
  });
}

function requireGitHubStack(options: ChangeServiceOptions): GitHubChangeStack {
  if (options.github === undefined) {
    throw new ConnectError(GITHUB_UNCONFIGURED_MESSAGE, Code.FailedPrecondition);
  }
  return options.github;
}

function requireRepositoryRegistry(options: ChangeServiceOptions): RepositoryRegistry {
  if (options.repositoryRegistry === undefined) {
    throw new ConnectError("repository registry is required", Code.FailedPrecondition);
  }
  return options.repositoryRegistry;
}

function requireBindingStore(options: ChangeServiceOptions): VcsChangeBindingStore {
  if (options.vcsChangeBindingStore === undefined) {
    throw new ConnectError(
      "the vcs change binding store is not composed on this host; restart the daemon with a host database",
      Code.FailedPrecondition,
    );
  }
  return options.vcsChangeBindingStore;
}

/** Derives `owner/name` from the registered repository's canonical remote. */
function githubRepositoryFullName(remote: string): string {
  let path = remote;
  const schemeEnd = remote.indexOf("://");
  if (schemeEnd >= 0) {
    path = remote.slice(schemeEnd + 3);
  } else {
    const at = remote.indexOf("@");
    const colon = remote.indexOf(":");
    if (at >= 0 && colon > at) {
      path = remote.slice(colon + 1);
    }
  }
  const name = path.replace(/\.git$/u, "").replace(/^\/+/u, "");
  if (!githubFullNamePattern.test(name)) {
    throw new ConnectError(
      `repository remote '${remote}' is not a GitHub repository (expected 'owner/name')`,
      Code.FailedPrecondition,
    );
  }
  return name;
}

function requiredRowText(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConnectError(`stored attempt record is missing ${column}`, Code.DataLoss);
  }
  return value;
}

function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    return error;
  }
  if (error instanceof VcsBackendError) {
    switch (error.code) {
      case "invalid_input":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "conflict":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      case "git_failed":
      case "output_limit":
        return new ConnectError(error.message, Code.Internal, undefined, undefined, error);
    }
  }
  if (error instanceof PullRequestError) {
    switch (error.code) {
      case "pr_not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "multiple_open_prs":
      case "auth_failed":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      case "review_fetch_failed":
      case "check_fetch_failed":
      case "create_failed":
      case "update_failed":
      case "api_error":
        return new ConnectError(error.message, Code.Internal, undefined, undefined, error);
    }
  }
  if (error instanceof PushError) {
    switch (error.code) {
      case "refspec_invalid":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "conflict_unresolved":
      case "remote_drift":
      case "lease_expired":
      case "auth_failed":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      case "push_failed":
        return new ConnectError(error.message, Code.Internal, undefined, undefined, error);
    }
  }
  if (error instanceof LandingError) {
    switch (error.code) {
      case "preflight_failed":
      case "already_landed":
      case "parent_not_landed":
      case "ambiguous_remote":
      case "duplicate_command":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      case "merge_failed":
      case "retarget_failed":
      case "receipt_failed":
        return new ConnectError(error.message, Code.Internal, undefined, undefined, error);
    }
  }
  if (error instanceof GitHubAppAuthError) {
    return new ConnectError(
      `${error.message}; ${GITHUB_UNCONFIGURED_MESSAGE.charAt(0).toLowerCase()}${GITHUB_UNCONFIGURED_MESSAGE.slice(1)}`,
      Code.FailedPrecondition,
      undefined,
      undefined,
      error,
    );
  }
  if (error instanceof DomainError) {
    switch (error.code) {
      case "invalid_value":
      case "invalid_artifact_input":
      case "invalid_outcome":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "duplicate_id":
      case "invalid_transition":
      case "invalid_tree":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
    }
  }
  return new ConnectError("change operation failed", Code.Internal, undefined, undefined, error);
}
