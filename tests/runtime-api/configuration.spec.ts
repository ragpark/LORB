/**
 * Production configuration fails closed.
 *
 * Each case here is a way the service could previously have started in a shape that looked healthy
 * and was not: in-memory state as a system of record, a signing key nobody else holds, the synthetic
 * identity simulator, example content in a real catalogue, an unauthenticated learning record store.
 * Configuration refuses all of them rather than logging a warning nobody reads.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "../../packages/runtime-api/src/config/index.js";

const saved = { ...process.env };

/** A minimally valid production environment, which each case then breaks in exactly one way. */
const productionEnv = () => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgres://user:pass@db.internal:5432/lorb",
  PSEUDONYM_TENANT_SECRET: "a".repeat(64),
  DESCRIPTOR_PRIVATE_KEY_PEM: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  DESCRIPTOR_KID: "lorb-descriptor-2026-01-01",
  RUNTIME_PUBLIC_ISSUER: "https://runtime.lorb.example",
  PLAYER_SHELL_ORIGIN: "https://player.lorb.example",
  ALLOWED_CONSUMER_ORIGINS: "https://consumer.lorb.example",
  OIDC_ISSUER: "https://tenant.eu.auth0.com/",
  OIDC_AUDIENCE: "https://runtime.lorb.example/api",
  LRS_ENDPOINT: "https://lrs.example/xapi",
  LRS_BEARER_TOKEN: "lrs-token",
  RUNTIME_INTERNAL_SERVICE_TOKEN: "s".repeat(48),
  SEED_EXAMPLE_CONTENT: "false",
  ALLOW_SYNTHETIC_IDENTITY: "false",
});

function withEnv(overrides: Record<string, string>): { config?: ReturnType<typeof loadConfig>; problems: string[] } {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, productionEnv(), overrides);
  try {
    return { config: loadConfig(), problems: [] };
  } catch (error) {
    if (error instanceof ConfigurationError) return { problems: error.problems };
    throw error;
  }
}

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("production configuration", () => {
  it("accepts a complete production environment", () => {
    const { config, problems } = withEnv({});
    expect(problems).toEqual([]);
    expect(config!.production).toBe(true);
    expect(config!.persistence).toBe("postgres");
    expect(config!.signingKeys).toHaveLength(1);
    expect(config!.rateLimit.enabled).toBe(true);
    expect(config!.trustProxy).toBe(true);
  });

  it("refuses to run without a database", () => {
    expect(withEnv({ DATABASE_URL: "" }).problems.join(" ")).toMatch(/in-memory state is not a system of record/);
  });

  it("refuses an ephemeral signing key", () => {
    expect(withEnv({ DESCRIPTOR_PRIVATE_KEY_PEM: "", DESCRIPTOR_KID: "" }).problems.join(" "))
      .toMatch(/descriptor signing key is required in production/);
  });

  it("refuses a pseudonym secret that is missing or the wrong length", () => {
    expect(withEnv({ PSEUDONYM_TENANT_SECRET: "" }).problems.join(" ")).toMatch(/required in production/);
    expect(withEnv({ PSEUDONYM_TENANT_SECRET: "abc" }).problems.join(" ")).toMatch(/exactly 32 bytes/);
  });

  it("refuses the synthetic identity simulator", () => {
    expect(withEnv({ ALLOW_SYNTHETIC_IDENTITY: "true" }).problems.join(" "))
      .toMatch(/ALLOW_SYNTHETIC_IDENTITY must not be enabled in production/);
  });

  it("refuses example content in a production catalogue", () => {
    expect(withEnv({ SEED_EXAMPLE_CONTENT: "true" }).problems.join(" "))
      .toMatch(/SEED_EXAMPLE_CONTENT must not be enabled in production/);
  });

  it("requires https for every public origin and for the identity provider", () => {
    expect(withEnv({ RUNTIME_PUBLIC_ISSUER: "http://runtime.lorb.example" }).problems.join(" ")).toMatch(/https origin/);
    expect(withEnv({ PLAYER_SHELL_ORIGIN: "http://player.lorb.example" }).problems.join(" ")).toMatch(/https origin/);
    expect(withEnv({ OIDC_ISSUER: "http://tenant.example" }).problems.join(" ")).toMatch(/OIDC_ISSUER must be an https URL/);
  });

  it("requires credentials for the learning record store", () => {
    expect(withEnv({ LRS_BEARER_TOKEN: "" }).problems.join(" "))
      .toMatch(/learning record store requires credentials in production/);
    expect(withEnv({ LRS_BEARER_TOKEN: "", LRS_BASIC_USERNAME: "only-a-username" }).problems.join(" "))
      .toMatch(/must be set together/);
  });

  it("requires an internal service credential of a usable length", () => {
    expect(withEnv({ RUNTIME_INTERNAL_SERVICE_TOKEN: "" }).problems.join(" ")).toMatch(/required in production/);
    expect(withEnv({ RUNTIME_INTERNAL_SERVICE_TOKEN: "short" }).problems.join(" ")).toMatch(/at least 32 characters/);
  });

  it("refuses an unsupported signature algorithm", () => {
    expect(withEnv({ OIDC_ALGORITHMS: "none" }).problems.join(" ")).toMatch(/unsupported algorithm/);
  });

  it("does not normalise the issuer, because providers differ on the trailing slash", () => {
    // Auth0's discovery document reports a trailing slash and the claim is compared byte for byte;
    // trimming it here would reject every valid token.
    expect(withEnv({}).config!.identity.issuer).toBe("https://tenant.eu.auth0.com/");
  });

  it("accepts a rotation ring with exactly one active key", () => {
    const key = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const ring = JSON.stringify([
      { kid: "new", pem: key(), state: "ACTIVE" },
      { kid: "old", pem: key(), state: "RETIRING" },
    ]);
    expect(withEnv({ DESCRIPTOR_SIGNING_KEYS: ring }).config!.signingKeys).toHaveLength(2);

    const twoActive = JSON.stringify([
      { kid: "a", pem: key(), state: "ACTIVE" },
      { kid: "b", pem: key(), state: "ACTIVE" },
    ]);
    expect(withEnv({ DESCRIPTOR_SIGNING_KEYS: twoActive }).problems.join(" ")).toMatch(/exactly one ACTIVE key/);
  });

  it("reports every problem at once rather than one restart at a time", () => {
    const { problems } = withEnv({ DATABASE_URL: "", PSEUDONYM_TENANT_SECRET: "", ALLOWED_CONSUMER_ORIGINS: "" });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps development conveniences outside production", () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.NODE_ENV = "development";
    const config = loadConfig();
    expect(config.production).toBe(false);
    expect(config.persistence).toBe("memory");
    expect(config.signingKeys).toEqual([]);
    expect(config.allowedConsumerOrigins).toContain("http://localhost:3300");
    expect(config.rateLimit.enabled).toBe(false);
  });
});
