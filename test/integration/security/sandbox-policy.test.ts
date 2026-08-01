import { describe, it, expect } from "vitest";
import {
  validateSandboxPolicy,
  fingerprintSandboxPolicy,
  serializeSandboxPolicy,
} from "@minions/adapters";

/**
 * Sandbox escape and policy tampering security tests
 * (PR 59 — adversarial-security-synthetics).
 */

describe("sandbox policy tamper detection", () => {
  it("is deterministic — same policy produces same fingerprint", () => {
    const policy = validateSandboxPolicy({
      version: 1,
      rootFilesystemDigest: "a".repeat(64),
      templateDigest: "a".repeat(64),
      mounts: [
        { kind: "workspace", sourcePath: "/repo", targetPath: "/workspace", access: "read_write" },
      ],
      network: {
        profile: "implementation",
        allowedHosts: ["registry.npmjs.org"],
        allowProviderGateway: false,
      },
      tools: {
        allowedExecutables: ["node", "git"],
        allowedGitSubcommands: ["status"],
        blockedGitSubcommands: ["push"],
      },
      resources: {
        cpuCount: 2,
        memoryMiB: 2048,
        processLimit: 256,
        storageMiB: 10240,
        executionTimeoutMs: 300000,
        maxOutputBytes: 10485760,
      },
    });
    const fp1 = fingerprintSandboxPolicy(policy);
    const fp2 = fingerprintSandboxPolicy(policy);
    expect(fp1.digest).toBe(fp2.digest);
  });

  it("detects modified resource limits", () => {
    const base = validateSandboxPolicy({
      version: 1,
      rootFilesystemDigest: "a".repeat(64),
      templateDigest: "a".repeat(64),
      mounts: [
        { kind: "workspace", sourcePath: "/repo", targetPath: "/workspace", access: "read_write" },
      ],
      network: {
        profile: "implementation",
        allowedHosts: ["registry.npmjs.org"],
        allowProviderGateway: false,
      },
      tools: {
        allowedExecutables: ["node", "git"],
        allowedGitSubcommands: ["status"],
        blockedGitSubcommands: ["push"],
      },
      resources: {
        cpuCount: 2,
        memoryMiB: 2048,
        processLimit: 256,
        storageMiB: 10240,
        executionTimeoutMs: 300000,
        maxOutputBytes: 10485760,
      },
    });
    const tampered = validateSandboxPolicy({
      version: 1,
      rootFilesystemDigest: "a".repeat(64),
      templateDigest: "a".repeat(64),
      mounts: [
        { kind: "workspace", sourcePath: "/repo", targetPath: "/workspace", access: "read_write" },
      ],
      network: {
        profile: "implementation",
        allowedHosts: ["registry.npmjs.org"],
        allowProviderGateway: false,
      },
      tools: {
        allowedExecutables: ["node", "git"],
        allowedGitSubcommands: ["status"],
        blockedGitSubcommands: ["push"],
      },
      resources: {
        cpuCount: 4,
        memoryMiB: 2048,
        processLimit: 256,
        storageMiB: 10240,
        executionTimeoutMs: 300000,
        maxOutputBytes: 10485760,
      },
    });
    expect(fingerprintSandboxPolicy(base).digest).not.toBe(
      fingerprintSandboxPolicy(tampered).digest,
    );
  });

  it("detects privilege escalation in tool policy", () => {
    const base = validateSandboxPolicy({
      version: 1,
      rootFilesystemDigest: "a".repeat(64),
      templateDigest: "a".repeat(64),
      mounts: [
        { kind: "workspace", sourcePath: "/repo", targetPath: "/workspace", access: "read_write" },
      ],
      network: {
        profile: "implementation",
        allowedHosts: ["registry.npmjs.org"],
        allowProviderGateway: false,
      },
      tools: {
        allowedExecutables: ["node", "git"],
        allowedGitSubcommands: ["status"],
        blockedGitSubcommands: ["push"],
      },
      resources: {
        cpuCount: 2,
        memoryMiB: 2048,
        processLimit: 256,
        storageMiB: 10240,
        executionTimeoutMs: 300000,
        maxOutputBytes: 10485760,
      },
    });
    const tampered = validateSandboxPolicy({
      version: 1,
      rootFilesystemDigest: "a".repeat(64),
      templateDigest: "a".repeat(64),
      mounts: [
        { kind: "workspace", sourcePath: "/repo", targetPath: "/workspace", access: "read_write" },
      ],
      network: {
        profile: "implementation",
        allowedHosts: ["registry.npmjs.org"],
        allowProviderGateway: false,
      },
      tools: {
        allowedExecutables: ["node", "git", "rm"],
        allowedGitSubcommands: ["status"],
        blockedGitSubcommands: ["push"],
      },
      resources: {
        cpuCount: 2,
        memoryMiB: 2048,
        processLimit: 256,
        storageMiB: 10240,
        executionTimeoutMs: 300000,
        maxOutputBytes: 10485760,
      },
    });
    expect(fingerprintSandboxPolicy(base).digest).not.toBe(
      fingerprintSandboxPolicy(tampered).digest,
    );
  });

  it("serialization round-trips", () => {
    const policy = validateSandboxPolicy({
      version: 1,
      rootFilesystemDigest: "a".repeat(64),
      templateDigest: "a".repeat(64),
      mounts: [
        { kind: "workspace", sourcePath: "/repo", targetPath: "/workspace", access: "read_write" },
      ],
      network: {
        profile: "implementation",
        allowedHosts: ["registry.npmjs.org"],
        allowProviderGateway: false,
      },
      tools: {
        allowedExecutables: ["node", "git"],
        allowedGitSubcommands: ["status"],
        blockedGitSubcommands: ["push"],
      },
      resources: {
        cpuCount: 2,
        memoryMiB: 2048,
        processLimit: 256,
        storageMiB: 10240,
        executionTimeoutMs: 300000,
        maxOutputBytes: 10485760,
      },
    });
    const serialized = serializeSandboxPolicy(policy);
    expect(typeof serialized).toBe("string");
    expect(serialized.length).toBeGreaterThan(0);
  });
});
