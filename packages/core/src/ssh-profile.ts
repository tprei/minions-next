/**
 * SSH execution-host profile (PR 53 — ssh-execution-hosts).
 *
 * A remote macOS/Linux engine attached through managed SSH. SSH runs only
 * bootstrap/service commands — node commands, events, and evidence use the
 * tunneled generated Connect API, never raw SSH.
 */
import type { ContentHash } from "./value-objects.js";

export type SshHostKeyFingerprint = ContentHash;

export type SshProfile = Readonly<{
  readonly alias: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly knownHostKey: SshHostKeyFingerprint;
  readonly controlMasterPath: string;
  readonly localForwardPort: number;
}>;

/**
 * Version skew policy for SSH host connections (PR 53).
 *
 * The daemon and remote host exchange version strings on connect. If the
 * versions are incompatible, the connection is rejected (fail-closed) rather
 * than attempting to operate with a mismatched API surface.
 */
export type VersionSkewVerdict = Readonly<{
  readonly compatible: boolean;
  readonly reason: string | undefined;
}>;

/**
 * Check version compatibility between the supervisor and a remote host.
 * Versions are semver-like strings (e.g. "1.0.0"). Compatible when the major
 * versions match — minor/patch differences are allowed (additive changes only).
 * Pure: no I/O, no side effects.
 */
export function checkVersionSkew(
  supervisorVersion: string,
  hostVersion: string,
): VersionSkewVerdict {
  const parseMajor = (version: string): number | undefined => {
    const match = /^(\d+)\./.exec(version);
    return match?.[1] !== undefined ? Number(match[1]) : undefined;
  };
  const supMajor = parseMajor(supervisorVersion);
  const hostMajor = parseMajor(hostVersion);
  if (supMajor === undefined || hostMajor === undefined) {
    return Object.freeze({
      compatible: false,
      reason: `unparseable version: supervisor=${supervisorVersion}, host=${hostVersion}`,
    });
  }
  if (supMajor !== hostMajor) {
    return Object.freeze({
      compatible: false,
      reason: `major version mismatch: supervisor=${String(supMajor)}, host=${String(hostMajor)}`,
    });
  }
  return Object.freeze({ compatible: true, reason: undefined });
}
