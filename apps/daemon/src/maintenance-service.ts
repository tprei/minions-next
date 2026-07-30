import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { randomUUID } from "node:crypto";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  EndSessionResponseSchema,
  ListSessionsResponseSchema,
  MaintenanceService,
  MaintenanceSessionResult,
  MaintenanceSessionSchema,
  StartSessionResponseSchema,
  type MaintenanceSession,
} from "@minions/contracts";

/**
 * Maintenance service handler (PR 55 — maintenance-plane-readonly).
 *
 * StartSession, EndSession, and ListSessions are functional with an in-memory session
 * list. The sessions are ephemeral (lost on restart) — in production, a separate
 * maintenance journal DB would persist them independently of host.db. RunTool and
 * GetJournal require that same durable maintenance journal store (a tool actually
 * executing, and its output/exit history surviving a restart) and return
 * Code.Unimplemented until it exists.
 */
export type MaintenanceServiceOptions = Readonly<Record<string, never>>;

function nowTimestamp() {
  return create(TimestampSchema, { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 });
}

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
      // No tool ever ran in this session (RunTool is not yet implemented), so closing
      // it is always a cancellation, never a success/failure outcome of a tool run.
      const ended = create(MaintenanceSessionSchema, {
        ...session,
        endedAt: nowTimestamp(),
        result: MaintenanceSessionResult.CANCELLED,
      });
      sessions.set(session.sessionId, ended);
      return create(EndSessionResponseSchema, { session: ended });
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
