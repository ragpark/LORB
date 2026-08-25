// The internal roster projection, scoped to the teacher an agent principal is linked to.
// See 006_agent_principal_link.sql for why that link is explicit rather than inferred.
// Read-only roster projection for the MCP connector, behind the internal service token. The agent
// surface can discover classes and resolve a roster for assignment; it cannot create or change one.
// Writes live on the administrator-authenticated /api/v1/admin/classes routes and nowhere else.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { adminDbPool } from "../../db/pool.js";

const correlationOf = (req: any): string =>
  typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID();

const notFound = (reply: any) => reply.code(404).send({ code: "CLASS_NOT_FOUND" });

/**
 * Resolves the calling agent principal to the teacher whose classes it may read.
 *
 * The connector's service token authenticates the *connector*, not the person using it, so on its
 * own it cannot scope anything: one credential serves every agent session. The connector therefore
 * forwards the principal it verified, and this resolves it through an explicit link the teacher
 * created. No link, no access — an unlinked principal sees an empty roster rather than everyone's.
 */
async function teacherFor(req: any): Promise<string | undefined> {
  const issuer = req.headers["x-lorb-agent-issuer"];
  const subject = req.headers["x-lorb-agent-subject"];
  if (typeof issuer !== "string" || typeof subject !== "string" || !issuer || !subject) return undefined;
  const result = await adminDbPool().query(
    "select teacher_pseudonym from agent_principal_link where agent_issuer = $1 and agent_subject = $2 and revoked_at is null",
    [issuer, subject],
  );
  return result.rows[0]?.teacher_pseudonym as string | undefined;
}

export function registerInternalRosterRoutes(
  app: FastifyInstance,
  guard: (req: any, reply: any, correlation: string) => boolean,
) {
  app.get("/api/v1/internal/roster/classes", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const teacher = await teacherFor(req);
    // `linked` distinguishes "this assistant is not linked to anyone" from "it is linked and that
    // teacher has no classes". Both return an empty list, and without this the difference is
    // invisible — which is exactly the dead end an unlinked assistant used to hit.
    if (!teacher) return { items: [], linked: false, next_cursor: null, correlation_id: correlation };
    const rows = (await adminDbPool().query(
      `select c.class_id, c.name, c.year_group, c.subject,
              (select count(*)::int from class_learner l where l.class_id = c.class_id) as learner_count
       from class c where c.status = 'ACTIVE' and c.created_by_pseudonym = $1 order by c.name`,
      [teacher],
    )).rows;
    return { items: rows, linked: true, next_cursor: null, correlation_id: correlation };
  });

  // Summary only: name, year group, subject and a count. No learner names or identifiers, matching
  // what the class:// resource has always promised an agent it would see.
  app.get<{ Params: { classId: string } }>("/api/v1/internal/roster/classes/:classId", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const teacher = await teacherFor(req);
    if (!teacher) return notFound(reply);
    const found = await adminDbPool().query(
      `select c.class_id, c.name, c.year_group, c.subject,
              (select count(*)::int from class_learner l where l.class_id = c.class_id) as learner_count
       from class c where c.class_id = $1 and c.status = 'ACTIVE' and c.created_by_pseudonym = $2`,
      [req.params.classId, teacher],
    );
    return found.rows[0] ?? notFound(reply);
  });

  app.get<{ Params: { classId: string } }>("/api/v1/internal/roster/classes/:classId/recent-topics", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const teacher = await teacherFor(req);
    if (!teacher) return notFound(reply);
    const found = await adminDbPool().query(
      "select class_id, subject, year_group from class where class_id = $1 and status = 'ACTIVE' and created_by_pseudonym = $2",
      [req.params.classId, teacher],
    );
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
    const teacher = await teacherFor(req);
    if (!teacher) return notFound(reply);
    const found = await adminDbPool().query(
      "select 1 from class where class_id = $1 and status = 'ACTIVE' and created_by_pseudonym = $2",
      [req.params.classId, teacher],
    );
    if (!found.rowCount) return notFound(reply);
    const learners = (await adminDbPool().query(
      "select learner_ref as learner_id from class_learner where class_id = $1 order by learner_ref",
      [req.params.classId],
    )).rows;
    return { class_id: req.params.classId, learners, correlation_id: correlation };
  });
}
