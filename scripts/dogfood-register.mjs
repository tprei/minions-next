#!/usr/bin/env node
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createSecureIdGenerator,
  daemonLifecyclePath,
  inspectLifecycleLock,
} from "@minions/adapters";
import { RepositoryService } from "@minions/contracts";
import { timestampFromEpochMilliseconds } from "@minions/core";

// PR 42 bootstrap-threshold helper: register THIS repository's own absolute root as a
// Minions-tracked repository against a locally running daemon, so Minions can register and
// operate against its own checkout (the "dogfood" repository).
//
// Idempotent: a repeat run against an already-registered checkout finds the existing
// registration and reports success without mutating anything. It only fails when the daemon
// is unreachable or the registration is rejected for a reason unrelated to "already
// registered" (dirty checkout, submodules, LFS paths, nested repositories, a rejected gate
// profile, and so on).
//
// Requires a running daemon (`minions start`, i.e. `pnpm --filter @minions/cli exec minions
// start` or the built `minions` binary). Run from anywhere:
//
//   node scripts/dogfood-register.mjs
//   node scripts/dogfood-register.mjs --home /custom/minions/home
//   MINIONS_HOME=/custom/minions/home node scripts/dogfood-register.mjs
//
// This does NOT perform an actual self-change / live OMP run against the repository — it only
// registers the repository record. That is a separate, later, human-reviewed step.

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);

await main();

async function main() {
  try {
    const record = await registerSelf(loadConfiguration());
    emit(record);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

function loadConfiguration() {
  const home = readHomeOption() ?? process.env["MINIONS_HOME"] ?? join(homedir(), ".minions");
  return Object.freeze({ home });
}

function readHomeOption() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--home");
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("--home requires a value");
  }
  return value;
}

async function registerSelf(configuration) {
  const inspection = inspectLifecycleLock(daemonLifecyclePath(configuration.home));
  if (inspection.state !== "active") {
    throw new Error(
      `daemon is ${inspection.state} at home ${configuration.home}; ` +
        `start it first (e.g. 'minions start --home ${configuration.home}').`,
    );
  }
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${String(inspection.record.port)}`,
    httpVersion: "1.1",
    useBinaryFormat: true,
  });
  const client = createClient(RepositoryService, transport);
  const canonicalRoot = await realpath(repositoryRoot);

  const existing = await findRegisteredRepository(client, canonicalRoot);
  if (existing !== undefined) {
    return { status: "already_registered", repository: repositoryJson(existing) };
  }

  const ids = createSecureIdGenerator({ now: () => timestampFromEpochMilliseconds(Date.now()) });
  try {
    const response = await client.registerRepository({
      commandId: ids.nextId(),
      actorSessionId: ids.nextId(),
      repositoryId: ids.nextId(),
      rootPath: canonicalRoot,
    });
    if (response.repository === undefined) {
      throw new Error("repository registration response is missing repository");
    }
    return { status: "registered", repository: repositoryJson(response.repository) };
  } catch (error) {
    // Race: another registration for this exact root landed between our list check above and
    // this call (e.g. a concurrent re-run). Re-list and treat that as an idempotent no-op
    // success instead of surfacing the FailedPrecondition ("overlap") the registry raises for a
    // duplicate root/workspace.
    if (error instanceof ConnectError && error.code === Code.FailedPrecondition) {
      const raced = await findRegisteredRepository(client, canonicalRoot);
      if (raced !== undefined) {
        return { status: "already_registered", repository: repositoryJson(raced) };
      }
    }
    throw error;
  }
}

async function findRegisteredRepository(client, canonicalRoot) {
  const seenTokens = new Set();
  let pageToken;
  do {
    const request = pageToken === undefined ? { pageSize: 100 } : { pageSize: 100, pageToken };
    const response = await client.listRepositories(request);
    const match = response.repositories.find(
      (repository) => repository.canonicalRoot === canonicalRoot,
    );
    if (match !== undefined) {
      return match;
    }
    pageToken = response.nextPageToken;
    if (pageToken !== undefined) {
      if (seenTokens.has(pageToken)) {
        throw new Error("repository pagination repeated a continuation token");
      }
      seenTokens.add(pageToken);
    }
  } while (pageToken !== undefined);
  return undefined;
}

function repositoryJson(repository) {
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
  };
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
