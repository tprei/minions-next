import { describe, it, expect } from "vitest";
import { checkVersionSkew } from "@minions/core";

describe("SSH version skew policy", () => {
  it("accepts matching major versions", () => {
    expect(checkVersionSkew("1.0.0", "1.2.3").compatible).toBe(true);
    expect(checkVersionSkew("2.5.1", "2.0.0").compatible).toBe(true);
  });

  it("rejects major version mismatch", () => {
    const v = checkVersionSkew("1.0.0", "2.0.0");
    expect(v.compatible).toBe(false);
    expect(v.reason).toContain("major");
  });

  it("rejects unparseable supervisor version", () => {
    expect(checkVersionSkew("invalid", "1.0.0").compatible).toBe(false);
  });

  it("rejects unparseable host version", () => {
    expect(checkVersionSkew("1.0.0", "bad").compatible).toBe(false);
  });

  it("returns frozen verdicts", () => {
    expect(Object.isFrozen(checkVersionSkew("1.0.0", "1.0.0"))).toBe(true);
  });
});
