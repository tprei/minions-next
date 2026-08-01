import process from "node:process";

import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { WslHostService, WslHostProfileSchema, WslRequirement } from "@minions/contracts";

/**
 * Synthetic 19 (PR 54 — wsl2-host-and-fleet-ui, PRD REMOTE-08..REMOTE-11). Exercises the
 * REAL daemon-side WSL host registration + requirement probe lifecycle over the running
 * supervisor's Connect API.
 *
 * NOTE: the Windows-side SSH bootstrap that invokes a named WSL distro in the first place
 * (wsl.exe / powershell) genuinely needs a real Windows host to build and exercise against
 * — apps/daemon/src/wsl-service.ts documents this explicitly. It is intentionally out of
 * scope here. This script drives everything the daemon owns once a WSL host is reachable:
 * register by distro + Windows user, probe systemd/rootless-Podman/localhost-forwarding/
 * secure-storage requirements, list registered hosts, and assert that a missing required
 * capability fails registration closed (no Windows-native fallback).
 *
 * Environment proof, not a CI gate. Requires:
 *   MINIONS_WSL_BASE_URL=<supervisor http url>
 *   MINIONS_WSL_DISTRO=<distro name, e.g. Ubuntu>
 *   MINIONS_WSL_WINDOWS_USER=<windows user>
 * Run on the maintained WSL host: pnpm synthetic:wsl-host
 */

await main();

async function main() {
  const baseUrl = requiredEnvironment("MINIONS_WSL_BASE_URL");
  const distro = requiredEnvironment("MINIONS_WSL_DISTRO");
  const windowsUser = requiredEnvironment("MINIONS_WSL_WINDOWS_USER");
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "1.1",
    nodeOptions: { agent: false },
  });
  const wsl = createClient(WslHostService, transport);
  const steps = [];
  try {
    // 1. Register the WSL host with all four required capabilities satisfied (REMOTE-11).
    const allRequirements = [
      WslRequirement.SYSTEMD,
      WslRequirement.ROOTLESS_PODMAN,
      WslRequirement.LOCALHOST_FORWARDING,
      WslRequirement.SECURE_STORAGE,
    ];
    const registered = await wsl.registerWslHost({
      profile: create(WslHostProfileSchema, {
        distro,
        windowsUser,
        requirementsMet: allRequirements,
      }),
    });
    if (registered.profile === undefined) {
      throw new Error("registerWslHost returned no profile");
    }
    steps.push({ step: "register_wsl_host", distro: registered.profile.distro });

    // 2. Probe the distro's requirements — the real probe inspects the live distro.
    const probe = await wsl.probeWslHost({ distro });
    steps.push({
      step: "probe_wsl_host",
      satisfied: probe.result?.satisfied,
    });

    // 3. List registered hosts reflects the registration.
    const list = await wsl.listWslHosts({});
    steps.push({
      step: "list_wsl_hosts",
      count: list.hosts.length,
      includesRegistered: list.hosts.some((host) => host.distro === distro),
    });

    // 4. Fail-closed: registration with NO requirements met must be rejected (REMOTE-11,
    //    acceptance: missing systemd/rootless Podman/localhost forwarding/secure storage
    //    blocks registration). A request that claims nothing should not succeed.
    let emptyRequirementsBlocked = false;
    try {
      await wsl.registerWslHost({
        profile: create(WslHostProfileSchema, {
          distro: `${distro}-empty`,
          windowsUser,
          requirementsMet: [],
        }),
      });
    } catch {
      emptyRequirementsBlocked = true;
    }
    steps.push({ step: "empty_requirements_blocked", blocked: emptyRequirementsBlocked });

    process.stdout.write(`${JSON.stringify({ synthetic: "wsl-host", steps })}\n`);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`required environment variable '${name}' is not set`);
  }
  return value;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
