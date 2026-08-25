/**
 * OIDC resource-server mode.
 *
 * The connector validates tokens issued by an identity provider someone else runs; it issues
 * nothing. These tests stand up a real local provider — an RSA key pair, a JWKS endpoint, and
 * genuinely signed tokens — so the verification path under test is the production one, not a stub.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import type { FastifyInstance } from "fastify";
import { buildMcpConnector, startupBanner } from "../../packages/mcp-connector/src/app.js";
import { loadConfig } from "../../packages/mcp-connector/src/config.js";

const ISSUER = "https://idp.lorb-oidc.test";
const AUDIENCE = "https://mcp.lorb-oidc.test/mcp";
const PUBLIC_URL = "https://mcp.lorb-oidc.test";
const SCOPE = "lorb.teacher";
const SERVICE_TOKEN = "oidc-suite-internal-service-token-000000001";

let signingKey: KeyLike;
let otherKey: KeyLike;
let jwksServer: Server;
let jwksUrl: string;
let connector: FastifyInstance;
let mcpUrl: string;
let metadataUrl: string;

/** Mints a token as the provider would. Overrides let each test bend exactly one thing. */
async function mintToken(overrides: { issuer?: string; audience?: string; scope?: string | null; expiresIn?: string; key?: KeyLike } = {}) {
  return new SignJWT({ ...(overrides.scope === null ? {} : { scope: overrides.scope ?? SCOPE }) })
    .setProtectedHeader({ alg: "RS256", kid: "idp-key-1" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject("teacher-0001")
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "5m")
    .sign(overrides.key ?? signingKey);
}

const post = (token?: string) =>
  fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

beforeAll(async () => {
  const signing = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  signingKey = signing.privateKey;
  otherKey = other.privateKey;

  const jwk = { ...(await exportJWK(signing.publicKey)), kid: "idp-key-1", alg: "RS256", use: "sig" };
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((done) => jwksServer.listen(0, "127.0.0.1", done));
  const jwksPort = (jwksServer.address() as { port: number }).port;
  jwksUrl = `http://127.0.0.1:${jwksPort}/jwks.json`;

  const config = loadConfig({
    AUTH_MODE: "oidc",
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URL: jwksUrl,
    OIDC_REQUIRED_SCOPE: SCOPE,
    MCP_PUBLIC_URL: PUBLIC_URL,
    RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
  } as NodeJS.ProcessEnv);

  connector = buildMcpConnector({ config, fetchImpl: async () => ({ status: 200, text: async () => "{}" }) });
  await connector.listen({ host: "127.0.0.1", port: 0 });
  const port = (connector.server.address() as { port: number }).port;
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
  metadataUrl = `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`;
});

afterAll(async () => {
  await connector?.close();
  await new Promise<void>((done) => jwksServer?.close(() => done()));
});

describe("OIDC resource-server mode", () => {
  it("accepts a token the configured provider issued for this resource", async () => {
    const response = await post(await mintToken());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["assign_quiz", "create_quiz", "list_classes", "whoami"]);
  });

  /**
   * The load-bearing check. Without audience binding, any token the same provider minted for any
   * other service in the tenant would open this one — the confused-deputy problem.
   */
  it("rejects a valid token minted for a different resource", async () => {
    const response = await post(await mintToken({ audience: "https://some-other-service.example/api" }));
    expect(response.status).toBe(401);
  });

  it("rejects a token from a different issuer", async () => {
    const response = await post(await mintToken({ issuer: "https://attacker.example" }));
    expect(response.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const response = await post(await mintToken({ expiresIn: "-1m" }));
    expect(response.status).toBe(401);
  });

  it("rejects a token signed by a key the provider does not publish", async () => {
    const response = await post(await mintToken({ key: otherKey }));
    expect(response.status).toBe(401);
  });

  // Note this passes because no key in a JWKS can satisfy `alg: none`, not because of the algorithm
  // allowlist — verified by mutation: widening ALLOWED_ALGORITHMS does not turn this red. The
  // allowlist is defence in depth; this test covers the unsigned-token path specifically.
  it("rejects an unsigned token, whatever the header claims", async () => {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: "teacher-0001", scope: SCOPE, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString("base64url")}.`;
    expect((await post(unsigned)).status).toBe(401);
  });

  it("returns 403 insufficient_scope for a valid token without the required scope", async () => {
    const response = await post(await mintToken({ scope: "some.other.scope" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("challenges an unauthenticated request with a discoverable metadata pointer", async () => {
    const response = await post();
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    // RFC 9728 §5.1 — this pointer is what lets a client find the authorization server rather than
    // guess. Its absence is why claude.ai's dynamic client registration failed against poc mode.
    expect(challenge).toContain(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain(`scope="${SCOPE}"`);
  });

  // The banner used to be a constant printed before the configuration loaded, so an OIDC
  // deployment announced "PoC bearer authentication only" in its logs. That cost real debugging
  // time against the live Railway service.
  it("announces the mode it is actually running in", () => {
    const banner = startupBanner(loadConfig({
      AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URL: jwksUrl,
      MCP_PUBLIC_URL: PUBLIC_URL, RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
    } as NodeJS.ProcessEnv));
    expect(banner).toContain("OIDC resource-server mode");
    expect(banner).toContain(ISSUER);
    expect(banner).toContain(AUDIENCE);
    expect(banner).not.toContain("PoC pre-shared");
    expect(banner).toContain("DRAFT, uncertified");
  });

  it("publishes RFC 9728 protected resource metadata naming the authorization server", async () => {
    const response = await fetch(metadataUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: AUDIENCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
    });
  });

  /**
   * RFC 9728 §3.1 inserts the well-known path between host and resource path. A client that
   * constructs the URL rather than following the challenge pointer looks here, and only here.
   */
  it("serves the same document at the path-inserted location", async () => {
    const response = await fetch(`${metadataUrl}/mcp`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await (await fetch(metadataUrl)).json());
  });
});

describe("OIDC configuration is fail-closed", () => {
  const base = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, MCP_PUBLIC_URL: PUBLIC_URL, RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN };

  it("requires an explicit audience, so it can never be forgotten", () => {
    expect(() => loadConfig({ ...base, OIDC_AUDIENCE: undefined } as NodeJS.ProcessEnv)).toThrow(/OIDC_AUDIENCE/);
  });

  it("requires an issuer and a public URL", () => {
    expect(() => loadConfig({ ...base, OIDC_ISSUER: undefined } as NodeJS.ProcessEnv)).toThrow(/OIDC_ISSUER/);
    expect(() => loadConfig({ ...base, MCP_PUBLIC_URL: undefined } as NodeJS.ProcessEnv)).toThrow(/MCP_PUBLIC_URL/);
  });

  it("refuses a plaintext issuer", () => {
    expect(() => loadConfig({ ...base, OIDC_ISSUER: "http://idp.example" } as NodeJS.ProcessEnv)).toThrow(/https/);
  });

  // Leaving the pre-shared token configured alongside a provider would keep a second, weaker way in.
  it("refuses to run with the PoC token still set", () => {
    expect(() => loadConfig({ ...base, MCP_POC_BEARER_TOKEN: "a".repeat(40) } as NodeJS.ProcessEnv)).toThrow(/must not be set/);
  });

  it("still rejects an unknown mode", () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: "open" } as NodeJS.ProcessEnv)).toThrow(/AUTH_MODE/);
  });
});

/**
 * The new mode must not leak into the old one. A `poc` deployment has no authorization server to
 * point at, so advertising RFC 9728 metadata there would send a client chasing a discovery
 * document that describes nothing real.
 */
describe("poc mode is unaffected", () => {
  const POC_TOKEN = "poc-mode-unaffected-bearer-token-0000000001";
  let pocConnector: FastifyInstance;
  let pocBase: string;

  beforeAll(async () => {
    const config = loadConfig({
      MCP_POC_BEARER_TOKEN: POC_TOKEN,
      RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
    } as NodeJS.ProcessEnv);
    pocConnector = buildMcpConnector({ config, fetchImpl: async () => ({ status: 200, text: async () => "{}" }) });
    await pocConnector.listen({ host: "127.0.0.1", port: 0 });
    pocBase = `http://127.0.0.1:${(pocConnector.server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await pocConnector?.close();
  });

  it("still accepts the pre-shared token", async () => {
    const response = await fetch(`${pocBase}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${POC_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
  });

  it("announces the pre-shared credential, not an identity provider", () => {
    const banner = startupBanner(loadConfig({ MCP_POC_BEARER_TOKEN: POC_TOKEN, RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN } as NodeJS.ProcessEnv));
    expect(banner).toContain("PoC pre-shared bearer authentication");
    expect(banner).not.toContain("OIDC");
    // Never print the credential itself.
    expect(banner).not.toContain(POC_TOKEN);
  });

  it("does not serve protected resource metadata", async () => {
    expect((await fetch(`${pocBase}/.well-known/oauth-protected-resource`)).status).toBe(404);
  });

  it("challenges without pointing at an authorization server it does not have", async () => {
    const response = await fetch(`${pocBase}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).not.toContain("resource_metadata");
  });
});

/**
 * Auth0 shapes. These are not hypothetical: an Auth0 tenant's `iss` claim carries a trailing
 * slash, and jose compares the claim byte for byte. Normalising the issuer at config time — the
 * obvious thing to do to a URL — silently rejects every token the tenant issues, and the symptom
 * is a 401 *after* a successful login, which is a miserable thing to debug.
 */
describe("an Auth0-shaped issuer", () => {
  const TENANT = "https://lorb-tenant.eu.auth0.com/";
  const API_ID = "https://mcp.lorb-oidc.test/mcp";
  let auth0Connector: FastifyInstance;
  let auth0Url: string;

  beforeAll(async () => {
    const config = loadConfig({
      AUTH_MODE: "oidc",
      OIDC_ISSUER: TENANT,
      OIDC_AUDIENCE: API_ID,
      OIDC_JWKS_URL: jwksUrl,
      OIDC_REQUIRED_SCOPE: SCOPE,
      MCP_PUBLIC_URL: PUBLIC_URL,
      RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
    } as NodeJS.ProcessEnv);
    auth0Connector = buildMcpConnector({ config, fetchImpl: async () => ({ status: 200, text: async () => "{}" }) });
    await auth0Connector.listen({ host: "127.0.0.1", port: 0 });
    auth0Url = `http://127.0.0.1:${(auth0Connector.server.address() as { port: number }).port}/mcp`;
  });

  afterAll(async () => {
    await auth0Connector?.close();
  });

  it("accepts a token whose iss carries the trailing slash Auth0 mints", async () => {
    const token = await mintToken({ issuer: TENANT, audience: API_ID });
    const response = await fetch(auth0Url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
  });

  it("still rejects the same token with the slash stripped from iss", async () => {
    const token = await mintToken({ issuer: "https://lorb-tenant.eu.auth0.com", audience: API_ID });
    const response = await fetch(auth0Url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("derives the JWKS URL without doubling the slash", () => {
    const config = loadConfig({
      AUTH_MODE: "oidc",
      OIDC_ISSUER: TENANT,
      OIDC_AUDIENCE: API_ID,
      MCP_PUBLIC_URL: PUBLIC_URL,
      RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
    } as NodeJS.ProcessEnv);
    expect(config.oidc?.issuer).toBe(TENANT);
    expect(config.oidc?.jwksUrl).toBe("https://lorb-tenant.eu.auth0.com/.well-known/jwks.json");
  });

  // Auth0 puts scopes in a space-delimited `scope` string, not an array.
  it("reads a space-delimited scope claim", async () => {
    const token = await mintToken({ issuer: TENANT, audience: API_ID, scope: `openid profile ${SCOPE}` });
    const response = await fetch(auth0Url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
  });
});
