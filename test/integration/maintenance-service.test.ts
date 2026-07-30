import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import { MaintenanceService, MaintenanceSessionResult } from "@minions/contracts";
import { describe, expect, it } from "vitest";

import { registerMaintenanceService } from "@minions/daemon";

/**
 * Maintenance service integration tests (PR 55 — maintenance-plane-readonly).
 *
 * Uses Connect's in-memory `createRouterTransport` (see pairing-service.test.ts's doc
 * comment for why this is a faithful integration test, not a mock).
 */
function maintenanceClient() {
  const transport = createRouterTransport((router) => {
    registerMaintenanceService(router, {});
  });
  return createClient(MaintenanceService, transport);
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

  it("endSession closes an open session as cancelled and preserves its identity", async () => {
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

  it("runTool and getJournal remain Code.Unimplemented (no journal store yet)", async () => {
    const maintenance = maintenanceClient();
    await expect(
      maintenance.runTool({
        sessionId: "01900000-0000-7000-8000-000000000001",
        toolName: "doctor",
      }),
    ).rejects.toThrow(ConnectError);
    await expect(
      maintenance.getJournal({ sessionId: "01900000-0000-7000-8000-000000000001" }),
    ).rejects.toThrow(ConnectError);
  });
});
