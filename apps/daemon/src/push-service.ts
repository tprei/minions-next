import { randomUUID } from "node:crypto";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { PushNotificationKind, PushService } from "@minions/contracts";
import { generateVapidKeyPair, MAX_WEB_PUSH_PLAINTEXT_BYTES } from "./web-push-crypto.js";
import { sendWebPush } from "./web-push.js";

/**
 * Push service handler (PR 58 — mobile-pwa-push-offline).
 *
 * RegisterSubscription and UnregisterSubscription are unchanged from the prior revision:
 * functional with an in-memory subscription set, ephemeral for the daemon process
 * lifetime (no persistent store exists yet — a restarted daemon requires every
 * subscription to be recreated).
 *
 * GetVapidPublicKey and SendPushNotification implement genuine Web Push delivery: RFC
 * 8291 payload encryption and RFC 8292 VAPID request signing (see web-push-crypto.ts for
 * the cryptographic primitives, web-push.ts for the HTTP delivery). The VAPID signing key
 * pair is generated once per `registerPushService` call — closure state, matching
 * `subscriptions`' in-memory-per-process lifetime — and never persisted to disk or a
 * database. A restarted daemon mints a new VAPID key, so every subscription created under
 * the old key stops delivering silently; Web Push has no mechanism to notify a subscriber
 * of this, so the phone only recovers once it re-subscribes (matches the "ephemeral, not
 * persisted" precedent RegisterSubscription already set).
 *
 * Delivery is best-effort per subscription: encryption, network, or HTTP failures for one
 * subscription never abort the broadcast to the rest (see web-push.ts's `sendWebPush`,
 * which never throws). A 404/410 response means the push service has permanently
 * discarded the subscription (RFC 8030 §7.3), so it is pruned from the registry —
 * self-healing, since a stale subscription would otherwise fail forever.
 *
 * Notification titles are never logged, matching this proto's own doc comment — this
 * file and its web-push*.ts collaborators never call `console.*` with request/response
 * content.
 */
export type PushServiceOptions = Readonly<Record<string, never>>;

type StoredSubscription = Readonly<{
  readonly subscriptionId: string;
  readonly p256dhKey: string;
  readonly authKey: string;
}>;

function toKindLabel(kind: PushNotificationKind): "attention" | "outcome" | "command_receipt" {
  switch (kind) {
    case PushNotificationKind.ATTENTION:
      return "attention";
    case PushNotificationKind.OUTCOME:
      return "outcome";
    case PushNotificationKind.COMMAND_RECEIPT:
      return "command_receipt";
    case PushNotificationKind.UNSPECIFIED:
      throw new ConnectError("kind must be specified", Code.InvalidArgument);
  }
}

export function registerPushService(router: ConnectRouter, options: PushServiceOptions): void {
  void options;
  const subscriptions = new Map<string, StoredSubscription>(); // endpoint → subscription
  const vapidKeyPair = generateVapidKeyPair();

  router.service(PushService, {
    registerSubscription(request) {
      if (request.subscription === undefined) {
        throw new ConnectError("subscription is required", Code.InvalidArgument);
      }
      const endpoint = request.subscription.endpoint;
      if (endpoint.trim().length === 0) {
        throw new ConnectError("subscription endpoint must not be empty", Code.InvalidArgument);
      }
      const subscriptionId = randomUUID();
      subscriptions.set(endpoint, {
        subscriptionId,
        p256dhKey: request.subscription.p256dhKey,
        authKey: request.subscription.authKey,
      });
      return { subscriptionId };
    },
    unregisterSubscription(request) {
      const endpoint = request.endpoint;
      if (subscriptions.delete(endpoint)) {
        return {};
      }
      throw new ConnectError("subscription not found", Code.NotFound);
    },
    getVapidPublicKey() {
      return { vapidPublicKey: vapidKeyPair.publicKeyBase64Url };
    },
    async sendPushNotification(request) {
      const plaintext = Buffer.from(
        JSON.stringify({
          treeId: request.treeId,
          nodeId: request.nodeId,
          kind: toKindLabel(request.kind),
          title: request.title,
        }),
      );
      if (plaintext.byteLength > MAX_WEB_PUSH_PLAINTEXT_BYTES) {
        throw new ConnectError(
          "push notification payload is too large to encrypt as a single Web Push record",
          Code.InvalidArgument,
        );
      }

      const results = await Promise.all(
        Array.from(subscriptions.entries()).map(async ([endpoint, subscription]) => ({
          endpoint,
          outcome: await sendWebPush(
            { endpoint, p256dhKey: subscription.p256dhKey, authKey: subscription.authKey },
            vapidKeyPair,
            plaintext,
          ),
        })),
      );

      let deliveredCount = 0;
      for (const { endpoint, outcome } of results) {
        if (outcome === "delivered") {
          deliveredCount += 1;
        } else if (outcome === "gone") {
          subscriptions.delete(endpoint);
        }
      }
      return { deliveredCount };
    },
  });
}
