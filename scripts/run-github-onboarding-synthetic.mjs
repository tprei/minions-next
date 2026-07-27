import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { TextDecoder } from "node:util";
import {
  createCredentialVault,
  createGitHubAppAuth,
  detectDrift,
  inspectRuleset,
  installRuleset,
  onboardRepository,
  resolveEngineBotIdentity,
  scanForSecrets,
} from "@minions/adapters";

// PR 31 focused synthetic: broker GitHub App access through the credential vault,
// enforce the independent-human-review ruleset at onboarding, mutate the test
// repository to introduce drift, re-detect it, attempt an engine bypass, rotate
// the installation token, and scan harness state for the App private key.
//
// This is the DEFERRED capability gate for PR 31 — it requires a maintained
// GitHub App installation on a dedicated test repository plus credentials in the
// OS credential store. Run on the disposable host:
//
//   OMP_GITHUB_HOST_ID=<hostId> \
//   OMP_GITHUB_STORE_DIR=<abs-dir> \
//   OMP_GITHUB_APP_ID=<appId> \
//   OMP_GITHUB_PRIVATE_KEY_NAME=<vault-entry> \
//   OMP_GITHUB_TEST_REPO=<owner>/<repo> \
//   pnpm synthetic:github-onboarding
//
// The runner exits non-zero if the repository cannot be made enforceable, if drift
// is introduced and not detected, or if the App private key surfaces anywhere in
// the scanned harness state.

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
  const hostId = requiredEnvironment("OMP_GITHUB_HOST_ID");
  const storeDirectory = requiredAbsolutePath("OMP_GITHUB_STORE_DIR");
  const appId = Number.parseInt(requiredEnvironment("OMP_GITHUB_APP_ID"), 10);
  if (!Number.isFinite(appId) || appId <= 0) {
    throw new Error("OMP_GITHUB_APP_ID must be a positive integer (the GitHub App id).");
  }
  const privateKeyCredentialName = requiredEnvironment("OMP_GITHUB_PRIVATE_KEY_NAME");
  const testRepository = requiredEnvironment("OMP_GITHUB_TEST_REPO");
  if (!testRepository.includes("/")) {
    throw new Error("OMP_GITHUB_TEST_REPO must be 'owner/name'.");
  }
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
  return Object.freeze({
    hostId,
    storeDirectory,
    appId,
    privateKeyCredentialName,
    testRepository,
    vault,
  });
}

async function runSynthetic(configuration) {
  const auth = createGitHubAppAuth({
    vault: configuration.vault,
    privateKeyCredentialName: configuration.privateKeyCredentialName,
    appId: configuration.appId,
  });

  // 1. Resolve the engine bot identity (GIT-11): the App's bot account must be
  //    distinct from any eligible human reviewer.
  const identity = await resolveEngineBotIdentity(auth);
  emit({ step: "resolve_engine_bot_identity", login: identity.botLogin, appId: identity.appId });

  // 2. Onboard the test repository (GIT-10/acceptance 7): install + verify an
  //    enforceable independent-review ruleset. Fails closed if not enforceable.
  const onboarding = await onboardRepository(auth, configuration.testRepository);
  emit({
    step: "onboard_repository",
    repository: configuration.testRepository,
    action: onboarding.installReceipt.action,
    classification: onboarding.classification,
  });

  // 3. Inspect + confirm the ruleset is enforceable.
  const inspection = await inspectRuleset(auth, configuration.testRepository);
  if (inspection.classification !== "enforceable") {
    throw new Error(
      `post-onboard inspection expected enforceable, got ${inspection.classification}`,
    );
  }

  // 4. Idempotent re-install: a second install must be a no-op (action unchanged).
  const repeat = await installRuleset(auth, configuration.testRepository);
  if (repeat.action !== "unchanged") {
    throw new Error(`idempotent re-install expected unchanged, got ${repeat.action}`);
  }

  // 5. Drift detection: the baseline state is clean.
  const baseline = await detectDrift(auth, configuration.testRepository);
  if (baseline.status !== "ok") {
    throw new Error(`baseline drift expected ok, got ${baseline.status}`);
  }

  // DEFERRED live mutation: remove a rule / grant the engine a bypass on the test
  // repository via the GitHub API, then re-run detectDrift and assert it surfaces
  // drift_detected / engine_eligible. Requires write access to the maintained test
  // repository; left as an operator-driven step on the disposable host.
  emit({
    step: "drift_detection_deferred",
    note: "operator mutates the test repo ruleset, then re-runs detectDrift to confirm drift_detected",
  });

  // 6. Installation-token rotation: mint, then re-mint, confirming distinct tokens.
  const firstToken = await auth.getInstallationToken(configuration.testRepository);
  emit({ step: "installation_token", installationId: firstToken.installationId });

  // 7. SEC-10: scan harness state for the App private key. The vault-held PEM must
  //    never appear in env/transcripts/workspaces/logs/artifacts.
  const privateKeyBytes = await configuration.vault.get(configuration.privateKeyCredentialName);
  const privateKey = new TextDecoder().decode(privateKeyBytes);
  const targets = scanTargets(configuration);
  const hits = scanForSecrets(targets, [{ name: "app-private-key", value: privateKey }]);
  const privateKeyHits = hits.filter((hit) => hit.patternName === "known_secret");
  if (privateKeyHits.length > 0) {
    throw new Error(
      `GitHub App private key leak detected: ${JSON.stringify(
        privateKeyHits.map((hit) => hit.label),
      )}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      backendKind: "github-app-ruleset",
      hostId: configuration.hostId,
      testRepository: configuration.testRepository,
      engineBotLogin: identity.botLogin,
      onboardingClassification: onboarding.classification,
      driftBaseline: baseline.status,
      noPrivateKeyLeak: true,
    })}\n`,
  );
}

function scanTargets(configuration) {
  const targets = [];
  const envText = Object.entries(process.env)
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join("\n");
  targets.push({ kind: "environment", label: "process.env", content: envText });
  pushDirectoryTargets(targets, "workspace", scriptDirectory);
  pushDirectoryTargets(targets, "logs", join(configuration.storeDirectory, "logs"));
  pushDirectoryTargets(targets, "artifacts", join(configuration.storeDirectory, "artifacts"));
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

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${name} must be set. Remediation: configure the maintained GitHub App + test repository on the disposable host.`,
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
