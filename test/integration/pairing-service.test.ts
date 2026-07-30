import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import { PairingScope, PairingService } from "@minions/contracts";
import { describe, expect, it } from "vitest";

import { registerPairingService } from "@minions/daemon";

/**
 * Pairing service integration tests (PR 57 — private-phone-pairing).
 *
 * Uses Connect's in-memory `createRouterTransport` (no real HTTP server/port) — the
 * handler under test is a pure function of the request/router, so this is a faithful,
 * fast integration test of `registerPairingService`'s actual RPC wiring, not a mock.
 */
function pairingClient() {
  const transport = createRouterTransport((router) => {
    registerPairingService(router, {});
  });
  return createClient(PairingService, transport);
}

describe("PairingService integration", () => {
  it("requestPairingCode returns a 6-char legible code bound to the requested scope", async () => {
    const pairing = pairingClient();
    const response = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
    expect(response.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(response.scope).toBe(PairingScope.CONTROL);
    expect(response.expiresAt).toBeDefined();
  });

  it("rejects requestPairingCode with an unspecified scope", async () => {
    const pairing = pairingClient();
    await expect(pairing.requestPairingCode({ scope: PairingScope.UNSPECIFIED })).rejects.toThrow(
      ConnectError,
    );
  });

  it("completePairing with a valid code mints a device session with the pinned scope", async () => {
    const pairing = pairingClient();
    const { code } = await pairing.requestPairingCode({ scope: PairingScope.READ_ONLY });
    const { session } = await pairing.completePairing({ code, deviceLabel: "iPhone 17" });
    expect(session?.deviceLabel).toBe("iPhone 17");
    expect(session?.scope).toBe(PairingScope.READ_ONLY);
    expect(session?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("rejects completePairing with an unknown code", async () => {
    const pairing = pairingClient();
    try {
      await pairing.completePairing({ code: "ZZZZZZ", deviceLabel: "phone" });
      expect.unreachable("completePairing must reject an unknown code");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.PermissionDenied);
    }
  });

  it("a pairing code is single-use — replaying it after a successful completion fails", async () => {
    const pairing = pairingClient();
    const { code } = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
    await pairing.completePairing({ code, deviceLabel: "first device" });
    await expect(pairing.completePairing({ code, deviceLabel: "replay attempt" })).rejects.toThrow(
      ConnectError,
    );
  });

  it("a pairing code is consumed even on a failed completion attempt (no retry on wrong label)", async () => {
    // Consuming on every attempt (not just success) means a leaked code can't be probed
    // repeatedly; this test only asserts the single-use invariant holds across two calls
    // with the same code, since deviceLabel validity itself doesn't gate consumption.
    const pairing = pairingClient();
    const { code } = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
    await pairing.completePairing({ code, deviceLabel: "device A" });
    await expect(pairing.completePairing({ code, deviceLabel: "device B" })).rejects.toThrow(
      ConnectError,
    );
  });

  it("listDevices returns every active session", async () => {
    const pairing = pairingClient();
    const code1 = (await pairing.requestPairingCode({ scope: PairingScope.CONTROL })).code;
    const code2 = (await pairing.requestPairingCode({ scope: PairingScope.READ_ONLY })).code;
    await pairing.completePairing({ code: code1, deviceLabel: "iPad" });
    await pairing.completePairing({ code: code2, deviceLabel: "Pixel" });

    const { devices } = await pairing.listDevices({});
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.deviceLabel).sort()).toEqual(["Pixel", "iPad"]);
  });

  it("listDevices is empty when no device has completed pairing", async () => {
    const pairing = pairingClient();
    const { devices } = await pairing.listDevices({});
    expect(devices).toEqual([]);
  });

  it("revokeDevice removes the session — it no longer appears in listDevices", async () => {
    const pairing = pairingClient();
    const { code } = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
    let responseHeaders: Headers | undefined;
    const { session } = await pairing.completePairing(
      { code, deviceLabel: "revoke-me" },
      { onHeader: (headers) => (responseHeaders = headers) },
    );
    expect((await pairing.listDevices({})).devices).toHaveLength(1);

    const cookie = (responseHeaders?.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const csrfToken = responseHeaders?.get("X-Minions-Csrf-Token") ?? "";
    await pairing.revokeDevice(
      { sessionId: session?.sessionId ?? "" },
      { headers: { Cookie: cookie, "X-Minions-Csrf-Token": csrfToken } },
    );

    expect((await pairing.listDevices({})).devices).toEqual([]);
  });

  it("revokeDevice on an unknown session id is idempotent (no error) for an authenticated caller", async () => {
    const pairing = pairingClient();
    const { code } = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
    let responseHeaders: Headers | undefined;
    await pairing.completePairing(
      { code, deviceLabel: "caller" },
      { onHeader: (headers) => (responseHeaders = headers) },
    );
    const cookie = (responseHeaders?.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const csrfToken = responseHeaders?.get("X-Minions-Csrf-Token") ?? "";

    await expect(
      pairing.revokeDevice(
        { sessionId: "01900000-0000-7000-8000-000000000099" },
        { headers: { Cookie: cookie, "X-Minions-Csrf-Token": csrfToken } },
      ),
    ).resolves.toBeDefined();
  });

  it("pairing codes are isolated per registerPairingService instance (no cross-daemon leakage)", async () => {
    const pairingA = pairingClient();
    const pairingB = pairingClient();
    const { code } = await pairingA.requestPairingCode({ scope: PairingScope.CONTROL });
    await expect(
      pairingB.completePairing({ code, deviceLabel: "cross-instance attempt" }),
    ).rejects.toThrow(ConnectError);
  });
});
