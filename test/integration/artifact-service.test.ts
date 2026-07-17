import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { WireType } from "@bufbuild/protobuf/wire";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  DaemonMode,
  ArtifactOutcomeSchema,
  ArtifactRetention,
  ArtifactService,
  CreateArtifactRequestSchema,
  CreateTreeRequestSchema,
  GetArtifactRequestSchema,
  DoctorStatus,
  GetHealthResponseSchema,
  ListArtifactsRequestSchema,
  NoChangeOutcomeSchema,
  RegisterRepositoryRequestSchema,
  RunDoctorResponseSchema,
  TreeBudgetSchema,
  type Artifact,
} from "@minions/contracts";
import {
  createEventCommitWaiter,
  createFileContentBlobStore,
  createPlanRegistry,
  createRepositoryRegistry,
  createSqliteArtifactRegistry,
  createSqliteCommandStore,
  createSqliteSteeringCommandStore,
  type EventCommitWaiter,
  type ManagedSqliteDatabase,
  type RepositoryInspection,
  type SqliteCommandStore,
} from "@minions/adapters";
import {
  actorSessionId,
  artifactId,
  commandId,
  contentHash,
  hostId,
  nonEmptyText,
  repositoryId,
  taskNodeId,
  taskTreeId,
  timestampFromEpochMilliseconds,
  type Clock,
  type ArtifactRegistry,
  type ContentBlobStore,
  type DomainPorts,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { executeTestSqliteWrite } from "@minions/adapters/sqlite-test-support";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemonServer, type RunningDaemonServer } from "@minions/daemon";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const HOST_ID = hostId("01900000-0000-7000-8000-000000000001");
const REPOSITORY_ID = repositoryId("01900000-0000-7000-8000-000000000002");
const ACTOR_ID = actorSessionId("01900000-0000-7000-8000-000000000003");
const TREE_ID = taskTreeId("01900000-0000-7000-8000-000000000004");
const REVISION_ID = "01900000-0000-7000-8000-000000000005";
const ROOT_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000006");
const ROOT_ARTIFACT_ID = artifactId("01900000-0000-7000-8000-000000000007");
const CHILD_NODE_ID = taskNodeId("01900000-0000-7000-8000-000000000008");
const ATTENTION_ID = "01900000-0000-7000-8000-000000000009";
const REGISTER_COMMAND_ID = commandId("01900000-0000-7000-8000-00000000000a");
const CREATE_TREE_COMMAND_ID = commandId("01900000-0000-7000-8000-00000000000b");
const CREATE_ARTIFACT_COMMAND_ID = commandId("01900000-0000-7000-8000-00000000000e");
const INVALID_ARTIFACT_COMMAND_ID = commandId("01900000-0000-7000-8000-00000000000f");
const MISSING_ARTIFACT_COMMAND_ID = commandId("01900000-0000-7000-8000-000000000016");
const OVERFLOW_ARTIFACT_COMMAND_ID = commandId("01900000-0000-7000-8000-000000000017");
const INVALID_UUID_ARTIFACT_COMMAND_ID = "00000000-0000-4000-8000-000000000018";
const ARTIFACT_EVIDENCE_ID = "01900000-0000-7000-8000-000000000010";
const SECOND_ARTIFACT_ID = artifactId("01900000-0000-7000-8000-000000000011");
const SECOND_ARTIFACT_EVIDENCE_ID = "01900000-0000-7000-8000-000000000012";
const OUTCOME_COMMAND_ID = commandId("01900000-0000-7000-8000-000000000013");
const NO_CHANGE_COMMAND_ID = commandId("01900000-0000-7000-8000-000000000014");
const NO_CHANGE_EVIDENCE_ID = "01900000-0000-7000-8000-000000000015";
const CONTENT = new TextEncoder().encode("artifact content");
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

type ArtifactClient = Client<typeof ArtifactService>;

type Fixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  database: ManagedSqliteDatabase;
  commandStore: SqliteCommandStore;
  artifactRegistry: ArtifactRegistry;
  blobStore: ContentBlobStore;
  clock: Clock;
  server: RunningDaemonServer;
  client: ArtifactClient;
}>;

let fixture: Fixture | undefined;

describe("ArtifactService integration", () => {
  afterEach(async () => {
    if (fixture !== undefined) {
      await fixture.server.close();
      await fixture.temporary.dispose();
      fixture = undefined;
    }
  });

  it("round-trips all RPCs with durable blobs, pagination, errors, replay, and outcomes", async () => {
    fixture = await createFixture();
    const testFixture = requireFixture(fixture);
    const request = create(CreateArtifactRequestSchema, {
      commandId: INVALID_ARTIFACT_COMMAND_ID,
      actorSessionId: ACTOR_ID,
      artifactId: ROOT_ARTIFACT_ID,
      nodeId: ROOT_NODE_ID,
      mediaType: "text/plain",
      artifactType: "wrong/type",
      evidenceId: ARTIFACT_EVIDENCE_ID,
      retention: ArtifactRetention.ACTIVE,
      content: CONTENT,
    });
    const invalid = await expectConnectError(() => testFixture.client.createArtifact(request));
    const missing = await expectConnectError(() =>
      testFixture.client.createArtifact(
        create(CreateArtifactRequestSchema, {
          ...request,
          commandId: MISSING_ARTIFACT_COMMAND_ID,
          content: new Uint8Array(),
        }),
      ),
    );
    expect(missing.code).toBe(Code.InvalidArgument);
    expect(invalid.code).toBe(Code.InvalidArgument);
    const overflow = await expectConnectError(() =>
      testFixture.client.createArtifact(
        create(CreateArtifactRequestSchema, {
          ...request,
          commandId: OVERFLOW_ARTIFACT_COMMAND_ID,
          expectedNodeVersion: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          content: new TextEncoder().encode("overflow content"),
        }),
      ),
    );
    expect(overflow.code).toBe(Code.InvalidArgument);
    const invalidUuid = await expectConnectError(() =>
      testFixture.client.createArtifact(
        create(CreateArtifactRequestSchema, {
          ...request,
          commandId: INVALID_UUID_ARTIFACT_COMMAND_ID,
          content: new TextEncoder().encode("invalid UUID content"),
        }),
      ),
    );
    expect(invalidUuid.code).toBe(Code.InvalidArgument);
    const reconciliation = await testFixture.blobStore.reconcile(
      testFixture.artifactRegistry.expectedBlobs(),
    );
    expect(reconciliation.removedOrphanPaths).toHaveLength(0);

    const createRequest = create(CreateArtifactRequestSchema, {
      ...request,
      commandId: CREATE_ARTIFACT_COMMAND_ID,
      artifactType: "plan",
      evidenceId: ARTIFACT_EVIDENCE_ID,
    });
    const created = await testFixture.client.createArtifact(createRequest);
    expect(created.artifact).toBeDefined();
    const artifact = requireArtifact(created.artifact);
    expect(artifact.artifactId).toBe(ROOT_ARTIFACT_ID);
    expect(artifact.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(artifact.sizeBytes).toBe(BigInt(CONTENT.byteLength));

    const replay = await testFixture.client.createArtifact(createRequest);
    expect(replay).toEqual(created);
    const concurrentReconcile = testFixture.blobStore.reconcile(
      testFixture.artifactRegistry.expectedBlobs(),
    );
    const concurrentCreate = testFixture.client.createArtifact(createRequest);
    const [concurrentResult, concurrentReplay] = await Promise.all([
      concurrentReconcile,
      concurrentCreate,
    ]);
    expect(concurrentResult.removedOrphanPaths).toEqual([]);
    expect(concurrentReplay).toEqual(created);
    const storedDigest = contentHash(artifact.contentDigest);
    expect(
      await testFixture.blobStore.readVerified({
        digest: storedDigest,
        sizeBytes: artifact.sizeBytes,
        relativePath: nonEmptyText(
          `sha256/${storedDigest.slice(0, 2)}/${storedDigest.slice(2, 4)}/${storedDigest}`,
          "blob relative path",
        ),
      }),
    ).toEqual(CONTENT);
    const conflict = await expectConnectError(() =>
      testFixture.client.createArtifact(
        create(CreateArtifactRequestSchema, {
          ...createRequest,
          mediaType: "application/octet-stream",
          content: new TextEncoder().encode("conflicting content"),
        }),
      ),
    );
    expect(conflict.code).toBe(Code.FailedPrecondition);
    const conflictReconciliation = await testFixture.blobStore.reconcile(
      testFixture.artifactRegistry.expectedBlobs(),
    );
    expect(conflictReconciliation.removedOrphanPaths).toEqual([]);

    const fetched = await testFixture.client.getArtifact(
      create(GetArtifactRequestSchema, { artifactId: ROOT_ARTIFACT_ID }),
    );
    expect(fetched.artifact).toEqual(artifact);
    const read = await testFixture.client.readArtifact({ artifactId: ROOT_ARTIFACT_ID });
    expect(read.content).toEqual(CONTENT);
    expect(read.artifact).toEqual(artifact);

    const blobDirectory = dirname(
      join(
        testFixture.temporary.directory,
        "blobs",
        "sha256",
        artifact.contentDigest.slice(0, 2),
        artifact.contentDigest.slice(2, 4),
        artifact.contentDigest,
      ),
    );
    const blobPath = join(blobDirectory, artifact.contentDigest);
    await unlink(blobPath);
    const missingContent = await expectConnectError(() =>
      testFixture.client.readArtifact({ artifactId: ROOT_ARTIFACT_ID }),
    );
    expect(missingContent.code).toBe(Code.DataLoss);
    await rm(blobDirectory, { recursive: true, force: true });
    const missingDirectory = await expectConnectError(() =>
      testFixture.client.readArtifact({ artifactId: ROOT_ARTIFACT_ID }),
    );
    expect(missingDirectory.code).toBe(Code.DataLoss);
    await mkdir(blobDirectory, { recursive: true });
    await writeFile(blobPath, new TextEncoder().encode("corrupted"));
    const corrupted = await expectConnectError(() =>
      testFixture.client.readArtifact({ artifactId: ROOT_ARTIFACT_ID }),
    );
    expect(corrupted.code).toBe(Code.DataLoss);
    const corruptReplay = await expectConnectError(() =>
      testFixture.client.createArtifact(createRequest),
    );
    expect(corruptReplay.code).toBe(Code.DataLoss);
    await writeFile(blobPath, CONTENT);

    await executeTestSqliteWrite(testFixture.database, (transaction) => {
      transaction.run(
        `INSERT INTO artifacts (
           id, node_id, attempt_id, tree_id, repository_id, host_id,
           content_digest, artifact_type, evidence_id, retention_kind, created_at_ms
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [
          SECOND_ARTIFACT_ID,
          ROOT_NODE_ID,
          TREE_ID,
          REPOSITORY_ID,
          HOST_ID,
          artifact.contentDigest,
          "plan",
          SECOND_ARTIFACT_EVIDENCE_ID,
          NOW,
        ],
      );
    });
    const firstPage = await testFixture.client.listArtifacts(
      create(ListArtifactsRequestSchema, { nodeId: ROOT_NODE_ID, pageSize: 1 }),
    );
    expect(firstPage.artifacts).toHaveLength(1);
    expect(firstPage.nextArtifactId).toBe(ROOT_ARTIFACT_ID);
    const secondPage = await testFixture.client.listArtifacts(
      create(ListArtifactsRequestSchema, {
        nodeId: ROOT_NODE_ID,
        pageSize: 1,
        afterArtifactId: firstPage.nextArtifactId,
      }),
    );
    expect(secondPage.artifacts.map((entry) => entry.artifactId)).toEqual([SECOND_ARTIFACT_ID]);
    const emptyPage = await testFixture.client.listArtifacts(
      create(ListArtifactsRequestSchema, {
        nodeId: ROOT_NODE_ID,
        pageSize: 1,
        afterArtifactId: SECOND_ARTIFACT_ID,
      }),
    );
    expect(emptyPage.artifacts).toEqual([]);
    expect(emptyPage.nextArtifactId).toBeUndefined();

    const unknownGet = create(GetArtifactRequestSchema, { artifactId: ROOT_ARTIFACT_ID });
    unknownGet.$unknown = [{ no: 99, wireType: WireType.Varint, data: new Uint8Array([1]) }];
    const unknownError = await expectConnectError(() => testFixture.client.getArtifact(unknownGet));
    expect(unknownError.code).toBe(Code.InvalidArgument);
    const invalidPage = await expectConnectError(() =>
      testFixture.client.listArtifacts({ nodeId: ROOT_NODE_ID, pageSize: 0 }),
    );
    expect(invalidPage.code).toBe(Code.InvalidArgument);

    const artifactOutcome = await testFixture.client.recordNodeOutcome({
      commandId: OUTCOME_COMMAND_ID,
      actorSessionId: ACTOR_ID,
      nodeId: ROOT_NODE_ID,
      expectedNodeVersion: 1n,
      outcome: {
        case: "artifact",
        value: create(ArtifactOutcomeSchema, { artifactId: ROOT_ARTIFACT_ID }),
      },
    });
    expect(artifactOutcome.outcome?.outcome.case).toBe("artifact");
    const storedArtifactOutcome = await testFixture.client.getNodeOutcome({ nodeId: ROOT_NODE_ID });
    expect(storedArtifactOutcome.outcome).toEqual(artifactOutcome.outcome);

    await executeTestSqliteWrite(testFixture.database, (transaction) => {
      transaction.run(
        `INSERT INTO nodes (
           id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
           mode, objective, output_kind, output_artifact_id, output_artifact_type,
           state_kind, resume_state_kind, blocker_kind, blocker_evidence_id,
           blocker_parent_node_id, blocker_host_id, outcome_kind, outcome_artifact_id,
           outcome_content_hash, outcome_artifact_type, outcome_commit, outcome_evidence_id,
           outcome_explanation, terminal_evidence_id, superseded_plan_revision_id,
           version, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 'implementation', ?, 'implementation', NULL, NULL,
                   'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, 0, ?, ?)`,
        [
          CHILD_NODE_ID,
          TREE_ID,
          REPOSITORY_ID,
          HOST_ID,
          ROOT_NODE_ID,
          REVISION_ID,
          "consume the artifact",
          NOW,
          NOW,
        ],
      );
    });
    const noChange = await testFixture.client.recordNodeOutcome({
      commandId: NO_CHANGE_COMMAND_ID,
      actorSessionId: ACTOR_ID,
      nodeId: CHILD_NODE_ID,
      expectedNodeVersion: 0n,
      outcome: {
        case: "noChange",
        value: create(NoChangeOutcomeSchema, {
          revision: BASE_COMMIT,
          evidenceId: NO_CHANGE_EVIDENCE_ID,
          explanation: "the parent result is unchanged",
        }),
      },
    });
    expect(noChange.outcome?.outcome.case).toBe("noChange");
    if (noChange.outcome?.outcome.case !== "noChange") {
      throw new Error("expected no-change outcome");
    }
    expect(noChange.outcome.outcome.value.revision).toBe(BASE_COMMIT);
    const noChangeRead = await testFixture.client.getNodeOutcome({ nodeId: CHILD_NODE_ID });
    expect(noChangeRead.outcome).toEqual(noChange.outcome);

    const duplicateOutcome = await expectConnectError(() =>
      testFixture.client.recordNodeOutcome({
        commandId: commandId("01900000-0000-7000-8000-000000000016"),
        actorSessionId: ACTOR_ID,
        nodeId: CHILD_NODE_ID,
        expectedNodeVersion: 1n,
        outcome: {
          case: "commit",
          value: { revision: BASE_COMMIT, evidenceId: NO_CHANGE_EVIDENCE_ID },
        },
      }),
    );
    expect(duplicateOutcome.code).toBe(Code.InvalidArgument);
  });
});

async function createFixture(): Promise<Fixture> {
  const clock = new FixedClock(NOW);
  const temporary = await TemporarySqliteDatabase.create("host", clock);
  const database = temporary.database;
  const ids = new SequenceIdGenerator(generatedIds(0x100));
  const ports: DomainPorts = { clock, ids };
  const eventWaiter: EventCommitWaiter = createEventCommitWaiter();
  const commandStore = createSqliteCommandStore({ database, ports, notifier: eventWaiter });
  const repositories = createRepositoryRegistry({ database, commandStore, hostId: HOST_ID });
  const inspection: RepositoryInspection = {
    canonicalRoot: "/workspace/artifact-service",
    canonicalRemote: "https://example.test/artifact-service",
    defaultBranch: "main",
    baseCommit: BASE_COMMIT,
    caseSensitive: true,
    submodulePaths: [],
    lfsPaths: [],
    nestedRepositoryPaths: [],
    dirty: false,
  };
  await repositories.register({
    request: create(RegisterRepositoryRequestSchema, {
      commandId: REGISTER_COMMAND_ID,
      actorSessionId: ACTOR_ID,
      repositoryId: REPOSITORY_ID,
      rootPath: inspection.canonicalRoot,
    }),
    inspection,
    allowedWorkspaceRoot: join(temporary.directory, "workspaces"),
    registeredAt: NOW,
  });
  const planRegistry = createPlanRegistry({ database, commandStore, hostId: HOST_ID });
  await planRegistry.create({
    request: create(CreateTreeRequestSchema, {
      commandId: CREATE_TREE_COMMAND_ID,
      actorSessionId: ACTOR_ID,
      repositoryId: REPOSITORY_ID,
      treeId: TREE_ID,
      planRevisionId: REVISION_ID,
      rootNodeId: ROOT_NODE_ID,
      rootArtifactId: ROOT_ARTIFACT_ID,
      goal: "produce an artifact",
      baseCommit: BASE_COMMIT,
      budget: create(TreeBudgetSchema, {
        maxDepth: 4,
        maxFanOut: 4,
        maxNodes: 4,
        maxConcurrency: 2,
        maxAttemptsPerNode: 2,
      }),
      attentionId: ATTENTION_ID,
      rootAllowedRepositoryPaths: ["."],
      rootCheckProfile: "artifact-check",
    }),
    at: NOW,
  });
  await executeTestSqliteWrite(database, (transaction) => {
    transaction.run(
      "UPDATE plan_revisions SET state_kind = 'approved', approved_at_ms = ? WHERE id = ?",
      [NOW, REVISION_ID],
    );
    transaction.run(
      "UPDATE plan_attentions SET state_kind = 'resolved', resolved_at_ms = ? WHERE id = ?",
      [NOW, ATTENTION_ID],
    );
    transaction.run("UPDATE trees SET active_plan_revision_id = ? WHERE id = ?", [
      REVISION_ID,
      TREE_ID,
    ]);
    transaction.run("UPDATE nodes SET state_kind = 'active' WHERE id = ?", [ROOT_NODE_ID]);
  });
  const artifactRegistry = createSqliteArtifactRegistry({
    database,
    commandStore,
    hostId: HOST_ID,
  });
  const blobStore = createFileContentBlobStore({
    rootPath: join(temporary.directory, "blobs"),
    clock,
    ids: new SequenceIdGenerator(generatedIds(0x1000)),
  });
  const server = await startDaemonServer({
    mode: "host",
    port: 0,
    database,
    eventWaiter,
    eventPollIntervalMs: 10,
    planRegistry,
    clock,
    steeringStore: createSqliteSteeringCommandStore({ database, commandStore, ports }),
    artifactRegistry,
    blobStore,
    system: {
      serverVersion: "0.0.0",
      health: createHealth(HOST_ID),
      runDoctor: () => Promise.resolve(createDoctor()),
    },
  });
  const transport = createConnectTransport({
    baseUrl: server.baseUrl,
    httpVersion: "1.1",
    useBinaryFormat: true,
  });
  return {
    temporary,
    database,
    commandStore,
    artifactRegistry,
    blobStore,
    clock,
    server,
    client: createClient(ArtifactService, transport),
  };
}

function generatedIds(start: number, count = 256): readonly string[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = (start + index).toString(16).padStart(12, "0");
    return `01900000-0000-7000-8000-${suffix}`;
  });
}

function requireArtifact(value: Artifact | undefined): Artifact {
  if (value === undefined) {
    throw new Error("artifact response is missing its artifact");
  }
  return value;
}

function requireFixture(value: Fixture | undefined): Fixture {
  if (value === undefined) {
    throw new Error("artifact service fixture was not created");
  }
  return value;
}

function createHealth(currentHostId: string) {
  return create(GetHealthResponseSchema, {
    instanceId: "01900000-0000-7000-8000-000000000017",
    mode: DaemonMode.HOST,
    hostId: currentHostId,
    startedAt: create(TimestampSchema, { seconds: 1_700_000_000n }),
  });
}

function createDoctor() {
  return create(RunDoctorResponseSchema, {
    status: DoctorStatus.HEALTHY,
    checks: [],
  });
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
