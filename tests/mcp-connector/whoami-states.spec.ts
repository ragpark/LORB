/**
 * whoami must not assert a link state it does not know.
 *
 * This tool exists for the case where nothing else adds up, so a confident wrong answer from it is
 * worse than no tool at all. Both cases below were raised in review on #56: the first version
 * collapsed "unknown" into "linked", and reported an authenticated caller as unauthenticated.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildMcpConnector } from "../../packages/mcp-connector/src/app.js";
import { loadConfig } from "../../packages/mcp-connector/src/config.js";
import { POC_PRINCIPAL } from "../../packages/mcp-connector/src/auth.js";
import type { ClassList, LorbClients } from "../../packages/mcp-connector/src/lorb-clients.js";

const AGENT_TOKEN = "whoami-states-suite-agent-bearer-token-000001";
const SERVICE_TOKEN = "whoami-states-suite-internal-service-token-01";

let connector: FastifyInstance | undefined;

/** Stands the connector up with a client layer that answers listClasses however the test needs. */
async function whoamiWith(listClasses: () => Promise<ClassList>) {
  const config = loadConfig({ MCP_POC_BEARER_TOKEN: AGENT_TOKEN, RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN } as NodeJS.ProcessEnv);
  connector = buildMcpConnector({ config, clients: { listClasses } as unknown as LorbClients });
  await connector.listen({ host: "127.0.0.1", port: 0 });
  const port = (connector.server.address() as { port: number }).port;
  const client = new Client({ name: "whoami-states", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${AGENT_TOKEN}` } },
  }));
  const result = await client.callTool({ name: "whoami", arguments: {} }) as { content: Array<{ text: string }> };
  await client.close();
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

afterEach(async () => {
  await connector?.close();
  connector = undefined;
});

describe("whoami link state", () => {
  it("reports linked when the roster says so", async () => {
    const me = await whoamiWith(async () => ({ items: [], linked: true }));
    expect(me.linked_to_a_teacher).toBe(true);
    expect(me.next_step).toContain("This assistant is linked.");
  });

  it("reports not linked when the roster says so", async () => {
    const me = await whoamiWith(async () => ({ items: [], linked: false }));
    expect(me.linked_to_a_teacher).toBe(false);
    expect(me.next_step).toContain("AI assistants");
  });

  it("does not claim a link when the Runtime API is unreachable", async () => {
    const me = await whoamiWith(async () => { throw new Error("connect ECONNREFUSED"); });
    expect(me.linked_to_a_teacher).toBe("unknown");
    expect(me.next_step).not.toContain("This assistant is linked.");
    expect(me.next_step).toContain("could not be reached");
    // The pair is still usable even when the status is not — that is the point of reporting it.
    expect(me.issuer).toBe(POC_PRINCIPAL.issuer);
    expect(me.subject).toBe(POC_PRINCIPAL.subject);
  });

  // A Runtime API mid-deployment on a build that predates link reporting omits the field entirely.
  it("does not claim a link when the roster omits the status", async () => {
    const me = await whoamiWith(async () => ({ items: [] }));
    expect(me.linked_to_a_teacher).toBe("unknown");
    expect(me.next_step).not.toContain("This assistant is linked.");
  });

  it("always reports the principal as authenticated when a tool call succeeds", async () => {
    const me = await whoamiWith(async () => ({ items: [], linked: true }));
    expect(me.authenticated).toBe(true);
  });
});
