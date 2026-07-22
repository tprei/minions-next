#!/usr/bin/env node

import { create } from "@bufbuild/protobuf";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AuthBrokerError,
  createAuthBrokerManager,
  createCredentialVault,
  createSecureIdGenerator,
  daemonLifecyclePath,
  inspectLifecycleLock,
  type AuthBrokerManager,
  type DaemonModeName,
  type SystemdCredsKeyMode,
} from "@minions/adapters";
import {
  ApiVersionSchema,
  ApprovePlanRequestSchema,
  ArtifactInputSchema,
  ArtifactOutputContractSchema,
  CreateTreeRequestSchema,
  DoctorStatus,
  GetTreeRequestSchema,
  HostService,
  ImplementationOutputContractSchema,
  ListHostsRequestSchema,
  ListRepositoriesRequestSchema,
  ListTreesRequestSchema,
  NodeState,
  PlanAttentionKind,
  PlanAttentionState,
  PlanNodeMode,
  PlanRevisionState,
  ProposePlanRequestSchema,
  ProposedNodeSchema,
  RepairPlanRequestSchema,
  RepositoryService,
  SystemService,
  TreeBudgetSchema,
  TreeService,
  TreeState,
  type ArtifactInput,
  type ExecutionHost,
  type PlanAttention,
  type PlanRevision,
  type RegisteredRepository,
  type TaskNode,
  type TaskTree,
  type TreeBudget,
  type TreeSummary,
} from "@minions/contracts";
import { hostId, timestampFromEpochMilliseconds, type HostId } from "@minions/core";
import { main as runDaemon } from "@minions/daemon";

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const invocation = parseInvocation(argv);
    switch (invocation.command) {
      case "start":
        return await start(invocation);
      case "stop":
        return await stop(invocation.home);
      case "status":
        return await status(invocation.home);
      case "doctor":
        return await doctor(invocation.home);
      case "host-list":
        return await listHosts(invocation.home);
      case "repository-register":
        return await registerRepository(invocation.home, invocation.rootPath);
      case "repository-get":
        return await getRepository(invocation.home, invocation.repositoryId);
      case "repository-list":
        return await listRepositories(invocation.home);
      case "tree-create":
        return await createTree(
          invocation.home,
          invocation.repositoryId,
          invocation.goal,
          invocation.baseCommit,
          invocation.rootAllowedRepositoryPath,
          invocation.rootCheckProfile,
          invocation.budget,
        );
      case "tree-get":
        return await getTree(invocation.home, invocation.treeId);
      case "tree-list":
        return await listTrees(invocation.home);
      case "tree-propose":
        return await proposePlan(
          invocation.home,
          invocation.treeId,
          invocation.planRevisionId,
          invocation.planPath,
        );
      case "tree-repair":
        return await repairPlan(
          invocation.home,
          invocation.treeId,
          invocation.planRevisionId,
          invocation.attentionId,
          invocation.planPath,
        );
      case "tree-approve":
        return await approvePlan(invocation.home, invocation.treeId, invocation.planRevisionId);
      case "auth-login":
        return await authLogin(invocation);
      case "auth-status":
        return await authStatus(invocation);
      case "auth-logout":
        return await authLogout(invocation);
    }
  } catch (error) {
    writeError(error);
    return exitCode(error);
  }
}

type StartInvocation = Readonly<{
  command: "start";
  home: string;
  mode: DaemonModeName;
  port: number;
  hostId?: HostId;
}>;

type TreeBudgetInput = Readonly<{
  maxDepth: number;
  maxFanOut: number;
  maxNodes: number;
  maxConcurrency: number;
  maxAttemptsPerNode: number;
}>;

type Invocation =
  | StartInvocation
  | Readonly<{
      command: "stop" | "status" | "doctor" | "host-list" | "repository-list" | "tree-list";
      home: string;
    }>
  | Readonly<{
      command: "repository-register";
      home: string;
      rootPath: string;
    }>
  | Readonly<{
      command: "repository-get";
      home: string;
      repositoryId: string;
    }>
  | Readonly<{
      command: "tree-create";
      home: string;
      repositoryId: string;
      goal: string;
      baseCommit: string;
      rootAllowedRepositoryPath: string;
      rootCheckProfile: string;
      budget: TreeBudgetInput;
    }>
  | Readonly<{
      command: "tree-get";
      home: string;
      treeId: string;
    }>
  | Readonly<{
      command: "tree-propose";
      home: string;
      treeId: string;
      planRevisionId: string;
      planPath: string;
    }>
  | Readonly<{
      command: "tree-repair";
      home: string;
      treeId: string;
      planRevisionId: string;
      attentionId: string;
      planPath: string;
    }>
  | Readonly<{
      command: "tree-approve";
      home: string;
      treeId: string;
      planRevisionId: string;
    }>
  | AuthLoginInvocation
  | AuthStatusInvocation
  | AuthLogoutInvocation;

type AuthLoginInvocation = Readonly<{
  command: "auth-login";
  home: string;
  hostId: HostId;
  provider: string;
  via?: string;
  vaultStoreDirectory?: string;
  vaultKeyMode?: SystemdCredsKeyMode;
}>;

type AuthStatusInvocation = Readonly<{
  command: "auth-status";
  home: string;
  hostId: HostId;
  vaultStoreDirectory?: string;
  vaultKeyMode?: SystemdCredsKeyMode;
}>;

type AuthLogoutInvocation = Readonly<{
  command: "auth-logout";
  home: string;
  hostId: HostId;
  provider: string;
  vaultStoreDirectory?: string;
  vaultKeyMode?: SystemdCredsKeyMode;
}>;

function parseInvocation(argv: readonly string[]): Invocation {
  const [first, second, ...rest] = argv;
  const command = normalizeCommand(first, second);
  const commandArguments =
    first === "host" || first === "repository" || first === "tree" || first === "auth"
      ? rest
      : argv.slice(1);
  const positionalCount = invocationPositionalCount(command);
  const positional = commandArguments.slice(0, positionalCount);
  const optionArguments = commandArguments.slice(positionalCount);
  let home = process.env["MINIONS_HOME"] ?? join(homedir(), ".minions");
  let mode: DaemonModeName = "local";
  let port = 4_817;
  let configuredHostId: HostId | undefined;
  let allowRemote = false;
  let authHostId: HostId | undefined;
  let authProvider: string | undefined;
  let authVia: string | undefined;
  let vaultStoreDirectory: string | undefined;
  let vaultKeyMode: SystemdCredsKeyMode | undefined;
  let maxDepth: number | undefined;
  let maxFanOut: number | undefined;
  let maxNodes: number | undefined;
  let maxConcurrency: number | undefined;
  let maxAttemptsPerNode: number | undefined;
  let rootAllowedRepositoryPath: string | undefined;
  let rootCheckProfile: string | undefined;
  const seenOptions = new Set<string>();
  for (let index = 0; index < optionArguments.length; index += 1) {
    const option = optionArguments[index];
    const value = optionArguments[index + 1];
    if (option === undefined) {
      throw new UsageError("option is missing");
    }
    if (seenOptions.has(option)) {
      throw new UsageError(`option is repeated: ${option}`);
    }
    seenOptions.add(option);
    switch (option) {
      case "--home":
        home = requiredValue(option, value);
        index += 1;
        break;
      case "--mode":
        if (command !== "start") {
          throw new UsageError("--mode is only valid with start");
        }
        mode = parseMode(requiredValue(option, value));
        index += 1;
        break;
      case "--port":
        if (command !== "start") {
          throw new UsageError("--port is only valid with start");
        }
        port = parsePort(requiredValue(option, value));
        index += 1;
        break;
      case "--host-id":
        if (command === "start") {
          configuredHostId = parseConfiguredHostId(requiredValue(option, value));
        } else if (
          command === "auth-login" ||
          command === "auth-status" ||
          command === "auth-logout"
        ) {
          authHostId = parseConfiguredHostId(requiredValue(option, value));
        } else {
          throw new UsageError("--host-id is only valid with start or auth");
        }
        index += 1;
        break;
      case "--max-depth":
        if (command !== "tree-create") {
          throw new UsageError("--max-depth is only valid with tree create");
        }
        maxDepth = parseBudget(requiredValue(option, value), option);
        index += 1;
        break;
      case "--max-fan-out":
        if (command !== "tree-create") {
          throw new UsageError("--max-fan-out is only valid with tree create");
        }
        maxFanOut = parseBudget(requiredValue(option, value), option);
        index += 1;
        break;
      case "--max-nodes":
        if (command !== "tree-create") {
          throw new UsageError("--max-nodes is only valid with tree create");
        }
        maxNodes = parseBudget(requiredValue(option, value), option);
        index += 1;
        break;
      case "--max-concurrency":
        if (command !== "tree-create") {
          throw new UsageError("--max-concurrency is only valid with tree create");
        }
        maxConcurrency = parseBudget(requiredValue(option, value), option);
        index += 1;
        break;
      case "--max-attempts-per-node":
        if (command !== "tree-create") {
          throw new UsageError("--max-attempts-per-node is only valid with tree create");
        }
        maxAttemptsPerNode = parseBudget(requiredValue(option, value), option);
        index += 1;
        break;
      case "--root-allowed-path":
        if (command !== "tree-create") {
          throw new UsageError("--root-allowed-path is only valid with tree create");
        }
        rootAllowedRepositoryPath = parseCanonicalRelativePath(
          requiredValue(option, value),
          option,
        );
        index += 1;
        break;
      case "--root-check-profile":
        if (command !== "tree-create") {
          throw new UsageError("--root-check-profile is only valid with tree create");
        }
        rootCheckProfile = requiredText("root check profile", requiredValue(option, value));
        index += 1;
        break;
      case "--provider":
        if (command !== "auth-login" && command !== "auth-logout") {
          throw new UsageError("--provider is only valid with auth login/logout");
        }
        authProvider = requiredText("provider", requiredValue(option, value));
        index += 1;
        break;
      case "--via":
        if (command !== "auth-login") {
          throw new UsageError("--via is only valid with auth login");
        }
        authVia = requiredText("via", requiredValue(option, value));
        index += 1;
        break;
      case "--vault-store-directory":
        if (command !== "auth-login" && command !== "auth-status" && command !== "auth-logout") {
          throw new UsageError("--vault-store-directory is only valid with auth");
        }
        vaultStoreDirectory = requiredValue(option, value);
        index += 1;
        break;
      case "--vault-key-mode":
        if (command !== "auth-login" && command !== "auth-status" && command !== "auth-logout") {
          throw new UsageError("--vault-key-mode is only valid with auth");
        }
        vaultKeyMode = parseVaultKeyMode(requiredValue(option, value));
        index += 1;
        break;
      default:
        throw new UsageError(`unknown option: ${option}`);
    }
  }

  if (command === "start") {
    if (mode === "host" && configuredHostId === undefined) {
      throw new UsageError("--host-id is required in host mode");
    }
    if (mode !== "host" && configuredHostId !== undefined) {
      throw new UsageError("--host-id is only valid in host mode");
    }
    if (configuredHostId === undefined) {
      return { command, home, mode, port };
    }
    return { command, home, mode, port, hostId: configuredHostId };
  }
  if (
    command === "stop" ||
    command === "status" ||
    command === "doctor" ||
    command === "host-list" ||
    command === "repository-list" ||
    command === "tree-list"
  ) {
    return { command, home };
  }
  if (command === "repository-register") {
    return { command, home, rootPath: requiredPositional("repository root", positional[0]) };
  }
  if (command === "repository-get") {
    return {
      command,
      home,
      repositoryId: requiredPositional("repository ID", positional[0]),
    };
  }
  if (command === "tree-create") {
    if (
      maxDepth === undefined ||
      maxFanOut === undefined ||
      maxNodes === undefined ||
      maxConcurrency === undefined ||
      maxAttemptsPerNode === undefined ||
      rootAllowedRepositoryPath === undefined ||
      rootCheckProfile === undefined
    ) {
      throw new UsageError(
        "tree create requires --max-depth, --max-fan-out, --max-nodes, --max-concurrency, --max-attempts-per-node, --root-allowed-path, and --root-check-profile",
      );
    }
    return {
      command,
      home,
      repositoryId: parseUuidV7Argument(
        "repository ID",
        requiredPositional("repository ID", positional[0]),
      ),
      goal: requiredText("tree goal", requiredPositional("tree goal", positional[1])),
      baseCommit: parseBaseCommit(requiredPositional("base commit", positional[2])),
      rootAllowedRepositoryPath,
      rootCheckProfile,
      budget: {
        maxDepth,
        maxFanOut,
        maxNodes,
        maxConcurrency,
        maxAttemptsPerNode,
      },
    };
  }
  if (command === "tree-get") {
    return {
      command,
      home,
      treeId: parseUuidV7Argument("tree ID", requiredPositional("tree ID", positional[0])),
    };
  }
  if (command === "tree-propose") {
    return {
      command,
      home,
      treeId: parseUuidV7Argument("tree ID", requiredPositional("tree ID", positional[0])),
      planRevisionId: parseUuidV7Argument(
        "plan revision ID",
        requiredPositional("plan revision ID", positional[1]),
      ),
      planPath: requiredPositional("plan JSON path", positional[2]),
    };
  }
  if (command === "tree-repair") {
    return {
      command,
      home,
      treeId: parseUuidV7Argument("tree ID", requiredPositional("tree ID", positional[0])),
      planRevisionId: parseUuidV7Argument(
        "plan revision ID",
        requiredPositional("plan revision ID", positional[1]),
      ),
      attentionId: parseUuidV7Argument(
        "attention ID",
        requiredPositional("attention ID", positional[2]),
      ),
      planPath: requiredPositional("plan JSON path", positional[3]),
    };
  }
  if (command === "tree-approve") {
    return {
      command,
      home,
      treeId: parseUuidV7Argument("tree ID", requiredPositional("tree ID", positional[0])),
      planRevisionId: parseUuidV7Argument(
        "plan revision ID",
        requiredPositional("plan revision ID", positional[1]),
      ),
    };
  }
  if (command === "auth-login") {
    if (authHostId === undefined) {
      throw new UsageError("auth login requires --host-id");
    }
    if (authProvider === undefined) {
      throw new UsageError("auth login requires --provider");
    }
    return {
      command,
      home,
      hostId: authHostId,
      provider: authProvider,
      ...(authVia !== undefined ? { via: authVia } : {}),
      ...(vaultStoreDirectory !== undefined ? { vaultStoreDirectory } : {}),
      ...(vaultKeyMode !== undefined ? { vaultKeyMode } : {}),
    };
  }
  if (command === "auth-status") {
    if (authHostId === undefined) {
      throw new UsageError("auth status requires --host-id");
    }
    return {
      command,
      home,
      hostId: authHostId,
      ...(vaultStoreDirectory !== undefined ? { vaultStoreDirectory } : {}),
      ...(vaultKeyMode !== undefined ? { vaultKeyMode } : {}),
    };
  }
  if (command === "auth-logout") {
    if (authHostId === undefined) {
      throw new UsageError("auth logout requires --host-id");
    }
    if (authProvider === undefined) {
      throw new UsageError("auth logout requires --provider");
    }
    return {
      command,
      home,
      hostId: authHostId,
      provider: authProvider,
      ...(vaultStoreDirectory !== undefined ? { vaultStoreDirectory } : {}),
      ...(vaultKeyMode !== undefined ? { vaultKeyMode } : {}),
    };
  }
  throw new UsageError(usageText());
}

function parseVaultKeyMode(value: string): SystemdCredsKeyMode {
  const allowed: readonly SystemdCredsKeyMode[] = [
    "host",
    "tpm2",
    "host+tpm2",
    "tpm2-absent",
    "auto",
    "auto-initrd",
  ];
  for (const candidate of allowed) {
    if (candidate === value) return candidate;
  }
  throw new UsageError(`--vault-key-mode must be one of: ${allowed.join(", ")}`);
}

function normalizeCommand(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  if (first === "host" && second === "list") {
    return "host-list";
  }
  if (first === "repository" && (second === "register" || second === "get" || second === "list")) {
    return `repository-${second}`;
  }
  if (
    first === "tree" &&
    (second === "create" ||
      second === "get" ||
      second === "list" ||
      second === "propose" ||
      second === "repair" ||
      second === "approve")
  ) {
    return `tree-${second}`;
  }
  if (first === "auth" && (second === "login" || second === "status" || second === "logout")) {
    return `auth-${second}`;
  }
  return first;
}

function invocationPositionalCount(command: string | undefined): number {
  switch (command) {
    case "repository-register":
    case "repository-get":
    case "tree-get":
      return 1;
    case "tree-create":
    case "tree-propose":
      return 3;
    case "tree-repair":
      return 4;
    case "tree-approve":
      return 2;
    case "auth-login":
    case "auth-status":
    case "auth-logout":
      return 0;
    case undefined:
    default:
      return 0;
  }
}

function requiredPositional(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new UsageError(`${name} is required`);
  }
  return value;
}

function requiredText(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new UsageError(`${name} must not be empty`);
  }
  return value;
}
function parseConfiguredHostId(value: string): HostId {
  if (!uuidV7Pattern.test(value)) {
    throw new UsageError("--host-id must be a lowercase UUIDv7");
  }
  return hostId(value);
}

function parseUuidV7Argument(name: string, value: string): string {
  if (!uuidV7Pattern.test(value)) {
    throw new UsageError(`${name} must be a lowercase UUIDv7`);
  }
  return value;
}

function parseBaseCommit(value: string): string {
  if (!gitShaPattern.test(value)) {
    throw new UsageError("base commit must be 40 or 64 lowercase hexadecimal characters");
  }
  return value;
}
function parseCanonicalRelativePath(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`${context} must be a canonical relative path`);
  }
  if (value === ".") {
    return value;
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:\//u.test(value) ||
    value
      .split("/")
      .some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new UsageError(`${context} must be a canonical relative path`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      throw new UsageError(`${context} must be a canonical relative path`);
    }
  }
  return value;
}

function parseBudget(value: string, option: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new UsageError(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 0xffff_ffff) {
    throw new UsageError(`${option} must be between 1 and 4294967295`);
  }
  return parsed;
}

function usageText(): string {
  return "usage: minions <start|stop|status|doctor|host list|repository register|repository get|repository list|tree create|tree get|tree list|tree propose|tree repair|tree approve|auth login|auth status|auth logout> [options]";
}

async function start(invocation: StartInvocation): Promise<number> {
  const arguments_ = [
    "--home",
    invocation.home,
    "--mode",
    invocation.mode,
    "--port",
    String(invocation.port),
  ];
  if (invocation.hostId !== undefined) {
    arguments_.push("--host-id", invocation.hostId);
  }
  return await runDaemon(arguments_);
}

async function stop(home: string): Promise<number> {
  const inspection = inspectLifecycleLock(daemonLifecyclePath(home));
  if (inspection.state !== "active") {
    throw new DaemonUnavailableError(`daemon is ${inspection.state}`);
  }
  const clients = clientsForHome(home);
  const health = await clients.system.getHealth({});
  if (health.instanceId !== inspection.record.instanceId) {
    throw new DaemonUnavailableError(
      "daemon lifecycle identity does not match its health response",
    );
  }
  const confirmed = inspectLifecycleLock(daemonLifecyclePath(home));
  if (
    confirmed.state !== "active" ||
    confirmed.record.instanceId !== inspection.record.instanceId ||
    confirmed.record.pid !== inspection.record.pid
  ) {
    throw new DaemonUnavailableError("daemon lifecycle identity changed before stop");
  }
  process.kill(inspection.record.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await delay(25);
    if (inspectLifecycleLock(daemonLifecyclePath(home)).state === "absent") {
      writeJson({ status: "stopped", instance_id: inspection.record.instanceId });
      return 0;
    }
  }
  throw new DaemonUnavailableError("daemon did not stop before the deadline");
}

async function status(home: string): Promise<number> {
  const clients = clientsForHome(home);
  const serverInfo = await clients.system.getServerInfo({
    clientName: "minions-cli",
    apiVersion: create(ApiVersionSchema, { major: 1 }),
  });
  const health = await clients.system.getHealth({});
  writeJson({
    status: "healthy",
    server_version: serverInfo.serverVersion,
    instance_id: health.instanceId,
    mode: health.mode,
    host_id: health.hostId,
    started_at: health.startedAt === undefined ? undefined : toJsonTimestamp(health.startedAt),
  });
  return 0;
}
async function registerRepository(home: string, rootPath: string): Promise<number> {
  const ids = createSecureIdGenerator({
    now: () => timestampFromEpochMilliseconds(Date.now()),
  });
  const response = await clientsForHome(home).repository.registerRepository({
    commandId: ids.nextId(),
    actorSessionId: ids.nextId(),
    repositoryId: ids.nextId(),
    rootPath,
  });
  if (response.repository === undefined) {
    throw new ConnectError("repository registration response is missing repository", Code.Internal);
  }
  writeJson({ repository: repositoryJson(response.repository) });
  return 0;
}

async function getRepository(home: string, repositoryId: string): Promise<number> {
  const response = await clientsForHome(home).repository.getRepository({ repositoryId });
  if (response.repository === undefined) {
    throw new ConnectError("repository response is missing repository", Code.Internal);
  }
  writeJson({ repository: repositoryJson(response.repository) });
  return 0;
}

async function listRepositories(home: string): Promise<number> {
  const client = clientsForHome(home).repository;
  const repositories: RegisteredRepository[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const request =
      pageToken === undefined
        ? create(ListRepositoriesRequestSchema, { pageSize: 100 })
        : create(ListRepositoriesRequestSchema, { pageSize: 100, pageToken });
    const response = await client.listRepositories(request);
    repositories.push(...response.repositories);
    pageToken = response.nextPageToken;
    if (pageToken !== undefined && seenTokens.has(pageToken)) {
      throw new ConnectError("repository pagination repeated a continuation token", Code.Internal);
    }
    if (pageToken !== undefined) {
      seenTokens.add(pageToken);
    }
  } while (pageToken !== undefined);
  writeJson({ repositories: repositories.map(repositoryJson) });
  return 0;
}

async function createTree(
  home: string,
  repositoryId: string,
  goal: string,
  baseCommit: string,
  rootAllowedRepositoryPath: string,
  rootCheckProfile: string,
  budget: TreeBudgetInput,
): Promise<number> {
  const ids = createSecureIdGenerator({
    now: () => timestampFromEpochMilliseconds(Date.now()),
  });
  const response = await clientsForHome(home).tree.createTree(
    create(CreateTreeRequestSchema, {
      commandId: ids.nextId(),
      actorSessionId: ids.nextId(),
      repositoryId,
      treeId: ids.nextId(),
      planRevisionId: ids.nextId(),
      rootNodeId: ids.nextId(),
      rootArtifactId: ids.nextId(),
      goal,
      baseCommit,
      budget: create(TreeBudgetSchema, budget),
      attentionId: ids.nextId(),
      rootAllowedRepositoryPaths: [rootAllowedRepositoryPath],
      rootCheckProfile,
    }),
  );
  writeJson({ tree: treeJson(requiredTree(response.tree, "create tree")) });
  return 0;
}

async function getTree(home: string, treeId: string): Promise<number> {
  const response = await clientsForHome(home).tree.getTree(
    create(GetTreeRequestSchema, { treeId }),
  );
  writeJson({ tree: treeJson(requiredTree(response.tree, "get tree")) });
  return 0;
}

async function listTrees(home: string): Promise<number> {
  const client = clientsForHome(home).tree;
  const trees: TreeSummary[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const request =
      pageToken === undefined
        ? create(ListTreesRequestSchema, { pageSize: 100 })
        : create(ListTreesRequestSchema, { pageSize: 100, pageToken });
    const response = await client.listTrees(request);
    trees.push(...response.trees);
    pageToken = response.nextPageToken;
    if (pageToken !== undefined && seenTokens.has(pageToken)) {
      throw new ConnectError("tree pagination repeated a continuation token", Code.Internal);
    }
    if (pageToken !== undefined) {
      seenTokens.add(pageToken);
    }
  } while (pageToken !== undefined);
  writeJson({ trees: trees.map(treeSummaryJson) });
  return 0;
}

async function proposePlan(
  home: string,
  treeId: string,
  planRevisionId: string,
  planPath: string,
): Promise<number> {
  const plan = await readPlanFile(planPath);
  const ids = createSecureIdGenerator({
    now: () => timestampFromEpochMilliseconds(Date.now()),
  });
  const response = await clientsForHome(home).tree.proposePlan(
    create(ProposePlanRequestSchema, {
      commandId: ids.nextId(),
      actorSessionId: ids.nextId(),
      treeId,
      planRevisionId,
      goal: plan.goal,
      nodes: plan.nodes.map(proposedNodeMessage),
    }),
  );
  writeJson({ tree: treeJson(requiredTree(response.tree, "propose plan")) });
  return 0;
}

async function repairPlan(
  home: string,
  treeId: string,
  planRevisionId: string,
  attentionId: string,
  planPath: string,
): Promise<number> {
  const plan = await readPlanFile(planPath);
  const ids = createSecureIdGenerator({
    now: () => timestampFromEpochMilliseconds(Date.now()),
  });
  const response = await clientsForHome(home).tree.repairPlan(
    create(RepairPlanRequestSchema, {
      commandId: ids.nextId(),
      actorSessionId: ids.nextId(),
      treeId,
      planRevisionId,
      attentionId,
      goal: plan.goal,
      nodes: plan.nodes.map(proposedNodeMessage),
    }),
  );
  writeJson({ tree: treeJson(requiredTree(response.tree, "repair plan")) });
  return 0;
}

async function approvePlan(home: string, treeId: string, planRevisionId: string): Promise<number> {
  const ids = createSecureIdGenerator({
    now: () => timestampFromEpochMilliseconds(Date.now()),
  });
  const response = await clientsForHome(home).tree.approvePlan(
    create(ApprovePlanRequestSchema, {
      commandId: ids.nextId(),
      actorSessionId: ids.nextId(),
      treeId,
      planRevisionId,
    }),
  );
  writeJson({ tree: treeJson(requiredTree(response.tree, "approve plan")) });
  return 0;
}

function requiredTree(tree: TaskTree | undefined, operation: string): TaskTree {
  if (tree === undefined) {
    throw new ConnectError(`${operation} response is missing tree`, Code.Internal);
  }
  return tree;
}

function treeSummaryJson(summary: TreeSummary) {
  return {
    id: summary.id,
    repository_id: summary.repositoryId,
    host_id: summary.hostId,
    root_node_id: summary.rootNodeId,
    active_plan_revision_id: summary.activePlanRevisionId,
    state: treeStateJson(summary.state),
    version: summary.version.toString(),
  };
}

function treeJson(tree: TaskTree) {
  if (tree.budget === undefined) {
    throw new ConnectError("tree response is missing budget", Code.Internal);
  }
  return {
    id: tree.id,
    repository_id: tree.repositoryId,
    host_id: tree.hostId,
    base_commit: tree.baseCommit,
    goal: tree.goal,
    active_plan_revision_id: tree.activePlanRevisionId,
    root_node_id: tree.rootNodeId,
    state: treeStateJson(tree.state),
    version: tree.version.toString(),
    created_at: requiredTimestamp(tree.createdAt, "tree created_at"),
    updated_at: requiredTimestamp(tree.updatedAt, "tree updated_at"),
    revisions: tree.revisions.map(planRevisionJson),
    nodes: tree.nodes.map(taskNodeJson),
    budget: treeBudgetJson(tree.budget),
    ...(tree.attention === undefined ? {} : { attention: planAttentionJson(tree.attention) }),
  };
}

function treeBudgetJson(budget: TreeBudget) {
  return {
    max_depth: budget.maxDepth,
    max_fan_out: budget.maxFanOut,
    max_nodes: budget.maxNodes,
    max_concurrency: budget.maxConcurrency,
    max_attempts_per_node: budget.maxAttemptsPerNode,
  };
}

function planRevisionJson(revision: PlanRevision) {
  return {
    id: revision.id,
    tree_id: revision.treeId,
    ordinal: revision.ordinal.toString(),
    goal: revision.goal,
    state: planRevisionStateJson(revision.state),
    version: revision.version.toString(),
    created_at: requiredTimestamp(revision.createdAt, "plan revision created_at"),
    ...(revision.approvedAt === undefined
      ? {}
      : { approved_at: toJsonTimestamp(revision.approvedAt) }),
    ...(revision.supersededAt === undefined
      ? {}
      : { superseded_at: toJsonTimestamp(revision.supersededAt) }),
  };
}

function taskNodeJson(node: TaskNode) {
  if (node.budget === undefined) {
    throw new ConnectError("task node response is missing budget", Code.Internal);
  }
  const fields = {
    id: node.id,
    tree_id: node.treeId,
    repository_id: node.repositoryId,
    host_id: node.hostId,
    ...(node.parentNodeId === undefined ? {} : { parent_node_id: node.parentNodeId }),
    plan_revision_id: node.planRevisionId,
    mode: planNodeModeJson(node.mode),
    objective: node.objective,
    acceptance_criteria: node.acceptanceCriteria,
    inputs: node.inputs.map(artifactInputJson),
    state: nodeStateJson(node.state),
    version: node.version.toString(),
    created_at: requiredTimestamp(node.createdAt, "task node created_at"),
    updated_at: requiredTimestamp(node.updatedAt, "task node updated_at"),
    allowed_repository_paths: node.allowedRepositoryPaths,
    check_profile: node.checkProfile,
    budget: {
      max_attempts: node.budget.maxAttempts,
    },
  };
  if (node.outputContract.case === "artifact") {
    return {
      ...fields,
      artifact: {
        artifact_id: node.outputContract.value.artifactId,
        artifact_type: node.outputContract.value.artifactType,
      },
    };
  }
  if (node.outputContract.case === "implementation") {
    return { ...fields, implementation: {} };
  }
  throw new ConnectError("task node response has no output contract", Code.Internal);
}

function artifactInputJson(input: ArtifactInput) {
  return {
    artifact_id: input.artifactId,
    source_node_id: input.sourceNodeId,
  };
}

function planAttentionJson(attention: PlanAttention) {
  return {
    id: attention.id,
    tree_id: attention.treeId,
    ...(attention.planRevisionId === undefined
      ? {}
      : { plan_revision_id: attention.planRevisionId }),
    kind: planAttentionKindJson(attention.kind),
    message: attention.message,
    state: planAttentionStateJson(attention.state),
    created_at: requiredTimestamp(attention.createdAt, "plan attention created_at"),
    ...(attention.resolvedAt === undefined
      ? {}
      : { resolved_at: toJsonTimestamp(attention.resolvedAt) }),
  };
}

function treeStateJson(value: TreeState): string {
  switch (value) {
    case TreeState.DRAFT:
      return "TREE_STATE_DRAFT";
    case TreeState.APPROVED:
      return "TREE_STATE_APPROVED";
    case TreeState.ACTIVE:
      return "TREE_STATE_ACTIVE";
    case TreeState.SUCCEEDED:
      return "TREE_STATE_SUCCEEDED";
    case TreeState.FAILED:
      return "TREE_STATE_FAILED";
    case TreeState.CANCELLED:
      return "TREE_STATE_CANCELLED";
    case TreeState.UNSPECIFIED:
      throw new ConnectError(`tree response has unknown state ${String(value)}`, Code.Internal);
  }
  throw new ConnectError(`tree response has unknown state ${String(value)}`, Code.Internal);
}

function planRevisionStateJson(value: PlanRevisionState): string {
  switch (value) {
    case PlanRevisionState.DRAFT:
      return "PLAN_REVISION_STATE_DRAFT";
    case PlanRevisionState.APPROVED:
      return "PLAN_REVISION_STATE_APPROVED";
    case PlanRevisionState.SUPERSEDED:
      return "PLAN_REVISION_STATE_SUPERSEDED";
    case PlanRevisionState.UNSPECIFIED:
      throw new ConnectError(
        `plan revision response has unknown state ${String(value)}`,
        Code.Internal,
      );
  }
  throw new ConnectError(
    `plan revision response has unknown state ${String(value)}`,
    Code.Internal,
  );
}

function planNodeModeJson(value: PlanNodeMode): string {
  switch (value) {
    case PlanNodeMode.PLAN:
      return "PLAN_NODE_MODE_PLAN";
    case PlanNodeMode.RESEARCH:
      return "PLAN_NODE_MODE_RESEARCH";
    case PlanNodeMode.EXPLORE:
      return "PLAN_NODE_MODE_EXPLORE";
    case PlanNodeMode.IMPLEMENTATION:
      return "PLAN_NODE_MODE_IMPLEMENTATION";
    case PlanNodeMode.UNSPECIFIED:
      throw new ConnectError(`task node response has unknown mode ${String(value)}`, Code.Internal);
  }
  throw new ConnectError(`task node response has unknown mode ${String(value)}`, Code.Internal);
}

function nodeStateJson(value: NodeState): string {
  switch (value) {
    case NodeState.PLANNED:
      return "NODE_STATE_PLANNED";
    case NodeState.READY:
      return "NODE_STATE_READY";
    case NodeState.ACTIVE:
      return "NODE_STATE_ACTIVE";
    case NodeState.BLOCKED:
      return "NODE_STATE_BLOCKED";
    case NodeState.SUCCEEDED:
      return "NODE_STATE_SUCCEEDED";
    case NodeState.FAILED:
      return "NODE_STATE_FAILED";
    case NodeState.CANCELLED:
      return "NODE_STATE_CANCELLED";
    case NodeState.SUPERSEDED:
      return "NODE_STATE_SUPERSEDED";
    case NodeState.UNSPECIFIED:
      throw new ConnectError(
        `task node response has unknown state ${String(value)}`,
        Code.Internal,
      );
  }
  throw new ConnectError(`task node response has unknown state ${String(value)}`, Code.Internal);
}

function planAttentionKindJson(value: PlanAttentionKind): string {
  switch (value) {
    case PlanAttentionKind.PLAN_REQUIRED:
      return "PLAN_ATTENTION_KIND_PLAN_REQUIRED";
    case PlanAttentionKind.PLAN_INVALID:
      return "PLAN_ATTENTION_KIND_PLAN_INVALID";
    case PlanAttentionKind.REPAIR_REQUIRED:
      return "PLAN_ATTENTION_KIND_REPAIR_REQUIRED";
    case PlanAttentionKind.UNSPECIFIED:
      throw new ConnectError(
        `plan attention response has unknown kind ${String(value)}`,
        Code.Internal,
      );
  }
  throw new ConnectError(
    `plan attention response has unknown kind ${String(value)}`,
    Code.Internal,
  );
}

function planAttentionStateJson(value: PlanAttentionState): string {
  switch (value) {
    case PlanAttentionState.OPEN:
      return "PLAN_ATTENTION_STATE_OPEN";
    case PlanAttentionState.RESOLVED:
      return "PLAN_ATTENTION_STATE_RESOLVED";
    case PlanAttentionState.UNSPECIFIED:
      throw new ConnectError(
        `plan attention response has unknown state ${String(value)}`,
        Code.Internal,
      );
  }
  throw new ConnectError(
    `plan attention response has unknown state ${String(value)}`,
    Code.Internal,
  );
}

function requiredTimestamp(
  timestamp: Timestamp | undefined,
  fieldName: string,
): Readonly<{ seconds: string; nanos: number }> {
  if (timestamp === undefined) {
    throw new ConnectError(`tree response is missing ${fieldName}`, Code.Internal);
  }
  return toJsonTimestamp(timestamp);
}

type PlanFile = Readonly<{
  goal: string;
  nodes: readonly PlanNodeInput[];
}>;

type PlanNodeInput = Readonly<{
  nodeId: string;
  parentNodeId?: string;
  mode: PlanNodeMode;
  objective: string;
  acceptanceCriteria: readonly string[];
  inputs: readonly PlanArtifactInput[];
  allowedRepositoryPaths: readonly string[];
  checkProfile: string;
  output:
    | Readonly<{ case: "artifact"; artifactId: string; artifactType: string }>
    | Readonly<{ case: "implementation" }>;
}>;

type PlanArtifactInput = Readonly<{
  artifactId: string;
  sourceNodeId: string;
}>;

type JsonObject = Record<string, unknown>;

const planFileKeys: Readonly<Record<string, boolean>> = {
  goal: true,
  nodes: true,
};
const planNodeKeys: Readonly<Record<string, boolean>> = {
  nodeId: true,
  parentNodeId: true,
  mode: true,
  objective: true,
  acceptanceCriteria: true,
  inputs: true,
  allowedRepositoryPaths: true,
  checkProfile: true,
  artifact: true,
  implementation: true,
};
const planInputKeys: Readonly<Record<string, boolean>> = {
  artifactId: true,
  sourceNodeId: true,
};
const planArtifactOutputKeys: Readonly<Record<string, boolean>> = {
  artifactId: true,
  artifactType: true,
};

async function readPlanFile(planPath: string): Promise<PlanFile> {
  let source: string;
  try {
    source = await readFile(planPath, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read plan JSON file: ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new UsageError(`plan JSON is malformed: ${errorMessage(error)}`);
  }
  if (!isJsonObject(parsed)) {
    throw new UsageError("plan JSON must contain an object");
  }
  assertExactKeys(parsed, planFileKeys, "plan");
  const goal = parseNonEmptyJsonString(parsed["goal"], "plan.goal");
  const rawNodes = parsed["nodes"];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new UsageError("plan.nodes must be a non-empty array");
  }
  return {
    goal,
    nodes: rawNodes.map((node, index) => parsePlanNode(node, index)),
  };
}

function parsePlanNode(value: unknown, index: number): PlanNodeInput {
  const context = `plan.nodes[${String(index)}]`;
  if (!isJsonObject(value)) {
    throw new UsageError(`${context} must contain an object`);
  }
  assertExactKeys(value, planNodeKeys, context);
  const parentNodeId = hasOwn(value, "parentNodeId")
    ? parseJsonUuid(value["parentNodeId"], `${context}.parentNodeId`)
    : undefined;
  const rawCriteria = value["acceptanceCriteria"];
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
    throw new UsageError(`${context}.acceptanceCriteria must be a non-empty array`);
  }
  const acceptanceCriteria = rawCriteria.map((criterion, criterionIndex) =>
    parseNonEmptyJsonString(criterion, `${context}.acceptanceCriteria[${String(criterionIndex)}]`),
  );
  const rawInputs = value["inputs"];
  let inputs: readonly PlanArtifactInput[] = [];
  if (rawInputs !== undefined) {
    if (!Array.isArray(rawInputs)) {
      throw new UsageError(`${context}.inputs must be an array`);
    }
    inputs = rawInputs.map((input, inputIndex) =>
      parsePlanInput(input, `${context}.inputs[${String(inputIndex)}]`),
    );
  }
  const rawAllowedRepositoryPaths = value["allowedRepositoryPaths"];
  if (!Array.isArray(rawAllowedRepositoryPaths) || rawAllowedRepositoryPaths.length === 0) {
    throw new UsageError(`${context}.allowedRepositoryPaths must be a non-empty array`);
  }
  const allowedRepositoryPaths = rawAllowedRepositoryPaths.map((path, pathIndex) =>
    parseCanonicalRelativePath(path, `${context}.allowedRepositoryPaths[${String(pathIndex)}]`),
  );
  const checkProfile = parseNonEmptyJsonString(value["checkProfile"], `${context}.checkProfile`);
  const mode = parsePlanMode(value["mode"], `${context}.mode`);
  const hasArtifact = hasOwn(value, "artifact");
  const hasImplementation = hasOwn(value, "implementation");
  if (hasArtifact === hasImplementation) {
    throw new UsageError(`${context} must contain exactly one output contract`);
  }
  const output = hasArtifact
    ? parseArtifactOutput(value["artifact"], `${context}.artifact`)
    : parseImplementationOutput(value["implementation"], `${context}.implementation`);
  if (
    (output.case === "implementation" && mode !== PlanNodeMode.IMPLEMENTATION) ||
    (output.case === "artifact" && mode === PlanNodeMode.IMPLEMENTATION)
  ) {
    throw new UsageError(`${context} output contract does not match mode`);
  }
  return {
    nodeId: parseJsonUuid(value["nodeId"], `${context}.nodeId`),
    ...(parentNodeId === undefined ? {} : { parentNodeId }),
    mode,
    objective: parseNonEmptyJsonString(value["objective"], `${context}.objective`),
    acceptanceCriteria,
    inputs,
    allowedRepositoryPaths,
    checkProfile,
    output,
  };
}

function parsePlanInput(value: unknown, context: string): PlanArtifactInput {
  if (!isJsonObject(value)) {
    throw new UsageError(`${context} must contain an object`);
  }
  assertExactKeys(value, planInputKeys, context);
  return {
    artifactId: parseJsonUuid(value["artifactId"], `${context}.artifactId`),
    sourceNodeId: parseJsonUuid(value["sourceNodeId"], `${context}.sourceNodeId`),
  };
}

function parseArtifactOutput(
  value: unknown,
  context: string,
): Readonly<{ case: "artifact"; artifactId: string; artifactType: string }> {
  if (!isJsonObject(value)) {
    throw new UsageError(`${context} must contain an object`);
  }
  assertExactKeys(value, planArtifactOutputKeys, context);
  return {
    case: "artifact",
    artifactId: parseJsonUuid(value["artifactId"], `${context}.artifactId`),
    artifactType: parseNonEmptyJsonString(value["artifactType"], `${context}.artifactType`),
  };
}

function parseImplementationOutput(
  value: unknown,
  context: string,
): Readonly<{ case: "implementation" }> {
  if (!isJsonObject(value)) {
    throw new UsageError(`${context} must contain an empty object`);
  }
  assertExactKeys(value, {}, context);
  return { case: "implementation" };
}

function parsePlanMode(value: unknown, context: string): PlanNodeMode {
  if (typeof value !== "string") {
    throw new UsageError(`${context} must be a generated PlanNodeMode name`);
  }
  switch (value) {
    case "PLAN_NODE_MODE_PLAN":
      return PlanNodeMode.PLAN;
    case "PLAN_NODE_MODE_RESEARCH":
      return PlanNodeMode.RESEARCH;
    case "PLAN_NODE_MODE_EXPLORE":
      return PlanNodeMode.EXPLORE;
    case "PLAN_NODE_MODE_IMPLEMENTATION":
      return PlanNodeMode.IMPLEMENTATION;
    default:
      throw new UsageError(`${context} contains an unknown PlanNodeMode`);
  }
}

function proposedNodeMessage(node: PlanNodeInput) {
  const fields = {
    nodeId: node.nodeId,
    ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
    mode: node.mode,
    objective: node.objective,
    acceptanceCriteria: [...node.acceptanceCriteria],
    inputs: node.inputs.map((input) =>
      create(ArtifactInputSchema, {
        artifactId: input.artifactId,
        sourceNodeId: input.sourceNodeId,
      }),
    ),
    allowedRepositoryPaths: [...node.allowedRepositoryPaths],
    checkProfile: node.checkProfile,
  };
  if (node.output.case === "artifact") {
    return create(ProposedNodeSchema, {
      ...fields,
      outputContract: {
        case: "artifact",
        value: create(ArtifactOutputContractSchema, {
          artifactId: node.output.artifactId,
          artifactType: node.output.artifactType,
        }),
      },
    });
  }
  return create(ProposedNodeSchema, {
    ...fields,
    outputContract: {
      case: "implementation",
      value: create(ImplementationOutputContractSchema, {}),
    },
  });
}
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactKeys(
  value: JsonObject,
  allowedKeys: Readonly<Record<string, boolean>>,
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowedKeys[key] !== true) {
      throw new UsageError(`${context} contains unknown field ${key}`);
    }
  }
}

function parseNonEmptyJsonString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UsageError(`${context} must be a non-empty string`);
  }
  return value;
}

function parseJsonUuid(value: unknown, context: string): string {
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) {
    throw new UsageError(`${context} must be a lowercase UUIDv7`);
  }
  return value;
}

function repositoryJson(repository: RegisteredRepository) {
  return {
    id: repository.id,
    host_id: repository.hostId,
    canonical_root: repository.canonicalRoot,
    canonical_remote: repository.canonicalRemote,
    default_branch: repository.defaultBranch,
    base_commit: repository.baseCommit,
    allowed_workspace_root: repository.allowedWorkspaceRoot,
    case_sensitive: repository.caseSensitive,
    submodule_paths: repository.submodulePaths,
    lfs_paths: repository.lfsPaths,
    nested_repository_paths: repository.nestedRepositoryPaths,
    registered_at:
      repository.registeredAt === undefined ? undefined : toJsonTimestamp(repository.registeredAt),
  };
}

async function doctor(home: string): Promise<number> {
  const response = await clientsForHome(home).system.runDoctor({});
  writeJson({
    status: DoctorStatus[response.status],
    checks: response.checks.map((check) => ({
      kind: check.kind,
      status: check.status,
    })),
  });
  return response.status === DoctorStatus.HEALTHY ? 0 : 1;
}

async function listHosts(home: string): Promise<number> {
  const client = clientsForHome(home).host;
  const hosts: ExecutionHost[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const request =
      pageToken === undefined
        ? create(ListHostsRequestSchema, { pageSize: 100 })
        : create(ListHostsRequestSchema, { pageSize: 100, pageToken });
    const response = await client.listHosts(request);
    hosts.push(...response.hosts);
    pageToken = response.nextPageToken;
    if (pageToken !== undefined && seenTokens.has(pageToken)) {
      throw new ConnectError("host pagination repeated a continuation token", Code.Internal);
    }
    if (pageToken !== undefined) {
      seenTokens.add(pageToken);
    }
  } while (pageToken !== undefined);
  writeJson({
    hosts: hosts.map((host) => ({
      id: host.id,
      kind: host.kind,
      display_name: host.displayName,
      state: host.state,
      endpoint: host.endpoint,
      version: host.version.toString(),
    })),
  });
  return 0;
}

// -------------------------------------------------------------------------------------------------
// PR 19: minions auth login / status / logout.
// -------------------------------------------------------------------------------------------------

/**
 * Resolve the `omp` binary path. Honors `OMP_PATH` (test/diagnostic override);
 * otherwise probes the standard install locations. Throws a UsageError when no
 * usable binary is found — the CLI is fail-closed on a missing OMP runtime.
 */
function resolveOmpPath(): string {
  const fromEnv = process.env["OMP_PATH"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const candidates = ["/usr/local/bin/omp", "/usr/bin/omp", `${homedir()}/.local/bin/omp`];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new UsageError("omp binary not found; install the pinned OMP runtime or set OMP_PATH");
}

function vaultOptionsFor(
  invocation: AuthLoginInvocation | AuthStatusInvocation | AuthLogoutInvocation,
): { storeDirectory?: string; systemdCredsKeyMode?: SystemdCredsKeyMode } {
  const options: { storeDirectory?: string; systemdCredsKeyMode?: SystemdCredsKeyMode } = {};
  if (invocation.vaultStoreDirectory !== undefined) {
    options.storeDirectory = invocation.vaultStoreDirectory;
  }
  if (invocation.vaultKeyMode !== undefined) {
    options.systemdCredsKeyMode = invocation.vaultKeyMode;
  }
  return options;
}

/**
 * Boot a per-host broker for the duration of an auth CLI command. The CLI is the
 * only operator surface for the interactive `omp auth-broker login`; the daemon
 * later recovers the persisted control bearer noninteractively.
 */
async function withAuthBroker<T>(
  invocation: AuthLoginInvocation | AuthStatusInvocation | AuthLogoutInvocation,
  action: (broker: AuthBrokerManager) => Promise<T>,
): Promise<T> {
  const ompPath = resolveOmpPath();
  const vault = createCredentialVault(invocation.hostId, vaultOptionsFor(invocation));
  const probe = vault.probe();
  if (!probe.available) {
    throw new AuthBrokerError(
      "vault_unavailable",
      `credential vault unavailable for host ${invocation.hostId}: ${probe.detail}`,
    );
  }
  const broker = createAuthBrokerManager({ ompPath, hostId: invocation.hostId, vault });
  await broker.start();
  try {
    return await action(broker);
  } finally {
    await broker.stop();
  }
}

async function authLogin(invocation: AuthLoginInvocation): Promise<number> {
  await withAuthBroker(invocation, async (broker) => {
    const loginOptions: { via?: string } = {};
    if (invocation.via !== undefined) {
      loginOptions.via = invocation.via;
    }
    await broker.login(invocation.provider, loginOptions);
  });
  writeJson({ status: "logged_in", host_id: invocation.hostId, provider: invocation.provider });
  return 0;
}

async function authStatus(invocation: AuthStatusInvocation): Promise<number> {
  const status = await withAuthBroker(invocation, async (broker) => broker.health());
  writeJson({ host_id: invocation.hostId, ...status });
  return 0;
}

async function authLogout(invocation: AuthLogoutInvocation): Promise<number> {
  await withAuthBroker(invocation, async (broker) => {
    await broker.revoke(invocation.provider);
  });
  writeJson({
    status: "logged_out",
    host_id: invocation.hostId,
    provider: invocation.provider,
  });
  return 0;
}

function clientsForHome(home: string) {
  const inspection = inspectLifecycleLock(daemonLifecyclePath(home));
  if (inspection.state !== "active") {
    throw new DaemonUnavailableError(`daemon is ${inspection.state}`);
  }
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${String(inspection.record.port)}`,
    httpVersion: "1.1",
    useBinaryFormat: true,
  });
  return {
    system: createClient(SystemService, transport),
    host: createClient(HostService, transport),
    repository: createClient(RepositoryService, transport),
    tree: createClient(TreeService, transport),
  };
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, milliseconds);
  return promise;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeError(error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({ status: "error", code: errorName(error), message: errorMessage(error) })}\n`,
  );
}

function exitCode(error: unknown): number {
  if (error instanceof UsageError) {
    return 2;
  }
  if (error instanceof DaemonUnavailableError) {
    return 3;
  }
  if (error instanceof ConnectError) {
    if (error.code === Code.FailedPrecondition) {
      return 4;
    }
    if (error.code === Code.Unavailable) {
      return 3;
    }
  }
  return 1;
}

function errorName(error: unknown): string {
  if (error instanceof ConnectError) {
    if (error.code === Code.FailedPrecondition) {
      return "incompatible";
    }
    if (error.code === Code.Unavailable) {
      return "unavailable";
    }
    return "rpc_failed";
  }
  if (error instanceof UsageError) {
    return "invalid_usage";
  }
  if (error instanceof DaemonUnavailableError) {
    return "unavailable";
  }
  return "command_failed";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "command failed";
}

function requiredValue(option: string | undefined, value: string | undefined): string {
  if (option === undefined || value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new UsageError(`${String(option)} requires a value`);
  }
  return value;
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const gitShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function parseMode(value: string): DaemonModeName {
  if (value === "host" || value === "local" || value === "supervisor") {
    return value;
  }
  throw new UsageError("--mode must be host, local, or supervisor");
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new UsageError("--port must be an integer");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError("--port must be between 1 and 65535");
  }
  return port;
}

function toJsonTimestamp(timestamp: Timestamp): Readonly<{ seconds: string; nanos: number }> {
  return { seconds: timestamp.seconds.toString(), nanos: timestamp.nanos };
}

class UsageError extends Error {}
class DaemonUnavailableError extends Error {}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await main(process.argv.slice(2));
}
