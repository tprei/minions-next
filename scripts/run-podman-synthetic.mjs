import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { TextDecoder } from "node:util";
import {
  createSecureIdGenerator,
  createLinuxPodmanSandboxLifecycle,
  createWsl2PodmanSandboxLifecycle,
  createSandboxPolicyFingerprinter,
  preparePodmanImage,
} from "@minions/adapters";
import { attemptId, contentHash, hostId, repositoryId, taskNodeId } from "@minions/core";
import {
  createSandboxContractFixture,
  executeSandboxContract,
  sandboxContractScenarios,
} from "@minions/testkit";

const POLICY_PROCESS_LIMIT = 16;
const POLICY_EXECUTION_TIMEOUT_MS = 120_000;
const POLICY_MAX_OUTPUT_BYTES = 65_536;
const EXPECTED_SCENARIO_COUNT = 26;
const ISOLATION_MARKER = "MINIONS_PODMAN_ISOLATION_OK";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const seccompProfilePath = resolve(
  scriptDirectory,
  "../packages/adapters/assets/podman/seccomp-default.json",
);
const idGenerator = createSecureIdGenerator(Object.freeze({ now: () => Date.now() }));

await main();

async function main() {
  try {
    const configuration = await loadConfiguration();
    const mode = process.argv[2];
    if (mode === "prepare") {
      await prepareMode(configuration);
      return;
    }
    if (mode === "run") {
      await runMode(configuration);
      return;
    }
    throw new Error(
      `usage: node scripts/run-podman-synthetic.mjs <prepare|run> (backend: ${configuration.backendKind})`,
    );
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

async function loadConfiguration() {
  assertLinuxHost();
  const storageRoot = requiredAbsoluteEnvironmentPath("MINIONS_PODMAN_STORAGE");
  const stateRoot = requiredAbsoluteEnvironmentPath("MINIONS_PODMAN_STATE");
  await assertWritableRoot(storageRoot, "MINIONS_PODMAN_STORAGE");
  await assertWritableRoot(stateRoot, "MINIONS_PODMAN_STATE");
  const podmanPath = await resolvePodman();
  await assertRegularFile(seccompProfilePath, "Podman seccomp profile asset");
  const imageReference = requiredEnvironment("MINIONS_PODMAN_IMAGE_REF");
  const expectedImageDigest = requiredDigest("MINIONS_PODMAN_IMAGE_DIGEST");
  const backendKind = resolveBackendKind();
  const runtime = Object.freeze({
    podmanPath,
    version: requiredEnvironment("MINIONS_PODMAN_VERSION"),
  });
  const template = Object.freeze({
    podmanPath,
    imageReference,
    expectedImageDigest,
    storageRoot,
    stateRoot,
    runtime,
  });
  return Object.freeze({ storageRoot, stateRoot, podmanPath, backendKind, template });
}

function resolveBackendKind() {
  const explicit = process.env.MINIONS_PODMAN_BACKEND;
  if (explicit === "linux") return "linux_podman";
  if (explicit === "wsl2") return "wsl2_podman";
  if (explicit !== undefined) {
    throw new Error(
      "MINIONS_PODMAN_BACKEND must be 'linux' or 'wsl2'. Remediation: Omit it for auto-detection or set it explicitly.",
    );
  }
  return typeof process.env.WSL_DISTRO_NAME === "string" && process.env.WSL_DISTRO_NAME.length > 0
    ? "wsl2_podman"
    : "linux_podman";
}

async function prepareMode(configuration) {
  const receipt = await preparePodmanImage(configuration.template);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

async function runMode(configuration) {
  const imageFingerprint = requiredFingerprint();
  const expectedTemplateFingerprint = Object.freeze({
    policyVersion: 1,
    digest: imageFingerprint,
  });
  const lifecycle = createLifecycle(configuration, expectedTemplateFingerprint);
  const probe = await lifecycle.probe();
  assertProbe(probe, imageFingerprint, configuration.backendKind);
  const tracker = new Map();
  const trackedLifecycle = trackLifecycle(lifecycle, tracker);
  let fixture;
  let finalReceipt;
  let primaryError;
  try {
    fixture = await createSandboxContractFixture({
      prefix: "minions-podman-synthetic-",
      templateDigest: contentHash(imageFingerprint),
    });
    await writeFile(join(fixture.workspace, "Dockerfile"), "FROM scratch\n", "utf8");
    await writeFile(
      join(fixture.workspace, "readonly-probe.mjs"),
      'await (await import("node:fs/promises")).writeFile(process.argv[2], "mutated");\n',
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "timeout-probe.mjs"),
      'await (await import("node:fs/promises")).writeFile(process.argv[2], String(process.pid)); setInterval(() => {}, 1_000);\n',
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "output-probe.mjs"),
      'process.stdout.write("x".repeat(131_072));\n',
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "process-probe.mjs"),
      'const child = (await import("node:child_" + "process"))["sp" + "awn"]("/usr/bin/docker", ["run", "--privileged", "ubuntu"]); child.on("error", () => process.exit(7)); child.on("exit", (code) => process.exit(code === 0 ? 7 : 0));\n',
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "network-probe.mjs"),
      'const http = await import("node:http"); const server = http.createServer((_request, response) => response.end("open")); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); const port = typeof address === "object" && address !== null ? address.port : 0; fetch(["http", "://", "127.0.0.1:", String(port)].join("")).then(() => { server.close(); process.exit(0); }, () => { server.close(); process.exit(7); });\n',
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "resource-probe.mjs"),
      'const child = await import("node:child_" + "process"); const children = Array.from({ length: 64 }, () => child["sp" + "awn"]("/usr/local/bin/node", ["-e", "setInterval(() => {}, 1_000)"])); let denied = false; for (const childProcess of children) { childProcess.on("error", () => { denied = true; }); } setTimeout(() => { for (const childProcess of children) childProcess.kill(); process.exitCode = denied ? 7 : 0; }, 1_000);\n',
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "survivor-probe.mjs"),
      'const fs = await import("node:fs/promises"); const pid = (await fs.readFile(process.argv[2], "utf8")).trim(); fs.access(`/proc/${pid}`).then(() => process.exit(7), () => process.exit(0));\n',
      "utf8",
    );
    await writeFile(
      join(fixture.workspace, "memory-probe.mjs"),
      "const chunks = []; for (let index = 0; index < 48; index += 1) { const chunk = Buffer.alloc(64 * 1_024 * 1_024); chunk.fill(index); chunks.push(chunk); } process.exit(0);\n",
      "utf8",
    );
    const syntheticFixture = createSyntheticFixture(fixture);
    const fingerprinter = createSandboxPolicyFingerprinter();
    const policyFingerprint = fingerprinter.fingerprint(syntheticFixture.policy);
    const sentinelsBefore = await syntheticFixture.snapshotSentinels();
    const report = await executeSandboxContract(
      trackedLifecycle,
      syntheticFixture,
      fingerprinter,
      Object.freeze({ teardown: false }),
    );
    assertContractReport(report, syntheticFixture, sentinelsBefore);

    const replayRequest = {
      context: syntheticFixture.context,
      idempotencyKey: "sandbox-contract-baseline",
      policy: syntheticFixture.policy,
      policyFingerprint,
    };
    const freshLifecycle = createLifecycle(configuration, expectedTemplateFingerprint);
    const freshTrackedLifecycle = trackLifecycle(freshLifecycle, tracker);
    const secondInstance = await freshTrackedLifecycle.create(replayRequest);
    if (secondInstance.instanceId !== report.baselineInstanceId) {
      throw new Error("fresh lifecycle did not recover the contract sandbox instance");
    }
    const replayInstance = await freshTrackedLifecycle.create(replayRequest);
    if (JSON.stringify(secondInstance) !== JSON.stringify(replayInstance)) {
      throw new Error("fresh lifecycle replay did not return the exact live sandbox instance");
    }
    await assertKernelEnforcement(
      freshTrackedLifecycle,
      secondInstance.instanceId,
      policyFingerprint,
      syntheticFixture,
    );

    const dockerResult = await freshTrackedLifecycle.execute({
      instanceId: secondInstance.instanceId,
      expectedPolicyFingerprint: policyFingerprint,
      executable: "docker",
      arguments: ["build", "--network=none", "--tag", "minions-podman-synthetic:v1", "."],
      workingDirectory: syntheticFixture.workspace,
      environment: Object.freeze({}),
      timeoutMs: POLICY_EXECUTION_TIMEOUT_MS,
      maxOutputBytes: POLICY_MAX_OUTPUT_BYTES,
    });
    if (dockerResult.exitCode !== 0) {
      throw new Error(`internal Docker build failed: ${decode(dockerResult.stderr)}`);
    }
    const dockerOutput = `${decode(dockerResult.stdout)}${decode(dockerResult.stderr)}`.trim();
    if (dockerOutput.length === 0) throw new Error("internal Docker build produced no output");
    const isolationPaths = await isolationProbePaths(
      configuration,
      secondInstance.instanceId,
      syntheticFixture,
    );
    const isolationResult = await freshTrackedLifecycle.execute({
      instanceId: secondInstance.instanceId,
      expectedPolicyFingerprint: policyFingerprint,
      executable: "node",
      arguments: ["-e", isolationProbeScript()],
      workingDirectory: syntheticFixture.workspace,
      environment: Object.freeze({
        MINIONS_PODMAN_PROBE_PATHS: JSON.stringify(isolationPaths),
      }),
      timeoutMs: 30_000,
      maxOutputBytes: 4_096,
    });
    const isolationOutput = decode(isolationResult.stdout).trim();
    if (isolationResult.exitCode !== 0 || isolationOutput !== ISOLATION_MARKER) {
      throw new Error(
        `in-guest isolation probe failed: ${decode(isolationResult.stderr)}${isolationOutput}`,
      );
    }
    const sentinelsAfter = await syntheticFixture.snapshotSentinels();
    if (!recordsEqual(sentinelsBefore, sentinelsAfter)) {
      throw new Error("sandbox synthetic changed a host sentinel");
    }
    await freshTrackedLifecycle.stop(secondInstance.instanceId, policyFingerprint);
    await freshTrackedLifecycle.stop(secondInstance.instanceId, policyFingerprint);
    await freshTrackedLifecycle.destroy(secondInstance.instanceId, policyFingerprint);
    await freshTrackedLifecycle.destroy(secondInstance.instanceId, policyFingerprint);
    finalReceipt = Object.freeze({
      backendKind: configuration.backendKind,
      templateFingerprint: imageFingerprint,
      scenarioIds: sandboxContractScenarios.map((scenario) => scenario.id),
      restartReplay: true,
      kernelEnforcement: true,
      dockerOutput,
      isolationMarker: ISOLATION_MARKER,
      cleanupConfirmed: true,
    });
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = await cleanupTrackedInstances(tracker);
  let fixtureError;
  if (fixture !== undefined) {
    try {
      await fixture.dispose();
    } catch (error) {
      fixtureError = error;
    }
  }
  const failures = [...cleanupErrors];
  if (fixtureError !== undefined) failures.push(fixtureError);
  if (primaryError !== undefined) failures.unshift(primaryError);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Podman synthetic failed");
  }
  if (finalReceipt === undefined) throw new Error("Podman synthetic did not produce a receipt");
  process.stdout.write(`${JSON.stringify(finalReceipt)}\n`);
}

function createLifecycle(configuration, expectedTemplateFingerprint) {
  const common = Object.freeze({
    storageRoot: configuration.storageRoot,
    stateRoot: configuration.stateRoot,
    podmanPath: configuration.podmanPath,
    seccompProfilePath,
    template: configuration.template,
    expectedTemplateFingerprint,
  });
  return configuration.backendKind === "wsl2_podman"
    ? createWsl2PodmanSandboxLifecycle(
        Object.freeze({ ...common, wslDistroName: requiredEnvironment("WSL_DISTRO_NAME") }),
      )
    : createLinuxPodmanSandboxLifecycle(common);
}

function trackLifecycle(lifecycle, tracker) {
  return Object.freeze({
    backendKind: lifecycle.backendKind,
    probe: () => lifecycle.probe(),
    create: async (request) => {
      const instance = await lifecycle.create(request);
      tracker.set(instance.instanceId, {
        lifecycle,
        policyFingerprint: request.policyFingerprint,
      });
      return instance;
    },
    execute: (request) => lifecycle.execute(request),
    stop: (instanceId, expectedPolicyFingerprint) =>
      lifecycle.stop(instanceId, expectedPolicyFingerprint),
    destroy: async (instanceId, expectedPolicyFingerprint) => {
      await lifecycle.destroy(instanceId, expectedPolicyFingerprint);
      tracker.delete(instanceId);
    },
  });
}

function createSyntheticFixture(fixture) {
  const allowedExecutables = [...fixture.policy.tools.allowedExecutables];
  if (!allowedExecutables.includes("docker")) allowedExecutables.push("docker");
  const policy = Object.freeze({
    ...fixture.policy,
    tools: Object.freeze({
      ...fixture.policy.tools,
      allowedExecutables: Object.freeze(allowedExecutables),
      allowedGitSubcommands: Object.freeze(["status"]),
      blockedGitSubcommands: Object.freeze([
        "branch",
        "commit",
        "fetch",
        "push",
        "remote",
        "worktree",
      ]),
    }),
    resources: Object.freeze({
      ...fixture.policy.resources,
      cpuCount: 2,
      memoryMiB: 2_048,
      processLimit: POLICY_PROCESS_LIMIT,
      storageMiB: 4_096,
      executionTimeoutMs: POLICY_EXECUTION_TIMEOUT_MS,
      maxOutputBytes: POLICY_MAX_OUTPUT_BYTES,
    }),
  });
  return Object.freeze({ ...fixture, context: syntheticContext(), policy });
}

function syntheticContext() {
  return Object.freeze({
    attemptId: attemptId(idGenerator.nextId()),
    nodeId: taskNodeId(idGenerator.nextId()),
    repositoryId: repositoryId(idGenerator.nextId()),
    hostId: hostId(idGenerator.nextId()),
  });
}

function assertContractReport(report, fixture, sentinelsBefore) {
  if (report.scenarioCount !== EXPECTED_SCENARIO_COUNT) {
    throw new Error(`sandbox contract ran ${String(report.scenarioCount)} scenarios instead of 26`);
  }
  if (!report.passed || !report.results.every((result) => result.passed)) {
    throw new Error("sandbox contract did not pass every malicious scenario");
  }
  const scenarioIds = sandboxContractScenarios.map((scenario) => scenario.id);
  if (JSON.stringify(report.results.map((result) => result.id)) !== JSON.stringify(scenarioIds)) {
    throw new Error("sandbox contract scenario IDs are not in the maintained order");
  }
  if (!report.sentinelsUnchanged || !recordsEqual(report.sentinelsAfter, report.sentinelsBefore)) {
    throw new Error("sandbox contract changed a host sentinel");
  }
  if (!recordsEqual(report.sentinelsAfter, fixture.sentinelContents)) {
    throw new Error("sandbox contract sentinel contents do not match the fixture");
  }
  if (!recordsEqual(report.sentinelsBefore, sentinelsBefore)) {
    throw new Error("sandbox contract sentinel baseline changed unexpectedly");
  }
}

async function assertKernelEnforcement(lifecycle, instanceId, policyFingerprint, fixture) {
  const execute = (script, arguments_ = [], timeoutMs = 10_000, maxOutputBytes = 16_384) =>
    lifecycle.execute({
      instanceId,
      expectedPolicyFingerprint: policyFingerprint,
      executable: "node",
      arguments: [`./${script}`, ...arguments_],
      workingDirectory: fixture.workspace,
      environment: Object.freeze({}),
      timeoutMs,
      maxOutputBytes,
    });
  const readonlyResult = await execute("readonly-probe.mjs", [fixture.workspaceSentinel]);
  if (readonlyResult.exitCode === 0) throw new Error("kernel read-only mount probe was allowed");
  const processResult = await execute("process-probe.mjs");
  if (processResult.exitCode === 0) throw new Error("kernel undeclared-process probe was allowed");
  const networkResult = await execute("network-probe.mjs");
  if (networkResult.exitCode === 0) throw new Error("kernel loopback-network probe was allowed");
  const resourceResult = await execute("resource-probe.mjs");
  if (resourceResult.exitCode === 0) throw new Error("kernel process-limit probe was allowed");
  const timeoutPidPath = join(fixture.scratch, "timeout-probe.pid");
  try {
    const timeoutResult = await execute("timeout-probe.mjs", [timeoutPidPath], 1_000);
    if (timeoutResult.exitCode === 0) throw new Error("kernel runtime-limit probe was allowed");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "command_timeout") {
      throw error;
    }
  }
  const survivorResult = await execute("survivor-probe.mjs", [timeoutPidPath]);
  if (survivorResult.exitCode !== 0) {
    throw new Error("kernel runtime-limit probe left a surviving process");
  }
  const memoryResult = await execute("memory-probe.mjs", [], 30_000);
  if (memoryResult.exitCode === 0) throw new Error("kernel memory-limit probe was allowed");
  try {
    await execute("output-probe.mjs", [], 10_000, 1_024);
    throw new Error("kernel output-limit probe was allowed");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "output_limit") {
      throw error;
    }
  }
}

async function isolationProbePaths(configuration, instanceId, fixture) {
  const hostHome = process.env.HOME;
  if (typeof hostHome !== "string" || !isAbsolute(hostHome)) {
    throw new Error("HOME must be an absolute path for the isolation probe");
  }
  await assertDirectory(hostHome, "host home");
  await assertDirectory(fixture.siblingWorkspace, "fixture sibling workspace");
  await assertRegularFile(fixture.daemonSocket, "fixture daemon socket sentinel");
  const paths = [
    Object.freeze({ path: hostHome, kind: "directory" }),
    Object.freeze({ path: fixture.siblingWorkspace, kind: "directory" }),
    Object.freeze({ path: fixture.daemonSocket, kind: "file" }),
  ];
  if (configuration.backendKind === "wsl2_podman") {
    const windowsDrive = "/mnt/c";
    const windowsInterop = "/run/WSL";
    if (await pathExists(windowsDrive)) {
      paths.push(Object.freeze({ path: windowsDrive, kind: "directory" }));
    }
    if (await pathExists(windowsInterop)) {
      paths.push(Object.freeze({ path: windowsInterop, kind: "directory" }));
    }
  }
  const podmanSocket = resolve(configuration.storageRoot, "podman.sock");
  if (await pathExists(podmanSocket)) {
    paths.push(Object.freeze({ path: podmanSocket, kind: "file" }));
  }
  return Object.freeze(paths);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isolationProbeScript() {
  return `
const fs = await import("node:fs/promises");
const paths = JSON.parse(process.env.MINIONS_PODMAN_PROBE_PATHS);
function denied(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["EACCES", "EISDIR", "ENAMETOOLONG", "ENODEV", "ENOENT", "ENOTDIR", "ENXIO", "EPERM"].includes(error.code);
}
async function blocked(candidate) {
  try {
    if (candidate.kind === "directory") await fs.readdir(candidate.path);
    else await fs.readFile(candidate.path);
    return false;
  } catch (error) {
    if (!denied(error)) throw error;
    return true;
  }
}
const results = await Promise.all(paths.map(blocked));
if (results.every(Boolean)) process.stdout.write(${JSON.stringify(ISOLATION_MARKER)});
else process.exitCode = 1;
`;
}

async function cleanupTrackedInstances(tracker) {
  const errors = [];
  for (const [instanceId, record] of [...tracker.entries()]) {
    try {
      await record.lifecycle.destroy(instanceId, record.policyFingerprint);
      tracker.delete(instanceId);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function assertProbe(probe, expectedFingerprint, backendKind) {
  if (!probe.available) {
    throw new Error(`${probe.message}. Remediation: ${probeRemediation(probe)}`);
  }
  if (probe.templateFingerprint !== expectedFingerprint) {
    throw new Error("Podman capability probe returned the wrong image fingerprint");
  }
  const capabilities = probe.capabilities;
  if (
    !capabilities.readOnlyMounts ||
    !capabilities.processIsolation ||
    !capabilities.privateNetworkBlocking ||
    !capabilities.toolFiltering
  ) {
    throw new Error("Podman capability probe is missing a required sandbox capability");
  }
  if (!capabilities.supportedNetworkProfiles.includes("implementation")) {
    throw new Error("Podman capability probe does not support the implementation network profile");
  }
  if (backendKind === "wsl2_podman" && capabilities.nestedContainers) {
    throw new Error("WSL2 Podman capability probe must not advertise nested containers by default");
  }
  if (sandboxContractScenarios.length !== EXPECTED_SCENARIO_COUNT) {
    throw new Error(
      `maintained sandbox contract has ${String(sandboxContractScenarios.length)} scenarios`,
    );
  }
}

function probeRemediation(probe) {
  if (probe.failureCode === "capability_unavailable") {
    return "Install the configured rootless Podman version and rerun host doctor.";
  }
  if (probe.failureCode === "wsl_context_invalid") {
    return "Enable systemd in the configured WSL2 distribution and rerun host doctor.";
  }
  return "Use explicit writable Podman storage and state roots and rebuild the pinned image.";
}

function assertLinuxHost() {
  if (platform() !== "linux") {
    throw new Error(
      "the Podman backend requires a Linux host (bare Linux or a WSL2 distribution). Remediation: Select the Lima backend on macOS or attach a Linux/WSL2 execution host.",
    );
  }
}

async function resolvePodman() {
  const pathValue = process.env.PATH;
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new Error(
      "podman is unavailable. Remediation: Install rootless Podman and ensure podman is executable on PATH.",
    );
  }
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory.length === 0 ? process.cwd() : resolve(directory), "podman");
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
      const resolvedPath = await realpath(candidate);
      const resolvedMetadata = await lstat(resolvedPath);
      if (resolvedMetadata.isFile() && (resolvedMetadata.mode & 0o111) !== 0) return resolvedPath;
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
  }
  throw new Error(
    "podman is unavailable. Remediation: Install rootless Podman and ensure podman is executable on PATH.",
  );
}

async function assertDirectory(path, field) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) throw new Error(`${field} is not a directory`);
}

async function assertRegularFile(path, field) {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`${field} is unavailable`);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${name} must be set. Remediation: Run host setup with the pinned image details.`,
    );
  }
  return value;
}

function requiredDigest(name) {
  const value = requiredEnvironment(name);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(
      `${name} must be a lowercase 64-hex sha256 digest (without the sha256: prefix)`,
    );
  }
  return value;
}

function requiredAbsoluteEnvironmentPath(name) {
  const value = process.env[name];
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    basename(value).length === 0
  ) {
    throw new Error(
      `${name} must be an absolute normalized path. Remediation: Run host setup with explicit dedicated Podman storage and state paths.`,
    );
  }
  return value;
}

async function assertWritableRoot(path, name) {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error("not a real directory");
    await access(path, constants.W_OK);
  } catch (error) {
    throw new Error(
      `${name} must be an explicit writable real directory. Remediation: Run host setup with explicit dedicated Podman storage and state paths.`,
      { cause: error },
    );
  }
}

function requiredFingerprint() {
  const value = process.env.MINIONS_PODMAN_IMAGE_FINGERPRINT;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("MINIONS_PODMAN_IMAGE_FINGERPRINT must be an exact lowercase 64-hex digest");
  }
  return value;
}

function recordsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decode(value) {
  return new TextDecoder().decode(value);
}

function isMissingPathError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function formatError(error) {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(formatError)].join("; ");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
