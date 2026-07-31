import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
} from "@connectrpc/connect";
import { PairingService } from "@minions/contracts";
import { describe, expect, it } from "vitest";

import {
  createDeviceSessionStore,
  createRemoteAccessInterceptor,
  registerPairingService,
  type DeviceSessionStore,
  type RemoteAccessPolicy,
} from "@minions/daemon";

/**
 * Remote-access interceptor tests (PR 57 — private-phone-pairing, REMOTE-01/REMOTE-02).
 *
 * Trust derives from the LISTENER, not the peer address: `server.ts` attaches this
 * interceptor to the remote (phone) listener ONLY, so it ALWAYS enforces the phone
 * policy + device-session auth for every request that reaches it — there is no loopback
 * short-circuit. These tests exercise the real `createRemoteAccessInterceptor` factory
 * wired in front of the real `registerPairingService` via `createRouterTransport` — real
 * interceptor composition and dispatch against a real, already-covered service, not a
 * hand-rolled fake. (Connect `ContextValues` are never transmitted over the wire, so the
 * only way to prove the interceptor's enforcement is to call it directly.)
 *
 * All tests target `PairingService.ListDevices` — real `minions.v1.PairingService/...`
 * method-name strings — because it is the one PairingService RPC with no auth requirement
 * baked into the handler itself (`RevokeDevice` calls `sessionStore.authenticate`
 * unconditionally, real `Date.now()`, regardless of caller). Varying the test policy's
 * required scope for `ListDevices` exercises every interceptor decision in isolation.
 */
const LIST_DEVICES = "minions.v1.PairingService/ListDevices";
const FIXED_NOW = 1_000_000;

function harness(options?: { policy?: RemoteAccessPolicy; now?: number }) {
  const sessionStore = createDeviceSessionStore();
  const policy = options?.policy ?? new Map([[LIST_DEVICES, "read_only" as const]]);
  const now = options?.now ?? FIXED_NOW;
  const transport = createRouterTransport(
    (router) => {
      registerPairingService(router, { sessionStore });
    },
    {
      router: {
        interceptors: [createRemoteAccessInterceptor({ sessionStore, policy, now: () => now })],
      },
    },
  );
  const client = createClient(PairingService, transport);
  return { client, sessionStore };
}

/** Creates a session as of `FIXED_NOW` (the harness's default interceptor clock). */
function activeSession(sessionStore: DeviceSessionStore, scope: "control" | "read_only") {
  return sessionStore.create({ deviceLabel: "phone", scope, now: FIXED_NOW, ttlMs: 60_000 });
}

function sessionHeaders(session: { sessionToken: string; csrfToken: string }): HeadersInit {
  return {
    Cookie: `minions_device_session=${session.sessionToken}`,
    "X-Minions-Csrf-Token": session.csrfToken,
  };
}

async function expectPermissionDenied(
  promise: Promise<unknown>,
  messageContains?: string,
): Promise<void> {
  const caught: unknown = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(ConnectError);
  const error = caught as ConnectError;
  expect(error.code).toBe(Code.PermissionDenied);
  if (messageContains !== undefined) {
    expect(error.message).toContain(messageContains);
  }
}

describe("createRemoteAccessInterceptor", () => {
  it("always enforces: rejects an RPC absent from the policy, fail-closed", async () => {
    const { client } = harness({ policy: new Map() });
    await expectPermissionDenied(client.listDevices({}), "not reachable from a remote caller");
  });

  it("rejects a caller with no session cookie for an RPC in the policy", async () => {
    const { client } = harness();
    await expectPermissionDenied(client.listDevices({}), "no device session cookie");
  });

  it("admits a caller with a read_only session for a read_only-policy RPC", async () => {
    const { client, sessionStore } = harness();
    const session = activeSession(sessionStore, "read_only");
    await expect(
      client.listDevices({}, { headers: sessionHeaders(session) }),
    ).resolves.toMatchObject({});
  });

  it("rejects a read_only session against a control-policy RPC", async () => {
    const { client, sessionStore } = harness({
      policy: new Map([[LIST_DEVICES, "control"]]),
    });
    const session = activeSession(sessionStore, "read_only");
    await expectPermissionDenied(
      client.listDevices({}, { headers: sessionHeaders(session) }),
      "requires a control session",
    );
  });

  it("admits a control session against a control-policy RPC", async () => {
    const { client, sessionStore } = harness({
      policy: new Map([[LIST_DEVICES, "control"]]),
    });
    const session = activeSession(sessionStore, "control");
    await expect(
      client.listDevices({}, { headers: sessionHeaders(session) }),
    ).resolves.toMatchObject({});
  });

  it("admits a control session against a read_only-policy RPC (control satisfies read_only)", async () => {
    const { client, sessionStore } = harness();
    const session = activeSession(sessionStore, "control");
    await expect(
      client.listDevices({}, { headers: sessionHeaders(session) }),
    ).resolves.toMatchObject({});
  });

  it("rejects an expired session", async () => {
    const { client, sessionStore } = harness();
    // Created and immediately expired relative to the harness's FIXED_NOW interceptor
    // clock: ttlMs 0 means expiresAt === FIXED_NOW, and the check is `now >= expiresAt`.
    const session = sessionStore.create({
      deviceLabel: "phone",
      scope: "read_only",
      now: FIXED_NOW,
      ttlMs: 0,
    });
    await expectPermissionDenied(
      client.listDevices({}, { headers: sessionHeaders(session) }),
      "expired",
    );
  });

  it("rejects a session whose CSRF header does not match", async () => {
    const { client, sessionStore } = harness();
    const session = activeSession(sessionStore, "read_only");
    await expectPermissionDenied(
      client.listDevices(
        {},
        {
          headers: {
            Cookie: `minions_device_session=${session.sessionToken}`,
            "X-Minions-Csrf-Token": "wrong",
          },
        },
      ),
      "CSRF",
    );
  });

  it("rejects a revoked session", async () => {
    const { client, sessionStore } = harness();
    const session = activeSession(sessionStore, "read_only");
    sessionStore.revoke(session.session.sessionId);
    await expectPermissionDenied(
      client.listDevices({}, { headers: sessionHeaders(session) }),
      "unknown or revoked",
    );
  });
});
