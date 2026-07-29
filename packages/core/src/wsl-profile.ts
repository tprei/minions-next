/**
 * WSL2 host profile (PR 54 — wsl2-host-and-fleet-ui).
 *
 * Windows development box running the complete engine inside one WSL2 distro.
 * Registration requires systemd, rootless Podman, localhost forwarding, and
 * secure credential storage — missing any blocks registration (fail-closed).
 */
export type WslDistroName = string;

export type WslRequirement =
  "systemd" | "rootless_podman" | "localhost_forwarding" | "secure_storage";

export type WslProbeResult = Readonly<{
  readonly distro: WslDistroName;
  readonly satisfied: readonly WslRequirement[];
  readonly missing: readonly WslRequirement[];
}>;

/**
 * Path validation for WSL2 repositories (PR 54 — "no Windows-path mixing").
 *
 * Registration paths MUST be Linux-style (POSIX): no drive letters (C:\),
 * no backslashes, no `drvfs` mount points (/mnt/c/...). Windows paths are
 * inaccessible from the sandbox and would silently break confinement.
 */
export type PathVerdict = Readonly<{ readonly valid: boolean; readonly reason?: string }>;

/** Reject Windows-style paths and drvfs mounts (pure, fail-closed). */
export function validateWslPath(path: string): PathVerdict {
  if (path.length === 0) {
    return Object.freeze({ valid: false, reason: "path must not be empty" });
  }
  if (/[A-Za-z]:[\\/]/.test(path)) {
    return Object.freeze({ valid: false, reason: "Windows drive-letter path rejected" });
  }
  if (path.includes("\\")) {
    return Object.freeze({
      valid: false,
      reason: "backslash in path rejected — use POSIX paths only",
    });
  }
  if (/^\/mnt\/[a-z]\//.test(path)) {
    return Object.freeze({
      valid: false,
      reason: "drvfs mount path rejected — Windows drives are inaccessible from the sandbox",
    });
  }
  if (!path.startsWith("/")) {
    return Object.freeze({ valid: false, reason: "path must be absolute (start with /)" });
  }
  return Object.freeze({ valid: true });
}

/**
 * Typed remediation for missing WSL requirements (PR 54 — "typed remediation").
 *
 * Each unsatisfied requirement maps to a specific, actionable remediation step
 * the operator can follow to satisfy it. This is NOT a generic error message —
 * it names the exact command or config change needed.
 */
export type Remediation = Readonly<{
  readonly requirement: WslRequirement;
  readonly title: string;
  readonly steps: readonly string[];
}>;

const REMEDIATIONS: Record<WslRequirement, Remediation> = {
  systemd: Object.freeze({
    requirement: "systemd",
    title: "Enable systemd in WSL",
    steps: Object.freeze([
      "Add [boot]\nsystemd=true to /etc/wsl.conf",
      "Restart WSL: wsl --shutdown (from Windows), then reopen",
    ]),
  }),
  rootless_podman: Object.freeze({
    requirement: "rootless_podman",
    title: "Install and configure rootless Podman",
    steps: Object.freeze([
      "Install: sudo apt install podman",
      "Enable rootless: podman system migrate",
      "Verify: podman info --format json | grep rootless",
    ]),
  }),
  localhost_forwarding: Object.freeze({
    requirement: "localhost_forwarding",
    title: "Enable localhost forwarding",
    steps: Object.freeze([
      "Add localhostForwarding=true to .wslconfig (Windows user dir)",
      "Or verify the guest can bind 127.0.0.1 and the host can reach it",
    ]),
  }),
  secure_storage: Object.freeze({
    requirement: "secure_storage",
    title: "Configure secure credential storage",
    steps: Object.freeze([
      "Install libsecret and gnome-keyring (or kwallet)",
      "Ensure DBUS_SESSION_BUS_ADDRESS is set in the WSL session",
      "Verify: secret-tool lookup password minions-test",
    ]),
  }),
};

/** Get the typed remediation for a missing requirement (pure). */
export function remediationFor(requirement: WslRequirement): Remediation {
  return REMEDIATIONS[requirement];
}

/** Get remediations for all missing requirements from a probe result (pure). */
export function remediationsForProbe(result: WslProbeResult): readonly Remediation[] {
  return result.missing.map((req) => REMEDIATIONS[req]);
}
