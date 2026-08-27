import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  ApprovePlanRequestSchema,
  CreateTreeRequestSchema,
  DaemonMode,
  DoctorCheckKind,
  DoctorCheckSchema,
  DoctorCheckStatus,
  DoctorStatus,
  GetHealthResponseSchema,
  ImplementationOutputContractSchema,
  PlanNodeMode,
  ProposePlanRequestSchema,
  ProposedNodeSchema,
  RegisterRepositoryRequestSchema,
  ReviewFreshness,
  RunDoctorResponseSchema,
  TreeBudgetSchema,
  TreeService,
} from "@minions/contracts";
import {
  actorSessionId,
  artifactId,
  commandId,
  contentHash,
  gitSha,
  hostId,
  planRevisionId,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type DomainPorts,
  type RecoveryGateProfile,
  type VcsChangeBinding,
} from "@minions/core";
import {
  createEventCommitWaiter,
  createFileContentBlobStore,
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteArtifactRegistry,
  createSqliteCommandStore,
  createSqliteRecoveryStore,
  createSqliteSteeringCommandStore,
  createSqliteVcsChangeBindingStore,
  type RepositoryInspection,
  type RevsetJjRunResult,
  type RevsetJjRunner,
} from "@minions/adapters";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemonServer, type RunningDaemonServer } from "@minions/daemon";

/**
 * Daemon-level integration test for `TreeService.getReviewHeaders` (PR 48). Proves the
 * backend contract is genuinely reachable by a real client: a real Connect RPC call, against
 * a real daemon server backed by a real SQLite binding store, returns a `ReviewHeader` whose
 * `interdiffContent` carries the full diff body for a genuine content change, and omits it
 * for an ancestry-only rewrite. The jj subprocess itself is a scripted double (as in
 * test/integration/adapters/revset.test.ts) — this test's job is the wire contract, not
 * re-proving jj behavior the adapter-level suite already covers.
 */

const at = timestampFromEpochMilliseconds(1_700_000_000_000);
const hostIdentifier = hostId("01900000-0000-7000-8000-000000000001");
const repositoryIdentifier = repositoryId("01900000-0000-7000-8000-000000000002");
const actorIdentifier = actorSessionId("01900000-0000-7000-8000-000000000003");
const treeIdentifier = taskTreeId("01900000-0000-7000-8000-000000000004");
const initialRevisionIdentifier = planRevisionId("01900000-0000-7000-8000-000000000005");
const rootNodeIdentifier = taskNodeId("01900000-0000-7000-8000-000000000006");
const rootArtifactIdentifier = artifactId("01900000-0000-7000-8000-000000000007");
const proposedRevisionIdentifier = planRevisionId("01900000-0000-7000-8000-000000000009");
const childNodeIdentifier = taskNodeId("01900000-0000-7000-8000-00000000000a");

function deterministicId(index: number): string {
  return `01900000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** Repeat a numeric seed's hex unit to exactly `length` lowercase-hex chars. */
function hexRun(seed: number, length: number): string {
  const unit = (seed % 256).toString(16).padStart(2, "0");
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

const change = (seed: number) => contentHash(hexRun(seed, 64));
const op = (seed: number) => contentHash(hexRun(seed + 64, 64));
const commit = (seed: number) => gitSha(hexRun(seed, 40));

// ROOT: commits differ (rewrite generation advanced), but the double's interdiff for its
// commit pair is empty — an ancestry-only restack, no content delta.
const rootBinding: VcsChangeBinding = Object.freeze({
  treeId: treeIdentifier,
  nodeId: rootNodeIdentifier,
  jjChangeId: change(1),
  currentCommitId: commit(11),
  parentChangeId: undefined,
  bookmark: undefined,
  rewriteGeneration: 1,
  lastJjOperationId: op(1),
  lastPushedCommitId: undefined,
  lastReviewedCommitId: commit(1),
  conflictState: "clean",
  recordedAt: at,
});

// CHILD: commits differ, and the double's interdiff for its commit pair is a real diff body.
const childBinding: VcsChangeBinding = Object.freeze({
  treeId: treeIdentifier,
  nodeId: childNodeIdentifier,
  jjChangeId: change(2),
  currentCommitId: commit(22),
  parentChangeId: change(1),
  bookmark: undefined,
  rewriteGeneration: 1,
  lastJjOperationId: op(2),
  lastPushedCommitId: undefined,
  lastReviewedCommitId: commit(2),
  conflictState: "clean",
  recordedAt: at,
});

const REAL_DIFF =
  "diff --git a/src/handler.ts b/src/handler.ts\n" +
  "--- a/src/handler.ts\n" +
  "+++ b/src/handler.ts\n" +
  "@@ -1,3 +1,4 @@\n" +
  " export function handler() {\n" +
  '+  console.log("reviewed via RPC");\n' +
  "   return true;\n" +
  " }\n";

/** A double that reports an empty interdiff for ROOT and a real diff body for CHILD. */
function reviewRunner(): RevsetJjRunner {
  return (args) => {
    if (args[0] !== "interdiff") {
      return Promise.reject(
        new Error(
          `unexpected jj invocation in review-headers-service test double: ${args.join(" ")}`,
        ),
      );
    }
    const toIndex = args.indexOf("--to");
    const to = toIndex === -1 ? undefined : args[toIndex + 1];
    const stdout = to === childBinding.currentCommitId ? REAL_DIFF : "";
    return Promise.resolve<RevsetJjRunResult>({ exitCode: 0, stdout, stderr: "" });
  };
}

const health = create(GetHealthResponseSchema, {
  instanceId: deterministicId(0x10),
  mode: DaemonMode.HOST,
  hostId: hostIdentifier,
  startedAt: create(TimestampSchema, { seconds: 1_700_000_000n }),
});

const doctor = create(RunDoctorResponseSchema, {
  status: DoctorStatus.HEALTHY,
  checks: [
    create(DoctorCheckSchema, {
      kind: DoctorCheckKind.LIFECYCLE_LOCK,
      status: DoctorCheckStatus.PASSED,
    }),
  ],
});

const noOpNotifier = Object.freeze({ commandCommitted: () => undefined });

const RECOVERY_TEST_GATE_PROFILE: RecoveryGateProfile = {
  allowedKinds: ["restart"],
  requiredApprovals: 1,
  maxGrantDurationMs: 900_000,
};

type ReviewHeadersFixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  server: RunningDaemonServer;
  client: Client<typeof TreeService>;
}>;

const fixtures: ReviewHeadersFixture[] = [];

async function createFixture(
  options: { withRevset?: boolean } = {},
): Promise<ReviewHeadersFixture> {
  const withRevset = options.withRevset ?? true;
  const clock = new FixedClock(at);
  const temporary = await TemporarySqliteDatabase.create("host", clock);
  const database = temporary.database;
  const ports: DomainPorts = Object.freeze({
    clock,
    ids: new SequenceIdGenerator(
      Array.from({ length: 32 }, (_, index) => deterministicId(0x1000 + index)),
    ),
  });
  const commandStore = createSqliteCommandStore({ database, ports, notifier: noOpNotifier });
  const repositories = createRepositoryRegistry({
    database,
    commandStore,
    hostId: hostIdentifier,
  });
  const inspection: RepositoryInspection = {
    canonicalRoot: "/workspace/minions",
    canonicalRemote: "https://example.test/minions",
    defaultBranch: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    caseSensitive: true,
    submodulePaths: [],
    lfsPaths: [],
    nestedRepositoryPaths: [],
    dirty: false,
  };
  await repositories.register({
    request: create(RegisterRepositoryRequestSchema, {
      commandId: commandId(deterministicId(0x20)),
      actorSessionId: actorIdentifier,
      repositoryId: repositoryIdentifier,
      rootPath: "/workspace/minions",
    }),
    inspection,
    allowedWorkspaceRoot: "/workspaces",
    registeredAt: at,
  });
  const planRegistry = createPlanRegistry({ database, commandStore, hostId: hostIdentifier });
  await planRegistry.create({
    request: create(CreateTreeRequestSchema, {
      commandId: commandId(deterministicId(0x21)),
      actorSessionId: actorIdentifier,
      repositoryId: repositoryIdentifier,
      treeId: treeIdentifier,
      planRevisionId: initialRevisionIdentifier,
      rootNodeId: rootNodeIdentifier,
      rootArtifactId: rootArtifactIdentifier,
      goal: "exercise review headers",
      baseCommit: inspection.baseCommit,
      budget: create(TreeBudgetSchema, {
        maxDepth: 4,
        maxFanOut: 4,
        maxNodes: 8,
        maxConcurrency: 4,
        maxAttemptsPerNode: 2,
      }),
      attentionId: deterministicId(0x22),
      rootAllowedRepositoryPaths: ["."],
    }),
    at,
  });
  await planRegistry.propose({
    request: create(ProposePlanRequestSchema, {
      commandId: commandId(deterministicId(0x23)),
      actorSessionId: actorIdentifier,
      treeId: treeIdentifier,
      planRevisionId: proposedRevisionIdentifier,
      goal: "exercise review headers",
      nodes: [
        create(ProposedNodeSchema, {
          nodeId: childNodeIdentifier,
          parentNodeId: rootNodeIdentifier,
          mode: PlanNodeMode.IMPLEMENTATION,
          objective: "receive a reviewed content change",
          acceptanceCriteria: ["the review header carries the interdiff body"],
          inputs: [],
          outputContract: {
            case: "implementation",
            value: create(ImplementationOutputContractSchema, {}),
          },
          allowedRepositoryPaths: ["."],
        }),
      ],
    }),
    at,
  });
  await planRegistry.approve({
    request: create(ApprovePlanRequestSchema, {
      commandId: commandId(deterministicId(0x24)),
      actorSessionId: actorIdentifier,
      treeId: treeIdentifier,
      planRevisionId: proposedRevisionIdentifier,
    }),
    at,
  });

  const bindingStore = createSqliteVcsChangeBindingStore({ database });
  await bindingStore.upsertBinding(rootBinding);
  await bindingStore.upsertBinding(childBinding);

  const steeringStore = createSqliteSteeringCommandStore({ database, commandStore, ports });
  const artifactRegistry = createSqliteArtifactRegistry({
    database,
    commandStore,
    hostId: hostIdentifier,
  });
  const blobStore = createFileContentBlobStore({
    rootPath: join(dirname(database.path), "blobs"),
    clock,
    ids: ports.ids,
  });
  const eventWaiter = createEventCommitWaiter();

  const server = await startDaemonServer({
    mode: "host",
    port: 0,
    database,
    eventWaiter,
    eventPollIntervalMs: 10,
    planRegistry,
    clock,
    steeringStore,
    artifactRegistry,
    blobStore,
    recoveryStore: createSqliteRecoveryStore({ database }),
    recoveryGateProfile: RECOVERY_TEST_GATE_PROFILE,
    recoveryIds: new SequenceIdGenerator(["01900000-0000-7000-8000-0000000000f0"]),
    recoveryRestart: { restart: () => Promise.reject(new Error("not used")) },
    vcsChangeBindingStore: bindingStore,
    system: {
      serverVersion: "0.0.0",
      health,
      runDoctor: () => Promise.resolve(doctor),
    },
    ...(withRevset
      ? {
          revset: {
            jjBinaryPath: "/nonexistent/jj",
            hostRoot: "/nonexistent/jj-repos",
            bindingStore,
            runJj: reviewRunner(),
          },
        }
      : {}),
  });
  const client = createClient(
    TreeService,
    createConnectTransport({
      baseUrl: server.baseUrl,
      httpVersion: "1.1",
      useBinaryFormat: true,
    }),
  );
  const fixture = { temporary, server, client };
  fixtures.push(fixture);
  return fixture;
}

async function expectConnectError(call: () => Promise<unknown>): Promise<ConnectError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ConnectError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the request to fail");
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.server.close();
    await fixture.temporary.dispose();
  }
});

describe("TreeService.getReviewHeaders integration", () => {
  it("returns the full interdiff body for a genuine content change over a real RPC call", async () => {
    const fixture = await createFixture();
    const response = await fixture.client.getReviewHeaders({ treeId: treeIdentifier });
    const byNode = new Map(response.headers.map((header) => [header.nodeId, header]));

    const childHeader = byNode.get(String(childNodeIdentifier));
    expect(childHeader?.freshness).toBe(ReviewFreshness.STALE_CONTENT);
    expect(childHeader?.contentChangedSinceReview).toBe(true);
    expect(childHeader?.interdiffContent).toBe(REAL_DIFF);
    expect(childHeader?.logicalChangeId).toBe(childBinding.jjChangeId);
    expect(childHeader?.rewriteGeneration).toBe(childBinding.rewriteGeneration);
  });

  it("omits interdiff content over the wire for an ancestry-only rewrite", async () => {
    const fixture = await createFixture();
    const response = await fixture.client.getReviewHeaders({ treeId: treeIdentifier });
    const byNode = new Map(response.headers.map((header) => [header.nodeId, header]));

    const rootHeader = byNode.get(String(rootNodeIdentifier));
    expect(rootHeader?.freshness).toBe(ReviewFreshness.ANCESTRY_ONLY);
    expect(rootHeader?.contentChangedSinceReview).toBe(false);
    expect(rootHeader?.interdiffContent).toBeUndefined();
  });

  it("fails closed with FailedPrecondition when jj revset capability is not configured", async () => {
    const fixture = await createFixture({ withRevset: false });
    const error = await expectConnectError(() =>
      fixture.client.getReviewHeaders({ treeId: treeIdentifier }),
    );
    expect(error.code).toBe(Code.FailedPrecondition);
  });

  it("rejects an unknown tree with NotFound", async () => {
    const fixture = await createFixture();
    const error = await expectConnectError(() =>
      fixture.client.getReviewHeaders({ treeId: "01900000-0000-7000-8000-0000000000ff" }),
    );
    expect(error.code).toBe(Code.NotFound);
  });
});
