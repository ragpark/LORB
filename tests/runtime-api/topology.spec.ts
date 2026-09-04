/**
 * The two topologies, from one build.
 *
 * The platform can run as separate services — the browser applications behind their own static
 * origins, the agent connector as its own process — or folded into the API process. Both are
 * reachable from the same image; two flags decide which. What matters here:
 *
 *  - Off is the topology a deployment already has. Nothing is mounted, nothing is served, and no
 *    route the API already had changes. This is the case that must stay true by default, because
 *    every existing deployment relies on it.
 *  - On serves the same bundles, with the environment's configuration written into the page at
 *    request time rather than baked into the bundle, so one image can be promoted between
 *    environments.
 *  - Folding the connector in does not weaken it: the agent token is still required, and the host's
 *    own service routes are not overwritten by the connector's.
 *  - The application policy is scoped. An API route keeps `default-src 'none'`, which is the control
 *    that would otherwise be silently lost by serving pages from an API origin.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import { generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { loadConfig, type RuntimeConfig } from "../../packages/runtime-api/src/config/index.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import {
  injectRuntimeConfig, registerWebApps, resolveWebAppRoot, runtimeConfigScript, webAppContentSecurityPolicy,
  webAppEnvironment, webAppPrefix, webAppRootCandidates, WEB_APPS,
} from "../../packages/runtime-api/src/services/web-apps.js";
import { appBaseUrl } from "../../packages/web-auth/src/app-base.js";
import { mcpConnectorPlugin } from "../../packages/mcp-connector/src/app.js";
import { loadConfig as loadConnectorConfig } from "../../packages/mcp-connector/src/config.js";

const saved = { ...process.env };
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A directory laid out the way the container image lays one out, with a real bundle in each slot. */
function bundleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lorb-web-"));
  temporaryRoots.push(root);
  for (const app of WEB_APPS) {
    const directory = join(root, app.slug);
    mkdirSync(join(directory, "assets"), { recursive: true });
    writeFileSync(join(directory, "index.html"), `<!doctype html><html><head><title>${app.title}</title><script type="module" crossorigin src="./assets/app.js"></script></head><body></body></html>`);
    writeFileSync(join(directory, "assets", "app.js"), `export const app=${JSON.stringify(app.slug)};`);
  }
  return root;
}

function developmentConfig(overrides: Record<string, string> = {}): RuntimeConfig {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: "development",
    PSEUDONYM_TENANT_SECRET: "a".repeat(64),
    RUNTIME_PUBLIC_ISSUER: "https://lorb.example",
    PLAYER_SHELL_ORIGIN: "https://player.lorb.example",
    OIDC_ISSUER: "https://tenant.eu.auth0.com/",
    OIDC_AUDIENCE: "https://lorb.example/api",
    ...overrides,
  });
  return loadConfig();
}

describe("topology flags", () => {
  it("defaults to the separate-service topology, so an existing deployment is unchanged", () => {
    const config = developmentConfig();
    expect(config.topology.serveWebApps).toBe(false);
    expect(config.topology.serveMcpConnector).toBe(false);
    expect(config.topology.webAppsRoot).toBeUndefined();
  });

  it("folds the surfaces in when asked, and carries a configured bundle root", () => {
    const config = developmentConfig({ SERVE_WEB_APPS: "true", SERVE_MCP_CONNECTOR: "1", WEB_APPS_ROOT: "/srv/web" });
    expect(config.topology.serveWebApps).toBe(true);
    expect(config.topology.serveMcpConnector).toBe(true);
    expect(config.topology.webAppsRoot).toBe("/srv/web");
  });

  it("mounts nothing and changes no API route when the flags are off", async () => {
    const config = developmentConfig();
    const ies = await generateKeyPair("ES256");
    const runtime = await buildRuntime({
      config, store: new MemoryRuntimeStore(), catalogue: new MemoryCatalogueStore({ seedExamples: false }),
      iesKey: ies.publicKey, iesIssuer: "https://tenant.eu.auth0.com/",
    });
    for (const path of ["/portal/", "/admin/", "/console/", "/mcp"]) {
      expect((await runtime.app.inject({ method: "GET", url: path })).statusCode, path).toBe(404);
    }
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/runtime/jwks" })).statusCode).toBe(200);
    await runtime.app.close();
  });
});

describe("browser applications served by the API process", () => {
  it("treats a configured root as the only place to look, and otherwise probes both known layouts", () => {
    const [portal] = WEB_APPS;
    // Authoritative: a named root that lacks the bundle is a refusal, never a quiet substitution
    // from somewhere else, which would serve a stale application that looks healthy.
    expect(webAppRootCandidates(portal!, "/srv/web", "/app")).toEqual(["/srv/web/portal"]);
    // Unconfigured, the container layout comes before the workspace one.
    expect(webAppRootCandidates(portal!, undefined, "/app")).toEqual(["/app/web/portal", "/app/packages/learner-portal/dist"]);
  });

  it("resolves only a directory that actually holds a bundle", () => {
    const root = bundleRoot();
    const [portal] = WEB_APPS;
    expect(resolveWebAppRoot(portal!, root)).toBe(join(root, "portal"));
    expect(resolveWebAppRoot(portal!, join(root, "nothing-here"), "/nonexistent")).toBeUndefined();
  });

  it("points the applications at this origin and derives each one's redirect URI from where it is mounted", () => {
    const config = developmentConfig();
    const environments = WEB_APPS.map((app) => [app.slug, webAppEnvironment(app, config)] as const);
    for (const [, environment] of environments) {
      expect(environment.VITE_RUNTIME_API_BASE).toBe("https://lorb.example/api/v1/runtime");
      expect(environment.VITE_ADMIN_API_BASE).toBe("https://lorb.example/api/v1/admin");
      expect(environment.VITE_PLAYER_SHELL_ORIGIN).toBe("https://player.lorb.example");
    }
    // A single forwarded redirect URI would be wrong for two of the three, so it is always derived.
    expect(environments.map(([slug, environment]) => `${slug}:${environment.VITE_OIDC_REDIRECT_URI}`)).toEqual([
      "portal:https://lorb.example/portal/",
      "admin:https://lorb.example/admin/",
      "console:https://lorb.example/console/",
    ]);
  });

  it("forwards VITE_ variables to the browser and nothing else", () => {
    const config = developmentConfig({
      SERVE_WEB_APPS: "true",
      VITE_OIDC_CLIENT_ID: "portal-client",
      VITE_RUNTIME_API_BASE: "https://api.elsewhere.example/api/v1/runtime",
      PSEUDONYM_TENANT_SECRET: "a".repeat(64),
      RUNTIME_INTERNAL_SERVICE_TOKEN: "s".repeat(48),
    });
    const environment = webAppEnvironment(WEB_APPS[0]!, config);
    // Forwarded, because an operator set it deliberately and it carries the public VITE_ prefix.
    expect(environment.VITE_OIDC_CLIENT_ID).toBe("portal-client");
    // An explicit value overrides the same-origin default.
    expect(environment.VITE_RUNTIME_API_BASE).toBe("https://api.elsewhere.example/api/v1/runtime");
    // Credentials do not carry the prefix and must never reach a page.
    const serialised = runtimeConfigScript(environment);
    expect(serialised).not.toContain("PSEUDONYM_TENANT_SECRET");
    expect(serialised).not.toContain("a".repeat(64));
    expect(serialised).not.toContain("s".repeat(48));
    expect(Object.keys(environment).every((name) => name.startsWith("VITE_"))).toBe(true);
  });

  it("puts the configuration script ahead of the bundle, and relative to wherever it is mounted", () => {
    const injected = injectRuntimeConfig('<!doctype html><html><head><title>x</title><script type="module" src="./assets/app.js"></script></head><body></body></html>');
    expect(injected).toContain('<head><script src="./config.js"></script>');
    // A deferred module script runs after the document parses, so a classic script in head wins.
    expect(injected.indexOf("config.js")).toBeLessThan(injected.indexOf("assets/app.js"));
  });

  it("admits the Player Shell origin, which the portal has to embed and call", () => {
    const directives = webAppContentSecurityPolicy(developmentConfig());
    expect(directives.frameSrc).toContain("https://player.lorb.example");
    expect(directives.connectSrc).toContain("https://player.lorb.example");
    expect(directives.connectSrc).toContain("https://lorb.example");
    // The identity provider, or the browser cannot complete a sign-in.
    expect(directives.connectSrc).toContain("https://tenant.eu.auth0.com");
    expect(directives.frameAncestors).toEqual(["'none'"]);
  });

  it("serves each application, its configuration and its assets, and reports a missing bundle", async () => {
    const root = bundleRoot();
    rmSync(join(root, "console"), { recursive: true, force: true });
    const config = developmentConfig({ SERVE_WEB_APPS: "true", WEB_APPS_ROOT: root });
    const app = Fastify({ logger: false });
    await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } });
    const { mounted, missing } = await registerWebApps(app, { config });

    expect(mounted.map((mount) => mount.prefix)).toEqual(["/portal", "/admin"]);
    expect(missing.map((entry) => entry.slug)).toEqual(["console"]);

    // Without the trailing slash the bundle's relative asset URLs would resolve against the origin root.
    const bare = await app.inject({ method: "GET", url: "/portal" });
    expect(bare.statusCode).toBe(308);
    expect(bare.headers.location).toBe("/portal/");

    const index = await app.inject({ method: "GET", url: "/portal/" });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<script src="./config.js"></script>');
    expect(index.headers["cache-control"]).toBe("no-store");
    // The page policy is scoped to the application, and is not the API's `default-src 'none'`.
    expect(String(index.headers["content-security-policy"])).toContain("script-src 'self'");

    const configScript = await app.inject({ method: "GET", url: "/portal/config.js" });
    expect(configScript.statusCode).toBe(200);
    expect(configScript.body).toContain("globalThis.__LORB_ENV__=");
    expect(configScript.headers["cache-control"]).toBe("no-store");

    const asset = await app.inject({ method: "GET", url: "/portal/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('"portal"');

    // Each application gets its own configuration, not the first one's.
    expect((await app.inject({ method: "GET", url: "/admin/config.js" })).body).toContain("/admin/");
    await app.close();
  });
});

describe("navigating back to an application that may be under a prefix", () => {
  // Signing out and restarting an expired session both leave the page and expect to come back. The
  // origin is the same string in both topologies and is only right in one of them.
  it("returns to the application, not to whatever the origin root serves", () => {
    expect(appBaseUrl("https://lorb.example/portal/", "https://lorb.example")).toBe("https://lorb.example/portal/");
    expect(appBaseUrl("https://lorb.example/console/", "https://lorb.example")).toBe("https://lorb.example/console/");
    // A query or fragment is not part of where the application lives.
    expect(appBaseUrl("https://lorb.example/portal/?code=abc#/launch", "https://lorb.example")).toBe("https://lorb.example/portal/");
  });

  it("keeps the bare origin when served at an origin root, which is what providers have registered", () => {
    // An identity provider matches a logout URL by exact string, so the trailing slash matters and a
    // deployment that registered the bare origin has to keep working unchanged.
    expect(appBaseUrl("https://portal.lorb.example/", "https://portal.lorb.example")).toBe("https://portal.lorb.example");
    expect(appBaseUrl("https://portal.lorb.example/index.html", "https://portal.lorb.example")).toBe("https://portal.lorb.example");
  });
});

describe("the agent connector folded into a host application", () => {
  const connectorEnvironment = {
    AUTH_MODE: "shared-token",
    MCP_SHARED_BEARER_TOKEN: "agent-token-for-the-folded-topology-01",
    RUNTIME_INTERNAL_SERVICE_TOKEN: "internal-service-token-for-the-host-01",
    RUNTIME_API_BASE: "http://127.0.0.1:3000",
  };

  async function hostWithConnector() {
    const app = Fastify({ logger: false });
    // The routes a host already serves, which the connector must not take over.
    app.get("/", async () => ({ name: "host" }));
    app.get("/health", async () => ({ status: "ok", from: "host" }));
    await app.register(mcpConnectorPlugin, { config: loadConnectorConfig(connectorEnvironment as NodeJS.ProcessEnv), serviceRoutes: false });
    return app;
  }

  it("leaves the host's own service routes in place", async () => {
    const app = await hostWithConnector();
    expect((await app.inject({ method: "GET", url: "/" })).json()).toEqual({ name: "host" });
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok", from: "host" });
    await app.close();
  });

  it("still requires the agent token, and answers with a usable challenge", async () => {
    const app = await hostWithConnector();
    const refused = await app.inject({ method: "POST", url: "/mcp", payload: {}, headers: { "content-type": "application/json" } });
    expect(refused.statusCode).toBe(401);
    expect(String(refused.headers["www-authenticate"])).toContain("Bearer realm=");
    await app.close();
  });

  it("serves the MCP endpoint at the same path it serves standalone", async () => {
    const app = await hostWithConnector();
    const accepted = await app.inject({
      method: "POST", url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${connectorEnvironment.MCP_SHARED_BEARER_TOKEN}`,
      },
      payload: { jsonrpc: "2.0", id: randomUUID(), method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "topology-suite", version: "1" } } },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toContain("lorb-mcp-connector");
    await app.close();
  });
});
