/**
 * Central runtime configuration.
 *
 * Every setting the platform needs is read once, here, and validated before anything starts. The
 * rule the module exists to enforce is that a production deployment fails to start rather than
 * starting in a degraded shape: no ephemeral signing key, no in-memory system of record, no
 * development identity provider, no implicit CORS allow-list, no development-mode credential.
 *
 * Development and test deployments keep working defaults so the suites and `pnpm dev` need no
 * ceremony, but every default that would be unsafe in production is refused there explicitly.
 */
import { readFileSync } from "node:fs";

export type Environment = "production" | "staging" | "development" | "test";

export class ConfigurationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigurationError";
    this.problems = problems;
  }
}

export interface SigningKeyConfig {
  /** Key identifier published in the JWKS and written into every descriptor header. */
  kid: string;
  /** PEM-encoded PKCS#8 EC P-256 private key. */
  pem: string;
  /** Only the active key signs; retiring keys stay in the JWKS so descriptors in flight verify. */
  state: "ACTIVE" | "RETIRING";
}

export interface IdentityProviderConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  algorithms: string[];
  /** Claim carrying the platform role, when the provider is configured to emit one. */
  roleClaim: string;
  /** Claim carrying a platform-administrator marker. */
  platformAdminClaim: string;
  /** True only for the bundled development identity provider, which production refuses. */
  synthetic: boolean;
}

export interface LrsConfig {
  endpoint: string;
  auth: { kind: "none" } | { kind: "basic"; username: string; password: string } | { kind: "bearer"; token: string };
  xapiVersion: string;
  timeoutMs: number;
}

export interface ForwarderConfig {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export interface RateLimitConfig {
  enabled: boolean;
  launchesPerMinute: number;
  smartLinksPerMinute: number;
  evidencePerMinute: number;
  adminPerMinute: number;
}

export interface RuntimeConfig {
  environment: Environment;
  production: boolean;
  logLevel: string;
  port: number;
  databaseUrl?: string;
  /** Postgres is the system of record everywhere except development and test without a database. */
  persistence: "postgres" | "memory";
  pseudonymSecret: Buffer;
  signingKeys: SigningKeyConfig[];
  /** Signs the LTI 1.3 id_token and the internal login-hint token; see `readLtiSigningKeys`. */
  ltiSigningKeys: SigningKeyConfig[];
  publicIssuer: string;
  playerOrigin: string;
  evidenceEndpoint: string;
  packageUrl: string;
  /** Base origin of the document-converter service. Absent where that optional service isn't
   * deployed — only the .../documents/upload publisher route needs it. */
  documentConverterUrl?: string;
  allowedConsumerOrigins: string[];
  /** Origins a packaged "external embed" object may point at. Empty means the deployment has not
   *  opted in to external-embed content at all — registration refuses rather than accepting any
   *  https URL, since nothing here has been reviewed the way this platform's other content has. */
  allowedExternalEmbedOrigins: string[];
  identity: IdentityProviderConfig;
  lrs: LrsConfig;
  forwarder: ForwarderConfig;
  rateLimit: RateLimitConfig;
  internalServiceToken?: string;
  /** Demo/example catalogue content is opt-in and refused in production. */
  seedExampleContent: boolean;
  metricsEnabled: boolean;
  trustProxy: boolean;
}

const HEX32 = /^[0-9a-f]{64}$/i;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function int(name: string, fallback: number, problems: string[], min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return parsed;
}

function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/$/, "");
}

/**
 * An origin is exactly a scheme, host and optional port. Paths, trailing slashes and wildcards are
 * refused rather than trimmed, because silently accepting "https://x.example/*" would put a value in
 * the allow-list that reads like a wildcard to whoever audits it next.
 */
function parseOrigins(raw: string | undefined, problems: string[], field: string): string[] {
  if (!raw) return [];
  const origins: string[] = [];
  for (const candidate of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    if (candidate.includes("*")) {
      problems.push(`${field} must not contain a wildcard (${candidate})`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      problems.push(`${field} entry is not an absolute origin (${candidate})`);
      continue;
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      problems.push(`${field} entry must be an origin with no path (${candidate})`);
      continue;
    }
    origins.push(url.origin);
  }
  return origins;
}

function readEnvironment(problems: string[]): Environment {
  const raw = (env("NODE_ENV") ?? "development").toLowerCase();
  if (raw === "production" || raw === "staging" || raw === "development" || raw === "test") return raw;
  problems.push(`NODE_ENV must be one of production, staging, development, test (received ${raw})`);
  return "development";
}

function readPseudonymSecret(production: boolean, problems: string[]): Buffer {
  const value = env("PSEUDONYM_TENANT_SECRET");
  if (!value) {
    if (production) problems.push("PSEUDONYM_TENANT_SECRET is required in production");
    // A fixed development value keeps pseudonyms stable across restarts for local work. It is never
    // reachable in production because the branch above has already failed the start.
    return Buffer.alloc(32, 1);
  }
  if (!HEX32.test(value)) {
    problems.push("PSEUDONYM_TENANT_SECRET must be exactly 32 bytes encoded as hexadecimal");
    return Buffer.alloc(32, 1);
  }
  return Buffer.from(value, "hex");
}

/**
 * Signing keys come from configuration, never from a per-process keypair: a descriptor issued by one
 * replica has to verify on another, and has to keep verifying across a restart. Two shapes are
 * accepted — a single PEM file plus its kid, or a JSON array so a rotation can publish the retiring
 * key alongside the new one.
 */
/**
 * Shared shape behind `readSigningKeys` and `readLtiSigningKeys`: a signing key ring can be
 * configured as either a single PEM plus its kid, or a JSON array so a rotation can publish the
 * retiring key alongside the new one. `requiredInProduction` is the one behavioural difference
 * between callers — the descriptor ring backs every launch, so production refuses to start without
 * one; the LTI ring only matters once an operator registers an LTI tool, so its absence is never
 * fatal on its own.
 */
function readSigningKeyRing(
  envPrefix: string,
  label: string,
  production: boolean,
  requiredInProduction: boolean,
  problems: string[],
): SigningKeyConfig[] {
  const inline = env(`${envPrefix}_SIGNING_KEYS`);
  if (inline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline);
    } catch {
      problems.push(`${envPrefix}_SIGNING_KEYS must be a JSON array of {kid, pem, state} objects`);
      return [];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      problems.push(`${envPrefix}_SIGNING_KEYS must be a non-empty JSON array`);
      return [];
    }
    const keys: SigningKeyConfig[] = [];
    for (const entry of parsed as Record<string, unknown>[]) {
      const kid = typeof entry?.kid === "string" ? entry.kid : undefined;
      const pem = typeof entry?.pem === "string" ? entry.pem : undefined;
      const state = entry?.state === "RETIRING" ? "RETIRING" : "ACTIVE";
      if (!kid || !pem) {
        problems.push(`every ${envPrefix}_SIGNING_KEYS entry needs a kid and a pem`);
        continue;
      }
      keys.push({ kid, pem: pem.replace(/\\n/g, "\n"), state });
    }
    if (keys.filter((key) => key.state === "ACTIVE").length !== 1) {
      problems.push(`${envPrefix}_SIGNING_KEYS must contain exactly one ACTIVE key`);
    }
    return keys;
  }

  const path = env(`${envPrefix}_PRIVATE_KEY_PATH`);
  const pem = env(`${envPrefix}_PRIVATE_KEY_PEM`);
  const kid = env(`${envPrefix}_KID`);
  if (path || pem) {
    if (!kid) {
      problems.push(`${envPrefix}_KID is required alongside a configured ${label} signing key`);
      return [];
    }
    let material = pem?.replace(/\\n/g, "\n");
    if (!material && path) {
      try {
        material = readFileSync(path, "utf8");
      } catch {
        problems.push(`${envPrefix}_PRIVATE_KEY_PATH could not be read (${path})`);
        return [];
      }
    }
    if (!material?.includes("PRIVATE KEY")) {
      problems.push(`the ${label} signing key must be a PEM-encoded PKCS#8 private key`);
      return [];
    }
    const keys: SigningKeyConfig[] = [{ kid, pem: material, state: "ACTIVE" }];
    const retiringPem = env(`${envPrefix}_RETIRING_PRIVATE_KEY_PEM`)?.replace(/\\n/g, "\n");
    const retiringKid = env(`${envPrefix}_RETIRING_KID`);
    if (retiringPem && retiringKid) keys.push({ kid: retiringKid, pem: retiringPem, state: "RETIRING" });
    return keys;
  }

  if (production && requiredInProduction) {
    problems.push(`a ${label} signing key is required in production (${envPrefix}_PRIVATE_KEY_PATH, ${envPrefix}_PRIVATE_KEY_PEM or ${envPrefix}_SIGNING_KEYS)`);
  }
  // Outside production, or when not required, an ephemeral key is generated at start-up by the key service.
  return [];
}

function readSigningKeys(production: boolean, problems: string[]): SigningKeyConfig[] {
  return readSigningKeyRing("DESCRIPTOR", "descriptor", production, true, problems);
}

/**
 * The LTI signing ring: distinct from the descriptor ring because it signs and publishes material
 * meant for a third party (the tool's own JWKS fetch verifying our id_token, and the login-hint
 * token in between) rather than material only LORB's own components ever see. Optional even in
 * production — a deployment with no LTI tools registered needs no LTI key configured.
 */
function readLtiSigningKeys(production: boolean, problems: string[]): SigningKeyConfig[] {
  return readSigningKeyRing("LTI", "LTI", production, false, problems);
}

function readIdentity(production: boolean, publicIssuer: string, problems: string[]): IdentityProviderConfig {
  const issuer = env("OIDC_ISSUER") ?? env("IES_ISSUER");
  const synthetic = bool("ALLOW_SYNTHETIC_IDENTITY", false);

  if (production && synthetic) {
    problems.push("ALLOW_SYNTHETIC_IDENTITY must not be enabled in production");
  }
  if (!issuer) {
    if (production) problems.push("OIDC_ISSUER is required in production");
    return {
      issuer: "http://localhost:4000",
      jwksUrl: "http://localhost:4000/.well-known/jwks.json",
      audience: env("OIDC_AUDIENCE") ?? "lorb-runtime",
      algorithms: ["ES256"],
      roleClaim: env("OIDC_ROLE_CLAIM") ?? "role",
      platformAdminClaim: env("OIDC_PLATFORM_ADMIN_CLAIM") ?? "platform_admin",
      synthetic: true,
    };
  }

  if (production && !issuer.startsWith("https://")) {
    problems.push("OIDC_ISSUER must be an https URL in production");
  }
  // The issuer is compared byte for byte against the token's `iss` claim, so it is never normalised
  // here: providers differ on the trailing slash and guessing would reject valid tokens.
  const jwksUrl = env("OIDC_JWKS_URL") ?? env("IES_JWKS_URL") ?? `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  const audience = env("OIDC_AUDIENCE") ?? "lorb-runtime";
  if (production && audience === publicIssuer) {
    problems.push("OIDC_AUDIENCE must identify the Runtime API audience, not its issuer origin");
  }
  const algorithms = (env("OIDC_ALGORITHMS") ?? "ES256,RS256").split(",").map((value) => value.trim()).filter(Boolean);
  for (const algorithm of algorithms) {
    if (!/^(ES256|ES384|RS256|RS384|RS512|PS256)$/.test(algorithm)) {
      problems.push(`OIDC_ALGORITHMS contains an unsupported algorithm (${algorithm})`);
    }
  }
  return {
    issuer,
    jwksUrl,
    audience,
    algorithms,
    roleClaim: env("OIDC_ROLE_CLAIM") ?? "role",
    platformAdminClaim: env("OIDC_PLATFORM_ADMIN_CLAIM") ?? "platform_admin",
    synthetic,
  };
}

/** Optional, unlike LRS_ENDPOINT: a deployment without the document-converter service simply can't
 * offer "upload a PowerPoint or Word file" from the Admin UI — every other content path still works. */
function readDocumentConverterUrl(production: boolean, problems: string[]): string | undefined {
  const url = env("DOCUMENT_CONVERTER_URL");
  if (!url) return undefined;
  if (production && !url.startsWith("https://")) problems.push("DOCUMENT_CONVERTER_URL must be an https URL in production");
  return url;
}

function readLrs(production: boolean, problems: string[]): LrsConfig {
  const endpoint = env("LRS_ENDPOINT") ?? env("DEVELOPMENT_LRS_URL");
  if (!endpoint) {
    if (production) problems.push("LRS_ENDPOINT is required in production");
    return { endpoint: "", auth: { kind: "none" }, xapiVersion: "1.0.3", timeoutMs: 10000 };
  }
  if (production && !endpoint.startsWith("https://")) {
    problems.push("LRS_ENDPOINT must be an https URL in production");
  }
  const username = env("LRS_BASIC_USERNAME");
  const password = env("LRS_BASIC_PASSWORD");
  const bearer = env("LRS_BEARER_TOKEN");
  let auth: LrsConfig["auth"] = { kind: "none" };
  if (bearer) auth = { kind: "bearer", token: bearer };
  else if (username && password) auth = { kind: "basic", username, password };
  else if (username || password) problems.push("LRS_BASIC_USERNAME and LRS_BASIC_PASSWORD must be set together");
  else if (production) problems.push("the learning record store requires credentials in production (LRS_BEARER_TOKEN or LRS_BASIC_USERNAME/LRS_BASIC_PASSWORD)");
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    auth,
    xapiVersion: env("LRS_XAPI_VERSION") ?? "1.0.3",
    timeoutMs: int("LRS_TIMEOUT_MS", 10000, problems, 100, 120000),
  };
}

export function loadConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const problems: string[] = [];
  const environment = readEnvironment(problems);
  const production = environment === "production" || environment === "staging";

  const databaseUrl = env("DATABASE_URL");
  if (production && !databaseUrl) {
    problems.push("DATABASE_URL is required in production: in-memory state is not a system of record");
  }

  const publicIssuer = normaliseOrigin(env("RUNTIME_PUBLIC_ISSUER") ?? "http://localhost:3000");
  const playerOrigin = normaliseOrigin(env("PLAYER_SHELL_ORIGIN") ?? "http://localhost:3200");
  if (production) {
    for (const [name, value] of [["RUNTIME_PUBLIC_ISSUER", publicIssuer], ["PLAYER_SHELL_ORIGIN", playerOrigin]] as const) {
      if (!value.startsWith("https://")) problems.push(`${name} must be an https origin in production`);
    }
  }

  const configuredOrigins = parseOrigins(env("ALLOWED_CONSUMER_ORIGINS"), problems, "ALLOWED_CONSUMER_ORIGINS");
  // Outside production the local consumer and console origins are convenient defaults. In production
  // the allow-list is exactly what the operator configured: a built-in origin nobody reviewed is the
  // same defect as a wildcard, only harder to notice.
  const developmentOrigins = ["http://localhost:3300", "http://localhost:5176", "http://localhost:5173", "http://localhost:5174"];
  const allowedConsumerOrigins = production ? configuredOrigins : [...new Set([...developmentOrigins, ...configuredOrigins])];
  if (production && allowedConsumerOrigins.length === 0) {
    problems.push("ALLOWED_CONSUMER_ORIGINS must list at least one origin in production");
  }

  // No development default here, unlike allowedConsumerOrigins above: an empty list means the
  // deployment has not opted in to external-embed content, which is the right default everywhere,
  // dev included — nothing forces a test suite or a local run to trust an origin it never chose.
  const allowedExternalEmbedOrigins = parseOrigins(env("ALLOWED_EXTERNAL_EMBED_ORIGINS"), problems, "ALLOWED_EXTERNAL_EMBED_ORIGINS");

  const internalServiceToken = env("RUNTIME_INTERNAL_SERVICE_TOKEN");
  if (production && !internalServiceToken) {
    problems.push("RUNTIME_INTERNAL_SERVICE_TOKEN is required in production");
  }
  if (internalServiceToken && internalServiceToken.length < 32) {
    problems.push("RUNTIME_INTERNAL_SERVICE_TOKEN must be at least 32 characters");
  }

  const seedExampleContent = bool("SEED_EXAMPLE_CONTENT", !production);
  if (production && seedExampleContent) {
    problems.push("SEED_EXAMPLE_CONTENT must not be enabled in production");
  }

  const config: RuntimeConfig = {
    environment,
    production,
    logLevel: env("LOG_LEVEL") ?? (environment === "test" ? "silent" : "info"),
    port: int("PORT", int("RUNTIME_API_PORT", 3000, problems, 1, 65535), problems, 1, 65535),
    databaseUrl,
    persistence: databaseUrl ? "postgres" : "memory",
    pseudonymSecret: readPseudonymSecret(production, problems),
    signingKeys: readSigningKeys(production, problems),
    ltiSigningKeys: readLtiSigningKeys(production, problems),
    publicIssuer,
    playerOrigin,
    evidenceEndpoint: env("EVIDENCE_API_ENDPOINT") ?? `${publicIssuer}/api/v1/evidence/statements`,
    packageUrl: env("PACKAGE_PUBLIC_URL") ?? `${playerOrigin}/module/index.html`,
    documentConverterUrl: readDocumentConverterUrl(production, problems),
    allowedConsumerOrigins,
    allowedExternalEmbedOrigins,
    identity: readIdentity(production, publicIssuer, problems),
    lrs: readLrs(production, problems),
    forwarder: {
      enabled: bool("EVIDENCE_FORWARDER_ENABLED", true),
      pollIntervalMs: int("EVIDENCE_FORWARDER_POLL_MS", 2000, problems, 100, 600000),
      batchSize: int("EVIDENCE_FORWARDER_BATCH", 25, problems, 1, 500),
      maxAttempts: int("EVIDENCE_FORWARDER_MAX_ATTEMPTS", 8, problems, 1, 100),
      baseBackoffMs: int("EVIDENCE_FORWARDER_BASE_BACKOFF_MS", 1000, problems, 10, 600000),
      maxBackoffMs: int("EVIDENCE_FORWARDER_MAX_BACKOFF_MS", 900000, problems, 1000, 86400000),
    },
    rateLimit: {
      enabled: bool("RATE_LIMIT_ENABLED", production),
      launchesPerMinute: int("RATE_LIMIT_LAUNCHES_PER_MINUTE", 120, problems, 1, 100000),
      smartLinksPerMinute: int("RATE_LIMIT_SMART_LINKS_PER_MINUTE", 60, problems, 1, 100000),
      evidencePerMinute: int("RATE_LIMIT_EVIDENCE_PER_MINUTE", 600, problems, 1, 100000),
      adminPerMinute: int("RATE_LIMIT_ADMIN_PER_MINUTE", 300, problems, 1, 100000),
    },
    internalServiceToken,
    seedExampleContent,
    metricsEnabled: bool("METRICS_ENABLED", true),
    trustProxy: bool("TRUST_PROXY", production),
    ...overrides,
  };

  if (problems.length > 0) throw new ConfigurationError(problems);
  return config;
}

let cached: RuntimeConfig | undefined;

/** The process-wide configuration, loaded once. */
export function config(): RuntimeConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam: drops the cached configuration so a suite can re-read a changed environment. */
export function resetConfig(): void {
  cached = undefined;
}
