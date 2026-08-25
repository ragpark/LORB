// The agent-facing trust domain.
//
// This service authenticates a *teacher's agent session* (Claude over MCP, for instance). That is a
// different actor, with a different lifetime and a different blast radius, from the learner
// identities the platform's identity provider issues. The two never share a token, a scope, or a
// signing key:
//
//   agent   -> AUTH_MODE=oidc:         a token issued by the identity provider the institution
//                                      already runs, validated here against that provider's JWKS.
//                                      The only mode a deployed environment may use.
//              AUTH_MODE=shared-token: one pre-shared bearer token, no identity provider behind it.
//                                      Local development and continuous integration only; refused
//                                      outright when NODE_ENV is production or staging.
//   learner -> a short-lived access token from the same provider, audience `lorb-runtime`, one launch
//
// An agent token must never reach a launch descriptor or a learner access token, and a learner
// token must never be accepted here.
//
// In `oidc` mode this connector is an OAuth **resource server** and nothing more. It validates
// tokens and publishes metadata; it never issues, refreshes, stores, or exchanges a credential, and
// it holds no client secret. Whoever runs the identity provider stays the only issuer of identity.

export type AuthMode = "shared-token" | "oidc";

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
  /** Pre-shared bearer token for the agent session, in "shared-token" mode only. Constant-time compared. */
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
  const production = env.NODE_ENV === "production" || env.NODE_ENV === "staging";
  // OIDC is the default. A deployment that says nothing gets the mode a deployment should have.
  // `poc` is still accepted as the previous name for `shared-token`, so an existing development
  // environment keeps working without an edit.
  const requested = env.AUTH_MODE ?? (production ? "oidc" : "shared-token");
  const authMode: string = requested === "poc" ? "shared-token" : requested;
  // Fail closed on an unrecognised mode rather than silently degrading to no authentication.
  if (authMode !== "shared-token" && authMode !== "oidc") {
    throw new ConnectorConfigError(`AUTH_MODE must be "oidc" or "shared-token". Received "${requested}".`);
  }
  if (production && authMode !== "oidc") {
    throw new ConnectorConfigError('AUTH_MODE must be "oidc" in production: a single pre-shared token has no identity behind it, cannot be scoped to one teacher, and cannot be revoked for one agent.');
  }
  const oidc = authMode === "oidc" ? loadOidc(env) : undefined;
  // The pre-shared token is required in "shared-token" mode and must be absent in "oidc" mode:
  // leaving it configured would keep a second, weaker way in alongside the identity provider.
  const agentBearerToken = env.MCP_SHARED_BEARER_TOKEN ?? env.MCP_POC_BEARER_TOKEN ?? "";
  if (authMode === "shared-token" && agentBearerToken.length < MIN_TOKEN_LENGTH) {
    throw new ConnectorConfigError(`MCP_SHARED_BEARER_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  if (authMode === "oidc" && agentBearerToken.length > 0) {
    throw new ConnectorConfigError('MCP_SHARED_BEARER_TOKEN must not be set when AUTH_MODE=oidc: the pre-shared token would remain a second, weaker way past the identity provider.');
  }
  const runtimeInternalServiceToken = env.RUNTIME_INTERNAL_SERVICE_TOKEN ?? "";
  if (runtimeInternalServiceToken.length < MIN_TOKEN_LENGTH) {
    throw new ConnectorConfigError(`RUNTIME_INTERNAL_SERVICE_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  // Structural guarantee that the agent-facing and service-to-service credentials stay separate: if
  // they were ever configured to the same value, an agent token would be a Runtime internal credential.
  if (authMode === "shared-token" && agentBearerToken === runtimeInternalServiceToken) {
    throw new ConnectorConfigError("The agent bearer token and RUNTIME_INTERNAL_SERVICE_TOKEN must differ: the agent-facing and service-to-service trust domains must not share a credential.");
  }
  const runtimeApiBase = trimBase(env.RUNTIME_API_BASE ?? "http://localhost:3000");
  const port = Number.parseInt(env.PORT ?? env.MCP_CONNECTOR_PORT ?? "4200", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectorConfigError("PORT must be a valid TCP port");
  return {
    authMode: authMode as AuthMode,
    agentBearerToken,
    oidc,
    runtimeApiBase,
    // The Evidence API is mounted on the Runtime API's listener (see src/server.ts), so it defaults
    // to the same base unless an operator has split them.
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
  // An issuer is an exact-match identifier, not a base URL to concatenate onto. Auth0 mints `iss`
  // as "https://tenant.auth0.com/" — with the trailing slash — and jose compares the claim byte
  // for byte, so normalising it away here would reject every token that tenant issues. Keep it
  // verbatim; trim only the copy used to build a URL.
  const issuer = required(env, "OIDC_ISSUER");
  if (!issuer.startsWith("https://")) {
    throw new ConnectorConfigError("OIDC_ISSUER must be an https URL: token signatures are only as trustworthy as the channel their keys arrive over.");
  }
  const publicUrl = trimBase(required(env, "MCP_PUBLIC_URL"));
  return {
    issuer,
    audience: required(env, "OIDC_AUDIENCE"),
    jwksUrl: trimBase(env.OIDC_JWKS_URL?.trim() || `${trimBase(issuer)}/.well-known/jwks.json`),
    requiredScope: env.OIDC_REQUIRED_SCOPE?.trim() || undefined,
    publicUrl,
  };
}
