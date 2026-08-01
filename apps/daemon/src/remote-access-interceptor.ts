import {
  Code,
  ConnectError,
  type Interceptor,
  type StreamRequest,
  type UnaryRequest,
} from "@connectrpc/connect";
import type { PairingScope } from "@minions/core";
import type { DeviceSessionStore } from "./device-session-store.js";

/**
 * Remote-access interceptor (PR 57 — private-phone-pairing, REMOTE-01/REMOTE-02).
 *
 * Trust derives from WHICH listener accepted the connection, never from the peer
 * address. `server.ts` wires this interceptor onto the remote (phone) listener ONLY, so
 * it runs for every request that reaches that listener regardless of source address, and
 * never runs for the trusted loopback (desktop UI) listener. The documented `tailscale
 * serve` deployment proxies the phone onto `http://127.0.0.1:<remotePort>`, so phone
 * requests arrive with a loopback `remoteAddress` — trusting the peer address would let
 * a phone bypass every session check. Because this interceptor only runs on the remote
 * listener, there is no trusted path through it: it ALWAYS enforces both the method
 * allowlist ({@link RemoteAccessPolicy}) and a valid device session. Fail-closed: an RPC
 * absent from the policy is never reachable through the remote listener, regardless of
 * session (REMOTE-05: complex plan editing, repository/host registration, recovery, and
 * maintenance stay desktop-only).
 */
export type RemoteAccessPolicy = ReadonlyMap<string, PairingScope>;

/**
 * The phone-reachable surface (REMOTE-05: "inspect trees/nodes, receive attention
 * notifications, steer, answer questions, approve/reject, pause/resume, retry, cancel").
 * Read RPCs accept either scope; `QueueNodeCommand` (steering) and `ApprovePlan` are the
 * only mutations a phone may invoke, both requiring `control`.
 */
export const PHONE_REMOTE_ACCESS_POLICY: RemoteAccessPolicy = new Map<string, PairingScope>([
  ["minions.v1.SteeringService/QueueNodeCommand", "control"],
  ["minions.v1.TreeService/ApprovePlan", "control"],
  ["minions.v1.TreeService/GetTree", "read_only"],
  ["minions.v1.TreeService/ListTrees", "read_only"],
  ["minions.v1.EventService/WatchEvents", "read_only"],
  ["minions.v1.SystemService/GetHealth", "read_only"],
]);

function fullMethodName(request: UnaryRequest | StreamRequest): string {
  return `${request.service.typeName}/${request.method.name}`;
}

/**
 * Builds the interceptor that enforces {@link RemoteAccessPolicy} and device-session
 * authentication. It ALWAYS enforces — there is no loopback short-circuit — because
 * `server.ts` attaches it to the remote (phone) listener only, where every caller is
 * untrusted until it proves a paired device session. The trusted loopback (desktop UI)
 * listener is served through a separate adapter that omits this interceptor entirely.
 */
export function createRemoteAccessInterceptor(options: {
  sessionStore: DeviceSessionStore;
  policy?: RemoteAccessPolicy;
  now?: () => number;
}): Interceptor {
  const policy = options.policy ?? PHONE_REMOTE_ACCESS_POLICY;
  const now = options.now ?? Date.now;
  return (next) => async (request) => {
    const methodName = fullMethodName(request);
    const requiredScope = policy.get(methodName);
    if (requiredScope === undefined) {
      throw new ConnectError(
        `${methodName} is not reachable from a remote caller`,
        Code.PermissionDenied,
      );
    }
    options.sessionStore.authenticate(request.header, requiredScope, now());
    return next(request);
  };
}
