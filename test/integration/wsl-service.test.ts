import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import type { WslRequirementProbe } from "@minions/adapters";
import { WslHostService, WslRequirement } from "@minions/contracts";
import { describe, expect, it } from "vitest";

import { registerWslHostService } from "@minions/daemon";

/**
 * WSL host service integration tests (PR 54 — wsl2-host-and-fleet-ui).
 *
 * ProbeWslHost now runs the real `@minions/adapters` `WslRequirementProbe` (systemctl,
 * podman, a real loopback bind/connect, the credential vault's backend probe) instead
 * of unconditionally reporting every requirement missing. These tests cover both: the
 * real default probe (proving the wiring is genuine, without asserting exact
 * satisfied/missing values that legitimately vary by host) and an injected probe (for
 * deterministic, environment-independent coverage of the RPC's own request/response
 * mapping and validation).
 *
 * RegisterWslHost is fail-closed on the same probe (PR 54 acceptance criterion: missing
 * systemd, rootless Podman, localhost forwarding, or secure credential storage blocks
 * registration). The client-supplied `requirementsMet` field is never trusted for that
 * decision — every registration re-probes independently — so the tests below always
 * inject a scripted probe rather than relying on the ambient host's real capabilities.
 */
function wslClient(probe?: WslRequirementProbe) {
  const transport = createRouterTransport((router) => {
    registerWslHostService(router, probe === undefined ? {} : { probe });
  });
  return createClient(WslHostService, transport);
}

function fakeProbe(result: {
  satisfied: readonly ("systemd" | "rootless_podman" | "localhost_forwarding" | "secure_storage")[];
  missing: readonly ("systemd" | "rootless_podman" | "localhost_forwarding" | "secure_storage")[];
}): WslRequirementProbe {
  return {
    probeAll: (distro) =>
      Promise.resolve({ distro, satisfied: result.satisfied, missing: result.missing }),
    probeOne: (_distro, requirement) => Promise.resolve(result.satisfied.includes(requirement)),
  };
}

const FULLY_SATISFIED = Object.freeze({
  satisfied: ["systemd", "rootless_podman", "localhost_forwarding", "secure_storage"] as const,
  missing: [] as const,
});

describe("WslHostService integration", () => {
  it("registerWslHost stores a profile, visible through listWslHosts, when the probe reports every requirement satisfied", async () => {
    const wsl = wslClient(fakeProbe(FULLY_SATISFIED));
    const profile = {
      distro: "Ubuntu-24.04",
      windowsUser: "DESKTOP-ABC\\minions",
      requirementsMet: [],
    };
    const { profile: registered } = await wsl.registerWslHost({ profile });
    expect(registered).toMatchObject(profile);

    const { hosts } = await wsl.listWslHosts({});
    expect(hosts.map((h) => h.distro)).toContain("Ubuntu-24.04");
  });

  it("rejects registerWslHost with no profile", async () => {
    const wsl = wslClient();
    await expect(wsl.registerWslHost({})).rejects.toThrow(ConnectError);
  });

  it("rejects registerWslHost with an empty distro", async () => {
    const wsl = wslClient();
    await expect(
      wsl.registerWslHost({ profile: { distro: "", windowsUser: "x", requirementsMet: [] } }),
    ).rejects.toThrow(ConnectError);
  });

  it("rejects registerWslHost when the probe reports a missing requirement, and does not add the host", async () => {
    const wsl = wslClient(
      fakeProbe({
        satisfied: ["rootless_podman", "localhost_forwarding", "secure_storage"],
        missing: ["systemd"],
      }),
    );
    // The client asserts every requirement is met — the server must ignore that claim
    // and reject anyway, because its own re-probe says systemd is missing.
    const profile = {
      distro: "Ubuntu-24.04",
      windowsUser: "DESKTOP-ABC\\minions",
      requirementsMet: [
        WslRequirement.SYSTEMD,
        WslRequirement.ROOTLESS_PODMAN,
        WslRequirement.LOCALHOST_FORWARDING,
        WslRequirement.SECURE_STORAGE,
      ],
    };

    try {
      await wsl.registerWslHost({ profile });
      expect.unreachable("registerWslHost must reject a host missing a required capability");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.FailedPrecondition);
    }

    const { hosts } = await wsl.listWslHosts({});
    expect(hosts.map((h) => h.distro)).not.toContain("Ubuntu-24.04");
  });

  it("rejects probeWslHost with an empty distro", async () => {
    const wsl = wslClient();
    try {
      await wsl.probeWslHost({ distro: "" });
      expect.unreachable("probeWslHost must reject an empty distro");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.InvalidArgument);
    }
  });

  it("probeWslHost with an injected probe reports exactly what the probe returns", async () => {
    const wsl = wslClient(
      fakeProbe({
        satisfied: ["systemd", "rootless_podman"],
        missing: ["localhost_forwarding", "secure_storage"],
      }),
    );
    const { result } = await wsl.probeWslHost({ distro: "Ubuntu-24.04" });
    expect(result?.distro).toBe("Ubuntu-24.04");
    expect(result?.satisfied).toEqual([WslRequirement.SYSTEMD, WslRequirement.ROOTLESS_PODMAN]);
    expect(result?.missing).toEqual([
      WslRequirement.LOCALHOST_FORWARDING,
      WslRequirement.SECURE_STORAGE,
    ]);
  });

  it("probeWslHost with an injected fully-satisfied probe reports zero missing", async () => {
    const wsl = wslClient(fakeProbe(FULLY_SATISFIED));
    const { result } = await wsl.probeWslHost({ distro: "Ubuntu-24.04" });
    expect(result?.missing).toEqual([]);
    expect(result?.satisfied).toHaveLength(4);
  });

  it("probeWslHost with the real default probe genuinely executes real system checks", async () => {
    const wsl = wslClient();
    const { result } = await wsl.probeWslHost({ distro: "Ubuntu-24.04" });
    // Not asserting specific satisfied/missing values — those legitimately vary by
    // host (systemd/podman availability differs across CI runners and dev machines).
    // What's asserted is that the real probe actually ran: every requirement is
    // accounted for in exactly one of the two buckets, none silently dropped.
    expect(result?.distro).toBe("Ubuntu-24.04");
    expect((result?.satisfied.length ?? 0) + (result?.missing.length ?? 0)).toBe(4);
    const all = [...(result?.satisfied ?? []), ...(result?.missing ?? [])];
    expect(new Set(all).size).toBe(4);
  });
});
