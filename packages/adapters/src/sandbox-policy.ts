import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { posix } from "node:path";
import {
  contentHash,
  sandboxNetworkProfiles,
  type ContentHash,
  type ExecuteSandboxRequest,
  type SandboxCommandDenial,
  type SandboxCommandKind,
  type SandboxMount,
  type SandboxNetworkProfile,
  type SandboxPolicy,
  type SandboxPolicyFingerprint,
  type SandboxPolicyFingerprinter as SandboxPolicyFingerprinterContract,
  type SandboxCommandValidationResult,
  type SandboxDenialCode,
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
const blockedGitCodes: Readonly<Record<string, SandboxDenialCode>> = Object.freeze({
  branch: "git_branch_blocked",
  commit: "git_commit_blocked",
  fetch: "git_fetch_blocked",
  push: "git_push_blocked",
  remote: "git_remote_blocked",
  worktree: "git_worktree_blocked",
});
const safeGitStatusArguments = new Set([
  "--short",
  "--porcelain",
  "--branch",
  "--show-stash",
  "--ahead-behind",
  "--no-ahead-behind",
  "--untracked-files",
  "-u",
  "--ignored",
  "-z",
  "--renames",
  "--no-renames",
  "--find-renames",
  "--no-optional-locks",
]);
const deniedEnvironmentKeys = new Set([
  "all_proxy",
  "bash_env",
  "curl_ca_bundle",
  "curl_home",
  "dyld_insert_libraries",
  "dyld_library_path",
  "env",
  "git_alternate_object_directories",
  "git_askpass",
  "git_config_count",
  "git_config_global",
  "git_config_key_0",
  "git_config_key_1",
  "git_config_nosystem",
  "git_config_parameters",
  "git_config_system",
  "git_config_value_0",
  "git_config_value_1",
  "git_exec_path",
  "git_index_file",
  "git_object_directory",
  "git_proxy_command",
  "git_ssh",
  "git_ssh_command",
  "git_template_dir",
  "http_proxy",
  "https_proxy",
  "ld_library_path",
  "ld_preload",
  "node_extra_ca_certs",
  "node_options",
  "node_path",
  "node_repl_external_module",
  "node_v8_coverage",
  "no_proxy",
  "perl5opt",
  "pythonpath",
  "shell",
]);
const nodeResourceProbeSource =
  "const {spawn}=require('node:child_process');const children=Array.from({length:17},()=>spawn(process.execPath,['-e','setTimeout(()=>{},1000)']));Promise.all(children.map(child=>new Promise(resolve=>child.on('exit',resolve))))";
const nodeOutputProbeSource = "process.stdout.write('x'.repeat(4097))";
const nodeTimeoutProbeSource = "setTimeout(()=>{},1000)";
const nodeIsolationProbeSource = [
  "",
  'const fs = await import("node:fs/promises");',
  "const paths = JSON.parse(process.env.MINIONS_LIMA_PROBE_PATHS);",
  "function denied(error) {",
  '  if (typeof error !== "object" || error === null || !("code" in error)) return false;',
  '  return ["EACCES", "EISDIR", "ENAMETOOLONG", "ENODEV", "ENOENT", "ENOTDIR", "ENXIO", "EPERM"].includes(error.code);',
  "}",
  "async function blocked(candidate) {",
  "  try {",
  '    if (candidate.kind === "directory") await fs.readdir(candidate.path);',
  "    else await fs.readFile(candidate.path);",
  "    return false;",
  "  } catch (error) {",
  "    if (!denied(error)) throw error;",
  "    return true;",
  "  }",
  "}",
  "const results = await Promise.all(paths.map(blocked));",
  'if (results.every(Boolean)) process.stdout.write("MINIONS_LIMA_ISOLATION_OK");',
  "else process.exitCode = 1;",
  "",
].join("\n");

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

export function validateSandboxPolicy(policy: unknown): SandboxPolicy {
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
export function validateSandboxCommand(
  request: ExecuteSandboxRequest,
  policy: SandboxPolicy,
): SandboxCommandValidationResult {
  if (
    !Array.isArray(request.arguments) ||
    request.arguments.some((argument) => typeof argument !== "string")
  ) {
    return commandDenied(
      "executable_not_allowed",
      "sandbox command arguments must be a string array",
    );
  }
  const environmentDenial = validateCommandEnvironment(request.environment);
  if (environmentDenial !== undefined) return environmentDenial;
  const executable = normalizeCommandExecutable(request.executable, policy);
  if (typeof executable !== "string") return executable;
  const kind = commandKind(executable);
  const commandDenial =
    kind === "node"
      ? validateNodeCommand(request, policy)
      : kind === "curl"
        ? validateCurlCommand(request, policy)
        : kind === "git"
          ? validateGitCommand(request, policy)
          : validateGenericCommand(request);
  if (commandDenial !== undefined) return commandDenial;
  return commandAllowed(executable, request.arguments, kind);
}

function commandAllowed(
  executable: string,
  arguments_: readonly string[],
  kind: SandboxCommandKind,
): SandboxCommandValidationResult {
  return Object.freeze({
    allowed: true as const,
    command: Object.freeze({
      executable,
      arguments: Object.freeze([...arguments_]),
      kind,
    }),
  });
}

function commandDenied(
  code: SandboxDenialCode,
  message: string,
  details: Readonly<Record<string, string | number>> = {},
): SandboxCommandValidationResult {
  const denial: SandboxCommandDenial = Object.freeze({
    code,
    message,
    details: Object.freeze({ ...details }),
  });
  return Object.freeze({ allowed: false as const, denial });
}

function validateCommandEnvironment(
  environment: unknown,
): SandboxCommandValidationResult | undefined {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    return commandDenied("process_escape", "sandbox command environment must be a string map");
  }
  for (const [key, value] of Object.entries(environment)) {
    if (
      key.length === 0 ||
      value === undefined ||
      typeof value !== "string" ||
      !isSafeEnvironmentKey(key)
    ) {
      return commandDenied("process_escape", "sandbox command environment is malformed", {
        environmentKey: key,
      });
    }
    const normalizedKey = key.toLowerCase();
    if (
      deniedEnvironmentKeys.has(normalizedKey) ||
      normalizedKey.startsWith("git_config_key_") ||
      normalizedKey.startsWith("git_config_value_")
    ) {
      return commandDenied("process_escape", "sandbox command environment can alter execution", {
        environmentKey: key,
      });
    }
  }
  return undefined;
}

function isSafeEnvironmentKey(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x21 || code > 0x7e || character === "=") return false;
  }
  return true;
}

function normalizeCommandExecutable(
  executable: unknown,
  policy: SandboxPolicy,
): string | SandboxCommandValidationResult {
  if (typeof executable !== "string" || executable.length === 0 || !isSafeCommandText(executable)) {
    return commandDenied("executable_not_allowed", "sandbox executable is ambiguous");
  }
  if (!Array.isArray(policy.tools.allowedExecutables)) {
    return commandDenied("invalid_policy", "sandbox executable policy is malformed");
  }
  if (executable.startsWith("/")) {
    if (
      !posix.isAbsolute(executable) ||
      posix.normalize(executable) !== executable ||
      !policy.tools.allowedExecutables.includes(executable)
    ) {
      return commandDenied(
        "executable_not_allowed",
        "absolute sandbox executable is not explicitly declared",
        { executable },
      );
    }
    return executable;
  }
  if (!isSafeExecutableToken(executable) || !policy.tools.allowedExecutables.includes(executable)) {
    return commandDenied(
      "executable_not_allowed",
      "sandbox executable is not explicitly declared",
      { executable },
    );
  }
  return executable;
}

function isSafeCommandText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code === 0 || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function isSafeExecutableToken(value: string): boolean {
  if (value === "." || value === "..") return false;
  for (const character of value) {
    const isAsciiLetter =
      (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
    const isDigit = character >= "0" && character <= "9";
    if (!isAsciiLetter && !isDigit && !".-_+".includes(character)) return false;
  }
  return true;
}

function commandKind(executable: string): SandboxCommandKind {
  const name = posix.basename(executable);
  if (name === "node") return "node";
  if (name === "curl") return "curl";
  if (name === "git") return "git";
  return "generic";
}

function validateGenericCommand(
  request: ExecuteSandboxRequest,
): SandboxCommandValidationResult | undefined {
  if (posix.basename(request.executable) === "docker") {
    const [subcommand, networkFlag, tagFlag, tag, context, ...extra] = request.arguments;
    if (
      subcommand !== "build" ||
      networkFlag !== "--network=none" ||
      tagFlag !== "--tag" ||
      tag === undefined ||
      !/^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$/u.test(tag) ||
      context !== "." ||
      extra.length !== 0
    ) {
      return commandDenied(
        "process_escape",
        "Docker is restricted to an isolated foreground image build",
      );
    }
  }
  for (const argument of request.arguments) {
    if (!isSafeCommandText(argument)) {
      return commandDenied("executable_not_allowed", "sandbox command argument is ambiguous");
    }
  }
  return undefined;
}
function validateNodeCommand(
  request: ExecuteSandboxRequest,
  policy: SandboxPolicy,
): SandboxCommandValidationResult | undefined {
  const arguments_ = request.arguments;
  const first = arguments_[0];
  if (first === undefined) {
    return commandDenied("process_escape", "Node must receive an explicit script or probe");
  }
  if (first === "-v" || first === "--version") {
    return arguments_.length === 1
      ? undefined
      : commandDenied("process_escape", "Node version mode cannot receive extra arguments");
  }
  if (first === "-e" || first === "--eval") {
    if (arguments_.length !== 2) {
      return commandDenied("process_escape", "Node eval requires one literal source argument");
    }
    const source = arguments_[1];
    if (source === "") return undefined;
    if (
      source === nodeOutputProbeSource ||
      source === nodeTimeoutProbeSource ||
      source === nodeResourceProbeSource
    ) {
      return undefined;
    }
    if (
      source === nodeIsolationProbeSource &&
      isolationProbeEnvironmentIsValid(request.environment["MINIONS_LIMA_PROBE_PATHS"])
    ) {
      return undefined;
    }
    return commandDenied(
      "process_escape",
      "Node eval source is not an explicitly declared sandbox operation",
    );
  }
  if (first === "--") {
    const script = arguments_[1];
    if (script === undefined || !isWorkspaceScriptPath(script, request, policy)) {
      return commandDenied("process_escape", "Node script path must be a declared workspace path");
    }
    return undefined;
  }
  if (first.startsWith("-")) {
    return commandDenied("process_escape", "Node option is not explicitly declared");
  }
  if (!isWorkspaceScriptPath(first, request, policy)) {
    return commandDenied("process_escape", "Node script path must be a declared workspace path");
  }
  return undefined;
}

function isolationProbeEnvironmentIsValid(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.every((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const record = candidate as UnknownRecord;
    const path = record["path"];
    const kind = record["kind"];
    return (
      typeof path === "string" &&
      path.length > 0 &&
      isSafeCommandText(path) &&
      (kind === "directory" || kind === "file")
    );
  });
}

export function commonAncestorPath(paths: readonly string[]): string | undefined {
  const first = paths[0];
  if (first === undefined) return undefined;
  if (paths.length === 1) return first;
  const firstSegments = first.split("/");
  let commonLength = firstSegments.length;
  for (const path of paths.slice(1)) {
    const segments = path.split("/");
    let index = 0;
    while (index < commonLength && index < segments.length && segments[index] === firstSegments[index]) {
      index += 1;
    }
    commonLength = index;
  }
  const commonSegments = firstSegments.slice(0, commonLength);
  const root = commonSegments.join("/");
  return root.length === 0 ? "/" : root;
}

export function commonWorkspaceRoot(workspaceMounts: readonly SandboxMount[]): string | undefined {
  return commonAncestorPath(workspaceMounts.map((mount) => mount.targetPath));
}

function isWithinAnyWorkspaceMount(path: string, workspaceMounts: readonly SandboxMount[]): boolean {
  // A per-entry mount set has no mount literally targeting the shared
  // conceptual root (e.g. "/workspace" when every mount targets
  // "/workspace/<entry>") - so containment also accepts PATH being EXACTLY
  // the tightest common ancestor of every workspace mount's target - never
  // any coarser ancestor (that would accept "/" for any non-empty mount
  // set, defeating this check entirely).
  return (
    workspaceMounts.some((mount) => pathIsWithin(path, mount.targetPath)) ||
    path === commonWorkspaceRoot(workspaceMounts)
  );
}

function isWorkspaceScriptPath(
  value: string,
  request: ExecuteSandboxRequest,
  policy: SandboxPolicy,
): boolean {
  if (
    value.length === 0 ||
    value.startsWith("-") ||
    !isSafeCommandText(value) ||
    value.includes("\\")
  ) {
    return false;
  }
  const workspaceMounts = policy.mounts.filter((mount) => mount.kind === "workspace");
  if (
    workspaceMounts.length === 0 ||
    !posix.isAbsolute(request.workingDirectory) ||
    posix.normalize(request.workingDirectory) !== request.workingDirectory ||
    !isWithinAnyWorkspaceMount(request.workingDirectory, workspaceMounts)
  ) {
    return false;
  }
  const scriptPath = posix.isAbsolute(value) ? value : posix.join(request.workingDirectory, value);
  if (posix.normalize(scriptPath) !== scriptPath) return false;
  return workspaceMounts.some((mount) => pathIsWithin(scriptPath, mount.targetPath));
}

function pathIsWithin(path: string, root: string): boolean {
  const relative = posix.relative(root, path);
  return relative === "" || (relative !== ".." && !relative.startsWith("../"));
}
function validateCurlCommand(
  request: ExecuteSandboxRequest,
  policy: SandboxPolicy,
): SandboxCommandValidationResult | undefined {
  const arguments_ = request.arguments;
  if (arguments_.length !== 1) {
    return commandDenied(
      "network_host_denied",
      "curl accepts exactly one literal URL and no options",
      { argumentCount: arguments_.length },
    );
  }
  const candidate = arguments_[0];
  if (candidate === undefined || !isSafeCommandText(candidate) || candidate.includes("%")) {
    return commandDenied("network_host_denied", "curl URL is not a literal network destination");
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return commandDenied("network_host_denied", "curl URL is invalid");
    }
    throw error;
  }
  const authority = urlAuthority(candidate);
  const authorityHost = authorityHostText(authority);
  const parsedHost = stripIpv6Brackets(url.hostname.toLowerCase());
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    candidate.includes("#") ||
    authorityHost === undefined ||
    !isLiteralUrlHost(authorityHost, parsedHost) ||
    candidate !== candidate.trim()
  ) {
    return commandDenied(
      "network_host_denied",
      "curl URL is not an unambiguous network destination",
    );
  }
  const restrictedCode = restrictedNetworkCode(parsedHost);
  if (restrictedCode !== undefined) {
    return commandDenied(restrictedCode, "curl destination is restricted", { host: parsedHost });
  }
  if (url.protocol !== "https:") {
    return commandDenied("network_host_denied", "curl requires an HTTPS destination");
  }
  if (
    !policy.network.allowedHosts.includes(parsedHost) &&
    !(policy.network.allowProviderGateway && parsedHost === "host.lima.internal")
  ) {
    return commandDenied("network_host_denied", "curl destination is not declared by the policy", {
      host: parsedHost,
    });
  }
  return undefined;
}

function urlAuthority(value: string): string {
  const schemeEnd = value.indexOf("://");
  const authorityStart = schemeEnd < 0 ? 0 : schemeEnd + 3;
  let authorityEnd = value.length;
  for (const delimiter of ["/", "?", "#"]) {
    const index = value.indexOf(delimiter, authorityStart);
    if (index >= 0 && index < authorityEnd) authorityEnd = index;
  }
  return value.slice(authorityStart, authorityEnd);
}

function authorityHostText(authority: string): string | undefined {
  if (authority.length === 0 || authority.includes("@") || authority.includes("%")) {
    return undefined;
  }
  if (authority.startsWith("[")) {
    if (!authority.endsWith("]")) return undefined;
    return authority.slice(1, -1);
  }
  if (authority.includes(":")) return undefined;
  return authority;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isLiteralUrlHost(authorityHost: string, parsedHost: string): boolean {
  if (
    authorityHost.length === 0 ||
    authorityHost !== authorityHost.toLowerCase() ||
    authorityHost !== parsedHost ||
    authorityHost.endsWith(".") ||
    authorityHost.includes("..") ||
    authorityHost.includes("xn--")
  ) {
    return false;
  }
  const ipVersion = isIP(authorityHost);
  if (ipVersion === 4) return parseCanonicalIpv4(authorityHost) !== undefined;
  if (ipVersion === 6) {
    return authorityHost.includes(":") && parseIpv6Words(authorityHost) !== undefined;
  }
  return isAsciiDnsHost(authorityHost);
}

function isAsciiDnsHost(host: string): boolean {
  if (host.length === 0 || host.endsWith(".") || host.includes("..")) return false;
  let labelLength = 0;
  let labelStart = true;
  let labelEnd = false;
  for (const character of host) {
    if (character === ".") {
      if (labelLength === 0 || labelEnd) return false;
      labelLength = 0;
      labelStart = true;
      labelEnd = false;
      continue;
    }
    const isAsciiLetter =
      (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
    const isDigit = character >= "0" && character <= "9";
    if ((!isAsciiLetter && !isDigit && character !== "-") || (labelStart && character === "-")) {
      return false;
    }
    labelStart = false;
    labelEnd = character === "-";
    labelLength += 1;
    if (labelLength > 63) return false;
  }
  return labelLength > 0 && !labelEnd;
}

function restrictedNetworkCode(host: string): SandboxDenialCode | undefined {
  if (isRestrictedHostname(host)) {
    return host === "localhost" || host.endsWith(".localhost")
      ? "network_loopback"
      : "network_metadata";
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = parseCanonicalIpv4(host);
    if (octets === undefined) return "network_host_denied";
    const first = octets[0];
    const second = octets[1];
    const third = octets[2];
    const fourth = octets[3];
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      return "network_host_denied";
    }
    if (first === 127 || (first === 0 && second === 0 && third === 0 && fourth === 0)) {
      return "network_loopback";
    }
    if (first === 169 && second === 254 && third === 169 && fourth === 254) {
      return "network_metadata";
    }
    if (first === 169 && second === 254) return "network_link_local";
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 198 && (second === 18 || second === 19))
    ) {
      return "network_private";
    }
    return undefined;
  }
  if (ipVersion !== 6) return undefined;
  const words = parseIpv6Words(host);
  if (words === undefined) return "network_host_denied";
  const lastWord = words[7] ?? 0;
  const firstWord = words[0] ?? 0;
  if (
    words.every((word) => word === 0) ||
    (lastWord === 1 && words.slice(0, 7).every((word) => word === 0))
  ) {
    return "network_loopback";
  }
  const mapped = ipv4FromMappedIpv6(words);
  if (mapped !== undefined) return restrictedNetworkCode(mapped);
  if ((firstWord & 0xffc0) === 0xfe80) return "network_link_local";
  if ((firstWord & 0xfe00) === 0xfc00) return "network_private";
  return undefined;
}

function parseCanonicalIpv4(host: string): readonly number[] | undefined {
  const segments = host.split(".");
  if (segments.length !== 4) return undefined;
  const octets: number[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || (segment.length > 1 && segment.startsWith("0"))) return undefined;
    let value = 0;
    for (const character of segment) {
      if (character < "0" || character > "9") return undefined;
      value = value * 10 + (character.codePointAt(0) ?? 0) - 48;
      if (value > 255) return undefined;
    }
    octets.push(value);
  }
  return Object.freeze(octets);
}

function parseIpv6Words(host: string): readonly number[] | undefined {
  if (host.length === 0 || host.includes("%")) return undefined;
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const left = parseIpv6Half(halves[0] ?? "");
  const right = parseIpv6Half(halves.length === 2 ? (halves[1] ?? "") : "");
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1) {
    if (left.length !== 8) return undefined;
    return Object.freeze(left);
  }
  const missing = 8 - left.length - right.length;
  if (missing <= 0) return undefined;
  return Object.freeze([...left, ...new Array<number>(missing).fill(0), ...right]);
}

function parseIpv6Half(value: string): readonly number[] | undefined {
  if (value.length === 0) return Object.freeze([]);
  const segments = value.split(":");
  const words: number[] = [];
  for (const segment of segments) {
    if (segment.includes(".")) {
      const octets = parseCanonicalIpv4(segment);
      if (octets === undefined || words.length + 2 > 8) return undefined;
      words.push((octets[0] ?? 0) * 256 + (octets[1] ?? 0));
      words.push((octets[2] ?? 0) * 256 + (octets[3] ?? 0));
      continue;
    }
    if (segment.length === 0 || segment.length > 4) return undefined;
    let valueNumber = 0;
    for (const character of segment.toLowerCase()) {
      const code = character.codePointAt(0);
      if (code === undefined) return undefined;
      const digit =
        character >= "0" && character <= "9"
          ? code - 48
          : character >= "a" && character <= "f"
            ? code - 87
            : -1;
      if (digit < 0) return undefined;
      valueNumber = valueNumber * 16 + digit;
    }
    words.push(valueNumber);
  }
  return words;
}

function ipv4FromMappedIpv6(words: readonly number[]): string | undefined {
  if (
    words.length !== 8 ||
    words[0] !== 0 ||
    words[1] !== 0 ||
    words[2] !== 0 ||
    words[3] !== 0 ||
    words[4] !== 0 ||
    words[5] !== 0xffff
  ) {
    return undefined;
  }
  const first = words[6] ?? 0;
  const second = words[7] ?? 0;
  return `${String(first >>> 8)}.${String(first & 0xff)}.${String(second >>> 8)}.${String(second & 0xff)}`;
}

function validateGitCommand(
  request: ExecuteSandboxRequest,
  policy: SandboxPolicy,
): SandboxCommandValidationResult | undefined {
  const arguments_ = request.arguments;
  if (arguments_.length === 0) {
    return commandDenied("executable_not_allowed", "Git requires an explicit subcommand");
  }
  let index = 0;
  while (index < arguments_.length) {
    const argument = arguments_[index];
    if (argument === undefined) {
      return commandDenied("executable_not_allowed", "Git argument list is incomplete");
    }
    if (argument === "-C") {
      const path = arguments_[index + 1];
      if (path === undefined || path.startsWith("-") || !isSafeCommandText(path)) {
        return commandDenied("process_escape", "Git directory option is ambiguous");
      }
      index += 2;
      continue;
    }
    if (argument === "-c" || argument.startsWith("--config") || argument.startsWith("-c")) {
      const value =
        argument === "-c" ? arguments_[index + 1] : argument.slice(argument.indexOf("=") + 1);
      if (
        isGitCredentialArgument(argument) ||
        (value !== undefined && isGitCredentialArgument(value))
      ) {
        return commandDenied("git_credential_blocked", "Git credential helpers are denied");
      }
      return commandDenied("process_escape", "Git configuration options are denied");
    }
    if (
      argument === "--exec-path" ||
      argument.startsWith("--exec-path=") ||
      argument === "--upload-pack" ||
      argument.startsWith("--upload-pack=") ||
      argument === "--receive-pack" ||
      argument.startsWith("--receive-pack=") ||
      argument === "--super-prefix" ||
      argument.startsWith("--super-prefix=") ||
      argument === "--namespace" ||
      argument.startsWith("--namespace=")
    ) {
      return commandDenied("process_escape", "Git helper and namespace options are denied");
    }
    if (argument === "--") {
      return commandDenied(
        "process_escape",
        "Git option terminator is not an explicit command shape",
      );
    }
    if (argument.startsWith("-")) {
      return commandDenied("process_escape", "Git option is not explicitly declared");
    }
    break;
  }
  const subcommand = arguments_[index];
  if (subcommand === undefined || subcommand.length === 0) {
    return commandDenied("executable_not_allowed", "Git requires an explicit subcommand");
  }
  if (arguments_.slice(index + 1).some((argument) => isGitCredentialArgument(argument))) {
    return commandDenied("git_credential_blocked", "Git credential helpers are denied");
  }
  const normalizedSubcommand = subcommand.toLowerCase();
  if (policy.tools.blockedGitSubcommands.includes(normalizedSubcommand)) {
    return commandDenied(
      blockedGitCodes[normalizedSubcommand] ?? "executable_not_allowed",
      `Git ${normalizedSubcommand} is denied`,
      { subcommand: normalizedSubcommand },
    );
  }
  if (!policy.tools.allowedGitSubcommands.includes(normalizedSubcommand)) {
    return commandDenied("executable_not_allowed", "Git subcommand is not declared by the policy", {
      subcommand: normalizedSubcommand,
    });
  }
  if (normalizedSubcommand !== "status") {
    for (const argument of arguments_.slice(index + 1)) {
      if (!isSafeCommandText(argument)) {
        return commandDenied("process_escape", "Git argument is ambiguous");
      }
    }
    return undefined;
  }
  let afterOptions = false;
  for (const argument of arguments_.slice(index + 1)) {
    if (!isSafeCommandText(argument)) {
      return commandDenied("process_escape", "Git status argument is ambiguous");
    }
    if (!afterOptions && argument === "--") {
      afterOptions = true;
      continue;
    }
    if (!afterOptions && argument.startsWith("-") && !safeGitStatusArguments.has(argument)) {
      return commandDenied("process_escape", "Git status option is not explicitly declared");
    }
  }
  return undefined;
}

function isGitCredentialArgument(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "credential.helper" ||
    normalized.startsWith("credential.helper=") ||
    normalized === "credential-store" ||
    normalized === "credential-cache" ||
    normalized === "git-credential" ||
    normalized.includes("git-credential-")
  );
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
    // P1 (review #15): only an EXACT duplicate target was rejected before -
    // a nested writable mount (e.g. target /workspace/.secrets under an
    // existing read-only /workspace) could still modify a supposedly
    // read-only subtree, since the two targets never collided exactly.
    // Reject any pairwise ancestor/descendant overlap between targets.
    for (const existingTarget of targets) {
      if (
        isAncestorPosixPath(existingTarget, targetPath) ||
        isAncestorPosixPath(targetPath, existingTarget)
      ) {
        throw new SandboxPolicyError(
          "duplicate_mount_target",
          `mount ${String(index)} target path overlaps an existing mount target`,
        );
      }
    }
    targets.add(targetPath);
    // P1 (review #15): the whole host root or another categorically-sensitive
    // root (credentials, process info, device nodes) was accepted as a
    // sourcePath - a legitimate per-attempt mount is always a specific
    // subdirectory the engine provisioned, never one of these roots itself.
    if (SENSITIVE_HOST_MOUNT_SOURCE_ROOTS.has(sourcePath)) {
      throw new SandboxPolicyError(
        "mount_path_invalid",
        `mount ${String(index)} source path '${sourcePath}' is a sensitive host root`,
      );
    }
    if (kind === "workspace") workspaceCount += 1;
    mounts.push(Object.freeze({ kind, sourcePath, targetPath, access }));
  }
  if (workspaceCount < 1) {
    throw new SandboxPolicyError(
      "workspace_mount_required",
      "sandbox policy must contain at least one workspace mount",
    );
  }
  return mounts;
}

/** Well-known host roots no legitimate per-attempt mount source is ever
 * exactly equal to - a mount THIS shallow always exposes credentials,
 * process info, device nodes, or the whole filesystem, never just the
 * engine-provisioned subdirectory a real workspace/scratch/cache mount
 * uses. Deliberately narrow (exact match only): a legitimate mount source
 * living somewhere UNDER one of these (e.g. /home/attempt/.minions/wc-1)
 * is unaffected. */
const SENSITIVE_HOST_MOUNT_SOURCE_ROOTS = new Set([
  "/",
  "/etc",
  "/home",
  "/root",
  "/run",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/var",
  "/usr",
]);

/** @returns `true` iff `candidate` is a strict ancestor of `target` (both
 *   normalized POSIX absolute paths) - i.e. `target` is `candidate` itself
 *   or lives under it. Used to reject overlapping mount targets: a nested
 *   writable mount under an existing read-only one can otherwise modify a
 *   supposedly read-only subtree. */
function isAncestorPosixPath(candidate: string, target: string): boolean {
  if (candidate === target) return true;
  const prefix = candidate === "/" ? "/" : `${candidate}/`;
  return target.startsWith(prefix);
}

function validateMountPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || !posix.isAbsolute(value)) {
    throw new SandboxPolicyError("mount_path_invalid", `${field} must be an absolute path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new SandboxPolicyError("mount_path_traversal", `${field} contains traversal segments`);
  }
  // GIT-15: jj metadata (`.jj`) must never be reachable inside any sandbox. Reject any
  // mount whose source or target path touches a `.jj` segment — this is the production
  // enforcement that pairs with the masked jj working copy (PR 28).
  if (segments.some((segment) => segment === ".jj")) {
    throw new SandboxPolicyError(
      "mount_path_invalid",
      `${field} traverses '.jj' metadata which is denied inside any sandbox (GIT-15)`,
    );
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
