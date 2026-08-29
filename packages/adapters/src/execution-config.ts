import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ExecutionHostConfig = Readonly<{
  ompPath: string;
  ompAgentVersion: string;
  podmanPath: string;
  seccompProfilePath: string;
  sandboxImageFingerprint: string;
  wslDistroName: string | null;
}>;

const fingerprintPattern = /^[0-9a-f]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+$/u;

export function validateExecutionHostConfig(value: unknown): ExecutionHostConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("execution config must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["ompPath"] !== "string" || record["ompPath"].length === 0) {
    throw new TypeError("execution config ompPath must be a non-empty string");
  }
  if (
    typeof record["ompAgentVersion"] !== "string" ||
    !versionPattern.test(record["ompAgentVersion"])
  ) {
    throw new TypeError("execution config ompAgentVersion must be a semver string (x.y.z)");
  }
  if (typeof record["podmanPath"] !== "string" || record["podmanPath"].length === 0) {
    throw new TypeError("execution config podmanPath must be a non-empty string");
  }
  if (
    typeof record["seccompProfilePath"] !== "string" ||
    record["seccompProfilePath"].length === 0
  ) {
    throw new TypeError("execution config seccompProfilePath must be a non-empty string");
  }
  if (
    typeof record["sandboxImageFingerprint"] !== "string" ||
    !fingerprintPattern.test(record["sandboxImageFingerprint"])
  ) {
    throw new TypeError(
      "execution config sandboxImageFingerprint must be a 64-hex lowercase string",
    );
  }
  const wslDistroName = record["wslDistroName"];
  if (wslDistroName !== null && typeof wslDistroName !== "string") {
    throw new TypeError("execution config wslDistroName must be a string or null");
  }

  return Object.freeze({
    ompPath: record["ompPath"],
    ompAgentVersion: record["ompAgentVersion"],
    podmanPath: record["podmanPath"],
    seccompProfilePath: record["seccompProfilePath"],
    sandboxImageFingerprint: record["sandboxImageFingerprint"],
    wslDistroName: wslDistroName ?? null,
  });
}

export function readExecutionHostConfig(hostDirectory: string): ExecutionHostConfig | undefined {
  const filePath = join(hostDirectory, "execution.json");
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(content);
    return validateExecutionHostConfig(parsed);
  } catch {
    return undefined;
  }
}

export function writeExecutionHostConfig(hostDirectory: string, config: ExecutionHostConfig): void {
  const validated = validateExecutionHostConfig(config);
  const filePath = join(hostDirectory, "execution.json");
  writeFileSync(filePath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
}
