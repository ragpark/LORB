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
 * A stable digest of the statement *as the client sent it*.
 *
 * Two exclusions, both at the top level only. The id is the key the digest is compared under, and
 * `stored` belongs to this store rather than to the sender. Nothing else is removed: a `stored` key
 * nested inside `result.extensions` is somebody's telemetry, and stripping it would make two
 * genuinely different statements digest the same — reported as a duplicate, with the first silently
 * kept.
 *
 * It digests what arrived rather than what is stored, which is what makes a redelivery idempotent:
 * this store fills in an absent `timestamp` from its own clock, and digesting the filled-in value
 * would give the same request a new identity every time it was sent.
 *
 * Keys are sorted throughout so that two encodings of the same statement agree.
 */
export function statementDigest(statement: LrsStatement): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  const { id: _id, stored: _stored, ...rest } = statement as LrsStatement & { stored?: unknown };
  return createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex");
}

/** Sorted-key JSON, so two encodings of the same value compare equal. */
function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, value_]) => [key, canonical(value_)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

/**
 * Whether an arriving statement is the one already stored under that id.
 *
 * Two comparisons, and between them they cover the two ways the same statement can arrive.
 *
 * The digest is over the statement *as sent*, so a plain retry — the same bytes again — matches it
 * whether or not the sender supplied a `timestamp`. That is the case the forwarder produces.
 *
 * The other is the round trip: a statement sent without a `timestamp` is stored with one this store
 * assigned, so a client that reads it back and offers the authoritative representation is sending
 * something that never arrived in that form. Its digest cannot match. This comparison catches it,
 * by ignoring exactly the two fields this store owns — `id`, which is the key it is filed under, and
 * `stored`, which is the store's own clock.
 *
 * `timestamp` is deliberately *not* ignored. An earlier version excluded it whenever the arriving
 * statement omitted one, which reads as generous and is wrong: a statement that asserts a time and
 * one that asserts none are different assertions, and treating the second as a duplicate of the
 * first accepts a different statement under a taken id instead of refusing it. Nothing needs the
 * exclusion — the digest already covers the retry it was reaching for.
 */
export function sameStatement(facets: StatementFacets, storedPayload: unknown): boolean {
  const strip = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { id: _id, stored: _stored, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  return canonicalJson(strip(facets.payload)) === canonicalJson(strip(storedPayload));
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

  // The digest is taken before this store's defaults are applied, so that redelivering the same
  // request is recognised as the same statement however many times it arrives.
  const digest = statementDigest(statement);

  // `stored` is the store's own record of when it took the statement, and xAPI reserves it for the
  // store to assign. A value the client sent is dropped here and the authoritative one is put back
  // on the way out, so provenance cannot be forged by a sender or lost by one that omits it.
  const { stored: _clientStored, ...withoutClientStored } = statement as LrsStatement & { stored?: unknown };
  const payload: LrsStatement = { ...withoutClientStored, id: statement_id, timestamp };

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
        digest,
      },
    },
  };
}
