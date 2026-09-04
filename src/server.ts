/**
 * The LORB service host.
 *
 * Composes the Runtime API, the Evidence API, the evidence forwarder and the background maintenance
 * loop into one process, and owns start-up ordering, probes and shutdown.
 *
 * The Evidence API is mounted on the Runtime listener rather than run separately: it verifies launch
 * descriptors with the Runtime's signing key and writes to the same durable store, so splitting them
 * would buy separate scaling at the cost of a second copy of the key ring. Both are versioned
 * surfaces under /api/v1 and can be split later without a contract change.
 */
import "dotenv/config";
import { buildRuntime } from "../packages/runtime-api/src/app.js";
import { registerEvidenceRoutes } from "../packages/evidence-api/src/app.js";
import { endpointsFromEnvironment, registerRelayRoutes } from "../packages/experience-relay/src/app.js";
import { ConfigurationError, loadConfig } from "../packages/runtime-api/src/config/index.js";
import { logger, metricsRegistry } from "../packages/runtime-api/src/services/observability.js";
import { httpSender, startForwarder, type ForwarderHandle } from "../packages/evidence-forwarder/src/worker.js";
import { PostgresCatalogueStore } from "../packages/runtime-api/src/catalogue/index.js";
import { createCatalogue } from "../packages/runtime-api/src/catalogue/index.js";
import { createStore } from "../packages/runtime-api/src/store/index.js";
import { registerWebApps, webAppPrefix, WEB_APPS } from "../packages/runtime-api/src/services/web-apps.js";

const log = logger();

let runtimeConfig;
try {
  runtimeConfig = loadConfig();
} catch (error) {
  // A misconfigured production process must not start. Naming every problem at once means an
  // operator fixes the deployment in one pass rather than discovering them one restart at a time.
  if (error instanceof ConfigurationError) {
    log.fatal({ problems: error.problems }, "refusing to start: invalid configuration");
    process.exit(78); // EX_CONFIG
  }
  throw error;
}

const store = createStore({ databaseUrl: runtimeConfig.databaseUrl });
const catalogue = createCatalogue({ databaseUrl: runtimeConfig.databaseUrl, seedExamples: runtimeConfig.seedExampleContent });

if (runtimeConfig.seedExampleContent && catalogue instanceof PostgresCatalogueStore) {
  await catalogue.seedExamples();
  log.warn("example content seeded: this is a development convenience and is refused in production");
}
await catalogue.ensureSharedPlayer();

const { app, ring } = await buildRuntime({ config: runtimeConfig, store, catalogue });
registerEvidenceRoutes(app, ring, { issuer: runtimeConfig.publicIssuer, store });
const relayEndpoints = endpointsFromEnvironment();
registerRelayRoutes(app, ring, { issuer: runtimeConfig.publicIssuer, endpoints: relayEndpoints, perMinute: Number.parseInt(process.env.RELAY_RATE_LIMIT_PER_MINUTE ?? "30", 10) });

/**
 * Optional surfaces, folded into this process when the deployment asks for them.
 *
 * Both default off, so a deployment that says nothing keeps the topology it already has: the
 * browser applications behind their own static origins and the agent connector as its own service.
 * Neither changes what those surfaces do — the same bundles are served and the same agent token is
 * verified — so the two topologies can be compared from one build and one image.
 *
 * Failures here are fatal rather than degraded. A process told to serve an application whose bundle
 * is missing, or to mount a connector whose configuration is refused, would otherwise start and
 * serve a 404 where an operator expects a workspace, which is a worse outcome than not starting.
 */
const foldedIn: string[] = [];

if (runtimeConfig.topology.serveWebApps) {
  const { mounted, missing } = await registerWebApps(app, { config: runtimeConfig });
  if (missing.length > 0) {
    log.fatal(
      { applications: missing.map((entry) => entry.slug), searched: missing.flatMap((entry) => entry.searched) },
      "refusing to start: SERVE_WEB_APPS is set but a built application bundle is missing",
    );
    process.exit(78); // EX_CONFIG
  }
  for (const mount of mounted) foldedIn.push(`web:${mount.slug}`);
  log.info({ applications: mounted.map((mount) => `${mount.prefix} <- ${mount.root}`) }, "serving the browser applications from this process");
}

if (runtimeConfig.topology.serveMcpConnector) {
  // Imported here rather than at the top so that a deployment which does not fold the connector in
  // never loads it, and never evaluates its configuration.
  const [{ mcpConnectorPlugin, startupBanner }, { loadConfig: loadConnectorConfig, ConnectorConfigError }] = await Promise.all([
    import("../packages/mcp-connector/src/app.js"),
    import("../packages/mcp-connector/src/config.js"),
  ]);
  try {
    // The connector still reaches the Runtime API over HTTP carrying its own internal service
    // credential, exactly as it does when it runs as its own service. Keeping that hop is what makes
    // the two topologies comparable: the same code path, the same credential, the same authorisation.
    const connectorConfig = loadConnectorConfig({ ...process.env, RUNTIME_API_BASE: process.env.RUNTIME_API_BASE ?? `http://127.0.0.1:${runtimeConfig.port}` });
    await app.register(mcpConnectorPlugin, { config: connectorConfig, serviceRoutes: false });
    foldedIn.push("mcp-connector");
    log.info({ auth_mode: connectorConfig.authMode }, startupBanner(connectorConfig));
  } catch (error) {
    if (error instanceof ConnectorConfigError) {
      log.fatal({ problem: error.message }, "refusing to start: SERVE_MCP_CONNECTOR is set but the connector's configuration is invalid");
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }
}

app.get("/", async () => ({
  name: "LORB Runtime API",
  status: "ok",
  environment: runtimeConfig.environment,
  folded_in: foldedIn,
  endpoints: {
    health: "/health",
    ready: "/ready",
    metrics: "/metrics",
    jwks: "/api/v1/runtime/jwks",
    repositories: "/api/v1/runtime/repositories",
    learning_objects: "/api/v1/runtime/learning-objects",
    launches: "/api/v1/runtime/launches",
    publisher: "/api/v1/publisher/learning-objects",
    evidence_statements: "/api/v1/evidence/statements",
    coach_relay: "/api/v1/relay/coach/messages",
    activity_results: "/api/v1/evidence/activity-results",
    ...(runtimeConfig.topology.serveMcpConnector ? { mcp: "/mcp" } : {}),
    ...(runtimeConfig.topology.serveWebApps
      ? Object.fromEntries(WEB_APPS.map((definition) => [`app_${definition.slug}`, `${webAppPrefix(definition)}/`]))
      : {}),
  },
}));

/** Liveness. Deliberately dependency-free: a failing database must not make the process be restarted. */
app.get("/health", async () => ({ status: "ok" }));

/**
 * Readiness. This is the probe a load balancer should use, and it does check dependencies: a replica
 * that cannot reach its store should stop receiving launches rather than fail them.
 */
app.get("/ready", async (_req, reply) => {
  const checks: Record<string, string> = {};
  let ready = true;
  try {
    await store.ping();
    checks.store = "ok";
  } catch (error) {
    checks.store = (error as Error).message.slice(0, 200);
    ready = false;
  }
  checks.persistence = store.kind;
  checks.signing_key = ring.activeKid;
  if (runtimeConfig.production && store.kind !== "postgres") {
    checks.persistence = "in-memory state is not a system of record";
    ready = false;
  }
  return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
});

if (runtimeConfig.metricsEnabled) {
  app.get("/metrics", async (_req, reply) =>
    reply.type(metricsRegistry.contentType).send(await metricsRegistry.metrics()));
}

let forwarder: ForwarderHandle | undefined;
if (runtimeConfig.forwarder.enabled && runtimeConfig.lrs.endpoint) {
  forwarder = startForwarder(httpSender(runtimeConfig.lrs), { store, forwarder: runtimeConfig.forwarder });
  log.info({ endpoint: new URL(runtimeConfig.lrs.endpoint).origin }, "evidence forwarder started");
} else {
  log.warn("evidence forwarder is not running: no learning record store endpoint is configured");
}

/**
 * Housekeeping the store cannot do for itself: terminate attempts whose session window has passed,
 * and drop idempotency records that have expired. Both are cheap, idempotent and safe to run on
 * every replica.
 */
const MAINTENANCE_INTERVAL_MS = Number.parseInt(process.env.MAINTENANCE_INTERVAL_MS ?? "60000", 10);
const maintenance = setInterval(() => {
  void (async () => {
    try {
      const expired = await store.expireStaleAttempts();
      const purged = await store.purgeExpiredIdempotency();
      if (expired > 0 || purged > 0) log.info({ expired_attempts: expired, purged_idempotency: purged }, "maintenance");
    } catch (error) {
      log.error({ err: { message: (error as Error).message } }, "maintenance pass failed");
    }
  })();
}, MAINTENANCE_INTERVAL_MS);
maintenance.unref();

const port = runtimeConfig.port;

/**
 * Graceful shutdown. In-flight requests are allowed to finish before the process exits, because a
 * launch cut off mid-flight is an attempt row with no descriptor delivered to anyone.
 */
let shuttingDown = false;
const stop = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  clearInterval(maintenance);
  await forwarder?.stop();
  await app.close();
  await store.close().catch(() => undefined);
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  log.error({ err: { message: reason instanceof Error ? reason.message : String(reason) } }, "unhandled rejection");
});

await app.listen({ host: "0.0.0.0", port });
log.info({
  port,
  environment: runtimeConfig.environment,
  persistence: store.kind,
  identity_issuer: runtimeConfig.identity.issuer,
  signing_kid: ring.activeKid,
  consumer_origins: runtimeConfig.allowedConsumerOrigins.length,
  folded_in: foldedIn,
}, "LORB Runtime API listening");
