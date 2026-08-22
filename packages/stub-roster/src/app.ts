// STUB — NOT PRODUCTION — BLOCKED BY BLK-02, BLK-03, BLK-07. See STUB.md.
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { classSummary, stubClassById, STUB_CLASSES } from "./seed.js";

const NOT_FOUND = { code: "CLASS_NOT_FOUND" } as const;

/** Builds the synthetic roster app. No authentication: it serves only synthetic data and is never
 * exposed outside a local dev or Railway review environment. */
export async function buildRoster() {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  const envelope = (items: unknown[], req: { headers: Record<string, unknown> }) => ({
    items,
    next_cursor: null,
    correlation_id: typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID(),
  });
  app.get("/health", async () => ({ status: "ok", stub: true, production: false }));
  app.get("/classes", async (req: any) => envelope(STUB_CLASSES.map(classSummary), req));
  app.get("/classes/:classId", async (req: any, reply) => {
    const entry = stubClassById.get(req.params.classId);
    return entry ? classSummary(entry) : reply.code(404).send(NOT_FOUND);
  });
  app.get("/classes/:classId/recent-topics", async (req: any, reply) => {
    const entry = stubClassById.get(req.params.classId);
    if (!entry) return reply.code(404).send(NOT_FOUND);
    return { class_id: entry.class_id, subject: entry.subject, year_group: entry.year_group, topics: entry.recent_topics };
  });
  // The roster is the only place synthetic learner identifiers are handed out. Callers must convert
  // them into LORB pseudonyms through the Runtime API rather than storing them against evidence.
  app.get("/classes/:classId/roster", async (req: any, reply) => {
    const entry = stubClassById.get(req.params.classId);
    if (!entry) return reply.code(404).send(NOT_FOUND);
    return { class_id: entry.class_id, learners: entry.learners };
  });
  return app;
}
