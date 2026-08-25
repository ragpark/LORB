// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION. Thin HTTP clients for the LORB services this connector
// depends on. The Runtime internal-service credential is attached to every internal Runtime route,
// including the read-only roster projection, and is never returned to the agent.
import { randomUUID } from "node:crypto";
import type { QuizDraft } from "../../contracts/src/index.js";
import type { ConnectorConfig } from "./config.js";

export type FetchImpl = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export class LorbServiceError extends Error {
  constructor(readonly status: number, readonly service: string, message: string) {
    super(message);
  }
}

export interface ClassSummary { class_id: string; name: string; year_group: string; subject: string; learner_count: number }
export interface RecentTopics { class_id: string; subject: string; year_group: string; topics: Array<{ topic: string; taught_on: string; summary: string }> }
/** The internal roster projection returns identifiers only. Display names stay in the roster: the
 *  agent has no use for them, and a name-to-pseudonym mapping is the one artefact that would undo
 *  the pseudonymisation this design rests on. */
export interface RosterLearner { learner_id: string }
export interface Roster { class_id: string; learners: RosterLearner[] }
export interface RegisteredQuiz { object_id: string; object_version_id: string; package_version_id: string; package_version: string; content_version: string; question_count: number; title: string }
export interface BatchLaunchLearner { learner_id: string; pseudonym: string }
export interface BatchLaunch { assignment_id: string; object_id: string; assigned_count: number; created_at: string; learners: BatchLaunchLearner[] }
export interface ActivityResults { object_id: string; assigned_count: number; completed_count: number; average_score_scaled: number | null; not_started_pseudonyms: string[] }

export interface ClassList { items: ClassSummary[]; linked?: boolean }

/** The verified agent identity, forwarded so the Runtime API can scope the roster to one teacher.
 *  The service credential authenticates the connector, not the person using it. */
export interface AgentPrincipal { issuer: string; subject: string }

export interface LorbClients {
  listClasses(): Promise<ClassList>;
  getClass(classId: string): Promise<ClassSummary>;
  getRecentTopics(classId: string): Promise<RecentTopics>;
  getRoster(classId: string): Promise<Roster>;
  createQuiz(draft: QuizDraft, idempotencyKey: string): Promise<RegisteredQuiz>;
  launchBatch(objectId: string, learners: RosterLearner[], idempotencyKey: string): Promise<BatchLaunch>;
  getActivityResults(objectId: string): Promise<ActivityResults>;
}

export function createLorbClients(config: ConnectorConfig, fetchImpl: FetchImpl = globalThis.fetch as unknown as FetchImpl, principal?: AgentPrincipal): LorbClients {
  async function call<T>(service: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", "x-correlation-id": randomUUID(), ...(init.headers ?? {}) };
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }
    const response = await fetchImpl(url, { method: init.method ?? "GET", headers, body });
    const text = await response.text();
    if (response.status >= 400) {
      // Deliberately does not surface the upstream body: it can contain a marking key (content route)
      // or a correlation trail the agent has no need for.
      throw new LorbServiceError(response.status, service, `${service} request failed with status ${response.status}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const internal = () => ({ authorization: `Bearer ${config.runtimeInternalServiceToken}` });
  // Sent on roster reads only. An absent principal resolves to no teacher, and the Runtime API
  // answers with an empty roster rather than everyone's — the fail-closed direction.
  const asPrincipal = () => ({
    ...internal(),
    ...(principal ? { "x-lorb-agent-issuer": principal.issuer, "x-lorb-agent-subject": principal.subject } : {}),
  });

  return {
    // Roster reads come from the Runtime API's read-only internal projection, so an agent sees the
    // classes a teacher actually created rather than seed data. Writes are administrator-only and
    // web-only; there is no roster-mutating path on this connector at all.
    listClasses: () => call("roster", `${config.runtimeApiBase}/api/v1/internal/roster/classes`, { headers: asPrincipal() }),
    getClass: (classId) =>
      call("roster", `${config.runtimeApiBase}/api/v1/internal/roster/classes/${encodeURIComponent(classId)}`, { headers: asPrincipal() }),
    getRecentTopics: (classId) =>
      call("roster", `${config.runtimeApiBase}/api/v1/internal/roster/classes/${encodeURIComponent(classId)}/recent-topics`, { headers: asPrincipal() }),
    getRoster: (classId) =>
      call("roster", `${config.runtimeApiBase}/api/v1/internal/roster/classes/${encodeURIComponent(classId)}/roster`, { headers: asPrincipal() }),
    createQuiz: (draft, idempotencyKey) =>
      call("runtime", `${config.runtimeApiBase}/api/v1/internal/runtime/quizzes`, {
        method: "POST", headers: { ...internal(), "idempotency-key": idempotencyKey }, body: draft,
      }),
    launchBatch: (objectId, learners, idempotencyKey) =>
      call("runtime", `${config.runtimeApiBase}/api/v1/internal/runtime/launch-batch`, {
        method: "POST",
        headers: { ...internal(), "idempotency-key": idempotencyKey },
        // include_descriptors is deliberately omitted (defaults to false). Learner launch descriptors
        // are learner-scoped credentials; the agent-facing surface must never receive one.
        body: { object_id: objectId, learners: learners.map((learner) => ({ learner_id: learner.learner_id })) },
      }),
    getActivityResults: (objectId) =>
      call("evidence", `${config.evidenceApiBase}/api/v1/evidence/activity-results?object_id=${encodeURIComponent(objectId)}`),
  };
}
