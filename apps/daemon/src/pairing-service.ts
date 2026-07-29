import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { PairingService, RequestPairingCodeResponseSchema, PairingScope } from "@minions/contracts";
import {
  createDeviceSessionStore,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  type AuthenticatedSession,
  type DeviceSessionStore,
} from "./device-session-store.js";

/**
 * Pairing service handler (PR 57 — private-phone-pairing).
 *
 * RequestPairingCode is functional: generates a real 6-char legible code with a
 * 5-minute expiry. The code is ephemeral (not persisted) — in production, a
 * PairingCodeStore would persist it for validation by CompletePairing. The
 * remaining RPCs (CompletePairing, ListDevices, RevokeDevice) require a device
 * session store and return Code.Unimplemented.
 */
export type PairingServiceOptions = Readonly<Record<string, never>>;

const PAIRING_CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export function registerPairingService(
  router: ConnectRouter,
  options: PairingServiceOptions,
): void {
  void options;
  const sessionStore = options.sessionStore ?? createDeviceSessionStore();
  router.service(PairingService, {
    requestPairingCode(request) {
      if (request.scope === PairingScope.UNSPECIFIED) {
        throw new ConnectError("scope must be specified", Code.InvalidArgument);
      }
      const code = generateCode();
      const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
      return create(RequestPairingCodeResponseSchema, {
        code,
        expiresAt: create(TimestampSchema, {
          seconds: BigInt(Math.floor(expiresAt / 1000)),
          nanos: 0,
        }),
        scope: request.scope,
      });
    },
    completePairing() {
      throw new ConnectError("CompletePairing requires a device session store", Code.Unimplemented);
    },
    listDevices() {
      throw new ConnectError("ListDevices requires a device session store", Code.Unimplemented);
    },
    revokeDevice() {
      throw new ConnectError("RevokeDevice requires a device session store", Code.Unimplemented);
    },
  });
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_CHARSET[Math.floor(Math.random() * PAIRING_CHARSET.length)] ?? "";
  }
  return code;
}
