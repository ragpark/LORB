import "dotenv/config";
import { buildRuntime } from "../packages/runtime-api/src/app.js";
import { registerEvidenceRoutes } from "../packages/evidence-api/src/app.js";

function pseudonymSecret(): Buffer | undefined {
  const value = process.env.PSEUDONYM_TENANT_SECRET;
  if (!value) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("PSEUDONYM_TENANT_SECRET must be exactly 32 bytes encoded as hexadecimal");
  }
  return Buffer.from(value, "hex");
}

const { app, keys } = await buildRuntime({ secret: pseudonymSecret() });

// The MVP evidence store is process-local in-memory state that the Evidence API imports directly
// from the Runtime API's core module, and the Evidence API verifies launch descriptors with the
// Runtime's own signing key. Neither can be satisfied across a process boundary, so the local and
// review-environment PoC host mounts both route sets on one listener. This puts the Evidence API on
// the Runtime service's public surface: a surface change to call out at human LORB-001 re-review.
registerEvidenceRoutes(app, keys.privateKey, (process.env.RUNTIME_PUBLIC_ISSUER ?? "http://localhost:3000").replace(/\/$/, ""));
app.get("/", async () => ({
  name: "LORB Runtime API",
  status: "ok",
  documentation: "/api/v1/runtime/jwks",
  endpoints: {
    health: "/health",
    jwks: "/api/v1/runtime/jwks",
    launches: "/api/v1/runtime/launches",
    evidence_statements: "/api/v1/evidence/statements",
    activity_results: "/api/v1/evidence/activity-results",
  },
}));
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
