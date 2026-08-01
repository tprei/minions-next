import { useMemo, type ReactNode } from "react";
import { Button, Fact, NavBar, StateView, StatusBadge, type StatusKind } from "@minions/ui-kit";
import { createApiClients, type ApiClients } from "../data/index.js";
import { useEventClient } from "../data/use-event-client.js";
import {
  usePushSubscription,
  type PushSubscriptionStatus,
} from "./push-notifications/use-push-subscription.js";
import "./PushNotifications.css";

const STATUS_LABEL: Readonly<Record<PushSubscriptionStatus, string>> = {
  unsupported: "not supported on this browser",
  checking: "checking…",
  unsubscribed: "not subscribed",
  subscribing: "subscribing…",
  subscribed: "subscribed",
  unsubscribing: "unsubscribing…",
  error: "error",
};

const STATUS_BADGE_KIND: Readonly<Record<PushSubscriptionStatus, StatusKind>> = {
  unsupported: "neutral",
  checking: "neutral",
  unsubscribed: "neutral",
  subscribing: "warning",
  subscribed: "success",
  unsubscribing: "warning",
  error: "danger",
};

/**
 * Push notification subscribe/unsubscribe panel (PR 58 — mobile-pwa-push-offline).
 * Follows Maintenance.tsx's self-contained-route pattern (PR 55). Reached at
 * `/push-notifications`, linked from the home screen's nav bar.
 *
 * The actual subscribe flow (`Notification.requestPermission` → `GetVapidPublicKey` →
 * `PushManager.subscribe` → `RegisterSubscription`) lives in use-push-subscription.ts;
 * this component only renders its state. The service worker that turns an arriving push
 * message into a real OS notification is src/sw.ts (`push`/`notificationclick` — this
 * component never touches that event, since it only ever reaches a service worker).
 */
export function PushNotificationsRoute(): ReactNode {
  const { connectionState } = useEventClient();
  const clients = useMemo<ApiClients>(() => createApiClients(), []);
  const { status, error, subscribe, unsubscribe } = usePushSubscription(clients.push);

  return (
    <>
      <NavBar brand="Minions">
        <a className="mn-push-notifications__back" href="/">
          ← Home
        </a>
        <StatusBadge
          status={connectionState === "live" ? "success" : "warning"}
          label={`daemon: ${connectionState}`}
          data-testid="connection-state"
        />
      </NavBar>

      <main className="mn-push-notifications" data-testid="push-notifications">
        <div className="mn-push-notifications__header">
          <h1>Push notifications</h1>
          <StatusBadge
            status={STATUS_BADGE_KIND[status]}
            label={STATUS_LABEL[status]}
            data-testid="push-subscription-status"
          />
        </div>

        {status === "unsupported" ? (
          <StateView
            kind="empty"
            title="Push notifications aren't supported on this browser"
            description="This browser has no Service Worker / Push API support, so there is nothing to enable here."
          />
        ) : (
          <>
            <p className="mn-push-notifications__description">
              Get notified on this device when a task needs your attention, a node finishes, or a
              command you sent is delivered. Notification content is end-to-end encrypted (RFC 8291)
              — the daemon never logs it, and only your browser can decrypt it.
            </p>
            <Fact>
              Subscribing is per-browser: enabling it here does not affect any other device, and it
              stops the moment you disable it below or clear this browser's site data.
            </Fact>
            <div className="mn-push-notifications__actions">
              {status === "subscribed" || status === "unsubscribing" ? (
                <Button
                  variant="secondary"
                  disabled={status === "unsubscribing"}
                  onClick={unsubscribe}
                  data-testid="unsubscribe-button"
                >
                  {status === "unsubscribing" ? "Disabling…" : "Disable push notifications"}
                </Button>
              ) : (
                <Button
                  disabled={status === "subscribing" || status === "checking"}
                  onClick={subscribe}
                  data-testid="subscribe-button"
                >
                  {status === "subscribing" ? "Enabling…" : "Enable push notifications"}
                </Button>
              )}
            </div>
            {error !== undefined ? (
              <p className="mn-form-error" role="alert">
                <strong>{error.code}:</strong> {error.message}
              </p>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}
