import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { acquireLifecycleLock, daemonLifecyclePath } from "@minions/adapters";
import { main } from "../../apps/cli/src/index.js";
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
