// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION — LOCAL DEV / REVIEW ENVIRONMENT ONLY.
import "dotenv/config";
import { buildMcpConnector, startupBanner } from "./app.js";
import { loadConfig } from "./config.js";

// Configuration first, so the banner can name the authentication mode that is actually in force.
// A failure here is fail-closed by design and the thrown ConnectorConfigError names the variable.
const config = loadConfig();
console.error(startupBanner(config));
const app = buildMcpConnector({ config });

const stop = async (signal: string) => {
  console.error(`shutting down (${signal})`);
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

await app.listen({ host: "0.0.0.0", port: config.port });
