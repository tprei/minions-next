import crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import { PushNotificationKind, PushService } from "@minions/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPushService } from "@minions/daemon";

/**
 * Push service integration tests (PR 58 — mobile-pwa-push-offline).
 *
 * Uses Connect's in-memory `createRouterTransport` (no real HTTP server/port) for the RPC
 * layer itself, matching every sibling `*-service.test.ts` — see pairing-service.test.ts's
 * doc comment. `sendPushNotification`'s Web Push delivery, though, really does go over
 * loopback HTTP: each test starts a genuine `node:http` server standing in for a push
 * service (e.g. Google FCM/Mozilla autopush) and lets `fetch` hit it for real, then
 * inspects exactly what that server received — the actual `Authorization`/`Content-
 * Encoding`/`TTL` headers and the actual `aes128gcm` body, decrypted with an independent
 * reference implementation (not a re-run of the production encrypt code). `fetch` itself
 * is never mocked.
 */

function pushClient() {
  const transport = createRouterTransport((router) => {
    registerPushService(router, {});
  });
  return createClient(PushService, transport);
}

type CapturedRequest = Readonly<{
  path: string;
  method: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Buffer;
}>;

type MockPushServer = Readonly<{
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}>;

/** A real loopback HTTP server standing in for a push service. `statusByPath` controls
 * the response for each registered path (default 201, mirroring a real push service
 * accepting a message); every request is captured verbatim for assertion. */
async function startMockPushServer(
  statusByPath: ReadonlyMap<string, number> = new Map(),
): Promise<MockPushServer> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const path = req.url ?? "/";
      requests.push({
        path,
        method: req.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value[0] : value,
          ]),
        ),
        body: Buffer.concat(chunks),
      });
      res.writeHead(statusByPath.get(path) ?? 201);
      res.end();
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

type Subscriber = Readonly<{
  p256dhKey: string;
  authKey: string;
  privateKeyRaw: Buffer;
  authSecret: Buffer;
}>;

function generateSubscriber(): Subscriber {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return {
    p256dhKey: ecdh.getPublicKey().toString("base64url"),
    authKey: authSecret.toString("base64url"),
    privateKeyRaw: ecdh.getPrivateKey(),
    authSecret,
  };
}

/** Independent reference RFC 8291 decrypt (the user agent's side) — duplicated from
 * web-push-crypto.test.ts rather than shared, matching this repo's existing
 * `reserveLoopbackPort`-style convention of small per-file test helpers. */
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

const openServers: MockPushServer[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function mockServer(statusByPath?: ReadonlyMap<string, number>): Promise<MockPushServer> {
  const server = await startMockPushServer(statusByPath);
  openServers.push(server);
  return server;
}

/** Matches the try/catch + `.code`/`.rawMessage` ConnectError assertion convention used
 * throughout this repo's other `*-service.test.ts` files (e.g. pairing-service.test.ts) —
 * `toMatchObject` against a freshly-constructed ConnectError doesn't work here because a
 * rejection that has round-tripped through Connect's transport doesn't expose `message`
 * as an own enumerable property the way a locally-constructed one does. */
async function expectConnectError(
  promise: Promise<unknown>,
  code: Code,
  message: string,
): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected a ConnectError(${message})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(code);
    expect((error as ConnectError).rawMessage).toBe(message);
  }
}

describe("PushService integration", () => {
  describe("registerSubscription / unregisterSubscription (unchanged)", () => {
    it("registers a subscription and returns a UUID subscription id", async () => {
      const client = pushClient();
      const subscriber = generateSubscriber();
      const response = await client.registerSubscription({
        subscription: {
          endpoint: "https://push.example.net/sub/abc",
          p256dhKey: subscriber.p256dhKey,
          authKey: subscriber.authKey,
        },
      });
      expect(response.subscriptionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("rejects a missing subscription", async () => {
      const client = pushClient();
      await expectConnectError(
        client.registerSubscription({}),
        Code.InvalidArgument,
        "subscription is required",
      );
    });

    it("rejects an empty endpoint", async () => {
      const client = pushClient();
      const subscriber = generateSubscriber();
      await expectConnectError(
        client.registerSubscription({
          subscription: {
            endpoint: "  ",
            p256dhKey: subscriber.p256dhKey,
            authKey: subscriber.authKey,
          },
        }),
        Code.InvalidArgument,
        "subscription endpoint must not be empty",
      );
    });

    it("unregisters a registered subscription", async () => {
      const client = pushClient();
      const subscriber = generateSubscriber();
      const endpoint = "https://push.example.net/sub/xyz";
      await client.registerSubscription({
        subscription: { endpoint, p256dhKey: subscriber.p256dhKey, authKey: subscriber.authKey },
      });
      await client.unregisterSubscription({ endpoint });
    });

    it("rejects unregistering an unknown endpoint", async () => {
      const client = pushClient();
      await expectConnectError(
        client.unregisterSubscription({ endpoint: "https://push.example.net/never-registered" }),
        Code.NotFound,
        "subscription not found",
      );
    });
  });

  describe("getVapidPublicKey", () => {
    it("returns a base64url-encoded 65-octet uncompressed P-256 public key", async () => {
      const client = pushClient();
      const response = await client.getVapidPublicKey({});
      const raw = Buffer.from(response.vapidPublicKey, "base64url");
      expect(raw.length).toBe(65);
      expect(raw[0]).toBe(0x04);
    });

    it("is stable across repeated calls on the same registerPushService instance", async () => {
      const client = pushClient();
      const first = await client.getVapidPublicKey({});
      const second = await client.getVapidPublicKey({});
      expect(first.vapidPublicKey).toBe(second.vapidPublicKey);
    });

    it("differs across independent registerPushService instances (no shared global key)", async () => {
      const a = await pushClient().getVapidPublicKey({});
      const b = await pushClient().getVapidPublicKey({});
      expect(a.vapidPublicKey).not.toBe(b.vapidPublicKey);
    });
  });

  describe("sendPushNotification", () => {
    it("returns delivered_count: 0 and contacts nothing when there are no subscriptions", async () => {
      const client = pushClient();
      const response = await client.sendPushNotification({
        treeId: crypto.randomUUID(),
        nodeId: crypto.randomUUID(),
        kind: PushNotificationKind.ATTENTION,
        title: "unused",
      });
      expect(response.deliveredCount).toBe(0);
    });

    it("POSTs a correctly-shaped VAPID+aes128gcm request per subscription, decryptable by the subscriber, and counts every 2xx as delivered", async () => {
      const server = await mockServer();
      const client = pushClient();
      const { vapidPublicKey } = await client.getVapidPublicKey({});

      const subscribers = [generateSubscriber(), generateSubscriber(), generateSubscriber()];
      const endpoints = subscribers.map((_, index) => `${server.baseUrl}/push/${String(index)}`);
      await Promise.all(
        subscribers.map((subscriber, index) =>
          client.registerSubscription({
            subscription: {
              endpoint: endpoints[index] ?? "",
              p256dhKey: subscriber.p256dhKey,
              authKey: subscriber.authKey,
            },
          }),
        ),
      );

      const treeId = crypto.randomUUID();
      const nodeId = crypto.randomUUID();
      const response = await client.sendPushNotification({
        treeId,
        nodeId,
        kind: PushNotificationKind.OUTCOME,
        title: "Node finished: run the tests",
      });

      expect(response.deliveredCount).toBe(3);
      expect(server.requests).toHaveLength(3);

      for (const request of server.requests) {
        expect(request.method).toBe("POST");
        expect(request.headers["content-encoding"]).toBe("aes128gcm");
        expect(request.headers["ttl"]).toMatch(/^\d+$/);
        const authorization = request.headers["authorization"] ?? "";
        const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(authorization);
        expect(match).not.toBeNull();
        expect(match?.[2]).toBe(vapidPublicKey);

        // The JWT itself: header alg is ES256 and the audience is this mock server's origin.
        const jwtParts = (match?.[1] ?? "").split(".");
        const jwtHeader: unknown = JSON.parse(
          Buffer.from(jwtParts[0] ?? "", "base64url").toString(),
        );
        expect(jwtHeader).toEqual({ typ: "JWT", alg: "ES256" });
        const jwtBody: unknown = JSON.parse(Buffer.from(jwtParts[1] ?? "", "base64url").toString());
        expect(jwtBody).toMatchObject({ aud: server.baseUrl });

        // The body is genuinely aes128gcm-encrypted: decrypting with the matching
        // subscriber's private key recovers the exact plaintext payload; nothing here
        // ever reads request.body as text/JSON directly.
        const subscriberIndex = endpoints.indexOf(`${server.baseUrl}${request.path}`);
        const subscriber = subscribers[subscriberIndex];
        if (subscriber === undefined) {
          throw new Error(`no subscriber registered for request path ${request.path}`);
        }
        const plaintext = decryptWebPushPayload(
          request.body,
          subscriber.privateKeyRaw,
          subscriber.authSecret,
        );
        expect(JSON.parse(plaintext.toString())).toEqual({
          treeId,
          nodeId,
          kind: "outcome",
          title: "Node finished: run the tests",
        });
      }
    });

    it("isolates per-subscription failures — a 500 from one endpoint does not throw or block delivery to the others", async () => {
      const server = await mockServer(new Map([["/fail", 500]]));
      const client = pushClient();
      const good = generateSubscriber();
      const bad = generateSubscriber();
      await client.registerSubscription({
        subscription: {
          endpoint: `${server.baseUrl}/ok`,
          p256dhKey: good.p256dhKey,
          authKey: good.authKey,
        },
      });
      await client.registerSubscription({
        subscription: {
          endpoint: `${server.baseUrl}/fail`,
          p256dhKey: bad.p256dhKey,
          authKey: bad.authKey,
        },
      });

      const response = await client.sendPushNotification({
        treeId: crypto.randomUUID(),
        nodeId: crypto.randomUUID(),
        kind: PushNotificationKind.COMMAND_RECEIPT,
        title: "one of two subscriptions is broken",
      });

      expect(response.deliveredCount).toBe(1);
      expect(server.requests).toHaveLength(2);
    });

    it("treats 404 and 410 as gone and self-heals by pruning the subscription from the registry", async () => {
      const server = await mockServer(
        new Map([
          ["/gone-404", 404],
          ["/gone-410", 410],
        ]),
      );
      const client = pushClient();
      const subA = generateSubscriber();
      const subB = generateSubscriber();
      const subC = generateSubscriber();
      await client.registerSubscription({
        subscription: {
          endpoint: `${server.baseUrl}/gone-404`,
          p256dhKey: subA.p256dhKey,
          authKey: subA.authKey,
        },
      });
      await client.registerSubscription({
        subscription: {
          endpoint: `${server.baseUrl}/gone-410`,
          p256dhKey: subB.p256dhKey,
          authKey: subB.authKey,
        },
      });
      await client.registerSubscription({
        subscription: {
          endpoint: `${server.baseUrl}/still-good`,
          p256dhKey: subC.p256dhKey,
          authKey: subC.authKey,
        },
      });

      const first = await client.sendPushNotification({
        treeId: crypto.randomUUID(),
        nodeId: crypto.randomUUID(),
        kind: PushNotificationKind.ATTENTION,
        title: "first send prunes the two gone subscriptions",
      });
      expect(first.deliveredCount).toBe(1);
      expect(server.requests).toHaveLength(3);

      // Pruned subscriptions are gone from the registry: unregistering them now 404s.
      await expectConnectError(
        client.unregisterSubscription({ endpoint: `${server.baseUrl}/gone-404` }),
        Code.NotFound,
        "subscription not found",
      );
      await expectConnectError(
        client.unregisterSubscription({ endpoint: `${server.baseUrl}/gone-410` }),
        Code.NotFound,
        "subscription not found",
      );

      // A second send only contacts the still-good subscription.
      const second = await client.sendPushNotification({
        treeId: crypto.randomUUID(),
        nodeId: crypto.randomUUID(),
        kind: PushNotificationKind.ATTENTION,
        title: "second send only reaches the surviving subscription",
      });
      expect(second.deliveredCount).toBe(1);
      expect(server.requests).toHaveLength(4);
    });

    it("labels every PushNotificationKind correctly in the encrypted plaintext", async () => {
      const server = await mockServer();
      const client = pushClient();
      const cases: readonly (readonly [PushNotificationKind, string])[] = [
        [PushNotificationKind.ATTENTION, "attention"],
        [PushNotificationKind.OUTCOME, "outcome"],
        [PushNotificationKind.COMMAND_RECEIPT, "command_receipt"],
      ];
      for (const [kind, label] of cases) {
        const subscriber = generateSubscriber();
        const endpoint = `${server.baseUrl}/${label}`;
        await client.registerSubscription({
          subscription: { endpoint, p256dhKey: subscriber.p256dhKey, authKey: subscriber.authKey },
        });
        await client.sendPushNotification({
          treeId: crypto.randomUUID(),
          nodeId: crypto.randomUUID(),
          kind,
          title: `kind check: ${label}`,
        });
        const request = server.requests.find((entry) => entry.path === `/${label}`);
        expect(request).toBeDefined();
        const plaintext = decryptWebPushPayload(
          request?.body ?? Buffer.alloc(0),
          subscriber.privateKeyRaw,
          subscriber.authSecret,
        );
        const parsed: unknown = JSON.parse(plaintext.toString());
        expect(parsed).toMatchObject({ kind: label });
        await client.unregisterSubscription({ endpoint });
      }
    });

    it("rejects an unspecified kind before attempting any delivery", async () => {
      const server = await mockServer();
      const client = pushClient();
      const subscriber = generateSubscriber();
      await client.registerSubscription({
        subscription: {
          endpoint: `${server.baseUrl}/x`,
          p256dhKey: subscriber.p256dhKey,
          authKey: subscriber.authKey,
        },
      });
      await expectConnectError(
        client.sendPushNotification({
          treeId: crypto.randomUUID(),
          nodeId: crypto.randomUUID(),
          kind: PushNotificationKind.UNSPECIFIED,
          title: "unused",
        }),
        Code.InvalidArgument,
        "kind must be specified",
      );
      expect(server.requests).toHaveLength(0);
    });

    it("never logs the notification title (privacy-minimal payload)", async () => {
      const server = await mockServer();
      const client = pushClient();
      const subscriber = generateSubscriber();
      await client.registerSubscription({
        subscription: {
          endpoint: `${server.baseUrl}/x`,
          p256dhKey: subscriber.p256dhKey,
          authKey: subscriber.authKey,
        },
      });
      const secretTitle = "SECRET-TITLE-must-never-be-logged-9f3c1a";
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
      try {
        await client.sendPushNotification({
          treeId: crypto.randomUUID(),
          nodeId: crypto.randomUUID(),
          kind: PushNotificationKind.ATTENTION,
          title: secretTitle,
        });
      } finally {
        for (const spy of [logSpy, warnSpy, errorSpy, infoSpy]) {
          for (const call of spy.mock.calls) {
            expect(call.join(" ")).not.toContain(secretTitle);
          }
        }
      }
    });
  });
});
