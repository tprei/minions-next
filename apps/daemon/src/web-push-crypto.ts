import crypto, { type KeyObject } from "node:crypto";

/**
 * RFC 8291 (Message Encryption for Web Push) + RFC 8292 (VAPID) primitives, built
 * directly on `node:crypto` — no external web-push dependency. Pure functions and data
 * only; no network I/O (see web-push.ts for the HTTP delivery that uses this module) and
 * no logging of any plaintext this module handles.
 *
 * Byte-exact against the RFC 8291 Appendix A worked example, including the ECDH shared
 * secret, both HKDF derivations, and the final `aes128gcm` wire body — see
 * web-push-crypto.test.ts.
 */

const P256_CURVE = "prime256v1";
/** Uncompressed P-256 point: 0x04 || X(32) || Y(32) (SEC1 §2.3.3 / RFC 8291 §3.1). */
const P256_RAW_PUBLIC_KEY_LENGTH = 65;
/**
 * `SubjectPublicKeyInfo` DER for a prime256v1 public key is always exactly this length:
 * a fixed-length AlgorithmIdentifier (the id-ecPublicKey and prime256v1 OIDs never change
 * length) followed by the 65-octet BIT STRING point. Verified in
 * web-push-crypto.test.ts, not just assumed here.
 */
const P256_SPKI_DER_LENGTH = 91;
/** RFC 8291 §3.2: the user agent's push authentication secret. */
const AUTH_SECRET_LENGTH = 16;
/** RFC 8188 §2.1: the `aes128gcm` content-coding header's random salt. */
const SALT_LENGTH = 16;
/** AEAD_AES_128_GCM authentication tag (RFC 5116 §5.1). */
const AES_128_GCM_TAG_LENGTH = 16;
/** Padding delimiter octet for the last (and, per RFC 8291 §4, only) record. */
const LAST_RECORD_DELIMITER = 0x02;
/**
 * Fixed single-record size — RFC 8291 §4 mandates exactly one record per push message.
 * 4096 matches the RFC's own worked example (§5) and is the record size every major Web
 * Push implementation defaults to.
 */
const RECORD_SIZE = 4096;
/** Largest plaintext that fits the fixed record size (delimiter + AEAD tag overhead). */
export const MAX_WEB_PUSH_PLAINTEXT_BYTES = RECORD_SIZE - 1 - AES_128_GCM_TAG_LENGTH;

export type VapidKeyPair = Readonly<{
  readonly privateKey: KeyObject;
  /** 65-octet uncompressed point. */
  readonly publicKeyRaw: Buffer;
  /** `publicKeyRaw`, base64url-encoded — the RFC 8292 §3.2 "k" parameter / the Push API's
   * `applicationServerKey`. */
  readonly publicKeyBase64Url: string;
}>;

/**
 * Generates a fresh ECDSA P-256 VAPID signing key pair (RFC 8292 §2). Callers own the
 * lifetime — this module never persists keys to disk or a database.
 */
export function generateVapidKeyPair(): VapidKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: P256_CURVE });

  // Extract the raw uncompressed EC point from the public KeyObject. SubjectPublicKeyInfo
  // DER for prime256v1 is always exactly P256_SPKI_DER_LENGTH octets — a fixed-length
  // AlgorithmIdentifier (the id-ecPublicKey and prime256v1 OIDs never change length)
  // followed by the 65-octet BIT STRING point — so slicing the last 65 octets is exact,
  // not a heuristic; both lengths are asserted below rather than assumed silently.
  const der = publicKey.export({ type: "spki", format: "der" });
  if (der.length !== P256_SPKI_DER_LENGTH) {
    throw new Error(`unexpected P-256 SubjectPublicKeyInfo DER length ${String(der.length)}`);
  }
  const publicKeyRaw = Buffer.from(der.subarray(der.length - P256_RAW_PUBLIC_KEY_LENGTH));
  if (publicKeyRaw[0] !== 0x04) {
    throw new Error("P-256 public key is not in uncompressed point form");
  }

  return Object.freeze({
    privateKey,
    publicKeyRaw,
    publicKeyBase64Url: publicKeyRaw.toString("base64url"),
  });
}

/**
 * Signs a VAPID JWT (RFC 8292 §2): ES256 over a compact `{typ,alg}.{aud,exp,sub}` JWS.
 * `dsaEncoding: "ieee-p1363"` is the fixed-length raw `r || s` signature JWS ES256
 * requires (64 octets for P-256) rather than `crypto.sign`'s default ASN.1 DER encoding.
 */
export function signVapidJwt(
  vapidKeyPair: VapidKeyPair,
  audienceOrigin: string,
  expiresAtEpochSeconds: number,
): string {
  const headerSegment = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString(
    "base64url",
  );
  const bodySegment = Buffer.from(
    JSON.stringify({
      aud: audienceOrigin,
      exp: expiresAtEpochSeconds,
      sub: "mailto:push@minions.local",
    }),
  ).toString("base64url");
  const signingInput = `${headerSegment}.${bodySegment}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: vapidKeyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export type WebPushEncryptInput = Readonly<{
  readonly plaintext: Buffer;
  /** Subscriber's ECDH public key (`PushSubscription.p256dh_key`), decoded from base64url. */
  readonly receiverPublicKeyRaw: Buffer;
  /** Subscriber's auth secret (`PushSubscription.auth_key`), decoded from base64url. */
  readonly receiverAuthSecret: Buffer;
  /**
   * Test-only override: fixes the per-message ephemeral ECDH private scalar instead of
   * generating one randomly. Never set outside web-push-crypto.test.ts's RFC 8291
   * Appendix A conformance check.
   */
  readonly senderPrivateKeyRaw?: Buffer;
  /**
   * Test-only override: fixes the random salt instead of generating one. Never set
   * outside web-push-crypto.test.ts.
   */
  readonly salt?: Buffer;
}>;

/**
 * RFC 8291 encryption. Generates a fresh ephemeral ECDH key pair and a random salt
 * (unless overridden for conformance testing), combines the resulting ECDH shared secret
 * with the subscriber's auth secret via two rounds of HKDF-SHA-256, and encrypts
 * `plaintext` as a single `aes128gcm` (RFC 8188) record. Returns the complete wire body —
 * 16-byte salt || 4-byte big-endian record size || 1-byte keyid length || keyid (the
 * sender's ephemeral public key) || ciphertext+tag — ready to POST as-is.
 */
export function encryptWebPushPayload(input: WebPushEncryptInput): Buffer {
  if (input.receiverPublicKeyRaw.length !== P256_RAW_PUBLIC_KEY_LENGTH) {
    throw new Error("receiver public key must be a 65-octet uncompressed P-256 point");
  }
  if (input.receiverAuthSecret.length !== AUTH_SECRET_LENGTH) {
    throw new Error("receiver auth secret must be 16 octets");
  }
  if (input.plaintext.length > MAX_WEB_PUSH_PLAINTEXT_BYTES) {
    throw new Error(
      `plaintext of ${String(input.plaintext.length)} octets exceeds the single-record limit of ${String(MAX_WEB_PUSH_PLAINTEXT_BYTES)} octets`,
    );
  }

  const senderEcdh = crypto.createECDH(P256_CURVE);
  if (input.senderPrivateKeyRaw !== undefined) {
    senderEcdh.setPrivateKey(input.senderPrivateKeyRaw);
  } else {
    senderEcdh.generateKeys();
  }
  const senderPublicKeyRaw = senderEcdh.getPublicKey();
  const salt = input.salt ?? crypto.randomBytes(SALT_LENGTH);

  // RFC 8291 §3.1/§3.3: ECDH shared secret, combined with the subscriber's auth secret
  // via HKDF-Extract(salt=auth_secret, IKM=ecdh_secret) then one HKDF-Expand block —
  // exactly what crypto.hkdfSync(digest, ikm, salt, info, 32) computes in one call.
  const ecdhSecret = senderEcdh.computeSecret(input.receiverPublicKeyRaw);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info"),
    Buffer.from([0]),
    input.receiverPublicKeyRaw,
    senderPublicKeyRaw,
  ]);
  const ikm = Buffer.from(
    crypto.hkdfSync("sha256", ecdhSecret, input.receiverAuthSecret, keyInfo, 32),
  );

  // RFC 8188 §2.2/§2.3: derive the content-encryption key and nonce from the RFC
  // 8291-derived IKM and the message's random salt. The two "info" strings are fixed by
  // the RFC (the content-coding name plus a single trailing zero octet).
  const cek = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), Buffer.from([0])]),
      16,
    ),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.concat([Buffer.from("Content-Encoding: nonce"), Buffer.from([0])]),
      12,
    ),
  );

  // Single record (RFC 8291 §4) — sequence number 0, so the nonce needs no XOR. Only the
  // mandatory delimiter octet is appended; no additional padding.
  const padded = Buffer.concat([input.plaintext, Buffer.from([LAST_RECORD_DELIMITER])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([
    salt,
    recordSize,
    Buffer.from([senderPublicKeyRaw.length]),
    senderPublicKeyRaw,
  ]);
  return Buffer.concat([header, ciphertext]);
}
