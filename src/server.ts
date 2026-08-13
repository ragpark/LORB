import "dotenv/config";
import { buildRuntime } from "../packages/runtime-api/src/app.js";

function pseudonymSecret(): Buffer | undefined {
  const value = process.env.PSEUDONYM_TENANT_SECRET;
  if (!value) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("PSEUDONYM_TENANT_SECRET must be exactly 32 bytes encoded as hexadecimal");
  }
  return Buffer.from(value, "hex");
}

const { app } = await buildRuntime({ secret: pseudonymSecret() });
app.get("/health", async () => ({ status: "ok" }));

const port = Number.parseInt(process.env.PORT ?? process.env.RUNTIME_API_PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");

const stop = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

await app.listen({ host: "0.0.0.0", port });
