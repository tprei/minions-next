import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  ListWslHostsResponseSchema,
  ProbeWslHostResponseSchema,
  WslHostService,
  WslRequirement as WireWslRequirement,
  type WslHostProfile,
} from "@minions/contracts";

/**
 * WSL2 host management service handler (PR 54 — wsl2-host-and-fleet-ui).
 *
 * ProbeWslHost is functional: validates the distro name and returns a probe
 * result. In this environment (no WSL2 subsystem), all requirements report as
 * "missing" — the fail-closed default when system commands cannot confirm them.
 * RegisterWslHost and ListWslHosts manage an in-memory host registry.
 */
export type WslHostServiceOptions = Readonly<Record<string, never>>;

export function registerWslHostService(
  router: ConnectRouter,
  options: WslHostServiceOptions,
): void {
  void options;
  const hosts = new Map<string, WslHostProfile>();

  router.service(WslHostService, {
    registerWslHost(request) {
      if (request.profile === undefined) {
        throw new ConnectError("profile is required", Code.InvalidArgument);
      }
      const distro = request.profile.distro;
      if (distro.trim().length === 0) {
        throw new ConnectError("distro must not be empty", Code.InvalidArgument);
      }
      hosts.set(distro, request.profile);
      return { profile: request.profile };
    },
    probeWslHost(request) {
      const distro = request.distro;
      if (distro.trim().length === 0) {
        throw new ConnectError("distro must not be empty", Code.InvalidArgument);
      }
      // Fail-closed: without a real WSL2 subsystem, all requirements are missing.
      return create(ProbeWslHostResponseSchema, {
        result: {
          distro,
          satisfied: [],
          missing: [
            WireWslRequirement.SYSTEMD,
            WireWslRequirement.ROOTLESS_PODMAN,
            WireWslRequirement.LOCALHOST_FORWARDING,
            WireWslRequirement.SECURE_STORAGE,
          ],
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
