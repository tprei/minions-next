import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PR 43 — ui-design-system-shell (PRD UI-11). The PWA caches only the last-known
// application shell and read-only projections fetched at runtime; it never caches or
// replays a mutating RPC response (registerType: "prompt" — the operator must explicitly
// accept an update rather than silently running stale code against a live daemon).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
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
      workbox: {
        // Read-only, cacheable app-shell assets only. RPC traffic (fetch to the daemon's
        // Connect endpoint) is never intercepted by the service worker.
        globPatterns: ["**/*.{js,css,html,svg}"],
      },
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
