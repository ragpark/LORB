// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION. Remote MCP server over the streamable HTTP transport.
import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateAgent, wwwAuthenticate } from "./auth.js";
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
}

const JSONRPC_UNAUTHORIZED = -32001;

export function buildMcpConnector(options: ConnectorOptions) {
  const { config } = options;
  const clients = options.clients ?? createLorbClients(config, options.fetchImpl);
  const assignIdempotency = new IdempotencyStore<Record<string, unknown>>();
  const app = Fastify({ logger: false, bodyLimit: 262144 });

  app.get("/health", async () => ({ status: "ok", service: CONNECTOR_NAME, version: CONNECTOR_VERSION, auth_mode: config.authMode, production: false }));

  // PoC-grade agent authentication. See auth.ts: this is *not* the OAuth 2.1 flow the MCP
  // authorization specification requires of a production remote server. The challenge shape is
  // spec-correct so a compliant host reports a useful error; the credential behind it is not.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/mcp")) return;
    const outcome = authenticateAgent(req.headers.authorization, config.agentBearerToken);
    if (outcome.ok) return;
    return reply
      .code(401)
      .header("www-authenticate", wwwAuthenticate(outcome.error))
      .type("application/json")
      .send({ jsonrpc: "2.0", error: { code: JSONRPC_UNAUTHORIZED, message: "Unauthorized" }, id: null });
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
