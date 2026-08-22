// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION — LOCAL DEV / REVIEW ENVIRONMENT ONLY.
console.error("LORB MCP connector: DRAFT, uncertified, PoC bearer authentication only. Not for shared or production deployment.");
import "dotenv/config";
import { buildMcpConnector } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildMcpConnector({ config });

const stop = async (signal: string) => {
  console.error(`shutting down (${signal})`);
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

await app.listen({ host: "0.0.0.0", port: config.port });
