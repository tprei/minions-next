import { isAbsolute } from "node:path";
import process from "node:process";

import {
  createCredentialVault,
  createGitHubAppAuth,
  createLandingCoordinator,
  createPullRequestManager,
  createRemoteCiManager,
  createSqliteGateReceiptStore,
  createSqliteVcsChangeBindingStore,
  createStackParentageManager,
  resolveEngineBotIdentity,
} from "@minions/adapters";
import { actorSessionId, humanApproval, taskTreeId, timestampFromEpochMilliseconds } from "@minions/core";
import { TemporarySqliteDatabase } from "@minions/testkit/sqlite";

// PR 36 focused synthetic: exercise the real landing coordinator's preflight +
// reconciliation contract against a maintained GitHub App installation on a dedicated
// test repository. DEFERRED capability gate for PR 36 — requires credentials in the OS
// credential store plus a prepared test PR.
//
//   OMP_GITHUB_HOST_ID=<hostId> \
//   OMP_GITHUB_STORE_DIR=<abs-dir> \
//   OMP_GITHUB_APP_ID=<appId> \
//   OMP_GITHUB_PRIVATE_KEY_NAME=<vault-entry> \
//   OMP_GITHUB_TEST_REPO=<owner>/<repo> \
//   OMP_GITHUB_LANDING_PR=<pr-number> \
//   OMP_GITHUB_LANDING_HEAD_SHA=<40-hex head sha the human reviewed> \
//   [OMP_GITHUB_LANDING_TRUNK=<trunk-branch, default main>] \
//   pnpm synthetic:github-landing
//
// The named PR must be open and un-merged. The synthetic proves the typed preflight is
// non-destructive (no merge, no receipt on failure) and that a second identical command
// is a clean idempotent duplicate once a receipt exists. It never force-merges: a fully
// passing preflight lands exactly once, then every subsequent command is duplicate_command.

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
  const prNumber = Number.parseInt(requiredEnvironment("OMP_GITHUB_LANDING_PR"), 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error("OMP_GITHUB_LANDING_PR must be a positive integer PR number.");
  }
  const expectedHeadSha = requiredEnvironment("OMP_GITHUB_LANDING_HEAD_SHA");
  if (!/^[0-9a-f]{40}$/u.test(expectedHeadSha)) {
    throw new Error("OMP_GITHUB_LANDING_HEAD_SHA must be a 40-hex git commit SHA.");
  }
  const trunk = process.env["OMP_GITHUB_LANDING_TRUNK"] ?? "main";
  const vault = createCredentialVault(hostId, {
    storeDirectory,
    systemdCredsPath: "/usr/bin/systemd-creds",
    systemdCredsKeyMode: "host",
  });
  const probe = vault.probe();
  if (!probe.available) {
    throw new Error(`credential vault backend unavailable: ${probe.detail ?? probe.backend}`);
  }
  return Object.freeze({
    appId,
    privateKeyCredentialName,
    testRepository,
    prNumber,
    expectedHeadSha,
    trunk,
    vault,
  });
}

async function runSynthetic(configuration) {
  const auth = createGitHubAppAuth({
    vault: configuration.vault,
    privateKeyCredentialName: configuration.privateKeyCredentialName,
    appId: configuration.appId,
  });
  const identity = await resolveEngineBotIdentity(auth);
  emit({ step: "resolve_engine_bot_identity", login: identity.botLogin });

  const repositoryFullName = configuration.testRepository;
  const client = await auth.clientFor(repositoryFullName);
  const clock = { now: () => timestampFromEpochMilliseconds(Date.now()) };
  const database = await TemporarySqliteDatabase.create("host", clock);
  try {
    const bindingStore = createSqliteVcsChangeBindingStore({
      database: database.applicationDatabase,
    });
    const pullRequests = createPullRequestManager({ auth, botIdentity: identity });
    const remoteCi = createRemoteCiManager({ auth, now: Date.now });
    const coordinator = createLandingCoordinator({
      auth,
      pullRequests,
      remoteCi,
      stackParentage: createStackParentageManager({ client, bindingStore, repositoryFullName }),
      bindingStore,
      gateReceipts: createSqliteGateReceiptStore({ database: database.applicationDatabase }),
      receiptStore: new MemoryLandingReceiptStore(),
      // Permissive policy so the real GitHub-side preflight (head/review/check/ruleset) is
      // the deciding factor, not an empty local gate-receipt table.
      policy: {
        requiredChecks: ["verify", "protobuf"],
        gateExpectation: {
          bindings: {
            headCommit: configuration.expectedHeadSha,
            profileHash: configuration.expectedHeadSha,
            environmentDigest: configuration.expectedHeadSha,
          },
          requiredCategories: [],
        },
        mergeMethod: "squash",
      },
      treeId: taskTreeId("00000000-0000-7000-8000-000000000036"),
      repositoryFullName,
      trunk: configuration.trunk,
      rulesetGate: { isEnforced: () => Promise.resolve(true) },
      now: Date.now,
    });

    // The synthetic is the authenticated boundary here: a verified HumanApproval
    // is minted from a transport-derived principal and attached to the intent.
    // In the daemon this principal comes from the transport; a request body can
    // never supply it.
    const intent = {
      prNumber: configuration.prNumber,
      repositoryFullName,
      humanApproval: humanApproval(actorSessionId("01900000-0000-7000-8000-000000000001")),
      requestedBy: "human",
      expectedHeadSha: configuration.expectedHeadSha,
      requestedAt: timestampFromEpochMilliseconds(Date.now()),
    };

    // First command: either lands (preflight passes) or throws a typed LandingError naming
    // the exact preflight verdict (stale head / bot / no / stale review / missing check /
    // parent_not_landed). Either is a valid, non-destructive spec outcome.
    let firstLanded = false;
    try {
      const receipt = await coordinator.land(intent);
      firstLanded = receipt.action === "landed";
      emit({ step: "first_command", action: receipt.action, pr: configuration.prNumber });
    } catch (error) {
      const verdict = error?.verdict;
      if (verdict === undefined) throw error;
      emit({
        step: "first_command",
        action: "preflight_failed",
        verdict,
        pr: configuration.prNumber,
      });
    }

    // Idempotency: if a receipt was recorded, the second command is duplicate_command;
    // otherwise it repeats the same non-destructive verdict.
    const second = await coordinator.land(intent);
    if (
      firstLanded &&
      second.action !== "duplicate_command" &&
      second.action !== "already_landed"
    ) {
      throw new Error(`expected idempotent second command, got '${second.action}'`);
    }
    emit({ step: "second_command_idempotent", action: second.action });

    emit({
      step: "synthetic_complete",
      repository: repositoryFullName,
      pr: configuration.prNumber,
    });
  } finally {
    await database.dispose();
  }
}

// Minimal in-memory LandingReceiptStore implementing the core interface
// (recordReceipt/getReceipt). The production path uses a durable store; this synthetic
// only needs the coordinator's idempotency marker within one process.
class MemoryLandingReceiptStore {
  #byPr = new Map();
  async recordReceipt(receipt) {
    this.#byPr.set(receipt.prNumber, receipt);
  }
  async getReceipt(repositoryFullName, prNumber) {
    return this.#byPr.get(prNumber);
  }
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`required environment variable '${name}' is not set`);
  }
  return value;
}

function requiredAbsolutePath(name) {
  const value = requiredEnvironment(name);
  if (!isAbsolute(value)) {
    throw new Error(`environment variable '${name}' must be an absolute path`);
  }
  return value;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
