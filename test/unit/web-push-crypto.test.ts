import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptWebPushPayload,
  generateVapidKeyPair,
  signVapidJwt,
  MAX_WEB_PUSH_PLAINTEXT_BYTES,
} from "../../apps/daemon/src/web-push-crypto.js";

/**
 * web-push-crypto.ts unit tests (PR 58 — mobile-pwa-push-offline).
 *
 * `encryptWebPushPayload` is checked two ways: byte-for-byte against the RFC 8291
 * Appendix A worked example (a real external oracle — fixed keys, salt, plaintext, and
 * expected ciphertext, reachable at https://www.rfc-editor.org/rfc/rfc8291), and via
 * round-trips against {@link decryptWebPushPayload}, a from-scratch reference decrypt
 * implemented independently below (receiver's side of the same RFC) — encrypt-then-
 * decrypt-and-compare is a valid correctness check even where it duplicates the Appendix
 * A coverage, because it also exercises random (non-fixed) keys/salts on every run.
 */

const b64u = (s: string): Buffer => Buffer.from(s, "base64url");

describe("encryptWebPushPayload — RFC 8291 Appendix A conformance", () => {
  // https://www.rfc-editor.org/rfc/rfc8291 Appendix A / Section 5.
  const plaintext = b64u("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
  const asPrivateRaw = b64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
  const uaPublicRaw = b64u(
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  );
  const salt = b64u("DGv6ra1nlYgDCS1FRnbzlw");
  const authSecret = b64u("BTBZMqHH6r4Tts7J_aSIgg");
  const expectedBody = b64u(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );

  it("reproduces the exact 144-octet wire body (header + ciphertext) from the RFC's fixed keys/salt/plaintext", () => {
    const body = encryptWebPushPayload({
      plaintext,
      receiverPublicKeyRaw: uaPublicRaw,
      receiverAuthSecret: authSecret,
      senderPrivateKeyRaw: asPrivateRaw,
      salt,
    });
    expect(body.equals(expectedBody)).toBe(true);
  });

  it("header carries the 16-byte salt, a 4096 record size, and the 65-byte sender public key as keyid", () => {
    const body = encryptWebPushPayload({
      plaintext,
      receiverPublicKeyRaw: uaPublicRaw,
      receiverAuthSecret: authSecret,
      senderPrivateKeyRaw: asPrivateRaw,
      salt,
    });
    expect(body.subarray(0, 16).equals(salt)).toBe(true);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04); // uncompressed EC point prefix
  });
});

describe("encryptWebPushPayload — round trip against an independent reference decrypt", () => {
  it("recovers the exact plaintext for freshly generated, non-fixed subscriber keys", () => {
    for (let i = 0; i < 10; i += 1) {
      const receiver = generateEcdhKeyPair();
      const authSecret = crypto.randomBytes(16);
      const plaintext = Buffer.from(
        JSON.stringify({
          treeId: `tree-${String(i)}`,
          nodeId: `node-${String(i)}`,
          title: `hi ${String(i)}`,
        }),
      );

      const body = encryptWebPushPayload({
        plaintext,
        receiverPublicKeyRaw: receiver.publicKeyRaw,
        receiverAuthSecret: authSecret,
      });
      const recovered = decryptWebPushPayload(body, receiver.privateKeyRaw, authSecret);
      expect(recovered.equals(plaintext)).toBe(true);
    }
  });

  it("two encryptions of the same plaintext never produce the same body (fresh salt + ephemeral key per call)", () => {
    const receiver = generateEcdhKeyPair();
    const authSecret = crypto.randomBytes(16);
    const plaintext = Buffer.from("same plaintext both times");

    const first = encryptWebPushPayload({
      plaintext,
      receiverPublicKeyRaw: receiver.publicKeyRaw,
      receiverAuthSecret: authSecret,
    });
    const second = encryptWebPushPayload({
      plaintext,
      receiverPublicKeyRaw: receiver.publicKeyRaw,
      receiverAuthSecret: authSecret,
    });
    expect(first.equals(second)).toBe(false);
    // but both still decrypt to the same plaintext
    expect(decryptWebPushPayload(first, receiver.privateKeyRaw, authSecret).equals(plaintext)).toBe(
      true,
    );
    expect(
      decryptWebPushPayload(second, receiver.privateKeyRaw, authSecret).equals(plaintext),
    ).toBe(true);
  });

  it("fails to decrypt (AEAD authentication failure) against the wrong auth secret", () => {
    const receiver = generateEcdhKeyPair();
    const authSecret = crypto.randomBytes(16);
    const wrongAuthSecret = crypto.randomBytes(16);
    const body = encryptWebPushPayload({
      plaintext: Buffer.from("top secret notification title"),
      receiverPublicKeyRaw: receiver.publicKeyRaw,
      receiverAuthSecret: authSecret,
    });
    expect(() => decryptWebPushPayload(body, receiver.privateKeyRaw, wrongAuthSecret)).toThrow();
  });

  it("fails to decrypt against the wrong receiver private key", () => {
    const receiver = generateEcdhKeyPair();
    const otherReceiver = generateEcdhKeyPair();
    const authSecret = crypto.randomBytes(16);
    const body = encryptWebPushPayload({
      plaintext: Buffer.from("top secret notification title"),
      receiverPublicKeyRaw: receiver.publicKeyRaw,
      receiverAuthSecret: authSecret,
    });
    expect(() => decryptWebPushPayload(body, otherReceiver.privateKeyRaw, authSecret)).toThrow();
  });
});

describe("encryptWebPushPayload — input validation", () => {
  const receiver = generateEcdhKeyPair();
  const authSecret = crypto.randomBytes(16);

  it("rejects a receiver public key that is not a 65-octet uncompressed point", () => {
    expect(() =>
      encryptWebPushPayload({
        plaintext: Buffer.from("x"),
        receiverPublicKeyRaw: Buffer.alloc(64),
        receiverAuthSecret: authSecret,
      }),
    ).toThrow(/65-octet/);
  });

  it("rejects an auth secret that is not 16 octets", () => {
    expect(() =>
      encryptWebPushPayload({
        plaintext: Buffer.from("x"),
        receiverPublicKeyRaw: receiver.publicKeyRaw,
        receiverAuthSecret: Buffer.alloc(15),
      }),
    ).toThrow(/16 octets/);
  });

  it("rejects plaintext larger than the single-record limit", () => {
    expect(() =>
      encryptWebPushPayload({
        plaintext: Buffer.alloc(MAX_WEB_PUSH_PLAINTEXT_BYTES + 1),
        receiverPublicKeyRaw: receiver.publicKeyRaw,
        receiverAuthSecret: authSecret,
      }),
    ).toThrow(/exceeds the single-record limit/);
  });

  it("accepts plaintext exactly at the single-record limit", () => {
    const body = encryptWebPushPayload({
      plaintext: Buffer.alloc(MAX_WEB_PUSH_PLAINTEXT_BYTES),
      receiverPublicKeyRaw: receiver.publicKeyRaw,
      receiverAuthSecret: authSecret,
    });
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("generateVapidKeyPair", () => {
  it("produces a 65-octet uncompressed P-256 public key (0x04 prefix)", () => {
    const vapid = generateVapidKeyPair();
    expect(vapid.publicKeyRaw.length).toBe(65);
    expect(vapid.publicKeyRaw[0]).toBe(0x04);
  });

  it("base64url-encodes publicKeyRaw exactly as publicKeyBase64Url", () => {
    const vapid = generateVapidKeyPair();
    expect(Buffer.from(vapid.publicKeyBase64Url, "base64url").equals(vapid.publicKeyRaw)).toBe(
      true,
    );
    // no padding/URL-unsafe characters
    expect(vapid.publicKeyBase64Url).not.toMatch(/[+/=]/);
  });

  it("generates a fresh, distinct key pair on every call", () => {
    const a = generateVapidKeyPair();
    const b = generateVapidKeyPair();
    expect(a.publicKeyBase64Url).not.toBe(b.publicKeyBase64Url);
  });
});

describe("signVapidJwt", () => {
  it("produces a three-segment compact JWS with a 64-octet raw ES256 signature", () => {
    const vapid = generateVapidKeyPair();
    const jwt = signVapidJwt(vapid, "https://push.example.net", 1_700_000_000);
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    const [headerSegment, bodySegment, signatureSegment] = segments as [string, string, string];
    expect(JSON.parse(Buffer.from(headerSegment, "base64url").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const body: unknown = JSON.parse(Buffer.from(bodySegment, "base64url").toString());
    expect(body).toMatchObject({ aud: "https://push.example.net", exp: 1_700_000_000 });
    expect(Buffer.from(signatureSegment, "base64url").length).toBe(64);
  });

  it("produces a signature that verifies against the VAPID public key", () => {
    const vapid = generateVapidKeyPair();
    const jwt = signVapidJwt(vapid, "https://push.example.net", 1_700_000_000);
    const parts = jwt.split(".");
    const signingInput = `${parts[0] ?? ""}.${parts[1] ?? ""}`;
    const signature = Buffer.from(parts[2] ?? "", "base64url");
    const publicKey = crypto.createPublicKey({
      key: derFromRawP256PublicKey(vapid.publicKeyRaw),
      format: "der",
      type: "spki",
    });
    const verified = crypto.verify(
      "sha256",
      Buffer.from(signingInput),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
    expect(verified).toBe(true);
  });

  it("fails verification against a different VAPID key pair's public key", () => {
    const vapid = generateVapidKeyPair();
    const otherVapid = generateVapidKeyPair();
    const jwt = signVapidJwt(vapid, "https://push.example.net", 1_700_000_000);
    const parts = jwt.split(".");
    const signingInput = `${parts[0] ?? ""}.${parts[1] ?? ""}`;
    const signature = Buffer.from(parts[2] ?? "", "base64url");
    const otherPublicKey = crypto.createPublicKey({
      key: derFromRawP256PublicKey(otherVapid.publicKeyRaw),
      format: "der",
      type: "spki",
    });
    const verified = crypto.verify(
      "sha256",
      Buffer.from(signingInput),
      { key: otherPublicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
    expect(verified).toBe(false);
  });

  it("fails verification once the signing input is tampered with", () => {
    const vapid = generateVapidKeyPair();
    const jwt = signVapidJwt(vapid, "https://push.example.net", 1_700_000_000);
    const parts = jwt.split(".");
    const tamperedInput = `${parts[0] ?? ""}.${Buffer.from('{"aud":"https://evil.example","exp":9999999999}').toString("base64url")}`;
    const signature = Buffer.from(parts[2] ?? "", "base64url");
    const publicKey = crypto.createPublicKey({
      key: derFromRawP256PublicKey(vapid.publicKeyRaw),
      format: "der",
      type: "spki",
    });
    const verified = crypto.verify(
      "sha256",
      Buffer.from(tamperedInput),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
    expect(verified).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// Test-only helpers. Production code never decrypts (only a subscriber's browser does) or needs a
// raw-point-to-DER conversion (VAPID signing works directly against the KeyObject) — both exist only
// to give these tests an independent oracle.
// -------------------------------------------------------------------------------------------------

function generateEcdhKeyPair(): { publicKeyRaw: Buffer; privateKeyRaw: Buffer } {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKeyRaw: ecdh.getPublicKey(), privateKeyRaw: ecdh.getPrivateKey() };
}

/** SEC1-uncompressed-point → SubjectPublicKeyInfo DER, the fixed 26-octet prime256v1
 * AlgorithmIdentifier prefix followed by the 65-octet BIT STRING point (the exact inverse
 * of web-push-crypto.ts's own SPKI slice, re-derived independently for this test). */
function derFromRawP256PublicKey(raw: Buffer): Buffer {
  const prefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
  return Buffer.concat([prefix, raw]);
}

/** Reference RFC 8291 decrypt (the user agent's side), implemented independently from
 * encryptWebPushPayload to give the round-trip tests above a real oracle rather than
 * merely re-running the same code forwards and backwards. */
function decryptWebPushPayload(
  body: Buffer,
  receiverPrivateKeyRaw: Buffer,
  receiverAuthSecret: Buffer,
): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  if (idlen === undefined) {
    throw new Error("truncated aes128gcm header");
  }
  const senderPublicKeyRaw = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const receiverEcdh = crypto.createECDH("prime256v1");
  receiverEcdh.setPrivateKey(receiverPrivateKeyRaw);
  const receiverPublicKeyRaw = receiverEcdh.getPublicKey();
  const ecdhSecret = receiverEcdh.computeSecret(senderPublicKeyRaw);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info"),
    Buffer.from([0]),
    receiverPublicKeyRaw,
    senderPublicKeyRaw,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, receiverAuthSecret, keyInfo, 32));
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

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) {
    end -= 1;
  }
  if (padded[end - 1] !== 0x02) {
    throw new Error("invalid or missing last-record padding delimiter (0x02)");
  }
  return padded.subarray(0, end - 1);
}
