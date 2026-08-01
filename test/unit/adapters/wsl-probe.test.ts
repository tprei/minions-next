import { describe, it, expect } from "vitest";
import {
  createWslRequirementProbe,
  type CommandResult,
  type CommandRunner,
} from "@minions/adapters";

/**
 * Unit tests for the WSL2 requirement probe (PR 54 — wsl2-host-and-fleet-ui).
 * All probes are fail-closed — a failed/uncertain check reports "missing".
 */

function runner(results: Record<string, CommandResult>): CommandRunner {
  return (args) => {
    const key = args.join(" ");
    const result = results[key];
    if (result !== undefined) return Promise.resolve(result);
    return Promise.resolve({ exitCode: -1, stdout: "", stderr: "not mocked" });
  };
}

describe("WSL requirement probe", () => {
  it("returns all satisfied when every probe passes", async () => {
    const probe = createWslRequirementProbe({
      runCommand: runner({
        "systemctl is-system-running": { exitCode: 0, stdout: "running", stderr: "" },
        "podman info --format json": {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true } } }),
          stderr: "",
        },
      }),
      probeLoopback: () => Promise.resolve(true),
      probeStorage: () => Promise.resolve(true),
    });
    const result = await probe.probeAll("Ubuntu");
    expect(result.satisfied).toHaveLength(4);
    expect(result.missing).toHaveLength(0);
  });

  it("reports systemd missing when not running", async () => {
    const probe = createWslRequirementProbe({
      runCommand: runner({
        "systemctl is-system-running": { exitCode: 1, stdout: "stopped", stderr: "" },
        "podman info --format json": {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true } } }),
          stderr: "",
        },
      }),
      probeLoopback: () => Promise.resolve(true),
      probeStorage: () => Promise.resolve(true),
    });
    const result = await probe.probeAll("Ubuntu");
    expect(result.missing).toContain("systemd");
    expect(result.satisfied).not.toContain("systemd");
  });

  it("reports systemd satisfied when degraded", async () => {
    const systemd = await createWslRequirementProbe({
      runCommand: runner({
        "systemctl is-system-running": { exitCode: 0, stdout: "degraded", stderr: "" },
        "podman info --format json": {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true } } }),
          stderr: "",
        },
      }),
      probeLoopback: () => Promise.resolve(true),
      probeStorage: () => Promise.resolve(true),
    }).probeOne("Ubuntu", "systemd");
    expect(systemd).toBe(true);
  });

  it("reports podman missing when not rootless", async () => {
    const probe = createWslRequirementProbe({
      runCommand: runner({
        "systemctl is-system-running": { exitCode: 0, stdout: "running", stderr: "" },
        "podman info --format json": {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: false } } }),
          stderr: "",
        },
      }),
      probeLoopback: () => Promise.resolve(true),
      probeStorage: () => Promise.resolve(true),
    });
    const result = await probe.probeAll("Ubuntu");
    expect(result.missing).toContain("rootless_podman");
  });

  it("reports podman missing on non-zero exit", async () => {
    const probe = createWslRequirementProbe({
      runCommand: runner({
        "systemctl is-system-running": { exitCode: 0, stdout: "running", stderr: "" },
        "podman info --format json": { exitCode: 127, stdout: "", stderr: "command not found" },
      }),
      probeLoopback: () => Promise.resolve(true),
      probeStorage: () => Promise.resolve(true),
    });
    const result = await probe.probeAll("Ubuntu");
    expect(result.missing).toContain("rootless_podman");
  });

  it("reports localhost_forwarding missing when loopback probe fails", async () => {
    const probe = createWslRequirementProbe({
      runCommand: runner({
        "systemctl is-system-running": { exitCode: 0, stdout: "running", stderr: "" },
        "podman info --format json": {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true } } }),
          stderr: "",
        },
      }),
      probeLoopback: () => Promise.resolve(false),
      probeStorage: () => Promise.resolve(true),
    });
    const result = await probe.probeAll("Ubuntu");
    expect(result.missing).toContain("localhost_forwarding");
  });

  it("reports secure_storage missing when storage unavailable", async () => {
    const probe = createWslRequirementProbe({
      runCommand: runner({
        "systemctl is-system-running": { exitCode: 0, stdout: "running", stderr: "" },
        "podman info --format json": {
          exitCode: 0,
          stdout: JSON.stringify({ host: { security: { rootless: true } } }),
          stderr: "",
        },
      }),
      probeLoopback: () => Promise.resolve(true),
      probeStorage: () => Promise.resolve(false),
    });
    const result = await probe.probeAll("Ubuntu");
    expect(result.missing).toContain("secure_storage");
  });

  it("throws on empty distro name", async () => {
    const probe = createWslRequirementProbe({});
    await expect(probe.probeAll("")).rejects.toThrow(/distro name/);
    await expect(probe.probeOne("  ", "systemd")).rejects.toThrow(/distro name/);
  });

  it("probeOne returns boolean for a single requirement", async () => {
    const probe = createWslRequirementProbe({
      runCommand: runner({
        "systemctl is-system-running": { exitCode: 0, stdout: "running", stderr: "" },
      }),
    });
    const ok = await probe.probeOne("Ubuntu", "systemd");
    expect(ok).toBe(true);
  });

  it("uses custom systemctl/podman paths when provided", async () => {
    const calls: string[][] = [];
    const probe = createWslRequirementProbe({
      systemctlPath: "/usr/local/bin/systemctl",
      podmanPath: "/opt/podman/bin/podman",
      runCommand: (args) => {
        calls.push([...args]);
        return Promise.resolve({ exitCode: 0, stdout: "running", stderr: "" });
      },
      probeLoopback: () => Promise.resolve(true),
      probeStorage: () => Promise.resolve(true),
    });
    await probe.probeAll("Ubuntu");
    expect(calls[0]?.[0]).toBe("/usr/local/bin/systemctl");
    expect(calls[1]?.[0]).toBe("/opt/podman/bin/podman");
  });
});
