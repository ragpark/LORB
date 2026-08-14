// STUB — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08, BLK-09, BLK-11. Administration workspace Wave 1 read-only audit trail.
import type { FastifyInstance } from "fastify";
import { type AdminRouteContext, correlationOf, requireAdmin, sendAdminError } from "./shared.js";
import { adminDbPool } from "../../db/pool.js";

interface AuditQuery {
  target_type?: string;
  target_id?: string;
  actor_pseudonym?: string;
  action_type?: string;
  outcome?: string;
  limit?: string;
  cursor?: string;
}

export function registerAdminAuditRoutes(app: FastifyInstance, ctx: AdminRouteContext) {
  app.get<{ Querystring: AuditQuery }>("/api/v1/admin/audit-records", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "audit.list", "audit_record");
    if (!principal) return;
    const correlation = correlationOf(req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    if (Number.isNaN(limit)) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
    const conditions: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ["target_type", req.query.target_type],
      ["target_id", req.query.target_id],
      ["actor_pseudonym", req.query.actor_pseudonym],
      ["action_type", req.query.action_type],
      ["outcome", req.query.outcome],
    ] as const) {
      if (value) {
        params.push(value);
        conditions.push(`${column} = $${params.length}`);
      }
    }
    if (req.query.cursor) {
      params.push(req.query.cursor);
      conditions.push(`created_at < $${params.length}`);
    }
    params.push(limit);
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const rows = await adminDbPool().query(`select * from audit_record ${where} order by created_at desc limit $${params.length}`, params);
    const items = rows.rows as { created_at: string }[];
    const nextCursor = items.length === limit ? items[items.length - 1]?.created_at ?? null : null;
    return { items, next_cursor: nextCursor, correlation_id: correlation };
  });
}
