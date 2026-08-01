/**
 * Decodes a base64url-encoded VAPID public key (`PushService.GetVapidPublicKey`'s
 * response — RFC 8292 section 3.2's "k" parameter encoding) into the raw bytes
 * `PushManager.subscribe`'s `applicationServerKey` option requires (PR 58 —
 * mobile-pwa-push-offline). Browsers have no `Buffer`, so this is the standard
 * `atob`-based base64url decode (RFC 4648 §5 alphabet, restoring the `=` padding `atob`
 * requires).
 */
export function decodeVapidPublicKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
