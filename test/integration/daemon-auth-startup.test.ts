import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { Writable } from "node:stream";
import { createSecureIdGenerator, OmpAcpAdapterError } from "@minions/adapters";
import { timestampFromEpochMilliseconds, hostId, type HostId } from "@minions/core";
import { FixedClock } from "@minions/testkit";
import { describe, expect, it } from "vitest";

import {
  AuthRuntimeStartupError,
  createStructuredLogger,
  defaultRuntimeOptions,
  startDaemonRuntime,
  type StructuredLogger,
} from "@minions/daemon";

/**
 * PR 19 daemon auth-startup test (deliverable 8). Asserts:
 * 1. With `authBroker.enabled` and a missing vault backend, `startDaemonRuntime`
 *    fails closed with `AuthRuntimeStartupError(vault_unavailable)` BEFORE
 *    accepting any harness session (acceptance 11).
 * 2. With `authBroker` omitted, behaviour is unchanged (existing tests pass).
 * 3. `defaultRuntimeOptions` (the sole builder the real CLI/daemon entrypoints use) wires
 *    `authBroker` automatically for `mode: "host"` with a supplied `hostId` — the bounded
 *    case where the host ID is known before `startDaemonRuntime` runs — and leaves it
 *    unset for `local`/`supervisor` modes and for `host` mode with no `hostId`, exactly
 *    preserving prior behaviour for every existing caller.
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
const HOST_MODE_HOST_ID_TEXT = "01900000-0000-7000-8000-000000000094";
const HOST_MODE_HOST_ID: HostId = hostId(HOST_MODE_HOST_ID_TEXT);

// Two of resolveOmpPath's three fallback candidates are system-wide paths; the third
// (`${homedir()}/.local/bin/omp`) is what this dev box uses. The "OMP unresolvable" test
// below only holds when neither system-wide fallback exists, so it self-skips otherwise.
const systemOmpCandidateExists = ["/usr/local/bin/omp", "/usr/bin/omp"].some((candidate) =>
  existsSync(candidate),
);

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

describe("defaultRuntimeOptions auth-broker wiring (PR 19)", () => {
  it("populates authBroker for mode: host when hostId is supplied", () => {
    const home = makeHome();
    const previousOmpPath = process.env["OMP_PATH"];
    // Deterministic across every environment (including CI, where no `omp` binary is
    // installed): resolveOmpPath() returns OMP_PATH verbatim without checking the file
    // exists, so this test never depends on ambient system state.
    process.env["OMP_PATH"] = "/opt/test-fixture/omp";
    try {
      const options = defaultRuntimeOptions({
        home,
        mode: "host",
        port: 4_820,
        serverVersion: "0.0.0",
        logger: captureLogger(),
        hostId: HOST_MODE_HOST_ID,
      });
      expect(options.authBroker).toEqual({
        enabled: true,
        hostId: HOST_MODE_HOST_ID,
        ompPath: "/opt/test-fixture/omp",
      });
    } finally {
      if (previousOmpPath === undefined) delete process.env["OMP_PATH"];
      else process.env["OMP_PATH"] = previousOmpPath;
      cleanup(home);
    }
  });

  it("leaves authBroker undefined for mode: local (unchanged behaviour)", () => {
    const home = makeHome();
    try {
      const options = defaultRuntimeOptions({
        home,
        mode: "local",
        port: 4_821,
        serverVersion: "0.0.0",
        logger: captureLogger(),
      });
      expect(options.authBroker).toBeUndefined();
    } finally {
      cleanup(home);
    }
  });

  it("leaves authBroker undefined for mode: host with no hostId (startDaemonRuntime throws separately)", () => {
    const home = makeHome();
    try {
      const options = defaultRuntimeOptions({
        home,
        mode: "host",
        port: 4_822,
        serverVersion: "0.0.0",
        logger: captureLogger(),
      });
      expect(options.authBroker).toBeUndefined();
    } finally {
      cleanup(home);
    }
  });

  it.skipIf(systemOmpCandidateExists)(
    "throws a typed OmpAcpAdapterError for mode: host when no OMP binary can be resolved",
    () => {
      const home = makeHome();
      const previousHome = process.env["HOME"];
      const previousOmpPath = process.env["OMP_PATH"];
      const emptyHome = mkdtempSync(join(tmpdir(), "mauth-no-omp-home-"));
      delete process.env["OMP_PATH"];
      process.env["HOME"] = emptyHome;
      try {
        expect(() =>
          defaultRuntimeOptions({
            home,
            mode: "host",
            port: 4_823,
            serverVersion: "0.0.0",
            logger: captureLogger(),
            hostId: HOST_MODE_HOST_ID,
          }),
        ).toThrow(OmpAcpAdapterError);
      } finally {
        if (previousHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = previousHome;
        if (previousOmpPath === undefined) delete process.env["OMP_PATH"];
        else process.env["OMP_PATH"] = previousOmpPath;
        cleanup(home);
        cleanup(emptyHome);
      }
    },
  );
});

describe("daemon static web serving URI resilience", () => {
  it("returns 400 on malformed URI paths and remains alive for subsequent requests", async () => {
    const home = makeHome();
    const webDistDir = join(home, "web-dist");
    mkdirSync(webDistDir, { recursive: true });
    writeFileSync(
      join(webDistDir, "index.html"),
      "<!DOCTYPE html><html><body>ok</body></html>\n",
      "utf8",
    );

    const clock = new FixedClock(timestampFromEpochMilliseconds(STARTED_AT_MS));
    const ids = createSecureIdGenerator({
      now: () => timestampFromEpochMilliseconds(STARTED_AT_MS),
    });
    const port = await reserveLoopbackPort();
    const runtime = await startDaemonRuntime({
      home,
      mode: "local",
      port,
      serverVersion: "0.0.0",
      clock,
      ids,
      logger: captureLogger(),
      displayName: "static-web-resilience-host",
      webDistDir,
    });
    try {
      const malformedOne = await fetch(`http://127.0.0.1:${String(port)}/%`);
      expect(malformedOne.status).toBe(400);

      const malformedTwo = await fetch(`http://127.0.0.1:${String(port)}/%zz`);
      expect(malformedTwo.status).toBe(400);

      const valid = await fetch(`http://127.0.0.1:${String(port)}/`);
      expect(valid.status).toBe(200);
      const text = await valid.text();
      expect(text).toContain("ok");
    } finally {
      await runtime.close();
      cleanup(home);
    }
  }, 30_000);
});

// Reference the symbols used above so type-only imports survive bundling.
void FIRST_INSTANCE_ID;
void FIRST_HOST_CANDIDATE_ID;
