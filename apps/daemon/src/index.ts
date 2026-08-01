#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LifecycleLockError, type DaemonModeName } from "@minions/adapters";
import { hostId, type HostId } from "@minions/core";

import { createStructuredLogger } from "./logger.js";
import { defaultRuntimeOptions, startDaemonRuntime } from "./runtime.js";

export { createStructuredLogger, defaultRuntimeOptions, startDaemonRuntime };
export { registerHostService } from "./host-service.js";
export { registerSystemService } from "./system-service.js";
export type { SystemServiceOptions } from "./system-service.js";
export { createSchedulerLoop } from "./scheduler.js";
export type { CreateSchedulerLoopOptions } from "./scheduler.js";
export { startDaemonServer } from "./server.js";
export type { CreateStructuredLoggerOptions, StructuredLogger } from "./logger.js";
export type { DaemonRuntimeOptions, RunningDaemonRuntime } from "./runtime.js";
export type { DaemonServerOptions, RunningDaemonServer } from "./server.js";
export { DaemonStartupError, AuthRuntimeStartupError } from "./runtime.js";
export type {
  AuthBrokerRuntimeOptions,
  AuthRuntimeStartupErrorCode,
  DaemonStartupErrorCode,
  NodeExecutionRuntimeOptions,
  ProviderAdmissionRuntimeOptions,
  RunningAuthRuntime,
} from "./runtime.js";

export type { ExecutionCoordinator } from "@minions/core";

export async function main(argv: readonly string[]): Promise<number> {
  const logger = createStructuredLogger({ stream: process.stderr, now: Date.now });
  const { promise, resolve } = Promise.withResolvers<NodeJS.Signals>();
  const startupAbort = new AbortController();
  const handleSignal = (signal: NodeJS.Signals): void => {
    startupAbort.abort();
    resolve(signal);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    const options = parseArguments(argv);
    const runtime = await startDaemonRuntime(
      defaultRuntimeOptions({
        ...options,
        serverVersion: "0.0.0",
        logger,
        signal: startupAbort.signal,
      }),
    );
    const signal = await promise;
    logger.log("info", "daemon_shutdown_requested", {
      instance_id: runtime.lifecycle.instanceId,
      signal,
    });
    await runtime.close();
    return 0;
  } catch (error) {
    if (startupAbort.signal.aborted && error instanceof Error && error.name === "AbortError") {
      return 0;
    }
    logger.log("error", "daemon_process_failed", { error_code: errorCode(error) });
    return exitCode(error);
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
}

type ProcessArguments = Readonly<{
  home: string;
  mode: DaemonModeName;
  port: number;
  hostId?: HostId;
}>;

function parseArguments(argv: readonly string[]): ProcessArguments {
  let home = process.env["MINIONS_HOME"] ?? join(homedir(), ".minions");
  let mode: DaemonModeName = "local";
  let port = 4_817;
  let configuredHostId: HostId | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      throw new TypeError("daemon argument is missing");
    }
    const value = argv[index + 1];
    switch (argument) {
      case "--home":
        home = requiredValue(argument, value);
        index += 1;
        break;
      case "--mode":
        mode = daemonMode(requiredValue(argument, value));
        index += 1;
        break;
      case "--port":
        port = parsePort(requiredValue(argument, value));
        index += 1;
        break;
      case "--host-id":
        configuredHostId = hostId(requiredValue(argument, value));
        index += 1;
        break;
      default:
        throw new TypeError(`unknown daemon argument: ${argument}`);
    }
  }

  if (mode === "host" && configuredHostId === undefined) {
    throw new TypeError("--host-id is required in host mode");
  }
  if (mode !== "host" && configuredHostId !== undefined) {
    throw new TypeError("--host-id is only valid in host mode");
  }
  if (configuredHostId === undefined) {
    return { home, mode, port };
  }
  return { home, mode, port, hostId: configuredHostId };
}

function daemonMode(value: string): DaemonModeName {
  if (value === "host" || value === "local" || value === "supervisor") {
    return value;
  }
  throw new TypeError("--mode must be host, local, or supervisor");
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new TypeError("--port must be an integer");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("--port must be between 1 and 65535");
  }
  return port;
}

function requiredValue(option: string, value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

function exitCode(error: unknown): number {
  if (error instanceof LifecycleLockError && error.code === "active_daemon") {
    return 3;
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return 2;
  }
  return 1;
}

function errorCode(error: unknown): string {
  if (error instanceof LifecycleLockError) {
    return error.code;
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return "invalid_configuration";
  }
  return "daemon_failure";
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await main(process.argv.slice(2));
}
export { registerWslHostService, type WslHostServiceOptions } from "./wsl-service.js";
