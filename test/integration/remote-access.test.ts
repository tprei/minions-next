import {
  Code,
  ConnectError,
  createClient,
  createContextValues,
  createRouterTransport,
  type Interceptor,
} from "@connectrpc/connect";
import { PairingService } from "@minions/contracts";
import { describe, expect, it } from "vitest";

import {
  createDeviceSessionStore,
  createRemoteAccessInterceptor,
  isLoopbackAddress,
  isLoopbackContextKey,
  registerPairingService,
  type DeviceSessionStore,
  type RemoteAccessPolicy,
} from "@minions/daemon";

/**
 * Remote-access interceptor tests (PR 57 — private-phone-pairing, REMOTE-01/REMOTE-02).
 *
 * `isLoopbackAddress` tests are pure-function unit tests. The interceptor tests below
 * exercise the actual `createRemoteAccessInterceptor` factory wired in front of the real
 * `registerPairingService` via `createRouterTransport` — real interceptor composition and
 * dispatch against a real, already-covered service, not a hand-rolled fake. Connect's
 * `ContextValues` are never transmitted over the wire (by design — a remote caller must
 * never be able to claim its own trust level), so `createRouterTransport` has no
 * client-to-server hook for them the way `connectNodeAdapter({ contextValues })` does in
 * production; `withLoopbackContext` below is a tiny outermost test interceptor that
 * injects the value directly, standing in for that hook (itself a thin,
 * directly-inspectable wrapper around `isLoopbackAddress`, unit-tested above).
 *
 * All tests target `PairingService.ListDevices` — real `minions.v1.PairingService/...`
 * method-name strings, exercised the same way `PHONE_REMOTE_ACCESS_POLICY` builds its own
 * keys — because it is the one PairingService RPC with no auth requirement baked into the
 * handler itself (`RevokeDevice` calls `sessionStore.authenticate` unconditionally, real
 * `Date.now()`, regardless of caller; using it here would test that pre-existing check
 * instead of this interceptor). Varying the test policy's required scope for
 * `ListDevices` exercises every interceptor decision in isolation.
 */
describe("isLoopbackAddress", () => {
  it("accepts IPv4 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  it("accepts IPv6 loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  it("accepts the IPv4-mapped-IPv6 form of loopback", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects a private (non-loopback) LAN address", () => {
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
  });

  it("rejects a Tailscale CGNAT-range address", () => {
    expect(isLoopbackAddress("100.64.1.5")).toBe(false);
  });

  it("fails closed on an undefined remote address", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

const LIST_DEVICES = "minions.v1.PairingService/ListDevices";
const FIXED_NOW = 1_000_000;

/** Outermost test interceptor standing in for `connectNodeAdapter`'s `contextValues`
 * hook — see the file doc comment for why `createRouterTransport` needs this. */
function withLoopbackContext(isLoopback: boolean): Interceptor {
  return (next) => (request) =>
    next({
      ...request,
      contextValues: createContextValues().set(isLoopbackContextKey, isLoopback),
    });
}

function harness(options?: { policy?: RemoteAccessPolicy; now?: number; isLoopback?: boolean }) {
  const sessionStore = createDeviceSessionStore();
  const policy = options?.policy ?? new Map([[LIST_DEVICES, "read_only" as const]]);
  const now = options?.now ?? FIXED_NOW;
  const isLoopback = options?.isLoopback ?? false;
  const transport = createRouterTransport(
    (router) => {
      registerPairingService(router, { sessionStore });
    },
    {
      router: {
        interceptors: [
          withLoopbackContext(isLoopback),
          createRemoteAccessInterceptor({ sessionStore, policy, now: () => now }),
        ],
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
  it("passes a loopback caller through untouched, even for a method absent from the policy", async () => {
    const { client } = harness({ policy: new Map(), isLoopback: true });
    await expect(client.listDevices({})).resolves.toMatchObject({ devices: [] });
  });

  it("rejects a non-loopback caller for an RPC absent from the policy, fail-closed", async () => {
    const { client } = harness({ policy: new Map(), isLoopback: false });
    await expectPermissionDenied(
      client.listDevices({}),
      "not reachable from a non-loopback caller",
    );
  });

  it("rejects a non-loopback caller with no session cookie for an RPC in the policy", async () => {
    const { client } = harness({ isLoopback: false });
    await expectPermissionDenied(client.listDevices({}), "no device session cookie");
  });

  it("admits a non-loopback caller with a read_only session for a read_only-policy RPC", async () => {
    const { client, sessionStore } = harness({ isLoopback: false });
    const session = activeSession(sessionStore, "read_only");
    await expect(
      client.listDevices({}, { headers: sessionHeaders(session) }),
    ).resolves.toMatchObject({});
  });

  it("rejects a non-loopback read_only session against a control-policy RPC", async () => {
    const { client, sessionStore } = harness({
      policy: new Map([[LIST_DEVICES, "control"]]),
      isLoopback: false,
    });
    const session = activeSession(sessionStore, "read_only");
    await expectPermissionDenied(
      client.listDevices({}, { headers: sessionHeaders(session) }),
      "requires a control session",
    );
  });

  it("admits a non-loopback control session against a control-policy RPC", async () => {
    const { client, sessionStore } = harness({
      policy: new Map([[LIST_DEVICES, "control"]]),
      isLoopback: false,
    });
    const session = activeSession(sessionStore, "control");
    await expect(
      client.listDevices({}, { headers: sessionHeaders(session) }),
    ).resolves.toMatchObject({});
  });

  it("admits a non-loopback control session against a read_only-policy RPC (control satisfies read_only)", async () => {
    const { client, sessionStore } = harness({ isLoopback: false });
    const session = activeSession(sessionStore, "control");
    await expect(
      client.listDevices({}, { headers: sessionHeaders(session) }),
    ).resolves.toMatchObject({});
  });

  it("rejects an expired non-loopback session", async () => {
    const { client, sessionStore } = harness({ isLoopback: false });
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

  it("rejects a non-loopback session whose CSRF header does not match", async () => {
    const { client, sessionStore } = harness({ isLoopback: false });
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

  it("rejects a revoked non-loopback session", async () => {
    const { client, sessionStore } = harness({ isLoopback: false });
    const session = activeSession(sessionStore, "read_only");
    sessionStore.revoke(session.session.sessionId);
    await expectPermissionDenied(
      client.listDevices({}, { headers: sessionHeaders(session) }),
      "unknown or revoked",
    );
  });
});
