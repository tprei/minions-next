/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";

// PR 58 — mobile-pwa-push-offline. This file (not App.tsx or any other app code) is the
// only place `push`/`notificationclick` are handled — those events only ever reach a
// service worker, never a page. Lives in its own directory with its own tsconfig.json
// (WebWorker lib, no DOM) rather than under src/, because a service worker's global
// scope is incompatible with the `DOM` lib the rest of this app uses (no
// `window`/`document`), and typescript-eslint's project service only auto-discovers
// files literally named `tsconfig.json`.
declare const self: ServiceWorkerGlobalScope;

// injectManifest strategy (vite.config.ts): self.__WB_MANIFEST is replaced at build time
// with the precache list `injectManifest.globPatterns` selects — reproduces the exact
// app-shell caching the prior generateSW-based config provided. RPC traffic (fetch to the
// daemon's Connect endpoint) is never intercepted — nothing below adds a `fetch` handler.
precacheAndRoute(self.__WB_MANIFEST);

/** The plaintext a push message decrypts to — see apps/daemon/src/push-service.ts's
 * `sendPushNotification`, which is the only sender and controls this exact shape. */
interface PushNotificationPayload {
  readonly treeId: string;
  readonly nodeId: string;
  readonly kind: "attention" | "outcome" | "command_receipt";
  readonly title: string;
}

function isPushNotificationPayload(value: unknown): value is PushNotificationPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["treeId"] === "string" &&
    typeof record["nodeId"] === "string" &&
    typeof record["title"] === "string" &&
    (record["kind"] === "attention" ||
      record["kind"] === "outcome" ||
      record["kind"] === "command_receipt")
  );
}

function notificationBody(kind: PushNotificationPayload["kind"]): string {
  switch (kind) {
    case "attention":
      return "Needs your input";
    case "outcome":
      return "Finished";
    case "command_receipt":
      return "Command delivered";
  }
}

self.addEventListener("push", (event) => {
  if (event.data === null) {
    return;
  }
  let payload: unknown;
  try {
    payload = event.data.json();
  } catch {
    return; // Not a payload this service worker understands — never surface raw bytes.
  }
  if (!isPushNotificationPayload(payload)) {
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: notificationBody(payload.kind),
      tag: `${payload.treeId}:${payload.nodeId}`,
      data: { treeId: payload.treeId, nodeId: payload.nodeId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { treeId?: string; nodeId?: string } | undefined;
  const targetUrl =
    data?.treeId !== undefined && data.nodeId !== undefined
      ? `/tree/${encodeURIComponent(data.treeId)}/node/${encodeURIComponent(data.nodeId)}`
      : "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clientList) => {
        for (const client of clientList) {
          if (
            client.url.startsWith(self.location.origin) &&
            "focus" in client &&
            "navigate" in client
          ) {
            await client.navigate(targetUrl);
            await client.focus();
            return;
          }
        }
        await self.clients.openWindow(targetUrl);
      }),
  );
});
