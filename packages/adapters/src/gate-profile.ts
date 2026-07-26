import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { contentHash, type ContentHash } from "@minions/core";
import { GateCategory } from "@minions/contracts";

export type GateProfileErrorCode =
  | "missing"
  | "malformed_yaml"
  | "unknown_field"
  | "shell_command"
  | "missing_category"
  | "weakens_host_minimum"
  | "unsafe_path"
  | "unsafe_env"
  | "unsafe_network"
  | "worktree_weakening"
  | "invalid";

export class GateProfileError extends Error {
  readonly code: GateProfileErrorCode;

  constructor(code: GateProfileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GateProfileError";
    this.code = code;
  }
}

export type HostGateMinimum = Readonly<{
  requiredCategories: readonly GateCategory[];
  allowedNetworkHosts: readonly string[];
  worktreeWeakeningPermitted: boolean;
  blockedPaths: readonly string[];
  deniedEnvKeys: readonly string[];
}>;

export type LoadedGateProfile = Readonly<{
  profile: GateProfileLike;
  hash: ContentHash;
}>;

export type GateCommandLike = Readonly<{
  executable: string;
  args: readonly string[];
  envAllowlist: readonly string[];
}>;

export type GateEntryLike = Readonly<{
  category: GateCategory;
  command?: GateCommandLike | undefined;
}>;

export type GateValidatedEntry = Readonly<{
  category: GateCategory;
  command: GateCommandLike;
}>;

export type GatePathPolicyLike = Readonly<{
  allowedPaths: readonly string[];
  blockedPaths: readonly string[];
}>;

export type GateEnvPolicyLike = Readonly<{
  allowedKeys: readonly string[];
  deniedKeys: readonly string[];
}>;

export type GateNetworkPolicyLike = Readonly<{
  allowedHosts: readonly string[];
}>;

export type GateWorktreePolicyLike = Readonly<{
  weakeningPermitted: boolean;
}>;

export type GateProfileInput = Readonly<{
  requiredCategories: readonly GateCategory[];
  gates: readonly GateEntryLike[];
  pathPolicy?: GatePathPolicyLike | undefined;
  envPolicy?: GateEnvPolicyLike | undefined;
  networkPolicy?: GateNetworkPolicyLike | undefined;
  worktreePolicy?: GateWorktreePolicyLike | undefined;
  profileHash: string;
}>;

export type GateProfileLike = Readonly<{
  requiredCategories: readonly GateCategory[];
  gates: readonly GateValidatedEntry[];
  pathPolicy: GatePathPolicyLike;
  envPolicy: GateEnvPolicyLike;
  networkPolicy: GateNetworkPolicyLike;
  worktreePolicy: GateWorktreePolicyLike;
  profileHash: string;
}>;

const GATES_FILE_NAME = ".minions/gates.yaml";

const GATE_CATEGORY_BY_NAME: Readonly<Record<string, GateCategory>> = Object.freeze({
  lint: GateCategory.LINT,
  typecheck: GateCategory.TYPECHECK,
  tests: GateCategory.TESTS,
  build: GateCategory.BUILD,
  security_review: GateCategory.SECURITY_REVIEW,
});

const GATE_CATEGORY_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [GateCategory.LINT]: "lint",
  [GateCategory.TYPECHECK]: "typecheck",
  [GateCategory.TESTS]: "tests",
  [GateCategory.BUILD]: "build",
  [GateCategory.SECURITY_REVIEW]: "security_review",
});

const TOP_LEVEL_KEYS: Readonly<Record<string, true>> = Object.freeze({
  required_categories: true,
  gates: true,
  path_policy: true,
  env_policy: true,
  network_policy: true,
  worktree_policy: true,
});

const PATH_POLICY_KEYS: Readonly<Record<string, true>> = Object.freeze({
  allowed_paths: true,
  blocked_paths: true,
});

const ENV_POLICY_KEYS: Readonly<Record<string, true>> = Object.freeze({
  allowed_keys: true,
  denied_keys: true,
});

const NETWORK_POLICY_KEYS: Readonly<Record<string, true>> = Object.freeze({
  allowed_hosts: true,
});

const WORKTREE_POLICY_KEYS: Readonly<Record<string, true>> = Object.freeze({
  weakening_permitted: true,
});

const COMMAND_KEYS: Readonly<Record<string, true>> = Object.freeze({
  executable: true,
  args: true,
  env_allowlist: true,
});

const UNSAFE_HOST_LITERALS: Readonly<Record<string, true>> = Object.freeze({
  "0.0.0.0": true,
  "[::]": true,
  "::": true,
  "metadata.google.internal": true,
  "metadata.azure.com": true,
  "169.254.169.254": true,
});

const SHELL_METACHAR_PATTERN = /[\s|&;$`<>{}()[\]\\*"'\n\r\t!#~]/u;
const UNSAFE_PATH_PATTERN = /^(\/|\.\.[\\/]|~)/u;
const UNSAFE_HOST_PATTERNS: readonly RegExp[] = [/^169\.254\./iu, /^metadata\./iu, /^fd00:/iu];
const UNSAFE_ENV_KEY_PATTERNS: readonly RegExp[] = [
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)(_|$)/iu,
  /API_KEY$/iu,
  /ACCESS_KEY$/iu,
  /^AWS_SECRET/iu,
  /^(GH|GITHUB)_(TOKEN|PAT)/iu,
  /^_?SSH_/iu,
  /^GPG/iu,
  /^GNUPG/iu,
];

type UnknownRecord = Record<string, unknown>;

type ValidatedEntry = Readonly<{
  category: GateCategory;
  command: Readonly<{
    executable: string;
    args: readonly string[];
    envAllowlist: readonly string[];
  }>;
}>;

type ValidatedData = Readonly<{
  requiredCategories: readonly GateCategory[];
  gates: readonly ValidatedEntry[];
  pathPolicy: GatePathPolicyLike;
  envPolicy: GateEnvPolicyLike;
  networkPolicy: GateNetworkPolicyLike;
  worktreePolicy: GateWorktreePolicyLike;
}>;

export async function loadGateProfile(
  repoRoot: string,
  hostMinimum?: HostGateMinimum,
): Promise<LoadedGateProfile> {
  const filePath = join(repoRoot, GATES_FILE_NAME);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new GateProfileError("missing", `gate profile not found at ${GATES_FILE_NAME}`, {
      cause: error,
    });
  }
  return parseGateProfile(text, hostMinimum);
}

export function parseGateProfile(text: string, hostMinimum?: HostGateMinimum): LoadedGateProfile {
  const parsed = parseYaml(text);
  const data = extractProfileData(parsed);
  const profile = buildProfileMessage(data);
  const validated = validateGateProfile(profile, hostMinimum);
  const hash = computeGateProfileHash(validated);
  return Object.freeze({
    profile: Object.freeze({ ...validated, profileHash: hash }),
    hash,
  });
}

export function validateGateProfile(
  profile: GateProfileInput,
  hostMinimum?: HostGateMinimum,
): GateProfileLike {
  const categories = validateRequiredCategories(profile.requiredCategories);
  const gates = validateGates(profile.gates, categories);
  const pathPolicy = validatePathPolicy(profile.pathPolicy);
  const envPolicy = validateEnvPolicy(profile.envPolicy);
  const networkPolicy = validateNetworkPolicy(profile.networkPolicy);
  const worktreePolicy = validateWorktreePolicy(profile.worktreePolicy);
  if (hostMinimum !== undefined) {
    assertMeetsHostMinimum(
      categories,
      networkPolicy,
      worktreePolicy,
      pathPolicy,
      envPolicy,
      hostMinimum,
    );
  }
  return {
    requiredCategories: Object.freeze([...categories]),
    gates: Object.freeze(
      gates.map((entry) =>
        Object.freeze({
          category: entry.category,
          command: Object.freeze({
            executable: entry.command.executable,
            args: Object.freeze([...entry.command.args]),
            envAllowlist: Object.freeze([...entry.command.envAllowlist]),
          }),
        }),
      ),
    ),
    pathPolicy: Object.freeze({
      allowedPaths: Object.freeze([...pathPolicy.allowedPaths]),
      blockedPaths: Object.freeze([...pathPolicy.blockedPaths]),
    }),
    envPolicy: Object.freeze({
      allowedKeys: Object.freeze([...envPolicy.allowedKeys]),
      deniedKeys: Object.freeze([...envPolicy.deniedKeys]),
    }),
    networkPolicy: Object.freeze({
      allowedHosts: Object.freeze([...networkPolicy.allowedHosts]),
    }),
    worktreePolicy: Object.freeze({
      weakeningPermitted: worktreePolicy.weakeningPermitted,
    }),
    profileHash: profile.profileHash,
  };
}

export function computeGateProfileHash(profile: GateProfileInput): ContentHash {
  return contentHash(
    createHash("sha256").update(serializeGateProfile(profile), "utf8").digest("hex"),
  );
}

export function serializeGateProfile(profile: GateProfileInput): string {
  const validated = validateGateProfile(profile);
  return canonicalJson({
    required_categories: [...validated.requiredCategories].sort(compareCategory),
    gates: validated.gates
      .map((entry) => ({
        category: entry.category,
        executable: entry.command.executable,
        args: [...entry.command.args],
        env_allowlist: [...entry.command.envAllowlist].sort(localeCompare),
      }))
      .sort((left, right) => compareCategory(left.category, right.category)),
    path_policy: {
      allowed_paths: [...validated.pathPolicy.allowedPaths].sort(localeCompare),
      blocked_paths: [...validated.pathPolicy.blockedPaths].sort(localeCompare),
    },
    env_policy: {
      allowed_keys: [...validated.envPolicy.allowedKeys].sort(localeCompare),
      denied_keys: [...validated.envPolicy.deniedKeys].sort(localeCompare),
    },
    network_policy: {
      allowed_hosts: [...validated.networkPolicy.allowedHosts].sort(localeCompare),
    },
    worktree_policy: {
      weakening_permitted: validated.worktreePolicy.weakeningPermitted,
    },
  });
}

export function profileWeakensBaseline(
  candidate: GateProfileInput,
  baseline: GateProfileInput,
): boolean {
  const candidateCategories = new Set(candidate.requiredCategories);
  for (const required of baseline.requiredCategories) {
    if (!candidateCategories.has(required)) {
      return true;
    }
  }
  const candidateGateCategories = new Set(candidate.gates.map((entry) => entry.category));
  for (const required of baseline.requiredCategories) {
    if (!candidateGateCategories.has(required)) {
      return true;
    }
  }
  const baselineHosts = new Set(baseline.networkPolicy?.allowedHosts ?? []);
  for (const host of candidate.networkPolicy?.allowedHosts ?? []) {
    if (!baselineHosts.has(host)) {
      return true;
    }
  }
  if (
    (candidate.worktreePolicy?.weakeningPermitted ?? false) &&
    !(baseline.worktreePolicy?.weakeningPermitted ?? false)
  ) {
    return true;
  }
  const baselineBlocked = new Set(baseline.pathPolicy?.blockedPaths ?? []);
  for (const path of baselineBlocked) {
    if (!(candidate.pathPolicy?.blockedPaths ?? []).includes(path)) {
      return true;
    }
  }
  const baselineDenied = new Set(baseline.envPolicy?.deniedKeys ?? []);
  for (const key of baselineDenied) {
    if (!(candidate.envPolicy?.deniedKeys ?? []).includes(key)) {
      return true;
    }
  }
  return false;
}

export function assertProfileDoesNotWeaken(
  candidate: GateProfileInput,
  baseline: GateProfileInput,
): void {
  if (profileWeakensBaseline(candidate, baseline)) {
    throw new GateProfileError(
      "worktree_weakening",
      "worktree gate profile weakens the active policy snapshot",
    );
  }
}

export function gateCategoryFromName(name: string): GateCategory {
  const category = GATE_CATEGORY_BY_NAME[name];
  if (category === undefined) {
    throw new GateProfileError("invalid", `unknown gate category name: ${name}`);
  }
  return category;
}

export function gateCategoryName(category: GateCategory): string {
  const name = GATE_CATEGORY_NAMES[category];
  if (name === undefined) {
    throw new GateProfileError("invalid", `unknown gate category value: ${String(category)}`);
  }
  return name;
}

function extractProfileData(parsed: unknown): ValidatedData {
  const record = asRecord(parsed, "gate profile");
  assertExactKeys(record, TOP_LEVEL_KEYS, "gate profile");
  if (!Array.isArray(record["required_categories"])) {
    throw new GateProfileError("invalid", "required_categories must be an array");
  }
  const requiredCategories = (record["required_categories"] as readonly unknown[]).map(
    (value, index) => parseCategoryValue(value, `required_categories[${String(index)}]`),
  );
  assertDistinctCategories(requiredCategories, "required_categories");
  if (requiredCategories.length === 0) {
    throw new GateProfileError("missing_category", "required_categories must not be empty");
  }
  const gatesRecord = asRecord(record["gates"], "gates");
  const gates: ValidatedEntry[] = [];
  for (const [name, raw] of Object.entries(gatesRecord)) {
    const category = parseCategoryName(name, "gates");
    const commandRecord = asRecord(raw, `gates.${name}`);
    assertExactKeys(commandRecord, COMMAND_KEYS, `gates.${name}`);
    const executableRaw = commandRecord["executable"];
    if (typeof executableRaw !== "string" || executableRaw.length === 0) {
      throw new GateProfileError("invalid", `gates.${name}.executable must be a non-empty string`);
    }
    assertNotShellString(executableRaw, `gates.${name}.executable`);
    const args = stringArray(commandRecord["args"], `gates.${name}.args`);
    const envAllowlist = stringArray(commandRecord["env_allowlist"], `gates.${name}.env_allowlist`);
    for (const key of envAllowlist) {
      assertSafeEnvKey(key, `gates.${name}.env_allowlist`);
    }
    gates.push(
      Object.freeze({
        category,
        command: Object.freeze({ executable: executableRaw, args, envAllowlist }),
      }),
    );
  }
  assertGatesCoverRequired(gates, requiredCategories);
  return Object.freeze({
    requiredCategories: Object.freeze([...requiredCategories]),
    gates: Object.freeze(
      gates.sort((left, right) => compareCategory(left.category, right.category)),
    ),
    pathPolicy: extractPathPolicy(record["path_policy"]),
    envPolicy: extractEnvPolicy(record["env_policy"]),
    networkPolicy: extractNetworkPolicy(record["network_policy"]),
    worktreePolicy: extractWorktreePolicy(record["worktree_policy"]),
  });
}

function extractPathPolicy(raw: unknown): GatePathPolicyLike {
  if (raw === undefined || raw === null) {
    return { allowedPaths: [], blockedPaths: [] };
  }
  const record = asRecord(raw, "path_policy");
  assertExactKeys(record, PATH_POLICY_KEYS, "path_policy");
  const allowedPaths = stringArray(record["allowed_paths"], "path_policy.allowed_paths");
  const blockedPaths = stringArray(record["blocked_paths"], "path_policy.blocked_paths");
  for (const path of allowedPaths) {
    assertSafePath(path, "path_policy.allowed_paths");
  }
  return {
    allowedPaths: [...allowedPaths],
    blockedPaths: [...blockedPaths],
  };
}

function extractEnvPolicy(raw: unknown): GateEnvPolicyLike {
  if (raw === undefined || raw === null) {
    return { allowedKeys: [], deniedKeys: [] };
  }
  const record = asRecord(raw, "env_policy");
  assertExactKeys(record, ENV_POLICY_KEYS, "env_policy");
  const allowedKeys = stringArray(record["allowed_keys"], "env_policy.allowed_keys");
  const deniedKeys = stringArray(record["denied_keys"], "env_policy.denied_keys");
  for (const key of allowedKeys) {
    assertSafeEnvKey(key, "env_policy.allowed_keys");
  }
  return {
    allowedKeys: [...allowedKeys],
    deniedKeys: [...deniedKeys],
  };
}

function extractNetworkPolicy(raw: unknown): GateNetworkPolicyLike {
  if (raw === undefined || raw === null) {
    return { allowedHosts: [] };
  }
  const record = asRecord(raw, "network_policy");
  assertExactKeys(record, NETWORK_POLICY_KEYS, "network_policy");
  const allowedHosts = stringArray(record["allowed_hosts"], "network_policy.allowed_hosts");
  for (const host of allowedHosts) {
    assertSafeHost(host, "network_policy.allowed_hosts");
  }
  return { allowedHosts: [...allowedHosts] };
}

function extractWorktreePolicy(raw: unknown): GateWorktreePolicyLike {
  if (raw === undefined || raw === null) {
    return { weakeningPermitted: false };
  }
  const record = asRecord(raw, "worktree_policy");
  assertExactKeys(record, WORKTREE_POLICY_KEYS, "worktree_policy");
  const weakeningPermitted = record["weakening_permitted"];
  if (typeof weakeningPermitted !== "boolean") {
    throw new GateProfileError("invalid", "worktree_policy.weakening_permitted must be a boolean");
  }
  return { weakeningPermitted };
}

function buildProfileMessage(data: ValidatedData): GateProfileLike {
  return {
    requiredCategories: [...data.requiredCategories],
    gates: data.gates.map((entry) => ({
      category: entry.category,
      command: {
        executable: entry.command.executable,
        args: [...entry.command.args],
        envAllowlist: [...entry.command.envAllowlist],
      },
    })),
    pathPolicy: { ...data.pathPolicy },
    envPolicy: { ...data.envPolicy },
    networkPolicy: { ...data.networkPolicy },
    worktreePolicy: { ...data.worktreePolicy },
    profileHash: "",
  };
}

function validateRequiredCategories(values: readonly GateCategory[]): readonly GateCategory[] {
  if (values.length === 0) {
    throw new GateProfileError("missing_category", "required_categories must not be empty");
  }
  for (const value of values) {
    if (value === GateCategory.UNSPECIFIED || GATE_CATEGORY_NAMES[value] === undefined) {
      throw new GateProfileError("invalid", `invalid gate category value: ${String(value)}`);
    }
  }
  assertDistinctCategories(values, "required_categories");
  return [...values];
}

function validateGates(
  gates: readonly GateEntryLike[],
  requiredCategories: readonly GateCategory[],
): readonly ValidatedEntry[] {
  if (gates.length === 0) {
    throw new GateProfileError("missing_category", "gates must not be empty");
  }
  const entries: ValidatedEntry[] = [];
  const seen = new Set<GateCategory>();
  for (const entry of gates) {
    if (
      entry.category === GateCategory.UNSPECIFIED ||
      GATE_CATEGORY_NAMES[entry.category] === undefined
    ) {
      throw new GateProfileError(
        "invalid",
        `invalid gate category in entry: ${String(entry.category)}`,
      );
    }
    if (seen.has(entry.category)) {
      throw new GateProfileError(
        "invalid",
        `duplicate gate category: ${gateCategoryName(entry.category)}`,
      );
    }
    seen.add(entry.category);
    const command = entry.command;
    if (command === undefined) {
      throw new GateProfileError(
        "invalid",
        `gate entry for ${gateCategoryName(entry.category)} has no command`,
      );
    }
    assertNotShellString(
      command.executable,
      `gates.${gateCategoryName(entry.category)}.executable`,
    );
    for (const key of command.envAllowlist) {
      assertSafeEnvKey(key, `gates.${gateCategoryName(entry.category)}.env_allowlist`);
    }
    entries.push({
      category: entry.category,
      command: {
        executable: command.executable,
        args: [...command.args],
        envAllowlist: [...command.envAllowlist],
      },
    });
  }
  assertGatesCoverRequired(entries, requiredCategories);
  return entries;
}

function validatePathPolicy(policy: GatePathPolicyLike | undefined): GatePathPolicyLike {
  const allowedPaths = policy?.allowedPaths ?? [];
  const blockedPaths = policy?.blockedPaths ?? [];
  assertStringArray(allowedPaths, "path_policy.allowed_paths");
  assertStringArray(blockedPaths, "path_policy.blocked_paths");
  for (const path of allowedPaths) {
    assertSafePath(path, "path_policy.allowed_paths");
  }
  return { allowedPaths: [...allowedPaths], blockedPaths: [...blockedPaths] };
}

function validateEnvPolicy(policy: GateEnvPolicyLike | undefined): GateEnvPolicyLike {
  const allowedKeys = policy?.allowedKeys ?? [];
  const deniedKeys = policy?.deniedKeys ?? [];
  assertStringArray(allowedKeys, "env_policy.allowed_keys");
  assertStringArray(deniedKeys, "env_policy.denied_keys");
  for (const key of allowedKeys) {
    assertSafeEnvKey(key, "env_policy.allowed_keys");
  }
  return { allowedKeys: [...allowedKeys], deniedKeys: [...deniedKeys] };
}

function validateNetworkPolicy(policy: GateNetworkPolicyLike | undefined): GateNetworkPolicyLike {
  const allowedHosts = policy?.allowedHosts ?? [];
  assertStringArray(allowedHosts, "network_policy.allowed_hosts");
  for (const host of allowedHosts) {
    assertSafeHost(host, "network_policy.allowed_hosts");
  }
  return { allowedHosts: [...allowedHosts] };
}

function validateWorktreePolicy(
  policy: GateWorktreePolicyLike | undefined,
): GateWorktreePolicyLike {
  return { weakeningPermitted: policy?.weakeningPermitted ?? false };
}

function assertMeetsHostMinimum(
  categories: readonly GateCategory[],
  networkPolicy: GateNetworkPolicyLike,
  worktreePolicy: GateWorktreePolicyLike,
  pathPolicy: GatePathPolicyLike,
  envPolicy: GateEnvPolicyLike,
  minimum: HostGateMinimum,
): void {
  const categorySet = new Set(categories);
  for (const required of minimum.requiredCategories) {
    if (!categorySet.has(required)) {
      throw new GateProfileError(
        "weakens_host_minimum",
        `gate profile removes required host-minimum category: ${gateCategoryName(required)}`,
      );
    }
  }
  const minimumHosts = new Set(minimum.allowedNetworkHosts);
  for (const host of networkPolicy.allowedHosts) {
    if (!minimumHosts.has(host)) {
      throw new GateProfileError(
        "weakens_host_minimum",
        `gate profile allows a network host not permitted by the host minimum: ${host}`,
      );
    }
  }
  if (worktreePolicy.weakeningPermitted && !minimum.worktreeWeakeningPermitted) {
    throw new GateProfileError(
      "worktree_weakening",
      "gate profile permits worktree weakening forbidden by the host minimum",
    );
  }
  const candidateBlocked = new Set(pathPolicy.blockedPaths);
  for (const path of minimum.blockedPaths) {
    if (!candidateBlocked.has(path)) {
      throw new GateProfileError(
        "weakens_host_minimum",
        `gate profile does not block a host-minimum path: ${path}`,
      );
    }
  }
  const candidateDenied = new Set(envPolicy.deniedKeys);
  for (const key of minimum.deniedEnvKeys) {
    if (!candidateDenied.has(key)) {
      throw new GateProfileError(
        "weakens_host_minimum",
        `gate profile does not deny a host-minimum env key: ${key}`,
      );
    }
  }
}

function assertGatesCoverRequired(
  gates: readonly Readonly<{ category: GateCategory }>[],
  required: readonly GateCategory[],
): void {
  const gateCategories = new Set(gates.map((entry) => entry.category));
  for (const category of required) {
    if (!gateCategories.has(category)) {
      throw new GateProfileError(
        "missing_category",
        `required category has no gate command: ${gateCategoryName(category)}`,
      );
    }
  }
}

function assertDistinctCategories(values: readonly GateCategory[], field: string): void {
  const seen = new Set<GateCategory>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new GateProfileError(
        "invalid",
        `${field} contains duplicate category: ${gateCategoryName(value)}`,
      );
    }
    seen.add(value);
  }
}

function parseYaml(text: string): unknown {
  if (text.trim().length === 0) {
    throw new GateProfileError("malformed_yaml", "gate profile is empty");
  }
  try {
    return parse(text, { strict: true });
  } catch (error) {
    throw new GateProfileError("malformed_yaml", "gate profile YAML is malformed", {
      cause: error,
    });
  }
}

function parseCategoryValue(value: unknown, field: string): GateCategory {
  if (typeof value === "number") {
    if (value === 0 || GATE_CATEGORY_NAMES[value] === undefined) {
      throw new GateProfileError(
        "invalid",
        `${field} has an invalid category value: ${String(value)}`,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    return parseCategoryName(value, field);
  }
  throw new GateProfileError("invalid", `${field} must be a category name or value`);
}

function parseCategoryName(name: unknown, field: string): GateCategory {
  if (typeof name !== "string" || name.length === 0) {
    throw new GateProfileError("invalid", `${field} must be a non-empty category name`);
  }
  const category = GATE_CATEGORY_BY_NAME[name];
  if (category === undefined) {
    throw new GateProfileError("invalid", `${field} has an unknown category name: ${name}`);
  }
  return category;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  assertStringArray(value, field);
  return [...(value as readonly unknown[])].map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new GateProfileError(
        "invalid",
        `${field}[${String(index)}] must be a non-empty string`,
      );
    }
    return item;
  });
}

function assertStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new GateProfileError("invalid", `${field} must be an array`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new GateProfileError("invalid", `${field} must contain only non-empty strings`);
    }
  }
}

function assertNotShellString(value: string, field: string): void {
  if (SHELL_METACHAR_PATTERN.test(value)) {
    throw new GateProfileError(
      "shell_command",
      `${field} must be a single executable token, not a shell string`,
    );
  }
}

function assertSafePath(value: string, field: string): void {
  if (UNSAFE_PATH_PATTERN.test(value) || isAbsolute(value) || value.includes("..")) {
    throw new GateProfileError(
      "unsafe_path",
      `${field} must stay within the repository (not absolute, home, or parent-traversal): ${value}`,
    );
  }
}

function assertSafeEnvKey(key: string, field: string): void {
  for (const pattern of UNSAFE_ENV_KEY_PATTERNS) {
    if (pattern.test(key)) {
      throw new GateProfileError(
        "unsafe_env",
        `${field} must not allow a credential-bearing key: ${key}`,
      );
    }
  }
}

function assertSafeHost(host: string, field: string): void {
  const lower = host.toLowerCase();
  if (UNSAFE_HOST_LITERALS[lower] === true) {
    throw new GateProfileError(
      "unsafe_network",
      `${field} must not allow a cloud-metadata endpoint: ${host}`,
    );
  }
  for (const pattern of UNSAFE_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new GateProfileError(
        "unsafe_network",
        `${field} must not allow a cloud-metadata endpoint: ${host}`,
      );
    }
  }
}

function asRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GateProfileError("invalid", `${field} must be a mapping`);
  }
  return value as UnknownRecord;
}

function assertExactKeys(
  record: UnknownRecord,
  allowed: Readonly<Record<string, true>>,
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (allowed[key] !== true) {
      throw new GateProfileError("unknown_field", `${field} contains an unknown field: ${key}`);
    }
  }
}

function compareCategory(left: GateCategory, right: GateCategory): number {
  return left - right;
}

function localeCompare(left: string, right: string): number {
  return left.localeCompare(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as UnknownRecord;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}
