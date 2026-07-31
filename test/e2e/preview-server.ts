import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { URL } from "node:url";

export interface PreviewServerOptions {
  readonly distDir: string;
  readonly port: number;
  readonly host?: string;
  readonly daemonBaseUrl: string;
}

export interface RunningPreviewServer {
  readonly baseUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Requests whose raw path starts with the Connect RPC service prefix "/minions."
// (e.g. "/minions.v1.EventService/GetSnapshot", "/minions.v1.EventService/WatchEvents")
// are forwarded verbatim, byte-for-byte, to the real daemon so a long-lived streamed
// response (WatchEvents) is never buffered.
function proxyToDaemon(req: IncomingMessage, res: ServerResponse, daemonBaseUrl: string): void {
  const daemonUrl = new URL(daemonBaseUrl);
  const proxyReq = httpRequest(
    {
      protocol: daemonUrl.protocol,
      hostname: daemonUrl.hostname,
      port: daemonUrl.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: daemonUrl.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502);
    }
    res.end();
  });
  // Propagate an early CLIENT disconnect to the upstream daemon request — but only when the
  // response genuinely never completed. `req`'s own "close" fires as soon as the incoming
  // request BODY finishes streaming (i.e. right after `req.pipe(proxyReq)` forwards the last
  // body byte), which is long before the daemon's response arrives for a normal exchange;
  // destroying `proxyReq` there would abort the upstream request before it could ever be
  // answered. `res`'s "close" firing without `res.writableEnded` is what actually means "the
  // browser hung up before we finished replying to it".
  res.on("close", () => {
    if (!res.writableEnded) {
      proxyReq.destroy();
    }
  });
  req.pipe(proxyReq);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, distDir: string): void {
  const rawUrl = req.url ?? "/";
  const pathOnly = rawUrl.split("?")[0] ?? "/";
  const decodedPath = decodeURIComponent(pathOnly);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const resolvedDistDir = normalize(distDir);
  const candidatePath = normalize(join(resolvedDistDir, relativePath));

  const withinDistDir =
    candidatePath === resolvedDistDir || candidatePath.startsWith(resolvedDistDir + sep);
  if (!withinDistDir) {
    res.writeHead(403);
    res.end();
    return;
  }

  if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(candidatePath)] ?? "application/octet-stream",
    });
    createReadStream(candidatePath).pipe(res);
    return;
  }

  // SPA fallback: a GET whose last path segment has no "." (so it doesn't look like a
  // missing static asset such as "/app.js" or "/logo.png") is treated as a client-side
  // route (e.g. "/", "/fixtures") and served index.html so App.tsx's own
  // window.location.pathname routing can take over.
  const lastSegment = decodedPath.split("/").pop() ?? "";
  const looksLikeClientRoute = req.method === "GET" && !lastSegment.includes(".");
  if (looksLikeClientRoute) {
    const indexPath = join(resolvedDistDir, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(indexPath).pipe(res);
      return;
    }
  }

  res.writeHead(404);
  res.end();
}

export function startPreviewServer(options: PreviewServerOptions): Promise<RunningPreviewServer> {
  const host = options.host ?? "127.0.0.1";
  const { distDir, daemonBaseUrl, port } = options;

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/minions.")) {
      proxyToDaemon(req, res, daemonBaseUrl);
      return;
    }
    serveStatic(req, res, distDir);
  });

  return new Promise<RunningPreviewServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = address !== null && typeof address === "object" ? address.port : port;
      resolve({
        baseUrl: `http://${host}:${String(actualPort)}`,
        port: actualPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error === undefined) {
                resolveClose();
                return;
              }
              rejectClose(error);
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}
