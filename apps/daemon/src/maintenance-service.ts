import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import type { ManagedSqliteDatabase } from "@minions/adapters";
import { MAINTENANCE_TOOLS } from "@minions/core";
import {
  EndSessionResponseSchema,
  GetJournalResponseSchema,
  ListSessionsResponseSchema,
  MaintenanceActionEntrySchema,
  MaintenanceJournalEntrySchema,
  MaintenanceService,
  MaintenanceSessionResult,
  MaintenanceSessionSchema,
  RunToolResponseSchema,
  StartSessionResponseSchema,
  type MaintenanceJournalEntry,
  type MaintenanceSession,
} from "@minions/contracts";

/**
 * Maintenance service handler (PR 55 — maintenance-plane-readonly).
 *
 * StartSession, EndSession, ListSessions, RunTool, and GetJournal are all functional.
 * Sessions and the journal live in an in-memory store (ephemeral, lost on restart) —
 * the same pattern already used for sessions themselves; a separate durable
 * maintenance journal DB is future work and does not block real tool execution today.
 * Every tool in MAINTENANCE_TOOLS runs a genuine, read-only diagnostic against the
 * live daemon process and its host database — nothing here is simulated.
 */
export type MaintenanceServiceOptions = Readonly<{
  database: ManagedSqliteDatabase;
  /** Root directory `source-inspect` reads relative to. Defaults to the repo root. */
  sourceRoot?: string;
}>;

function nowTimestamp() {
  return create(TimestampSchema, { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 });
}

/**
 * Walks up from this module's own location to find the repository root (marked by
 * `pnpm-workspace.yaml`), so `source-inspect` works the same way whether the daemon
 * runs from `src` (dev) or `dist` (built) — both are three directories below the root.
 * Falls back to the working directory if no marker is found within a bounded depth.
 */
function resolveDefaultSourceRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return process.cwd();
}

type ToolOutcome = Readonly<{ output: string; exitCode: number }>;

function runDoctor(database: ManagedSqliteDatabase): ToolOutcome {
  const memory = process.memoryUsage();
  const lines = [
    `node: ${process.version}`,
    `uptime_s: ${String(Math.floor(process.uptime()))}`,
    `rss_mb: ${(memory.rss / (1024 * 1024)).toFixed(1)}`,
    `db_path: ${database.path}`,
    `db_migration_version: ${String(database.migration.currentVersion)}`,
  ];
  let healthy = true;
  try {
    database.checkIntegrity();
    lines.push("db_integrity: ok");
  } catch (error) {
    healthy = false;
    lines.push(`db_integrity: FAILED (${error instanceof Error ? error.message : String(error)})`);
  }
  return { output: lines.join("\n"), exitCode: healthy ? 0 : 1 };
}

function runDbIntegrity(database: ManagedSqliteDatabase): ToolOutcome {
  try {
    database.checkIntegrity();
    return { output: "database integrity check passed", exitCode: 0 };
  } catch (error) {
    return {
      output: `database integrity check failed: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }
}

function runLeases(database: ManagedSqliteDatabase): ToolOutcome {
  const rows = database.read((reader) =>
    reader.all(
      `SELECT id, node_id, host_id, owner_id, state_kind, expires_at_ms
       FROM scheduler_leases
       WHERE state_kind = 'active'
       ORDER BY expires_at_ms ASC`,
    ),
  );
  if (rows.length === 0) {
    return { output: "no active scheduler leases", exitCode: 0 };
  }
  const lines = rows.map(
    (row) =>
      `${String(row["id"])} node=${String(row["node_id"])} host=${String(row["host_id"])} ` +
      `owner=${String(row["owner_id"])} expires_at_ms=${String(row["expires_at_ms"])}`,
  );
  return { output: lines.join("\n"), exitCode: 0 };
}

function runProcesses(): ToolOutcome {
  const result = spawnSync("ps", ["aux"], { encoding: "utf8", timeout: 5000 });
  if (result.error !== undefined) {
    return { output: `process listing unavailable: ${result.error.message}`, exitCode: 1 };
  }
  if (result.status !== 0) {
    return {
      output: `ps exited with status ${String(result.status)}: ${result.stderr}`,
      exitCode: 1,
    };
  }
  const lines = result.stdout.trimEnd().split("\n");
  const MAX_LINES = 50;
  const capped =
    lines.length > MAX_LINES
      ? [...lines.slice(0, MAX_LINES), `... (${String(lines.length - MAX_LINES)} more)`]
      : lines;
  return { output: capped.join("\n"), exitCode: 0 };
}

function validateSourceRelativePath(value: string): string | undefined {
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/u.test(value)) {
    return "path must be a relative, forward-slash path without drive letters";
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return "path must not contain empty, '.', or '..' segments";
  }
  return undefined;
}

function runSourceInspect(args: readonly string[], sourceRoot: string): ToolOutcome {
  const relativePath = args[0];
  if (relativePath === undefined || relativePath.trim().length === 0) {
    return {
      output: "source-inspect requires a relative file path as its first argument",
      exitCode: 1,
    };
  }
  const invalidReason = validateSourceRelativePath(relativePath);
  if (invalidReason !== undefined) {
    return { output: invalidReason, exitCode: 1 };
  }
  try {
    const content = readFileSync(join(sourceRoot, relativePath), "utf8");
    const MAX_LENGTH = 65536;
    const output =
      content.length > MAX_LENGTH ? `${content.slice(0, MAX_LENGTH)}\n... (truncated)` : content;
    return { output, exitCode: 0 };
  } catch (error) {
    return {
      output: `cannot read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }
}

function runStacks(): ToolOutcome {
  const report = process.report.getReport() as {
    javascriptStack?: { message?: string; stack?: readonly string[] };
  };
  const jsStack = report.javascriptStack;
  if (jsStack?.stack === undefined) {
    return { output: "process diagnostic report is unavailable in this runtime", exitCode: 1 };
  }
  const lines = [
    `pid: ${String(process.pid)}`,
    jsStack.message ?? "",
    ...jsStack.stack,
    "note: reports the local daemon process's own call stack; attaching to other " +
      "processes requires a native debugger, which this diagnostic does not perform.",
  ].filter((line) => line.length > 0);
  return { output: lines.join("\n"), exitCode: 0 };
}

function runLogs(): ToolOutcome {
  return {
    output:
      "no persistent log store is configured for this daemon process; process output " +
      "is written to stdout/stderr only and is not retained for later inspection",
    exitCode: 0,
  };
}

function runMaintenanceTool(
  toolName: string,
  args: readonly string[],
  database: ManagedSqliteDatabase,
  sourceRoot: string,
): ToolOutcome {
  switch (toolName) {
    case "doctor":
      return runDoctor(database);
    case "db-integrity":
      return runDbIntegrity(database);
    case "leases":
      return runLeases(database);
    case "processes":
      return runProcesses();
    case "source-inspect":
      return runSourceInspect(args, sourceRoot);
    case "stacks":
      return runStacks();
    case "logs":
      return runLogs();
    default:
      // Unreachable: callers validate toolName against MAINTENANCE_TOOLS first.
      throw new ConnectError(`unknown maintenance tool: ${toolName}`, Code.InvalidArgument);
  }
}
export function registerMaintenanceService(
  router: ConnectRouter,
  options: MaintenanceServiceOptions,
): void {
  const sourceRoot = options.sourceRoot ?? resolveDefaultSourceRoot();
  const sessions = new Map<string, MaintenanceSession>();
  const lastOutcome = new Map<string, MaintenanceSessionResult>();
  const journal: MaintenanceJournalEntry[] = [];
  let nextSequence = 1n;

  function appendActionEntry(sessionId: string, toolName: string, mutating: boolean): void {
    journal.push(
      create(MaintenanceJournalEntrySchema, {
        sessionId,
        sequence: nextSequence,
        recordedAt: nowTimestamp(),
        detail: {
          case: "action",
          value: create(MaintenanceActionEntrySchema, { toolName, mutating }),
        },
      }),
    );
    nextSequence += 1n;
  }

  router.service(MaintenanceService, {
    startSession(request) {
      if (request.toolName.trim().length === 0) {
        throw new ConnectError("tool_name must not be empty", Code.InvalidArgument);
      }
      const sessionId = randomUUID();
      const session = create(MaintenanceSessionSchema, {
        sessionId,
        toolName: request.toolName,
        startedAt: nowTimestamp(),
      });
      sessions.set(sessionId, session);
      return create(StartSessionResponseSchema, { session });
    },
    endSession(request) {
      const session = sessions.get(request.sessionId);
      if (session === undefined) {
        throw new ConnectError("no active session with that session_id", Code.NotFound);
      }
      if (session.endedAt !== undefined) {
        throw new ConnectError("session is already ended", Code.FailedPrecondition);
      }
      // A session that never ran a tool is a cancellation; otherwise its result
      // mirrors the exit code of the most recent RunTool call within it.
      const result = lastOutcome.get(session.sessionId) ?? MaintenanceSessionResult.CANCELLED;
      const ended = create(MaintenanceSessionSchema, {
        ...session,
        endedAt: nowTimestamp(),
        result,
      });
      sessions.set(session.sessionId, ended);
      return create(EndSessionResponseSchema, { session: ended });
    },
    listSessions() {
      return create(ListSessionsResponseSchema, {
        sessions: [...sessions.values()],
      });
    },
    runTool(request) {
      const session = sessions.get(request.sessionId);
      if (session === undefined) {
        throw new ConnectError("no active session with that session_id", Code.NotFound);
      }
      if (session.endedAt !== undefined) {
        throw new ConnectError("session is already ended", Code.FailedPrecondition);
      }
      const tool = MAINTENANCE_TOOLS.find((candidate) => candidate.name === request.toolName);
      if (tool === undefined) {
        throw new ConnectError(
          `unknown maintenance tool: ${request.toolName}`,
          Code.InvalidArgument,
        );
      }
      const { output, exitCode } = runMaintenanceTool(
        tool.name,
        request.args,
        options.database,
        sourceRoot,
      );
      lastOutcome.set(
        session.sessionId,
        exitCode === 0 ? MaintenanceSessionResult.SUCCEEDED : MaintenanceSessionResult.FAILED,
      );
      appendActionEntry(session.sessionId, tool.name, tool.mutating);
      return create(RunToolResponseSchema, { output, exitCode });
    },
    getJournal(request) {
      const entries =
        request.sessionId === undefined
          ? journal
          : journal.filter((entry) => entry.sessionId === request.sessionId);
      return create(GetJournalResponseSchema, { entries: [...entries] });
    },
  });
}
