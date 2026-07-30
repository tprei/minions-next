import { createClient, createRouterTransport, ConnectError } from "@connectrpc/connect";
import { PairingScope, PairingService } from "@minions/contracts";
import { describe, expect, it } from "vitest";

import { registerPairingService } from "@minions/daemon";

/**
 * Phone revocation security tests (PR 59 — adversarial-security-synthetics,
 * SECURITY_SCENARIOS syntheticId 15-16, boundary `phone_revocation`).
 *
 * syntheticId 16 ("expired pairing code rejected") is already covered by
 * `test/unit/core/pairing.test.ts`'s `isPairingCodeValid` suite — this file covers
 * syntheticId 15 ("revoked device session rejected") against the real daemon RPC wiring
 * (`registerPairingService`, PR 57), now that `RevokeDevice`/`ListDevices` are functional
 * rather than `Code.Unimplemented` stubs, and `RevokeDevice` requires an authenticated
 * control-scope session (HttpOnly cookie + double-submit CSRF token) rather than a bare
 * session_id — see the `pairAsControl` helper for how tests obtain one.
 */
function pairingClient() {
  const transport = createRouterTransport((router) => {
    registerPairingService(router, {});
  });
  return createClient(PairingService, transport);
}

type Authenticated = Readonly<{
  sessionId: string;
  headers: Readonly<{ Cookie: string; "X-Minions-Csrf-Token": string }>;
}>;

/** Completes a CONTROL-scope pairing and returns the caller headers RevokeDevice needs. */
async function pairAsControl(
  pairing: ReturnType<typeof pairingClient>,
  deviceLabel: string,
): Promise<Authenticated> {
  const { code } = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
  let responseHeaders: Headers | undefined;
  const { session } = await pairing.completePairing(
    { code, deviceLabel },
    { onHeader: (headers) => (responseHeaders = headers) },
  );
  const setCookie = responseHeaders?.get("Set-Cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const csrfToken = responseHeaders?.get("X-Minions-Csrf-Token") ?? "";
  return {
    sessionId: session?.sessionId ?? "",
    headers: { Cookie: cookie, "X-Minions-Csrf-Token": csrfToken },
  };
}

describe("phone revocation: revoked device session rejected", () => {
  it("a revoked session is gone from the device registry — every subsequent list omits it", async () => {
    const pairing = pairingClient();
    const attacker = await pairAsControl(pairing, "attacker-phone");
    expect((await pairing.listDevices({})).devices.map((d) => d.sessionId)).toContain(
      attacker.sessionId,
    );

    await pairing.revokeDevice({ sessionId: attacker.sessionId }, { headers: attacker.headers });

    // Not a transient effect — every subsequent read confirms the session stays gone.
    for (let i = 0; i < 3; i += 1) {
      const { devices } = await pairing.listDevices({});
      expect(devices.map((d) => d.sessionId)).not.toContain(attacker.sessionId);
    }
  });

  it("revoking one device session never affects a different device's session", async () => {
    const pairing = pairingClient();
    const deviceA = await pairAsControl(pairing, "device A");
    const { code: codeB } = await pairing.requestPairingCode({ scope: PairingScope.READ_ONLY });
    const { session: sessionB } = await pairing.completePairing({
      code: codeB,
      deviceLabel: "device B",
    });

    await pairing.revokeDevice({ sessionId: deviceA.sessionId }, { headers: deviceA.headers });

    const { devices } = await pairing.listDevices({});
    expect(devices).toHaveLength(1);
    expect(devices[0]?.sessionId).toBe(sessionB?.sessionId);
    expect(devices[0]?.deviceLabel).toBe("device B");
  });

  it("a device cannot re-pair using its own revoked session id as a pairing code", async () => {
    // Session ids (UUIDs) and pairing codes (6-char legible strings) are disjoint
    // namespaces by construction — a revoked session id is never a valid pairing code.
    const pairing = pairingClient();
    const device = await pairAsControl(pairing, "phone");
    await pairing.revokeDevice({ sessionId: device.sessionId }, { headers: device.headers });

    await expect(
      pairing.completePairing({
        code: device.sessionId,
        deviceLabel: "replay via session id",
      }),
    ).rejects.toThrow(ConnectError);
  });

  it("revokeDevice rejects a request with no session cookie", async () => {
    const pairing = pairingClient();
    const device = await pairAsControl(pairing, "phone");
    await expect(pairing.revokeDevice({ sessionId: device.sessionId })).rejects.toThrow(
      ConnectError,
    );
  });

  it("revokeDevice rejects a request with a session cookie but a wrong CSRF token", async () => {
    const pairing = pairingClient();
    const device = await pairAsControl(pairing, "phone");
    await expect(
      pairing.revokeDevice(
        { sessionId: device.sessionId },
        { headers: { Cookie: device.headers.Cookie, "X-Minions-Csrf-Token": "wrong-token" } },
      ),
    ).rejects.toThrow(ConnectError);
  });

  it("revokeDevice rejects a read-only scope session — control is required", async () => {
    const pairing = pairingClient();
    const { code } = await pairing.requestPairingCode({ scope: PairingScope.READ_ONLY });
    let responseHeaders: Headers | undefined;
    const { session } = await pairing.completePairing(
      { code, deviceLabel: "read-only phone" },
      { onHeader: (headers) => (responseHeaders = headers) },
    );
    const cookie = (responseHeaders?.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const csrfToken = responseHeaders?.get("X-Minions-Csrf-Token") ?? "";

    await expect(
      pairing.revokeDevice(
        { sessionId: session?.sessionId ?? "" },
        { headers: { Cookie: cookie, "X-Minions-Csrf-Token": csrfToken } },
      ),
    ).rejects.toThrow(ConnectError);
  });

  it("revokeDevice rejects a cross-origin request even with a valid cookie and CSRF token", async () => {
    const pairing = pairingClient();
    const device = await pairAsControl(pairing, "phone");
    await expect(
      pairing.revokeDevice(
        { sessionId: device.sessionId },
        {
          headers: {
            ...device.headers,
            Origin: "https://evil.example",
            Host: "127.0.0.1:9999",
          },
        },
      ),
    ).rejects.toThrow(ConnectError);
  });
});
