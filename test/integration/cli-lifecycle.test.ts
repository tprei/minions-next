import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { Writable } from "node:stream";

import { timestampFromEpochMilliseconds } from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import {
  acquireLifecycleLock,
  createSecureIdGenerator,
  daemonLifecyclePath,
} from "@minions/adapters";
import { main } from "../../apps/cli/src/index.js";
import {
  createStructuredLogger,
  startDaemonRuntime,
  type RunningDaemonRuntime,
} from "@minions/daemon";
import { afterEach, describe, expect, it } from "vitest";

const INSTANCE_ID = "01900000-0000-7000-8000-000000000001";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI lifecycle safety", () => {
  it("does not signal a stale PID when daemon health is unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-cli-lifecycle-"));
    temporaryDirectories.push(home);
    const port = await reserveLoopbackPort();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    if (unrelated.pid === undefined) {
      throw new Error("unrelated process did not start");
    }
    const unrelatedPid = unrelated.pid;
    const lock = acquireLifecycleLock({
      path: daemonLifecyclePath(home),
      record: {
        instanceId: INSTANCE_ID,
        mode: "local",
        pid: unrelatedPid,
        port,
        startedAtMs: 1_700_000_000_000,
      },
    });

    try {
      expect(await main(["stop", "--home", home])).toBe(3);
      expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
    } finally {
      lock.release();
      unrelated.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        unrelated.once("exit", () => {
          resolve();
        }),
      );
    }
  });
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("loopback port reservation did not bind to a TCP address"));
      return;
    }
    server.close((error) => {
      if (error === undefined) {
        resolve(address.port);
      } else {
        reject(error);
      }
    });
  });
  return promise;
}

// -------------------------------------------------------------------------------------------------
// PR 42: `minions tree provenance <treeId>` integration coverage.
//
// Drives the CLI against a real daemon (register -> create -> propose -> approve)
// and asserts the `tree provenance` document's shape and root-to-leaf node
// ordering. Outcome recording is intentionally NOT exercised here:
// ArtifactRegistry.recordOutcome hard-requires the node to be ACTIVE
// (packages/adapters/src/sqlite/artifact-registry.ts), and reaching ACTIVE
// needs the real scheduler lease pipeline, which has no RPC surface and is
// out of scope for this CLI-level test. Both nodes therefore report a null
// `outcome`, which is itself part of the contract this test verifies.
// -------------------------------------------------------------------------------------------------

const PROVENANCE_STARTED_AT_MS = 1_700_000_000_000;
const PROVENANCE_INSTANCE_ID = "01900000-0000-7000-8000-000000000601";
const PROVENANCE_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000602";
const PROVENANCE_REGISTER_EVENT_ID = "01900000-0000-7000-8000-000000000603";
const PROVENANCE_CREATE_EVENT_ID = "01900000-0000-7000-8000-000000000604";
const PROVENANCE_PROPOSE_EVENT_ID = "01900000-0000-7000-8000-000000000605";
const PROVENANCE_APPROVE_EVENT_ID = "01900000-0000-7000-8000-000000000606";
const PROVENANCE_REVISION_ID = "01900000-0000-7000-8000-000000000608";
const PROVENANCE_CHILD_NODE_ID = "01900000-0000-7000-8000-000000000609";

interface ProvenanceGitFixture {
  readonly directory: string;
  readonly root: string;
  readonly baseCommit: string;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function createProvenanceGitFixture(): Promise<ProvenanceGitFixture> {
  const directory = await mkdtemp(join(tmpdir(), "minions-cli-provenance-"));
  const origin = join(directory, "origin.git");
  const root = join(directory, "working");
  try {
    await runGit(directory, ["init", "--bare", origin]);
    await runGit(directory, ["clone", origin, root]);
    await runGit(root, ["config", "user.name", "CLI Provenance Test"]);
    await runGit(root, ["config", "user.email", "cli-provenance@example.test"]);
    await runGit(root, ["checkout", "-b", "main"]);
    await mkdir(join(root, ".minions"), { recursive: true });
    await writeFile(
      join(root, ".minions", "gates.yaml"),
      'required_categories:\n  - lint\ngates:\n  lint:\n    executable: "true"\n',
      "utf8",
    );
    await writeFile(join(root, "README.md"), "cli-provenance\n", "utf8");
    await runGit(root, ["add", "README.md", ".minions/gates.yaml"]);
    await runGit(root, ["commit", "-m", "initial"]);
    await runGit(root, ["push", "--set-upstream", "origin", "main"]);
    await runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await runGit(root, ["fetch", "origin"]);
    await runGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const baseCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    await runGit(root, [
      "remote",
      "set-url",
      "origin",
      "https://github.com/Minions/cli-provenance",
    ]);
    return { directory, root, baseCommit };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

function discardWritable(): Writable {
  return new Writable({
    write(
      _chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      callback();
    },
  });
}

function createOutputCapture(): Readonly<{ chunks: string[]; stream: Writable }> {
  const chunks: string[] = [];
  return {
    chunks,
    stream: new Writable({
      write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        chunks.push(chunk.toString("utf8"));
        callback();
      },
    }),
  };
}

async function closeWritable(stream: Writable): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  stream.end((error?: Error | null) => {
    if (error === undefined || error === null) {
      resolve(undefined);
    } else {
      reject(error);
    }
  });
  await promise;
}

async function captureCli(
  action: () => Promise<number>,
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const originalStdout = process.stdout;
  const originalStderr = process.stderr;
  Object.defineProperty(process, "stdout", { configurable: true, value: stdout.stream });
  Object.defineProperty(process, "stderr", { configurable: true, value: stderr.stream });
  try {
    const code = await action();
    return { code, stdout: stdout.chunks.join(""), stderr: stderr.chunks.join("") };
  } finally {
    Object.defineProperty(process, "stdout", { configurable: true, value: originalStdout });
    Object.defineProperty(process, "stderr", { configurable: true, value: originalStderr });
    await closeWritable(stdout.stream);
    await closeWritable(stderr.stream);
  }
}

async function captureCliJson(
  action: () => Promise<number>,
): Promise<Readonly<{ code: number; json: unknown }>> {
  const captured = await captureCli(action);
  expect(captured.stderr).toBe("");
  if (captured.stdout.length === 0) {
    throw new Error("CLI did not produce JSON output");
  }
  return { code: captured.code, json: JSON.parse(captured.stdout) as unknown };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function jsonString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("expected a JSON string");
  }
  return value;
}

function jsonArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("expected a JSON array");
  }
  return value;
}

describe("CLI tree provenance export", () => {
  it("aggregates tree -> node -> outcome provenance in root-to-leaf order", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-cli-provenance-home-"));
    const fixture = await createProvenanceGitFixture();
    const logStream = discardWritable();
    const clock = new FixedClock(timestampFromEpochMilliseconds(PROVENANCE_STARTED_AT_MS));
    const logger = createStructuredLogger({ stream: logStream, now: () => clock.now() });
    let runtime: RunningDaemonRuntime | undefined;
    let planPath: string | undefined;
    try {
      const port = await reserveLoopbackPort();
      runtime = await startDaemonRuntime({
        home,
        mode: "local",
        port,
        serverVersion: "1.0.0",
        clock,
        ids: new SequenceIdGenerator([
          PROVENANCE_INSTANCE_ID,
          PROVENANCE_HOST_CANDIDATE_ID,
          PROVENANCE_REGISTER_EVENT_ID,
          PROVENANCE_CREATE_EVENT_ID,
          PROVENANCE_PROPOSE_EVENT_ID,
          PROVENANCE_APPROVE_EVENT_ID,
        ]),
        logger,
        displayName: "cli-provenance-test-host",
      });

      const registration = await captureCliJson(() =>
        main(["repository", "register", fixture.root, "--home", home]),
      );
      expect(registration.code).toBe(0);
      const repositoryId = jsonString(
        jsonRecord(jsonRecord(registration.json)["repository"])["id"],
      );

      const created = await captureCliJson(() =>
        main([
          "tree",
          "create",
          repositoryId,
          "provenance export root",
          fixture.baseCommit,
          "--max-depth",
          "4",
          "--max-fan-out",
          "3",
          "--max-nodes",
          "8",
          "--max-concurrency",
          "2",
          "--max-attempts-per-node",
          "2",
          "--root-allowed-path",
          ".",
          "--home",
          home,
        ]),
      );
      expect(created.code).toBe(0);
      const createdTree = jsonRecord(jsonRecord(created.json)["tree"]);
      const treeId = jsonString(createdTree["id"]);
      const rootNodeId = jsonString(createdTree["root_node_id"]);

      planPath = join(home, "provenance-plan.json");
      await writeFile(
        planPath,
        JSON.stringify({
          goal: "provenance export root",
          nodes: [
            {
              nodeId: PROVENANCE_CHILD_NODE_ID,
              parentNodeId: rootNodeId,
              mode: "PLAN_NODE_MODE_IMPLEMENTATION",
              objective: "implement the provenance child",
              acceptanceCriteria: ["the provenance child is implementable"],
              inputs: [],
              implementation: {},
              allowedRepositoryPaths: ["src"],
            },
          ],
        }),
        "utf8",
      );

      const proposed = await captureCliJson(() =>
        main(["tree", "propose", treeId, PROVENANCE_REVISION_ID, planPath ?? "", "--home", home]),
      );
      expect(proposed.code).toBe(0);

      const approved = await captureCliJson(() =>
        main(["tree", "approve", treeId, PROVENANCE_REVISION_ID, "--home", home]),
      );
      expect(approved.code).toBe(0);
      const approvedTree = jsonRecord(jsonRecord(approved.json)["tree"]);
      const approvedNodes = jsonArray(approvedTree["nodes"]).map((node) => jsonRecord(node));
      const childNode = approvedNodes.find((node) => node["id"] === PROVENANCE_CHILD_NODE_ID);
      if (childNode === undefined) {
        throw new Error("approved tree is missing the provenance child node");
      }
      const childState = jsonString(childNode["state"]);

      const provenance = await captureCliJson(() =>
        main(["tree", "provenance", treeId, "--home", home]),
      );
      expect(provenance.code).toBe(0);
      const document = jsonRecord(provenance.json);
      expect(document["treeId"]).toBe(treeId);
      const nodes = jsonArray(document["nodes"]).map((node) => jsonRecord(node));
      expect(nodes).toHaveLength(2);

      const [rootProvenance, childProvenance] = nodes;
      if (rootProvenance === undefined || childProvenance === undefined) {
        throw new Error("provenance document did not contain both nodes");
      }
      // Root-to-leaf order: the parent (root) precedes its child, matching
      // `tree.nodes` ordering from the underlying GetTree response.
      expect(rootProvenance["nodeId"]).toBe(rootNodeId);
      expect(rootProvenance["parentNodeId"]).toBeUndefined();
      expect(rootProvenance["objective"]).toBe("provenance export root");
      expect(rootProvenance["state"]).toBe("NODE_STATE_PLANNED");
      expect(rootProvenance["vcsChangeBinding"]).toBeUndefined();
      expect(rootProvenance["outcome"]).toBeNull();

      expect(childProvenance["nodeId"]).toBe(PROVENANCE_CHILD_NODE_ID);
      expect(childProvenance["parentNodeId"]).toBe(rootNodeId);
      expect(childProvenance["objective"]).toBe("implement the provenance child");
      expect(childProvenance["state"]).toBe(childState);
      expect(childProvenance["vcsChangeBinding"]).toBeUndefined();
      expect(childProvenance["outcome"]).toBeNull();

      const malformed = await captureCli(() => main(["tree", "provenance", "--home", home]));
      expect(malformed.code).toBe(2);
    } finally {
      await runtime?.close();
      await closeWritable(logStream);
      await rm(planPath ?? join(home, "provenance-plan.json"), { force: true });
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });
});

// -------------------------------------------------------------------------------------------------
// PR 42: `minions node get` / `minions node steer` / `minions node attention` integration coverage.
//
// Drives the CLI against a real daemon (register -> create -> propose -> approve) so a
// steerable node exists, then exercises the node-scoped inspect/steer/attention commands
// that complete the create/approve/inspect/steer workflow (create = tree create,
// approve = tree approve, inspect = node get, steer = node steer / node attention).
// -------------------------------------------------------------------------------------------------

const NODE_STEER_STARTED_AT_MS = 1_700_000_000_000;
const NODE_STEER_CHILD_NODE_ID = "01900000-0000-7000-8000-000000000701";
const NODE_STEER_REVISION_ID = "01900000-0000-7000-8000-000000000702";
const NODE_STEER_MISSING_NODE_ID = "01900000-0000-7000-8000-0000000000ff";

describe("CLI node inspection and steering", () => {
  it("inspects, steers, and lists attention for a node through a real daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-cli-node-home-"));
    const fixture = await createProvenanceGitFixture();
    const logStream = discardWritable();
    const clock = new FixedClock(timestampFromEpochMilliseconds(NODE_STEER_STARTED_AT_MS));
    const logger = createStructuredLogger({ stream: logStream, now: () => clock.now() });
    let runtime: RunningDaemonRuntime | undefined;
    let planPath: string | undefined;
    try {
      const port = await reserveLoopbackPort();
      runtime = await startDaemonRuntime({
        home,
        mode: "local",
        port,
        serverVersion: "1.0.0",
        clock,
        ids: createSecureIdGenerator(clock),
        logger,
        displayName: "cli-node-steering-test-host",
      });

      const registration = await captureCliJson(() =>
        main(["repository", "register", fixture.root, "--home", home]),
      );
      expect(registration.code).toBe(0);
      const repositoryId = jsonString(
        jsonRecord(jsonRecord(registration.json)["repository"])["id"],
      );

      const created = await captureCliJson(() =>
        main([
          "tree",
          "create",
          repositoryId,
          "node steering root",
          fixture.baseCommit,
          "--max-depth",
          "4",
          "--max-fan-out",
          "3",
          "--max-nodes",
          "8",
          "--max-concurrency",
          "2",
          "--max-attempts-per-node",
          "2",
          "--root-allowed-path",
          ".",
          "--home",
          home,
        ]),
      );
      expect(created.code).toBe(0);
      const createdTree = jsonRecord(jsonRecord(created.json)["tree"]);
      const treeId = jsonString(createdTree["id"]);
      const rootNodeId = jsonString(createdTree["root_node_id"]);

      planPath = join(home, "node-steering-plan.json");
      await writeFile(
        planPath,
        JSON.stringify({
          goal: "node steering root",
          nodes: [
            {
              nodeId: NODE_STEER_CHILD_NODE_ID,
              parentNodeId: rootNodeId,
              mode: "PLAN_NODE_MODE_IMPLEMENTATION",
              objective: "implement the steerable child",
              acceptanceCriteria: ["the steerable child is implementable"],
              inputs: [],
              implementation: {},
              allowedRepositoryPaths: ["src"],
            },
          ],
        }),
        "utf8",
      );

      const proposed = await captureCliJson(() =>
        main(["tree", "propose", treeId, NODE_STEER_REVISION_ID, planPath ?? "", "--home", home]),
      );
      expect(proposed.code).toBe(0);

      const approved = await captureCliJson(() =>
        main(["tree", "approve", treeId, NODE_STEER_REVISION_ID, "--home", home]),
      );
      expect(approved.code).toBe(0);
      const approvedTree = jsonRecord(jsonRecord(approved.json)["tree"]);
      const approvedNodes = jsonArray(approvedTree["nodes"]).map((node) => jsonRecord(node));
      const childNode = approvedNodes.find((node) => node["id"] === NODE_STEER_CHILD_NODE_ID);
      if (childNode === undefined) {
        throw new Error("approved tree is missing the steerable child node");
      }
      expect(jsonString(childNode["state"])).toBe("NODE_STATE_READY");

      const missingNode = await captureCli(() =>
        main(["node", "get", treeId, NODE_STEER_MISSING_NODE_ID, "--home", home]),
      );
      expect(missingNode.code).toBe(1);

      const fetched = await captureCliJson(() =>
        main(["node", "get", treeId, NODE_STEER_CHILD_NODE_ID, "--home", home]),
      );
      expect(fetched.code).toBe(0);
      const fetchedDocument = jsonRecord(fetched.json);
      const fetchedNode = jsonRecord(fetchedDocument["node"]);
      expect(fetchedNode["id"]).toBe(NODE_STEER_CHILD_NODE_ID);
      expect(fetchedNode["objective"]).toBe("implement the steerable child");
      expect(fetchedDocument["outcome"]).toBeUndefined();
      expect(jsonArray(fetchedDocument["attention"])).toHaveLength(0);
      expect(jsonArray(fetchedDocument["commands"])).toHaveLength(0);

      const steered = await captureCliJson(() =>
        main([
          "node",
          "steer",
          treeId,
          NODE_STEER_CHILD_NODE_ID,
          "text",
          "--text",
          "focus on the acceptance criteria",
          "--home",
          home,
        ]),
      );
      expect(steered.code).toBe(0);
      const steeredCommand = jsonRecord(jsonRecord(steered.json)["command"]);
      expect(steeredCommand["node_id"]).toBe(NODE_STEER_CHILD_NODE_ID);
      expect(steeredCommand["ordinal"]).toBe("1");
      expect(steeredCommand["delivery_state"]).toBe("NODE_COMMAND_DELIVERY_STATE_QUEUED");
      const steeredPayload = jsonRecord(steeredCommand["payload"]);
      expect(steeredPayload["case"]).toBe("text");
      expect(steeredPayload["text"]).toBe("focus on the acceptance criteria");

      const afterSteer = await captureCliJson(() =>
        main(["node", "get", treeId, NODE_STEER_CHILD_NODE_ID, "--home", home]),
      );
      expect(afterSteer.code).toBe(0);
      const afterSteerCommands = jsonArray(jsonRecord(afterSteer.json)["commands"]).map((command) =>
        jsonRecord(command),
      );
      expect(afterSteerCommands).toHaveLength(1);
      expect(afterSteerCommands[0]?.["command_id"]).toBe(steeredCommand["command_id"]);

      const attention = await captureCliJson(() =>
        main(["node", "attention", treeId, "--home", home]),
      );
      expect(attention.code).toBe(0);
      expect(jsonArray(jsonRecord(attention.json)["attention"])).toHaveLength(0);

      const scopedAttention = await captureCliJson(() =>
        main(["node", "attention", treeId, "--node-id", NODE_STEER_CHILD_NODE_ID, "--home", home]),
      );
      expect(scopedAttention.code).toBe(0);
      expect(jsonArray(jsonRecord(scopedAttention.json)["attention"])).toHaveLength(0);

      const missingAnswer = await captureCli(() =>
        main(["node", "steer", treeId, NODE_STEER_CHILD_NODE_ID, "answer", "--home", home]),
      );
      expect(missingAnswer.code).toBe(2);
    } finally {
      await runtime?.close();
      await closeWritable(logStream);
      await rm(planPath ?? join(home, "node-steering-plan.json"), { force: true });
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });
});

// -------------------------------------------------------------------------------------------------
// One-prompt templated trees: `minions tree create-templated`.
//
// Drives the CLI against a real daemon and asserts that a template name plus a
// prompt alone produces a correctly shaped task DAG: EXPLAIN auto-approves a
// read-only RESEARCH child, FIX proposes a RESEARCH -> IMPLEMENTATION chain
// that stays DRAFT until a human approves. The budget flags and the root
// allowed path are deliberately absent — they come from the template.
// -------------------------------------------------------------------------------------------------

const TEMPLATED_STARTED_AT_MS = 1_700_000_000_000;
const TEMPLATED_REPOSITORY_ID = "01900000-0000-7000-8000-000000000901";
const TEMPLATED_TREE_ID = "01900000-0000-7000-8000-000000000902";
const TEMPLATED_BASE_COMMIT = "ab".repeat(20);

async function capturedUsageError(action: () => Promise<number>): Promise<string> {
  const captured = await captureCli(action);
  expect(captured.code).toBe(2);
  const error = jsonRecord(JSON.parse(captured.stderr) as unknown);
  expect(jsonString(error["code"])).toBe("invalid_usage");
  return jsonString(error["message"]);
}

function jsonNodes(value: unknown): readonly Record<string, unknown>[] {
  return jsonArray(value).map((node) => jsonRecord(node));
}

describe("CLI templated tree usage", () => {
  it("rejects unknown templates and misplaced flags without contacting a daemon", async () => {
    expect(
      await capturedUsageError(() =>
        main(["tree", "create-templated", TEMPLATED_REPOSITORY_ID, "deploy", "explain the bug"]),
      ),
    ).toBe("template must be explain, fix, or feature");

    expect(
      await capturedUsageError(() =>
        main(["tree", "get", TEMPLATED_TREE_ID, "--base-commit", TEMPLATED_BASE_COMMIT]),
      ),
    ).toBe("--base-commit is only valid with tree create-templated");

    expect(
      await capturedUsageError(() =>
        main([
          "tree",
          "create-templated",
          TEMPLATED_REPOSITORY_ID,
          "fix",
          "stop the flaky retry test",
          "--base-commit",
          "nothex",
        ]),
      ),
    ).toBe("base commit must be 40 or 64 lowercase hexadecimal characters");
  });
});

describe("CLI templated tree creation", () => {
  it("creates shaped trees from a prompt through a real daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "minions-cli-templated-home-"));
    const fixture = await createProvenanceGitFixture();
    const logStream = discardWritable();
    const clock = new FixedClock(timestampFromEpochMilliseconds(TEMPLATED_STARTED_AT_MS));
    const logger = createStructuredLogger({ stream: logStream, now: () => clock.now() });
    let runtime: RunningDaemonRuntime | undefined;
    try {
      const port = await reserveLoopbackPort();
      runtime = await startDaemonRuntime({
        home,
        mode: "local",
        port,
        serverVersion: "1.0.0",
        clock,
        ids: createSecureIdGenerator(clock),
        logger,
        displayName: "cli-templated-tree-test-host",
      });

      const registration = await captureCliJson(() =>
        main(["repository", "register", fixture.root, "--home", home]),
      );
      expect(registration.code).toBe(0);
      const repositoryId = jsonString(
        jsonRecord(jsonRecord(registration.json)["repository"])["id"],
      );

      const explained = await captureCliJson(() =>
        main([
          "tree",
          "create-templated",
          repositoryId,
          "explain",
          "explain why the retry loop drops messages",
          "--home",
          home,
        ]),
      );
      expect(explained.code).toBe(0);
      const explainedTree = jsonRecord(jsonRecord(explained.json)["tree"]);
      expect(jsonString(explainedTree["state"])).toBe("TREE_STATE_APPROVED");
      expect(jsonString(explainedTree["goal"])).toBe("explain why the retry loop drops messages");
      expect(jsonString(explainedTree["base_commit"])).toBe(fixture.baseCommit);
      const explainedBudget = jsonRecord(explainedTree["budget"]);
      for (const field of [
        "max_depth",
        "max_fan_out",
        "max_nodes",
        "max_concurrency",
        "max_attempts_per_node",
      ]) {
        expect(typeof explainedBudget[field]).toBe("number");
      }
      const explainedRevisions = jsonNodes(explainedTree["revisions"]);
      expect(explainedRevisions).toHaveLength(1);
      expect(jsonString(explainedRevisions[0]?.["state"])).toBe("PLAN_REVISION_STATE_APPROVED");

      const explainedNodes = jsonNodes(explainedTree["nodes"]);
      expect(explainedNodes).toHaveLength(2);
      const explainedRoot = explainedNodes.find((node) => node["mode"] === "PLAN_NODE_MODE_PLAN");
      const explainedResearch = explainedNodes.find(
        (node) => node["mode"] === "PLAN_NODE_MODE_RESEARCH",
      );
      if (explainedRoot === undefined || explainedResearch === undefined) {
        throw new Error("explained tree is missing the root or research node");
      }
      expect(explainedRoot["parent_node_id"]).toBeUndefined();
      expect(jsonString(explainedRoot["state"])).toBe("NODE_STATE_PLANNED");
      expect(jsonString(explainedResearch["parent_node_id"])).toBe(
        jsonString(explainedTree["root_node_id"]),
      );
      expect(jsonString(explainedResearch["state"])).toBe("NODE_STATE_READY");
      expect(jsonString(explainedResearch["objective"]).length).toBeGreaterThan(0);
      expect(jsonArray(explainedResearch["acceptance_criteria"]).length).toBeGreaterThan(0);
      expect(jsonRecord(explainedResearch["artifact"])["artifact_id"]).toBeDefined();
      expect(explainedResearch["implementation"]).toBeUndefined();

      const fixed = await captureCliJson(() =>
        main([
          "tree",
          "create-templated",
          repositoryId,
          "fix",
          "stop the flaky retry test",
          "--base-commit",
          fixture.baseCommit,
          "--home",
          home,
        ]),
      );
      expect(fixed.code).toBe(0);
      const fixedTree = jsonRecord(jsonRecord(fixed.json)["tree"]);
      expect(jsonString(fixedTree["state"])).toBe("TREE_STATE_APPROVED");
      expect(jsonString(fixedTree["goal"])).toBe("stop the flaky retry test");
      expect(jsonString(fixedTree["base_commit"])).toBe(fixture.baseCommit);
      const fixedRevisions = jsonNodes(fixedTree["revisions"]);
      expect(fixedRevisions).toHaveLength(1);
      expect(jsonString(fixedRevisions[0]?.["state"])).toBe("PLAN_REVISION_STATE_APPROVED");

      const fixedNodes = jsonNodes(fixedTree["nodes"]);
      expect(fixedNodes).toHaveLength(3);
      const fixedResearch = fixedNodes.find((node) => node["mode"] === "PLAN_NODE_MODE_RESEARCH");
      const fixedImplementation = fixedNodes.find(
        (node) => node["mode"] === "PLAN_NODE_MODE_IMPLEMENTATION",
      );
      if (fixedResearch === undefined || fixedImplementation === undefined) {
        throw new Error("fixed tree is missing the research or implementation node");
      }
      expect(jsonString(fixedResearch["parent_node_id"])).toBe(
        jsonString(fixedTree["root_node_id"]),
      );
      expect(jsonString(fixedResearch["state"])).toBe("NODE_STATE_READY");
      expect(jsonString(fixedImplementation["parent_node_id"])).toBe(
        jsonString(fixedResearch["id"]),
      );
      expect(jsonString(fixedImplementation["state"])).toBe("NODE_STATE_PLANNED");
      expect(jsonString(fixedImplementation["objective"]).length).toBeGreaterThan(0);
      expect(jsonArray(fixedImplementation["acceptance_criteria"]).length).toBeGreaterThan(0);
      expect(fixedImplementation["implementation"]).toBeDefined();
      expect(fixedImplementation["artifact"]).toBeUndefined();
    } finally {
      await runtime?.close();
      await closeWritable(logStream);
      await rm(fixture.directory, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  });
});
