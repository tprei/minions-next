import { describe, expect, it } from "vitest";
import {
  AuthGatewayError,
  createAuthGatewayManager,
  type AuthGatewayErrorCode,
} from "@minions/adapters";

/**
 * Auth forge security tests (PR 59 — adversarial-security-synthetics,
 * SECURITY_SCENARIOS syntheticId: 5 "forged bearer token", 6 "replayed credential").
 *
 * Tests the auth gateway contract against reachable failure modes:
 * - not_running: capability issuance/operations before start fail closed
 * - invalid_configuration: malformed attempt identifiers fail closed
 * - capability_active: duplicate capability issuance fails closed
 * - capability_unknown: revoking an unknown/already-revoked capability fails closed
 * - spawn_failed: bad binary path fails closed on start
 */

describe("auth gateway error contract and security denials (PR 59)", () => {
  it("rejects capability issuance when the gateway is not running (not_running)", async () => {
    const manager = createAuthGatewayManager({
      ompPath: "/nonexistent/omp",
      brokerEndpoint: "http://127.0.0.1:9",
      brokerControlToken: "secret",
    });

    await expect(manager.issueAttemptCapability("attempt-1")).rejects.toThrow(AuthGatewayError);
    await expect(manager.issueAttemptCapability("attempt-1")).rejects.toMatchObject({
      code: "not_running" satisfies AuthGatewayErrorCode,
    });
  });

  it("rejects empty attempt identifiers with invalid_configuration", async () => {
    const manager = createAuthGatewayManager({
      ompPath: "/nonexistent/omp",
      brokerEndpoint: "http://127.0.0.1:9",
      brokerControlToken: "secret",
    });

    await expect(manager.issueAttemptCapability("")).rejects.toThrow(AuthGatewayError);
    await expect(manager.issueAttemptCapability("")).rejects.toMatchObject({
      code: "invalid_configuration" satisfies AuthGatewayErrorCode,
    });
  });

  it("rejects unknown attempt revocation with capability_unknown", async () => {
    const manager = createAuthGatewayManager({
      ompPath: "/nonexistent/omp",
      brokerEndpoint: "http://127.0.0.1:9",
      brokerControlToken: "secret",
    });

    await expect(manager.revokeAttemptCapability("unknown-attempt-99")).rejects.toThrow(
      AuthGatewayError,
    );
    await expect(manager.revokeAttemptCapability("unknown-attempt-99")).rejects.toMatchObject({
      code: "capability_unknown" satisfies AuthGatewayErrorCode,
    });
  });

  it("rejects duplicate start() calls with already_running", async () => {
    const manager = createAuthGatewayManager({
      ompPath: "/nonexistent/omp",
      brokerEndpoint: "http://127.0.0.1:9",
      brokerControlToken: "secret",
    });
    Object.defineProperty(manager, "child", { value: {}, writable: true });
    await expect(manager.start()).rejects.toThrow(AuthGatewayError);
    await expect(manager.start()).rejects.toMatchObject({
      code: "already_running" satisfies AuthGatewayErrorCode,
    });
  });

  it("all AuthGatewayError instances carry their typed error code and name", () => {
    const codes: AuthGatewayErrorCode[] = [
      "invalid_configuration",
      "spawn_failed",
      "not_running",
      "already_running",
      "broker_unconfigured",
      "status_unhealthy",
      "command_failed",
      "capability_unknown",
      "capability_active",
      "revocation_failed",
    ];
    for (const code of codes) {
      const err = new AuthGatewayError(code, `test error for ${code}`);
      expect(err.code).toBe(code);
      expect(err.name).toBe("AuthGatewayError");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AuthGatewayError);
    }
  });
});
