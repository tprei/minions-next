import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PR 43 — ui-design-system-shell (PRD UI-11); PR 58 — mobile-pwa-push-offline switched
// from the `generateSW` strategy to `injectManifest` so the service worker
// (service-worker/sw.ts) can add `push`/`notificationclick` handlers — `generateSW`'s
// workbox build has no hook for custom event listeners. `injectManifest.globPatterns`
// reproduces the exact app-shell precache list the old `workbox.globPatterns` provided;
// service-worker/sw.ts calls `precacheAndRoute(self.__WB_MANIFEST)` against it. The SW
// source lives outside src/ (its own directory, with its own tsconfig.json — see that
// directory) because a service worker's global scope is incompatible with the `DOM` lib
// the rest of this app uses; typescript-eslint's project service only auto-discovers
// files named exactly `tsconfig.json`, so it needs its own directory rather than a
// differently-named sibling tsconfig. The PWA still caches only the last-known
// application shell and read-only projections fetched at runtime; it never caches or
// replays a mutating RPC response (registerType: "prompt" — the operator must explicitly
// accept an update rather than silently running stale code against a live daemon).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      strategies: "injectManifest",
      srcDir: "service-worker",
      filename: "sw.ts",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Minions",
        short_name: "Minions",
        description: "Local-first command center for supervising coding agents.",
        start_url: "/",
        display: "standalone",
        background_color: "#101014",
        theme_color: "#4638e0",
        icons: [
          { src: "pwa-192.svg", sizes: "192x192", type: "image/svg+xml" },
          { src: "pwa-512.svg", sizes: "512x512", type: "image/svg+xml" },
        ],
      },
      injectManifest: {
        // Read-only, cacheable app-shell assets only. RPC traffic (fetch to the
        // daemon's Connect endpoint) is never intercepted by the service worker.
        globPatterns: ["**/*.{js,css,html,svg}"],
      },
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
