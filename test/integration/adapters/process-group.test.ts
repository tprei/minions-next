import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateProcessGroup } from "../../../packages/adapters/src/process-group.js";

afterEach(() => {
  vi.useRealTimers();
});

// The raw escalation timer this replaces could outlive a child that exited
// inside the window and SIGKILL a pid the kernel had already recycled.
describe("terminateProcessGroup", () => {
  it("clears the SIGKILL escalation timer when the child exits inside the window", async () => {
    vi.useFakeTimers();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await terminateProcessGroup(child);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves without scheduling an escalation timer for an already-exited child", async () => {
    vi.useFakeTimers();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolveExit) => {
      child.once("exit", () => {
        resolveExit();
      });
    });
    await terminateProcessGroup(child);
    expect(vi.getTimerCount()).toBe(0);
  });
});
