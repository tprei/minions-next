import {
  createSqliteRecoveryStore,
  openHostDatabase,
  type ManagedSqliteDatabase,
} from "@minions/adapters";
import {
  timestampFromEpochMilliseconds,
  type ElevationGrant,
  type RecordedRecoveryAction,
} from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * SQLite recovery store integration tests (PR 56 — maintenance-elevation-recovery).
 *
 * Covers the durable elevation-grant + recovery-action store against a real, temporary
 * SQLite host database (migration `0014_recovery_elevation.sql`) — round-trips, outcome
 * transitions, pagination, and crash-safety (a write survives closing and reopening the
 * same database file), matching this repo's "durable and replayable" principle.
 */

const BASE_TIME = 1_700_000_000_000;
const clock = new FixedClock(timestampFromEpochMilliseconds(BASE_TIME));
const ACTOR = "0190af1e-7b2d-7c3a-89ab-1234567890ab";
const GRANT_ID = "01900000-0000-7000-8000-000000000001";

let temporary: TemporarySqliteDatabase | undefined;

beforeEach(async () => {
  temporary = await TemporarySqliteDatabase.create("host", clock);
});

afterEach(async () => {
  const current = temporary;
  temporary = undefined;
  if (current !== undefined) {
    await current.dispose();
  }
});

function store() {
  if (temporary === undefined) {
    throw new Error("temporary database is not initialized");
  }
  return createSqliteRecoveryStore({ database: temporary.database });
}

function makeGrant(overrides: Partial<ElevationGrant> = {}): ElevationGrant {
  return Object.freeze({
    id: GRANT_ID,
    requestedBySessionId: ACTOR,
    authorizedKinds: ["restart"] as const,
    justification: "investigating a stuck sandbox",
    state: "approved",
    approvalsReceived: 1,
    createdAt: BASE_TIME,
    expiresAt: BASE_TIME + 900_000,
    ...overrides,
  });
}

function makeAction(overrides: Partial<RecordedRecoveryAction> = {}): RecordedRecoveryAction {
  return Object.freeze({
    id: "01900000-0000-7000-8000-000000000010",
    grantId: GRANT_ID,
    kind: "restart",
    target: "primary-daemon",
    expectedState: "running",
    actorSessionId: ACTOR,
    expiresAt: BASE_TIME + 60_000,
    state: "pending",
    createdAt: BASE_TIME,
    ...overrides,
  });
}

// -------------------------------------------------------------------------------------------------
// Tests.
// -------------------------------------------------------------------------------------------------

describe("recovery store: elevation grant round-trip", () => {
  it("creates a grant and reads it back exactly", async () => {
    const grant = makeGrant();
    await store().createGrant(grant);
    await expect(store().getGrant(grant.id)).resolves.toEqual(grant);
  });

  it("returns undefined for an unknown grant id, never throws not_found", async () => {
    await expect(store().getGrant("01900000-0000-7000-8000-000000000099")).resolves.toBeUndefined();
  });

  it("marks a grant consumed independently of any action", async () => {
    const grant = makeGrant();
    await store().createGrant(grant);
    await store().markGrantConsumed(grant.id);
    await expect(store().getGrant(grant.id)).resolves.toEqual({ ...grant, state: "consumed" });
  });
});

describe("recovery store: recovery action outcome transitions", () => {
  beforeEach(async () => {
    await store().createGrant(makeGrant());
  });

  it("creates a pending action, then transitions it to executed", async () => {
    const action = makeAction();
    await store().createAction(action);

    const [pendingListed] = await store().listActions({ limit: 10 });
    expect(pendingListed).toEqual(action);

    await store().recordActionOutcome(action.id, {
      state: "executed",
      executedAt: BASE_TIME + 1_000,
    });
    const [executedListed] = await store().listActions({ limit: 10 });
    expect(executedListed).toEqual({ ...action, state: "executed", executedAt: BASE_TIME + 1_000 });
  });

  it("creates a pending action, then transitions it to failed with a failure reason", async () => {
    const action = makeAction({ id: "01900000-0000-7000-8000-000000000011" });
    await store().createAction(action);

    await store().recordActionOutcome(action.id, {
      state: "failed",
      failure: "restart command exited 1",
    });
    const [listed] = await store().listActions({ limit: 10 });
    expect(listed).toEqual({ ...action, state: "failed", failure: "restart command exited 1" });
  });

  it("creates a pending action, then transitions it to rejected with a failure reason", async () => {
    const action = makeAction({ id: "01900000-0000-7000-8000-000000000012", kind: "quarantine" });
    await store().createAction(action);

    await store().recordActionOutcome(action.id, {
      state: "rejected",
      failure: "recovery action kind 'quarantine' has no adapter in this revision",
    });
    const [listed] = await store().listActions({ limit: 10 });
    expect(listed?.state).toBe("rejected");
    expect(listed?.failure).toBe(
      "recovery action kind 'quarantine' has no adapter in this revision",
    );
  });

  it("rejects recordActionOutcome for an unknown action id", async () => {
    await expect(
      store().recordActionOutcome("01900000-0000-7000-8000-000000000099", { state: "executed" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("recovery store: listActions filtering and ordering", () => {
  beforeEach(async () => {
    await store().createGrant(makeGrant());
  });

  it("filters by target and orders newest-first by createdAt then id", async () => {
    const first = makeAction({
      id: "01900000-0000-7000-8000-000000000021",
      target: "primary-daemon",
      createdAt: BASE_TIME,
    });
    const second = makeAction({
      id: "01900000-0000-7000-8000-000000000022",
      target: "primary-daemon",
      createdAt: BASE_TIME + 1_000,
    });
    const otherTarget = makeAction({
      id: "01900000-0000-7000-8000-000000000023",
      target: "sandbox-7",
      createdAt: BASE_TIME + 2_000,
    });
    await store().createAction(first);
    await store().createAction(second);
    await store().createAction(otherTarget);

    const primaryOnly = await store().listActions({ target: "primary-daemon", limit: 10 });
    expect(primaryOnly.map((action) => action.id)).toEqual([second.id, first.id]);

    const everything = await store().listActions({ limit: 10 });
    expect(everything.map((action) => action.id)).toEqual([otherTarget.id, second.id, first.id]);
  });

  it("paginates with an exclusive action-id cursor", async () => {
    const ids = [
      "01900000-0000-7000-8000-000000000031",
      "01900000-0000-7000-8000-000000000032",
      "01900000-0000-7000-8000-000000000033",
    ];
    for (const [index, id] of ids.entries()) {
      await store().createAction(makeAction({ id, createdAt: BASE_TIME + index * 1_000 }));
    }

    const firstPage = await store().listActions({ limit: 2 });
    expect(firstPage.map((action) => action.id)).toEqual([ids[2], ids[1]]);

    const secondPage = await store().listActions({
      limit: 2,
      ...(firstPage[1] === undefined ? {} : { before: firstPage[1].id }),
    });
    expect(secondPage.map((action) => action.id)).toEqual([ids[0]]);
  });
});

describe("recovery store: durability", () => {
  it("survives closing and reopening the same database file", async () => {
    const temp = await TemporarySqliteDatabase.create("host", clock);
    let database: ManagedSqliteDatabase = temp.database;
    let reopened: ManagedSqliteDatabase | undefined;
    try {
      const grant = makeGrant();
      const action = makeAction();
      const originalStore = createSqliteRecoveryStore({ database });
      await originalStore.createGrant(grant);
      await originalStore.createAction(action);
      await originalStore.recordActionOutcome(action.id, {
        state: "executed",
        executedAt: BASE_TIME + 1_000,
      });

      await database.close();
      database = await openHostDatabase({ path: temp.path, clock });
      reopened = database;

      const reopenedStore = createSqliteRecoveryStore({ database });
      await expect(reopenedStore.getGrant(grant.id)).resolves.toEqual(grant);
      const [listed] = await reopenedStore.listActions({ limit: 10 });
      expect(listed).toEqual({ ...action, state: "executed", executedAt: BASE_TIME + 1_000 });
    } finally {
      if (reopened !== undefined) {
        await reopened.close();
      }
      await temp.dispose();
    }
  });
});
