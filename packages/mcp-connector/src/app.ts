// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION. Remote MCP server over the streamable HTTP transport.
import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createVerifier,
  protectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PATH,
  PROTECTED_RESOURCE_METADATA_PATH_INSERTED,
  wwwAuthenticate,
} from "./auth.js";
import { createLorbClients, type FetchImpl, type LorbClients } from "./lorb-clients.js";
import { IdempotencyStore } from "./idempotency.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION, createMcpServer } from "./mcp-server.js";
import type { ConnectorConfig } from "./config.js";

export interface ConnectorOptions {
  config: ConnectorConfig;
  /** Injectable transport for the outbound LORB calls, so tests exercise the real client code. */
  fetchImpl?: FetchImpl;
  /** Overrides the whole client layer. Prefer fetchImpl. */
  clients?: LorbClients;
  newId?: () => string;
  /** Overrides token validation. Tests only — production always builds one from config. */
  verifyToken?: import("./auth.js").TokenVerifier;
}

const JSONRPC_UNAUTHORIZED = -32001;

export function buildMcpConnector(options: ConnectorOptions) {
  const { config } = options;
  const clients = options.clients ?? createLorbClients(config, options.fetchImpl);
  const assignIdempotency = new IdempotencyStore<Record<string, unknown>>();
  const app = Fastify({ logger: false, bodyLimit: 262144 });
  const verifyToken = options.verifyToken ?? createVerifier(config);

  // Endpoint index, mirroring the Runtime API's root route. Unauthenticated, like /health: the MCP
  // endpoint itself is the only authenticated surface. Without this, opening the service in a browser
  // returns a bare Fastify 404, which reads as "broken" rather than "alive but nothing served here".
  // It lists paths only — never the configured Runtime, Evidence, or roster addresses, which are
  // internal and none of a caller's business.
  app.get("/", async () => ({
    name: "LORB MCP connector",
    status: "ok",
    production: false,
    notice: "DRAFT — NOT CERTIFIED — LOCAL DEV / REVIEW ENVIRONMENT ONLY. Synthetic data only.",
    auth_mode: config.authMode,
    documentation: "packages/mcp-connector/README.md",
    endpoints: {
      health: "/health",
      mcp: "/mcp",
      ...(config.oidc ? { protected_resource_metadata: PROTECTED_RESOURCE_METADATA_PATH_INSERTED } : {}),
    },
    transport: "streamable-http",
  }));
  app.get("/health", async () => ({ status: "ok", service: CONNECTOR_NAME, version: CONNECTOR_VERSION, auth_mode: config.authMode, production: false }));

  // RFC 9728 protected resource metadata. Served only in `oidc` mode: in `poc` mode there is no
  // authorization server to name, and publishing a document that pointed nowhere would be worse
  // than publishing none — a client would start a flow that cannot complete.
  if (config.oidc) {
    const document = protectedResourceMetadata(config.oidc);
    const serve = async (_req: unknown, reply: { header: (k: string, v: string) => { send: (b: unknown) => unknown } }) =>
      reply.header("cache-control", "public, max-age=300").send(document);
    // Both spellings: the path-inserted one RFC 9728 §3.1 specifies for a resource with a path,
    // and the bare root one a client may try when it treats the origin as the resource.
    app.get(PROTECTED_RESOURCE_METADATA_PATH_INSERTED, serve);
    app.get(PROTECTED_RESOURCE_METADATA_PATH, serve);
  }

  // PoC-grade agent authentication. See auth.ts: this is *not* the OAuth 2.1 flow the MCP
  // authorization specification requires of a production remote server. The challenge shape is
  // spec-correct so a compliant host reports a useful error; the credential behind it is not.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/mcp")) return;
    const outcome = await verifyToken(req.headers.authorization);
    if (outcome.ok) return;
    // insufficient_scope is a 403 per RFC 6750 §3.1: the token is valid, the grant is not enough.
    const status = outcome.error === "insufficient_scope" ? 403 : 401;
    return reply
      .code(status)
      .header("www-authenticate", wwwAuthenticate(outcome.error, config))
      .type("application/json")
      .send({ jsonrpc: "2.0", error: { code: JSONRPC_UNAUTHORIZED, message: status === 403 ? "Forbidden" : "Unauthorized" }, id: null });
  });

  const handle = async (req: any, reply: any) => {
    // Stateless: one MCP server and transport per request. No session state to leak between agent
    // sessions, and nothing to clean up if a host disconnects mid-call.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer({ clients, assignIdempotency, newId: options.newId });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", handle);
  // GET and DELETE are part of the streamable HTTP transport; the SDK answers them (405 in stateless
  // mode) rather than Fastify guessing.
  app.get("/mcp", handle);
  app.delete("/mcp", handle);

  return app;
}
