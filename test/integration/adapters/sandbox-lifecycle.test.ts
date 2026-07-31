import {
  SandboxPolicyError,
  ProductionSandboxLifecycleError,
  createProductionSandboxLifecycle,
  createSandboxPolicyFingerprinter,
  fingerprintSandboxPolicy,
  serializeSandboxPolicy,
} from "@minions/adapters";
import {
  attemptId,
  contentHash,
  hostId,
  repositoryId,
  taskNodeId,
  type CreateSandboxRequest,
  type ExecuteSandboxRequest,
  type SandboxCapabilityProbe,
  type SandboxExecutionResult,
  type SandboxInstance,
  type SandboxLifecycle,
  type SandboxPolicy,
  type SandboxPolicyFingerprint,
} from "@minions/core";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const DIGEST = "0".repeat(64);
const ATTEMPT_ID = attemptId("018f3a2e-4a20-7b90-8123-abcdef123456");
const NODE_ID = taskNodeId("018f3a2e-4a20-7b90-8123-abcdef123457");
const REPOSITORY_ID = repositoryId("018f3a2e-4a20-7b90-8123-abcdef123458");
const HOST_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef123459");
const OTHER_HOST_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef12345a");

function policy(): SandboxPolicy {
  return {
    version: 1,
    rootFilesystemDigest: contentHash(DIGEST),
    templateDigest: contentHash(DIGEST),
    mounts: [
      {
        kind: "workspace",
        sourcePath: "/tmp/minions/workspace",
        targetPath: "/workspace",
        access: "read_write",
      },
      {
        kind: "scratch",
        sourcePath: "/tmp/minions/scratch",
        targetPath: "/scratch",
        access: "read_only",
      },
    ],
    network: {
      profile: "implementation",
      allowedHosts: ["github.com"],
      allowProviderGateway: false,
    },
    tools: {
      allowedExecutables: ["git", "node"],
      allowedGitSubcommands: ["status"],
      blockedGitSubcommands: ["push"],
    },
    resources: {
      cpuCount: 1,
      memoryMiB: 512,
      processLimit: 32,
      storageMiB: 1024,
      executionTimeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
    },
  };
}

function request(currentPolicy = policy()): CreateSandboxRequest {
  const fingerprinter = createSandboxPolicyFingerprinter();
  return {
    context: {
      attemptId: ATTEMPT_ID,
      nodeId: NODE_ID,
      repositoryId: REPOSITORY_ID,
      hostId: HOST_ID,
    },
    idempotencyKey: "sandbox-test-1",
    policy: currentPolicy,
    policyFingerprint: fingerprinter.fingerprint(currentPolicy),
  };
}

function execution(
  instanceId: string,
  fingerprint: SandboxPolicyFingerprint,
): ExecuteSandboxRequest {
  return {
    instanceId,
    expectedPolicyFingerprint: fingerprint,
    executable: "git",
    arguments: ["status"],
    workingDirectory: "/workspace",
    environment: {},
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  };
}

type RecordingLifecycleOptions = Readonly<{
  backendKind?: SandboxLifecycle["backendKind"];
  probe?: SandboxCapabilityProbe;
  createContext?: SandboxInstance["context"];
  createState?: SandboxInstance["state"];
  executeResult?: SandboxExecutionResult;
  executeGate?: Promise<void>;
  cleanupFails?: boolean;
}>;

class RecordingLifecycle implements SandboxLifecycle {
  readonly backendKind: SandboxLifecycle["backendKind"];
  readonly probeResult: SandboxCapabilityProbe;
  readonly createContext: SandboxInstance["context"] | undefined;
  readonly createState: SandboxInstance["state"] | undefined;
  readonly executeResult: SandboxExecutionResult;
  readonly executeGate: Promise<void> | undefined;
  readonly cleanupFails: boolean;
  probeCalls = 0;
  createCalls = 0;
  executeCalls = 0;
  stopCalls = 0;
  destroyCalls = 0;

  constructor(options: RecordingLifecycleOptions = {}) {
    this.backendKind = options.backendKind ?? "linux_podman";
    this.probeResult =
      options.probe ??
      ({
        available: true,
        backendKind: "linux_podman",
        backendVersion: "podman-test",
        templateFingerprint: contentHash(DIGEST),
        capabilities: {
          readOnlyMounts: true,
          processIsolation: true,
          privateNetworkBlocking: true,
          toolFiltering: true,
          nestedContainers: false,
          supportedNetworkProfiles: ["implementation"],
        },
      } satisfies Extract<SandboxCapabilityProbe, { available: true }>);
    this.createContext = options.createContext;
    this.createState = options.createState;
    this.executeResult = options.executeResult ?? {
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    };
    this.executeGate = options.executeGate;
    this.cleanupFails = options.cleanupFails ?? false;
  }

  probe(): Promise<SandboxCapabilityProbe> {
    this.probeCalls += 1;
    return Promise.resolve(this.probeResult);
  }

  create(createRequest: CreateSandboxRequest): Promise<SandboxInstance> {
    this.createCalls += 1;
    return Promise.resolve({
      instanceId: "sandbox-1",
      context: this.createContext ?? createRequest.context,
      backendKind: this.backendKind,
      policyFingerprint: createRequest.policyFingerprint,
      state: this.createState ?? "created",
    });
  }

  async execute(request: ExecuteSandboxRequest): Promise<SandboxExecutionResult> {
    void request;
    this.executeCalls += 1;
    await this.executeGate;
    return this.executeResult;
  }

  stop(instanceId: string, fingerprint: SandboxPolicyFingerprint): Promise<void> {
    void instanceId;
    void fingerprint;
    this.stopCalls += 1;
    return Promise.resolve();
  }

  destroy(instanceId: string, fingerprint: SandboxPolicyFingerprint): Promise<void> {
    void instanceId;
    void fingerprint;
    this.destroyCalls += 1;
    return this.cleanupFails
      ? Promise.reject(new Error("sandbox cleanup failed"))
      : Promise.resolve();
  }
}

function expectLifecycleCode(error: unknown, code: ProductionSandboxLifecycleError["code"]): void {
  expect(error).toBeInstanceOf(ProductionSandboxLifecycleError);
  expect((error as ProductionSandboxLifecycleError).code).toBe(code);
}

describe("sandbox policy adapters", () => {
  it("hashes canonical object keys while preserving array order", () => {
    const first = policy();
    const reordered = {
      resources: first.resources,
      tools: first.tools,
      network: first.network,
      mounts: first.mounts,
      templateDigest: first.templateDigest,
      rootFilesystemDigest: first.rootFilesystemDigest,
      version: first.version,
    } satisfies SandboxPolicy;

    expect(fingerprintSandboxPolicy(first)).toEqual(fingerprintSandboxPolicy(reordered));
    const serialized = serializeSandboxPolicy(first);
    expect(fingerprintSandboxPolicy(first).digest).toBe(
      createHash("sha256").update(serialized, "utf8").digest("hex"),
    );
    const arrayOrderChanged = {
      ...first,
      tools: { ...first.tools, allowedExecutables: ["node", "git"] },
    } satisfies SandboxPolicy;
    expect(fingerprintSandboxPolicy(arrayOrderChanged)).not.toEqual(
      fingerprintSandboxPolicy(first),
    );
  });

  it("rejects strict policy violations", () => {
    const fingerprinter = createSandboxPolicyFingerprinter();
    const valid = policy();
    const [workspaceMount, ...otherMounts] = valid.mounts;
    if (workspaceMount === undefined) throw new Error("workspace mount fixture is unavailable");
    const malformed = {
      ...valid,
      mounts: [{ ...workspaceMount, targetPath: "/workspace/../escape" }, ...otherMounts],
      network: { ...valid.network, allowedHosts: ["github.com"] },
    };
    expect(() => fingerprinter.fingerprint(malformed)).toThrow(SandboxPolicyError);
    // P1 (review #15): only an exact-duplicate target was rejected before -
    // a nested writable mount under an existing mount's target could still
    // modify a supposedly read-only subtree.
    expect(() =>
      fingerprinter.fingerprint({
        ...valid,
        mounts: [
          { ...workspaceMount, targetPath: "/workspace" },
          { kind: "cache", sourcePath: "/tmp/minions/nested", targetPath: "/workspace/.secrets", access: "read_write" as const },
        ],
      }),
    ).toThrow(SandboxPolicyError);
    // P1 (review #15): the whole host root (and other categorically-
    // sensitive roots) were accepted as a mount sourcePath.
    for (const sensitiveSource of ["/", "/home", "/etc", "/run"]) {
      expect(() =>
        fingerprinter.fingerprint({
          ...valid,
          mounts: [{ ...workspaceMount, sourcePath: sensitiveSource }, ...otherMounts],
        }),
      ).toThrow(SandboxPolicyError);
    }
    expect(() =>
      fingerprinter.fingerprint({
        ...policy(),
        network: { profile: "explore", allowedHosts: ["github.com"], allowProviderGateway: false },
      }),
    ).toThrow(SandboxPolicyError);
    for (const host of ["192.0.2.1", "::ffff:127.0.0.1"]) {
      expect(() =>
        fingerprinter.fingerprint({
          ...policy(),
          network: { profile: "implementation", allowedHosts: [host], allowProviderGateway: false },
        }),
      ).toThrow(SandboxPolicyError);
    }
    for (const profile of ["gate", "maintenance"] as const) {
      expect(() =>
        fingerprinter.fingerprint({
          ...policy(),
          network: { profile, allowedHosts: [], allowProviderGateway: false },
        }),
      ).not.toThrow();
    }
  });

  it.each([
    ["test", "invalid_backend_kind"],
    ["unavailable", "backend_unavailable"],
    ["kind", "backend_kind_mismatch"],
    ["template", "template_fingerprint_mismatch"],
    ["capability", "capability_missing"],
  ] as const)("rejects %s production initialization", async (scenario, code) => {
    const probe: SandboxCapabilityProbe =
      scenario === "unavailable"
        ? {
            available: false,
            backendKind: "linux_podman",
            failureCode: "not-installed",
            message: "podman is unavailable",
          }
        : {
            available: true,
            backendKind: scenario === "kind" ? "macos_lima" : "linux_podman",
            backendVersion: "podman-test",
            templateFingerprint: contentHash(scenario === "template" ? "1".repeat(64) : DIGEST),
            capabilities: {
              readOnlyMounts: scenario !== "capability",
              processIsolation: true,
              privateNetworkBlocking: true,
              toolFiltering: true,
              nestedContainers: false,
              supportedNetworkProfiles: ["implementation"],
            },
          };
    const lifecycle = new RecordingLifecycle({
      backendKind: scenario === "test" ? "test" : "linux_podman",
      probe,
    });
    await expect(
      createProductionSandboxLifecycle({
        lifecycle,
        backendKind: "linux_podman",
        templateFingerprint: contentHash(DIGEST),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectLifecycleCode(error, code);
      return true;
    });
    expect(lifecycle.probeCalls).toBe(scenario === "test" ? 0 : 1);
  });

  it("probes once, fences policy mutations, and retains lifecycle state", async () => {
    const lifecycle = new RecordingLifecycle();
    const production = await createProductionSandboxLifecycle({
      lifecycle,
      backendKind: "linux_podman",
      templateFingerprint: contentHash(DIGEST),
    });
    expect(lifecycle.probeCalls).toBe(1);
    const createRequest = request();
    const instance = await production.create(createRequest);
    expect(lifecycle.createCalls).toBe(1);
    const result = await production.execute(
      execution(instance.instanceId, createRequest.policyFingerprint),
    );
    expect(result.exitCode).toBe(0);
    expect(lifecycle.executeCalls).toBe(1);
    const replay = await production.create(createRequest);
    expect(replay).toEqual({ ...instance, state: "running" });
    expect(lifecycle.createCalls).toBe(1);

    const wrongFingerprint = {
      ...createRequest.policyFingerprint,
      digest: contentHash("1".repeat(64)),
    };
    await expect(production.stop(instance.instanceId, wrongFingerprint)).rejects.toSatisfy(
      (error: unknown) => {
        expectLifecycleCode(error, "policy_fingerprint_mismatch");
        return true;
      },
    );
    expect(lifecycle.stopCalls).toBe(0);

    await production.stop(instance.instanceId, createRequest.policyFingerprint);
    expect(lifecycle.stopCalls).toBe(1);
    await expect(
      production.execute(execution(instance.instanceId, createRequest.policyFingerprint)),
    ).rejects.toSatisfy((error: unknown) => {
      expectLifecycleCode(error, "instance_stopped");
      return true;
    });
    expect(lifecycle.executeCalls).toBe(1);
    await production.stop(instance.instanceId, createRequest.policyFingerprint);
    expect(lifecycle.stopCalls).toBe(1);
    await expect(production.destroy(instance.instanceId, wrongFingerprint)).rejects.toSatisfy(
      (error: unknown) => {
        expectLifecycleCode(error, "policy_fingerprint_mismatch");
        return true;
      },
    );
    expect(lifecycle.destroyCalls).toBe(0);
    await production.destroy(instance.instanceId, createRequest.policyFingerprint);
    expect(lifecycle.destroyCalls).toBe(1);
    await production.destroy(instance.instanceId, createRequest.policyFingerprint);
    expect(lifecycle.destroyCalls).toBe(1);
    await production.stop(instance.instanceId, createRequest.policyFingerprint);
    expect(lifecycle.stopCalls).toBe(1);
    await expect(production.create(createRequest)).rejects.toSatisfy((error: unknown) => {
      expectLifecycleCode(error, "idempotency_conflict");
      return true;
    });
    expect(lifecycle.createCalls).toBe(1);
  });

  it("rejects execution requests that exceed the created policy before delegation", async () => {
    const lifecycle = new RecordingLifecycle();
    const production = await createProductionSandboxLifecycle({
      lifecycle,
      backendKind: "linux_podman",
      templateFingerprint: contentHash(DIGEST),
    });
    const createRequest = request();
    const instance = await production.create(createRequest);
    const valid = execution(instance.instanceId, createRequest.policyFingerprint);
    const violations = [
      { ...valid, executable: "sh" },
      { ...valid, executable: "/scratch/git" },
      { ...valid, workingDirectory: "/etc" },
      { ...valid, timeoutMs: createRequest.policy.resources.executionTimeoutMs + 1 },
      { ...valid, maxOutputBytes: createRequest.policy.resources.maxOutputBytes + 1 },
      { ...valid, arguments: ["-C", ".", "push"] },
      { ...valid, arguments: ["-c", "alias.ship=push", "ship", "origin", "HEAD"] },
      { ...valid, arguments: ["-c", "alias.shell=!sh -c id", "shell"] },
      // The three above end in a token that's blocked/disallowed on its own
      // merits, so they were already rejected before this fix - for the
      // WRONG reason, and don't exercise the actual P1. These two end in
      // "status", which the fixture's tools.allowedGitSubcommands DOES
      // allow: pre-fix, parseGitSubcommand skipped past -c/--work-tree to
      // report the harmless-looking "status" token and the request was
      // WRONGLY ACCEPTED, even though the -c/--work-tree value redefines
      // what "status" does (an alias running an arbitrary command) or
      // redirects it to an unconfined directory.
      { ...valid, arguments: ["-c", "alias.status=!sh -c id", "status"] },
      { ...valid, arguments: ["--work-tree=/outside", "status"] },
      { ...valid, arguments: ["-C", "/outside", "status"] },
    ] satisfies readonly ExecuteSandboxRequest[];

    for (const violation of violations) {
      await expect(production.execute(violation)).rejects.toSatisfy((error: unknown) => {
        expectLifecycleCode(error, "policy_violation");
        return true;
      });
    }
    expect(lifecycle.executeCalls).toBe(0);
  });

  it("serializes identical creates and lifecycle transitions", async () => {
    let releaseExecute: (() => void) | undefined;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const lifecycle = new RecordingLifecycle({ executeGate });
    const production = await createProductionSandboxLifecycle({
      lifecycle,
      backendKind: "linux_podman",
      templateFingerprint: contentHash(DIGEST),
    });
    const createRequest = request();
    const [first, replay] = await Promise.all([
      production.create(createRequest),
      production.create(createRequest),
    ]);
    expect(replay).toEqual(first);
    expect(lifecycle.createCalls).toBe(1);

    const executing = production.execute(
      execution(first.instanceId, createRequest.policyFingerprint),
    );
    const destroying = production.destroy(first.instanceId, createRequest.policyFingerprint);
    await Promise.resolve();
    expect(lifecycle.destroyCalls).toBe(0);
    releaseExecute?.();
    await executing;
    await destroying;
    expect(lifecycle.executeCalls).toBe(1);
    expect(lifecycle.destroyCalls).toBe(1);
    await expect(production.create(createRequest)).rejects.toSatisfy((error: unknown) => {
      expectLifecycleCode(error, "idempotency_conflict");
      return true;
    });
  });

  it("fences idempotency replays and template mutation before delegation", async () => {
    const lifecycle = new RecordingLifecycle();
    const production = await createProductionSandboxLifecycle({
      lifecycle,
      backendKind: "linux_podman",
      templateFingerprint: contentHash(DIGEST),
    });
    const original = request();
    await production.create(original);
    expect(lifecycle.createCalls).toBe(1);
    const changedPolicy = {
      ...original.policy,
      tools: { ...original.policy.tools, allowedExecutables: ["git"] },
    } satisfies SandboxPolicy;
    await expect(
      production.create({
        ...original,
        policy: changedPolicy,
        policyFingerprint: fingerprintSandboxPolicy(changedPolicy),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectLifecycleCode(error, "idempotency_conflict");
      return true;
    });
    const changedContextRequest = {
      ...original,
      context: { ...original.context, hostId: OTHER_HOST_ID },
    };
    await expect(production.create(changedContextRequest)).rejects.toSatisfy((error: unknown) => {
      expectLifecycleCode(error, "idempotency_conflict");
      return true;
    });
    const mismatchedTemplatePolicy = {
      ...original.policy,
      templateDigest: contentHash("1".repeat(64)),
    } satisfies SandboxPolicy;
    await expect(production.create(request(mismatchedTemplatePolicy))).rejects.toSatisfy(
      (error: unknown) => {
        expectLifecycleCode(error, "template_fingerprint_mismatch");
        return true;
      },
    );
    expect(lifecycle.createCalls).toBe(1);
  });

  it("cleans malformed create receipts and rejects oversized backend output", async () => {
    const malformedBackend = new RecordingLifecycle({
      createContext: {
        attemptId: ATTEMPT_ID,
        nodeId: NODE_ID,
        repositoryId: REPOSITORY_ID,
        hostId: OTHER_HOST_ID,
      },
    });
    const malformedProduction = await createProductionSandboxLifecycle({
      lifecycle: malformedBackend,
      backendKind: "linux_podman",
      templateFingerprint: contentHash(DIGEST),
    });
    await expect(malformedProduction.create(request())).rejects.toSatisfy((error: unknown) => {
      expectLifecycleCode(error, "instance_identity_mismatch");
      return true;
    });
    expect(malformedBackend.destroyCalls).toBe(1);

    const outputBackend = new RecordingLifecycle({
      executeResult: {
        exitCode: 0,
        stdout: new Uint8Array(1_024),
        stderr: new Uint8Array(1),
      },
    });
    const outputProduction = await createProductionSandboxLifecycle({
      lifecycle: outputBackend,
      backendKind: "linux_podman",
      templateFingerprint: contentHash(DIGEST),
    });
    const createRequest = request();
    const instance = await outputProduction.create(createRequest);
    await expect(
      outputProduction.execute(execution(instance.instanceId, createRequest.policyFingerprint)),
    ).rejects.toSatisfy((error: unknown) => {
      expectLifecycleCode(error, "output_limit");
      return true;
    });
    expect(outputBackend.executeCalls).toBe(1);
  });
});
