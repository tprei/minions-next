import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSystemRecoveryRestarter } from "../../../apps/daemon/src/recovery-restart.js";
import type { StructuredLogger } from "../../../apps/daemon/src/logger.js";

/**
 * Recovery restart adapter unit tests (PR 56 — maintenance-elevation-recovery).
 *
 * `node:child_process` is mocked so these tests exercise the real detection +
 * invocation logic (argv construction, exit-code handling, stderr propagation,
 * timeout handling) deterministically, without depending on a real systemd/launchd
 * environment. Each test configures `execFileMock` to answer specific argv shapes,
 * mirroring how the genuine `systemctl`/`launchctl` CLIs behave.
 */

type ExecFileCallback = (
  error: (Error & { killed?: boolean; code?: number | string | null }) | null,
  stdout: string,
  stderr: string,
) => void;

const execFileMock =
  vi.fn<
    (
      command: string,
      args: readonly string[],
      options: unknown,
      callback: ExecFileCallback,
    ) => EventEmitter
  >();

type SpawnedProcess = EventEmitter & { unref: () => void };

const spawnMock =
  vi.fn<(command: string, args: readonly string[], options: unknown) => SpawnedProcess>();

vi.mock("node:child_process", () => ({
  execFile: (...callArgs: Parameters<typeof execFileMock>) => execFileMock(...callArgs),
  spawn: (...callArgs: Parameters<typeof spawnMock>) => spawnMock(...callArgs),
}));

function fakeLogger(): StructuredLogger & {
  calls: { level: string; event: string; fields: unknown }[];
} {
  const calls: { level: string; event: string; fields: unknown }[] = [];
  return {
    calls,
    log(level, event, fields = {}) {
      calls.push({ level, event, fields });
    },
  };
}

function answer(exitCode: number, stdout: string, stderr: string): void {
  execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
    if (exitCode === 0) {
      callback(null, stdout, stderr);
    } else {
      const error = Object.assign(new Error(`Command failed`), { code: exitCode });
      callback(error, stdout, stderr);
    }
    return new EventEmitter();
  });
}

function answerTimeout(): void {
  execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
    const error = Object.assign(new Error("Command timed out"), {
      killed: true,
      signal: "SIGKILL",
    }) as Error & { killed: boolean };
    callback(error, "", "");
    return new EventEmitter();
  });
}

function spawnSucceeds(): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as SpawnedProcess;
    child.unref = vi.fn();
    queueMicrotask(() => {
      child.emit("spawn");
    });
    return child;
  });
}

function spawnFails(message: string): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as SpawnedProcess;
    child.unref = vi.fn();
    queueMicrotask(() => {
      child.emit("error", new Error(message));
    });
    return child;
  });
}

let originalPlatform: PropertyDescriptor | undefined;
let originalGetuid: typeof process.getuid;

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  originalGetuid = process.getuid;
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform(): void {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  if (originalGetuid) {
    process.getuid = originalGetuid;
  }
}

describe("createSystemRecoveryRestarter", () => {
  it("restarts via systemd with the correct argv when the unit is active", async () => {
    setPlatform("linux");
    try {
      answer(0, "active\n", "");
      answer(0, "", "");
      const logger = fakeLogger();
      const restarter = createSystemRecoveryRestarter({ logger });
      await restarter.restart("primary-daemon");

      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(execFileMock.mock.calls[0]?.[0]).toBe("systemctl");
      expect(execFileMock.mock.calls[0]?.[1]).toEqual(["--user", "is-active", "minions.service"]);
      expect(execFileMock.mock.calls[1]?.[0]).toBe("systemd-run");
      expect(execFileMock.mock.calls[1]?.[1]).toEqual([
        "--user",
        "--collect",
        "--no-block",
        "--",
        "systemctl",
        "--user",
        "restart",
        "minions.service",
      ]);
      expect(logger.calls.some((c) => c.event === "recovery_restart_invoked")).toBe(true);
    } finally {
      restorePlatform();
    }
  });

  it("restarts via launchd with the correct argv when the agent is loaded", async () => {
    setPlatform("darwin");
    process.getuid = () => 501;
    try {
      answer(0, "", "");
      spawnSucceeds();
      const logger = fakeLogger();
      const restarter = createSystemRecoveryRestarter({ logger });
      await restarter.restart("primary-daemon");

      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls[0]?.[0]).toBe("launchctl");
      expect(execFileMock.mock.calls[0]?.[1]).toEqual(["print", "gui/501/dev.minions.daemon"]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe("launchctl");
      expect(spawnMock.mock.calls[0]?.[1]).toEqual([
        "kickstart",
        "-k",
        "gui/501/dev.minions.daemon",
      ]);
      expect(logger.calls.some((c) => c.event === "recovery_restart_invoked")).toBe(true);
    } finally {
      restorePlatform();
    }
  });

  it("rejects when the detached launchctl kickstart process cannot be spawned", async () => {
    setPlatform("darwin");
    process.getuid = () => 501;
    try {
      answer(0, "", "");
      spawnFails("spawn launchctl ENOENT");
      const logger = fakeLogger();
      const restarter = createSystemRecoveryRestarter({ logger });
      await expect(restarter.restart("primary-daemon")).rejects.toThrow(/ENOENT/);
    } finally {
      restorePlatform();
    }
  });

  it("rejects with a clear message when neither supervisor is detected", async () => {
    setPlatform("linux");
    try {
      answer(3, "inactive\n", "");
      const logger = fakeLogger();
      const restarter = createSystemRecoveryRestarter({ logger });
      await expect(restarter.restart("primary-daemon")).rejects.toThrow(
        /no systemd user service or launchd agent detected for minions; cannot restart automatically/,
      );
      expect(execFileMock).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  it("rejects with a clear message on an unsupported platform", async () => {
    setPlatform("win32");
    try {
      const logger = fakeLogger();
      const restarter = createSystemRecoveryRestarter({ logger });
      await expect(restarter.restart("primary-daemon")).rejects.toThrow(
        /no systemd user service or launchd agent detected for minions/,
      );
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it("surfaces the child process's stderr when the restart command itself fails", async () => {
    setPlatform("linux");
    try {
      answer(0, "active\n", "");
      answer(1, "", "Unit minions.service failed to reload configuration.\n");
      const logger = fakeLogger();
      const restarter = createSystemRecoveryRestarter({ logger });
      await expect(restarter.restart("primary-daemon")).rejects.toThrow(
        /Unit minions\.service failed to reload configuration\./,
      );
    } finally {
      restorePlatform();
    }
  });

  it("enforces the timeout and rejects with a clear timeout error", async () => {
    setPlatform("linux");
    try {
      answer(0, "active\n", "");
      answerTimeout();
      const logger = fakeLogger();
      const restarter = createSystemRecoveryRestarter({ logger });
      await expect(restarter.restart("primary-daemon")).rejects.toThrow(/timed out after 5000ms/);
    } finally {
      restorePlatform();
    }
  });
});
