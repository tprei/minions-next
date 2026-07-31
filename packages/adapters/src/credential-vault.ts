/**
 * Per-host credential vault — owner-only storage for the OMP auth-broker control
 * bearer and any other secret that must survive a process/machine restart without
 * entering a harness process.
 *
 * ## Backend selection (PR 19, §10.5)
 * - macOS: `/usr/bin/security add-generic-password`/`find-generic-password` against a
 *   per-host service account (`minions.<hostId>`).
 * - Linux/WSL2: `systemd-creds encrypt/decrypt` with `--with-key=host` (no TPM
 *   dependency). The encrypted credential file is stored owner-only (0600); the
 *   plaintext is held only transiently in memory and never logged.
 *
 * The factory probes availability fail-closed: a host whose selected backend is
 * absent cannot register (acceptance 11: "missing secure credential storage fails
 * host registration"). Secrets are kept as `Uint8Array`/`string` in memory only
 * for the duration of a `put`/`get` call; nothing is logged.
 *
 * ## Empirical deviation (documented for reviewers)
 * `systemd-creds --with-key=host` requires read access to the root-only
 * `/var/lib/systemd/credential.secret`. On hosts where the daemon cannot run as
 * root (e.g. a developer WSL2 account), `host` mode is unavailable and the
 * operator MUST explicitly opt into a working mode via `systemdCredsKeyMode`.
 * The vault NEVER silently falls back: the default is `host`, and a `put` against
 * an inaccessible key surfaces `backend_failed`. Doctor and `probe()` report the
 * selected mode in `detail` so an insecure selection is observable.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { statSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type CredentialVaultErrorCode =
  "vault_unavailable" | "invalid_name" | "not_found" | "backend_failed" | "permission_invalid";

export type CredentialVaultBackend = "systemd-creds" | "macos-keychain";

export class CredentialVaultError extends Error {
  readonly code: CredentialVaultErrorCode;
  readonly backend: CredentialVaultBackend;

  constructor(
    code: CredentialVaultErrorCode,
    backend: CredentialVaultBackend,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CredentialVaultError";
    this.code = code;
    this.backend = backend;
  }
}

export type CredentialVaultProbeResult = Readonly<{
  available: boolean;
  backend: CredentialVaultBackend;
  detail: string;
}>;

/**
 * systemd-creds `--with-key=` mode. The default `"host"` matches PR 19 §10.5
 * (no TPM dependency, portable across reboots of the same host). The host key
 * lives at `/var/lib/systemd/credential.secret` and is root-only.
 */
export type SystemdCredsKeyMode =
  "host" | "tpm2" | "host+tpm2" | "tpm2-absent" | "auto" | "auto-initrd";

export interface CredentialVault {
  readonly backend: CredentialVaultBackend;
  /** Store `secret` under `name`. Overwrites prior content. Refuses invalid names. */
  put(name: string, secret: Uint8Array): Promise<void>;
  /** Read `name`. Throws `not_found` when absent. Validates at-rest permissions. */
  get(name: string): Promise<Uint8Array>;
  /** Remove `name`. Idempotent (no error when the entry is already absent). */
  delete(name: string): Promise<void>;
  /** Best-effort availability probe — never throws. */
  probe(): CredentialVaultProbeResult;
}

export type CredentialVaultOptions = Readonly<{
  /** Directory holding the encrypted credential files (systemd-creds backend only). */
  storeDirectory?: string;
  /** Override path to the `systemd-creds` binary (testing/diagnostics). */
  systemdCredsPath?: string;
  /** Override path to the macOS `security` binary (testing/diagnostics). */
  securityPath?: string;
  /** `systemd-creds --with-key=` mode (default `"host"`). */
  systemdCredsKeyMode?: SystemdCredsKeyMode;
}>;

const ownerOnlyFileMode = 0o600;
const ownerOnlyDirMode = 0o700;
// systemd-creds credential names: ASCII, no `/`, no leading `-`. Restricted to a
// safe portable subset; max 180 chars keeps the on-disk filename + namespace prefix
// comfortably under common filesystem limits.
const credentialNamePattern = /^[A-Za-z0-9._-]{1,180}$/u;
const defaultSystemdCredsPath = "/usr/bin/systemd-creds";
const defaultSecurityPath = "/usr/bin/security";

/**
 * Select a vault backend for `hostId` based on the current platform and probe its
 * availability. Throws `vault_unavailable` fail-closed when the platform backend
 * is missing — this is the registration gate from acceptance 11.
 */
export function createCredentialVault(
  hostId: string,
  options: CredentialVaultOptions = {},
): CredentialVault {
  if (process.platform === "darwin") {
    return new KeychainVault(hostId, options.securityPath ?? defaultSecurityPath);
  }
  // P1 (review #20): 'tpm2-absent' tells systemd-creds to encrypt with a
  // zero-length key - no confidentiality or authentication at all, so the
  // credential vault is effectively stored in the clear. Reject it fail
  // closed rather than silently accepting a non-encrypting mode; the
  // operator must pick a mode that actually protects the vault (host,
  // tpm2, host+tpm2, auto, auto-initrd).
  const keyMode = options.systemdCredsKeyMode ?? "host";
  if (keyMode === "tpm2-absent") {
    throw new CredentialVaultError(
      "vault_unavailable",
      "systemd-creds",
      "systemdCredsKeyMode 'tpm2-absent' stores the vault unencrypted at rest and is refused",
    );
  }
  return new SystemdCredentialVault(
    hostId,
    options.systemdCredsPath ?? defaultSystemdCredsPath,
    options.storeDirectory ?? join(homedir(), ".local", "share", "minions", "vault", hostId),
    keyMode,
  );
}

// -------------------------------------------------------------------------------------------------
// systemd-creds backend (Linux/WSL2).
// -------------------------------------------------------------------------------------------------

class SystemdCredentialVault implements CredentialVault {
  readonly backend = "systemd-creds" as const;

  constructor(
    private readonly hostId: string,
    private readonly systemdCredsPath: string,
    private readonly storeDirectory: string,
    private readonly keyMode: SystemdCredsKeyMode,
  ) {}

  async put(name: string, secret: Uint8Array): Promise<void> {
    assertValidName(name);
    const probe = this.probe();
    if (!probe.available) {
      throw new CredentialVaultError("vault_unavailable", this.backend, probe.detail);
    }
    await mkdir(this.storeDirectory, { recursive: true, mode: ownerOnlyDirMode });
    await enforceOwnerOnlyDirectory(this.storeDirectory);

    const plaintext = await writeTransientPlaintext(secret);
    const plaintextDir = dirname(plaintext);
    // F5: stage the ciphertext inside a 0700 workDir under the store directory
    // (same filesystem → atomic rename) so the cipher is unreachable to other
    // users during the brief default-umask window before chmod. systemd-creds
    // re-creates the output file (ignoring any pre-existing mode), so we cannot
    // pre-create the cipher at 0600; the 0700 workDir is the access-control
    // boundary. We still chmod 0600 BEFORE the atomic rename, so the cipher is
    // owner-only from the moment it becomes visible at its final path.
    const workDir = await mkdtemp(join(this.storeDirectory, ".put-"));
    await chmod(workDir, ownerOnlyDirMode);
    const tempCipher = join(workDir, "cipher.cred");
    try {
      const cipherPath = this.cipherPath(name);
      const args = [
        "encrypt",
        `--name=${this.credentialName(name)}`,
        `--with-key=${this.keyMode}`,
        plaintext,
        tempCipher,
      ];
      await this.invokeSystemdCreds(args, "encrypt");
      await chmod(tempCipher, ownerOnlyFileMode);
      await rename(tempCipher, cipherPath);
    } finally {
      // F4: overwrite the plaintext with zeros and fsync before unlink so freed
      // blocks do not retain the secret, then remove the plaintext temp dir AND
      // the cipher workDir (previously only the plaintext FILE was removed,
      // orphaning both directories).
      await shredFile(plaintext);
      await rm(plaintextDir, { force: true, recursive: true });
      await rm(workDir, { force: true, recursive: true });
    }
  }

  async get(name: string): Promise<Uint8Array> {
    assertValidName(name);
    const probe = this.probe();
    if (!probe.available) {
      throw new CredentialVaultError("vault_unavailable", this.backend, probe.detail);
    }
    const cipherPath = this.cipherPath(name);
    let info: Stats;
    try {
      info = await stat(cipherPath);
    } catch (error: unknown) {
      if (isEnoent(error)) {
        throw new CredentialVaultError("not_found", this.backend, `credential absent: ${name}`);
      }
      throw new CredentialVaultError(
        "backend_failed",
        this.backend,
        `cannot stat credential ${name}: ${errorToString(error)}`,
        { cause: error },
      );
    }
    if ((info.mode & 0o777) !== ownerOnlyFileMode) {
      throw new CredentialVaultError(
        "permission_invalid",
        this.backend,
        `credential ${name} mode ${info.mode.toString(8)} is not owner-only (0600)`,
      );
    }
    // F9: also enforce the store DIRECTORY is owner-only (0700). put() enforces
    // this on every write; get() rejects on drift rather than silently fixing, so
    // a permissions regression on the store dir is observable on the read path.
    await this.assertOwnerOnlyStoreDirectory();
    const args = ["decrypt", `--name=${this.credentialName(name)}`, cipherPath];
    const result = await this.invokeSystemdCreds(args, "decrypt");
    return result.stdout;
  }

  async delete(name: string): Promise<void> {
    assertValidName(name);
    try {
      await rm(this.cipherPath(name), { force: true });
    } catch (error: unknown) {
      throw new CredentialVaultError(
        "backend_failed",
        this.backend,
        `cannot delete credential ${name}: ${errorToString(error)}`,
        { cause: error },
      );
    }
  }

  probe(): CredentialVaultProbeResult {
    let info: Stats;
    try {
      info = statSync(this.systemdCredsPath);
    } catch (error: unknown) {
      return {
        available: false,
        backend: this.backend,
        detail: `systemd-creds probe failed: ${errorToString(error)}`,
      };
    }
    if (!info.isFile()) {
      return {
        available: false,
        backend: this.backend,
        detail: `systemd-creds binary not a regular file at ${this.systemdCredsPath}`,
      };
    }
    return {
      available: true,
      backend: this.backend,
      detail: `systemd-creds at ${this.systemdCredsPath}, store ${this.storeDirectory}, key=${this.keyMode}`,
    };
  }

  private cipherPath(name: string): string {
    return join(this.storeDirectory, `${name}.cred`);
  }

  private credentialName(name: string): string {
    return `minions.${this.hostId}.${name}`;
  }

  private async assertOwnerOnlyStoreDirectory(): Promise<void> {
    let info: Stats;
    try {
      info = await stat(this.storeDirectory);
    } catch (error: unknown) {
      // The cipher file stat above succeeded, so the store directory MUST exist;
      // any error here is a genuine backend failure.
      throw new CredentialVaultError(
        "backend_failed",
        this.backend,
        `cannot stat credential store directory ${this.storeDirectory}: ${errorToString(error)}`,
        { cause: error },
      );
    }
    if ((info.mode & 0o777) !== ownerOnlyDirMode) {
      throw new CredentialVaultError(
        "permission_invalid",
        this.backend,
        `credential store directory ${this.storeDirectory} mode ${info.mode.toString(8)} is not owner-only (0700)`,
      );
    }
  }

  private async invokeSystemdCreds(
    args: readonly string[],
    action: string,
  ): Promise<{ stdout: Uint8Array; stderr: string }> {
    const result = await runChild(this.systemdCredsPath, args, {
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new CredentialVaultError(
        "backend_failed",
        this.backend,
        `systemd-creds ${action} failed (exit ${String(result.exitCode)}): ${bytesToString(result.stderr).trim()}`,
      );
    }
    return { stdout: result.stdout, stderr: bytesToString(result.stderr) };
  }
}

// -------------------------------------------------------------------------------------------------
// macOS Keychain backend.
// -------------------------------------------------------------------------------------------------

class KeychainVault implements CredentialVault {
  readonly backend = "macos-keychain" as const;

  constructor(
    private readonly hostId: string,
    private readonly securityPath: string,
  ) {}

  async put(name: string, secret: Uint8Array): Promise<void> {
    assertValidName(name);
    this.requireAvailable();
    const args = [
      "add-generic-password",
      "-s",
      this.service(),
      "-a",
      name,
      "-w",
      bytesToString(secret),
      "-U",
    ];
    const result = await runChild(this.securityPath, args, {
      maxStdoutBytes: 4 * 1024,
      maxStderrBytes: 4 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new CredentialVaultError(
        "backend_failed",
        this.backend,
        `security add-generic-password failed (exit ${String(result.exitCode)}): ${bytesToString(result.stderr).trim()}`,
      );
    }
  }

  async get(name: string): Promise<Uint8Array> {
    assertValidName(name);
    this.requireAvailable();
    const result = await runChild(
      this.securityPath,
      ["find-generic-password", "-s", this.service(), "-a", name, "-w"],
      { maxStdoutBytes: 256 * 1024, maxStderrBytes: 4 * 1024 },
    );
    if (result.exitCode !== 0) {
      const stderr = bytesToString(result.stderr);
      if (result.exitCode === 44 || /could not be found/iu.test(stderr)) {
        throw new CredentialVaultError("not_found", this.backend, `credential absent: ${name}`);
      }
      throw new CredentialVaultError(
        "backend_failed",
        this.backend,
        `security find-generic-password failed (exit ${String(result.exitCode)}): ${stderr.trim()}`,
      );
    }
    return result.stdout;
  }

  async delete(name: string): Promise<void> {
    assertValidName(name);
    this.requireAvailable();
    const result = await runChild(
      this.securityPath,
      ["delete-generic-password", "-s", this.service(), "-a", name],
      { maxStdoutBytes: 4 * 1024, maxStderrBytes: 4 * 1024 },
    );
    if (result.exitCode !== 0) {
      const stderr = bytesToString(result.stderr);
      if (result.exitCode === 44 || /could not be found/iu.test(stderr)) {
        return;
      }
      throw new CredentialVaultError(
        "backend_failed",
        this.backend,
        `security delete-generic-password failed (exit ${String(result.exitCode)}): ${stderr.trim()}`,
      );
    }
  }

  probe(): CredentialVaultProbeResult {
    let info: Stats;
    try {
      info = statSync(this.securityPath);
    } catch (error: unknown) {
      return {
        available: false,
        backend: this.backend,
        detail: `security probe failed: ${errorToString(error)}`,
      };
    }
    if (!info.isFile()) {
      return {
        available: false,
        backend: this.backend,
        detail: `security binary not a regular file at ${this.securityPath}`,
      };
    }
    return {
      available: true,
      backend: this.backend,
      detail: `macOS keychain via ${this.securityPath}, service ${this.service()}`,
    };
  }

  private service(): string {
    return `minions.${this.hostId}`;
  }

  private requireAvailable(): void {
    const probe = this.probe();
    if (!probe.available) {
      throw new CredentialVaultError("vault_unavailable", this.backend, probe.detail);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Helpers (multi-call-site or non-trivial).
// -------------------------------------------------------------------------------------------------

function assertValidName(name: string): void {
  if (typeof name !== "string" || !credentialNamePattern.test(name)) {
    throw new CredentialVaultError(
      "invalid_name",
      "systemd-creds",
      `credential name must match ${credentialNamePattern.source}: ${truncate(name)}`,
    );
  }
}

function truncate(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

async function writeTransientPlaintext(secret: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minions-vault-"));
  await chmod(dir, ownerOnlyDirMode);
  const plaintext = join(dir, "plaintext");
  await writeFile(plaintext, secret, { mode: ownerOnlyFileMode });
  await chmod(plaintext, ownerOnlyFileMode);
  return plaintext;
}

/**
 * F4: overwrite `path` with zeros and fsync before unlinking so the freed blocks
 * do not retain the secret on disk. Best-effort: any I/O error proceeds to the
 * unconditional `rm` so cleanup never wedges on a hostile/unreadable file.
 */
async function shredFile(path: string): Promise<void> {
  try {
    const info = await stat(path);
    const size = info.size;
    if (size > 0) {
      const handle = await open(path, "r+");
      try {
        const zeros = new Uint8Array(Math.min(size, 64 * 1024));
        let written = 0;
        while (written < size) {
          const chunkSize = Math.min(zeros.length, size - written);
          await handle.write(zeros, 0, chunkSize, written);
          written += chunkSize;
        }
        await handle.datasync();
      } finally {
        await handle.close();
      }
    }
  } catch {
    // best-effort: proceed to unlink regardless
  }
  await rm(path, { force: true });
}

async function enforceOwnerOnlyDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  if ((info.mode & 0o777) !== ownerOnlyDirMode) {
    await chmod(directory, ownerOnlyDirMode);
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

type ChildResult = Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;
type ChildLimits = Readonly<{ maxStdoutBytes: number; maxStderrBytes: number }>;

function runChild(
  binary: string,
  args: readonly string[],
  limits: ChildLimits,
): Promise<ChildResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ChildResult>();
  const child = spawn(binary, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;

  child.once("error", (error: unknown) => {
    reject(
      new CredentialVaultError(
        "backend_failed",
        "systemd-creds",
        `failed to spawn ${binary}: ${errorToString(error)}`,
        { cause: error },
      ),
    );
  });

  child.stdout.on("data", (chunk: Uint8Array) => {
    if (stdoutTruncated) return;
    if (stdoutBytes + chunk.byteLength > limits.maxStdoutBytes) {
      stdoutTruncated = true;
      return;
    }
    stdoutBytes += chunk.byteLength;
    stdoutChunks.push(new Uint8Array(chunk));
  });
  child.stderr.on("data", (chunk: Uint8Array) => {
    if (stderrTruncated) return;
    if (stderrBytes + chunk.byteLength > limits.maxStderrBytes) {
      stderrTruncated = true;
      return;
    }
    stderrBytes += chunk.byteLength;
    stderrChunks.push(new Uint8Array(chunk));
  });
  child.once("close", (code: number | null) => {
    resolve({
      exitCode: code ?? -1,
      stdout: concatenate(stdoutChunks),
      stderr: concatenate(stderrChunks),
    });
  });
  return promise;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
