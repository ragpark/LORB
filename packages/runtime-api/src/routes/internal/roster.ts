// NOT PRODUCTION — BLK-02, BLK-03 and BLK-07 ARE IMPLICATED. See 004_roster.sql.
// Read-only roster projection for the MCP connector, behind the internal service token. The agent
// surface can discover classes and resolve a roster for assignment; it cannot create or change one.
// Writes live on the administrator-authenticated /api/v1/admin/classes routes and nowhere else.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { adminDbPool } from "../../db/pool.js";

const correlationOf = (req: any): string =>
  typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID();

const notFound = (reply: any) => reply.code(404).send({ code: "CLASS_NOT_FOUND" });

export function registerInternalRosterRoutes(
  app: FastifyInstance,
  guard: (req: any, reply: any, correlation: string) => boolean,
) {
  app.get("/api/v1/internal/roster/classes", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const rows = (await adminDbPool().query(
      `select c.class_id, c.name, c.year_group, c.subject,
              (select count(*)::int from class_learner l where l.class_id = c.class_id) as learner_count
       from class c where c.status = 'ACTIVE' order by c.name`,
    )).rows;
    return { items: rows, next_cursor: null, correlation_id: correlation };
  });

  // Summary only: name, year group, subject and a count. No learner names or identifiers, matching
  // what the class:// resource has always promised an agent it would see.
  app.get<{ Params: { classId: string } }>("/api/v1/internal/roster/classes/:classId", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const found = await adminDbPool().query(
      `select c.class_id, c.name, c.year_group, c.subject,
              (select count(*)::int from class_learner l where l.class_id = c.class_id) as learner_count
       from class c where c.class_id = $1 and c.status = 'ACTIVE'`,
      [req.params.classId],
    );
    return found.rows[0] ?? notFound(reply);
  });

  app.get<{ Params: { classId: string } }>("/api/v1/internal/roster/classes/:classId/recent-topics", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const found = await adminDbPool().query("select class_id, subject, year_group from class where class_id = $1 and status = 'ACTIVE'", [req.params.classId]);
    if (!found.rows[0]) return notFound(reply);
    const topics = (await adminDbPool().query(
      "select topic, to_char(taught_on,'YYYY-MM-DD') as taught_on, summary from class_topic where class_id = $1 order by taught_on desc limit 20",
      [req.params.classId],
    )).rows;
    return { ...found.rows[0], topics, correlation_id: correlation };
  });

  // The one place learner identifiers are handed out, and only to a service-token caller that is
  // about to convert them into pseudonyms through the Runtime API's own launch path. Display names
  // are deliberately withheld: the agent has no use for them and they are the roster's only PII.
  app.get<{ Params: { classId: string } }>("/api/v1/internal/roster/classes/:classId/roster", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const found = await adminDbPool().query("select 1 from class where class_id = $1 and status = 'ACTIVE'", [req.params.classId]);
    if (!found.rowCount) return notFound(reply);
    const learners = (await adminDbPool().query(
      "select learner_ref as learner_id from class_learner where class_id = $1 order by learner_ref",
      [req.params.classId],
    )).rows;
    return { class_id: req.params.classId, learners, correlation_id: correlation };
  });
}
