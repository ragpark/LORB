/**
 * Configuration for the learning record store.
 *
 * Fail-closed, like the rest of the platform: a production process names everything it is missing at
 * once and exits, rather than starting in a shape nobody would accept. The two settings that matter
 * are the database and the credentials — an LRS with neither is a service that accepts a learner's
 * record and loses it, or accepts it from anybody.
 */
import { readFileSync } from "node:fs";

export type LrsEnvironment = "production" | "staging" | "development" | "test";

export interface BasicCredential {
  kind: "basic";
  username: string;
  password: string;
}
export interface BearerCredential {
  kind: "bearer";
  token: string;
}
export type LrsCredential = BasicCredential | BearerCredential;

export interface LrsServiceConfig {
  environment: LrsEnvironment;
  production: boolean;
  port: number;
  databaseUrl?: string;
  credentials: LrsCredential[];
  /** Default and ceiling for `limit` on a statement query. */
  defaultLimit: number;
  maxLimit: number;
  /**
   * Whether to refuse a statement whose actor identifies a person directly.
   *
   * LORB's evidence is pseudonymous by construction, and a store that quietly accepted an `mbox` or
   * a display name would be the one place the whole chain leaks. On by default; a deployment that
   * genuinely receives identified statements from elsewhere can turn it off deliberately.
   */
  requirePseudonymousActor: boolean;
  xapiVersion: string;
  metricsEnabled: boolean;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function int(name: string, fallback: number, problems: string[], min: number, max: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

/**
 * Reads the credentials this store accepts.
 *
 * Deliberately a list rather than one pair: rotating the token a forwarder uses means both the old
 * and the new one have to be accepted for the length of the rollout, and a store that accepts
 * exactly one credential turns that into an outage.
 */
export function readCredentials(problems: string[]): LrsCredential[] {
  const credentials: LrsCredential[] = [];
  for (const token of (env("LRS_ACCEPTED_BEARER_TOKENS") ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    if (token.length < 16) {
      problems.push("every entry in LRS_ACCEPTED_BEARER_TOKENS must be at least 16 characters");
      continue;
    }
    credentials.push({ kind: "bearer", token });
  }
  for (const pair of (env("LRS_ACCEPTED_BASIC_CREDENTIALS") ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = pair.indexOf(":");
    if (separator <= 0 || separator === pair.length - 1) {
      problems.push("every entry in LRS_ACCEPTED_BASIC_CREDENTIALS must be username:password");
      continue;
    }
    credentials.push({ kind: "basic", username: pair.slice(0, separator), password: pair.slice(separator + 1) });
  }
  return credentials;
}

function readEnvironment(problems: string[]): LrsEnvironment {
  const raw = env("NODE_ENV") ?? "development";
  if (raw === "production" || raw === "staging" || raw === "development" || raw === "test") return raw;
  problems.push("NODE_ENV must be production, staging, development or test");
  return "development";
}

export function loadLrsConfig(overrides: Partial<LrsServiceConfig> = {}): LrsServiceConfig {
  const problems: string[] = [];
  const environment = readEnvironment(problems);
  const production = environment === "production" || environment === "staging";

  // Its own database URL first: the store of record for evidence should be able to live somewhere
  // other than the runtime's database without a rewrite, even where a small deployment shares one.
  const databaseUrl = env("LRS_DATABASE_URL") ?? env("DATABASE_URL");
  if (!databaseUrl && production) {
    problems.push("LRS_DATABASE_URL (or DATABASE_URL) is required in production: in-memory statements are not a record");
  }

  const credentials = readCredentials(problems);
  if (credentials.length === 0 && production) {
    problems.push("at least one credential is required in production (LRS_ACCEPTED_BEARER_TOKENS or LRS_ACCEPTED_BASIC_CREDENTIALS)");
  }

  const maxLimit = int("LRS_MAX_LIMIT", 1000, problems, 1, 10000);
  const defaultLimit = int("LRS_DEFAULT_LIMIT", 100, problems, 1, maxLimit);

  const config: LrsServiceConfig = {
    environment,
    production,
    port: int("PORT", int("LRS_PORT", 5000, problems, 1, 65535), problems, 1, 65535),
    databaseUrl,
    credentials,
    defaultLimit,
    maxLimit,
    requirePseudonymousActor: bool("LRS_REQUIRE_PSEUDONYMOUS_ACTOR", true),
    xapiVersion: env("LRS_XAPI_VERSION") ?? "1.0.3",
    metricsEnabled: bool("METRICS_ENABLED", true),
    ...overrides,
  };

  if (problems.length > 0 && overrides.credentials === undefined) {
    const detail = JSON.stringify(problems);
    if (production) {
      process.stderr.write(`refusing to start: invalid configuration ${detail}\n`);
      throw new Error(`LRS configuration is invalid: ${detail}`);
    }
    process.stderr.write(`configuration warnings ${detail}\n`);
  }
  return config;
}

/** Reads a credential file, so a deployment can mount secrets rather than pass them in the environment. */
export function credentialsFromFile(path: string): LrsCredential[] {
  const problems: string[] = [];
  const previous = { bearer: process.env.LRS_ACCEPTED_BEARER_TOKENS, basic: process.env.LRS_ACCEPTED_BASIC_CREDENTIALS };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { bearer?: string[]; basic?: string[] };
    process.env.LRS_ACCEPTED_BEARER_TOKENS = (parsed.bearer ?? []).join(",");
    process.env.LRS_ACCEPTED_BASIC_CREDENTIALS = (parsed.basic ?? []).join(",");
    return readCredentials(problems);
  } finally {
    process.env.LRS_ACCEPTED_BEARER_TOKENS = previous.bearer;
    process.env.LRS_ACCEPTED_BASIC_CREDENTIALS = previous.basic;
  }
}
