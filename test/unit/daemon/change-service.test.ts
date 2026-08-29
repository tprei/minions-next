import { describe, expect, it } from "vitest";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { CreatePullRequestRequestSchema, GetNodeDiffRequestSchema } from "@minions/contracts";
import type { PlanRegistry } from "@minions/adapters";
import { timestampFromEpochMilliseconds, type Clock } from "@minions/core";
import {
  buildStackedPrBody,
  registerChangeService,
  type ChangeServiceOptions,
} from "../../../apps/daemon/src/change-service.js";

describe("stacked PR body builder", () => {
  it("enforces the mandated stack shape from STACKED_DIFFS.md", () => {
    const body = buildStackedPrBody({
      position: 2,
      total: 4,
      stack: [
        {
          number: 12,
          branch: "minions/plan-persistence",
          title: "Add plan revisions and SQLite schema",
        },
        { number: 13, branch: "minions/attempts-domain", title: "Add attempt harness contract" },
        {
          number: 14,
          branch: "minions/scheduler-leases",
          title: "Add fenced scheduler and leases",
        },
        { number: 15, branch: "minions/sandbox-policy", title: "Add fail-closed sandbox policy" },
      ],
      scope: "This PR adds the durable attempt harness contract and its SQLite migration.",
      dependsOn: "- #12 for plan revisions and the SQLite schema.",
      intentionallyLeftOut: "- Scheduler and leases.\n- Sandbox policy.",
    });

    expect(body).toContain("## Stack");
    expect(body).toContain("1. #12 [1/4] Add plan revisions and SQLite schema");
    expect(body).toContain("2. #13 [2/4] Add attempt harness contract");
    expect(body).toContain("3. #14 [3/4] Add fenced scheduler and leases");
    expect(body).toContain("4. #15 [4/4] Add fail-closed sandbox policy");
    expect(body).toContain("This PR is: 2 of 4.");
    expect(body).toContain("Review order: #12 -> #13 -> #14 -> #15.");
    expect(body).toContain("## Scope");
    expect(body).toContain("## Depends On");
    expect(body).toContain("## Intentionally Left Out");
  });

  it("uses branch names when PR numbers do not exist yet", () => {
    const body = buildStackedPrBody({
      position: 1,
      total: 2,
      stack: [
        { branch: "minions/slice-1", title: "Add research" },
        { branch: "minions/slice-2", title: "Add implementation" },
      ],
      scope: "Add research slice.",
    });

    expect(body).toContain("1. minions/slice-1 [1/2] Add research");
    expect(body).toContain("2. minions/slice-2 [2/2] Add implementation");
    expect(body).toContain("This PR is: 1 of 2.");
    expect(body).toContain("Review order: minions/slice-1 -> minions/slice-2.");
  });
});

const REPOSITORY_ID = "01900000-0000-7000-8000-00000000000a";
const TREE_ID = "01900000-0000-7000-8000-00000000000b";
const NODE_ID = "01900000-0000-7000-8000-00000000000c";

const GITHUB_UNCONFIGURED_MESSAGE =
  "GitHub is not configured on this host; add the GitHub App credentials to the vault and restart";

const EXECUTION_UNCOMPOSED_MESSAGE =
  "node execution is not composed on this host; run minions execution prepare and restart";

function unreachablePlanRegistry(): PlanRegistry {
  const fail = (): never => {
    throw new Error("plan registry must not be read by these tests");
  };
  return {
    create: fail,
    createTemplated: fail,
    get: fail,
    list: fail,
    propose: fail,
    repair: fail,
    approve: fail,
  };
}

function baseChangeServiceOptions(): ChangeServiceOptions {
  return {
    planRegistry: unreachablePlanRegistry(),
    clock: { now: () => timestampFromEpochMilliseconds(0) } satisfies Clock,
  };
}

function captureChangeService(options: ChangeServiceOptions): Record<string, unknown> {
  let handlers: Record<string, unknown> | undefined;
  const router = {
    service(_type: unknown, implementation: Record<string, unknown>): void {
      handlers = implementation;
    },
  } as ConnectRouter;
  registerChangeService(router, options);
  if (handlers === undefined) {
    throw new Error("change service was not registered");
  }
  return handlers;
}

function handler(handlers: Record<string, unknown>, name: string): (request: object) => unknown {
  const fn = handlers[name];
  if (typeof fn !== "function") {
    throw new Error(`change service handler ${name} was not registered`);
  }
  return fn as (request: object) => unknown;
}

async function connectErrorOf(action: () => unknown): Promise<ConnectError> {
  const caught: unknown = await Promise.resolve()
    .then(action)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(caught).toBeInstanceOf(ConnectError);
  return caught as ConnectError;
}

describe("change service fail-closed behavior", () => {
  it("getNodeDiff fails closed when node execution is not composed on the host", async () => {
    const handlers = captureChangeService(baseChangeServiceOptions());
    const error = await connectErrorOf(() =>
      handler(
        handlers,
        "getNodeDiff",
      )(create(GetNodeDiffRequestSchema, { repositoryId: REPOSITORY_ID, nodeId: NODE_ID })),
    );

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toBe(EXECUTION_UNCOMPOSED_MESSAGE);
  });

  it("createPullRequest fails closed when GitHub is not configured on the host", async () => {
    const handlers = captureChangeService(baseChangeServiceOptions());
    const error = await connectErrorOf(() =>
      handler(
        handlers,
        "createPullRequest",
      )(
        create(CreatePullRequestRequestSchema, {
          repositoryId: REPOSITORY_ID,
          treeId: TREE_ID,
          nodeId: NODE_ID,
          branchName: "minions/node-1",
          baseBranchName: "",
          title: "Add the thing",
          body: "",
        }),
      ),
    );

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toBe(GITHUB_UNCONFIGURED_MESSAGE);
  });

  it("getPullRequest fails closed when GitHub is not configured on the host", async () => {
    const handlers = captureChangeService(baseChangeServiceOptions());
    const error = await connectErrorOf(() =>
      handler(handlers, "getPullRequest")({ repositoryId: REPOSITORY_ID, prNumber: 7 }),
    );

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toBe(GITHUB_UNCONFIGURED_MESSAGE);
  });

  it("landPullRequest fails closed when GitHub is not configured on the host", async () => {
    const handlers = captureChangeService(baseChangeServiceOptions());
    const error = await connectErrorOf(() =>
      handler(
        handlers,
        "landPullRequest",
      )({
        repositoryId: REPOSITORY_ID,
        treeId: TREE_ID,
        prNumber: 7,
        actorSessionId: NODE_ID,
      }),
    );

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toBe(GITHUB_UNCONFIGURED_MESSAGE);
  });
});
