/**
 * What a statement is to this store, and what it refuses.
 *
 * The Evidence API validates the *platform's* contract — three verbs, a narrow result, no free text.
 * This is a learning record store, so it validates the xAPI shape instead and accepts any conformant
 * statement, including telemetry a learning object puts in `result.extensions` or
 * `context.extensions` that the platform's own contract has never heard of. Storing it is the point;
 * an LRS that only accepts what today's players emit is a schema migration every time content
 * changes.
 *
 * Two things it does refuse, and they are the reasons this is not a generic bucket:
 *
 *   - a statement whose actor identifies a person directly, where the deployment asks for
 *     pseudonymity — LORB's evidence chain is pseudonymous by construction, and a store that quietly
 *     accepted an `mbox` would be the one place it leaks;
 *   - a statement whose body carries an id that disagrees with the id it was addressed to, which is
 *     a client bug that would otherwise be stored as a third statement nobody asked for.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const uuid = z.string().uuid();
const iri = z.string().min(1).max(2048);

/** An actor, in any of the shapes xAPI allows. Kept loose: the guard below is what does the work. */
const agentSchema = z.object({
  objectType: z.enum(["Agent", "Group"]).optional(),
  name: z.string().optional(),
  mbox: z.string().optional(),
  mbox_sha1sum: z.string().optional(),
  openid: z.string().optional(),
  account: z.object({ homePage: z.string(), name: z.string() }).passthrough().optional(),
  member: z.array(z.record(z.unknown())).optional(),
}).passthrough();

export const lrsStatementSchema = z.object({
  id: uuid.optional(),
  actor: agentSchema,
  verb: z.object({ id: iri, display: z.record(z.string()).optional() }).passthrough(),
  object: z.object({ id: z.string().optional(), objectType: z.string().optional() }).passthrough(),
  result: z.record(z.unknown()).optional(),
  context: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
  stored: z.string().datetime().optional(),
  authority: z.record(z.unknown()).optional(),
  version: z.string().optional(),
  attachments: z.array(z.record(z.unknown())).optional(),
}).passthrough();

export type LrsStatement = z.infer<typeof lrsStatementSchema>;

export const VOIDED_VERB = "http://adlnet.gov/expapi/verbs/voided";

/** The LORB context extensions worth a column, because they are what an operator queries by. */
const EXTENSION = {
  repository: "https://lorb.example/xapi/repository_id",
  attempt: "https://lorb.example/xapi/attempt_id",
  packageVersion: "https://lorb.example/xapi/package_version_id",
  correlation: "https://lorb.example/xapi/correlation_id",
} as const;

export interface StatementFacets {
  statement_id: string;
  actor_pseudonym: string | null;
  verb_id: string;
  object_id: string | null;
  registration: string | null;
  repository_id: string | null;
  attempt_id: string | null;
  package_version_id: string | null;
  correlation_id: string | null;
  timestamp: string;
  voids: string | null;
  payload: LrsStatement;
  digest: string;
}

/**
 * A stable digest of the statement as stored.
 *
 * `stored` and the id are excluded: the id is the key, and `stored` is assigned by this store, so
 * including either would make an identical redelivery look like a conflicting one. Keys are sorted
 * so that two encodings of the same statement agree.
 */
export function statementDigest(statement: LrsStatement): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "stored")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  const { id: _id, ...rest } = statement;
  return createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex");
}

/** True when the actor names a person rather than a pseudonym. */
export function identifiesAPerson(actor: LrsStatement["actor"]): boolean {
  if (actor.mbox || actor.mbox_sha1sum || actor.openid || actor.name) return true;
  return (actor.member ?? []).some((member) => identifiesAPerson(member as LrsStatement["actor"]));
}

export type StatementProblem =
  | { code: "INVALID"; detail: string }
  | { code: "ID_MISMATCH"; detail: string }
  | { code: "ACTOR_IDENTIFIES_A_PERSON"; detail: string };

export interface PreparedStatement {
  facets: StatementFacets;
}

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * Validates one statement and pulls out the columns worth indexing. `addressedTo` is the
 * `statementId` a PUT names; a body that carries a different id is refused rather than reconciled.
 */
export function prepareStatement(
  body: unknown,
  options: { addressedTo?: string; requirePseudonymousActor: boolean; now?: () => Date } = { requirePseudonymousActor: true },
): { ok: true; prepared: PreparedStatement } | { ok: false; problem: StatementProblem } {
  const parsed = lrsStatementSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, problem: { code: "INVALID", detail: parsed.error.issues[0]?.message ?? "statement is not a valid xAPI statement" } };
  }
  const statement = parsed.data;

  if (options.addressedTo && statement.id && statement.id.toLowerCase() !== options.addressedTo.toLowerCase()) {
    return { ok: false, problem: { code: "ID_MISMATCH", detail: "the statement id in the body differs from the statementId parameter" } };
  }
  if (options.requirePseudonymousActor && identifiesAPerson(statement.actor)) {
    return {
      ok: false,
      problem: {
        code: "ACTOR_IDENTIFIES_A_PERSON",
        detail: "this store accepts pseudonymous actors only: an actor may not carry mbox, mbox_sha1sum, openid or name",
      },
    };
  }

  const statement_id = (options.addressedTo ?? statement.id ?? randomUUID()).toLowerCase();
  const now = (options.now ?? (() => new Date()))();
  const timestamp = statement.timestamp ?? now.toISOString();
  const context = (statement.context ?? {}) as { registration?: unknown; extensions?: Record<string, unknown> };
  const extensions = context.extensions ?? {};
  const object = statement.object as { id?: unknown; objectType?: unknown };
  const voids = statement.verb.id === VOIDED_VERB && object.objectType === "StatementRef" ? asString(object.id) : null;
  const payload: LrsStatement = { ...statement, id: statement_id, timestamp };

  return {
    ok: true,
    prepared: {
      facets: {
        statement_id,
        actor_pseudonym: asString(statement.actor.account?.name),
        verb_id: statement.verb.id,
        object_id: asString(object.id),
        registration: asString(context.registration),
        repository_id: asString(extensions[EXTENSION.repository]),
        attempt_id: asString(extensions[EXTENSION.attempt]),
        package_version_id: asString(extensions[EXTENSION.packageVersion]),
        correlation_id: asString(extensions[EXTENSION.correlation]),
        timestamp,
        voids: voids ? voids.toLowerCase() : null,
        payload,
        digest: statementDigest(payload),
      },
    },
  };
}
