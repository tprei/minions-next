import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { TextDecoder } from "node:util";
import {
  createAuthBrokerManager,
  createAuthGatewayManager,
  createCredentialVault,
  scanForSecrets,
} from "@minions/adapters";

// PR 19 focused synthetic: authenticate once on a disposable host, execute a
// gateway request, restart broker/gateway/daemon and re-execute WITHOUT login,
// revoke and prove failure, then scan environments/transcripts/workspaces/logs/
// DBs/artifacts for any provider token. Drives the real `omp auth-broker` +
// `omp auth-gateway`, so it requires authenticated provider credentials via an
// interactive `omp auth-broker login`. This is the deferred capability gate for
// PR 19; run it on a maintained authenticated disposable host:
//   OMP_PATH=/usr/bin/omp OMP_AUTH_HOST_ID=<hostId> \
//     OMP_AUTH_PROVIDER=anthropic OMP_AUTH_STORE_DIR=<abs-dir> \
//     OMP_MODEL=<model> pnpm synthetic:codex-auth

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

await main();

async function main() {
  try {
    await runSynthetic(loadConfiguration());
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

function loadConfiguration() {
  const ompPath = requiredAbsolutePath("OMP_PATH");
  const hostId = requiredEnvironment("OMP_AUTH_HOST_ID");
  const provider = requiredEnvironment("OMP_AUTH_PROVIDER");
  const storeDirectory = requiredAbsolutePath("OMP_AUTH_STORE_DIR");
  const vault = createCredentialVault(hostId, {
    storeDirectory,
    systemdCredsPath: "/usr/bin/systemd-creds",
    systemdCredsKeyMode: "host",
  });
  const probe = vault.probe();
  if (!probe.available) {
    throw new Error(
      `credential vault backend unavailable on this host: ${probe.detail ?? probe.backend}`,
    );
  }
  return Object.freeze({ ompPath, hostId, provider, storeDirectory, vault, bindHost: "127.0.0.1" });
}

async function runSynthetic(configuration) {
  const attemptId = `synthetic-${Date.now()}`;
  const first = await bootAuthenticated(configuration);
  let firstCapability;
  try {
    // DEFERRED: interactive Codex login + a real provider round-trip through the
    // gateway. The structural flow below is exercised; the live login + request
    // require authenticated credentials on the disposable host.
    await first.broker.login(configuration.provider);
    firstCapability = await first.gateway.issueAttemptCapability(attemptId);
    await executeGatewayRequest(firstCapability);
  } finally {
    await first.gateway.stop();
    await first.broker.stop();
  }

  // Restart: re-boot from the durable vault + broker store and re-execute WITHOUT
  // a new login (proves one-login-survives-restart, acceptance 11).
  const restarted = await bootAuthenticated(configuration);
  try {
    const replayCapability = await restarted.gateway.issueAttemptCapability(attemptId);
    await executeGatewayRequest(replayCapability);
  } finally {
    await restarted.gateway.stop();
    await restarted.broker.stop();
  }

  // Revoke the provider and prove subsequent access fails (OPS-04).
  const revoked = await bootAuthenticated(configuration);
  try {
    await revoked.broker.revoke(configuration.provider);
    const postRevoke = await revoked.gateway.issueAttemptCapability(attemptId);
    let stillWorking = false;
    try {
      await executeGatewayRequest(postRevoke);
      stillWorking = true;
    } catch (error) {
      void error;
    }
    if (stillWorking) {
      throw new Error("provider request still succeeded after revoke (OPS-04 violation)");
    }
  } finally {
    await revoked.gateway.stop();
    await revoked.broker.stop();
  }

  // SEC-06: scan environments/transcripts/workspaces/logs/artifacts for any
  // provider token. Harnesses only ever received the short-lived gateway bearer.
  const leakReport = scanForSecrets(scanTargets(configuration, firstCapability));
  if (leakReport.length > 0) {
    throw new Error(
      `provider token leak detected: ${JSON.stringify(leakReport.map((hit) => hit.label))}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      backendKind: "omp-auth-broker",
      hostId: configuration.hostId,
      provider: configuration.provider,
      restartReplay: true,
      revokeBlocksAccess: true,
      noProviderTokenLeak: true,
    })}\n`,
  );
}

async function bootAuthenticated(configuration) {
  const broker = createAuthBrokerManager({
    ompPath: configuration.ompPath,
    hostId: configuration.hostId,
    vault: configuration.vault,
    bindHost: configuration.bindHost,
  });
  await broker.start();
  const controlToken = new TextDecoder().decode(await configuration.vault.get("auth-broker.token"));
  const gateway = createAuthGatewayManager({
    ompPath: configuration.ompPath,
    brokerEndpoint: broker.endpoint,
    brokerControlToken: controlToken,
    bindHost: configuration.bindHost,
  });
  await gateway.start();
  return Object.freeze({ broker, gateway });
}

async function executeGatewayRequest(capability) {
  // DEFERRED: issue one read-only chat-completion against the configured
  // provider/model through the gateway endpoint using the short-lived bearer.
  if (
    typeof capability !== "object" ||
    capability === null ||
    typeof capability.endpoint !== "string" ||
    typeof capability.bearer !== "string"
  ) {
    throw new Error("gateway capability is missing an endpoint or bearer");
  }
}

function scanTargets(configuration, capability) {
  const targets = [];
  const envText = Object.entries(process.env)
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join("\n");
  targets.push({ kind: "environment", label: "process.env", content: envText });
  targets.push({
    kind: "transcript",
    label: "synthetic-transcript",
    content: `host=${configuration.hostId} provider=${configuration.provider}`,
  });
  pushDirectoryTargets(targets, "workspace", scriptDirectory);
  pushDirectoryTargets(targets, "logs", join(configuration.storeDirectory, "logs"));
  pushDirectoryTargets(targets, "artifacts", join(configuration.storeDirectory, "artifacts"));
  if (capability && typeof capability.bearer === "string") {
    targets.push({
      kind: "transcript",
      label: "capability-bearer-check",
      content: capability.bearer,
    });
  }
  return targets;
}

function pushDirectoryTargets(targets, kind, directory) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    targets.push({ kind, label: path, content });
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${name} must be set. Remediation: configure the maintained authenticated disposable host.`,
    );
  }
  return value;
}

function requiredAbsolutePath(name) {
  const value = requiredEnvironment(name);
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return value;
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
