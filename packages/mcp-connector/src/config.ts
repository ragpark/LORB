// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08.
//
// This service authenticates a *teacher's agent session* (e.g. Claude over MCP). That is a different
// actor, with a different lifetime and a different blast radius, from the learner identities the
// synthetic IES issues. The two never share a token, a scope, or a signing key:
//
//   agent   -> AUTH_MODE=poc:  pre-shared bearer token, no IdP behind it, local dev and CI only
//              AUTH_MODE=oidc: a token issued by an external identity provider the institution
//                              already runs, validated here against that provider's JWKS
//   learner -> IES-issued short-lived ES256 token, audience `lorb-runtime`, one launch
//
// An agent token must never reach a launch descriptor or an IES token, and an IES token must never
// be accepted here.
//
// In `oidc` mode this connector is an OAuth **resource server** and nothing more. It validates
// tokens and publishes metadata; it never issues, refreshes, stores, or exchanges a credential, and
// it holds no client secret. Whoever runs the identity provider stays the only issuer of identity.

export type AuthMode = "poc" | "oidc";

/** Set only when authMode is "oidc". */
export interface OidcConfig {
  /** Expected `iss`. The authorization server the institution already runs. */
  issuer: string;
  /**
   * Expected `aud` — the canonical identifier of *this* resource. Required, never derived: a token
   * minted for some other service in the same tenant must not be accepted here (confused deputy).
   */
  audience: string;
  /** Where this server's signing keys are published. Defaults to the issuer's standard JWKS path. */
  jwksUrl: string;
  /** Optional scope gate. When set, a valid token without it gets 403 insufficient_scope. */
  requiredScope?: string;
  /** Public base URL of this connector, for the RFC 9728 `resource` value and metadata pointer. */
  publicUrl: string;
}

export interface ConnectorConfig {
  authMode: AuthMode;
  /** Pre-shared bearer token for the agent session, in "poc" mode only. Compared in constant time. */
  agentBearerToken: string;
  /** Present exactly when authMode is "oidc". */
  oidc?: OidcConfig;
  runtimeApiBase: string;
  evidenceApiBase: string;
  rosterApiBase: string;
  /** Credential for the Runtime API's internal service surface. Distinct from agentBearerToken. */
  runtimeInternalServiceToken: string;
  port: number;
}

const MIN_TOKEN_LENGTH = 32;

export class ConnectorConfigError extends Error {}

const trimBase = (value: string) => value.replace(/\/$/, "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  // Fail closed on an unrecognised mode rather than silently degrading to no authentication.
  const authMode = env.AUTH_MODE ?? "poc";
  if (authMode !== "poc" && authMode !== "oidc") {
    throw new ConnectorConfigError(`AUTH_MODE must be "poc" or "oidc". Received "${authMode}".`);
  }
  const oidc = authMode === "oidc" ? loadOidc(env) : undefined;
  // The pre-shared token is required in "poc" mode and must be absent in "oidc" mode: leaving it
  // configured would keep a second, weaker way in alongside the identity provider.
  const agentBearerToken = env.MCP_POC_BEARER_TOKEN ?? "";
  if (authMode === "poc" && agentBearerToken.length < MIN_TOKEN_LENGTH) {
    throw new ConnectorConfigError(`MCP_POC_BEARER_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  if (authMode === "oidc" && agentBearerToken.length > 0) {
    throw new ConnectorConfigError('MCP_POC_BEARER_TOKEN must not be set when AUTH_MODE=oidc: the pre-shared token would remain a second, weaker way past the identity provider.');
  }
  const runtimeInternalServiceToken = env.RUNTIME_INTERNAL_SERVICE_TOKEN ?? "";
  if (runtimeInternalServiceToken.length < MIN_TOKEN_LENGTH) {
    throw new ConnectorConfigError(`RUNTIME_INTERNAL_SERVICE_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  // Structural guarantee that the agent-facing and service-to-service credentials stay separate: if
  // they were ever configured to the same value, an agent token would be a Runtime internal credential.
  if (authMode === "poc" && agentBearerToken === runtimeInternalServiceToken) {
    throw new ConnectorConfigError("MCP_POC_BEARER_TOKEN and RUNTIME_INTERNAL_SERVICE_TOKEN must differ: the agent-facing and service-to-service trust domains must not share a credential.");
  }
  const runtimeApiBase = trimBase(env.RUNTIME_API_BASE ?? "http://localhost:3000");
  const port = Number.parseInt(env.PORT ?? env.MCP_CONNECTOR_PORT ?? "4200", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectorConfigError("PORT must be a valid TCP port");
  return {
    authMode,
    agentBearerToken,
    oidc,
    runtimeApiBase,
    // The MVP evidence store is process-local to the Runtime API (see packages/evidence-api), so the
    // Evidence routes are served by the Runtime API host unless pointed elsewhere.
    evidenceApiBase: trimBase(env.EVIDENCE_API_BASE ?? runtimeApiBase),
    rosterApiBase: trimBase(env.ROSTER_API_BASE ?? "http://localhost:4100"),
    runtimeInternalServiceToken,
    port,
  };
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new ConnectorConfigError(`${name} is required when AUTH_MODE=oidc.`);
  return value;
};

function loadOidc(env: NodeJS.ProcessEnv): OidcConfig {
  const issuer = trimBase(required(env, "OIDC_ISSUER"));
  if (!issuer.startsWith("https://")) {
    throw new ConnectorConfigError("OIDC_ISSUER must be an https URL: token signatures are only as trustworthy as the channel their keys arrive over.");
  }
  const publicUrl = trimBase(required(env, "MCP_PUBLIC_URL"));
  return {
    issuer,
    audience: required(env, "OIDC_AUDIENCE"),
    jwksUrl: trimBase(env.OIDC_JWKS_URL?.trim() || `${issuer}/.well-known/jwks.json`),
    requiredScope: env.OIDC_REQUIRED_SCOPE?.trim() || undefined,
    publicUrl,
  };
}
