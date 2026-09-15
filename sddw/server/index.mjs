// Static host for the SDDW single-page app.
// - Listens on PORT (8080 on Cookie), binds 0.0.0.0
// - GET /health   -> 200 "ok" with no dependencies (liveness)
// - GET /ready    -> 200 when the runtime config has been assembled (readiness)
// - GET /app-config.json -> non-secret runtime configuration from environment variables
// - Everything else -> files from dist/, falling back to index.html for client-side routes
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');
const port = Number(process.env.PORT ?? 8080);

const runtimeConfig = {
  storageProvider: process.env.STORAGE_PROVIDER ?? 'mock',
  entraTenantId: process.env.ENTRA_TENANT_ID ?? '',
  entraClientId: process.env.ENTRA_CLIENT_ID ?? '',
  sharePointSiteId: process.env.SHAREPOINT_SITE_ID ?? '',
  sharePointDriveId: process.env.SHAREPOINT_DRIVE_ID ?? '',
  dataverseOrgUrl: process.env.DATAVERSE_ORG_URL ?? '',
  companionBaseUrl: process.env.COMPANION_BASE_URL ?? '',
  companionScope: process.env.COMPANION_SCOPE ?? '',
};
const configBody = JSON.stringify(runtimeConfig);

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, 'ok');
  if (url.pathname === '/ready') return send(res, fs.existsSync(path.join(distDir, 'index.html')) ? 200 : 503, 'ready');
  if (url.pathname === '/app-config.json') return send(res, 200, configBody, mime['.json'], { 'Cache-Control': 'no-store' });

  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(distDir, safePath);
  if (!filePath.startsWith(distDir)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDir, 'index.html');

  const ext = path.extname(filePath);
  const cache = ext && filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, mime[ext] ?? 'application/octet-stream', { 'Cache-Control': cache });
  });
});

server.listen(port, '0.0.0.0', () => console.log(`SDDW listening on :${port}`));
