import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { posix } from "node:path";
import {
  contentHash,
  sandboxNetworkProfiles,
  type ContentHash,
  type SandboxMount,
  type SandboxNetworkProfile,
  type SandboxPolicy,
  type SandboxPolicyFingerprint,
  type SandboxPolicyFingerprinter as SandboxPolicyFingerprinterContract,
} from "@minions/core";

export type SandboxPolicyErrorCode =
  | "invalid_policy"
  | "invalid_policy_version"
  | "invalid_digest"
  | "invalid_mounts"
  | "workspace_mount_required"
  | "workspace_mount_access_invalid"
  | "mount_path_invalid"
  | "mount_path_traversal"
  | "duplicate_mount_target"
  | "invalid_resources"
  | "invalid_tools"
  | "duplicate_tool"
  | "invalid_network"
  | "duplicate_network_host"
  | "network_profile_mismatch";

export class SandboxPolicyError extends Error {
  readonly code: SandboxPolicyErrorCode;

  constructor(code: SandboxPolicyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxPolicyError";
    this.code = code;
  }
}

const contentHashPattern = /^[0-9a-f]{64}$/u;
const sandboxNetworkProfileSet = new Set<string>(sandboxNetworkProfiles);
const policyKeys = [
  "version",
  "rootFilesystemDigest",
  "templateDigest",
  "mounts",
  "network",
  "tools",
  "resources",
] as const;
const mountKeys = ["kind", "sourcePath", "targetPath", "access"] as const;
const networkKeys = ["profile", "allowedHosts", "allowProviderGateway"] as const;
const toolKeys = ["allowedExecutables", "allowedGitSubcommands", "blockedGitSubcommands"] as const;
const resourceKeys = [
  "cpuCount",
  "memoryMiB",
  "processLimit",
  "storageMiB",
  "executionTimeoutMs",
  "maxOutputBytes",
] as const;

type UnknownRecord = Record<string, unknown>;

export class SandboxPolicyFingerprinter implements SandboxPolicyFingerprinterContract {
  fingerprint(policy: SandboxPolicy): SandboxPolicyFingerprint {
    const normalized = validateSandboxPolicy(policy);
    const serialized = canonicalJson(normalized);
    const digest = contentHash(createHash("sha256").update(serialized, "utf8").digest("hex"));
    return Object.freeze({ policyVersion: 1 as const, digest });
  }
}

export function createSandboxPolicyFingerprinter(): SandboxPolicyFingerprinter {
  return new SandboxPolicyFingerprinter();
}

export function fingerprintSandboxPolicy(policy: SandboxPolicy): SandboxPolicyFingerprint {
  return new SandboxPolicyFingerprinter().fingerprint(policy);
}

export function validateSandboxPolicy(policy: SandboxPolicy): SandboxPolicy {
  const record = asRecord(policy, "policy");
  assertExactKeys(record, policyKeys, "policy", "invalid_policy");
  if (record["version"] !== 1) {
    throw new SandboxPolicyError("invalid_policy_version", "sandbox policy version must be 1");
  }
  const rootFilesystemDigest = validateDigest(
    record["rootFilesystemDigest"],
    "root filesystem digest",
  );
  const templateDigest = validateDigest(record["templateDigest"], "template digest");
  const mounts = validateMounts(record["mounts"]);
  const network = validateNetwork(record["network"]);
  const tools = validateTools(record["tools"]);
  const resources = validateResources(record["resources"]);
  return Object.freeze({
    version: 1,
    rootFilesystemDigest,
    templateDigest,
    mounts: Object.freeze(mounts),
    network,
    tools,
    resources,
  });
}

export function serializeSandboxPolicy(policy: SandboxPolicy): string {
  return canonicalJson(validateSandboxPolicy(policy));
}

function validateDigest(value: unknown, field: string): ContentHash {
  if (typeof value !== "string" || !contentHashPattern.test(value)) {
    throw new SandboxPolicyError(
      "invalid_digest",
      `${field} must be a lowercase SHA-256 content hash`,
    );
  }
  return contentHash(value);
}

function validateMounts(value: unknown): readonly SandboxMount[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SandboxPolicyError(
      "invalid_mounts",
      "sandbox policy mounts must be a non-empty array",
    );
  }
  let workspaceCount = 0;
  const targets = new Set<string>();
  const mounts: SandboxMount[] = [];
  for (const [index, candidate] of value.entries()) {
    const record = asRecord(candidate, `mount ${String(index)}`);
    assertExactKeys(record, mountKeys, `mount ${String(index)}`, "invalid_mounts");
    const kind = record["kind"];
    if (kind !== "workspace" && kind !== "scratch" && kind !== "cache") {
      throw new SandboxPolicyError("invalid_mounts", `mount ${String(index)} kind is invalid`);
    }
    const access = record["access"];
    if (access !== "read_only" && access !== "read_write") {
      throw new SandboxPolicyError(
        "workspace_mount_access_invalid",
        `mount ${String(index)} access is invalid`,
      );
    }
    const sourcePath = validateMountPath(
      record["sourcePath"],
      `mount ${String(index)} source path`,
    );
    const targetPath = validateMountPath(
      record["targetPath"],
      `mount ${String(index)} target path`,
    );
    if (targets.has(targetPath)) {
      throw new SandboxPolicyError(
        "duplicate_mount_target",
        `mount ${String(index)} target path is duplicated`,
      );
    }
    targets.add(targetPath);
    if (kind === "workspace") workspaceCount += 1;
    mounts.push(Object.freeze({ kind, sourcePath, targetPath, access }));
  }
  if (workspaceCount !== 1) {
    throw new SandboxPolicyError(
      "workspace_mount_required",
      "sandbox policy must contain exactly one workspace mount",
    );
  }
  return mounts;
}

function validateMountPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || !posix.isAbsolute(value)) {
    throw new SandboxPolicyError("mount_path_invalid", `${field} must be an absolute path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new SandboxPolicyError("mount_path_traversal", `${field} contains traversal segments`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value) {
    throw new SandboxPolicyError("mount_path_invalid", `${field} must be normalized`);
  }
  return normalized;
}

function validateNetwork(value: unknown): SandboxPolicy["network"] {
  const record = asRecord(value, "network policy");
  assertExactKeys(record, networkKeys, "network policy", "invalid_network");
  const profile = record["profile"];
  if (typeof profile !== "string" || !sandboxNetworkProfileSet.has(profile)) {
    throw new SandboxPolicyError("invalid_network", "sandbox network profile is unknown");
  }
  const allowEmptyHosts = profile === "explore" || profile === "gate" || profile === "maintenance";
  const rawHosts = validateStringList(
    record["allowedHosts"],
    "allowed network hosts",
    "invalid_network",
    allowEmptyHosts,
  );
  const allowedHosts = rawHosts.map((host, index) =>
    validateNetworkHost(host, profile as SandboxNetworkProfile, index),
  );
  const allowProviderGateway = record["allowProviderGateway"];
  if (typeof allowProviderGateway !== "boolean") {
    throw new SandboxPolicyError("invalid_network", "allowProviderGateway must be boolean");
  }
  if (profile === "explore" && (allowedHosts.length !== 0 || allowProviderGateway)) {
    throw new SandboxPolicyError(
      "network_profile_mismatch",
      "explore network profile must have no allowed hosts or provider gateway",
    );
  }
  return Object.freeze({
    profile: profile as SandboxNetworkProfile,
    allowedHosts: Object.freeze(allowedHosts),
    allowProviderGateway,
  });
}

function validateNetworkHost(host: string, profile: SandboxNetworkProfile, index: number): string {
  if (
    host !== host.toLowerCase() ||
    host.endsWith(".") ||
    host.includes("://") ||
    host.includes("/") ||
    host.includes("@") ||
    host.includes("?") ||
    host.includes("#") ||
    host.includes("*")
  ) {
    throw new SandboxPolicyError(
      "invalid_network",
      `allowed network host ${String(index)} must be a normalized host name`,
    );
  }
  const bracketlessHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ipVersion = isIP(bracketlessHost);
  if (ipVersion === 0) {
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(
        host,
      )
    ) {
      throw new SandboxPolicyError(
        "invalid_network",
        `allowed network host ${String(index)} must be a normalized host name`,
      );
    }
    if (profile !== "maintenance" && isRestrictedHostname(host)) {
      throw new SandboxPolicyError(
        "network_profile_mismatch",
        `${profile} network profile cannot access a local or metadata host`,
      );
    }
    return host;
  }
  if (profile !== "maintenance") {
    throw new SandboxPolicyError(
      "network_profile_mismatch",
      `${profile} network profile cannot access an IP-literal host`,
    );
  }
  return host;
}

function isRestrictedHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "instance-data.ec2.internal"
  );
}

function validateTools(value: unknown): SandboxPolicy["tools"] {
  const record = asRecord(value, "tool policy");
  assertExactKeys(record, toolKeys, "tool policy", "invalid_tools");
  return Object.freeze({
    allowedExecutables: validateStringList(
      record["allowedExecutables"],
      "allowed executables",
      "invalid_tools",
    ),
    allowedGitSubcommands: validateStringList(
      record["allowedGitSubcommands"],
      "allowed Git subcommands",
      "invalid_tools",
    ),
    blockedGitSubcommands: validateStringList(
      record["blockedGitSubcommands"],
      "blocked Git subcommands",
      "invalid_tools",
    ),
  });
}

function validateResources(value: unknown): SandboxPolicy["resources"] {
  const record = asRecord(value, "resource profile");
  assertExactKeys(record, resourceKeys, "resource profile", "invalid_resources");
  const resources: Record<string, number> = {};
  for (const field of resourceKeys) {
    const candidate = record[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new SandboxPolicyError("invalid_resources", `${field} must be a positive safe integer`);
    }
    resources[field] = candidate;
  }
  return Object.freeze(resources as SandboxPolicy["resources"]);
}

function validateStringList(
  value: unknown,
  field: string,
  code: SandboxPolicyErrorCode,
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new SandboxPolicyError(
      code,
      `${field} must be an ${allowEmpty ? "array" : "non-empty array"}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, candidate] of value.entries()) {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.trim() !== candidate) {
      throw new SandboxPolicyError(code, `${field} entry ${String(index)} must be non-empty text`);
    }
    if (seen.has(candidate)) {
      const duplicateCode =
        field === "allowed network hosts" ? "duplicate_network_host" : "duplicate_tool";
      throw new SandboxPolicyError(duplicateCode, `${field} contains a duplicate entry`);
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return Object.freeze(result);
}

function asRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxPolicyError("invalid_policy", `${field} must be an object`);
  }
  return value as UnknownRecord;
}

function assertExactKeys(
  record: UnknownRecord,
  expected: readonly string[],
  field: string,
  code: SandboxPolicyErrorCode,
): void {
  const actual = Object.keys(record).sort();
  const normalizedExpected = [...expected].sort();
  if (
    actual.length !== normalizedExpected.length ||
    actual.some((key, index) => key !== normalizedExpected[index])
  ) {
    throw new SandboxPolicyError(code, `${field} contains unknown or missing fields`);
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    const serialized = JSON.stringify(value);
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as UnknownRecord;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new SandboxPolicyError("invalid_policy", "policy contains an unserializable value");
}
