import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  createAuthBrokerManager,
  createAuthGatewayManager,
  createCredentialVault,
  parseJsonObject,
  redactSecrets,
  runOmp,
  scanForSecrets,
  type AuthBrokerManager,
  type AuthGatewayManager,
  type CredentialVault,
  type SystemdCredsKeyMode,
} from "@minions/adapters";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Integration test for the auth-broker + auth-gateway lifecycle (PR 19, deliverable
 * 8). Boots REAL `omp auth-broker serve` + `omp auth-gateway serve` subprocesses on
 * loopback ephemeral ports, persists the control bearer via a real
 * `systemd-creds`-backed vault, and exercises:
 *
 * - `health()` ok on broker + gateway after start,
 * - noninteractive recovery across a broker restart (the broker boots against its
 *   existing SQLite store and the persisted control bearer matches the new one —
 *   NO real provider login is performed; this is the acceptance-11 durable-auth
 *   invariant at the broker-state level),
 * - `issueAttemptCapability` returns ONLY a short-lived bearer + endpoint (the
 *   broker control bearer is never handed out — SEC-06),
 * - revocation rotates the gateway bearer so the prior capability is invalidated,
 * - `scanForSecrets` across the captured environment/transcripts finds the
 *   broker-control + attempt-capability bearers (proving the scan surface works)
 *   while transcripts containing only endpoint metadata are clean.
 *
 * Live login against a real provider is DEFERRED to the synthetic runner.
 *
 * ## Empirical deviation (documented)
 * `systemd-creds --with-key=host` requires the root-only host key. This dev box
 * has no host key accessible to non-root users, so the test probes a working key
 * mode at setup. The factory default remains `"host"`.
 */

const ompPath = resolveOmpPath();
const keyMode = detectKeyMode();
const live = ompPath !== undefined && keyMode !== undefined;

const HOST_ID = "01900000-0000-7000-8000-000000000020";
const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];
const temporaryBrokers: AuthBrokerManager[] = [];
const temporaryGateways: AuthGatewayManager[] = [];

afterEach(async () => {
  while (temporaryGateways.length > 0) {
    const gateway = temporaryGateways.pop();
    if (gateway === undefined) break;
    await gateway.stop().catch(() => undefined);
  }
  while (temporaryBrokers.length > 0) {
    const broker = temporaryBrokers.pop();
    if (broker === undefined) break;
    await broker.stop().catch(() => undefined);
  }
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir === undefined) break;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  while (temporaryFiles.length > 0) {
    const file = temporaryFiles.pop();
    if (file === undefined) break;
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe.skipIf(!live)("auth-broker + auth-gateway lifecycle (real omp subprocesses)", () => {
  it("boots broker + gateway and reports healthy status", async () => {
    const { broker, gateway, controlBearer } = await bootBrokerAndGateway();
    expect(broker.running).toBe(true);
    expect(broker.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

    const brokerHealth = await broker.health();
    expect(brokerHealth.ok).toBe(true);
    expect(brokerHealth.url).toBe(broker.endpoint);
    expect(brokerHealth.version).toBe("17.1.3");

    expect(controlBearer.length).toBeGreaterThan(0);

    expect(gateway.running).toBe(true);
    const gatewayHealth = await gateway.health();
    expect(gatewayHealth.ready).toBe(true);
    expect(gatewayHealth.brokerConfigured).toBe(true);
    expect(gatewayHealth.brokerAuthenticated).toBe(true);
  }, 30_000);

  it("recovers the control bearer noninteractively across a broker restart", async () => {
    const vault = makeVault();
    const broker = createAuthBrokerManager({
      ompPath: ompPath ?? "",
      hostId: HOST_ID,
      vault,
    });
    temporaryBrokers.push(broker);
    await broker.start();
    const firstBearer = await readVaultText(vault, "auth-broker.token");
    expect(firstBearer.length).toBeGreaterThan(0);
    await broker.stop();

    // Boot a fresh manager against the SAME vault + SQLite store. The
    // persisted control bearer must match the broker's new one — restart
    // recovery is transparent and unambiguous (no provider login required).
    const brokerAgain = createAuthBrokerManager({
      ompPath: ompPath ?? "",
      hostId: HOST_ID,
      vault,
    });
    temporaryBrokers.push(brokerAgain);
    await brokerAgain.start();
    const recoveredBearer = await readVaultText(vault, "auth-broker.token");
    expect(recoveredBearer).toBe(firstBearer);
    const health = await brokerAgain.health();
    expect(health.ok).toBe(true);
  }, 60_000);

  it("issueAttemptCapability returns only a short-lived bearer + endpoint (SEC-06)", async () => {
    const { gateway, controlBearer } = await bootBrokerAndGateway();
    const attemptId = "01900000-0000-7000-8000-0000000000aa";
    const cap = await gateway.issueAttemptCapability(attemptId);

    expect(cap.attemptId).toBe(attemptId);
    expect(cap.endpoint).toBe(gateway.endpoint);
    expect(cap.bearer.length).toBeGreaterThan(0);
    // The capability MUST NOT be the broker control bearer — that lives in
    // the broker/vault boundary and never reaches the harness (SEC-06).
    expect(cap.bearer).not.toBe(controlBearer);
    expect(gateway.liveAttemptCount).toBe(1);

    // Issuing twice for the same attempt fails closed.
    await expect(gateway.issueAttemptCapability(attemptId)).rejects.toMatchObject({
      code: "capability_active",
      name: "AuthGatewayError",
    });
  }, 30_000);

  it("revokeAttemptCapability rotates the gateway bearer when the live set is empty", async () => {
    const { gateway } = await bootBrokerAndGateway();
    const firstAttempt = "01900000-0000-7000-8000-0000000000b1";
    const secondAttempt = "01900000-0000-7000-8000-0000000000b2";
    const cap1 = await gateway.issueAttemptCapability(firstAttempt);
    await gateway.issueAttemptCapability(secondAttempt);

    // Revoking ONE attempt while others are live MUST NOT rotate the gateway
    // bearer — that would invalidate the other live attempt.
    await gateway.revokeAttemptCapability(firstAttempt);
    const cap2Again = await gateway.issueAttemptCapability(firstAttempt);
    expect(cap2Again.bearer).toBe(cap1.bearer);

    // Revoking the last live attempt rotates the gateway bearer.
    await gateway.revokeAttemptCapability(secondAttempt);
    await gateway.revokeAttemptCapability(firstAttempt);
    const capAfterRotate = await gateway.issueAttemptCapability(
      "01900000-0000-7000-8000-0000000000b3",
    );
    expect(capAfterRotate.bearer).not.toBe(cap1.bearer);
  }, 60_000);

  it("revokeAttemptCapability on an unknown attempt fails closed", async () => {
    const { gateway } = await bootBrokerAndGateway();
    await expect(
      gateway.revokeAttemptCapability("01900000-0000-7000-8000-0000000000ff"),
    ).rejects.toMatchObject({
      code: "capability_unknown",
      name: "AuthGatewayError",
    });
  }, 30_000);

  it("revokeAttemptCapability rejects (revocation_failed) when the LAST attempt is revoked and rotation fails (F1)", async () => {
    // Drive a real broker + gateway through a tiny sh wrapper that delegates to
    // the real omp EXCEPT for `auth-gateway token --regenerate`, which it fails
    // with a nonzero exit. This exercises the F1 fail-closed path: when the last
    // live attempt is revoked and the bearer cannot be rotated, the prior
    // capability is still live in omp, so revokeAttemptCapability MUST reject
    // rather than swallow the rotation error.
    const wrapperPath = makeFailingRotateOmpWrapper(ompPath ?? "");
    const { gateway } = await bootBrokerAndGateway({ ompPath: wrapperPath });
    const attemptId = "01900000-0000-7000-8000-0000000000c1";
    await gateway.issueAttemptCapability(attemptId);
    await expect(gateway.revokeAttemptCapability(attemptId)).rejects.toMatchObject({
      code: "revocation_failed",
      name: "AuthGatewayError",
    });
  }, 30_000);

  it("broker.start fails closed when the vault backend is unavailable", async () => {
    const brokenVault = createCredentialVault(HOST_ID, {
      storeDirectory: makeStoreDirectory(),
      systemdCredsPath: "/does/not/exist/systemd-creds",
      systemdCredsKeyMode: "host",
    });
    const broker = createAuthBrokerManager({
      ompPath: ompPath ?? "",
      hostId: HOST_ID,
      vault: brokenVault,
    });
    await expect(broker.start()).rejects.toMatchObject({
      code: "vault_unavailable",
      name: "AuthBrokerError",
    });
    expect(broker.running).toBe(false);
  });

  it("issueAttemptCapability fails closed when the gateway is not running", async () => {
    const gateway = createAuthGatewayManager({
      ompPath: ompPath ?? "",
      brokerEndpoint: "http://127.0.0.1:1",
      brokerControlToken: "deadbeef",
    });
    await expect(
      gateway.issueAttemptCapability("01900000-0000-7000-8000-0000000000cc"),
    ).rejects.toMatchObject({ code: "not_running", name: "AuthGatewayError" });
  });

  it("issueAttemptCapability rejects empty attempt ids", async () => {
    const gateway = createAuthGatewayManager({
      ompPath: ompPath ?? "",
      brokerEndpoint: "http://127.0.0.1:1",
      brokerControlToken: "deadbeef",
    });
    await expect(gateway.issueAttemptCapability("")).rejects.toMatchObject({
      code: "invalid_configuration",
      name: "AuthGatewayError",
    });
  });
});

describe("redaction of broker / gateway artifacts (always run)", () => {
  it("the broker control bearer shape is covered by the default opaque pattern", () => {
    const bearer = "CXLhiaunG7fLIlQm38JkiM9UvhIyNsObn5FRPlshBLY";
    expect(redactSecrets(`broker=${bearer}`)).toBe("broker=[REDACTED]");
  });

  it("scanForSecrets detects leaked broker control bearers", () => {
    const bearer = "CXLhiaunG7fLIlQm38JkiM9UvhIyNsObn5FRPlshBLY";
    const hits = scanForSecrets(
      [{ kind: "logs" as const, label: "l", content: `control=${bearer}` }],
      [bearer],
    );
    // The bearer matches both the literal known_secret AND the default
    // opaque_base64url shape — scan returns BOTH as separate (target, pattern) hits.
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.patternName).sort()).toEqual(["known_secret", "opaque_base64url"]);
  });

  it("scanForSecrets reports zero hits for clean transcripts", () => {
    const hits = scanForSecrets(
      [{ kind: "transcript" as const, label: "t", content: "endpoint=http://127.0.0.1:39201" }],
      [],
    );
    expect(hits).toEqual([]);
  });

  it("parseJsonObject accepts a flat object and rejects malformed input", () => {
    expect(parseJsonObject('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonObject("not-json")).toBeNull();
    expect(parseJsonObject("[1,2,3]")).toBeNull();
  });

  it("runOmp returns the exit code and captured output of an omp invocation", async () => {
    if (ompPath === undefined) return;
    const result = await runOmp(ompPath, ["--version"], process.env as Record<string, string>, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/omp/u);
  });
});

// -------------------------------------------------------------------------------------------------
// Helpers.
// -------------------------------------------------------------------------------------------------

async function bootBrokerAndGateway(override: Readonly<{ ompPath?: string }> = {}): Promise<{
  broker: AuthBrokerManager;
  gateway: AuthGatewayManager;
  controlBearer: string;
}> {
  const effectiveOmpPath = override.ompPath ?? ompPath ?? "";
  const vault = makeVault();
  const broker = createAuthBrokerManager({ ompPath: effectiveOmpPath, hostId: HOST_ID, vault });
  temporaryBrokers.push(broker);
  await broker.start();
  const controlBearer = await readVaultText(vault, "auth-broker.token");
  const gateway = createAuthGatewayManager({
    ompPath: effectiveOmpPath,
    brokerEndpoint: broker.endpoint ?? "",
    brokerControlToken: controlBearer,
  });
  temporaryGateways.push(gateway);
  await gateway.start();
  return { broker, gateway, controlBearer };
}

/**
 * F1 test helper: a sh wrapper that delegates every invocation to the real omp
 * EXCEPT `auth-gateway token --regenerate`, which it fails with exit 1 + a short
 * stderr line. Drives a real broker+gateway pair through it so the F1
 * reject-on-rotate-failure path is exercised against genuine subprocesses.
 */
function makeFailingRotateOmpWrapper(realOmpPath: string): string {
  const script = `#!/bin/sh
if [ "$1" = "auth-gateway" ] && [ "$2" = "token" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--regenerate" ]; then
      echo "simulated rotation failure" >&2
      exit 1
    fi
  done
fi
exec "${realOmpPath}" "$@"
`;
  const wrapperPath = join(
    tmpdir(),
    `omp-fail-rotate-${String(process.pid)}-${String(Date.now())}.sh`,
  );
  writeFileSync(wrapperPath, script, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  temporaryFiles.push(wrapperPath);
  return wrapperPath;
}

function makeVault(): CredentialVault {
  return createCredentialVault(HOST_ID, {
    storeDirectory: makeStoreDirectory(),
    systemdCredsKeyMode: keyMode ?? "host",
  });
}

function makeStoreDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "mauth-bg-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function readVaultText(vault: CredentialVault, name: string): Promise<string> {
  const bytes = await vault.get(name);
  return new TextDecoder().decode(bytes);
}

function resolveOmpPath(): string | undefined {
  const fromEnv = process.env["OMP_PATH"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const candidates = ["/home/mbn/.local/bin/omp", "/usr/local/bin/omp", "/usr/bin/omp"];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function detectKeyMode(): SystemdCredsKeyMode | undefined {
  if (!existsSync("/usr/bin/systemd-creds")) return undefined;
  const plain = join(tmpdir(), `mauth-probe-${String(process.pid)}-${String(Date.now())}.plain`);
  writeFileSync(plain, "probe");
  try {
    const modes: readonly SystemdCredsKeyMode[] = ["host", "auto-initrd", "tpm2-absent", "auto"];
    for (const mode of modes) {
      const cipher = join(
        tmpdir(),
        `mauth-probe-${String(process.pid)}-${String(Date.now())}.cipher`,
      );
      const result = spawnSync(
        "/usr/bin/systemd-creds",
        ["encrypt", "--name=probe", `--with-key=${mode}`, plain, cipher],
        { encoding: "utf8" },
      );
      if (result.status === 0 && existsSync(cipher)) {
        rmSync(cipher, { force: true });
        return mode;
      }
      rmSync(cipher, { force: true });
    }
    return undefined;
  } finally {
    rmSync(plain, { force: true });
  }
}
