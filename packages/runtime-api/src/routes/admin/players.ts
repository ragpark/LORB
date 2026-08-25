// Administration: player registration and the immutable player versions a launch policy routes to.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AdminRouteContext, correlationOf, requireAdmin, requireIdempotencyKey, sendAdminError, withAdminTransaction, writeAudit, AdminAuthError } from "./shared.js";
import { approvalRequiredFor } from "../../services/admin-authz.js";
import { createApprovalRequest } from "../../services/approval-service.js";
import { adminDbPool } from "../../db/pool.js";

const createPlayerSchema = z.object({ display_name: z.string().min(3).max(120) }).strict();
const registerVersionSchema = z
  .object({
    semver: z.string().regex(/^\d+\.\d+\.\d+$/),
    module_url: z.string().url(),
    module_origin: z.string().url(),
    integrity_algorithm: z.enum(["sha384", "sha256"]),
    integrity_hash: z.string().regex(/^[0-9a-f]+$/i),
    supported_descriptor_versions: z.array(z.string()).min(1),
    supported_protocol_versions: z.array(z.string()).min(1),
    supported_delivery_profiles: z.array(z.literal("native-web-package")).min(1),
    supported_launch_modes: z.array(z.literal("embedded-iframe")).min(1),
  })
  .strict();

const WEAK_ALGORITHMS = new Set(["sha256"]);

export function registerAdminPlayerRoutes(app: FastifyInstance, ctx: AdminRouteContext) {
  app.get("/api/v1/admin/players", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "player.list", "player");
    if (!principal) return;
    const rows = await adminDbPool().query("select * from player order by created_at desc");
    return { items: rows.rows, next_cursor: null, correlation_id: correlationOf(req) };
  });

  app.get<{ Params: { playerId: string } }>("/api/v1/admin/players/:playerId", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "player.get", "player");
    if (!principal) return;
    const correlation = correlationOf(req);
    const player = await adminDbPool().query("select * from player where player_id = $1", [req.params.playerId]);
    if (!player.rows[0]) return sendAdminError(reply, "PLAYER_NOT_FOUND", correlation);
    const versions = await adminDbPool().query("select * from player_version where player_id = $1 order by registered_at desc", [req.params.playerId]);
    return { ...player.rows[0], versions: versions.rows, correlation_id: correlation };
  });

  app.post("/api/v1/admin/players", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "player.create", "player");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const parsed = createPlayerSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
    const playerId = randomUUID();
    await withAdminTransaction(async (client) => {
      await client.query("insert into player (player_id, display_name, owner_pseudonym, status) values ($1,$2,$3,'REGISTERED')", [playerId, parsed.data.display_name, principal.pseudonym]);
      await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "player.create", targetType: "player", targetId: playerId, resultingState: parsed.data, outcome: "ALLOWED", correlationId: correlation });
    });
    return reply.code(201).send({ player_id: playerId, display_name: parsed.data.display_name, status: "REGISTERED", correlation_id: correlation });
  });

  app.post<{ Params: { playerId: string } }>("/api/v1/admin/players/:playerId/versions", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "player_version.register", "player_version");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const parsed = registerVersionSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
    if (WEAK_ALGORITHMS.has(parsed.data.integrity_algorithm)) return sendAdminError(reply, "PLAYER_INTEGRITY_WEAK", correlation);
    if (!ctx.playerModuleOriginAllowlist.includes(parsed.data.module_origin)) return sendAdminError(reply, "PLAYER_ORIGIN_NOT_ALLOWED", correlation);
    // module_origin being allow-listed is meaningless if module_url can point somewhere else — the
    // launch-policy resolver later hands module_url straight to the player shell as the trusted
    // package URL, so the two must actually agree.
    if (new URL(parsed.data.module_url).origin !== parsed.data.module_origin) return sendAdminError(reply, "PLAYER_ORIGIN_NOT_ALLOWED", correlation);
    try {
      const playerVersionId = await withAdminTransaction(async (client) => {
        const player = await client.query("select player_id from player where player_id = $1", [req.params.playerId]);
        if (!player.rows[0]) throw new AdminAuthError("PLAYER_NOT_FOUND");
        const playerVersionId = randomUUID();
        await client.query(
          `insert into player_version (player_version_id, player_id, semver, module_url, module_origin, integrity_algorithm, integrity_hash, supported_descriptor_versions, supported_protocol_versions, supported_delivery_profiles, supported_launch_modes, status, correlation_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'TESTING',$12)`,
          [
            playerVersionId,
            req.params.playerId,
            parsed.data.semver,
            parsed.data.module_url,
            parsed.data.module_origin,
            parsed.data.integrity_algorithm,
            parsed.data.integrity_hash,
            parsed.data.supported_descriptor_versions,
            parsed.data.supported_protocol_versions,
            parsed.data.supported_delivery_profiles,
            parsed.data.supported_launch_modes,
            correlation,
          ],
        );
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "player_version.register", targetType: "player_version", targetId: playerVersionId, resultingState: { ...parsed.data, integrity_hash: undefined }, outcome: "ALLOWED", correlationId: correlation });
        return playerVersionId;
      });
      return reply.code(201).send({ player_version_id: playerVersionId, status: "TESTING", correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  type Transition = { actionType: "player_version.approve" | "player_version.activate" | "player_version.suspend"; fromStatus: string; toStatus: string };
  const transitions: Transition[] = [
    { actionType: "player_version.approve", fromStatus: "TESTING", toStatus: "APPROVED" },
    { actionType: "player_version.activate", fromStatus: "APPROVED", toStatus: "ACTIVE" },
    { actionType: "player_version.suspend", fromStatus: "ACTIVE", toStatus: "SUSPENDED" },
  ];

  async function requestVersionTransition(transition: Transition, req: any, reply: any) {
    const principal = await requireAdmin(req, reply, ctx, transition.actionType, "player_version");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const playerVersionId = req.params.playerVersionId as string;
    try {
      const approvalRequestId = await withAdminTransaction(async (client) => {
        const version = await client.query("select status from player_version where player_version_id = $1 and player_id = $2", [playerVersionId, req.params.playerId]);
        if (!version.rows[0]) throw new AdminAuthError("PLAYER_NOT_FOUND");
        if (version.rows[0].status !== transition.fromStatus) throw new AdminAuthError("PLAYER_VERSION_IMMUTABLE");
        if (!approvalRequiredFor(transition.actionType)) throw new AdminAuthError("ADMIN_REQUEST_INVALID");
        const id = await createApprovalRequest(client, { actionType: transition.actionType, targetType: "player_version", targetId: playerVersionId, requestedByPseudonym: principal.pseudonym, correlationId: correlation, detail: { to_status: transition.toStatus, player_id: req.params.playerId } });
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: transition.actionType, targetType: "player_version", targetId: playerVersionId, outcome: "ALLOWED", reason: "APPROVAL_REQUESTED", approvalRequestId: id, correlationId: correlation });
        return id;
      });
      return reply.code(202).send({ approval_request_id: approvalRequestId, status: "PENDING", correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  }

  for (const transition of transitions) {
    const path = transition.actionType === "player_version.approve" ? "approve" : transition.actionType === "player_version.activate" ? "activate" : "suspend";
    app.post<{ Params: { playerId: string; playerVersionId: string } }>(`/api/v1/admin/players/:playerId/versions/:playerVersionId/${path}`, (req, reply) => requestVersionTransition(transition, req, reply));
  }
}
