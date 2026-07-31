import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { createSshConnection } from "@minions/adapters";

/**
 * Synthetic (PR 53 — ssh-execution-hosts, PRD REMOTE-08..REMOTE-10). Exercises the REAL
 * SSH adapter (packages/adapters/src/ssh-adapter.ts) against a disposable remote host:
 * establish a ControlMaster connection + local port forward, health-check the multiplexed
 * link, prove a changed host key is rejected fail-closed (host_key_mismatch), then tear
 * the connection down. Node commands, events, and evidence use the tunneled generated
 * Connect API; SSH itself runs bootstrap/service commands only.
 *
 * Environment proof, not a CI gate. Requires:
 *   MINIONS_SSH_ALIAS=<control-master alias>
 *   MINIONS_SSH_HOST=<hostname or ip>
 *   MINIONS_SSH_PORT=<port, default 22>
 *   MINIONS_SSH_USER=<ssh user>
 *   MINIONS_SSH_KNOWN_HOST_KEY=<the pinned host-key fingerprint the adapter should accept>
 *   MINIONS_SUPERVISOR_VERSION=<this supervisor's server version, exchanged on connect>
 * Run on the maintained Mac supervisor with a disposable remote host:
 *   pnpm synthetic:ssh-host
 */

await main();

async function main() {
  const alias = requiredEnvironment("MINIONS_SSH_ALIAS");
  const hostname = requiredEnvironment("MINIONS_SSH_HOST");
  const port = Number.parseInt(process.env["MINIONS_SSH_PORT"] ?? "22", 10);
  const user = requiredEnvironment("MINIONS_SSH_USER");
  const knownHostKey = requiredEnvironment("MINIONS_SSH_KNOWN_HOST_KEY");
  const supervisorVersion = requiredEnvironment("MINIONS_SUPERVISOR_VERSION");
  const controlMasterDir = await mkdtemp(join(tmpdir(), "minions-ssh-synthetic-"));
  const steps = [];
  let connection;
  try {
    // 1. Establish the ControlMaster connection + local forward (REMOTE-08).
    connection = createSshConnection({
      profile: {
        alias,
        hostname,
        port,
        user,
        knownHostKey,
        controlMasterPath: join(controlMasterDir, `${alias}%r@%h:%p`),
        localForwardPort: 0, // 0 = let the adapter pick a free loopback port
      },
      supervisorVersion,
    });
    await connection.connect();
    steps.push({ step: "connect", state: connection.state, forward: connection.localForwardPort });

    // 2. Health-check the multiplexed connection.
    const healthy = await connection.checkHealth();
    steps.push({ step: "check_health", healthy });

    // 3. A changed host key must be rejected fail-closed (REMOTE-09, host_key_mismatch):
    //    a deliberately wrong fingerprint never matches the live host's key.
    let changedKeyRejected = false;
    const tampered = createSshConnection({
      profile: {
        alias: `${alias}-tampered`,
        hostname,
        port,
        user,
        knownHostKey: "SHA256:0000000000000000000000000000000000000000000=",
        controlMasterPath: join(controlMasterDir, `${alias}-tampered-%r@%h:%p`),
        localForwardPort: 0,
      },
      supervisorVersion,
    });
    try {
      await tampered.connect();
    } catch {
      changedKeyRejected = true;
    }
    await tampered.disconnect().catch(() => undefined);
    steps.push({ step: "changed_host_key_rejected", rejected: changedKeyRejected });

    // 4. Disconnect tears the ControlMaster + forward down cleanly.
    await connection.disconnect();
    steps.push({ step: "disconnect", state: connection.state });
    connection = undefined;

    process.stdout.write(`${JSON.stringify({ synthetic: "ssh-host", steps })}\n`);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  } finally {
    await connection?.disconnect().catch(() => undefined);
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
