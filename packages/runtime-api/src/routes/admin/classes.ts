// NOT PRODUCTION — BLK-02, BLK-03 and BLK-07 ARE IMPLICATED. See 004_roster.sql and stub-roster/STUB.md.
// Roster administration: classes, their learners, assignment of a learning object to a whole class,
// and the class-level results read-model. Writes are web-only and administrator-authenticated; the
// MCP connector reads this roster through the internal service-token routes and cannot change it.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type AdminPrincipal,
  type AdminRouteContext,
  AdminAuthError,
  correlationOf,
  requireAdmin,
  requireIdempotencyKey,
  sendAdminError,
  withAdminTransaction,
  writeAudit,
} from "./shared.js";
import { adminDbPool } from "../../db/pool.js";
import { computePseudonym } from "../../services/pseudonym-service.js";
import { catalogue as defaultCatalogue, type CatalogueStore } from "../../catalogue/index.js";
import { store as defaultStore, type RuntimeStore } from "../../store/index.js";
import { resultsByPseudonym } from "../../../../evidence-api/src/read-model.js";

/** The identifier shape the synthetic IES accepts, so a roster entry and that learner's own login
 *  derive the same pseudonym. Deliberately narrower than a free-text field: an identifier that
 *  cannot round-trip through the IES would produce evidence nobody could ever attribute. */
const LEARNER_REF = /^[A-Za-z\d._:-]{1,128}$/;

const createClassSchema = z.object({
  name: z.string().min(1).max(120),
  year_group: z.string().max(40).optional(),
  subject: z.string().max(80).optional(),
}).strict();

const addLearnersSchema = z.object({
  learners: z.array(z.object({
    learner_ref: z.string().regex(LEARNER_REF),
    display_name: z.string().min(1).max(120),
  }).strict()).min(1).max(200),
}).strict();

const addTopicsSchema = z.object({
  topics: z.array(z.object({
    topic: z.string().min(1).max(120),
    taught_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    summary: z.string().max(600).optional(),
  }).strict()).min(1).max(50),
}).strict();

const assignSchema = z.object({ object_id: z.string().uuid() }).strict();

const linkAgentSchema = z.object({
  agent_issuer: z.string().min(1).max(256),
  agent_subject: z.string().min(1).max(256),
  label: z.string().max(120).optional(),
}).strict();

export interface ClassRouteContext extends AdminRouteContext {
  /** The same secret, issuer and purpose the IES-authenticated launch path uses. Results are joined
   *  to a class by recomputing pseudonyms with these; no mapping table is kept. */
  iesIssuer: string;
  tenantSecret: Buffer;
}

interface RosterEntry { learner_ref: string; display_name: string; pseudonym: string }

/** Pairs each roster learner with the pseudonym the launch path would derive for them, using the
 *  same secret, issuer and purpose. Held only for the life of one request. */
const withPseudonyms = (ctx: ClassRouteContext, learners: Array<{ learner_ref: string; display_name: string }>): RosterEntry[] =>
  learners.map((learner) => ({ ...learner, pseudonym: computePseudonym(ctx.tenantSecret, ctx.iesIssuer, learner.learner_ref, "launch") }));

/**
 * Every class operation is scoped to the principal that created it. `requireAdmin` alone only
 * proves the caller is *an* administrator, which in a multi-teacher tenant would let one teacher
 * read another's learner names and edit their roster — the roster is the one place this system
 * holds personal data, so that is a confidentiality failure, not an inconvenience.
 *
 * A class the caller does not own reports CLASS_NOT_FOUND rather than a 403, so the endpoint does
 * not confirm that someone else's class id exists.
 */
async function ownedClass(classId: string, principal: AdminPrincipal): Promise<boolean> {
  const result = await adminDbPool().query(
    principal.platformAdmin
      ? "select 1 from class where class_id = $1"
      : "select 1 from class where class_id = $1 and created_by_pseudonym = $2",
    principal.platformAdmin ? [classId] : [classId, principal.pseudonym],
  );
  return (result.rowCount ?? 0) > 0;
}

export function registerAdminClassRoutes(app: FastifyInstance, ctx: ClassRouteContext, deps: { catalogue?: CatalogueStore; store?: RuntimeStore } = {}) {
  const catalogue = deps.catalogue ?? defaultCatalogue();
  const store = deps.store ?? defaultStore();
  app.get("/api/v1/admin/classes", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "class.list", "class");
    if (!principal) return;
    // The UI calls these "your classes", and so does this query.
    const rows = (await adminDbPool().query(
      `select c.class_id, c.name, c.year_group, c.subject, c.status, c.created_at,
              (select count(*)::int from class_learner l where l.class_id = c.class_id) as learner_count
       from class c
       where c.status = 'ACTIVE' and ($1::boolean or c.created_by_pseudonym = $2)
       order by c.created_at desc`,
      [principal.platformAdmin, principal.pseudonym],
    )).rows;
    return { items: rows, next_cursor: null, correlation_id: correlationOf(req) };
  });

  app.get<{ Params: { classId: string } }>("/api/v1/admin/classes/:classId", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "class.get", "class");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!(await ownedClass(req.params.classId, principal))) return sendAdminError(reply, "CLASS_NOT_FOUND", correlation);
    const found = await adminDbPool().query("select * from class where class_id = $1", [req.params.classId]);
    if (!found.rows[0]) return sendAdminError(reply, "CLASS_NOT_FOUND", correlation);
    const learners = (await adminDbPool().query(
      "select learner_ref, display_name, added_at from class_learner where class_id = $1 order by display_name",
      [req.params.classId],
    )).rows;
    const topics = (await adminDbPool().query(
      "select topic, taught_on, summary from class_topic where class_id = $1 order by taught_on desc limit 20",
      [req.params.classId],
    )).rows;
    return { ...found.rows[0], learners, topics, correlation_id: correlation };
  });

  app.post("/api/v1/admin/classes", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "class.create", "class");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const parsed = createClassSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "CLASS_REQUEST_INVALID", correlation);
    // A retry after a lost response must return the original class, not create a second one.
    const replayed = await adminDbPool().query(
      "select class_id, name, year_group, subject, status from class where created_by_pseudonym = $1 and idempotency_key = $2",
      [principal.pseudonym, idempotencyKey],
    );
    if (replayed.rows[0]) return reply.code(201).send({ ...replayed.rows[0], replayed: true, correlation_id: correlation });
    const classId = randomUUID();
    await withAdminTransaction(async (client) => {
      await client.query(
        "insert into class (class_id, name, year_group, subject, created_by_pseudonym, idempotency_key) values ($1,$2,$3,$4,$5,$6)",
        [classId, parsed.data.name, parsed.data.year_group ?? null, parsed.data.subject ?? null, principal.pseudonym, idempotencyKey],
      );
      await writeAudit(client, {
        actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "class.create",
        targetType: "class", targetId: classId,
        // The class name is curriculum metadata. Learner details are never written to the audit log.
        resultingState: { name: parsed.data.name, year_group: parsed.data.year_group, subject: parsed.data.subject },
        outcome: "ALLOWED", correlationId: correlation,
      });
    });
    return reply.code(201).send({ class_id: classId, ...parsed.data, status: "ACTIVE", replayed: false, correlation_id: correlation });
  });

  app.post<{ Params: { classId: string } }>("/api/v1/admin/classes/:classId/learners", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "class.learners.add", "class");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;
    if (!(await ownedClass(req.params.classId, principal))) return sendAdminError(reply, "CLASS_NOT_FOUND", correlation);
    const parsed = addLearnersSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "LEARNER_REF_INVALID", correlation);
    try {
      const added = await withAdminTransaction(async (client) => {
        const exists = await client.query("select 1 from class where class_id = $1 and status = 'ACTIVE'", [req.params.classId]);
        if (!exists.rowCount) throw new AdminAuthError("CLASS_NOT_FOUND");
        let added = 0;
        for (const learner of parsed.data.learners) {
          const result = await client.query(
            `insert into class_learner (class_id, learner_ref, display_name, added_by_pseudonym)
             values ($1,$2,$3,$4) on conflict (class_id, learner_ref) do nothing`,
            [req.params.classId, learner.learner_ref, learner.display_name, principal.pseudonym],
          );
          added += result.rowCount ?? 0;
        }
        await writeAudit(client, {
          actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "class.learners.add",
          targetType: "class", targetId: req.params.classId,
          // Count only. Writing the identifiers or names here would put roster PII in the audit log.
          resultingState: { added, submitted: parsed.data.learners.length },
          outcome: "ALLOWED", correlationId: correlation,
        });
        return added;
      });
      return reply.code(201).send({ class_id: req.params.classId, added, correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  app.delete<{ Params: { classId: string; learnerRef: string } }>("/api/v1/admin/classes/:classId/learners/:learnerRef", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "class.learners.remove", "class");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!(await ownedClass(req.params.classId, principal))) return sendAdminError(reply, "CLASS_NOT_FOUND", correlation);
    const removed = await withAdminTransaction(async (client) => {
      const result = await client.query("delete from class_learner where class_id = $1 and learner_ref = $2", [req.params.classId, req.params.learnerRef]);
      await writeAudit(client, {
        actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "class.learners.remove",
        targetType: "class", targetId: req.params.classId, resultingState: { removed: result.rowCount ?? 0 },
        outcome: "ALLOWED", correlationId: correlation,
      });
      return result.rowCount ?? 0;
    });
    if (!removed) return sendAdminError(reply, "LEARNER_NOT_FOUND", correlation);
    return reply.code(204).send();
  });

  app.post<{ Params: { classId: string } }>("/api/v1/admin/classes/:classId/topics", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "class.topics.add", "class");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;
    if (!(await ownedClass(req.params.classId, principal))) return sendAdminError(reply, "CLASS_NOT_FOUND", correlation);
    const parsed = addTopicsSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "CLASS_REQUEST_INVALID", correlation);
    try {
      await withAdminTransaction(async (client) => {
        const exists = await client.query("select 1 from class where class_id = $1 and status = 'ACTIVE'", [req.params.classId]);
        if (!exists.rowCount) throw new AdminAuthError("CLASS_NOT_FOUND");
        for (const topic of parsed.data.topics) {
          await client.query(
            "insert into class_topic (class_topic_id, class_id, topic, taught_on, summary) values ($1,$2,$3,$4,$5)",
            [randomUUID(), req.params.classId, topic.topic, topic.taught_on, topic.summary ?? ""],
          );
        }
        await writeAudit(client, {
          actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "class.topics.add",
          targetType: "class", targetId: req.params.classId, resultingState: { added: parsed.data.topics.length },
          outcome: "ALLOWED", correlationId: correlation,
        });
      });
      return reply.code(201).send({ class_id: req.params.classId, added: parsed.data.topics.length, correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  /** Assign a published learning object to every learner currently in the class. Records the
   *  assignment only — learners launch through their usual signed-in path, which mints the
   *  descriptor at the moment they open the activity. No shareable link is created. */
  app.post<{ Params: { classId: string } }>("/api/v1/admin/classes/:classId/assignments", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "class.assign", "class");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    if (!(await ownedClass(req.params.classId, principal))) return sendAdminError(reply, "CLASS_NOT_FOUND", correlation);
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "CLASS_REQUEST_INVALID", correlation);
    // The replay lookup runs before the object is validated, and returns the object that was
    // actually assigned. Re-validating the *new* body on a replay would let a retry carrying a
    // different or since-retired object fail a request that already succeeded, and answering with
    // the new object against the original assignment id would describe an assignment that never
    // happened.
    const replayed = await adminDbPool().query(
      "select assignment_id, object_id, learner_count from class_assignment where class_id = $1 and idempotency_key = $2",
      [req.params.classId, idempotencyKey],
    );
    if (replayed.rows[0]) {
      return reply.code(201).send({ ...replayed.rows[0], replayed: true, class_id: req.params.classId, correlation_id: correlation });
    }
    const object = await catalogue.learningObject(parsed.data.object_id);
    if (!object) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
    if (object.status !== "PUBLISHED") return sendAdminError(reply, "LEARNING_OBJECT_NOT_PUBLISHED", correlation);
    try {
      const result = await withAdminTransaction(async (client) => {
        const exists = await client.query("select 1 from class where class_id = $1 and status = 'ACTIVE'", [req.params.classId]);
        if (!exists.rowCount) throw new AdminAuthError("CLASS_NOT_FOUND");
        const learners = await client.query("select learner_ref from class_learner where class_id = $1", [req.params.classId]);
        if (!learners.rowCount) throw new AdminAuthError("CLASS_EMPTY");
        const assignmentId = randomUUID();
        await client.query(
          "insert into class_assignment (assignment_id, class_id, object_id, assigned_by_pseudonym, idempotency_key, learner_count) values ($1,$2,$3,$4,$5,$6)",
          [assignmentId, req.params.classId, parsed.data.object_id, principal.pseudonym, idempotencyKey, learners.rowCount],
        );
        // Who was in the class at this moment. Results are built from this, not from the live
        // roster, so later joiners are not shown as having missed work and later leavers do not
        // silently drop out of a record that still counts them.
        for (const row of learners.rows as Array<{ learner_ref: string }>) {
          await client.query("insert into class_assignment_learner (assignment_id, learner_ref) values ($1,$2)", [assignmentId, row.learner_ref]);
        }
        await writeAudit(client, {
          actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "class.assign",
          targetType: "class", targetId: req.params.classId,
          resultingState: { assignment_id: assignmentId, object_id: parsed.data.object_id, learner_count: learners.rowCount },
          outcome: "ALLOWED", correlationId: correlation,
        });
        return { assignment_id: assignmentId, object_id: parsed.data.object_id, learner_count: learners.rowCount, replayed: false };
      });
      // object_id comes from `result`, which is the stored value on a replay.
      return reply.code(201).send({ ...result, class_id: req.params.classId, correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  // ---------------------------------------------------------------- agent principals
  //
  // A teacher links the AI assistant they use to their own LORB account. Until they do, that
  // assistant sees no classes at all — the connector holds one service credential for every agent
  // session, so it cannot scope anything by itself.
  //
  // A principal can only ever be linked to the pseudonym of the teacher making the request. There
  // is deliberately no route that links a principal to somebody else's classes.

  app.get("/api/v1/admin/agent-links", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "agent_link.list", "agent_link");
    if (!principal) return;
    const rows = (await adminDbPool().query(
      "select agent_issuer, agent_subject, label, linked_at from agent_principal_link where teacher_pseudonym = $1 and revoked_at is null order by linked_at desc",
      [principal.pseudonym],
    )).rows;
    return { items: rows, next_cursor: null, correlation_id: correlationOf(req) };
  });

  app.post("/api/v1/admin/agent-links", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "agent_link.create", "agent_link");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;
    const parsed = linkAgentSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "AGENT_LINK_INVALID", correlation);
    try {
      await withAdminTransaction(async (client) => {
        // One principal, one teacher. Re-pointing a live link at a different account would silently
        // move an assistant's roster access, so it must be revoked by its owner first.
        //
        // The ownership condition lives in the conflicting write, not in a preceding SELECT. Two
        // teachers claiming the same unlinked principal at once would both see no active row and
        // both proceed, and an unconditional DO UPDATE would let the later one take the link the
        // earlier one had just won. Postgres locks the conflicting row for the duration of the
        // upsert, so deciding there makes the claim atomic: the loser updates nothing.
        const claimed = await client.query(
          `insert into agent_principal_link (agent_issuer, agent_subject, teacher_pseudonym, label, revoked_at)
           values ($1,$2,$3,$4,null)
           on conflict (agent_issuer, agent_subject)
           do update set teacher_pseudonym = excluded.teacher_pseudonym, label = excluded.label, revoked_at = null, linked_at = now()
           where agent_principal_link.revoked_at is not null
              or agent_principal_link.teacher_pseudonym = excluded.teacher_pseudonym`,
          [parsed.data.agent_issuer, parsed.data.agent_subject, principal.pseudonym, parsed.data.label ?? ""],
        );
        if (!claimed.rowCount) throw new AdminAuthError("AGENT_LINK_TAKEN");
        await writeAudit(client, {
          actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "agent_link.create",
          targetType: "agent_link", resultingState: { agent_issuer: parsed.data.agent_issuer, label: parsed.data.label },
          outcome: "ALLOWED", correlationId: correlation,
        });
      });
      return reply.code(201).send({ ...parsed.data, correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  app.delete<{ Params: { issuer: string; subject: string } }>("/api/v1/admin/agent-links/:issuer/:subject", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "agent_link.revoke", "agent_link");
    if (!principal) return;
    const correlation = correlationOf(req);
    const revoked = await withAdminTransaction(async (client) => {
      const result = await client.query(
        "update agent_principal_link set revoked_at = now() where agent_issuer = $1 and agent_subject = $2 and teacher_pseudonym = $3 and revoked_at is null",
        [req.params.issuer, req.params.subject, principal.pseudonym],
      );
      await writeAudit(client, {
        actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "agent_link.revoke",
        targetType: "agent_link", resultingState: { revoked: result.rowCount ?? 0 }, outcome: "ALLOWED", correlationId: correlation,
      });
      return result.rowCount ?? 0;
    });
    if (!revoked) return sendAdminError(reply, "AGENT_LINK_NOT_FOUND", correlation);
    return reply.code(204).send();
  });

  /** Results for one class, taken from the evidence outbox. The outbox holds pseudonymous actors
   *  only, so the join runs the other way: recompute each roster learner's pseudonym and look for it
   *  in the aggregate. The mapping exists for the duration of this request and is never stored. */
  app.get<{ Params: { classId: string } }>("/api/v1/admin/classes/:classId/results", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "class.results", "class");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!(await ownedClass(req.params.classId, principal))) return sendAdminError(reply, "CLASS_NOT_FOUND", correlation);
    const assignments = (await adminDbPool().query(
      "select assignment_id, object_id, learner_count, created_at from class_assignment where class_id = $1 order by created_at desc",
      [req.params.classId],
    )).rows;
    // Display names come from the live roster; membership comes from each assignment's snapshot.
    const namesByRef = new Map((await adminDbPool().query(
      "select learner_ref, display_name from class_learner where class_id = $1",
      [req.params.classId],
    )).rows.map((row: { learner_ref: string; display_name: string }) => [row.learner_ref, row.display_name]));

    const items = await Promise.all(assignments.map(async (assignment: { object_id: string; assignment_id: string; created_at: Date | string; learner_count: number }) => {
      const assignedAt = assignment.created_at instanceof Date ? assignment.created_at.toISOString() : assignment.created_at;
      const membership = (await adminDbPool().query(
        "select learner_ref from class_assignment_learner where assignment_id = $1 order by learner_ref",
        [assignment.assignment_id],
      )).rows as Array<{ learner_ref: string }>;
      const roster = withPseudonyms(ctx, membership.map((row) => ({
        learner_ref: row.learner_ref,
        // A learner removed from the class after being assigned still belongs in this record.
        display_name: namesByRef.get(row.learner_ref) ?? "(removed from class)",
      })));
      const byPseudonym = await resultsByPseudonym(assignment.object_id, assignedAt, store);
      const learnerResults = roster.map((learner) => {
        const result = byPseudonym.get(learner.pseudonym);
        return {
          learner_ref: learner.learner_ref,
          display_name: learner.display_name,
          attempted: result?.attempted ?? false,
          completed: result?.completed ?? false,
          scaled: result?.scaled ?? null,
        };
      });
      return {
        assignment_id: assignment.assignment_id,
        object_id: assignment.object_id,
        assigned_at: assignedAt,
        learner_count: assignment.learner_count,
        attempted_count: learnerResults.filter((r) => r.attempted).length,
        learners: learnerResults,
      };
    }));
    return { class_id: req.params.classId, items, correlation_id: correlation };
  });
}
