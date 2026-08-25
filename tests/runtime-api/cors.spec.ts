/**
 * CORS is an allow-list of exact origins, never a wildcard and never a reflection.
 *
 * In production the list is exactly what the operator configured: the service previously carried a
 * few hard-coded hosted origins so that a stale environment variable could not lock the consumer
 * out, which is convenient and is also an origin nobody reviewing the deployment can see.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { loadConfig } from "../../packages/runtime-api/src/config/index.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

const saved = { ...process.env };
const build = () => buildRuntime({ store: new MemoryRuntimeStore(), catalogue: new MemoryCatalogueStore() });

const preflight = (app: Awaited<ReturnType<typeof build>>["app"], origin: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "OPTIONS",
    url: "/api/v1/runtime/repositories",
    headers: { origin, "access-control-request-method": "GET", ...headers },
  });

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("Runtime API CORS", () => {
  it("allows exactly the configured consumer origins", async () => {
    process.env.ALLOWED_CONSUMER_ORIGINS = " https://consumer.example , https://second.example ";
    const { app } = await build();

    const first = await preflight(app, "https://consumer.example", {
      "access-control-request-headers": "authorization,content-type,x-correlation-id",
    });
    const second = await preflight(app, "https://second.example");
    const rejected = await preflight(app, "https://unlisted.example");

    expect(first.statusCode).toBe(204);
    expect(first.headers["access-control-allow-origin"]).toBe("https://consumer.example");
    expect(second.headers["access-control-allow-origin"]).toBe("https://second.example");
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("never answers with a wildcard origin", async () => {
    process.env.ALLOWED_CONSUMER_ORIGINS = "https://consumer.example";
    const { app } = await build();
    const response = await preflight(app, "https://consumer.example");
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
    await app.close();
  });

  it("allows the sandboxed player's opaque origin on player routes only", async () => {
    const { app } = await build();

    // The shell's iframe runs without allow-same-origin, so its own fetches arrive as "null".
    const stateRoute = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/runtime/attempts/00000000-0000-4000-8000-000000000001/state",
      headers: { origin: "null", "access-control-request-method": "PUT" },
    });
    const catalogueRoute = await preflight(app, "null");

    expect(stateRoute.headers["access-control-allow-origin"]).toBe("null");
    expect(catalogueRoute.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("refuses a wildcard, a path or a non-origin in the configured list", async () => {
    for (const value of ["https://*.example.com", "https://consumer.example/app", "consumer.example"]) {
      process.env.ALLOWED_CONSUMER_ORIGINS = value;
      expect(() => loadConfig()).toThrow(/ALLOWED_CONSUMER_ORIGINS/);
    }
  });

  it("requires at least one configured origin in production", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      ALLOWED_CONSUMER_ORIGINS: "",
      DATABASE_URL: "postgres://localhost/lorb",
      PSEUDONYM_TENANT_SECRET: "a".repeat(64),
      DESCRIPTOR_SIGNING_KEYS: "",
      RUNTIME_PUBLIC_ISSUER: "https://runtime.example",
      PLAYER_SHELL_ORIGIN: "https://player.example",
      OIDC_ISSUER: "https://issuer.example/",
    });
    let problems: string[] = [];
    try {
      loadConfig();
    } catch (error) {
      problems = (error as { problems: string[] }).problems;
    }
    expect(problems.join(" ")).toMatch(/ALLOWED_CONSUMER_ORIGINS must list at least one origin in production/);
  });
});
