import type { ChildProcess } from "node:child_process";

const defaultEscalationTimeoutMs = 1_000;

/**
 * Tears down a detached child's whole process group: ends stdin, SIGTERMs the
 * group, escalates to SIGKILL after `timeoutMs`, and resolves once the child
 * has exited. The escalation timer is cleared from the exit handler, so a
 * child that dies inside the window never leaves a pending SIGKILL aimed at a
 * pid the kernel may have recycled.
 */
export function terminateProcessGroup(
  child: ChildProcess,
  timeoutMs: number = defaultEscalationTimeoutMs,
): Promise<void> {
  try {
    if (child.stdin !== null) child.stdin.end();
  } catch {
    // ignore — the process-group signal is the authoritative teardown
  }
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveTermination) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        resolveTermination();
      }
    };
    const killTimer = setTimeout(() => {
      const delivered = signalProcessGroup(child, pid, "SIGKILL");
      if (!delivered) finish();
    }, timeoutMs);
    killTimer.unref();
    child.once("exit", () => {
      finish();
    });
    const delivered = signalProcessGroup(child, pid, "SIGTERM");
    if (!delivered) {
      finish();
    }
  });
}

function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (groupError: unknown) {
    if (isNodeError(groupError) && groupError.code === "ESRCH") {
      return false;
    }
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
