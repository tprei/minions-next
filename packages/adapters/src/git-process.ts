import { Buffer } from "node:buffer";
import { lstat } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  GitProcessError,
  type GitProcess,
  type GitProcessFailureKind,
  type GitProcessRequest,
  type GitProcessResult,
} from "@minions/core";

const TERMINATION_SETTLE_MS = 1_000;

const TERMINATION_GRACE_MS = 100;

type OutputStream = "stdout" | "stderr";

interface OutputCapture {
  readonly stdout: Uint8Array[];
  readonly stderr: Uint8Array[];
  totalBytes: number;
  exceeded: boolean;
}

interface PendingFailure {
  readonly kind: GitProcessFailureKind;
  readonly message: string;
}

interface ProcessTermination {
  readonly forceKillTimer: NodeJS.Timeout | undefined;
}

interface SignalResult {
  readonly groupSignalled: boolean;
  readonly processGone: boolean;
}

export function createNodeGitProcess(): GitProcess {
  return new NodeGitProcess();
}

class NodeGitProcess implements GitProcess {
  run(request: GitProcessRequest): Promise<GitProcessResult> {
    const validationError = validateRequest(request);
    if (validationError !== undefined) {
      return Promise.reject(validationError);
    }
    return runGit(request);
  }
}

function validateRequest(request: GitProcessRequest): Error | undefined {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    return new RangeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
    return new RangeError("maxOutputBytes must be a positive safe integer");
  }
  if (typeof request.workingDirectoryDevice !== "bigint" || request.workingDirectoryDevice < 0n) {
    return new RangeError("workingDirectoryDevice must be a non-negative bigint");
  }
  if (typeof request.workingDirectoryInode !== "bigint" || request.workingDirectoryInode < 0n) {
    return new RangeError("workingDirectoryInode must be a non-negative bigint");
  }
  return undefined;
}

async function validateWorkingDirectory(
  request: GitProcessRequest,
): Promise<GitProcessError | undefined> {
  let metadata;
  try {
    metadata = await lstat(request.workingDirectory, { bigint: true });
  } catch {
    return new GitProcessError("spawn", "Git working directory is unavailable");
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== request.workingDirectoryDevice ||
    metadata.ino !== request.workingDirectoryInode
  ) {
    return new GitProcessError("spawn", "Git working directory identity is invalid");
  }
  return undefined;
}

async function runGit(request: GitProcessRequest): Promise<GitProcessResult> {
  const workingDirectoryError = await validateWorkingDirectory(request);
  if (workingDirectoryError !== undefined) {
    throw workingDirectoryError;
  }
  return new Promise<GitProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("git", ["-c", "protocol.file.allow=always", ...request.arguments], {
        cwd: request.workingDirectory,
        detached: true,
        env: deterministicEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new GitProcessError("spawn", "Git process could not be started"));
      return;
    }

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      terminateProcessGroup(child);
      reject(new GitProcessError("spawn", "Git process streams could not be opened"));
      return;
    }

    const capture: OutputCapture = {
      stdout: [],
      stderr: [],
      totalBytes: 0,
      exceeded: false,
    };
    let childClosed = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let exitCode: number | null = null;
    let failure: PendingFailure | undefined;
    const timeoutTimer = setTimeout(() => {
      fail("timeout", "Git process exceeded the configured timeout");
    }, request.timeoutMs);
    let forceKillTimer: NodeJS.Timeout | undefined;
    let terminationSettleTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const finishIfDrained = (): void => {
      if (settled || !childClosed || !stdoutEnded || !stderrEnded) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      if (terminationSettleTimer !== undefined) {
        clearTimeout(terminationSettleTimer);
      }

      const capturedStdout = collectOutput(capture.stdout);
      if (failure !== undefined) {
        reject(new GitProcessError(failure.kind, failure.message));
        return;
      }
      if (exitCode !== 0) {
        reject(
          new GitProcessError("exit", "Git process exited with a non-zero status", {
            ...(exitCode === null ? {} : { exitCode }),
          }),
        );
        return;
      }
      resolve({ stdout: capturedStdout, stderr: collectOutput(capture.stderr) });
    };

    const fail = (kind: GitProcessFailureKind, message: string): void => {
      if (settled || failure !== undefined) {
        return;
      }
      failure = { kind, message };
      const termination = terminateProcessGroup(child);
      forceKillTimer = termination.forceKillTimer;
      terminationSettleTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        capture.exceeded = true;
        stdout.destroy();
        stderr.destroy();
        childClosed = true;
        stdoutEnded = true;
        stderrEnded = true;
        finishIfDrained();
      }, TERMINATION_SETTLE_MS);
      finishIfDrained();
    };

    const onStreamError = (): void => {
      fail("spawn", "Git process output stream failed");
    };

    consumeStream(
      stdout,
      "stdout",
      capture,
      request.maxOutputBytes,
      () => {
        fail("output_limit", "Git process output exceeded the configured limit");
      },
      onStreamError,
      () => {
        stdoutEnded = true;
        finishIfDrained();
      },
    );
    consumeStream(
      stderr,
      "stderr",
      capture,
      request.maxOutputBytes,
      () => {
        fail("output_limit", "Git process output exceeded the configured limit");
      },
      onStreamError,
      () => {
        stderrEnded = true;
        finishIfDrained();
      },
    );

    child.once("error", () => {
      fail("spawn", "Git process could not be started");
    });
    child.once("close", (code: number | null) => {
      childClosed = true;
      exitCode = code;
      finishIfDrained();
    });
  });
}

function consumeStream(
  stream: Readable,
  outputStream: OutputStream,
  capture: OutputCapture,
  maxOutputBytes: number,
  onLimit: () => void,
  onError: () => void,
  onEnd: () => void,
): void {
  stream.on("data", (chunk: unknown) => {
    if (capture.exceeded) {
      return;
    }
    const bytes = toBytes(chunk);
    const remaining = maxOutputBytes - capture.totalBytes;
    const retainedBytes = Math.min(remaining, bytes.byteLength);
    if (retainedBytes > 0) {
      capture[outputStream].push(bytes.subarray(0, retainedBytes));
      capture.totalBytes += retainedBytes;
    }
    if (retainedBytes < bytes.byteLength) {
      capture.exceeded = true;
      onLimit();
    }
  });
  stream.once("error", onError);
  stream.once("end", onEnd);
}

function toBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  throw new TypeError("Git process output was not bytes");
}

function collectOutput(chunks: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(chunks);
}

function deterministicEnvironment(): NodeJS.ProcessEnv {
  const path = process.env["PATH"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("PATH is unavailable");
  }
  return {
    PATH: path,
    LANG: "C",
    LC_ALL: "C",
    GIT_ASKPASS: "",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_KEY_1: "user.useConfigOnly",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_VALUE_1: "true",
    GIT_SSH_COMMAND:
      "ssh -F /dev/null -oBatchMode=yes -oIdentityAgent=none -oIdentitiesOnly=yes -oIdentityFile=/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
  };
}

function terminateProcessGroup(child: ChildProcess): ProcessTermination {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return { forceKillTimer: undefined };
  }
  signalProcessGroup(child, pid, "SIGTERM");
  const forceKillTimer = setTimeout(() => {
    const forceSignal = signalProcessGroup(child, pid, "SIGKILL");
    if (!forceSignal.groupSignalled && !forceSignal.processGone) {
      signalChild(child, "SIGKILL");
    }
  }, TERMINATION_GRACE_MS);
  return { forceKillTimer };
}

function signalProcessGroup(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
): SignalResult {
  try {
    process.kill(-pid, signal);
    return { groupSignalled: true, processGone: false };
  } catch (error: unknown) {
    if (isProcessGone(error)) {
      return { groupSignalled: false, processGone: true };
    }
    const childSignalled = signalChild(child, signal);
    return { groupSignalled: false, processGone: !childSignalled };
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch (error: unknown) {
    return !isProcessGone(error);
  }
}

function isProcessGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ESRCH";
}
