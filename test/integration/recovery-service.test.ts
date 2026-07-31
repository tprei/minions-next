import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { createSqliteRecoveryStore } from "@minions/adapters";
import {
  ElevationGrantState,
  RecoveryActionKind,
  RecoveryActionState,
  RecoveryService,
} from "@minions/contracts";
import {
  timestampFromEpochMilliseconds,
  type Clock,
  type RecoveryGateProfile,
  type RecoveryStore,
} from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerRecoveryService, type RecoveryServiceOptions } from "@minions/daemon";

/**
 * Recovery service integration tests (PR 56 — maintenance-elevation-recovery).
 *
 * Uses Connect's in-memory `createRouterTransport` (see pairing-service.test.ts's doc
 * comment for why this is a faithful integration test, not a mock) against a real,
 * temporary SQLite host database via `createSqliteRecoveryStore` — grants and actions
 * persist for real; only the process-restart side effect (`RecoveryRestarter`) is faked.
 */

const BASE_TIME = 1_700_000_000_000;
const REQUESTER = "0190af1e-7b2d-7c3a-89ab-1234567890ab";
const OTHER_ACTOR = "0290af1e-7b2d-7c3a-89ab-1234567890ab";

const DEFAULT_PROFILE: RecoveryGateProfile = Object.freeze({
  allowedKinds: ["restart"] as const,
  requiredApprovals: 1,
  maxGrantDurationMs: 900_000,
});

function timestampFromMilliseconds(milliseconds: number) {
  const value = BigInt(milliseconds);
  return create(TimestampSchema, {
    seconds: value / 1_000n,
    nanos: Number(value % 1_000n) * 1_000_000,
  });
}

/** A SequenceIdGenerator preloaded with valid UUID-format ids. */
function idPool(count: number): SequenceIdGenerator {
  return new SequenceIdGenerator(
    Array.from({ length: count }, (_, index) => {
      const suffix = index.toString(16).padStart(12, "0").slice(-12);
      return `01900000-0000-7000-8000-${suffix}`;
    }),
  );
}

/** A RecoveryRestarter fake recording every target it was asked to restart. */
function fakeRestarter(failure?: string) {
  const calls: string[] = [];
  return {
    calls,
    restart: (target: string) => {
      calls.push(target);
      if (failure !== undefined) {
        return Promise.reject(new Error(failure));
      }
      return Promise.resolve();
    },
  };
}

let temporary: TemporarySqliteDatabase | undefined;
let recoveryStore: RecoveryStore | undefined;

beforeEach(async () => {
  temporary = await TemporarySqliteDatabase.create(
    "host",
    new FixedClock(timestampFromEpochMilliseconds(BASE_TIME)),
  );
  recoveryStore = createSqliteRecoveryStore({ database: temporary.database });
});

afterEach(async () => {
  const current = temporary;
  temporary = undefined;
  recoveryStore = undefined;
  if (current !== undefined) {
    await current.dispose();
  }
});

function store(): RecoveryStore {
  if (recoveryStore === undefined) {
    throw new Error("recovery store is not initialized");
  }
  return recoveryStore;
}

function recoveryClient(
  overrides: Partial<{
    gateProfile: RecoveryGateProfile;
    clock: Clock;
    ids: SequenceIdGenerator;
    restart: RecoveryServiceOptions["restart"];
    primaryTarget: string;
  }> = {},
) {
  const options: RecoveryServiceOptions = {
    store: store(),
    gateProfile: overrides.gateProfile ?? DEFAULT_PROFILE,
    clock: overrides.clock ?? new FixedClock(timestampFromEpochMilliseconds(BASE_TIME)),
    ids: overrides.ids ?? idPool(10),
    restart: overrides.restart ?? fakeRestarter(),
    ...(overrides.primaryTarget === undefined ? {} : { primaryTarget: overrides.primaryTarget }),
  };
  const transport = createRouterTransport((router) => {
    registerRecoveryService(router, options);
  });
  return createClient(RecoveryService, transport);
}

function restartRequest(overrides: Partial<{ target: string; actorSessionId: string }> = {}) {
  return {
    kind: RecoveryActionKind.RESTART,
    target: overrides.target ?? "primary-daemon",
    expectedState: "running",
    expiresAt: timestampFromMilliseconds(BASE_TIME + 60_000),
  };
}

// -------------------------------------------------------------------------------------------------
// Tests.
// -------------------------------------------------------------------------------------------------

describe("RecoveryService: successful restart end-to-end", () => {
  it("requests elevation, executes a restart, and consumes the grant", async () => {
    const restarter = fakeRestarter();
    const client = recoveryClient({ restart: restarter });

    const { grant } = await client.requestElevation({
      requestedBySessionId: REQUESTER,
      requestedKinds: [RecoveryActionKind.RESTART],
      justification: "investigating a stuck sandbox",
    });
    expect(grant?.state).toBe(ElevationGrantState.APPROVED);
    expect(grant?.approvalsReceived).toBe(1);
    expect(grant?.authorizedKinds).toEqual([RecoveryActionKind.RESTART]);

    const { action } = await client.executeRecoveryAction({
      grantId: grant?.id ?? "",
      actorSessionId: REQUESTER,
      action: restartRequest(),
    });
    expect(action?.state).toBe(RecoveryActionState.EXECUTED);
    expect(action?.executedAt).toBeDefined();
    expect(action?.failure).toBeUndefined();
    expect(restarter.calls).toEqual(["primary-daemon"]);

    const grantAfter = await store().getGrant(grant?.id ?? "");
    expect(grantAfter?.state).toBe("consumed");
  });

  it("records a failed outcome when the restarter throws, without consuming the grant", async () => {
    const restarter = fakeRestarter("systemctl restart failed: exit code 1");
    const client = recoveryClient({ restart: restarter });

    const { grant } = await client.requestElevation({
      requestedBySessionId: REQUESTER,
      requestedKinds: [RecoveryActionKind.RESTART],
      justification: "investigating a stuck sandbox",
    });

    const { action } = await client.executeRecoveryAction({
      grantId: grant?.id ?? "",
      actorSessionId: REQUESTER,
      action: restartRequest(),
    });
    expect(action?.state).toBe(RecoveryActionState.FAILED);
    expect(action?.failure).toBe("systemctl restart failed: exit code 1");

    const grantAfter = await store().getGrant(grant?.id ?? "");
    expect(grantAfter?.state).toBe("approved");
  });
});

describe("RecoveryService: wrong-target rejection", () => {
  it("rejects a restart against a target that is not the configured primary, without throwing", async () => {
    const restarter = fakeRestarter();
    const client = recoveryClient({ restart: restarter });
    const { grant } = await client.requestElevation({
      requestedBySessionId: REQUESTER,
      requestedKinds: [RecoveryActionKind.RESTART],
      justification: "investigating a stuck sandbox",
    });

    const { action } = await client.executeRecoveryAction({
      grantId: grant?.id ?? "",
      actorSessionId: REQUESTER,
      action: restartRequest({ target: "some-other-host" }),
    });
    expect(action?.state).toBe(RecoveryActionState.REJECTED);
    expect(action?.failure).toMatch(/does not match/i);
    expect(restarter.calls).toEqual([]);

    const grantAfter = await store().getGrant(grant?.id ?? "");
    expect(grantAfter?.state).toBe("approved");
  });
});

describe("RecoveryService: unapproved-grant rejection", () => {
  it("rejects execution against a still-pending grant under a multi-approval profile", async () => {
    const twoApprovalProfile: RecoveryGateProfile = {
      ...DEFAULT_PROFILE,
      requiredApprovals: 2,
    };
    const client = recoveryClient({ gateProfile: twoApprovalProfile });
    const { grant } = await client.requestElevation({
      requestedBySessionId: REQUESTER,
      requestedKinds: [RecoveryActionKind.RESTART],
      justification: "investigating a stuck sandbox",
    });
    expect(grant?.state).toBe(ElevationGrantState.PENDING);
    expect(grant?.approvalsReceived).toBe(1);

    await expect(
      client.executeRecoveryAction({
        grantId: grant?.id ?? "",
        actorSessionId: REQUESTER,
        action: restartRequest(),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
});

describe("RecoveryService: expired-grant rejection", () => {
  it("rejects execution against a grant whose expiry has passed", async () => {
    const shortProfile: RecoveryGateProfile = { ...DEFAULT_PROFILE, maxGrantDurationMs: 1_000 };
    const requestClient = recoveryClient({
      gateProfile: shortProfile,
      clock: new FixedClock(timestampFromEpochMilliseconds(BASE_TIME)),
    });
    const { grant } = await requestClient.requestElevation({
      requestedBySessionId: REQUESTER,
      requestedKinds: [RecoveryActionKind.RESTART],
      justification: "investigating a stuck sandbox",
    });

    const laterClient = recoveryClient({
      clock: new FixedClock(timestampFromEpochMilliseconds(BASE_TIME + 5_000)),
    });
    await expect(
      laterClient.executeRecoveryAction({
        grantId: grant?.id ?? "",
        actorSessionId: REQUESTER,
        action: {
          kind: RecoveryActionKind.RESTART,
          target: "primary-daemon",
          expectedState: "running",
          expiresAt: timestampFromMilliseconds(BASE_TIME + 5_000 + 60_000),
        },
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
});

describe("RecoveryService: wrong-actor rejection", () => {
  it("rejects execution from an actor session that does not match the grant", async () => {
    const client = recoveryClient();
    const { grant } = await client.requestElevation({
      requestedBySessionId: REQUESTER,
      requestedKinds: [RecoveryActionKind.RESTART],
      justification: "investigating a stuck sandbox",
    });

    await expect(
      client.executeRecoveryAction({
        grantId: grant?.id ?? "",
        actorSessionId: OTHER_ACTOR,
        action: restartRequest(),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
});

describe("RecoveryService: unimplemented-kind rejection", () => {
  it("rejects an authorized-but-unimplemented kind with a typed receipt, not a thrown error", async () => {
    const quarantineProfile: RecoveryGateProfile = {
      allowedKinds: ["restart", "quarantine"],
      requiredApprovals: 1,
      maxGrantDurationMs: 900_000,
    };
    const client = recoveryClient({ gateProfile: quarantineProfile });
    const { grant } = await client.requestElevation({
      requestedBySessionId: REQUESTER,
      requestedKinds: [RecoveryActionKind.QUARANTINE],
      justification: "quarantining a runaway sandbox",
    });
    expect(grant?.state).toBe(ElevationGrantState.APPROVED);

    const { action } = await client.executeRecoveryAction({
      grantId: grant?.id ?? "",
      actorSessionId: REQUESTER,
      action: {
        kind: RecoveryActionKind.QUARANTINE,
        target: "sandbox-7",
        expectedState: "quarantined",
        expiresAt: timestampFromMilliseconds(BASE_TIME + 60_000),
      },
    });
    expect(action?.state).toBe(RecoveryActionState.REJECTED);
    expect(action?.failure).toMatch(/no adapter/i);
  });
});

describe("RecoveryService: grant not found", () => {
  it("returns Code.NotFound for an unknown grant id", async () => {
    const client = recoveryClient();
    await expect(
      client.executeRecoveryAction({
        grantId: "01900000-0000-7000-8000-0000000000ff",
        actorSessionId: REQUESTER,
        action: restartRequest(),
      }),
    ).rejects.toMatchObject({ code: Code.NotFound });
  });
});

describe("RecoveryService: listRecoveryActions pagination", () => {
  it("returns actions newest-first with a next_page_token exactly when a page is full", async () => {
    const client = recoveryClient();
    const { grant } = await client.requestElevation({
      requestedBySessionId: REQUESTER,
      requestedKinds: [RecoveryActionKind.RESTART],
      justification: "investigating repeated restart attempts",
    });

    // Each attempt targets the wrong host, so it rejects without consuming the grant —
    // three actions accumulate under one grant without three separate elevations.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await client.executeRecoveryAction({
        grantId: grant?.id ?? "",
        actorSessionId: REQUESTER,
        action: restartRequest({ target: "wrong-target" }),
      });
    }

    const firstPage = await client.listRecoveryActions({ pageSize: 2 });
    expect(firstPage.actions).toHaveLength(2);
    expect(firstPage.nextPageToken).toBeTruthy();

    const secondPage = await client.listRecoveryActions({
      pageSize: 2,
      pageToken: firstPage.nextPageToken,
    });
    expect(secondPage.actions).toHaveLength(1);
    expect(secondPage.nextPageToken).toBeFalsy();

    const allIds = [...firstPage.actions, ...secondPage.actions].map((action) => action.id);
    expect(new Set(allIds).size).toBe(3);
  });
});
