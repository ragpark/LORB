/**
 * LTI 1.3 tool registration and launch — Resource Link launch only, no Assignment & Grades Services,
 * no Deep Linking, per-object registration (no separate platform/tool registry).
 *
 * An lti-tool is the one learning-object kind that ever points at a URL outside the Player Shell's
 * own origin. What matters here is that it never becomes an unreviewed iframe embed of that origin:
 * the launch descriptor carries a `content_profile` claim so the shell recognises the kind, the shell
 * mints a short-lived, minimal-claim login-hint token rather than handing over the launch descriptor
 * itself, and `/api/v1/lti/authorize` only ever hands a signed id_token to the exact `target_link_uri`
 * an admin registered — never wherever a `redirect_uri` query parameter happens to point.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair, createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { signLtiLoginHint } from "../../packages/runtime-api/src/core.js";
import { ltiToolDraftSchema } from "../../packages/contracts/src/index.js";

const ISSUER = "https://identity.lti-tools.test";

async function setup() {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const store = new MemoryRuntimeStore();
  const catalogue = new MemoryCatalogueStore({ seedExamples: false });
  const runtime = await buildRuntime({
    iesKey: keys.publicKey, iesIssuer: ISSUER, playerOrigin: `https://player.lti-tools-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 11), store, catalogue,
  });
  const adminToken = await issueIesToken(keys.privateKey, "lti-admin", "lorb-runtime", ISSUER, { role: "admin" });
  const learnerToken = await issueIesToken(keys.privateKey, "lti-learner", "lorb-runtime", ISSUER, {});
  const repository = (await catalogue.defaultRepository())!;

  const call = (method: "GET" | "POST", url: string, payload?: unknown, as = adminToken) =>
    runtime.app.inject({
      method, url,
      headers: { authorization: `Bearer ${as}`, ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  return { runtime, store, catalogue, call, adminToken, learnerToken, repositoryId: repository.repository_id };
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  title: "Acme Interactive Quiz",
  description: "A third-party interactive quiz tool.",
  tool_name: "Acme Quiz",
  oidc_login_url: "https://acme.example.com/lti/login",
  target_link_uri: "https://acme.example.com/lti/launch",
  ...overrides,
});

describe("LTI tool draft contract", () => {
  it("refuses a non-https login or target URL", () => {
    expect(ltiToolDraftSchema.safeParse(draft({ oidc_login_url: "http://acme.example.com/lti/login" })).success).toBe(false);
    expect(ltiToolDraftSchema.safeParse(draft({ target_link_uri: "http://acme.example.com/lti/launch" })).success).toBe(false);
  });
  it("accepts a well-formed draft", () => {
    expect(ltiToolDraftSchema.safeParse(draft()).success).toBe(true);
  });
});

describe("LTI tool registration", () => {
  it("registers a tool, minting client_id and deployment_id, and lists it as PUBLISHED", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/lti-tools", { repository_id: repositoryId, ...draft() });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.client_id).toBeTruthy();
    expect(body.deployment_id).toBeTruthy();

    const preview = await call("GET", `/api/v1/admin/learning-objects/${body.object_id}/preview`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().kind).toBe("lti-tool");
    expect(preview.json().tool_name).toBe("Acme Quiz");
    expect(preview.json().target_link_uri).toBe("https://acme.example.com/lti/launch");
  });

  it("refuses registration from a non-admin caller", async () => {
    const { call, repositoryId, learnerToken } = await setup();
    const response = await call("POST", "/api/v1/publisher/learning-objects/lti-tools", { repository_id: repositoryId, ...draft() }, learnerToken);
    expect(response.statusCode).toBe(403);
  });

  it("never touches the native-web-package module_path invariant", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/lti-tools", { repository_id: repositoryId, ...draft() });
    // The registered object's module_path still resolves under the Player Shell's own origin — an
    // lti-tool never gets an absolute URL for module_path; that stays the shell-driven descriptor claim.
    expect(created.json()).not.toHaveProperty("module_path");
  });
});

describe("LTI tool launch and authorize", () => {
  const registerAndLaunch = async () => {
    const h = await setup();
    const created = await h.call("POST", "/api/v1/publisher/learning-objects/lti-tools", { repository_id: h.repositoryId, ...draft() });
    expect(created.statusCode).toBe(201);
    const { object_id: objectId, client_id: clientId, deployment_id: deploymentId } = created.json();

    const launch = await h.runtime.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${h.learnerToken}`, "idempotency-key": randomUUID() },
      payload: {
        contract_version: "1.0", consumer_id: "lti-tools-suite",
        repository_id: h.repositoryId, object_id: objectId,
        requested_launch_mode: "embedded-iframe", locale: "en-GB",
      },
    });
    expect(launch.statusCode).toBe(201);
    const playerUrl = new URL(launch.json().player_url);
    const hashParams = new URLSearchParams(playerUrl.hash.slice(1));
    const loginHint = hashParams.get("lti_login_hint");
    expect(loginHint).toBeTruthy();
    return { ...h, objectId, clientId, deploymentId, loginHint: loginHint! };
  };

  const authorize = (h: Awaited<ReturnType<typeof registerAndLaunch>>, overrides: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams({
      scope: "openid", response_type: "id_token", response_mode: "form_post",
      client_id: h.clientId, lti_deployment_id: h.deploymentId,
      redirect_uri: "https://acme.example.com/lti/launch",
      login_hint: h.loginHint, nonce: randomUUID(), state: randomUUID(),
      ...overrides,
    });
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) params.delete(key);
    return h.runtime.app.inject({ method: "GET", url: `/api/v1/lti/authorize?${params.toString()}` });
  };

  it("mints an id_token that verifies against the published JWKS, carrying a Resource Link launch", async () => {
    const h = await registerAndLaunch();
    const nonce = randomUUID();
    const response = await authorize(h, { nonce });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(`action="https://acme.example.com/lti/launch"`);

    const idToken = response.body.match(/name="id_token" value="([^"]+)"/)?.[1];
    expect(idToken).toBeTruthy();

    const jwks = await h.runtime.app.inject({ method: "GET", url: "/api/v1/lti/jwks" });
    expect(jwks.statusCode).toBe(200);
    const keySet = createLocalJWKSet(jwks.json());
    const { payload } = await jwtVerify(idToken!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"), keySet, {
      issuer: h.runtime.config.publicIssuer, audience: h.clientId,
    });
    expect(payload.nonce).toBe(nonce);
    expect(payload["https://purl.imsglobal.org/spec/lti/claim/message_type"]).toBe("LtiResourceLinkRequest");
    expect(payload["https://purl.imsglobal.org/spec/lti/claim/version"]).toBe("1.3.0");
    expect(payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"]).toBe(h.deploymentId);
    expect(payload["https://purl.imsglobal.org/spec/lti/claim/target_link_uri"]).toBe("https://acme.example.com/lti/launch");
  });

  it("refuses a redirect_uri that does not match the registered target_link_uri", async () => {
    const h = await registerAndLaunch();
    const response = await authorize(h, { redirect_uri: "https://attacker.example.com/steal" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });

  it("refuses an unknown client_id", async () => {
    const h = await registerAndLaunch();
    const response = await authorize(h, { client_id: `lorb-${randomUUID()}` });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a tampered or expired login_hint", async () => {
    const h = await registerAndLaunch();
    const response = await authorize(h, { login_hint: `${h.loginHint}tampered` });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a login_hint minted for a different object", async () => {
    const h = await registerAndLaunch();
    const foreignHint = await signLtiLoginHint(h.runtime.ltiRing, { sub: "someone", object_id: randomUUID(), attempt_id: randomUUID() }, h.runtime.config.publicIssuer);
    const response = await authorize(h, { login_hint: foreignHint });
    expect(response.statusCode).toBe(401);
  });

  it("refuses anything but response_mode=form_post", async () => {
    const h = await registerAndLaunch();
    const response = await authorize(h, { response_mode: "fragment" });
    expect(response.statusCode).toBe(400);
  });
});
