// STUB — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08, BLK-09, BLK-11. Administration workspace Wave 1.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AdminRouteContext, correlationOf, requireAdmin, requireIdempotencyKey, sendAdminError, withAdminTransaction, writeAudit, AdminAuthError } from "./shared.js";
import { approvalRequiredFor } from "../../services/admin-authz.js";
import { createApprovalRequest } from "../../services/approval-service.js";
import { adminDbPool } from "../../db/pool.js";

const createPolicySchema = z.object({ display_name: z.string().min(3).max(120) }).strict();

const ruleSchema = z
  .object({
    priority: z.number().int().min(0).max(999),
    match: z
      .object({
        consumer_id: z.string().optional(),
        repository_id: z.string().uuid().optional(),
        delivery_profile: z.literal("native-web-package").optional(),
        launch_mode: z.literal("embedded-iframe").optional(),
      })
      .strict(),
    route: z.object({ player_id: z.string().uuid(), player_version_id: z.string().uuid() }).strict(),
    effective_at: z.string().datetime().optional(),
    expires_at: z.string().datetime().optional(),
  })
  .strict();
const rulesSchema = z.object({ rules: z.array(ruleSchema).min(1).max(10) }).strict();
const createVersionSchema = z.object({ semver: z.string().regex(/^\d+\.\d+\.\d+$/), rules: rulesSchema }).strict();

export function registerAdminLaunchPolicyRoutes(app: FastifyInstance, ctx: AdminRouteContext) {
  app.get("/api/v1/admin/launch-policies", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "launch_policy.list", "launch_policy");
    if (!principal) return;
    const rows = await adminDbPool().query("select * from launch_policy order by created_at desc");
    return { items: rows.rows, next_cursor: null, correlation_id: correlationOf(req) };
  });

  app.get<{ Params: { launchPolicyId: string } }>("/api/v1/admin/launch-policies/:launchPolicyId", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "launch_policy.get", "launch_policy");
    if (!principal) return;
    const correlation = correlationOf(req);
    const policy = await adminDbPool().query("select * from launch_policy where launch_policy_id = $1", [req.params.launchPolicyId]);
    if (!policy.rows[0]) return sendAdminError(reply, "LAUNCH_POLICY_NOT_FOUND", correlation);
    const versions = await adminDbPool().query("select * from launch_policy_version where launch_policy_id = $1 order by published_at desc nulls first", [req.params.launchPolicyId]);
    return { ...policy.rows[0], versions: versions.rows, correlation_id: correlation };
  });

  app.post("/api/v1/admin/launch-policies", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "launch_policy.create", "launch_policy");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const parsed = createPolicySchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
    const launchPolicyId = randomUUID();
    await withAdminTransaction(async (client) => {
      await client.query("insert into launch_policy (launch_policy_id, display_name, owner_pseudonym, status) values ($1,$2,$3,'DRAFT')", [launchPolicyId, parsed.data.display_name, principal.pseudonym]);
      await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "launch_policy.create", targetType: "launch_policy", targetId: launchPolicyId, resultingState: parsed.data, outcome: "ALLOWED", correlationId: correlation });
    });
    return reply.code(201).send({ launch_policy_id: launchPolicyId, display_name: parsed.data.display_name, status: "DRAFT", correlation_id: correlation });
  });

  app.post<{ Params: { launchPolicyId: string } }>("/api/v1/admin/launch-policies/:launchPolicyId/versions", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "launch_policy_version.create", "launch_policy_version");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const parsed = createVersionSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "LAUNCH_POLICY_RULES_INVALID", correlation);
    try {
      const launchPolicyVersionId = await withAdminTransaction(async (client) => {
        const policy = await client.query("select launch_policy_id from launch_policy where launch_policy_id = $1", [req.params.launchPolicyId]);
        if (!policy.rows[0]) throw new AdminAuthError("LAUNCH_POLICY_NOT_FOUND");
        const launchPolicyVersionId = randomUUID();
        await client.query(
          "insert into launch_policy_version (launch_policy_version_id, launch_policy_id, semver, rules, status, correlation_id) values ($1,$2,$3,$4,'DRAFT',$5)",
          [launchPolicyVersionId, req.params.launchPolicyId, parsed.data.semver, JSON.stringify(parsed.data.rules), correlation],
        );
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "launch_policy_version.create", targetType: "launch_policy_version", targetId: launchPolicyVersionId, resultingState: { semver: parsed.data.semver }, outcome: "ALLOWED", correlationId: correlation });
        return launchPolicyVersionId;
      });
      return reply.code(201).send({ launch_policy_version_id: launchPolicyVersionId, status: "DRAFT", correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  type Transition = { actionType: "launch_policy_version.publish" | "launch_policy_version.activate" };
  async function requestVersionTransition(transition: Transition, req: any, reply: any) {
    const principal = await requireAdmin(req, reply, ctx, transition.actionType, "launch_policy_version");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const versionId = req.params.versionId as string;
    try {
      const approvalRequestId = await withAdminTransaction(async (client) => {
        const version = await client.query("select status from launch_policy_version where launch_policy_version_id = $1 and launch_policy_id = $2", [versionId, req.params.launchPolicyId]);
        if (!version.rows[0]) throw new AdminAuthError("LAUNCH_POLICY_NOT_FOUND");
        if (transition.actionType === "launch_policy_version.publish" && version.rows[0].status !== "DRAFT") throw new AdminAuthError("LAUNCH_POLICY_VERSION_IMMUTABLE");
        if (transition.actionType === "launch_policy_version.activate" && version.rows[0].status !== "PUBLISHED") throw new AdminAuthError("LAUNCH_POLICY_VERSION_IMMUTABLE");
        if (!approvalRequiredFor(transition.actionType)) throw new AdminAuthError("ADMIN_REQUEST_INVALID");
        const id = await createApprovalRequest(client, { actionType: transition.actionType, targetType: "launch_policy_version", targetId: versionId, requestedByPseudonym: principal.pseudonym, correlationId: correlation, detail: { launch_policy_id: req.params.launchPolicyId } });
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: transition.actionType, targetType: "launch_policy_version", targetId: versionId, outcome: "ALLOWED", reason: "APPROVAL_REQUESTED", approvalRequestId: id, correlationId: correlation });
        return id;
      });
      return reply.code(202).send({ approval_request_id: approvalRequestId, status: "PENDING", correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  }

  app.post<{ Params: { launchPolicyId: string; versionId: string } }>("/api/v1/admin/launch-policies/:launchPolicyId/versions/:versionId/publish", (req, reply) => requestVersionTransition({ actionType: "launch_policy_version.publish" }, req, reply));
  app.post<{ Params: { launchPolicyId: string; versionId: string } }>("/api/v1/admin/launch-policies/:launchPolicyId/versions/:versionId/activate", (req, reply) => requestVersionTransition({ actionType: "launch_policy_version.activate" }, req, reply));
}
