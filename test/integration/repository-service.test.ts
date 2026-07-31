import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import type { Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  ApiVersionSchema,
  GetServerInfoRequestSchema,
  ListRepositoriesRequestSchema,
  RegisterRepositoryRequestSchema,
  RepositoryService,
  ServerCapability,
  SystemService,
} from "@minions/contracts";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

import type { RegisterRepositoryRequest } from "@minions/contracts";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { describe, expect, it } from "vitest";

import { main as runCli } from "../../apps/cli/src/index.js";
import { createStructuredLogger, startDaemonRuntime } from "@minions/daemon";
import type { RunningDaemonRuntime, StructuredLogger } from "@minions/daemon";

const STARTED_AT_MS = 1_700_000_000_000;
const RESTARTED_AT_MS = STARTED_AT_MS + 1_000;
const FIRST_INSTANCE_ID = "01900000-0000-7000-8000-000000000001";
const FIRST_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000002";
const FIRST_EVENT_ID = "01900000-0000-7000-8000-000000000003";
const SECOND_EVENT_ID = "01900000-0000-7000-8000-000000000004";
const RESTART_INSTANCE_ID = "01900000-0000-7000-8000-000000000005";
const RESTART_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000006";
const POLICY_INSTANCE_ID = "01900000-0000-7000-8000-000000000007";
const POLICY_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000008";
const POLICY_EVENT_ID = "01900000-0000-7000-8000-000000000009";
const CLI_INSTANCE_ID = "01900000-0000-7000-8000-00000000000a";
const CLI_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-00000000000b";
const CLI_EVENT_ID = "01900000-0000-7000-8000-00000000000c";

const REGISTER_COMMAND_A = "01900000-0000-7000-8000-000000000101";
const REGISTER_ACTOR_A = "01900000-0000-7000-8000-000000000102";
const REGISTER_REPOSITORY_A = "01900000-0000-7000-8000-000000000103";
const REGISTER_COMMAND_B = "01900000-0000-7000-8000-000000000104";
const REGISTER_ACTOR_B = "01900000-0000-7000-8000-000000000105";
const REGISTER_REPOSITORY_B = "01900000-0000-7000-8000-000000000106";

const POLICY_COMMAND_DIRTY = "01900000-0000-7000-8000-000000000201";
const POLICY_ACTOR_DIRTY = "01900000-0000-7000-8000-000000000202";
const POLICY_REPOSITORY_DIRTY = "01900000-0000-7000-8000-000000000203";
const POLICY_COMMAND_NESTED = "01900000-0000-7000-8000-000000000204";
const POLICY_ACTOR_NESTED = "01900000-0000-7000-8000-000000000205";
const POLICY_REPOSITORY_NESTED = "01900000-0000-7000-8000-000000000206";
const POLICY_COMMAND_WORKTREE = "01900000-0000-7000-8000-000000000207";
const POLICY_ACTOR_WORKTREE = "01900000-0000-7000-8000-000000000208";
const POLICY_REPOSITORY_WORKTREE = "01900000-0000-7000-8000-000000000209";
const POLICY_COMMAND_ORIGINAL = "01900000-0000-7000-8000-00000000020a";
const POLICY_ACTOR_ORIGINAL = "01900000-0000-7000-8000-00000000020b";
const POLICY_REPOSITORY_ORIGINAL = "01900000-0000-7000-8000-00000000020c";
const POLICY_COMMAND_OVERLAP = "01900000-0000-7000-8000-00000000020d";
const POLICY_ACTOR_OVERLAP = "01900000-0000-7000-8000-00000000020e";
const POLICY_REPOSITORY_OVERLAP = "01900000-0000-7000-8000-00000000020f";

const POLICY_COMMAND_HOME = "01900000-0000-7000-8000-000000000213";
const POLICY_ACTOR_HOME = "01900000-0000-7000-8000-000000000214";
const POLICY_REPOSITORY_HOME = "01900000-0000-7000-8000-000000000215";
const POLICY_COMMAND_WORKSPACE = "01900000-0000-7000-8000-000000000216";
const POLICY_ACTOR_WORKSPACE = "01900000-0000-7000-8000-000000000217";
const POLICY_REPOSITORY_WORKSPACE = "01900000-0000-7000-8000-000000000218";
interface GitFixture {
  readonly directory: string;
  readonly origin: string;
  readonly root: string;
  readonly remote: string;
  readonly baseCommit: string;
}

type Clients = Readonly<{
  system: Client<typeof SystemService>;
  repository: Client<typeof RepositoryService>;
}>;

type LogCapture = Readonly<{
  lines: string[];
  stream: Writable;
}>;

type DatabaseState = Readonly<{
  repositories: readonly Record<string, unknown>[];
  registrations: readonly Record<string, unknown>[];
  features: readonly Record<string, unknown>[];
  commands: readonly Record<string, unknown>[];
  idempotency: readonly Record<string, unknown>[];
  events: readonly Record<string, unknown>[];
}>;

type CliRepository = Readonly<{
  id: string;
  host_id: string;
  canonical_root: string;
  canonical_remote: string;
  default_branch: string;
  base_commit: string;
  allowed_workspace_root: string;
  case_sensitive: boolean;
  submodule_paths: readonly string[];
  lfs_paths: readonly string[];
  nested_repository_paths: readonly string[];
  registered_at?: Readonly<{ seconds: string; nanos: number }>;
}>;

type CliRegisterResponse = Readonly<{ repository: CliRepository }>;
type CliGetResponse = Readonly<{ repository: CliRepository }>;
type CliListResponse = Readonly<{ repositories: readonly CliRepository[] }>;
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function requireBoolean(record: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function requireStrings(
  record: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] {
  const value = record[field];
  if (!isUnknownArray(value)) {
    throw new TypeError(`${field} must be a string array`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new TypeError(`${field} must be a string array`);
    }
    return entry;
  });
}

function parseCliRepository(value: unknown): CliRepository {
  const repository = requireRecord(value, "repository");
  const registeredAtValue = repository["registered_at"];
  let registeredAt: Readonly<{ seconds: string; nanos: number }> | undefined;
  if (registeredAtValue !== undefined) {
    const timestamp = requireRecord(registeredAtValue, "registered_at");
    const nanos = timestamp["nanos"];
    if (typeof nanos !== "number") {
      throw new TypeError("registered_at.nanos must be a number");
    }
    registeredAt = { seconds: requireString(timestamp, "seconds"), nanos };
  }
  return {
    id: requireString(repository, "id"),
    host_id: requireString(repository, "host_id"),
    canonical_root: requireString(repository, "canonical_root"),
    canonical_remote: requireString(repository, "canonical_remote"),
    default_branch: requireString(repository, "default_branch"),
    base_commit: requireString(repository, "base_commit"),
    allowed_workspace_root: requireString(repository, "allowed_workspace_root"),
    case_sensitive: requireBoolean(repository, "case_sensitive"),
    submodule_paths: requireStrings(repository, "submodule_paths"),
    lfs_paths: requireStrings(repository, "lfs_paths"),
    nested_repository_paths: requireStrings(repository, "nested_repository_paths"),
    ...(registeredAt === undefined ? {} : { registered_at: registeredAt }),
  };
}

function parseCliRegisterResponse(value: unknown): CliRegisterResponse {
  return { repository: parseCliRepository(requireRecord(value, "response")["repository"]) };
}

function parseCliGetResponse(value: unknown): CliGetResponse {
  return { repository: parseCliRepository(requireRecord(value, "response")["repository"]) };
}

function parseCliListResponse(value: unknown): CliListResponse {
  const repositories = requireRecord(value, "response")["repositories"];
  if (!isUnknownArray(repositories)) {
    throw new TypeError("repositories must be an array");
  }
  return { repositories: repositories.map((repository) => parseCliRepository(repository)) };
}

function createLogCapture(): LogCapture {
  const lines: string[] = [];
  const stream = new Writable({
    write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { lines, stream };
}

function connectClients(baseUrl: string): Clients {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "1.1",
    useBinaryFormat: true,
    nodeOptions: { agent: false },
  });
  return {
    system: createClient(SystemService, transport),
    repository: createClient(RepositoryService, transport),
  };
}

function runtimeOptions(
  home: string,
  port: number,
  clock: FixedClock,
  ids: SequenceIdGenerator,
  logger: StructuredLogger,
) {
  return {
    home,
    mode: "local" as const,
    port,
    serverVersion: "1.0.0",
    clock,
    ids,
    logger,
    displayName: "repository-service-test-host",
  };
}

function registerRequest(
  commandId: string,
  actorSessionId: string,
  repositoryId: string,
  rootPath: string,
): RegisterRepositoryRequest {
  return create(RegisterRepositoryRequestSchema, {
    commandId,
    actorSessionId,
    repositoryId,
    rootPath,
  });
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function createGitFixture(name: string): Promise<GitFixture> {
  const directory = await mkdtemp(join(tmpdir(), `minions-repository-service-${name}-`));
  const origin = join(directory, "origin.git");
  const root = join(directory, "working");
  const remote = `https://github.com/Minions/${name}`;
  try {
    await runGit(directory, ["init", "--bare", origin]);
    await runGit(directory, ["clone", origin, root]);
    await runGit(root, ["config", "user.name", "Repository Service Test"]);
    await runGit(root, ["config", "user.email", "repository-service@example.test"]);
    await runGit(root, ["checkout", "-b", "main"]);
    await writeFile(join(root, "README.md"), `${name}\n`, "utf8");
    await runGit(root, ["add", "README.md"]);
    await runGit(root, ["commit", "-m", "initial"]);
    await runGit(root, ["push", "--set-upstream", "origin", "main"]);
    await runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await runGit(root, ["fetch", "origin"]);
    await runGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const baseCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    await runGit(root, ["remote", "set-url", "origin", remote]);
    return { directory, origin, root, remote, baseCommit };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function addNestedRepository(fixture: GitFixture): Promise<void> {
  const nested = join(fixture.root, "nested");
  await mkdir(nested);
  await runGit(nested, ["init"]);
  await runGit(fixture.root, ["remote", "set-url", "origin", fixture.origin]);
  try {
    await writeFile(join(fixture.root, ".gitignore"), "nested/\n", "utf8");
    await runGit(fixture.root, ["add", ".gitignore"]);
    await runGit(fixture.root, ["commit", "-m", "ignore nested repository"]);
    await runGit(fixture.root, ["push", "origin", "main"]);
  } finally {
    await runGit(fixture.root, ["remote", "set-url", "origin", fixture.remote]);
  }
}

async function createLinkedWorktree(fixture: GitFixture): Promise<string> {
  const worktree = join(fixture.directory, "linked-worktree");
  await runGit(fixture.root, ["worktree", "add", "--detach", worktree]);
  return worktree;
}

async function cloneRepository(origin: string, target: string, remote: string): Promise<string> {
  await runGit(dirname(target), ["clone", origin, target]);
  await runGit(target, ["remote", "set-url", "origin", remote]);
  return target;
}

async function changeOriginDefaultBranch(fixture: GitFixture): Promise<string> {
  await runGit(fixture.root, ["checkout", "-b", "develop"]);
  await writeFile(join(fixture.root, "develop.txt"), "develop\n", "utf8");
  await runGit(fixture.root, ["add", "develop.txt"]);
  await runGit(fixture.root, ["commit", "-m", "develop"]);
  const developCommit = (await runGit(fixture.root, ["rev-parse", "HEAD"])).trim();
  await runGit(fixture.root, ["remote", "set-url", "origin", fixture.origin]);
  try {
    await runGit(fixture.root, ["push", "origin", "develop"]);
    await runGit(fixture.origin, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
    await runGit(fixture.root, ["fetch", "origin", "develop"]);
  } finally {
    await runGit(fixture.root, ["remote", "set-url", "origin", fixture.remote]);
  }
  await runGit(fixture.root, ["update-ref", "refs/remotes/origin/develop", developCommit]);
  await runGit(fixture.root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/develop",
  ]);
  await runGit(fixture.root, ["checkout", "main"]);
  return developCommit;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const rejectOnError = (error: Error): void => {
    reject(error);
  };
  server.once("error", rejectOnError);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.off("error", rejectOnError);
      reject(new Error("loopback port reservation did not bind to a TCP address"));
      return;
    }
    server.close((error) => {
      server.off("error", rejectOnError);
      if (error === undefined) {
        resolve(address.port);
      } else {
        reject(error);
      }
    });
  });
  return promise;
}

async function closeWritable(stream: Writable): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  stream.end((error?: Error | null) => {
    if (error === undefined || error === null) {
      resolve(undefined);
    } else {
      reject(error);
    }
  });
  await promise;
}

async function expectConnectCode<T>(
  action: () => Promise<T>,
  expected: Code,
): Promise<ConnectError> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConnectError);
  if (!(thrown instanceof ConnectError)) {
    throw new Error("expected a ConnectError");
  }
  expect(thrown.code).toBe(expected);
  return thrown;
}

function withReadOnlyDatabase<T>(path: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readBigInts: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function readDatabaseState(path: string): DatabaseState {
  return withReadOnlyDatabase(path, (database) => ({
    repositories: database.prepare("SELECT * FROM repositories ORDER BY id").all(),
    registrations: database
      .prepare("SELECT * FROM repository_registrations ORDER BY repository_id")
      .all(),
    features: database
      .prepare(
        "SELECT * FROM repository_features ORDER BY repository_id, feature_kind, relative_path",
      )
      .all(),
    commands: database.prepare("SELECT * FROM operator_commands ORDER BY id").all(),
    idempotency: database.prepare("SELECT * FROM idempotency_records ORDER BY command_id").all(),
    events: database.prepare("SELECT * FROM events ORDER BY sequence").all(),
  }));
}

async function captureCliJson<T>(
  action: () => Promise<number>,
  parse: (value: unknown) => T,
): Promise<Readonly<{ code: number; json: T }>> {
  const chunks: string[] = [];
  const stream = new Writable({
    write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  const original = process.stdout;
  Object.defineProperty(process, "stdout", {
    configurable: true,
    value: stream,
  });
  try {
    const code = await action();
    const value: unknown = JSON.parse(chunks.join(""));
    return { code, json: parse(value) };
  } finally {
    Object.defineProperty(process, "stdout", {
      configurable: true,
      value: original,
    });
    await closeWritable(stream);
  }
}

describe("repository service integration", () => {
  it("round-trips Connect registrations, replays exact commands, paginates, and persists across restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-repository-service-home-"));
    const capture = createLogCapture();
    const fixtures: GitFixture[] = [];
    let runtime: RunningDaemonRuntime | undefined;
    let restartedRuntime: RunningDaemonRuntime | undefined;
    try {
      fixtures.push(await createGitFixture("connect-alpha"));
      fixtures.push(await createGitFixture("connect-beta"));
      const [alpha, beta] = fixtures;
      if (alpha === undefined || beta === undefined) {
        throw new Error("repository fixtures were not created");
      }
      const port = await reserveLoopbackPort();
      const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
      const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([
            FIRST_INSTANCE_ID,
            FIRST_HOST_CANDIDATE_ID,
            FIRST_EVENT_ID,
            SECOND_EVENT_ID,
          ]),
          logger,
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const daemonHome = runtime.home;
      const clients = connectClients(runtime.server.baseUrl);
      const serverInfo = await clients.system.getServerInfo(
        create(GetServerInfoRequestSchema, {
          clientName: "repository-service-test",
          apiVersion: create(ApiVersionSchema, { major: 1 }),
        }),
      );
      expect(serverInfo.capabilities).toContain(ServerCapability.REPOSITORY_REGISTRY);

      const alphaRequest = registerRequest(
        REGISTER_COMMAND_A,
        REGISTER_ACTOR_A,
        REGISTER_REPOSITORY_A,
        alpha.root,
      );
      expect("taskPath" in alphaRequest).toBe(false);
      expect("remote" in alphaRequest).toBe(false);
      expect("remotePath" in alphaRequest).toBe(false);
      const alphaResponse = await clients.repository.registerRepository(alphaRequest);
      expect(alphaResponse.repository).toMatchObject({
        id: REGISTER_REPOSITORY_A,
        hostId,
        canonicalRoot: await realpath(alpha.root),
        canonicalRemote: alpha.remote,
        defaultBranch: "main",
        baseCommit: alpha.baseCommit,
        allowedWorkspaceRoot: join(daemonHome, "workspaces", REGISTER_REPOSITORY_A),
        submodulePaths: [],
        lfsPaths: [],
        nestedRepositoryPaths: [],
      });
      expect(typeof alphaResponse.repository?.caseSensitive).toBe("boolean");
      const replayResponse = await clients.repository.registerRepository(alphaRequest);
      expect(replayResponse).toEqual(alphaResponse);

      const betaResponse = await clients.repository.registerRepository(
        registerRequest(REGISTER_COMMAND_B, REGISTER_ACTOR_B, REGISTER_REPOSITORY_B, beta.root),
      );
      expect(betaResponse.repository?.id).toBe(REGISTER_REPOSITORY_B);

      const firstPage = await clients.repository.listRepositories(
        create(ListRepositoriesRequestSchema, { pageSize: 1 }),
      );
      expect(firstPage.repositories).toHaveLength(1);
      expect(firstPage.repositories[0]?.id).toBe(REGISTER_REPOSITORY_A);
      expect(firstPage.nextPageToken).toBe(REGISTER_REPOSITORY_A);
      const secondPage = await clients.repository.listRepositories(
        create(ListRepositoriesRequestSchema, {
          pageSize: 1,
          pageToken: firstPage.nextPageToken,
        }),
      );
      expect(secondPage.repositories.map((repository) => repository.id)).toEqual([
        REGISTER_REPOSITORY_B,
      ]);
      expect(secondPage.nextPageToken).toBeUndefined();

      const fetchedAlpha = await clients.repository.getRepository({
        repositoryId: REGISTER_REPOSITORY_A,
      });
      expect(fetchedAlpha.repository).toEqual(alphaResponse.repository);

      await runtime.close();
      runtime = undefined;
      const hostDatabasePath = join(home, "hosts", hostId, "host.db");
      const persisted = readDatabaseState(hostDatabasePath);
      expect(persisted.repositories).toHaveLength(2);
      expect(persisted.registrations).toHaveLength(2);
      expect(persisted.features).toHaveLength(0);
      expect(persisted.commands).toHaveLength(2);
      expect(persisted.idempotency).toHaveLength(2);
      expect(persisted.events).toHaveLength(2);
      expect(persisted.registrations[0]).toMatchObject({
        repository_id: REGISTER_REPOSITORY_A,
        host_id: hostId,
        canonical_root: await realpath(alpha.root),
        canonical_remote: alpha.remote,
        default_branch: "main",
        base_commit: alpha.baseCommit,
        allowed_workspace_root: join(daemonHome, "workspaces", REGISTER_REPOSITORY_A),
        case_sensitive: alphaResponse.repository?.caseSensitive === true ? 1n : 0n,
        registered_at_ms: BigInt(STARTED_AT_MS),
      });

      const restartedClock = new FixedClock(timestampFromEpochMilliseconds(RESTARTED_AT_MS));
      const restartedLogger = createStructuredLogger({
        stream: capture.stream,
        now: () => RESTARTED_AT_MS,
      });
      restartedRuntime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          restartedClock,
          new SequenceIdGenerator([RESTART_INSTANCE_ID, RESTART_HOST_CANDIDATE_ID]),
          restartedLogger,
        ),
      );
      expect(restartedRuntime.hostId).toBe(hostId);
      const restartedClients = connectClients(restartedRuntime.server.baseUrl);
      const restartedAlpha = await restartedClients.repository.getRepository({
        repositoryId: REGISTER_REPOSITORY_A,
      });
      expect(restartedAlpha.repository).toEqual(alphaResponse.repository);
      const restartedList = await restartedClients.repository.listRepositories(
        create(ListRepositoriesRequestSchema, { pageSize: 100 }),
      );
      expect(restartedList.repositories.map((repository) => repository.id)).toEqual([
        REGISTER_REPOSITORY_A,
        REGISTER_REPOSITORY_B,
      ]);
      await restartedRuntime.close();
      restartedRuntime = undefined;
    } finally {
      await restartedRuntime?.close();
      await runtime?.close();
      await closeWritable(capture.stream);
      await Promise.all(
        fixtures.map((fixture) => rm(fixture.directory, { force: true, recursive: true })),
      );
      await rm(home, { force: true, recursive: true });
    }
  });

  it("maps dirty, nested, linked-worktree, overlap, and changed-default policies to typed failures", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-repository-service-policy-home-"));
    const capture = createLogCapture();
    const fixtures: GitFixture[] = [];
    let runtime: RunningDaemonRuntime | undefined;
    try {
      fixtures.push(await createGitFixture("policy-dirty"));
      fixtures.push(await createGitFixture("policy-nested"));
      fixtures.push(await createGitFixture("policy-worktree"));
      fixtures.push(await createGitFixture("policy-original"));
      const [dirty, nested, worktree, original] = fixtures;
      if (
        dirty === undefined ||
        nested === undefined ||
        worktree === undefined ||
        original === undefined
      ) {
        throw new Error("repository fixtures were not created");
      }
      await writeFile(join(dirty.root, "README.md"), "dirty\n", "utf8");
      await addNestedRepository(nested);
      const linked = await createLinkedWorktree(worktree);
      const port = await reserveLoopbackPort();
      const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
      const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([POLICY_INSTANCE_ID, POLICY_HOST_CANDIDATE_ID, POLICY_EVENT_ID]),
          logger,
        ),
      );
      const clients = connectClients(runtime.server.baseUrl);
      const homeRepository = await cloneRepository(
        original.origin,
        join(runtime.home, "repository-inside-home"),
        "https://github.com/Minions/repository-inside-home",
      );
      await mkdir(join(runtime.home, "workspaces"), { recursive: true });
      const workspaceRepository = await cloneRepository(
        original.origin,
        join(runtime.home, "workspaces", "repository-inside-workspace"),
        "https://github.com/Minions/repository-inside-workspace",
      );
      await expectConnectCode(
        () =>
          clients.repository.registerRepository(
            registerRequest(
              POLICY_COMMAND_HOME,
              POLICY_ACTOR_HOME,
              POLICY_REPOSITORY_HOME,
              homeRepository,
            ),
          ),
        Code.FailedPrecondition,
      );
      await expectConnectCode(
        () =>
          clients.repository.registerRepository(
            registerRequest(
              POLICY_COMMAND_WORKSPACE,
              POLICY_ACTOR_WORKSPACE,
              POLICY_REPOSITORY_WORKSPACE,
              workspaceRepository,
            ),
          ),
        Code.FailedPrecondition,
      );

      await expectConnectCode(
        () => clients.repository.getRepository({ repositoryId: POLICY_REPOSITORY_HOME }),
        Code.NotFound,
      );
      await expectConnectCode(
        () => clients.repository.getRepository({ repositoryId: POLICY_REPOSITORY_WORKSPACE }),
        Code.NotFound,
      );

      await expectConnectCode(
        () =>
          clients.repository.registerRepository(
            registerRequest(
              POLICY_COMMAND_DIRTY,
              POLICY_ACTOR_DIRTY,
              POLICY_REPOSITORY_DIRTY,
              dirty.root,
            ),
          ),
        Code.FailedPrecondition,
      );
      await expectConnectCode(
        () =>
          clients.repository.registerRepository(
            registerRequest(
              POLICY_COMMAND_NESTED,
              POLICY_ACTOR_NESTED,
              POLICY_REPOSITORY_NESTED,
              nested.root,
            ),
          ),
        Code.FailedPrecondition,
      );
      await expectConnectCode(
        () =>
          clients.repository.registerRepository(
            registerRequest(
              POLICY_COMMAND_WORKTREE,
              POLICY_ACTOR_WORKTREE,
              POLICY_REPOSITORY_WORKTREE,
              linked,
            ),
          ),
        Code.FailedPrecondition,
      );

      const originalResponse = await clients.repository.registerRepository(
        registerRequest(
          POLICY_COMMAND_ORIGINAL,
          POLICY_ACTOR_ORIGINAL,
          POLICY_REPOSITORY_ORIGINAL,
          original.root,
        ),
      );

      const developCommit = await changeOriginDefaultBranch(original);
      expect(developCommit).not.toBe(originalResponse.repository?.baseCommit);
      await expectConnectCode(
        () =>
          clients.repository.registerRepository(
            registerRequest(
              POLICY_COMMAND_ORIGINAL,
              POLICY_ACTOR_ORIGINAL,
              POLICY_REPOSITORY_ORIGINAL,
              original.root,
            ),
          ),
        Code.FailedPrecondition,
      );
      const child = await cloneRepository(
        original.origin,
        join(original.root, "child-repository"),
        "https://github.com/Minions/child-repository",
      );
      await expectConnectCode(
        () =>
          clients.repository.registerRepository(
            registerRequest(
              POLICY_COMMAND_OVERLAP,
              POLICY_ACTOR_OVERLAP,
              POLICY_REPOSITORY_OVERLAP,
              child,
            ),
          ),
        Code.FailedPrecondition,
      );
      const unchanged = await clients.repository.getRepository({
        repositoryId: POLICY_REPOSITORY_ORIGINAL,
      });
      expect(unchanged.repository).toEqual(originalResponse.repository);

      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      await runtime.close();
      runtime = undefined;
      const persisted = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(persisted.repositories).toHaveLength(1);
      expect(persisted.registrations).toHaveLength(1);
      expect(persisted.commands).toHaveLength(1);
      expect(persisted.idempotency).toHaveLength(1);
      expect(persisted.events).toHaveLength(1);
      expect(persisted.registrations[0]).toMatchObject({
        repository_id: POLICY_REPOSITORY_ORIGINAL,
        default_branch: "main",
        base_commit: originalResponse.repository?.baseCommit,
      });
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await Promise.all(
        fixtures.map((fixture) => rm(fixture.directory, { force: true, recursive: true })),
      );
      await rm(home, { force: true, recursive: true });
    }
  });

  it("returns repository registration, get, and list JSON through the direct CLI main", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-repository-service-cli-home-"));
    const capture = createLogCapture();
    const fixture = await createGitFixture("cli");
    let runtime: RunningDaemonRuntime | undefined;
    try {
      const port = await reserveLoopbackPort();
      const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
      const logger = createStructuredLogger({ stream: capture.stream, now: () => STARTED_AT_MS });
      runtime = await startDaemonRuntime(
        runtimeOptions(
          home,
          port,
          clock,
          new SequenceIdGenerator([CLI_INSTANCE_ID, CLI_HOST_CANDIDATE_ID, CLI_EVENT_ID]),
          logger,
        ),
      );
      const hostId = runtime.hostId;
      if (hostId === undefined) {
        throw new Error("local runtime did not produce a host ID");
      }
      const daemonHome = runtime.home;
      const root = await realpath(fixture.root);
      const registration = await captureCliJson(
        () => runCli(["repository", "register", fixture.root, "--home", home]),
        parseCliRegisterResponse,
      );
      expect(registration.code).toBe(0);
      expect(registration.json.repository).toMatchObject({
        host_id: hostId,
        canonical_root: root,
        canonical_remote: fixture.remote,
        default_branch: "main",
        base_commit: fixture.baseCommit,
        allowed_workspace_root: join(daemonHome, "workspaces", registration.json.repository.id),
        submodule_paths: [],
        lfs_paths: [],
        nested_repository_paths: [],
      });
      const fetched = await captureCliJson(
        () => runCli(["repository", "get", registration.json.repository.id, "--home", home]),
        parseCliGetResponse,
      );
      expect(fetched.code).toBe(0);
      expect(fetched.json.repository).toEqual(registration.json.repository);
      const listed = await captureCliJson(
        () => runCli(["repository", "list", "--home", home]),
        parseCliListResponse,
      );
      expect(listed.code).toBe(0);
      expect(listed.json.repositories).toEqual([registration.json.repository]);
      await runtime.close();
      runtime = undefined;
      const persisted = readDatabaseState(join(home, "hosts", hostId, "host.db"));
      expect(persisted.registrations).toHaveLength(1);
      expect(persisted.registrations[0]).toMatchObject({
        repository_id: registration.json.repository.id,
        host_id: hostId,
        canonical_root: root,
      });
    } finally {
      await runtime?.close();
      await closeWritable(capture.stream);
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });
});
