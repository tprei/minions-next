import { useCallback, useEffect, useState } from "react";
import type { Client } from "@connectrpc/connect";
import type { PushService } from "@minions/contracts";
import { describeConnectError, type TypedError } from "../home/connect-error.js";
import { decodeVapidPublicKey } from "./web-push-key.js";

export type PushSubscriptionStatus =
  | "unsupported"
  | "checking"
  | "unsubscribed"
  | "subscribing"
  | "subscribed"
  | "unsubscribing"
  | "error";

export interface PushSubscriptionState {
  readonly status: PushSubscriptionStatus;
  readonly error: TypedError | undefined;
  readonly subscribe: () => void;
  readonly unsubscribe: () => void;
}

/**
 * Drives the browser side of the Web Push subscribe flow (PR 58 —
 * mobile-pwa-push-offline). On mount, feature-detects Push API support and checks
 * `PushManager.getSubscription()` for an already-active subscription (e.g. from a prior
 * visit) so the UI never asks to re-subscribe an already-subscribed browser.
 *
 * `subscribe()` walks, in order: `Notification.requestPermission` →
 * `PushService.GetVapidPublicKey` → `PushManager.subscribe` →
 * `PushService.RegisterSubscription`. Any step's failure surfaces via `error`
 * (`describeConnectError` handles both real `ConnectError`s from the RPC steps and plain
 * browser `Error`s from the Notification/Push API steps — `ConnectError.from` wraps
 * either uniformly). If `RegisterSubscription` itself is what fails, the just-created
 * browser-side `PushSubscription` is torn back down so a retry starts clean instead of
 * leaving an orphaned subscription the daemon never learned about.
 */
export function usePushSubscription(pushClient: Client<typeof PushService>): PushSubscriptionState {
  const [status, setStatus] = useState<PushSubscriptionStatus>("checking");
  const [error, setError] = useState<TypedError | undefined>(undefined);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (!controller.signal.aborted) {
        setStatus(existing !== null ? "subscribed" : "unsubscribed");
      }
    })();
    return () => {
      controller.abort();
    };
  }, []);

  const subscribe = useCallback(() => {
    void (async () => {
      setStatus("subscribing");
      setError(undefined);
      let created: PushSubscription | undefined;
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          throw new Error(`notification permission was ${permission}, not granted`);
        }
        const registration = await navigator.serviceWorker.ready;
        const { vapidPublicKey } = await pushClient.getVapidPublicKey({});
        created = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidPublicKey(vapidPublicKey),
        });
        const keys = created.toJSON().keys;
        const p256dhKey = keys?.["p256dh"];
        const authKey = keys?.["auth"];
        if (p256dhKey === undefined || authKey === undefined) {
          throw new Error("browser did not return p256dh/auth subscription keys");
        }
        await pushClient.registerSubscription({
          subscription: { endpoint: created.endpoint, p256dhKey, authKey },
        });
        setStatus("subscribed");
      } catch (caught) {
        if (created !== undefined) {
          await created.unsubscribe().catch(() => false);
        }
        setError(describeConnectError(caught));
        setStatus("error");
      }
    })();
  }, [pushClient]);

  const unsubscribe = useCallback(() => {
    void (async () => {
      setStatus("unsubscribing");
      setError(undefined);
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing !== null) {
          const endpoint = existing.endpoint;
          await existing.unsubscribe();
          await pushClient.unregisterSubscription({ endpoint });
        }
        setStatus("unsubscribed");
      } catch (caught) {
        setError(describeConnectError(caught));
        setStatus("error");
      }
    })();
  }, [pushClient]);

  return { status, error, subscribe, unsubscribe };
}
