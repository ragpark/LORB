/**
 * Test-only harness for the player browser suite.
 *
 * Runs the Runtime API (with the Evidence routes mounted on it, exactly as `src/server.ts` does) on a
 * real port, and serves the Player Shell origin as static files assembled the same way
 * `Dockerfile.player-shell` assembles them. The browser then drives a genuine launch.
 *
 * No synthetic IES server is needed: the browser never talks to one. The Runtime verifies access
 * tokens in-process, so the suite generates the key pair itself and signs tokens with the stub issuer.
 */
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { generateKeyPair, type KeyLike } from "jose";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { registerEvidenceRoutes } from "../../packages/evidence-api/src/app.js";

export const RUNTIME_PORT = 3010;
export const PLAYER_PORT = 3210;
export const RUNTIME_ORIGIN = `http://localhost:${RUNTIME_PORT}`;
export const PLAYER_ORIGIN = `http://localhost:${PLAYER_PORT}`;
export const IES_ISSUER = "http://localhost:4010";
export const INTERNAL_SERVICE_TOKEN = "browser-suite-internal-service-token-0001";
export const REPOSITORY_ID = "b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d";

const ROOT = resolve(import.meta.dirname, "../..");
const BUNDLES = [
  { from: "packages/player-shell/dist", to: "." },
  { from: "packages/example-module/src", to: "module" },
  { from: "packages/quiz-player/dist", to: "modules/quiz-player" },
] as const;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface Harness {
  runtime: Awaited<ReturnType<typeof buildRuntime>>;
  iesPrivateKey: KeyLike;
  /** Absolute path of the assembled static root, so a test can add its own fixture pages. */
  playerRoot: string;
  stop(): Promise<void>;
}

/** Assembles the Player Shell origin from built bundles, mirroring Dockerfile.player-shell. */
async function assemblePlayerRoot(): Promise<string> {
  const missing = BUNDLES.filter((bundle) => !existsSync(join(ROOT, bundle.from))).map((bundle) => bundle.from);
  if (missing.length > 0) {
    throw new Error(
      `Player bundles are not built: ${missing.join(", ")}. ` +
        "Run `pnpm --filter player-shell build && pnpm --filter quiz-player build` first.",
    );
  }
  const root = await mkdtemp(join(tmpdir(), "lorb-player-"));
  for (const bundle of BUNDLES) await cp(join(ROOT, bundle.from), join(root, bundle.to), { recursive: true });
  return root;
}

function staticServer(root: string): Server {
  return createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0]!.split("#")[0]!;
    // Contain path traversal: a resolved path must stay inside the served root.
    const target = resolve(root, `.${normalize(path === "/" ? "/index.html" : path)}`);
    const file = target.startsWith(root) && existsSync(target) && !target.endsWith("/") ? target : join(root, "index.html");
    const extension = file.slice(file.lastIndexOf("."));
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      // Mirrors the `add_header Access-Control-Allow-Origin "*"` in Dockerfile.player-shell, and it is
      // load-bearing rather than lazy: Vite emits `<script type="module" crossorigin>`, and a module
      // sandboxed without allow-same-origin fetches it from an opaque origin, so without this header
      // the browser blocks the bundle and the module renders nothing at all.
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  });
}

export async function startHarness(): Promise<Harness> {
  const playerRoot = await assemblePlayerRoot();
  const ies = await generateKeyPair("ES256");
  const runtime = await buildRuntime({
    iesKey: ies.publicKey,
    iesIssuer: IES_ISSUER,
    secret: Buffer.alloc(32, 11),
    publicIssuer: RUNTIME_ORIGIN,
    playerOrigin: PLAYER_ORIGIN,
    evidenceEndpoint: `${RUNTIME_ORIGIN}/api/v1/evidence/statements`,
    internalServiceToken: INTERNAL_SERVICE_TOKEN,
  });
  registerEvidenceRoutes(runtime.app, runtime.keys.privateKey, RUNTIME_ORIGIN);
  await runtime.app.listen({ host: "127.0.0.1", port: RUNTIME_PORT });

  const player = staticServer(playerRoot);
  await new Promise<void>((done) => player.listen(PLAYER_PORT, "127.0.0.1", done));

  return {
    runtime,
    iesPrivateKey: ies.privateKey,
    playerRoot,
    async stop() {
      await new Promise<void>((done) => player.close(() => done()));
      await runtime.app.close();
      await rm(playerRoot, { recursive: true, force: true });
    },
  };
}

/** Writes a fixture page into the served root. Test-only; nothing here ships. */
export async function addFixturePage(harness: Harness, path: string, html: string): Promise<void> {
  await writeFile(join(harness.playerRoot, path), html, "utf8");
}
