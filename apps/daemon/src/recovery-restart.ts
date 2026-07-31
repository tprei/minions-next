import { execFile, spawn } from "node:child_process";

import type { StructuredLogger } from "./logger.js";

/**
 * Recovery-action restart adapter (PR 56 — maintenance-elevation-recovery).
 *
 * Executes the `restart` recovery-action kind against the primary daemon process by
 * shelling out to whichever service supervisor PR 52's distribution assets installed:
 * the systemd user unit `minions.service` (`scripts/distribution/minions.service`) on
 * Linux, or the launchd agent `dev.minions.daemon` (`scripts/distribution/minions.plist`)
 * on macOS. Detection is genuine (queries the supervisor for the unit's live state)
 * rather than assumed from the platform alone — an installed-but-inactive unit, or no
 * unit at all, fails closed with a named error instead of silently no-op'ing.
 */
export type RecoveryRestartTarget = "primary-daemon";

export interface RecoveryRestarter {
  restart(target: RecoveryRestartTarget): Promise<void>;
}

export type CreateSystemRecoveryRestarterOptions = Readonly<{
  logger: StructuredLogger;
}>;

/** systemd user unit name installed by `scripts/distribution/minions.service`. */
const SYSTEMD_UNIT = "minions.service";
/** launchd agent label installed by `scripts/distribution/minions.plist`. */
const LAUNCHD_LABEL = "dev.minions.daemon";

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 65_536;

const NOT_DETECTED_MESSAGE =
  "no systemd user service or launchd agent detected for minions; cannot restart automatically";

export function createSystemRecoveryRestarter(
  options: CreateSystemRecoveryRestarterOptions,
): RecoveryRestarter {
  const { logger } = options;
  return {
    restart: (target: RecoveryRestartTarget) => restartTarget(target, logger),
  };
}

async function restartTarget(
  target: RecoveryRestartTarget,
  logger: StructuredLogger,
): Promise<void> {
  if (process.platform === "linux") {
    return restartViaSystemd(target, logger);
  }
  if (process.platform === "darwin") {
    return restartViaLaunchd(target, logger);
  }
  logger.log("error", "recovery_restart_no_supervisor", { target, platform: process.platform });
  throw new Error(`${NOT_DETECTED_MESSAGE} (unsupported platform '${process.platform}')`);
}

async function restartViaSystemd(
  target: RecoveryRestartTarget,
  logger: StructuredLogger,
): Promise<void> {
  const status = await runCommand("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
  const active = status.exitCode === 0 && status.stdout.trim() === "active";
  if (!active) {
    logger.log("error", "recovery_restart_no_supervisor", {
      target,
      supervisor: "systemd",
      unit: SYSTEMD_UNIT,
    });
    throw new Error(`${NOT_DETECTED_MESSAGE} (systemd user unit '${SYSTEMD_UNIT}' is not active)`);
  }
  logger.log("info", "recovery_restart_invoking", {
    target,
    supervisor: "systemd",
    unit: SYSTEMD_UNIT,
  });
  // Never invoke `systemctl restart` on the daemon's own unit directly: the daemon
  // process (and this execFile child) live inside that unit's cgroup, so systemd
  // SIGTERMs this very command mid-flight as part of tearing the unit down before
  // it can report success — observed empirically as a synchronous restart racing
  // its own teardown and resolving with an unusable exit code. `systemd-run
  // --no-block` submits the restart as a new, independent transient unit and
  // returns as soon as it is queued (well before systemd starts stopping this
  // unit), so this command completes cleanly before any SIGTERM arrives.
  // `--collect` unloads the transient unit once it finishes so nothing leaks.
  const result = await runCommand("systemd-run", [
    "--user",
    "--collect",
    "--no-block",
    "--",
    "systemctl",
    "--user",
    "restart",
    SYSTEMD_UNIT,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `systemd-run --user --collect --no-block -- systemctl --user restart ${SYSTEMD_UNIT} failed to queue with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }
  logger.log("info", "recovery_restart_invoked", {
    target,
    supervisor: "systemd",
    unit: SYSTEMD_UNIT,
  });
}

async function restartViaLaunchd(
  target: RecoveryRestartTarget,
  logger: StructuredLogger,
): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) {
    logger.log("error", "recovery_restart_no_supervisor", {
      target,
      supervisor: "launchd",
      label: LAUNCHD_LABEL,
    });
    throw new Error(`${NOT_DETECTED_MESSAGE} (unable to resolve current user id)`);
  }
  const service = `gui/${String(uid)}/${LAUNCHD_LABEL}`;
  const status = await runCommand("launchctl", ["print", service]);
  if (status.exitCode !== 0) {
    logger.log("error", "recovery_restart_no_supervisor", {
      target,
      supervisor: "launchd",
      label: LAUNCHD_LABEL,
    });
    throw new Error(`${NOT_DETECTED_MESSAGE} (launchd agent '${LAUNCHD_LABEL}' is not loaded)`);
  }
  logger.log("info", "recovery_restart_invoking", {
    target,
    supervisor: "launchd",
    label: LAUNCHD_LABEL,
  });
  // Same self-teardown race as the systemd path (see restartViaSystemd): this
  // process is a child of the very job `kickstart -k` is about to kill, so a
  // synchronous execFile that waits for `launchctl` to exit can be torn down
  // before it reports success. macOS has no `systemd-run`-equivalent detached
  // launcher, so spawn `launchctl` detached from this process group and don't
  // wait for it to exit — best-effort mitigation of the same race, not
  // empirically verified against a real launchd (no macOS host in this repo's
  // CI or dev environment).
  await runDetachedCommand("launchctl", ["kickstart", "-k", service]);
  logger.log("info", "recovery_restart_invoked", {
    target,
    supervisor: "launchd",
    label: LAUNCHD_LABEL,
  });
}

type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/**
 * Runs `command` with `args` via `execFile` (never a shell — argv array only, no string
 * interpolation) with a bounded timeout. Resolves with the exit code + captured output
 * for any process that actually ran and exited (including non-zero exits, which callers
 * inspect themselves); rejects only when the process could not be run at all or was
 * killed for exceeding `COMMAND_TIMEOUT_MS`.
 */
function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  execFile(
    command,
    args,
    {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
      shell: false,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
    },
    (error, stdout, stderr) => {
      if (error !== null) {
        const processError = error as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: number | string | null;
        };
        if (processError.killed === true) {
          reject(
            new Error(
              `command '${command} ${args.join(" ")}' timed out after ${String(COMMAND_TIMEOUT_MS)}ms`,
            ),
          );
          return;
        }
        if (processError.code === "ENOENT") {
          resolve({ exitCode: -1, stdout, stderr: processError.message });
          return;
        }
        const exitCode = typeof processError.code === "number" ? processError.code : -1;
        resolve({ exitCode, stdout, stderr });
        return;
      }
      resolve({ exitCode: 0, stdout, stderr });
    },
  );
  return promise;
}

/**
 * Spawns `command` with `args` detached from this process (new session, ignored
 * stdio) and does not wait for it to exit — for commands that may kill this very
 * process's job/unit as a side effect, where waiting synchronously risks the wait
 * itself being torn down before it observes success. Resolves once the process has
 * been handed to the OS (or rejects if it could not be spawned at all, e.g. ENOENT);
 * never reports the detached command's own exit code.
 */
function runDetachedCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
