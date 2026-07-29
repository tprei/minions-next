import { DomainError } from "./domain-error.js";
import {
  compareTimestamps,
  type ActorSessionId,
  type NonEmptyText,
  type Timestamp,
} from "./value-objects.js";

/**
 * Maintenance plane (PR 55 — maintenance-plane-readonly).
 *
 * Starts an OMP diagnostic session even when the primary host API, scheduler,
 * or projections are unhealthy. Uses a SEPARATE supervisor maintenance DB and
 * event stream — never the primary host.db. Default tools are read-only.
 */
export type MaintenanceTool = Readonly<{
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
}>;

export const MAINTENANCE_TOOLS: readonly MaintenanceTool[] = Object.freeze([
  { name: "doctor", description: "Health check the host and all capabilities", mutating: false },
  { name: "logs", description: "Inspect daemon and harness logs", mutating: false },
  { name: "stacks", description: "Capture process stack traces", mutating: false },
  { name: "processes", description: "List running processes and their state", mutating: false },
  { name: "leases", description: "Inspect scheduler leases", mutating: false },
  { name: "db-integrity", description: "Check database integrity and migrations", mutating: false },
  { name: "source-inspect", description: "Read source files (read-only)", mutating: false },
]);

const maintenanceToolNames: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(MAINTENANCE_TOOLS.map((tool) => [tool.name, true as const])),
);

export type MaintenanceSessionResult = "succeeded" | "failed" | "cancelled";

/**
 * A single maintenance-tool invocation. `endedAt`/`result` are undefined
 * while the session is still running and set together when it closes.
 */
export type MaintenanceSession = Readonly<{
  readonly sessionId: ActorSessionId;
  readonly toolName: string;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp | undefined;
  readonly result: MaintenanceSessionResult | undefined;
}>;

export function openMaintenanceSession(
  sessionId: ActorSessionId,
  toolName: string,
  startedAt: Timestamp,
): MaintenanceSession {
  if (!Object.hasOwn(maintenanceToolNames, toolName)) {
    throw new DomainError("invalid_value", `unknown maintenance tool: ${toolName}`);
  }
  return Object.freeze({ sessionId, toolName, startedAt, endedAt: undefined, result: undefined });
}

export function closeMaintenanceSession(
  session: MaintenanceSession,
  endedAt: Timestamp,
  result: MaintenanceSessionResult,
): MaintenanceSession {
  if (session.endedAt !== undefined || session.result !== undefined) {
    throw new DomainError("invalid_transition", "maintenance session is already closed");
  }
  if (compareTimestamps(endedAt, session.startedAt) < 0) {
    throw new DomainError("invalid_value", "endedAt must not precede startedAt");
  }
  return Object.freeze({ ...session, endedAt, result });
}

/**
 * A separately journaled transcript/actions store for maintenance sessions.
 * The store name is a fixed literal distinct from the primary host database —
 * a maintenance journal can never point at host.db.
 */
export const MAINTENANCE_JOURNAL_STORE_NAME = "maintenance-journal" as const;

export type MaintenanceJournalEntry =
  | Readonly<{
      readonly kind: "transcript";
      readonly sessionId: ActorSessionId;
      readonly sequence: number;
      readonly recordedAt: Timestamp;
      readonly text: NonEmptyText;
    }>
  | Readonly<{
      readonly kind: "action";
      readonly sessionId: ActorSessionId;
      readonly sequence: number;
      readonly recordedAt: Timestamp;
      readonly toolName: string;
      readonly mutating: boolean;
    }>;

export type MaintenanceJournal = Readonly<{
  readonly storeName: typeof MAINTENANCE_JOURNAL_STORE_NAME;
  readonly sessions: readonly MaintenanceSession[];
  readonly entries: readonly MaintenanceJournalEntry[];
}>;

export function createMaintenanceJournal(): MaintenanceJournal {
  return Object.freeze({ storeName: MAINTENANCE_JOURNAL_STORE_NAME, sessions: [], entries: [] });
}

export function recordMaintenanceSession(
  journal: MaintenanceJournal,
  session: MaintenanceSession,
): MaintenanceJournal {
  if (journal.sessions.some((existing) => existing.sessionId === session.sessionId)) {
    throw new DomainError(
      "duplicate_id",
      `maintenance session already recorded: ${session.sessionId}`,
    );
  }
  return Object.freeze({ ...journal, sessions: Object.freeze([...journal.sessions, session]) });
}

export function appendMaintenanceJournalEntry(
  journal: MaintenanceJournal,
  entry: MaintenanceJournalEntry,
): MaintenanceJournal {
  if (!journal.sessions.some((session) => session.sessionId === entry.sessionId)) {
    throw new DomainError("not_found", `unknown maintenance session: ${entry.sessionId}`);
  }
  const maxSequence = journal.entries
    .filter((existing) => existing.sessionId === entry.sessionId)
    .reduce((max, existing) => Math.max(max, existing.sequence), -1);
  if (entry.sequence <= maxSequence) {
    throw new DomainError(
      "invalid_value",
      "journal entries must have strictly increasing sequence numbers",
    );
  }
  return Object.freeze({ ...journal, entries: Object.freeze([...journal.entries, entry]) });
}
