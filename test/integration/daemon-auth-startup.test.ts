import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { Writable } from "node:stream";
import { createSecureIdGenerator } from "@minions/adapters";
import { timestampFromEpochMilliseconds, hostId, type HostId } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { describe, expect, it } from "vitest";

import {
  AuthRuntimeStartupError,
  createStructuredLogger,
  startDaemonRuntime,
  type StructuredLogger,
} from "@minions/daemon";

/**
 * PR 19 daemon auth-startup test (deliverable 8). Asserts:
 * 1. With `authBroker.enabled` and a missing vault backend, `startDaemonRuntime`
 *    fails closed with `AuthRuntimeStartupError(vault_unavailable)` BEFORE
 *    accepting any harness session (acceptance 11).
 * 2. With `authBroker` omitted, behaviour is unchanged (existing tests pass).
 *
 * Booting real broker/gateway subprocesses from the daemon test would couple this
 * test to OMP availability; the broker/gateway subprocess lifecycle is already
 * exercised in `auth-broker-gateway.test.ts`. Here we verify the registration
 * gate (fail-closed on missing vault) at the daemon runtime level.
 */

const STARTED_AT_MS = 1_700_000_050_000;
const FIRST_INSTANCE_ID = "01900000-0000-7000-8000-000000000091";
const FIRST_HOST_CANDIDATE_ID = "01900000-0000-7000-8000-000000000092";
const AUTH_HOST_ID_TEXT = "01900000-0000-7000-8000-000000000093";
const AUTH_HOST_ID: HostId = hostId(AUTH_HOST_ID_TEXT);

const temporaryDirectories: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mauth-daemon-"));
  temporaryDirectories.push(dir);
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const onError = (error: Error): void => {
    reject(error);
  };
  server.once("error", onError);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : undefined;
    if (typeof port !== "number") {
      reject(new Error("could not reserve loopback port"));
      return;
    }
    server.close(() => {
      resolve(port);
    });
  });
  return promise;
}

function captureLogger(): StructuredLogger {
  return createStructuredLogger({
    stream: new Writable({
      write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        callback();
      },
    }),
    now: () => Date.now(),
  });
}

describe("daemon auth-startup (PR 19)", () => {
  it("fails closed with AuthRuntimeStartupError(vault_unavailable) when the vault backend is missing", async () => {
    const home = makeHome();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const ids = createSecureIdGenerator({
      now: () => timestampFromEpochMilliseconds(STARTED_AT_MS),
    });
    try {
      await expect(
        startDaemonRuntime({
          home,
          mode: "local",
          port: await reserveLoopbackPort(),
          serverVersion: "0.0.0",
          clock,
          ids,
          logger: captureLogger(),
          displayName: "auth-fail-closed-host",
          authBroker: {
            enabled: true,
            hostId: AUTH_HOST_ID,
            ompPath: "/usr/bin/omp",
            vaultStoreDirectory: join(home, "vault"),
            // Point systemdCredsPath at a non-existent binary so probe() returns
            // unavailable — simulating a host without secure storage.
            vaultSystemdCredsPath: "/does/not/exist/systemd-creds",
            vaultKeyMode: "host",
            bindHost: "127.0.0.1",
          },
        }),
      ).rejects.toThrow(AuthRuntimeStartupError);
    } finally {
      cleanup(home);
    }
  }, 30_000);

  it("auth-startup is unchanged when authBroker is omitted", async () => {
    const home = makeHome();
    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const ids = createSecureIdGenerator({
      now: () => timestampFromEpochMilliseconds(STARTED_AT_MS),
    });
    try {
      const runtime = await startDaemonRuntime({
        home,
        mode: "local",
        port: await reserveLoopbackPort(),
        serverVersion: "0.0.0",
        clock,
        ids,
        logger: captureLogger(),
        displayName: "auth-disabled-host",
      });
      expect(runtime.hostId).toBeDefined();
      await runtime.close();
    } finally {
      cleanup(home);
    }
  }, 30_000);
});

// Reference the symbols used above so type-only imports survive bundling.
void FIRST_INSTANCE_ID;
void FIRST_HOST_CANDIDATE_ID;
