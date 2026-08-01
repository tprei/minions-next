import { createSupervisorHostRegistry, HostRegistryError } from "@minions/adapters";
import { hostId, timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

/**
 * SSH host revocation security tests (PR 59 — adversarial-security-synthetics,
 * SECURITY_SCENARIOS syntheticId 13, boundary `ssh_revocation`,
 * expectedDenialCode `host_revoked`).
 *
 * syntheticId 14 ("changed host key rejected") is covered by
 * `test/unit/adapters/ssh-adapter.test.ts`'s `host_key_mismatch` suite. This file
 * covers syntheticId 13 ("revoked SSH host rejected") against the real supervisor
 * registry (PR 53's `RegisterSshHost`/`RemoveHost` RPCs and
 * `SupervisorHostRegistry.requireActive`): once a host is removed, `requireActive`
 * — the guard every future connection-dispatch path must call before reaching a
 * host — fails closed with `host_revoked`, never silently permitting reuse of a
 * still-matching key. Real SSH bootstrap/ControlMaster/tunnel dispatch needs a real
 * remote host to build and exercise, and is out of scope for this synthetic.
 */
const CLOCK = new FixedClock(timestampFromEpochMilliseconds(1_735_689_600_000));
const REGISTERED_AT = timestampFromEpochMilliseconds(1_735_689_600_000);
const REMOVED_AT = timestampFromEpochMilliseconds(1_735_689_700_000);
const KNOWN_HOST_KEY = "c".repeat(64);
const HOST_ID_A = hostId("018f3a2e-4a20-7b90-8123-abcdef1234c1");
const HOST_ID_B = hostId("018f3a2e-4a20-7b90-8123-abcdef1234c2");

describe("ssh revocation: revoked SSH host rejected (host_revoked)", () => {
  it("a removed host fails requireActive with host_revoked — a matching key no longer suffices", async () => {
    const temporary = await TemporarySqliteDatabase.create("supervisor", CLOCK);
    try {
      const registry = createSupervisorHostRegistry({ database: temporary.database });
      const id = HOST_ID_A;
      await registry.registerSsh({
        id,
        displayName: "trusted-builder",
        hostname: "builder.internal",
        port: 22,
        username: "minions",
        knownHostKeyFingerprint: KNOWN_HOST_KEY,
        registeredAt: REGISTERED_AT,
      });

      // Still-active: the same key that authorized registration still authorizes use.
      expect(registry.requireActive(id).state).toBe("pending");

      await registry.remove(id, REMOVED_AT);

      // Revoked: requireActive fails closed with host_revoked, not host_not_found —
      // this is a distinct, deliberate denial, not the host silently vanishing.
      try {
        registry.requireActive(id);
        expect.unreachable("requireActive must reject a revoked host");
      } catch (error) {
        expect(error).toBeInstanceOf(HostRegistryError);
        expect((error as InstanceType<typeof HostRegistryError>).code).toBe("host_revoked");
      }
    } finally {
      await temporary.dispose();
    }
  });

  it("revocation is durable — every subsequent requireActive call keeps rejecting", async () => {
    const temporary = await TemporarySqliteDatabase.create("supervisor", CLOCK);
    try {
      const registry = createSupervisorHostRegistry({ database: temporary.database });
      const id = HOST_ID_B;
      await registry.registerSsh({
        id,
        displayName: "trusted-builder",
        hostname: "builder.internal",
        port: 22,
        username: "minions",
        knownHostKeyFingerprint: KNOWN_HOST_KEY,
        registeredAt: REGISTERED_AT,
      });
      await registry.remove(id, REMOVED_AT);

      for (let i = 0; i < 3; i += 1) {
        expect(() => registry.requireActive(id)).toThrow(
          expect.objectContaining({ code: "host_revoked" }),
        );
      }
    } finally {
      await temporary.dispose();
    }
  });
});
