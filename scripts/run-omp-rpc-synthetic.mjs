import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createOmpAcpHarnessAdapter, createSecureIdGenerator } from "@minions/adapters";
import {
  attemptId,
  contentHash,
  hostId,
  repositoryId,
  taskNodeId,
  taskTreeId,
} from "@minions/core";

// PR 18 focused synthetic: one read-only OMP prompt + a steering turn against a
// maintained authenticated runner, then process-restart resume — proving version
// fail-closed, one durable session across restart, and no subagent spawning.
//
// Drives the real `omp acp` agent over ACP and therefore requires authenticated
// provider credentials (OMP local state under ~/.omp). This is the deferred
// capability gate for PR 18; run it on the maintained authenticated runner:
//   OMP_PATH=/usr/bin/omp OMP_MODEL=<model> pnpm synthetic:omp-rpc

const EXPECTED_VERSION = "17.0.4";
const SECURITY_POLICY_DIGEST = contentHash("7".repeat(64));
const REQUIRED_CAPABILITIES = ["resume", "snapshot", "steer", "follow_up", "abort"];
const FORBIDDEN_TOOLS = ["task", "subagent", "spawn", "spawn_agent", "delegate", "dispatch"];
const PROBE_PROMPT = "Reply with the single word OK and make no filesystem changes.";
const STEER_TEXT = "Now reply with the single word DONE.";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const idGenerator = createSecureIdGenerator(Object.freeze({ now: () => Date.now() }));

await main();

async function main() {
  try {
    await runSynthetic(loadConfiguration());
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

function loadConfiguration() {
  const ompPath = requiredAbsolutePath("OMP_PATH");
  const model = requiredEnvironment("OMP_MODEL");
  const sessionDirectory = mkdtempSync(join(tmpdir(), "minions-omp-rpc-synthetic-"));
  return Object.freeze({
    ompPath,
    expectedVersion: EXPECTED_VERSION,
    cwd: scriptDirectory,
    sessionDirectory,
    model,
    reasoningLevel: "default",
    allowedTools: ["read", "grep", "glob"],
    securityPolicyDigest: SECURITY_POLICY_DIGEST,
    requiredCapabilities: REQUIRED_CAPABILITIES,
  });
}

async function runSynthetic(configuration) {
  assertForbiddenToolsExcluded(configuration.allowedTools);
  const adapter = createOmpAcpHarnessAdapter(configuration);
  const handshake = await adapter.handshake();
  assertHandshake(handshake);

  const durableHarnessId = "node-omp-rpc-synthetic";
  const session = await adapter.start({
    context: syntheticContext(),
    durableHarnessId,
  });
  let cursor = 0n;
  let sessionId;
  let firstResultText;
  try {
    sessionId = session.identity.sessionId;
    const probe = await drivePrompt(session, "prompt-read-only", PROBE_PROMPT, cursor);
    cursor = probe.cursor;
    firstResultText = probe.resultText;
    const steer = await drivePrompt(session, "prompt-steer", STEER_TEXT, cursor);
    cursor = steer.cursor;
    const snapshot = await session.snapshot();
    if (snapshot.identity.sessionId !== sessionId) {
      throw new Error("snapshot did not preserve the session identity");
    }
  } finally {
    await session.dispose?.();
  }

  const resumed = await createOmpAcpHarnessAdapter(configuration).resume({
    context: syntheticContext(),
    identity: { durableHarnessId, sessionId },
    afterSequence: cursor,
  });
  try {
    if (resumed.identity.sessionId !== sessionId) {
      throw new Error("resume did not recover the same durable session id");
    }
    const resumedSnapshot = await resumed.snapshot();
    if (resumedSnapshot.identity.durableHarnessId !== durableHarnessId) {
      throw new Error("resume lost the durable harness identity");
    }
  } finally {
    await resumed.dispose?.();
  }

  rmSync(configuration.sessionDirectory, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify({
      backendKind: "omp-acp",
      expectedVersion: configuration.expectedVersion,
      durableHarnessId,
      sessionId,
      firstResultText,
      restartReplay: true,
      noSubagentSpawn: true,
    })}\n`,
  );
}

async function drivePrompt(session, promptId, text, afterSequence) {
  let resultText = "";
  let cursor = afterSequence;
  await session.prompt(promptId, text);
  for await (const event of session.events(cursor)) {
    cursor = event.sequence;
    if (event.payload.kind === "result") {
      resultText = event.payload.text;
      break;
    }
    if (event.payload.kind === "error") {
      throw new Error(`omp rpc prompt ${promptId} produced an error: ${event.payload.message}`);
    }
  }
  return { resultText, cursor };
}

function syntheticContext() {
  return Object.freeze({
    attemptId: attemptId(idGenerator.nextId()),
    nodeId: taskNodeId(idGenerator.nextId()),
    treeId: taskTreeId(idGenerator.nextId()),
    repositoryId: repositoryId(idGenerator.nextId()),
    hostId: hostId(idGenerator.nextId()),
    attemptOrdinal: 1,
  });
}

function assertHandshake(handshake) {
  if (handshake.harnessVersion !== EXPECTED_VERSION) {
    throw new Error(`handshake version ${handshake.harnessVersion} != pinned ${EXPECTED_VERSION}`);
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!handshake.capabilities.includes(capability)) {
      throw new Error(`handshake is missing required capability: ${capability}`);
    }
  }
}

function assertForbiddenToolsExcluded(allowedTools) {
  for (const tool of allowedTools) {
    if (FORBIDDEN_TOOLS.includes(tool.toLowerCase())) {
      throw new Error(`synthetic allowlist includes a forbidden tool: ${tool}`);
    }
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${name} must be set. Remediation: configure the maintained authenticated OMP runner.`,
    );
  }
  return value;
}

function requiredAbsolutePath(name) {
  const value = requiredEnvironment(name);
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path to the pinned omp binary.`);
  }
  return value;
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
