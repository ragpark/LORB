/**
 * The learning record store's HTTP surface: the xAPI statements resource.
 *
 * The platform has always had a box on the diagram labelled "learning record store" and nothing
 * behind it — `LRS_ENDPOINT` pointed at somebody else's product, or in development at an in-memory
 * stub that lost everything on restart. This is that box: durable, authenticated, and speaking
 * enough of xAPI 1.0.3 that the forwarder cannot tell it from a commercial one.
 *
 * What it implements: PUT and POST /statements with xAPI's dedupe-by-id rule, GET /statements by id
 * and by filter with paging, voiding, and /about. What it does not: attachments, signed statements,
 * and the state, agent and activity profile resources. Those are real parts of the specification and
 * nothing in this platform emits them; adding them later is additive rather than a redesign.
 *
 * Errors are plain status codes with a small JSON body rather than the platform's problem+json. This
 * surface is spoken to by xAPI clients, and a client that expects a 409 to mean "conflicting
 * statement" should not have to learn a second error contract to discover it.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { authenticate } from "./auth.js";
import type { LrsServiceConfig } from "./config.js";
import { prepareStatement, type StatementProblem } from "./statement.js";
import { decodeCursor, encodeCursor, MemoryLrsStore, type LrsStore, type StatementQuery } from "./store.js";

export interface LrsAppOptions {
  config: LrsServiceConfig;
  store?: LrsStore;
}

const VERSION_HEADER = "x-experience-api-version";

/** Statuses this surface returns, kept in one place so the tests and the docs agree with the code. */
const PROBLEM_STATUS: Record<StatementProblem["code"], number> = {
  INVALID: 400,
  ID_MISMATCH: 400,
  ACTOR_IDENTIFIES_A_PERSON: 400,
};

export async function buildLrs(options: LrsAppOptions): Promise<{ app: FastifyInstance; store: LrsStore }> {
  const config = options.config;
  const store = options.store ?? new MemoryLrsStore();

  const app = Fastify({
    logger: false,
    bodyLimit: Number.parseInt(process.env.LRS_BODY_LIMIT_BYTES ?? "1048576", 10),
    disableRequestLogging: true,
  });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (typeof body !== "string" || body.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  // Every xAPI response carries the version it speaks, on the way out as well as in.
  app.addHook("onSend", async (_req, reply, payload) => {
    void reply.header(VERSION_HEADER, config.xapiVersion);
    return payload;
  });

  const fail = (reply: FastifyReply, status: number, error: string, detail?: string) =>
    reply.code(status).send({ error, ...(detail ? { detail } : {}) });

  /**
   * The version a client declares. A client speaking a different major version of xAPI is refused
   * rather than half-understood; one that declares nothing is accepted, because a great many
   * clients — including this platform's own forwarder before it was configured — simply omit it.
   */
  const versionAccepted = (req: FastifyRequest): boolean => {
    const declared = req.headers[VERSION_HEADER];
    if (typeof declared !== "string" || declared.length === 0) return true;
    return declared.startsWith("1.0");
  };

  const authorised = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const caller = authenticate(req.headers.authorization, config.credentials);
    if (!caller) {
      void reply.header("www-authenticate", 'Basic realm="lorb-lrs", Bearer').code(401).send({ error: "UNAUTHORISED" });
      return false;
    }
    return true;
  };

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!authorised(req, reply)) return false;
    if (!versionAccepted(req)) {
      void fail(reply, 400, "VERSION_NOT_SUPPORTED", `this store speaks xAPI ${config.xapiVersion}`);
      return false;
    }
    return true;
  };

  // ---------------------------------------------------------------------------
  // Operational surface
  // ---------------------------------------------------------------------------

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    try {
      await store.ping();
      return { status: "ready", persistence: store.kind };
    } catch {
      return reply.code(503).send({ status: "unavailable", persistence: store.kind });
    }
  });

  /** The xAPI capability probe. Unauthenticated by specification: it says what, never who or what's in it. */
  app.get("/about", async () => ({ version: [config.xapiVersion], extensions: { "https://lorb.example/lrs": { statements: true, attachments: false } } }));

  // ---------------------------------------------------------------------------
  // Statements
  // ---------------------------------------------------------------------------

  /**
   * PUT is the idempotent path, and the one the evidence forwarder uses: the caller names the
   * statement id, so a redelivery after a lost response is a no-op rather than a second record.
   */
  app.put("/statements", async (req, reply) => {
    if (!guard(req, reply)) return;
    const statementId = (req.query as { statementId?: string }).statementId;
    if (!statementId) return fail(reply, 400, "STATEMENT_ID_REQUIRED", "PUT /statements requires a statementId parameter");

    const prepared = prepareStatement(req.body, { addressedTo: statementId, requirePseudonymousActor: config.requirePseudonymousActor });
    if (!prepared.ok) return fail(reply, PROBLEM_STATUS[prepared.problem.code], prepared.problem.code, prepared.problem.detail);

    const outcome = await store.accept(prepared.prepared.facets);
    // A conflicting statement under an id that is already taken is the one case xAPI singles out:
    // the store keeps what it has, and says so, rather than overwriting evidence.
    if (outcome === "CONFLICT") return fail(reply, 409, "STATEMENT_CONFLICT", "a different statement is already stored under this id");
    return reply.code(204).send();
  });

  /** POST accepts one statement or a batch, and answers with the ids it stored them under. */
  app.post("/statements", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = req.body;
    const batch = Array.isArray(body) ? body : [body];
    if (batch.length === 0) return fail(reply, 400, "STATEMENT_REQUIRED", "no statements in the request");

    const prepared = [];
    for (const [index, entry] of batch.entries()) {
      const result = prepareStatement(entry, { requirePseudonymousActor: config.requirePseudonymousActor });
      if (!result.ok) {
        return fail(reply, PROBLEM_STATUS[result.problem.code], result.problem.code, `statement ${index}: ${result.problem.detail}`);
      }
      prepared.push(result.prepared);
    }

    // One transaction for the whole batch. Writing them one at a time and stopping at the first
    // conflict leaves the earlier ones stored and unacknowledged — and where the sender supplied no
    // id, this store generated one it never got to answer with, so a retry of the rejected batch
    // stores them a second time under ids nobody can reach.
    const result = await store.acceptAll(prepared.map((entry) => entry.facets));
    if (!result.ok) {
      const conflicting = prepared[result.conflictAt]!.facets.statement_id;
      return fail(reply, 409, "STATEMENT_CONFLICT", `statement ${result.conflictAt}: a different statement is already stored under id ${conflicting}`);
    }
    return reply.code(200).send(prepared.map((entry) => entry.facets.statement_id));
  });

  app.get("/statements", async (req, reply) => {
    if (!guard(req, reply)) return;
    const query = req.query as Record<string, string | undefined>;

    if (query.statementId) {
      // Fetching a voided statement by its id is allowed; finding it in a query is not.
      const statement = await store.get(query.statementId);
      if (!statement) return fail(reply, 404, "STATEMENT_NOT_FOUND");
      return reply.send(statement.payload);
    }

    const limitRaw = query.limit ? Number.parseInt(query.limit, 10) : config.defaultLimit;
    if (!Number.isFinite(limitRaw) || limitRaw < 0) return fail(reply, 400, "LIMIT_INVALID", "limit must be a non-negative integer");
    const limit = Math.min(limitRaw === 0 ? config.defaultLimit : limitRaw, config.maxLimit);

    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (query.cursor && !after) return fail(reply, 400, "CURSOR_INVALID", "the continuation token is not one this store issued");

    const agent = agentFilter(query.agent);
    if (agent === "UNPARSEABLE") return fail(reply, 400, "AGENT_INVALID", "agent must be a JSON-encoded xAPI Agent, or a pseudonym");
    // An Agent this store can hold no statement for — one identified by mbox or openid, where every
    // actor here is an account pseudonym — matches nothing rather than everything.
    if (agent === "UNMATCHABLE") return reply.send({ statements: [], more: "" });

    const statementQuery: StatementQuery = {
      agent,
      verb: query.verb,
      activity: query.activity,
      registration: query.registration,
      attemptId: query.attempt_id,
      repositoryId: query.repository_id,
      since: query.since,
      until: query.until,
      ascending: query.ascending === "true",
      includeVoided: query.voided === "true",
      limit,
      after,
    };
    const page = await store.query(statementQuery);

    // `more` is a relative IRL per the specification: the client follows it rather than building it.
    const passthrough = Object.entries(query)
      .filter(([key, value]) => key !== "cursor" && value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    const more = page.next
      ? `/statements?${[...passthrough, `cursor=${encodeCursor(page.next)}`].join("&")}`
      : "";

    return reply.send({
      statements: page.statements.map((statement) => statement.payload),
      more,
    });
  });

  app.setNotFoundHandler(async (_req, reply) => fail(reply, 404, "NOT_FOUND"));


  app.setErrorHandler(async (error, _req, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 400) return fail(reply, 400, "MALFORMED_REQUEST", "the request body is not valid JSON");
    return fail(reply, status >= 500 ? 500 : status, status >= 500 ? "STORE_UNAVAILABLE" : "REQUEST_REJECTED");
  });

  return { app, store };
}

/**
 * The actor a query filters on.
 *
 * xAPI sends `agent` as a JSON-encoded Agent, and this store's actors are account pseudonyms, so the
 * filter is that account's name. A bare string is accepted too: it is what the platform's own tools
 * pass, and rejecting it would break them to satisfy a specification neither side is speaking at
 * that moment.
 *
 * Returns the pseudonym to filter by, `undefined` for no filter, `UNMATCHABLE` for a well-formed
 * Agent this store could never hold a statement for, and `UNPARSEABLE` for something that is neither.
 */
export function agentFilter(raw: string | undefined): string | undefined | "UNMATCHABLE" | "UNPARSEABLE" {
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "UNPARSEABLE";
  }
  if (!parsed || typeof parsed !== "object") return "UNPARSEABLE";
  const agent = parsed as { account?: { name?: unknown }; mbox?: unknown; openid?: unknown; mbox_sha1sum?: unknown };
  if (typeof agent.account?.name === "string" && agent.account.name.length > 0) return agent.account.name;
  if (agent.mbox || agent.openid || agent.mbox_sha1sum) return "UNMATCHABLE";
  return "UNPARSEABLE";
}

/** Test seam: a store with one throwaway credential, so a suite need not configure the world. */
export function testConfig(overrides: Partial<LrsServiceConfig> = {}): LrsServiceConfig {
  return {
    environment: "test",
    production: false,
    port: 0,
    credentials: [{ kind: "bearer", token: `test-token-${randomUUID()}` }],
    defaultLimit: 100,
    maxLimit: 1000,
    requirePseudonymousActor: true,
    xapiVersion: "1.0.3",
    metricsEnabled: false,
    ...overrides,
  };
}
