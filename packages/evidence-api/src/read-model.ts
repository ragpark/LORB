// Thin read model over the evidence store — deliberately not a general-purpose xAPI query engine.
// It answers exactly one teacher-facing question ("how did this class do on this quiz?") by filtering
// the statements the Evidence API already accepted, which is upstream of the forwarder and therefore
// available whether or not the LRS delivery has happened yet.
import { xapiVerbs } from "../../contracts/src/index.js";
import { store } from "../../runtime-api/src/core.js";

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

export function aggregateActivityResults(object_id: string): ActivityResults {
  const target = object_id.toLowerCase();
  const assigned = new Set<string>();
  for (const assignment of store.assignments.values()) {
    if (assignment.object_id.toLowerCase() !== target) continue;
    for (const pseudonym of assignment.pseudonyms) assigned.add(pseudonym);
  }

  const active = new Set<string>();
  const scaledByPseudonym = new Map<string, number | undefined>();
  for (const row of store.outbox.values() as Iterable<{ payload?: any }>) {
    const statement = row?.payload;
    if (!statement?.object?.id || activityObjectId(statement.object.id) !== target) continue;
    const pseudonym = statement.actor?.account?.name;
    if (typeof pseudonym !== "string") continue;
    active.add(pseudonym);
    // Last completion wins, matching "most recent attempt" semantics for this PoC.
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
 * Per-actor view of the same statements `aggregateActivityResults` counts, for the one caller that
 * holds a roster and can therefore turn a pseudonym back into a name: the class results endpoint.
 * It returns pseudonyms, never identifiers — the caller does the matching and the pairing exists
 * only for the duration of that request.
 */
export function resultsByPseudonym(object_id: string): Map<string, PseudonymResult> {
  const target = object_id.toLowerCase();
  const results = new Map<string, PseudonymResult>();
  for (const row of store.outbox.values() as Iterable<{ payload?: any }>) {
    const statement = row?.payload;
    if (!statement?.object?.id || activityObjectId(statement.object.id) !== target) continue;
    const pseudonym = statement.actor?.account?.name;
    if (typeof pseudonym !== "string") continue;
    const entry = results.get(pseudonym) ?? { attempted: true, completed: false, scaled: null };
    entry.attempted = true;
    if (statement.verb?.id === xapiVerbs.completed) {
      entry.completed = true;
      // Last completion wins, matching the "most recent attempt" semantics of the aggregate above.
      entry.scaled = typeof statement.result?.score?.scaled === "number" ? statement.result.score.scaled : null;
    }
    results.set(pseudonym, entry);
  }
  return results;
}
