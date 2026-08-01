import {
  actorSessionId,
  appendMaintenanceJournalEntry,
  closeMaintenanceSession,
  createMaintenanceJournal,
  DomainError,
  MAINTENANCE_JOURNAL_STORE_NAME,
  MAINTENANCE_TOOLS,
  nonEmptyText,
  openMaintenanceSession,
  recordMaintenanceSession,
  timestampFromEpochMilliseconds,
  type MaintenanceJournalEntry,
} from "@minions/core";
import { describe, expect, it } from "vitest";

/**
 * Unit tests for the maintenance journal/session domain (PR 55 —
 * maintenance-plane-readonly). The journal is a store separate from
 * host.db, holding transcript/action entries scoped to a session.
 */

function uuid(counter: number): string {
  return `01890f00-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`;
}

const startedAt = timestampFromEpochMilliseconds(1_700_000_000_000);
const endedAt = timestampFromEpochMilliseconds(1_700_000_001_000);

describe("openMaintenanceSession / closeMaintenanceSession", () => {
  it("opens a session for a known maintenance tool with no end/result yet", () => {
    const session = openMaintenanceSession(actorSessionId(uuid(1)), "doctor", startedAt);
    expect(session).toEqual({
      sessionId: actorSessionId(uuid(1)),
      toolName: "doctor",
      startedAt,
      endedAt: undefined,
      result: undefined,
    });
  });

  it("rejects an unknown tool name", () => {
    expect(() => openMaintenanceSession(actorSessionId(uuid(1)), "wipe-disk", startedAt)).toThrow(
      DomainError,
    );
    try {
      openMaintenanceSession(actorSessionId(uuid(1)), "wipe-disk", startedAt);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("invalid_value");
    }
  });

  it("accepts every registered maintenance tool name", () => {
    for (const tool of MAINTENANCE_TOOLS) {
      expect(() =>
        openMaintenanceSession(actorSessionId(uuid(1)), tool.name, startedAt),
      ).not.toThrow();
    }
  });

  it("closes a session, setting endedAt and result together", () => {
    const session = openMaintenanceSession(actorSessionId(uuid(1)), "doctor", startedAt);
    const closed = closeMaintenanceSession(session, endedAt, "succeeded");
    expect(closed.endedAt).toBe(endedAt);
    expect(closed.result).toBe("succeeded");
    expect(session.endedAt).toBeUndefined();
  });

  it("rejects closing an already-closed session", () => {
    const session = closeMaintenanceSession(
      openMaintenanceSession(actorSessionId(uuid(1)), "doctor", startedAt),
      endedAt,
      "succeeded",
    );
    expect(() => closeMaintenanceSession(session, endedAt, "failed")).toThrow(DomainError);
  });

  it("rejects endedAt preceding startedAt", () => {
    const session = openMaintenanceSession(actorSessionId(uuid(1)), "doctor", startedAt);
    const before = timestampFromEpochMilliseconds(1_600_000_000_000);
    expect(() => closeMaintenanceSession(session, before, "succeeded")).toThrow(DomainError);
  });
});

describe("MaintenanceJournal", () => {
  it("starts empty and never points at host.db", () => {
    const journal = createMaintenanceJournal();
    expect(journal.storeName).toBe(MAINTENANCE_JOURNAL_STORE_NAME);
    expect(journal.storeName).not.toBe("host.db");
    expect(journal.sessions).toEqual([]);
    expect(journal.entries).toEqual([]);
  });

  it("records a session and rejects recording the same session twice", () => {
    const session = openMaintenanceSession(actorSessionId(uuid(1)), "doctor", startedAt);
    const journal = recordMaintenanceSession(createMaintenanceJournal(), session);
    expect(journal.sessions).toEqual([session]);
    expect(() => recordMaintenanceSession(journal, session)).toThrow(DomainError);
  });

  it("appends transcript and action entries in increasing sequence order", () => {
    const session = openMaintenanceSession(actorSessionId(uuid(1)), "doctor", startedAt);
    let journal = recordMaintenanceSession(createMaintenanceJournal(), session);

    const transcript: MaintenanceJournalEntry = {
      kind: "transcript",
      sessionId: session.sessionId,
      sequence: 0,
      recordedAt: startedAt,
      text: nonEmptyText("running doctor checks", "text"),
    };
    const action: MaintenanceJournalEntry = {
      kind: "action",
      sessionId: session.sessionId,
      sequence: 1,
      recordedAt: endedAt,
      toolName: "doctor",
      mutating: false,
    };

    journal = appendMaintenanceJournalEntry(journal, transcript);
    journal = appendMaintenanceJournalEntry(journal, action);

    expect(journal.entries).toEqual([transcript, action]);
  });

  it("rejects appending an entry for an unrecorded session", () => {
    const entry: MaintenanceJournalEntry = {
      kind: "transcript",
      sessionId: actorSessionId(uuid(2)),
      sequence: 0,
      recordedAt: startedAt,
      text: nonEmptyText("orphan entry", "text"),
    };
    expect(() => appendMaintenanceJournalEntry(createMaintenanceJournal(), entry)).toThrow(
      DomainError,
    );
  });

  it("rejects non-increasing sequence numbers within a session", () => {
    const session = openMaintenanceSession(actorSessionId(uuid(1)), "doctor", startedAt);
    let journal = recordMaintenanceSession(createMaintenanceJournal(), session);
    journal = appendMaintenanceJournalEntry(journal, {
      kind: "transcript",
      sessionId: session.sessionId,
      sequence: 5,
      recordedAt: startedAt,
      text: nonEmptyText("first", "text"),
    });

    expect(() =>
      appendMaintenanceJournalEntry(journal, {
        kind: "transcript",
        sessionId: session.sessionId,
        sequence: 5,
        recordedAt: endedAt,
        text: nonEmptyText("duplicate sequence", "text"),
      }),
    ).toThrow(DomainError);
  });

  it("tracks sequence numbers independently per session", () => {
    const sessionA = openMaintenanceSession(actorSessionId(uuid(1)), "doctor", startedAt);
    const sessionB = openMaintenanceSession(actorSessionId(uuid(2)), "logs", startedAt);
    let journal = recordMaintenanceSession(createMaintenanceJournal(), sessionA);
    journal = recordMaintenanceSession(journal, sessionB);

    journal = appendMaintenanceJournalEntry(journal, {
      kind: "transcript",
      sessionId: sessionA.sessionId,
      sequence: 0,
      recordedAt: startedAt,
      text: nonEmptyText("session a entry", "text"),
    });
    journal = appendMaintenanceJournalEntry(journal, {
      kind: "transcript",
      sessionId: sessionB.sessionId,
      sequence: 0,
      recordedAt: startedAt,
      text: nonEmptyText("session b entry", "text"),
    });

    expect(journal.entries).toHaveLength(2);
  });
});
