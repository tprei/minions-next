import { encryptWebPushPayload, signVapidJwt, type VapidKeyPair } from "./web-push-crypto.js";

/**
 * Web Push HTTP delivery (RFC 8030) for a single subscription: encrypts `plaintext`
 * (RFC 8291) and POSTs it to the subscription's endpoint with a VAPID `Authorization`
 * header (RFC 8292). No caller in this daemon logs `plaintext` or any header derived
 * from it — see push-service.ts's doc comment.
 */
export type PushSubscriptionRecord = Readonly<{
  readonly endpoint: string;
  /** Base64url — `PushSubscription.p256dh_key`. */
  readonly p256dhKey: string;
  /** Base64url — `PushSubscription.auth_key`. */
  readonly authKey: string;
}>;

/**
 * `delivered`: the push service accepted the message (2xx).
 * `gone`: the push service reports the subscription no longer exists (404/410 — RFC 8030
 * §7.3), so the caller should prune it from its registry.
 * `failed`: any other outcome (network error, malformed subscription, non-2xx status) —
 * transient from the caller's perspective, the subscription is left registered.
 */
export type WebPushOutcome = "delivered" | "gone" | "failed";

/** RFC 8292 §2 caps the VAPID JWT "exp" claim at 24h from issuance; a fresh JWT is minted
 * per send (audience varies per subscription's push-service origin), so a much shorter
 * lifetime is fine and reduces the value of a leaked token. */
const VAPID_JWT_TTL_SECONDS = 60 * 60;
/** How long the push service should hold the message if the user agent is offline (RFC
 * 8030 §5.2 `TTL` header, in seconds). Notifications route to live tree/node state, so a
 * few hours of retention is enough to be useful without piling up stale alerts. */
const PUSH_MESSAGE_TTL_SECONDS = 4 * 60 * 60;

/**
 * Encrypts and POSTs one push message to a single subscription. Never throws — every
 * failure mode (malformed subscription, network error, non-2xx status) is reported via
 * the return value so a caller broadcasting to many subscriptions can isolate failures
 * per subscription instead of aborting the batch.
 */
export async function sendWebPush(
  subscription: PushSubscriptionRecord,
  vapidKeyPair: VapidKeyPair,
  plaintext: Buffer,
): Promise<WebPushOutcome> {
  try {
    const body = encryptWebPushPayload({
      plaintext,
      receiverPublicKeyRaw: Buffer.from(subscription.p256dhKey, "base64url"),
      receiverAuthSecret: Buffer.from(subscription.authKey, "base64url"),
    });
    const audience = new URL(subscription.endpoint).origin;
    const jwt = signVapidJwt(
      vapidKeyPair,
      audience,
      Math.floor(Date.now() / 1000) + VAPID_JWT_TTL_SECONDS,
    );

    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_MESSAGE_TTL_SECONDS),
        Authorization: `vapid t=${jwt}, k=${vapidKeyPair.publicKeyBase64Url}`,
      },
      // node:crypto Buffers type their backing store as ArrayBufferLike (it could in
      // principle be a SharedArrayBuffer), which lib.dom.d.ts's BodyInit rejects; wrap in
      // a fresh Uint8Array so the body is provably backed by a plain ArrayBuffer.
      body: new Uint8Array(body),
    });
    if (response.status === 404 || response.status === 410) {
      return "gone";
    }
    return response.ok ? "delivered" : "failed";
  } catch {
    return "failed";
  }
}
