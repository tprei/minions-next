import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { createWslRequirementProbe, type WslRequirementProbe } from "@minions/adapters";
import {
  ListWslHostsResponseSchema,
  ProbeWslHostResponseSchema,
  WslHostService,
  WslRequirement as WireWslRequirement,
  type WslHostProfile,
} from "@minions/contracts";
import type { WslProbeResult, WslRequirement } from "@minions/core";

/**
 * WSL2 host management service handler (PR 54 — wsl2-host-and-fleet-ui).
 *
 * ProbeWslHost runs `@minions/adapters`'s real `WslRequirementProbe`: `systemctl
 * is-system-running`, `podman info` (checked for rootless mode), a real loopback TCP
 * bind/connect, and the credential vault's own backend probe (systemd-creds on
 * Linux/WSL2). These are genuine system checks, not simulated — they report
 * accurately whether run from inside a real WSL2 distro or (as in most dev/CI
 * environments) plain Linux, since the underlying facts they check (is systemd
 * running, is podman installed and rootless, does loopback forwarding work, is a
 * secure credential backend available) don't depend on WSL2 specifically. What this
 * does NOT cover: the Windows-side SSH bootstrap that invokes a named distro in the
 * first place — that needs a real Windows host to build and exercise against.
 * RegisterWslHost re-probes the same way and fails closed (`FailedPrecondition`) if
 * any requirement is missing, ignoring the client-supplied `requirementsMet` claim.
 * RegisterWslHost and ListWslHosts manage an in-memory host registry.
 */
export type WslHostServiceOptions = Readonly<{
  probe?: WslRequirementProbe;
}>;

function toWireRequirement(requirement: WslRequirement): WireWslRequirement {
  switch (requirement) {
    case "systemd":
      return WireWslRequirement.SYSTEMD;
    case "rootless_podman":
      return WireWslRequirement.ROOTLESS_PODMAN;
    case "localhost_forwarding":
      return WireWslRequirement.LOCALHOST_FORWARDING;
    case "secure_storage":
      return WireWslRequirement.SECURE_STORAGE;
  }
}

/**
 * Fail-closed requirement gate for RegisterWslHost (PR 54 acceptance criterion):
 * missing systemd, rootless Podman, localhost forwarding, or secure credential
 * storage blocks registration. The client-supplied `requirementsMet` field on the
 * request is never consulted here — it is a client assertion, not a server-verified
 * fact. This always re-probes independently via the injected `WslRequirementProbe`.
 */
function assertRequirementsMet(distro: string, result: WslProbeResult): void {
  if (result.missing.length === 0) {
    return;
  }
  throw new ConnectError(
    `WSL host "${distro}" is missing required capabilities: ${result.missing.join(", ")}`,
    Code.FailedPrecondition,
    undefined,
    undefined,
    result.missing,
  );
}

export function registerWslHostService(
  router: ConnectRouter,
  options: WslHostServiceOptions,
): void {
  const probe = options.probe ?? createWslRequirementProbe();
  const hosts = new Map<string, WslHostProfile>();

  router.service(WslHostService, {
    async registerWslHost(request) {
      if (request.profile === undefined) {
        throw new ConnectError("profile is required", Code.InvalidArgument);
      }
      const distro = request.profile.distro;
      if (distro.trim().length === 0) {
        throw new ConnectError("distro must not be empty", Code.InvalidArgument);
      }
      const result = await probe.probeAll(distro);
      assertRequirementsMet(distro, result);
      hosts.set(distro, request.profile);
      return { profile: request.profile };
    },
    async probeWslHost(request) {
      const distro = request.distro;
      if (distro.trim().length === 0) {
        throw new ConnectError("distro must not be empty", Code.InvalidArgument);
      }
      const result = await probe.probeAll(distro);
      return create(ProbeWslHostResponseSchema, {
        result: {
          distro: result.distro,
          satisfied: result.satisfied.map(toWireRequirement),
          missing: result.missing.map(toWireRequirement),
        },
      });
    },
    listWslHosts() {
      return create(ListWslHostsResponseSchema, {
        hosts: [...hosts.values()],
      });
    },
  });
}
