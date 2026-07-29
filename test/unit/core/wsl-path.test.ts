import { describe, it, expect } from "vitest";
import { validateWslPath } from "@minions/core";

describe("WSL path validation (no Windows-path mixing)", () => {
  it("accepts valid POSIX paths", () => {
    expect(validateWslPath("/home/user/repo").valid).toBe(true);
    expect(validateWslPath("/srv/projects/minions").valid).toBe(true);
  });

  it("rejects Windows drive-letter paths", () => {
    expect(validateWslPath("C:\\Users\\dev\\repo").valid).toBe(false);
    expect(validateWslPath("D:/projects/repo").valid).toBe(false);
  });

  it("rejects backslash in paths", () => {
    const v = validateWslPath("/home\\user");
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("backslash");
  });

  it("rejects drvfs mount paths (/mnt/c/...)", () => {
    const v = validateWslPath("/mnt/c/Users/dev/repo");
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("drvfs");
  });

  it("rejects empty path", () => {
    expect(validateWslPath("").valid).toBe(false);
  });

  it("rejects relative path", () => {
    const v = validateWslPath("relative/path");
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("absolute");
  });

  it("returns frozen verdicts", () => {
    expect(Object.isFrozen(validateWslPath("/valid"))).toBe(true);
  });
});
