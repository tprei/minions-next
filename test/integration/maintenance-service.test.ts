import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import type { ManagedSqliteDatabase } from "@minions/adapters";
import { MaintenanceService, MaintenanceSessionResult } from "@minions/contracts";
import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerMaintenanceService } from "@minions/daemon";

/**
 * Maintenance service integration tests (PR 55 — maintenance-plane-readonly).
 *
 * Uses Connect's in-memory `createRouterTransport` (see pairing-service.test.ts's doc
 * comment for why this is a faithful integration test, not a mock) against a real,
 * temporary SQLite host database — RunTool executes genuine diagnostics, not stubs.
 */
let temporary: TemporarySqliteDatabase;
let database: ManagedSqliteDatabase;

beforeEach(async () => {
  temporary = await TemporarySqliteDatabase.create(
    "host",
    new FixedClock(timestampFromEpochMilliseconds(1_735_689_600_000)),
  );
  database = temporary.database;
});

afterEach(async () => {
  await temporary.dispose();
});

function maintenanceClient() {
  const transport = createRouterTransport((router) => {
    registerMaintenanceService(router, { database });
  });
  return createClient(MaintenanceService, transport);
}

async function openSession(maintenance: ReturnType<typeof maintenanceClient>, toolName = "doctor") {
  const { session } = await maintenance.startSession({ toolName });
  return session?.sessionId ?? "";
}

describe("MaintenanceService integration", () => {
  it("startSession opens a session that appears in listSessions", async () => {
    const maintenance = maintenanceClient();
    const { session } = await maintenance.startSession({ toolName: "doctor" });
    expect(session?.toolName).toBe("doctor");
    expect(session?.endedAt).toBeUndefined();

    const { sessions } = await maintenance.listSessions({});
    expect(sessions.map((s) => s.sessionId)).toContain(session?.sessionId);
  });

  it("rejects startSession with an empty tool name", async () => {
    const maintenance = maintenanceClient();
    await expect(maintenance.startSession({ toolName: "" })).rejects.toThrow(ConnectError);
  });

  it("endSession closes a session that never ran a tool as cancelled", async () => {
    const maintenance = maintenanceClient();
    const { session } = await maintenance.startSession({ toolName: "logs" });
    const sessionId = session?.sessionId ?? "";

    const { session: ended } = await maintenance.endSession({ sessionId });
    expect(ended?.sessionId).toBe(sessionId);
    expect(ended?.toolName).toBe("logs");
    expect(ended?.startedAt).toEqual(session?.startedAt);
    expect(ended?.endedAt).toBeDefined();
    expect(ended?.result).toBe(MaintenanceSessionResult.CANCELLED);
  });

  it("an ended session reflects its ended state in listSessions", async () => {
    const maintenance = maintenanceClient();
    const { session } = await maintenance.startSession({ toolName: "processes" });
    await maintenance.endSession({ sessionId: session?.sessionId ?? "" });

    const { sessions } = await maintenance.listSessions({});
    const listed = sessions.find((s) => s.sessionId === session?.sessionId);
    expect(listed?.endedAt).toBeDefined();
    expect(listed?.result).toBe(MaintenanceSessionResult.CANCELLED);
  });

  it("rejects endSession for an unknown session id", async () => {
    const maintenance = maintenanceClient();
    try {
      await maintenance.endSession({ sessionId: "01900000-0000-7000-8000-000000000099" });
      expect.unreachable("endSession must reject an unknown session id");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.NotFound);
    }
  });

  it("rejects ending an already-ended session (no double-close)", async () => {
    const maintenance = maintenanceClient();
    const { session } = await maintenance.startSession({ toolName: "doctor" });
    const sessionId = session?.sessionId ?? "";
    await maintenance.endSession({ sessionId });

    try {
      await maintenance.endSession({ sessionId });
      expect.unreachable("endSession must reject a second close of the same session");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.FailedPrecondition);
    }
  });

  it("rejects runTool for an unknown session id", async () => {
    const maintenance = maintenanceClient();
    try {
      await maintenance.runTool({
        sessionId: "01900000-0000-7000-8000-000000000001",
        toolName: "doctor",
      });
      expect.unreachable("runTool must reject an unknown session id");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.NotFound);
    }
  });

  it("rejects runTool for an ended session", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance);
    await maintenance.endSession({ sessionId });

    try {
      await maintenance.runTool({ sessionId, toolName: "doctor" });
      expect.unreachable("runTool must reject an ended session");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.FailedPrecondition);
    }
  });

  it("rejects runTool for a tool name outside the maintenance tool registry", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance);
    try {
      await maintenance.runTool({ sessionId, toolName: "rm-rf" });
      expect.unreachable("runTool must reject an unregistered tool");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.InvalidArgument);
    }
  });

  it("doctor reports real process and database health", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "doctor");
    const { output, exitCode } = await maintenance.runTool({ sessionId, toolName: "doctor" });
    expect(exitCode).toBe(0);
    expect(output).toContain(`node: ${process.version}`);
    expect(output).toContain(`db_path: ${database.path}`);
    expect(output).toContain("db_integrity: ok");
  });

  it("db-integrity passes against a freshly migrated database", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "db-integrity");
    const { output, exitCode } = await maintenance.runTool({ sessionId, toolName: "db-integrity" });
    expect(exitCode).toBe(0);
    expect(output).toBe("database integrity check passed");
  });

  it("leases reports no active leases against an empty scheduler table", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "leases");
    const { output, exitCode } = await maintenance.runTool({ sessionId, toolName: "leases" });
    expect(exitCode).toBe(0);
    expect(output).toBe("no active scheduler leases");
  });

  it("processes lists real running processes from the host", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "processes");
    const { output, exitCode } = await maintenance.runTool({ sessionId, toolName: "processes" });
    expect(exitCode).toBe(0);
    // A real `ps aux` snapshot always has a header and PID 1 (init) near the top,
    // well within the tool's 50-line cap regardless of how busy the host is.
    expect(output).toContain("USER");
    expect(output).toContain("PID");
    expect(output.split("\n").length).toBeGreaterThan(1);
  });

  it("stacks captures the local daemon process's own call stack", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "stacks");
    const { output, exitCode } = await maintenance.runTool({ sessionId, toolName: "stacks" });
    expect(exitCode).toBe(0);
    expect(output).toContain(`pid: ${String(process.pid)}`);
  });

  it("logs honestly reports that no persistent log store is configured", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "logs");
    const { output, exitCode } = await maintenance.runTool({ sessionId, toolName: "logs" });
    expect(exitCode).toBe(0);
    expect(output).toContain("no persistent log store is configured");
  });

  it("source-inspect reads a real repository file via the default resolved root", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "source-inspect");
    const { output, exitCode } = await maintenance.runTool({
      sessionId,
      toolName: "source-inspect",
      args: ["package.json"],
    });
    expect(exitCode).toBe(0);
    expect(output).toContain('"name": "minions"');
  });

  it("source-inspect rejects a missing path argument", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "source-inspect");
    const { output, exitCode } = await maintenance.runTool({
      sessionId,
      toolName: "source-inspect",
    });
    expect(exitCode).toBe(1);
    expect(output).toContain("requires a relative file path");
  });

  it("source-inspect rejects a path-traversal attempt", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "source-inspect");
    const { output, exitCode } = await maintenance.runTool({
      sessionId,
      toolName: "source-inspect",
      args: ["../../etc/passwd"],
    });
    expect(exitCode).toBe(1);
    expect(output).toContain("must not contain empty, '.', or '..' segments");
  });

  it("source-inspect rejects an absolute path", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "source-inspect");
    const { output, exitCode } = await maintenance.runTool({
      sessionId,
      toolName: "source-inspect",
      args: ["/etc/passwd"],
    });
    expect(exitCode).toBe(1);
    expect(output).toContain("must be a relative");
  });

  it("runTool appends a journal action entry visible through getJournal", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "doctor");
    await maintenance.runTool({ sessionId, toolName: "doctor" });

    const { entries } = await maintenance.getJournal({ sessionId });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.sessionId).toBe(sessionId);
    expect(entry?.sequence).toBe(1n);
    expect(entry?.detail.case).toBe("action");
    expect(entry?.detail.value).toMatchObject({ toolName: "doctor", mutating: false });
  });

  it("getJournal without a session id returns entries across every session in order", async () => {
    const maintenance = maintenanceClient();
    const first = await openSession(maintenance, "doctor");
    const second = await openSession(maintenance, "db-integrity");
    await maintenance.runTool({ sessionId: first, toolName: "doctor" });
    await maintenance.runTool({ sessionId: second, toolName: "db-integrity" });
    await maintenance.runTool({ sessionId: first, toolName: "leases" });

    const { entries } = await maintenance.getJournal({});
    expect(entries.map((entry) => entry.sequence)).toEqual([1n, 2n, 3n]);
    expect(entries.map((entry) => entry.sessionId)).toEqual([first, second, first]);
  });

  it("getJournal filters to a single session's entries", async () => {
    const maintenance = maintenanceClient();
    const first = await openSession(maintenance, "doctor");
    const second = await openSession(maintenance, "db-integrity");
    await maintenance.runTool({ sessionId: first, toolName: "doctor" });
    await maintenance.runTool({ sessionId: second, toolName: "db-integrity" });

    const { entries } = await maintenance.getJournal({ sessionId: second });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionId).toBe(second);
  });

  it("endSession reflects succeeded after a passing tool run", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "db-integrity");
    await maintenance.runTool({ sessionId, toolName: "db-integrity" });

    const { session } = await maintenance.endSession({ sessionId });
    expect(session?.result).toBe(MaintenanceSessionResult.SUCCEEDED);
  });

  it("endSession reflects failed after a failing tool run", async () => {
    const maintenance = maintenanceClient();
    const sessionId = await openSession(maintenance, "source-inspect");
    await maintenance.runTool({ sessionId, toolName: "source-inspect" });

    const { session } = await maintenance.endSession({ sessionId });
    expect(session?.result).toBe(MaintenanceSessionResult.FAILED);
  });
});
