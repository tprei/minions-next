#!/usr/bin/env node

import { create } from "@bufbuild/protobuf";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { daemonLifecyclePath, inspectLifecycleLock, type DaemonModeName } from "@minions/adapters";
import {
  ApiVersionSchema,
  DoctorStatus,
  HostService,
  ListHostsRequestSchema,
  SystemService,
  type ExecutionHost,
} from "@minions/contracts";
import { hostId, type HostId } from "@minions/core";
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

type Invocation =
  | StartInvocation
  | Readonly<{
      command: "stop" | "status" | "doctor" | "host-list";
      home: string;
    }>;

function parseInvocation(argv: readonly string[]): Invocation {
  const [first, second, ...rest] = argv;
  const command = first === "host" && second === "list" ? "host-list" : first;
  const optionArguments = command === "host-list" ? rest : argv.slice(1);
  let home = process.env["MINIONS_HOME"] ?? join(homedir(), ".minions");
  let mode: DaemonModeName = "local";
  let port = 4_817;
  let configuredHostId: HostId | undefined;
  for (let index = 0; index < optionArguments.length; index += 1) {
    const option = optionArguments[index];
    const value = optionArguments[index + 1];
    switch (option) {
      case "--home":
        home = requiredValue(option, value);
        index += 1;
        break;
      case "--mode":
        mode = parseMode(requiredValue(option, value));
        index += 1;
        break;
      case "--port":
        port = parsePort(requiredValue(option, value));
        index += 1;
        break;
      case "--host-id":
        configuredHostId = hostId(requiredValue(option, value));
        index += 1;
        break;
      case undefined:
        throw new UsageError("option is missing");
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
    command === "host-list"
  ) {
    if (mode !== "local" || port !== 4_817) {
      throw new UsageError("--mode and --port are only valid with start");
    }
    return { command, home };
  }
  throw new UsageError("usage: minions <start|stop|status|doctor|host list> [options]");
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
