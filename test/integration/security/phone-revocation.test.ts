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
 * rather than `Code.Unimplemented` stubs.
 */
function pairingClient() {
  const transport = createRouterTransport((router) => {
    registerPairingService(router, {});
  });
  return createClient(PairingService, transport);
}

describe("phone revocation: revoked device session rejected", () => {
  it("a revoked session is gone from the device registry — every subsequent list omits it", async () => {
    const pairing = pairingClient();
    const { code } = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
    const { session } = await pairing.completePairing({ code, deviceLabel: "attacker-phone" });
    const sessionId = session?.sessionId ?? "";
    expect((await pairing.listDevices({})).devices.map((d) => d.sessionId)).toContain(sessionId);

    await pairing.revokeDevice({ sessionId });

    // Not a transient effect — every subsequent read confirms the session stays gone.
    for (let i = 0; i < 3; i += 1) {
      const { devices } = await pairing.listDevices({});
      expect(devices.map((d) => d.sessionId)).not.toContain(sessionId);
    }
  });

  it("revoking one device session never affects a different device's session", async () => {
    const pairing = pairingClient();
    const codeA = (await pairing.requestPairingCode({ scope: PairingScope.CONTROL })).code;
    const codeB = (await pairing.requestPairingCode({ scope: PairingScope.READ_ONLY })).code;
    const sessionA = (await pairing.completePairing({ code: codeA, deviceLabel: "device A" }))
      .session;
    const sessionB = (await pairing.completePairing({ code: codeB, deviceLabel: "device B" }))
      .session;

    await pairing.revokeDevice({ sessionId: sessionA?.sessionId ?? "" });

    const { devices } = await pairing.listDevices({});
    expect(devices).toHaveLength(1);
    expect(devices[0]?.sessionId).toBe(sessionB?.sessionId);
    expect(devices[0]?.deviceLabel).toBe("device B");
  });

  it("a device cannot re-pair using its own revoked session id as a pairing code", async () => {
    // Session ids (UUIDs) and pairing codes (6-char legible strings) are disjoint
    // namespaces by construction — a revoked session id is never a valid pairing code.
    const pairing = pairingClient();
    const { code } = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
    const { session } = await pairing.completePairing({ code, deviceLabel: "phone" });
    await pairing.revokeDevice({ sessionId: session?.sessionId ?? "" });

    await expect(
      pairing.completePairing({
        code: session?.sessionId ?? "",
        deviceLabel: "replay via session id",
      }),
    ).rejects.toThrow(ConnectError);
  });
});
