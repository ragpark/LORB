/**
 * A thin read model over the evidence store — deliberately not a general-purpose xAPI query engine.
 *
 * It answers exactly one teacher-facing question ("how did this class do on this activity?") from
 * the statements the Evidence API has already accepted, which is upstream of the forwarder and
 * therefore available whether or not delivery to the learning record store has happened yet. The
 * learning record store remains the authoritative evidence store; this is a projection, and nothing
 * downstream may treat it as the record.
 */
import { xapiVerbs } from "../../contracts/src/index.js";
import { store as defaultStore, type RuntimeStore } from "../../runtime-api/src/store/index.js";

/** Activity ids are minted as https://lorb.example/objects/{object_id}/versions/{...}[/questions/{id}]. */
export function activityObjectId(activityId: string): string | undefined {
  return /\/objects\/([\da-f-]{36})(?:\/|$)/i.exec(activityId)?.[1]?.toLowerCase();
}

export interface ActivityResults {
  object_id: string;
  assigned_count: number;
  completed_count: number;
  /** Mean of result.score.scaled across completions that reported one; null when there are none. */
  average_score_scaled: number | null;
  /** Assigned learners with no statement of any kind for this activity. */
  not_started_pseudonyms: string[];
}

export async function aggregateActivityResults(object_id: string, runtimeStore: RuntimeStore = defaultStore()): Promise<ActivityResults> {
  const target = object_id.toLowerCase();
  const assigned = new Set<string>();
  for (const assignment of await runtimeStore.assignmentsForObject(target)) {
    for (const pseudonym of assignment.pseudonyms) assigned.add(pseudonym);
  }

  const active = new Set<string>();
  const scaledByPseudonym = new Map<string, number | undefined>();
  for (const row of await runtimeStore.statementsForObject(target)) {
    const statement = row.payload as { object?: { id?: string }; actor?: { account?: { name?: string } }; verb?: { id?: string }; result?: { score?: { scaled?: number } } } | undefined;
    if (!statement?.object?.id || activityObjectId(statement.object.id) !== target) continue;
    const pseudonym = statement.actor?.account?.name;
    if (typeof pseudonym !== "string") continue;
    active.add(pseudonym);
    // Last completion wins, matching "most recent attempt" semantics.
    if (statement.verb?.id === xapiVerbs.completed) scaledByPseudonym.set(pseudonym, statement.result?.score?.scaled);
  }

  const scores = [...scaledByPseudonym.values()].filter((value): value is number => typeof value === "number");
  return {
    object_id: target,
    assigned_count: assigned.size,
    completed_count: scaledByPseudonym.size,
    average_score_scaled: scores.length === 0 ? null : Number((scores.reduce((total, value) => total + value, 0) / scores.length).toFixed(4)),
    not_started_pseudonyms: [...assigned].filter((pseudonym) => !active.has(pseudonym)).sort(),
  };
}

export interface PseudonymResult {
  /** Any statement at all for this activity — launched, answered or completed. */
  attempted: boolean;
  completed: boolean;
  scaled: number | null;
}

/**
 * Per-actor view of the same statements the aggregate counts, for the one caller that holds a roster
 * and can therefore turn a pseudonym back into a name: the class results endpoint. It returns
 * pseudonyms, never identifiers — the caller does the matching, and the pairing exists only for the
 * duration of that request.
 */
export async function resultsByPseudonym(object_id: string, since?: string, runtimeStore: RuntimeStore = defaultStore()): Promise<Map<string, PseudonymResult>> {
  const target = object_id.toLowerCase();
  const results = new Map<string, PseudonymResult>();
  // `since` bounds the answer to one assignment window. Without it a freshly created assignment
  // reports completions from before it existed, and re-assigning the same object to the same class
  // returns the identical aggregate every time. The bound is the outbox row's created_at, set when
  // the Evidence API accepted the statement — not the statement's own `timestamp`, which the player
  // supplies and could place anywhere it liked.
  for (const row of await runtimeStore.statementsForObject(target, since)) {
    const statement = row.payload as { object?: { id?: string }; actor?: { account?: { name?: string } }; verb?: { id?: string }; result?: { score?: { scaled?: number } } } | undefined;
    if (!statement?.object?.id || activityObjectId(statement.object.id) !== target) continue;
    const pseudonym = statement.actor?.account?.name;
    if (typeof pseudonym !== "string") continue;
    const entry = results.get(pseudonym) ?? { attempted: true, completed: false, scaled: null };
    entry.attempted = true;
    if (statement.verb?.id === xapiVerbs.completed) {
      entry.completed = true;
      entry.scaled = typeof statement.result?.score?.scaled === "number" ? statement.result.score.scaled : null;
    }
    results.set(pseudonym, entry);
  }
  return results;
}
