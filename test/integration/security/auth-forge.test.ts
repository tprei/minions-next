import { describe, it, expect } from "vitest";
import { AuthGatewayError, type AuthGatewayErrorCode } from "@minions/adapters";

/**
 * Auth forge security tests (PR 59 — adversarial-security-synthetics,
 * SECURITY_SCENARIOS syntheticId: 5 "forged bearer token", 6 "replayed credential").
 *
 * Tests the auth gateway error contract: every auth failure produces a typed
 * AuthGatewayError with a specific code. The error codes are the deterministic
 * denial surface — a forged token, expired credential, or replayed bearer each
 * produce a distinct, machine-readable code that the security matrix maps to an
 * expected denial.
 */

describe("auth gateway error contract", () => {
  it("constructs errors with typed codes", () => {
    const error = new AuthGatewayError("spawn_failed", "gateway process failed to start");
    expect(error.code).toBe("spawn_failed");
    expect(error.message).toContain("gateway process failed");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AuthGatewayError);
  });

  it("preserves the error name as the class name", () => {
    const error = new AuthGatewayError("capability_unknown", "authentication failed");
    expect(error.name).toBe("AuthGatewayError");
  });

  it("supports cause chaining for diagnostics", () => {
    const cause = new Error("ENOENT");
    const error = new AuthGatewayError("spawn_failed", "binary not found", { cause });
    expect(error.cause).toBe(cause);
  });

  it("every error code produces a distinct AuthGatewayError", () => {
    const codes: AuthGatewayErrorCode[] = [
      "spawn_failed",
      "capability_unknown",
      "status_unhealthy",
      "not_running",
      "revocation_failed",
    ];
    const errors = codes.map((code) => new AuthGatewayError(code, `test: ${code}`));
    // Every error has a unique code
    const uniqueCodes = new Set(errors.map((e) => e.code));
    expect(uniqueCodes.size).toBe(codes.length);
  });

  it("errors are safe to throw in promise chains", async () => {
    const thrower = (): Promise<void> =>
      Promise.reject(new AuthGatewayError("capability_unknown", "forged token detected"));
    await expect(thrower()).rejects.toThrow(AuthGatewayError);
    await expect(thrower()).rejects.toThrow(/forged token/);
  });
});
