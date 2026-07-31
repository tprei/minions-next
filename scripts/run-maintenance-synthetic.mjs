import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  MaintenanceService,
  RecoveryActionKind,
  RecoveryActionState,
  RecoveryService,
  SystemService,
} from "@minions/contracts";

/**
 * Synthetic 20 (PR 56 — maintenance-elevation-recovery, PRD synthetic scenario 20):
 * "Stop the primary scheduler/API, launch the supervisor maintenance agent, capture
 * diagnostics, elevate one restart action, and import the audit receipt after
 * recovery."
 *
 * Runs a real `minions start` daemon under a real systemd user unit (matching
 * `scripts/distribution/minions.service`'s unit name, since
 * `apps/daemon/src/recovery-restart.ts` hardcodes `minions.service` as the target
 * it restarts) — proves the elevation-grant -> execute-recovery-action -> real
 * `systemctl --user restart` path end-to-end, and that the executed action's
 * receipt survives the very process restart it caused (the recovery store is
 * SQLite, not in-memory).
 *
 * Explicitly out of scope (see `apps/daemon/src/recovery-service.ts`'s own doc
 * comment): the other 8 `RecoveryActionKind`s have no adapter in this revision —
 * only `restart` is exercised here, matching the one synthetic scenario this
 * revision's spec names (synthetic 20). Their fail-closed rejection paths
 * (expired/wrong-actor/unapproved/wrong-kind grants, and the honest "no adapter"
 * rejection for unimplemented kinds) are covered by
 * `test/unit/core/recovery-action.test.ts` and `test/integration/recovery-service.test.ts`,
 * not re-proven here against a real process.
 */

const SYSTEMD_UNIT = "minions.service";
const PRIMARY_TARGET = "primary-daemon";
const DAEMON_PORT = 58743;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const RESTART_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDirectory, "..");
const cliEntrypoint = join(repoRoot, "apps/cli/dist/index.js");
const unitPath = join(homedir(), ".config", "systemd", "user", `${SYSTEMD_UNIT}`);
const unitBackupPath = `${unitPath}.synthetic-backup`;

await main();

async function main() {
  const teardown = [];
  try {
    await assertLinuxSystemdHost();
    await assertCliBuilt();
    const home = await mkdtemp(join(tmpdir(), "minions-maintenance-synthetic-"));
    teardown.push(() => rm(home, { recursive: true, force: true }));

    await backUpExistingUnit();
    teardown.push(restoreBackedUpUnit);

    await installUnit(home);
    teardown.push(uninstallUnit);

    log("Starting the primary daemon under a real systemd user unit...");
    await systemctl(["start", SYSTEMD_UNIT]);
    teardown.push(() => systemctl(["stop", SYSTEMD_UNIT]).catch(() => undefined));
    const baseUrl = `http://127.0.0.1:${String(DAEMON_PORT)}`;
    const firstInstanceId = await waitForHealth(baseUrl, HEALTH_TIMEOUT_MS);
    log(`Primary daemon healthy (instance ${firstInstanceId}).`);

    log("Launching the supervisor maintenance agent and capturing diagnostics...");
    const maintenanceTransport = createConnectTransport({
      baseUrl,
      httpVersion: "1.1",
      nodeOptions: { agent: false },
    });
    const maintenance = createClient(MaintenanceService, maintenanceTransport);
    const { session } = await maintenance.startSession({ toolName: "doctor" });
    const { output, exitCode } = await maintenance.runTool({
      sessionId: session.sessionId,
      toolName: "doctor",
      args: [],
    });
    if (exitCode !== 0) {
      throw new Error(`maintenance doctor tool exited ${String(exitCode)}: ${output}`);
    }
    log(`Diagnostics captured (doctor exit 0, ${String(output.length)} bytes of output).`);

    log("Requesting elevation for one restart action...");
    const recoveryTransport = createConnectTransport({
      baseUrl,
      httpVersion: "1.1",
      nodeOptions: { agent: false },
    });
    const recovery = createClient(RecoveryService, recoveryTransport);
    const actorSessionId = randomUUID();
    const { grant } = await recovery.requestElevation({
      requestedBySessionId: actorSessionId,
      requestedKinds: [RecoveryActionKind.RESTART],
      justification: "synthetic 20: recover primary API after simulated outage",
    });
    if (grant.state !== 2 /* ElevationGrantState.APPROVED */) {
      throw new Error(
        `grant did not auto-approve under a 1-required-approval profile: ${grant.state}`,
      );
    }
    log(`Grant ${grant.id} approved (${String(grant.approvalsReceived)} approval).`);

    log("Executing the restart recovery action against the primary daemon...");
    const actionExpiresAt = create(TimestampSchema, {
      seconds: BigInt(Math.floor(Date.now() / 1000) + 60),
      nanos: 0,
    });
    const { action } = await recovery.executeRecoveryAction({
      grantId: grant.id,
      actorSessionId,
      action: {
        kind: RecoveryActionKind.RESTART,
        target: PRIMARY_TARGET,
        expectedState: "primary_daemon_restarted",
        expiresAt: actionExpiresAt,
      },
    });
    if (action.state !== RecoveryActionState.EXECUTED) {
      throw new Error(
        `recovery action did not execute: state=${String(action.state)} failure=${action.failure ?? "none"}`,
      );
    }
    log(`Recovery action ${action.id} executed (systemctl --user restart ${SYSTEMD_UNIT}).`);

    log("Waiting for the primary daemon to come back up after the real restart...");
    const secondInstanceId = await waitForRestart(baseUrl, firstInstanceId, RESTART_TIMEOUT_MS);
    log(`Primary daemon back online (instance ${secondInstanceId}).`);

    log(
      "Importing the audit receipt after recovery (ListRecoveryActions on the restarted daemon)...",
    );
    const postRestartRecovery = createClient(
      RecoveryService,
      createConnectTransport({ baseUrl, httpVersion: "1.1", nodeOptions: { agent: false } }),
    );
    const { actions } = await postRestartRecovery.listRecoveryActions({
      target: PRIMARY_TARGET,
      pageSize: 10,
    });
    const receipt = actions.find((candidate) => candidate.id === action.id);
    if (receipt === undefined) {
      throw new Error(
        `executed action ${action.id} did not survive the restart it caused (receipt not found)`,
      );
    }
    if (receipt.state !== RecoveryActionState.EXECUTED) {
      throw new Error(`receipt state changed across restart: ${String(receipt.state)}`);
    }
    log(`Receipt imported: action ${receipt.id} still EXECUTED after recovery.`);
    // The maintenance session created before the restart is intentionally not ended
    // here: MaintenanceService's session/journal store is documented as in-memory
    // and ephemeral (apps/daemon/src/maintenance-service.ts), so it does not survive
    // the very daemon restart this synthetic just proved — there is no live session
    // left to end, and that is correct, not a leak.

    log("Synthetic 20 (maintenance elevation-recovery) passed.");
  } finally {
    for (const step of teardown.reverse()) {
      await step().catch((error) => {
        process.stderr.write(`teardown step failed (continuing): ${formatError(error)}\n`);
      });
    }
  }
}

async function assertLinuxSystemdHost() {
  if (process.platform !== "linux") {
    throw new Error(
      `synthetic:maintenance requires a Linux host with a systemd user session (platform: ${process.platform})`,
    );
  }
  try {
    await execFileAsync("systemctl", ["--user", "status"], { timeout: 5_000 });
  } catch (error) {
    throw new Error(
      `no active systemd user session detected — required to install and drive ${SYSTEMD_UNIT}: ${formatError(error)}`,
      { cause: error },
    );
  }
}

async function assertCliBuilt() {
  try {
    await readFile(cliEntrypoint);
  } catch {
    throw new Error(
      `apps/cli is not built (missing ${cliEntrypoint}) — run 'pnpm build' before this synthetic`,
    );
  }
}

async function backUpExistingUnit() {
  try {
    const existing = await readFile(unitPath, "utf8");
    await writeFile(unitBackupPath, existing, "utf8");
    log(`Backed up a pre-existing ${SYSTEMD_UNIT} unit before installing the synthetic one.`);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

async function restoreBackedUpUnit() {
  try {
    const backedUp = await readFile(unitBackupPath, "utf8");
    await writeFile(unitPath, backedUp, "utf8");
    await rm(unitBackupPath, { force: true });
    await systemctl(["daemon-reload"]);
    log(`Restored the pre-existing ${SYSTEMD_UNIT} unit.`);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

async function installUnit(home) {
  await mkdir(dirname(unitPath), { recursive: true });
  const unit = [
    "[Unit]",
    "Description=Minions synthetic:maintenance test instance",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${process.execPath} ${cliEntrypoint} start --home ${home} --port ${String(DAEMON_PORT)}`,
    "Restart=no",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  await writeFile(unitPath, unit, "utf8");
  await systemctl(["daemon-reload"]);
}

async function uninstallUnit() {
  await systemctl(["stop", SYSTEMD_UNIT]).catch(() => undefined);
  await rm(unitPath, { force: true });
}

async function systemctl(args) {
  await execFileAsync("systemctl", ["--user", ...args], { timeout: 10_000 });
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const system = createClient(
    SystemService,
    createConnectTransport({ baseUrl, httpVersion: "1.1", nodeOptions: { agent: false } }),
  );
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await system.getHealth({});
      if (health.instanceId !== undefined && health.instanceId.length > 0) {
        return health.instanceId;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `primary daemon did not become healthy within ${String(timeoutMs)}ms: ${lastError ? formatError(lastError) : "no response"}`,
  );
}

async function waitForRestart(baseUrl, previousInstanceId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const system = createClient(
    SystemService,
    createConnectTransport({ baseUrl, httpVersion: "1.1", nodeOptions: { agent: false } }),
  );
  let sawGap = false;
  while (Date.now() < deadline) {
    try {
      const health = await system.getHealth({});
      if (health.instanceId !== previousInstanceId) {
        return health.instanceId;
      }
    } catch {
      // Expected briefly while systemd tears the old process down and starts the new one.
      sawGap = true;
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `primary daemon did not report a new instance id within ${String(timeoutMs)}ms after restart` +
      (sawGap
        ? " (did observe a connection gap, but health never returned)"
        : " (connection never dropped — was the process actually restarted?)"),
  );
}

function isMissingPathError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
