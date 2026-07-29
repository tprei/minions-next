import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { randomUUID } from "node:crypto";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  ListSessionsResponseSchema,
  MaintenanceService,
  MaintenanceSessionSchema,
  StartSessionResponseSchema,
  type MaintenanceSession,
} from "@minions/contracts";

/**
 * Maintenance service handler (PR 55 — maintenance-plane-readonly).
 *
 * StartSession and ListSessions are functional with an in-memory session list.
 * The sessions are ephemeral (lost on restart) — in production, a separate
 * maintenance journal DB would persist them independently of host.db.
 * RunTool, EndSession, and GetJournal require the maintenance journal store
 * and return Code.Unimplemented.
 */
export type MaintenanceServiceOptions = Readonly<Record<string, never>>;

export function registerMaintenanceService(
  router: ConnectRouter,
  options: MaintenanceServiceOptions,
): void {
  void options;
  const sessions = new Map<string, MaintenanceSession>();

  router.service(MaintenanceService, {
    startSession(request) {
      if (request.toolName.trim().length === 0) {
        throw new ConnectError("tool_name must not be empty", Code.InvalidArgument);
      }
      const sessionId = randomUUID();
      const now = Date.now();
      const session = create(MaintenanceSessionSchema, {
        sessionId,
        toolName: request.toolName,
        startedAt: create(TimestampSchema, {
          seconds: BigInt(Math.floor(now / 1000)),
          nanos: 0,
        }),
      });
      sessions.set(sessionId, session);
      return create(StartSessionResponseSchema, { session });
    },
    endSession() {
      throw new ConnectError("EndSession requires a maintenance journal store", Code.Unimplemented);
    },
    listSessions() {
      return create(ListSessionsResponseSchema, {
        sessions: [...sessions.values()],
      });
    },
    runTool() {
      throw new ConnectError("RunTool requires a maintenance journal store", Code.Unimplemented);
    },
    getJournal() {
      throw new ConnectError("GetJournal requires a maintenance journal store", Code.Unimplemented);
    },
  });
}
