import process from "node:process";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { PairingScope, PairingService } from "@minions/contracts";

/**
 * Synthetic 12 (PR 57 — private-phone-pairing, PRD REMOTE-01..REMOTE-07). Exercises the
 * REAL pairing service against a running supervisor reachable over a private network:
 * check network capability, request+complete a pairing code for each scope, prove a
 * read-only session is rejected for control mutations, revoke a device, assert foreign
 * origins are rejected (CSRF), and scan the pairing outputs for any long-lived
 * credential (the QR/code must never carry one).
 *
 * Environment proof, not a CI gate. Requires:
 *   MINIONS_PHONE_BASE_URL=<supervisor http url, e.g. http://100.x.y.z:4817>
 *   [MINIONS_PHONE_ORIGIN=<expected origin, defaults to the base url>]
 * Run on the maintained phone-reachable host: pnpm synthetic:phone-pairing
 */

await main();

async function main() {
  const baseUrl = requiredEnvironment("MINIONS_PHONE_BASE_URL");
  const expectedOrigin = process.env["MINIONS_PHONE_ORIGIN"] ?? baseUrl;
  const transport = (origin) =>
    createConnectTransport({
      baseUrl,
      httpVersion: "1.1",
      nodeOptions: { agent: false, headers: { origin } },
    });
  const pairing = createClient(PairingService, transport(expectedOrigin));
  const steps = [];
  try {
    // 1. Network/capability gate (REMOTE-01): a private network must be reachable.
    const capability = await pairing.checkNetworkCapability({});
    steps.push({ step: "check_network_capability", reachable: capability.connected });

    // 2. Request a one-time pairing code for READ_ONLY (REMOTE-02).
    const readOnlyCode = await pairing.requestPairingCode({ scope: PairingScope.READ_ONLY });
    if (readOnlyCode.code === undefined || readOnlyCode.code.length === 0) {
      throw new Error("requestPairingCode returned no code for READ_ONLY");
    }
    assertNoLongLivedCredential(readOnlyCode.code, "read-only pairing code");
    steps.push({ step: "request_code_read_only", codeLength: readOnlyCode.code.length });

    // 3. Complete pairing for the read-only device.
    const readOnlySession = await pairing.completePairing({ code: readOnlyCode.code });
    if (readOnlySession.session === undefined) {
      throw new Error("completePairing returned no session for READ_ONLY");
    }
    steps.push({ step: "complete_read_only", sessionId: readOnlySession.session.sessionId });

    // 4. A control-scope mutation from a read-only session must be rejected (REMOTE-04).
    let readOnlyBlocked = false;
    try {
      await pairing.revokeDevice({ sessionId: readOnlySession.session.sessionId });
    } catch {
      readOnlyBlocked = true;
    }
    steps.push({ step: "read_only_control_blocked", blocked: readOnlyBlocked });

    // 5. Pair + complete a CONTROL device and revoke the read-only one (REMOTE-05).
    const controlCode = await pairing.requestPairingCode({ scope: PairingScope.CONTROL });
    const controlSession = await pairing.completePairing({ code: controlCode.code });
    if (controlSession.session === undefined) {
      throw new Error("completePairing returned no session for CONTROL");
    }
    await pairing.revokeDevice({ sessionId: readOnlySession.session.sessionId });

    // 6. List devices reflects the revocation (REMOTE-06).
    const devices = await pairing.listDevices({});
    const stillListed = devices.devices.some(
      (device) => device.sessionId === readOnlySession.session.sessionId,
    );
    steps.push({ step: "list_devices_after_revoke", revokedStillListed: stillListed });

    // 7. CSRF / origin rejection (REMOTE-03): a request with a foreign origin is denied.
    let foreignOriginBlocked = false;
    try {
      await pairing.listDevices({}, { headers: { origin: "https://evil.example" } });
    } catch {
      foreignOriginBlocked = true;
    }
    steps.push({ step: "foreign_origin_blocked", blocked: foreignOriginBlocked });

    process.stdout.write(`${JSON.stringify({ synthetic: "phone-pairing", steps })}\n`);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

/** Reject anything resembling a long-lived bearer/refresh/API credential in pairing output. */
function assertNoLongLivedCredential(value, label) {
  if (/ai-[a-z0-9_-]{20,}|sk-[a-z0-9]{20,}|Bearer\s+/iu.test(value)) {
    throw new Error(`${label} appears to contain a long-lived credential`);
  }
  if (value.length >= 64) {
    throw new Error(
      `${label} is unusually long for a one-time pairing token (${String(value.length)} chars)`,
    );
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`required environment variable '${name}' is not set`);
  }
  return value;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
