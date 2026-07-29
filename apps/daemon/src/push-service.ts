import { randomUUID } from "node:crypto";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { PushService } from "@minions/contracts";

/**
 * Push service handler (PR 58 — mobile-pwa-push-offline).
 *
 * RegisterSubscription and UnregisterSubscription are functional with an in-memory
 * subscription set. Subscriptions are ephemeral — in production, a persistent
 * store would survive restarts. SendPushNotification requires a Web Push delivery
 * pipeline (VAPID keys, HTTP web-push protocol) and returns Code.Unimplemented.
 */
export type PushServiceOptions = Readonly<Record<string, never>>;

export function registerPushService(router: ConnectRouter, options: PushServiceOptions): void {
  void options;
  const subscriptions = new Map<string, string>(); // endpoint → subscription_id

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
      subscriptions.set(endpoint, subscriptionId);
      return { subscriptionId };
    },
    unregisterSubscription(request) {
      const endpoint = request.endpoint;
      if (subscriptions.delete(endpoint)) {
        return {};
      }
      throw new ConnectError("subscription not found", Code.NotFound);
    },
    sendPushNotification() {
      throw new ConnectError(
        "SendPushNotification requires a Web Push delivery pipeline (VAPID keys)",
        Code.Unimplemented,
      );
    },
  });
}
