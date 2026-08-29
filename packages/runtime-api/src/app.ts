/**
 * The LORB Runtime API.
 *
 * Resolves a learning object to a signed, short-lived launch descriptor, holds attempt state and the
 * attempt lifecycle, serves the catalogue, and hosts the administration, publisher and internal
 * service surfaces.
 *
 * Everything mutable lives in the runtime store (Postgres in a deployed environment), the signing
 * material comes from a configured key ring shared by every replica, and identity is delegated to
 * the configured OIDC provider. None of those three was true while this was a thin slice, and each
 * of them is the difference between a demonstration and a service that can be run.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type RouteShorthandOptions } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { KeyLike } from "jose";
import { launchRequestSchema } from "../../contracts/src/index.js";
import { config as loadRuntimeConfig, loadConfig, type RuntimeConfig } from "./config/index.js";
import { catalogue as defaultCatalogue, createCatalogue, type CatalogueStore, type LearningObjectRow } from "./catalogue/index.js";
import { createStore, type RuntimeStore } from "./store/index.js";
import { issueDescriptor, sessionExpiresAt, SigningKeyRing } from "./core.js";
import { requestFingerprint as fingerprint, withIdempotencyClaim } from "./services/idempotency.js";
import { computePseudonym } from "./services/pseudonym-service.js";
import { createTokenVerifier, IdentityError, type KeyResolver, type TokenVerifier } from "./services/identity.js";
import { metrics, registerObservability } from "./services/observability.js";
import { problemFor, sendProblem } from "./services/problem.js";
import { resolveLaunchPolicy } from "./services/launch-policy-resolver.js";
import { registerAdminRepositoryRoutes } from "./routes/admin/repositories.js";
import { registerAdminMembershipRoutes } from "./routes/admin/memberships.js";
import { registerAdminPlayerRoutes } from "./routes/admin/players.js";
import { registerAdminLaunchPolicyRoutes } from "./routes/admin/launch-policies.js";
import { registerAdminApprovalRoutes } from "./routes/admin/approvals.js";
import { registerAdminAuditRoutes } from "./routes/admin/audit.js";
import { registerAdminClassRoutes } from "./routes/admin/classes.js";
import { registerPublisherRoutes } from "./routes/publisher/objects.js";
import { correlationOf, requireAdmin, requireIdempotencyKey, sendAdminError } from "./routes/admin/shared.js";
import { checkServiceCredential, sendInternalError } from "./routes/internal/service-auth.js";
import { registerInternalQuizRoutes } from "./routes/internal/quizzes.js";
import { registerInternalLaunchBatchRoutes } from "./routes/internal/launch-batch.js";
import { registerInternalRosterRoutes } from "./routes/internal/roster.js";

const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export interface RuntimeOptions {
  /** Injected key material for the identity provider, so a suite need not run a JWKS endpoint. */
  identityKeys?: KeyResolver;
  /** Historical name for `identityKeys`. */
  iesKey?: KeyLike;
  secret?: Buffer;
  iesIssuer?: string;
  iesJwksUrl?: string;
  publicIssuer?: string;
  playerOrigin?: string;
  evidenceEndpoint?: string;
  packageUrl?: string;
  internalServiceToken?: string;
  store?: RuntimeStore;
  catalogue?: CatalogueStore;
  signingKeys?: SigningKeyRing;
  config?: RuntimeConfig;
}

export interface BuiltRuntime {
  app: FastifyInstance;
  /** The active signing key, kept in the historical shape callers already destructure. */
  keys: { privateKey: KeyLike; publicJwk: unknown; kid: string };
  ring: SigningKeyRing;
  store: RuntimeStore;
  catalogue: CatalogueStore;
  config: RuntimeConfig;
  verifier: TokenVerifier;
}

function applyOverrides(base: RuntimeConfig, options: RuntimeOptions): RuntimeConfig {
  const identity = { ...base.identity };
  if (options.iesIssuer) identity.issuer = options.iesIssuer;
  if (options.iesJwksUrl) identity.jwksUrl = options.iesJwksUrl;
  return {
    ...base,
    identity,
    ...(options.secret ? { pseudonymSecret: options.secret } : {}),
    ...(options.publicIssuer ? { publicIssuer: options.publicIssuer.replace(/\/$/, "") } : {}),
    ...(options.playerOrigin ? { playerOrigin: options.playerOrigin.replace(/\/$/, "") } : {}),
    ...(options.evidenceEndpoint ? { evidenceEndpoint: options.evidenceEndpoint } : {}),
    ...(options.packageUrl ? { packageUrl: options.packageUrl } : {}),
    ...(options.internalServiceToken ? { internalServiceToken: options.internalServiceToken } : {}),
  };
}

export async function buildRuntime(options: RuntimeOptions = {}): Promise<BuiltRuntime> {
  const runtimeConfig = applyOverrides(options.config ?? (process.env.NODE_ENV === "test" ? loadConfig() : loadRuntimeConfig()), options);
  const store = options.store ?? createStore({ databaseUrl: runtimeConfig.databaseUrl });
  const catalogue = options.catalogue ?? (runtimeConfig.databaseUrl ? createCatalogue({ databaseUrl: runtimeConfig.databaseUrl }) : defaultCatalogue());
  const ring = options.signingKeys
    ?? (runtimeConfig.signingKeys.length > 0
      ? await SigningKeyRing.fromConfig(runtimeConfig.signingKeys)
      : await SigningKeyRing.ephemeral());
  const verifier = createTokenVerifier(runtimeConfig.identity, options.identityKeys ?? (options.iesKey as KeyResolver | undefined));

  const app = Fastify({
    logger: false,
    bodyLimit: Number.parseInt(process.env.BODY_LIMIT_BYTES ?? "131072", 10),
    trustProxy: runtimeConfig.trustProxy,
    disableRequestLogging: true,
  });

  // An empty body is a valid request on several routes; the default parser rejects it outright.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (typeof body !== "string" || body.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  registerObservability(app, { metricsEnabled: runtimeConfig.metricsEnabled });

  const { publicIssuer, playerOrigin, evidenceEndpoint, pseudonymSecret: secret } = runtimeConfig;
  const consumerOrigins = new Set(runtimeConfig.allowedConsumerOrigins);
  const browserOrigins = new Set([...consumerOrigins, playerOrigin]);

  // Fetches made from an opaque origin arrive with the Origin header "null", and two documents in a
  // launch have one: the module, always, because its iframe is sandboxed without allow-same-origin;
  // and the Player Shell itself whenever a consumer embeds it the same way — which the Learner Portal
  // does. So the shell's own calls are not reliably same-origin either, and every route a launch
  // needs has to accept "null" or the launch breaks in that topology.
  //
  // Evidence is the one that was missing. Without it a launch embedded in a sandboxed consumer iframe
  // rendered, played and completed while every xAPI statement was refused by the browser before it
  // left the page — a silent, total loss of the evidence trail in the topology a consumer actually
  // uses. Nothing else is widened: no other route accepts "null", and no wildcard is introduced.
  const playerShellRoute = (url: string): boolean => {
    const path = url.split("?")[0] ?? url;
    return path === "/api/v1/runtime/jwks"
      || path === "/api/v1/evidence/statements"
      || /^\/api\/v1\/runtime\/attempts\/[^/]+\/(state|complete)$/.test(path)
      || /^\/api\/v1\/runtime\/learning-objects\/[^/]+\/content$/.test(path);
  };

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // The API is served over HTTPS everywhere it is deployed, and the descriptor it returns is a
    // bearer credential, so downgrade is worth refusing at the browser.
    hsts: runtimeConfig.production ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });

  await app.register(cors, {
    delegator: (req, cb) => {
      const allowOpaqueShellOrigin = playerShellRoute(req.url);
      cb(null, {
        origin: (origin, originCb) => originCb(null, !origin || browserOrigins.has(origin) || (allowOpaqueShellOrigin && origin === "null")),
        credentials: false,
        maxAge: 600,
        allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-correlation-id", "traceparent"],
        exposedHeaders: ["x-correlation-id", "traceparent"],
      });
    },
  });

  if (runtimeConfig.rateLimit.enabled) {
    await app.register(rateLimit, {
      global: false,
      // Keyed by the caller's address; behind a proxy that is the forwarded client because
      // trustProxy is on in production. Rate limiting is per replica by design — a shared counter
      // would put the launch hot path behind another network dependency.
      keyGenerator: (req) => req.ip,
      addHeadersOnExceeding: { "ratelimit-limit": true, "ratelimit-remaining": true, "ratelimit-reset": true },
      errorResponseBuilder: (req, context) => ({
        ...problemFor("RATE_LIMITED", (req as never as { correlationId: string }).correlationId ?? randomUUID(), 429),
        detail: `Wait ${Math.ceil(context.ttl / 1000)} seconds and try again.`,
      }),
    });
  }

  const limit = (perMinute: number) =>
    runtimeConfig.rateLimit.enabled ? { rateLimit: { max: perMinute, timeWindow: "1 minute" } } : {};

  const correlation = (req: unknown): string => (req as { correlationId?: string }).correlationId ?? randomUUID();
  const envelope = (items: unknown[], req: unknown) => ({ items, next_cursor: null, correlation_id: correlation(req) });

  // The catalogue names every repository and object a deployment holds, and attempts carry state
  // payloads and pseudonyms; neither is served anonymously. Any subject the identity provider will
  // vouch for may read the catalogue — the same bar as launching. The routes a sandboxed launch
  // itself calls (content, state, complete, jwks, smart-link redemption) stay public: the module
  // runs from an opaque origin and holds no bearer token, only its descriptor.
  const requireSubject = async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
    try {
      return (await verifier.verify(req.headers.authorization)).subject;
    } catch (error) {
      const code = error instanceof IdentityError ? error.code : "AUTHENTICATION_EXPIRED";
      sendProblem(reply, code, correlation(req), code === "ACCESS_DENIED" ? 403 : 401);
      return undefined;
    }
  };

  const adminCtx = {
    iesKey: verifier.keys,
    iesIssuer: verifier.issuer,
    tenantSecret: secret,
    playerModuleOriginAllowlist: [playerOrigin, ...runtimeConfig.allowedConsumerOrigins],
    audience: verifier.audience,
    algorithms: runtimeConfig.identity.algorithms,
  };

  // -------------------------------------------------------------------------
  // Service surface
  // -------------------------------------------------------------------------

  app.get("/api/v1/runtime/jwks", async () => ring.jwks());

  // -------------------------------------------------------------------------
  // Catalogue (read)
  // -------------------------------------------------------------------------

  app.get("/api/v1/runtime/repositories", async (req, reply) => {
    if (!(await requireSubject(req, reply))) return;
    return envelope(await catalogue.repositories(), req);
  });

  app.get("/api/v1/runtime/repositories/:repositoryId", async (req, reply) => {
    if (!(await requireSubject(req, reply))) return;
    const { repositoryId } = (req as { params: { repositoryId: string } }).params;
    const repository = await catalogue.repository(repositoryId);
    return repository ?? sendProblem(reply, "OBJECT_NOT_FOUND", correlation(req));
  });

  app.get("/api/v1/runtime/learning-objects", async (req, reply) => {
    if (!(await requireSubject(req, reply))) return;
    const query = (req as { query: { repository_id?: string } }).query;
    return envelope(await catalogue.learningObjects({ repository_id: query.repository_id }), req);
  });

  app.get("/api/v1/runtime/learning-objects/:objectId", async (req, reply) => {
    if (!(await requireSubject(req, reply))) return;
    const object = await catalogue.learningObject((req as { params: { objectId: string } }).params.objectId);
    return object ?? sendProblem(reply, "OBJECT_NOT_FOUND", correlation(req));
  });

  /**
   * Learner-facing structured content. Read-only, and the only place a marking key is served: the
   * quiz player marks in the browser, so the payload carries correct_option_id. No administration,
   * publisher or agent-facing surface returns this body.
   */
  app.get("/api/v1/runtime/learning-objects/:objectId/content", async (req, reply) => {
    const request = req as { params: { objectId: string }; query: { object_version_id?: string } };
    const objectId = request.params.objectId;
    const object = await catalogue.learningObject(objectId);
    // The shell passes the object version its descriptor pinned. Serving that version's content
    // rather than whatever is current is what stops an edit published mid-attempt changing the
    // questions under a learner who has already answered half of them — and what keeps the evidence
    // they produce describing content that still exists. A descriptor issued before content versions
    // were recorded names a version with none, and falls back to the current content.
    const content = request.query.object_version_id
      ? await catalogue.contentForObjectVersion(objectId, request.query.object_version_id)
      : await catalogue.content(objectId);
    if (!object || object.status !== "PUBLISHED" || !content) return sendProblem(reply, "OBJECT_NOT_FOUND", correlation(req));
    // The launch context rides with the content, pinned to the same version the descriptor named:
    // the module holds no bearer token and this is the one authenticated-enough fetch it makes, so
    // the theme and settings a publisher versioned arrive exactly where they are interpreted.
    const versionRow = await catalogue.objectVersion(request.query.object_version_id ?? object.active_object_version_id);
    const launchContext = versionRow && versionRow.object_id.toLowerCase() === object.object_id.toLowerCase()
      ? versionRow.launch_context ?? undefined
      : undefined;
    return reply.header("cache-control", "no-store").send({
      ...content,
      package_version_id: object.active_package_version_id,
      ...(launchContext ? { launch_context: launchContext } : {}),
    });
  });

  app.get("/api/v1/runtime/package-versions", async (req, reply) => {
    if (!(await requireSubject(req, reply))) return;
    const query = (req as { query: { object_id?: string } }).query;
    return envelope(await catalogue.packageVersions({ object_id: query.object_id }), req);
  });

  app.get("/api/v1/runtime/package-versions/:packageVersionId", async (req, reply) => {
    if (!(await requireSubject(req, reply))) return;
    const row = await catalogue.packageVersion((req as { params: { packageVersionId: string } }).params.packageVersionId);
    return row ?? sendProblem(reply, "OBJECT_NOT_FOUND", correlation(req));
  });

  // -------------------------------------------------------------------------
  // Attempts (read)
  // -------------------------------------------------------------------------

  // Attempt records expose learner pseudonyms and stored state payloads, so reading them is an
  // administration action, audited like the rest of the workspace.
  app.get("/api/v1/runtime/attempts", async (req, reply) => {
    if (!(await requireAdmin(req, reply, adminCtx, "attempt.list", "attempt"))) return;
    const query = (req as { query: { repository_id?: string; object_id?: string } }).query;
    const attempts = await store.listAttempts({ repository_id: query.repository_id, object_id: query.object_id });
    return envelope(attempts.map((attempt) => ({ ...attempt, pseudonymous_subject_id: attempt.pseudonym })), req);
  });

  app.get("/api/v1/runtime/attempts/:attemptId", async (req, reply) => {
    if (!(await requireAdmin(req, reply, adminCtx, "attempt.read", "attempt"))) return;
    const attempt = await store.getAttempt((req as { params: { attemptId: string } }).params.attemptId);
    return attempt ?? sendProblem(reply, "OBJECT_NOT_FOUND", correlation(req));
  });

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  /**
   * Resolves the immutable identifiers a descriptor binds to.
   *
   * A pinned shared player wins over a launch policy. A launch policy routes a renderer for content
   * that does not care which one it gets; content whose payload only one player can present does
   * care, and letting the policy override that pin silently substituted the renderer. The pin is
   * honoured only when the object actually belongs to the repository being launched — otherwise
   * naming any known shared-player object alongside any repository would bypass that repository's
   * policy, since the request carries both identifiers and nothing else forces them to agree.
   */
  async function resolvePackageUrl(object: LearningObjectRow, repositoryId: string, consumerId: string, launchMode: string): Promise<{ packageUrl: string; policy: Awaited<ReturnType<typeof resolveLaunchPolicy>>; pinned: boolean }> {
    const policy = await resolveLaunchPolicy({
      consumerId, repositoryId, deliveryProfile: "native-web-package", launchMode,
    }).catch(() => null);
    const objectPackageUrl = `${playerOrigin}${object.module_path}`;
    const activePackage = await catalogue.packageVersion(object.active_package_version_id);
    const pinned = object.repository_id.toLowerCase() === repositoryId.toLowerCase() && activePackage?.shared_player === true;
    return { packageUrl: pinned ? objectPackageUrl : (policy?.packageUrl ?? objectPackageUrl), policy, pinned };
  }

  app.post("/api/v1/runtime/launches", { ...limit(runtimeConfig.rateLimit.launchesPerMinute) } as RouteShorthandOptions, async (req, reply) => {
    const correlationValue = correlation(req);
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      metrics.launches.inc({ outcome: "rejected", source: "consumer" });
      return sendProblem(reply, "IDEMPOTENCY_KEY_REQUIRED", correlationValue, 400);
    }

    const parsed = launchRequestSchema.safeParse(req.body);
    const requestFingerprint = fingerprint(req.body);
    // Claimed before the work, not recorded after it. Recording only the outcome left a window in
    // which two replicas both saw no record, both created an attempt and a launch, and only then
    // raced to store one of the two responses — so the caller's retry silently produced a second
    // attempt while the unique constraint kept exactly one of the answers.
    return withIdempotencyClaim(store, "runtime-launch", idempotencyKey, requestFingerprint, {
      mismatch: () => sendProblem(reply, "IDEMPOTENCY_KEY_REUSED", correlationValue, 409),
      inFlight: () => sendProblem(reply, "IDEMPOTENCY_KEY_IN_FLIGHT", correlationValue, 409),
      replay: (statusCode, response) => {
        metrics.launches.inc({ outcome: "replayed", source: "consumer" });
        return reply.code(statusCode).send(response);
      },
      run: async (complete) => {
        if (!parsed.success) {
          metrics.launches.inc({ outcome: "rejected", source: "consumer" });
          return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", correlationValue, 400);
        }
        const body = parsed.data;

        let subject: string;
        try {
          subject = (await verifier.verify(req.headers.authorization)).subject;
        } catch (error) {
          metrics.launches.inc({ outcome: "unauthenticated", source: "consumer" });
          const code = error instanceof IdentityError ? error.code : "AUTHENTICATION_EXPIRED";
          return sendProblem(reply, code, correlationValue, code === "ACCESS_DENIED" ? 403 : 401);
        }

        // An unknown or unpublished object is refused rather than falling back to a default package.
        // Substituting content the caller did not ask for is a silent-fallback defect: the learner gets
        // an activity nobody assigned and the evidence records a different object than was launched.
        const object = await catalogue.learningObject(body.object_id);
        if (!object) {
          metrics.launches.inc({ outcome: "not_found", source: "consumer" });
          return sendProblem(reply, "OBJECT_NOT_FOUND", correlationValue);
        }
        if (object.status === "RETIRED") return sendProblem(reply, "OBJECT_RETIRED", correlationValue);
        if (object.status !== "PUBLISHED") return sendProblem(reply, "OBJECT_NOT_PUBLISHED", correlationValue);
        if (object.repository_id.toLowerCase() !== body.repository_id.toLowerCase()) {
          metrics.launches.inc({ outcome: "not_found", source: "consumer" });
          return sendProblem(reply, "OBJECT_NOT_FOUND", correlationValue);
        }

        const pseudonym = computePseudonym(secret, verifier.issuer, subject, "launch");
        const { packageUrl, policy, pinned } = await resolvePackageUrl(object, body.repository_id, body.consumer_id, body.requested_launch_mode);

        const attemptId = randomUUID();
        const launchId = randomUUID();
        const expiresAt = sessionExpiresAt();

        await store.createAttempt({
          attempt_id: attemptId,
          repository_id: object.repository_id,
          object_id: object.object_id,
          object_version_id: object.active_object_version_id,
          package_version_id: object.active_package_version_id,
          pseudonym,
          consumer_id: body.consumer_id,
          status: "CREATED",
          revision: 1,
          correlation_id: correlationValue,
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
          source: "consumer",
          ...(policy ? {
            governed_by_launch_policy: {
              launch_policy_id: policy.governedBy.launchPolicyId,
              launch_policy_version_id: policy.governedBy.launchPolicyVersionId,
              display_name: policy.governedBy.displayName,
              semver: policy.governedBy.semver,
            },
          } : {}),
          ...(pinned ? { package_pinned_by_object: true } : {}),
        });

        const descriptor = await issueDescriptor(ring, {
          sub: pseudonym,
          repository_id: object.repository_id,
          consumer_id: body.consumer_id,
          object_id: object.object_id,
          object_version_id: object.active_object_version_id,
          package_version_id: object.active_package_version_id,
          correlation_id: randomUUID(),
          locale: body.locale,
          attempt_id: attemptId,
          state_endpoint: `${publicIssuer}/api/v1/runtime/attempts/${attemptId}/state`,
          package_url: packageUrl,
          session_config: { expires_at: expiresAt },
        }, { issuer: publicIssuer, evidenceEndpoint });

        const response = {
          launch_id: launchId,
          attempt_id: attemptId,
          signed_descriptor: descriptor,
          player_url: `${playerOrigin}/#descriptor=${encodeURIComponent(descriptor)}`,
          expires_at: expiresAt,
          correlation_id: correlationValue,
        };

        await store.recordLaunch({
          launch_id: launchId, attempt_id: attemptId, repository_id: object.repository_id,
          object_id: object.object_id, consumer_id: body.consumer_id,
          launch_mode: body.requested_launch_mode, expires_at: expiresAt, correlation_id: correlationValue,
        });
        await complete(201, response);
        metrics.launches.inc({ outcome: "issued", source: "consumer" });
        return reply.code(201).send(response);
      },
    });
  });

  // -------------------------------------------------------------------------
  // Attempt state and completion (player surface)
  // -------------------------------------------------------------------------

  /** The descriptor claims the player surface acts on. */
  interface PlayerSession { attempt_id: string; correlation_id: string; sub: string; object_id: string }

  async function authenticatePlayer(req: { headers: Record<string, unknown> }, reply: FastifyReply): Promise<PlayerSession | undefined> {
    try {
      const header = req.headers.authorization;
      const token = typeof header === "string" ? header.replace(/^Bearer /, "") : "";
      if (!token) throw new Error("SESSION_EXPIRED");
      const { payload } = await ring.verify(token, { issuer: publicIssuer, audience: "lorb-player" });
      return payload as unknown as PlayerSession;
    } catch {
      sendProblem(reply, "SESSION_EXPIRED", correlation(req), 401);
      return undefined;
    }
  }

  /** Keys a learner could put personal data behind. Rejected outright rather than stored and stripped. */
  const PII_STATE_KEY = /(email|name|dob|date_of_birth|address|phone|postcode|nhs|surname)/i;

  app.put("/api/v1/runtime/attempts/:attemptId/state", async (req, reply) => {
    const request = req as { headers: Record<string, unknown>; params: { attemptId: string }; body: { revision?: number; state_payload?: unknown } };
    const correlationValue = correlation(req);
    if (!request.headers["idempotency-key"]) return sendProblem(reply, "IDEMPOTENCY_KEY_REQUIRED", correlationValue, 400);
    const descriptor = await authenticatePlayer(request, reply);
    if (!descriptor) return;
    if (descriptor.attempt_id !== request.params.attemptId) return sendProblem(reply, "ACCESS_DENIED", descriptor.correlation_id, 403);

    const payload = request.body?.state_payload;
    const serialised = JSON.stringify(payload ?? null);
    if (serialised.length > 65536) return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", descriptor.correlation_id, 400);
    if (PII_STATE_KEY.test(JSON.stringify(Object.keys((payload as Record<string, unknown>) ?? {})))) {
      return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", descriptor.correlation_id, 400);
    }

    const result = await store.writeAttemptState(request.params.attemptId, request.body?.revision as number, payload);
    if (result.outcome === "NOT_FOUND") return sendProblem(reply, "ATTEMPT_CONFLICT", descriptor.correlation_id, 409);
    if (result.outcome === "CONFLICT") return sendProblem(reply, "ATTEMPT_CONFLICT", descriptor.correlation_id, 409);
    metrics.attemptTransitions.inc({ to: result.status ?? "STARTED", outcome: "applied" });
    return reply.send({ revision: result.revision, status: result.status, correlation_id: descriptor.correlation_id });
  });

  app.post("/api/v1/runtime/attempts/:attemptId/complete", async (req, reply) => {
    const request = req as { headers: Record<string, unknown>; params: { attemptId: string } };
    const correlationValue = correlation(req);
    if (!request.headers["idempotency-key"]) return sendProblem(reply, "IDEMPOTENCY_KEY_REQUIRED", correlationValue, 400);
    const descriptor = await authenticatePlayer(request, reply);
    if (!descriptor) return;
    if (descriptor.attempt_id !== request.params.attemptId) return sendProblem(reply, "ACCESS_DENIED", descriptor.correlation_id, 403);

    const result = await store.transitionAttempt(request.params.attemptId, "COMPLETED");
    if (result.outcome !== "APPLIED") {
      metrics.attemptTransitions.inc({ to: "COMPLETED", outcome: "conflict" });
      return sendProblem(reply, "ATTEMPT_CONFLICT", descriptor.correlation_id, 409);
    }
    metrics.attemptTransitions.inc({ to: "COMPLETED", outcome: "applied" });
    return reply.send({ attempt_id: request.params.attemptId, status: "COMPLETED", correlation_id: descriptor.correlation_id });
  });

  // -------------------------------------------------------------------------
  // Smart links
  // -------------------------------------------------------------------------

  const smartLinkUrl = (token: string) => `${publicIssuer}/api/v1/runtime/smart-links/${token}`;

  const smartLinkResponse = (link: { smart_link_id: string; object_id: string; object_version_id?: string | null; created_at: string; revoked_at: string | null; token_prefix: string; redemption_count: number }, token: string | undefined, correlationValue: string) => ({
    smart_link_id: link.smart_link_id,
    object_id: link.object_id,
    object_version_id: link.object_version_id ?? null,
    // The token itself is returned only on the response that created it: the store keeps a hash, so
    // a later read cannot reproduce it. An admin who loses it revokes and creates a new one.
    ...(token ? { token, url: smartLinkUrl(token) } : { token_prefix: link.token_prefix }),
    created_at: link.created_at,
    revoked_at: link.revoked_at,
    redemption_count: link.redemption_count,
    correlation_id: correlationValue,
  });

  function readCookie(req: { headers: Record<string, unknown> }, name: string): string | undefined {
    const header = req.headers.cookie;
    if (typeof header !== "string") return undefined;
    const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
  }

  /**
   * Public redemption. Mints a fresh attempt and descriptor per visit and redirects into the Player
   * Shell, so a top-level browser navigation carries it and CORS is not involved at all.
   *
   * The learner is a pseudonym derived from a random identifier in a long-lived cookie, namespaced by
   * a fixed "smart-link" issuer distinct from any real identity provider, so a smart-link pseudonym
   * can never collide with one derived from a genuine login.
   */
  app.get("/api/v1/runtime/smart-links/:token", { ...limit(runtimeConfig.rateLimit.smartLinksPerMinute) } as RouteShorthandOptions, async (req, reply) => {
    const request = req as { headers: Record<string, unknown>; params: { token: string }; protocol: string };
    const correlationValue = correlation(req);
    const link = await store.smartLinkByTokenHash(hashToken(request.params.token));
    if (!link) {
      metrics.smartLinkRedemptions.inc({ outcome: "not_found" });
      return sendProblem(reply, "SMART_LINK_NOT_FOUND", correlationValue);
    }
    const object = await catalogue.learningObject(link.object_id);
    if (!object || object.status !== "PUBLISHED") {
      metrics.smartLinkRedemptions.inc({ outcome: "unavailable" });
      return sendProblem(reply, "LEARNING_OBJECT_NOT_AVAILABLE", correlationValue, 410);
    }
    // A pinned link keeps delivering the version it was created against — that a later publish
    // superseded it is the reason the link exists. The version chain is immutable, so the only
    // failure here is a link whose version no longer resolves at all.
    const pinnedVersion = link.object_version_id ? await catalogue.objectVersion(link.object_version_id) : undefined;
    if (link.object_version_id && (!pinnedVersion || pinnedVersion.object_id.toLowerCase() !== object.object_id.toLowerCase())) {
      metrics.smartLinkRedemptions.inc({ outcome: "unavailable" });
      return sendProblem(reply, "LEARNING_OBJECT_NOT_AVAILABLE", correlationValue, 410);
    }
    const deliveredVersionId = pinnedVersion?.object_version_id ?? object.active_object_version_id;
    const deliveredPackageId = pinnedVersion?.package_version_id ?? object.active_package_version_id;
    const deliveredModulePath = pinnedVersion
      ? (await catalogue.packageVersion(pinnedVersion.package_version_id))?.module_path ?? object.module_path
      : object.module_path;

    let subject = readCookie(request, "lorb_smart_link_subject");
    if (!subject || !/^[a-f0-9-]{36}$/i.test(subject)) subject = randomUUID();
    const isHttps = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
    (reply as { header: (name: string, value: string) => void }).header(
      "set-cookie",
      `lorb_smart_link_subject=${subject}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${isHttps ? "; Secure" : ""}`,
    );

    const pseudonym = computePseudonym(secret, "smart-link", subject, "launch");
    const attemptId = randomUUID();
    const expiresAt = sessionExpiresAt();
    await store.createAttempt({
      attempt_id: attemptId,
      repository_id: object.repository_id,
      object_id: object.object_id,
      object_version_id: deliveredVersionId,
      package_version_id: deliveredPackageId,
      pseudonym,
      consumer_id: "smart-link",
      status: "CREATED",
      revision: 1,
      correlation_id: correlationValue,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      source: "smart-link",
    });
    const descriptor = await issueDescriptor(ring, {
      sub: pseudonym,
      repository_id: object.repository_id,
      consumer_id: "smart-link",
      object_id: object.object_id,
      object_version_id: deliveredVersionId,
      package_version_id: deliveredPackageId,
      correlation_id: randomUUID(),
      locale: "en-GB",
      attempt_id: attemptId,
      state_endpoint: `${publicIssuer}/api/v1/runtime/attempts/${attemptId}/state`,
      package_url: `${playerOrigin}${deliveredModulePath}`,
      session_config: { expires_at: expiresAt },
    }, { issuer: publicIssuer, evidenceEndpoint });

    await store.recordSmartLinkRedemption(link.smart_link_id);
    metrics.smartLinkRedemptions.inc({ outcome: "redeemed" });
    metrics.launches.inc({ outcome: "issued", source: "smart-link" });
    return (reply as { redirect: (url: string, code: number) => unknown })
      .redirect(`${playerOrigin}/#descriptor=${encodeURIComponent(descriptor)}`, 302);
  });

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  app.get("/api/v1/admin/whoami", async (req, reply) => {
    const principal = await requireAdmin(req, reply, adminCtx, "admin.whoami", "admin_principal");
    if (!principal) return;
    return { pseudonym: principal.pseudonym, role: principal.role, platform_admin: principal.platformAdmin, correlation_id: correlationOf(req) };
  });

  app.get("/api/v1/admin/learning-objects", async (req, reply) => {
    const principal = await requireAdmin(req, reply, adminCtx, "learning_object.list", "learning_object");
    if (!principal) return;
    const objects = await catalogue.learningObjects();
    const packages = new Map((await catalogue.packageVersions()).map((row) => [row.package_version_id, row]));
    return {
      items: objects.map((object) => ({ ...object, package_version: packages.get(object.active_package_version_id) })),
      next_cursor: null,
      correlation_id: correlationOf(req),
    };
  });

  app.post("/api/v1/admin/learning-objects/:objectId/smart-link", async (req, reply) => {
    const principal = await requireAdmin(req, reply, adminCtx, "smart_link.create", "smart_link");
    if (!principal) return;
    const correlationValue = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;
    const objectId = (req as { params: { objectId: string } }).params.objectId;
    const object = await catalogue.learningObject(objectId);
    if (!object) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlationValue);
    if (object.status !== "PUBLISHED") return sendAdminError(reply, "LEARNING_OBJECT_NOT_PUBLISHED", correlationValue);

    // Naming a version pins the link to it — the artefact form of sharing. Every published or
    // superseded version of this object qualifies: superseded is the case the pin exists for.
    // Without one the link follows the active version, as it always has.
    const requestedVersion = (req as { body?: { object_version_id?: unknown } }).body?.object_version_id;
    if (requestedVersion !== undefined && typeof requestedVersion !== "string") return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlationValue);
    let pinnedVersionId: string | null = null;
    if (typeof requestedVersion === "string") {
      const version = await catalogue.objectVersion(requestedVersion);
      if (!version || version.object_id.toLowerCase() !== object.object_id.toLowerCase()) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlationValue);
      if (!["PUBLISHED", "SUPERSEDED"].includes(version.status)) return sendAdminError(reply, "LEARNING_OBJECT_STATE_INVALID", correlationValue);
      pinnedVersionId = version.object_version_id;
    }

    const existing = pinnedVersionId
      ? await store.activeSmartLinkForVersion(object.object_id, pinnedVersionId)
      : await store.activeSmartLinkForObject(object.object_id);
    if (existing) return (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(200).send(smartLinkResponse(existing, undefined, correlationValue));

    const token = randomBytes(32).toString("base64url");
    const link = {
      smart_link_id: randomUUID(),
      object_id: object.object_id,
      object_version_id: pinnedVersionId,
      token_prefix: token.slice(0, 8),
      created_by_pseudonym: principal.pseudonym,
      created_at: new Date().toISOString(),
      revoked_at: null,
      last_redeemed_at: null,
      redemption_count: 0,
    };
    await store.createSmartLink({ ...link, token_hash: hashToken(token) });
    return (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(201).send(smartLinkResponse(link, token, correlationValue));
  });

  app.get("/api/v1/admin/learning-objects/:objectId/smart-link", async (req, reply) => {
    const principal = await requireAdmin(req, reply, adminCtx, "smart_link.get", "smart_link");
    if (!principal) return;
    const correlationValue = correlationOf(req);
    const request = req as { params: { objectId: string }; query: { object_version_id?: string } };
    const link = request.query.object_version_id
      ? await store.activeSmartLinkForVersion(request.params.objectId, request.query.object_version_id)
      : await store.activeSmartLinkForObject(request.params.objectId);
    if (!link) return sendAdminError(reply, "SMART_LINK_NOT_FOUND", correlationValue);
    return smartLinkResponse(link, undefined, correlationValue);
  });

  app.post("/api/v1/admin/learning-objects/:objectId/smart-link/revoke", async (req, reply) => {
    const principal = await requireAdmin(req, reply, adminCtx, "smart_link.revoke", "smart_link");
    if (!principal) return;
    const correlationValue = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;
    const link = await store.revokeSmartLink((req as { params: { objectId: string } }).params.objectId, principal.pseudonym);
    if (!link) return sendAdminError(reply, "SMART_LINK_NOT_FOUND", correlationValue);
    return smartLinkResponse(link, undefined, correlationValue);
  });

  // -------------------------------------------------------------------------
  // Internal service surface
  // -------------------------------------------------------------------------

  const internalServiceToken = runtimeConfig.internalServiceToken;
  // The internal credential and any agent-facing credential are different trust domains with
  // different blast radii; configuring them to the same value collapses that separation.
  const agentToken = process.env.MCP_SHARED_BEARER_TOKEN ?? process.env.MCP_POC_BEARER_TOKEN;
  if (internalServiceToken && agentToken
    && internalServiceToken.length === agentToken.length
    && timingSafeEqual(Buffer.from(internalServiceToken), Buffer.from(agentToken))) {
    throw new Error("RUNTIME_INTERNAL_SERVICE_TOKEN must not equal the agent connector's bearer token");
  }

  const internalGuard = (req: FastifyRequest, reply: FastifyReply, correlationValue: string): boolean => {
    const failure = checkServiceCredential(req, internalServiceToken);
    if (!failure) return true;
    void sendInternalError(reply, failure, correlationValue);
    return false;
  };

  registerInternalQuizRoutes(app, internalGuard, { store, catalogue });
  registerInternalLaunchBatchRoutes(app, {
    serviceToken: internalServiceToken, ring, secret,
    identityIssuer: verifier.issuer, publicIssuer, playerOrigin, evidenceEndpoint,
    store, catalogue,
  }, internalGuard);
  registerInternalRosterRoutes(app, internalGuard);

  registerPublisherRoutes(app, { catalogue, store, adminCtx });
  registerAdminRepositoryRoutes(app, adminCtx);
  registerAdminMembershipRoutes(app, adminCtx);
  registerAdminPlayerRoutes(app, adminCtx);
  registerAdminLaunchPolicyRoutes(app, adminCtx);
  registerAdminApprovalRoutes(app, adminCtx);
  registerAdminAuditRoutes(app, adminCtx);
  registerAdminClassRoutes(app, adminCtx, { catalogue, store });

  return {
    app,
    keys: { privateKey: ring.signingKey, publicJwk: ring.jwks().keys[0], kid: ring.activeKid },
    ring,
    store,
    catalogue,
    config: runtimeConfig,
    verifier,
  };
}
