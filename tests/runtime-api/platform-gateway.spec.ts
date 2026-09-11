/**
 * Running behind an authenticating gateway.
 *
 * Some hosting platforms sign every browser in at a proxy and forward `Authorization: Bearer` on
 * the paths they protect, leaving the API paths to callers with their own credentials. What that
 * needs from this service, and what is checked here:
 *
 *   - a token verifier that can be pointed at such a gateway's provider without hand-holding: a
 *     Keycloak realm's key set lives under the realm rather than the well-known path, and the
 *     audience of the tokens it forwards is the client it registered;
 *   - a platform-administrator marker that can be a group membership, because a gateway's provider
 *     may express everything as groups and nothing as a boolean claim;
 *   - a route on a protected path that hands the forwarded token back to the browser application,
 *     which returns only a token this service would accept anyway, and nothing when there is none;
 *   - a Player Shell that can be served under a path prefix, because a gateway that authenticates
 *     every path but one prefix cannot serve a cookieless sandboxed module from anywhere else.
 */
import { generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { defaultJwksUrl, loadConfig } from "../../packages/runtime-api/src/config/index.js";
import { platformAdminOf } from "../../packages/runtime-api/src/services/identity.js";
import { webAppEnvironment, WEB_APPS } from "../../packages/runtime-api/src/services/web-apps.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

function developmentConfig(overrides: Record<string, string> = {}) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: "development",
    PSEUDONYM_TENANT_SECRET: "a".repeat(64),
    RUNTIME_PUBLIC_ISSUER: "https://shelf.example",
    PLAYER_SHELL_ORIGIN: "https://player.example",
    OIDC_ISSUER: "https://sso.example/realms/tenant",
    ...overrides,
  });
  return loadConfig();
}

const ISSUER = "https://sso.example/realms/tenant";

describe("a gateway's identity provider", () => {
  it("finds a Keycloak realm's key set under the realm, and the well-known path elsewhere", () => {
    expect(defaultJwksUrl("https://sso.example/realms/tenant")).toBe("https://sso.example/realms/tenant/protocol/openid-connect/certs");
    expect(defaultJwksUrl("https://sso.example/realms/tenant/")).toBe("https://sso.example/realms/tenant/protocol/openid-connect/certs");
    expect(defaultJwksUrl("https://tenant.eu.auth0.com/")).toBe("https://tenant.eu.auth0.com/.well-known/jwks.json");
    expect(developmentConfig().identity.jwksUrl).toBe("https://sso.example/realms/tenant/protocol/openid-connect/certs");
    expect(developmentConfig({ OIDC_JWKS_URL: "https://keys.example/jwks" }).identity.jwksUrl).toBe("https://keys.example/jwks");
  });

  it("takes the registered client as the audience when none is named, and never over one that is", () => {
    expect(developmentConfig({ OIDC_CLIENT_ID: "cookie-app-shelf" }).identity.audience).toBe("cookie-app-shelf");
    expect(developmentConfig({ OIDC_CLIENT_ID: "cookie-app-shelf", OIDC_AUDIENCE: "lorb-runtime" }).identity.audience).toBe("lorb-runtime");
  });

  it("reads the platform-administrator marker as a boolean claim or as a group membership", () => {
    expect(platformAdminOf({ platform_admin: true }, "platform_admin")).toBe(true);
    expect(platformAdminOf({ platform_admin: "true" }, "platform_admin")).toBe(false);
    expect(platformAdminOf({ groups: ["cookie-app-shelf", "shelf-platform-admins"] }, "groups=shelf-platform-admins")).toBe(true);
    expect(platformAdminOf({ groups: ["cookie-app-shelf"] }, "groups=shelf-platform-admins")).toBe(false);
    expect(platformAdminOf({ groups: "shelf-platform-admins" }, "groups=shelf-platform-admins")).toBe(true);
    expect(platformAdminOf({}, "groups=shelf-platform-admins")).toBe(false);
  });
});

describe("the session route", () => {
  async function runtime(overrides: Record<string, string> = {}) {
    const config = developmentConfig(overrides);
    const ies = await generateKeyPair("ES256");
    const built = await buildRuntime({
      config, store: new MemoryRuntimeStore(), catalogue: new MemoryCatalogueStore({ seedExamples: false }),
      iesKey: ies.publicKey, iesIssuer: ISSUER,
    });
    return { built, ies };
  }

  it("is absent unless the deployment asks for it", async () => {
    const { built } = await runtime();
    expect((await built.app.inject({ method: "GET", url: "/auth/session" })).statusCode).toBe(404);
    await built.app.close();
  });

  it("hands back the token the gateway forwarded, and only one this service accepts", async () => {
    const { built, ies } = await runtime({ PLATFORM_SESSION_ENDPOINT: "true" });
    const token = await issueIesToken(ies.privateKey, "learner-1", "lorb-runtime", ISSUER);

    const accepted = await built.app.inject({ method: "GET", url: "/auth/session", headers: { authorization: `Bearer ${token}` } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    const body = accepted.json() as { access_token: string; token_type: string; expires_at: string | null; issuer: string };
    expect(body.access_token).toBe(token);
    expect(body.token_type).toBe("Bearer");
    expect(body.issuer).toBe(ISSUER);
    expect(Date.parse(body.expires_at ?? "")).toBeGreaterThan(Date.now());

    // No gateway session: nothing to hand back, and the response says so rather than inventing one.
    expect((await built.app.inject({ method: "GET", url: "/auth/session" })).statusCode).toBe(401);
    // A token for another audience is exactly as unwelcome here as on any API route.
    const other = await issueIesToken(ies.privateKey, "learner-1", "some-other-api", ISSUER);
    expect((await built.app.inject({ method: "GET", url: "/auth/session", headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(401);
    await built.app.close();
  });

  it("tells the browser applications where the route is, only when it exists", () => {
    const off = webAppEnvironment(WEB_APPS[0]!, developmentConfig());
    expect(off.VITE_PLATFORM_SESSION_URL).toBeUndefined();
    const on = webAppEnvironment(WEB_APPS[0]!, developmentConfig({ PLATFORM_SESSION_ENDPOINT: "true" }));
    expect(on.VITE_PLATFORM_SESSION_URL).toBe("https://shelf.example/auth/session");
  });
});

describe("a Player Shell under a path prefix", () => {
  it("keeps the origin for comparisons and uses the prefix for the URLs a launch hands out", async () => {
    const config = developmentConfig({ PLAYER_SHELL_BASE_PATH: "/api/" });
    expect(config.playerOrigin).toBe("https://player.example");
    expect(config.playerBaseUrl).toBe("https://player.example/api");
    expect(config.packageUrl).toBe("https://player.example/api/module/index.html");
    expect(webAppEnvironment(WEB_APPS[0]!, config).VITE_PLAYER_SHELL_ORIGIN).toBe("https://player.example");

    const ies = await generateKeyPair("ES256");
    const catalogue = new MemoryCatalogueStore();
    const built = await buildRuntime({ config, store: new MemoryRuntimeStore(), catalogue, iesKey: ies.publicKey, iesIssuer: ISSUER });
    const [object] = await catalogue.learningObjects();
    const token = await issueIesToken(ies.privateKey, "learner-1", "lorb-runtime", ISSUER);
    const response = await built.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "prefix-1" },
      payload: {
        contract_version: "1.0", consumer_id: "prefix-suite", repository_id: object!.repository_id, object_id: object!.object_id,
        requested_launch_mode: "embedded-iframe", locale: "en-GB",
      },
    });
    expect(response.statusCode).toBe(201);
    const launch = response.json() as { player_url: string; signed_descriptor: string };
    expect(launch.player_url.startsWith("https://player.example/api/#")).toBe(true);
    const descriptor = JSON.parse(Buffer.from(launch.signed_descriptor.split(".")[1]!, "base64url").toString()) as { package_url: string };
    expect(descriptor.package_url.startsWith("https://player.example/api/")).toBe(true);
    await built.app.close();
  });

  it("refuses a prefix that is not a path", () => {
    expect(() => developmentConfig({ PLAYER_SHELL_BASE_PATH: "api" })).toThrow(/PLAYER_SHELL_BASE_PATH/);
    expect(() => developmentConfig({ PLAYER_SHELL_BASE_PATH: "/api?x" })).toThrow(/PLAYER_SHELL_BASE_PATH/);
  });
});
