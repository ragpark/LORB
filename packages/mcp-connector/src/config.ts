// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08.
//
// This service authenticates a *teacher's agent session* (e.g. Claude over MCP). That is a different
// actor, with a different lifetime and a different blast radius, from the learner identities the
// synthetic IES issues. The two never share a token, a scope, or a signing key:
//
//   agent   -> pre-shared bearer token, this file, PoC only, no IdP behind it
//   learner -> IES-issued short-lived ES256 token, audience `lorb-runtime`, one launch
//
// An agent bearer token must never reach a launch descriptor or an IES token, and an IES token must
// never be accepted here.

export type AuthMode = "poc";

export interface ConnectorConfig {
  authMode: AuthMode;
  /** Single pre-shared bearer token for the agent session. Compared in constant time. */
  agentBearerToken: string;
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
  if (authMode !== "poc") {
    throw new ConnectorConfigError(`AUTH_MODE must be "poc"; this connector implements no other authorisation mode. Received "${authMode}".`);
  }
  const agentBearerToken = env.MCP_POC_BEARER_TOKEN ?? "";
  if (agentBearerToken.length < MIN_TOKEN_LENGTH) {
    throw new ConnectorConfigError(`MCP_POC_BEARER_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  const runtimeInternalServiceToken = env.RUNTIME_INTERNAL_SERVICE_TOKEN ?? "";
  if (runtimeInternalServiceToken.length < MIN_TOKEN_LENGTH) {
    throw new ConnectorConfigError(`RUNTIME_INTERNAL_SERVICE_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  // Structural guarantee that the agent-facing and service-to-service credentials stay separate: if
  // they were ever configured to the same value, an agent token would be a Runtime internal credential.
  if (agentBearerToken === runtimeInternalServiceToken) {
    throw new ConnectorConfigError("MCP_POC_BEARER_TOKEN and RUNTIME_INTERNAL_SERVICE_TOKEN must differ: the agent-facing and service-to-service trust domains must not share a credential.");
  }
  const runtimeApiBase = trimBase(env.RUNTIME_API_BASE ?? "http://localhost:3000");
  const port = Number.parseInt(env.PORT ?? env.MCP_CONNECTOR_PORT ?? "4200", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectorConfigError("PORT must be a valid TCP port");
  return {
    authMode,
    agentBearerToken,
    runtimeApiBase,
    // The MVP evidence store is process-local to the Runtime API (see packages/evidence-api), so the
    // Evidence routes are served by the Runtime API host unless pointed elsewhere.
    evidenceApiBase: trimBase(env.EVIDENCE_API_BASE ?? runtimeApiBase),
    rosterApiBase: trimBase(env.ROSTER_API_BASE ?? "http://localhost:4100"),
    runtimeInternalServiceToken,
    port,
  };
}
