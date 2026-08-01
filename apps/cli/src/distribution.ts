/**
 * PR 52 — distribution service lifecycle.
 *
 * Real install/upgrade/rollback/uninstall/version commands that lay out a release
 * archive (produced by `scripts/build-release-archive.mjs`) under a versioned prefix,
 * install the platform service unit, and preserve data across upgrade/rollback.
 *
 * Design (per the chosen "Tarball + Node" approach):
 * - A release is laid out under `<prefix>/versions/<version>/` and a stable
 *   `<prefix>/current` symlink points at the active version. Upgrade = add a version +
 *   flip the symlink; rollback = flip back. Old versions + DB backups are retained so
 *   rollback never loses data.
 * - The systemd user unit / launchd agent template ships inside the archive with
 *   `__PREFIX__` already resolved to the install prefix; install copies it into the
 *   platform's user service location and reloads.
 * - node_modules are NOT bundled in the archive: install runs a frozen
 *   `pnpm install --prod` against the bundled lockfile, keeping the dependency graph
 *   reproducible and auditable (the SBOM in the archive names every package).
 * - Pre-upgrade DB backup: the daemon's own migration kernel already takes a verified
 *   backup on forward migration (packages/adapters/src/sqlite/migration.ts); this module
 *   adds a belt-and-suspenders file-level copy of every *.db under --home before the
 *   swap, so a rollback can restore the exact pre-upgrade bytes even if the new version
 *   never starts.
 *
 * Every shell-out uses execFile with an argv array (never a shell string).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  constants,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const PLATFORM_UNIT_NAME = "minions.service";
const LAUNCHD_LABEL = "dev.minions.daemon";
const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`;
const DEFAULT_PREFIX = "/opt/minions";
const VERSION_PATTERN = /^minions-(.+)-(?:macos|linux)-[a-z0-9_]+\.tar\.gz$/u;

const execFileAsync = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 1_024 * 1_024 }, (error, stdout) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error("child process failed"));
        return;
      }
      resolve(stdout);
    });
  });

export interface InstallOptions {
  readonly archive: string;
  readonly prefix: string;
  readonly home: string;
}

export async function install(options: InstallOptions): Promise<number> {
  const stagingVersion = await verifyAndExtract(options.archive, options.prefix);
  const versionDirectory = join(options.prefix, "versions", stagingVersion);
  await installDependencies(versionDirectory);
  await activateVersion(options.prefix, stagingVersion);
  await installPlatformUnit(versionDirectory);
  emit({ action: "installed", version: stagingVersion, prefix: options.prefix });
  return 0;
}

export async function upgrade(options: InstallOptions): Promise<number> {
  await backupDatabases(options.home);
  const stagingVersion = await verifyAndExtract(options.archive, options.prefix);
  const versionDirectory = join(options.prefix, "versions", stagingVersion);
  await installDependencies(versionDirectory);
  await activateVersion(options.prefix, stagingVersion);
  await installPlatformUnit(versionDirectory);
  emit({
    action: "upgraded",
    version: stagingVersion,
    prefix: options.prefix,
    note: "pre-upgrade databases backed up; previous version retained for rollback",
  });
  return 0;
}

export interface RollbackOptions {
  readonly prefix: string;
  readonly home: string;
}

export async function rollback(options: RollbackOptions): Promise<number> {
  const versionsDirectory = join(options.prefix, "versions");
  const current = await readCurrentVersion(options.prefix);
  const installed = await listVersions(versionsDirectory);
  const previous = previousVersion(installed, current);
  if (previous === undefined) {
    throw new Error(`no previous version to roll back to (current: ${current ?? "none"})`);
  }
  await activateVersion(options.prefix, previous);
  await restoreLatestDatabaseBackup(options.home);
  emit({ action: "rolled_back", from: current ?? "none", to: previous, prefix: options.prefix });
  return 0;
}

export interface UninstallOptions {
  readonly prefix: string;
  readonly home: string;
  readonly purge: boolean;
}

export async function uninstall(options: UninstallOptions): Promise<number> {
  await removePlatformUnit();
  await rm(options.prefix, { recursive: true, force: true });
  if (options.purge) {
    await rm(options.home, { recursive: true, force: true });
    emit({ action: "uninstalled", prefix: options.prefix, home: options.home, purged: true });
  } else {
    emit({
      action: "uninstalled",
      prefix: options.prefix,
      home: options.home,
      purged: false,
      note: "data home preserved (use --purge to remove it)",
    });
  }
  return 0;
}

export async function version(): Promise<number> {
  const pkg = await readPackageJson();
  emit({
    name: pkg.name,
    version: pkg.version,
    prefix: process.env["MINIONS_INSTALL_PREFIX"] ?? DEFAULT_PREFIX,
  });
  return 0;
}

// --- internals ---

async function verifyAndExtract(archive: string, prefix: string): Promise<string> {
  await access(archive, constants.R_OK);
  const checksumSidecar = `${archive}.sha256`;
  try {
    const sidecar = await readFile(checksumSidecar, "utf8");
    const expected = sidecar.trim().split(/\s+/u)[0];
    if (expected !== undefined && expected.length > 0) {
      const archiveBytes = await readFile(archive);
      const actual = createHash("sha256").update(archiveBytes).digest("hex");
      if (actual !== expected) {
        throw new Error(`archive checksum mismatch: expected ${expected}, got ${actual}`);
      }
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    // No sidecar present — skip verification (best-effort).
  }
  const stagingVersion = deriveVersion(archive);
  const versionDirectory = join(prefix, "versions", stagingVersion);
  await mkdir(versionDirectory, { recursive: true });
  await execFileAsync("tar", ["-xzf", archive, "-C", versionDirectory]);
  return stagingVersion;
}

function deriveVersion(archive: string): string {
  const base = archive.split("/").pop() ?? archive;
  // minions-<version>-<platform>.tar.gz → <version> (version may contain '+').
  const match = VERSION_PATTERN.exec(base);
  return match?.[1] ?? base.replace(/\.tar\.gz$/u, "");
}

async function installDependencies(versionDirectory: string): Promise<void> {
  // The archive ships the lockfile but not node_modules; a frozen prod install
  // reconstructs it reproducibly. Skipped if the bundle already includes node_modules.
  try {
    await access(join(versionDirectory, "node_modules"), constants.R_OK);
    return;
  } catch {
    // fall through to install
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      "pnpm",
      ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: versionDirectory, encoding: "utf8", maxBuffer: 4 * 1_024 * 1_024 },
      (error) => {
        if (error !== null) {
          reject(error instanceof Error ? error : new Error("child process failed"));
        } else {
          resolve();
        }
      },
    );
  });
}

async function activateVersion(prefix: string, version: string): Promise<void> {
  const currentLink = join(prefix, "current");
  await rm(currentLink, { force: true });
  await symlink(join(prefix, "versions", version), currentLink);
}

async function installPlatformUnit(versionDirectory: string): Promise<void> {
  const unitSource = join(versionDirectory, "distribution", PLATFORM_UNIT_NAME);
  if (process.platform === "linux") {
    const userUnitDirectory = join(homedir(), ".config", "systemd", "user");
    await mkdir(userUnitDirectory, { recursive: true });
    await copyFile(unitSource, join(userUnitDirectory, PLATFORM_UNIT_NAME));
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  if (process.platform === "darwin") {
    const launchAgents = join(homedir(), "Library", "LaunchAgents");
    await mkdir(launchAgents, { recursive: true });
    const plistSource = join(versionDirectory, "distribution", "minions.plist");
    await copyFile(plistSource, join(launchAgents, LAUNCHD_PLIST_NAME));
    await execFileAsync("launchctl", ["load", join(launchAgents, LAUNCHD_PLIST_NAME)]);
    return;
  }
  throw new Error(`no service supervisor available on platform '${process.platform}'`);
}

async function removePlatformUnit(): Promise<void> {
  if (process.platform === "linux") {
    const unitPath = join(homedir(), ".config", "systemd", "user", PLATFORM_UNIT_NAME);
    await execFileAsync("systemctl", ["--user", "stop", PLATFORM_UNIT_NAME]).catch(() => undefined);
    await execFileAsync("systemctl", ["--user", "disable", PLATFORM_UNIT_NAME]).catch(
      () => undefined,
    );
    await rm(unitPath, { force: true });
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return;
  }
  if (process.platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", LAUNCHD_PLIST_NAME);
    await execFileAsync("launchctl", ["unload", plistPath]).catch(() => undefined);
    await rm(plistPath, { force: true });
  }
}

async function readCurrentVersion(prefix: string): Promise<string | undefined> {
  try {
    const target = await readlink(join(prefix, "current"));
    return target.split("/").pop();
  } catch {
    return undefined;
  }
}

async function listVersions(versionsDirectory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(versionsDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function previousVersion(
  sorted: readonly string[],
  current: string | undefined,
): string | undefined {
  if (current === undefined) return sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
  const index = sorted.indexOf(current);
  return index > 0 ? sorted[index - 1] : undefined;
}

async function backupDatabases(home: string): Promise<void> {
  const backupRoot = join(home, "backup");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupDirectory = join(backupRoot, `pre-upgrade-${stamp}`);
  await mkdir(backupDirectory, { recursive: true });
  await copyDatabaseFiles(home, backupDirectory);
}

async function restoreLatestDatabaseBackup(home: string): Promise<void> {
  const backupRoot = join(home, "backup");
  const entries = await listVersions(backupRoot);
  if (entries.length === 0) {
    return; // nothing to restore — rollback keeps the current DB.
  }
  const latest = entries[entries.length - 1];
  if (latest === undefined) {
    return;
  }
  const backupDirectory = join(backupRoot, latest);
  await copyDatabaseFiles(backupDirectory, home);
}

/** Copy every *.db found under `source` to the same relative path under `destination`. */
async function copyDatabaseFiles(source: string, destination: string): Promise<void> {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyDatabaseFiles(sourcePath, destinationPath);
    } else if (entry.name.endsWith(".db")) {
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }
  }
}

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

async function readPackageJson(): Promise<PackageMetadata> {
  const here = dirname(new URL(import.meta.url).pathname);
  // apps/cli/src/distribution.ts → repo root package.json (../../..), fall back to the
  // installed package.json sibling if present.
  const candidates = [
    join(here, "..", "..", "..", "package.json"),
    join(here, "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      return Object.freeze({
        name: typeof raw.name === "string" ? raw.name : "minions",
        version: typeof raw.version === "string" ? raw.version : "0.0.0",
      });
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return Object.freeze({ name: "minions", version: "0.0.0" });
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
