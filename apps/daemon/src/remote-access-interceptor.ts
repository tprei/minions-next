import {
  Code,
  ConnectError,
  createContextKey,
  type Interceptor,
  type StreamRequest,
  type UnaryRequest,
} from "@connectrpc/connect";
import type { PairingScope } from "@minions/core";
import type { DeviceSessionStore } from "./device-session-store.js";

/**
 * Remote-access interceptor (PR 57 — private-phone-pairing, REMOTE-01/REMOTE-02).
 *
 * The daemon binds to loopback by default (`server.ts`'s `startDaemonServer` never
 * listens anywhere else unless `options.remoteAccess` is set). When remote access IS
 * enabled the daemon also listens on a non-loopback interface, so a phone reachable over
 * Tailscale can connect through the exact same RPC surface the desktop UI already uses.
 * That is the entire remote-networking change; this module's job is the other half of
 * REMOTE-02 ("direct unauthenticated public listeners are prohibited"): distinguishing a
 * trusted loopback caller (the desktop UI — its behaviour MUST be completely unaffected)
 * from a non-loopback caller (untrusted until it proves a paired device session), and
 * fail-closed rejecting any RPC this interceptor doesn't explicitly recognise.
 *
 * `isLoopbackContextKey` is populated once per HTTP request by `server.ts`'s
 * `connectNodeAdapter({ contextValues })` hook from the raw socket's `remoteAddress` —
 * the one signal that cannot be spoofed by request headers. It defaults to `false`
 * (untrusted) so any code path that forgets to populate it fails closed rather than
 * silently granting loopback trust.
 */
export const isLoopbackContextKey = createContextKey<boolean>(false, {
  description: "whether this request's underlying socket connected from a loopback address",
});

/** IPv4/IPv6 loopback, plus Node's IPv4-mapped-IPv6 form for a loopback IPv4 peer. */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1"
  );
}

/**
 * Per-RPC remote-access policy. The map value is the minimum device-session scope a
 * non-loopback caller must present. An RPC whose full method name is absent from the
 * policy is never reachable from a non-loopback caller, regardless of session — the
 * fail-closed default for every mutation this interceptor doesn't know phones are meant
 * to reach (REMOTE-05: complex plan editing, repository/host registration, recovery, and
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
 * Builds the interceptor that enforces {@link RemoteAccessPolicy} against
 * {@link isLoopbackContextKey}. Loopback requests always pass through untouched — the
 * desktop UI's behaviour is unchanged whether or not remote access is enabled at all.
 */
export function createRemoteAccessInterceptor(options: {
  sessionStore: DeviceSessionStore;
  policy?: RemoteAccessPolicy;
  now?: () => number;
}): Interceptor {
  const policy = options.policy ?? PHONE_REMOTE_ACCESS_POLICY;
  const now = options.now ?? Date.now;
  return (next) => async (request) => {
    if (request.contextValues.get(isLoopbackContextKey)) {
      return next(request);
    }
    const methodName = fullMethodName(request);
    const requiredScope = policy.get(methodName);
    if (requiredScope === undefined) {
      throw new ConnectError(
        `${methodName} is not reachable from a non-loopback caller`,
        Code.PermissionDenied,
      );
    }
    options.sessionStore.authenticate(request.header, requiredScope, now());
    return next(request);
  };
}
