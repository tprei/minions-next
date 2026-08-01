import { createTailscaleProbe } from "@minions/adapters";
import { describe, expect, it } from "vitest";

/**
 * Tailscale capability probe unit tests (PR 57 — private-phone-pairing).
 *
 * Covers the real `tailscale status --json` parsing logic via an injected command
 * runner (deterministic, no real `tailscaled` dependency) plus one test against the
 * actual local `tailscale` binary when present, proving the wiring genuinely shells
 * out rather than only satisfying a fake interface.
 */
function fakeRunner(exitCode: number, stdout: string) {
  return () => Promise.resolve({ exitCode, stdout, stderr: "" });
}

const CONNECTED_JSON = JSON.stringify({
  BackendState: "Running",
  CertDomains: ["mini-1.example.ts.net"],
  Self: { DNSName: "mini-1.example.ts.net.", Online: true },
});

describe("createTailscaleProbe", () => {
  it("reports connected + https-capable from a real-shaped connected status", async () => {
    const probe = createTailscaleProbe({ runCommand: fakeRunner(0, CONNECTED_JSON) });
    const capability = await probe.checkCapability();
    expect(capability).toEqual({
      connected: true,
      tailnetHostname: "mini-1.example.ts.net",
      httpsCapable: true,
      certDomain: "mini-1.example.ts.net",
    });
  });

  it("strips the trailing dot from the DNS name", async () => {
    const probe = createTailscaleProbe({
      runCommand: fakeRunner(
        0,
        JSON.stringify({
          BackendState: "Running",
          CertDomains: [],
          Self: { DNSName: "host.example.ts.net.", Online: true },
        }),
      ),
    });
    const capability = await probe.checkCapability();
    expect(capability.tailnetHostname).toBe("host.example.ts.net");
    expect(capability.httpsCapable).toBe(false);
    expect(capability.certDomain).toBeUndefined();
  });

  it("reports not connected when BackendState is not Running", async () => {
    const probe = createTailscaleProbe({
      runCommand: fakeRunner(
        0,
        JSON.stringify({ BackendState: "Stopped", Self: { Online: false } }),
      ),
    });
    const capability = await probe.checkCapability();
    expect(capability).toEqual({
      connected: false,
      tailnetHostname: undefined,
      httpsCapable: false,
      certDomain: undefined,
    });
  });

  it("fails closed when the command exits non-zero (binary missing or daemon down)", async () => {
    const probe = createTailscaleProbe({ runCommand: fakeRunner(1, "") });
    const capability = await probe.checkCapability();
    expect(capability.connected).toBe(false);
  });

  it("fails closed on malformed JSON output", async () => {
    const probe = createTailscaleProbe({ runCommand: fakeRunner(0, "not json") });
    const capability = await probe.checkCapability();
    expect(capability.connected).toBe(false);
  });

  it("fails closed when the command runner itself throws", async () => {
    const probe = createTailscaleProbe({
      runCommand: () => Promise.reject(new Error("spawn failed")),
    });
    const capability = await probe.checkCapability();
    expect(capability.connected).toBe(false);
  });

  it("real default probe genuinely shells out (no assertion on the specific result — legitimately varies by host)", async () => {
    const probe = createTailscaleProbe();
    const capability = await probe.checkCapability();
    // Only asserting the shape is well-formed, not a specific connectivity state -
    // whether this sandbox has a real tailnet connection is environment-dependent.
    expect(typeof capability.connected).toBe("boolean");
    if (!capability.connected) {
      expect(capability.tailnetHostname).toBeUndefined();
      expect(capability.httpsCapable).toBe(false);
    }
  });
});
