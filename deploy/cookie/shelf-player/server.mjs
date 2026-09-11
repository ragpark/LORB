/**
 * Static server for the Player Shell and its bundled content packages.
 *
 * What the nginx image did, in Node, because the hosting platform has no approved nginx base:
 *
 *   - everything under `PLAYER_BASE_PATH` (default `/api`) maps onto the `www` directory, so the
 *     shell is at /api/ and a module at /api/modules/<name>/;
 *   - `Access-Control-Allow-Origin: *` on every file. Load-bearing: a module runs in an iframe
 *     sandboxed without allow-same-origin, so it fetches its own module-script bundle from an opaque
 *     origin, and only the wildcard lets that load. This origin serves static files and nothing
 *     else, which is why the wildcard is acceptable here and nowhere else;
 *   - entry documents are never cached, hashed assets are cached for a year;
 *   - GET /health for the platform's probe, dependency-free.
 *
 * No directory listings, no path escapes, no methods other than GET and HEAD.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const ROOT = resolve(process.env.PLAYER_WWW_ROOT ?? "www");
const BASE = (process.env.PLAYER_BASE_PATH ?? "/api").replace(/\/+$/, "");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const HASHED = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

function headers(file) {
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  return {
    "content-type": type,
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // An entry document that stays cached keeps yesterday's bundle; the hashed assets it names are
    // immutable by construction and may be kept for as long as the browser likes.
    "cache-control": HASHED.test(file) ? "public, max-age=31536000, immutable" : "no-store",
  };
}

async function resolveFile(urlPath) {
  // A malformed escape such as /api/% throws here. On a public, unauthenticated path that has to be
  // a 404, never an unhandled rejection that takes the whole server down.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidate = join(ROOT, relative);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return undefined;
  let target = candidate;
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      // A directory is served by its index only when the URL says so; otherwise the browser would
      // resolve the bundle's relative asset URLs against the parent and load nothing.
      if (!urlPath.endsWith("/")) return { redirect: `${urlPath}/` };
      target = join(target, "index.html");
      await stat(target);
    }
  } catch {
    return undefined;
  }
  return { file: target };
}

async function handle(req, res) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end('{"status":"ok"}');
    return;
  }
  if (url.pathname === "/" || url.pathname === BASE) {
    res.writeHead(308, { location: `${BASE}/` }).end();
    return;
  }
  if (!url.pathname.startsWith(`${BASE}/`)) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"NOT_FOUND"}');
    return;
  }
  const found = await resolveFile(url.pathname.slice(BASE.length));
  if (!found) {
    res.writeHead(404, { "content-type": "application/json", "access-control-allow-origin": "*" }).end('{"error":"NOT_FOUND"}');
    return;
  }
  if (found.redirect) {
    res.writeHead(308, { location: `${BASE}${found.redirect}${url.search}` }).end();
    return;
  }
  const info = await stat(found.file);
  res.writeHead(200, { ...headers(found.file), "content-length": info.size });
  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(found.file).on("error", () => res.destroy()).pipe(res);
}

// Nothing a request can contain may end the process: an async handler that rejects would otherwise
// surface as an unhandled rejection, and Node exits on those.
const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"INTERNAL"}');
  });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(JSON.stringify({ service: "lorb-player-shell", msg: `serving ${ROOT} under ${BASE}/ on ${PORT}` }) + "\n");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
