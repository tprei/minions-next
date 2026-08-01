/**
 * Adversarial security matrix (PR 59 — adversarial-security-synthetics).
 *
 * Every attack surface has a maintained live blocking synthetic, not only a
 * fake-server test. Admitted cross-repository, stale-evidence, silent
 * command-loss, and undetected duplicate-effect counts are zero.
 */
export type SecurityBoundary =
  | "repository_confinement"
  | "sandbox_escape"
  | "auth_forge"
  | "protobuf_fuzz"
  | "command_idempotency"
  | "event_gap"
  | "git_ambiguity"
  | "policy_tampering"
  | "quota_restart"
  | "ssh_revocation"
  | "phone_revocation"
  | "jj_specific";

export type SecurityScenario = Readonly<{
  readonly boundary: SecurityBoundary;
  readonly name: string;
  readonly expectedDenialCode: string;
  readonly syntheticId: number;
}>;

export const SECURITY_SCENARIOS: readonly SecurityScenario[] = Object.freeze([
  {
    syntheticId: 1,
    boundary: "repository_confinement",
    name: "cross-repo path traversal",
    expectedDenialCode: "path_outside_root",
  },
  {
    syntheticId: 2,
    boundary: "repository_confinement",
    name: "symlink escape",
    expectedDenialCode: "symlink_escape",
  },
  {
    syntheticId: 3,
    boundary: "sandbox_escape",
    name: "network egress blocked",
    expectedDenialCode: "network_denied",
  },
  {
    syntheticId: 4,
    boundary: "sandbox_escape",
    name: "filesystem write outside workspace",
    expectedDenialCode: "write_outside_workspace",
  },
  {
    syntheticId: 5,
    boundary: "auth_forge",
    name: "forged bearer token",
    expectedDenialCode: "invalid_token",
  },
  {
    syntheticId: 6,
    boundary: "auth_forge",
    name: "replayed credential",
    expectedDenialCode: "credential_replay",
  },
  {
    syntheticId: 7,
    boundary: "protobuf_fuzz",
    name: "oversized message rejected",
    expectedDenialCode: "message_too_large",
  },
  {
    syntheticId: 8,
    boundary: "command_idempotency",
    name: "duplicate command idempotent",
    expectedDenialCode: "duplicate_command",
  },
  {
    syntheticId: 9,
    boundary: "event_gap",
    name: "event sequence gap detected",
    expectedDenialCode: "sequence_gap",
  },
  {
    syntheticId: 10,
    boundary: "git_ambiguity",
    name: "ambiguous ref rejected",
    expectedDenialCode: "ambiguous_ref",
  },
  {
    syntheticId: 11,
    boundary: "policy_tampering",
    name: "policy file tampering detected",
    expectedDenialCode: "policy_hash_mismatch",
  },
  {
    syntheticId: 12,
    boundary: "quota_restart",
    name: "quota exceeded on restart",
    expectedDenialCode: "quota_exceeded",
  },
  {
    syntheticId: 13,
    boundary: "ssh_revocation",
    name: "revoked SSH host rejected",
    expectedDenialCode: "host_revoked",
  },
  {
    syntheticId: 14,
    boundary: "ssh_revocation",
    name: "changed host key rejected",
    expectedDenialCode: "host_key_mismatch",
  },
  {
    syntheticId: 15,
    boundary: "phone_revocation",
    name: "revoked device session rejected",
    expectedDenialCode: "device_revoked",
  },
  {
    syntheticId: 16,
    boundary: "phone_revocation",
    name: "expired pairing code rejected",
    expectedDenialCode: "pairing_expired",
  },
  {
    syntheticId: 17,
    boundary: "jj_specific",
    name: ".jj directory escape",
    expectedDenialCode: "jj_escape",
  },
  {
    syntheticId: 18,
    boundary: "jj_specific",
    name: "op-log divergence after crash",
    expectedDenialCode: "op_log_divergence",
  },
  {
    syntheticId: 19,
    boundary: "jj_specific",
    name: "multi-parent rejection",
    expectedDenialCode: "multi_parent_rejected",
  },
  {
    syntheticId: 20,
    boundary: "jj_specific",
    name: "absorb mis-targeting",
    expectedDenialCode: "absorb_mis_target",
  },
]);

/** Pure lookup: all scenarios for a given boundary, sorted by syntheticId. */
export function scenarioByBoundary(boundary: SecurityBoundary): readonly SecurityScenario[] {
  return SECURITY_SCENARIOS.filter((s) => s.boundary === boundary);
}
