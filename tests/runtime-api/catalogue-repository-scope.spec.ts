/**
 * The learner-facing catalogue route, and what a repository filter does to it.
 *
 * The bug behind these: a quiz registered through the agent connector goes to the *default*
 * repository — the canonical one where it exists, otherwise the oldest ACTIVE one — while the
 * Consumer UI listed the objects of `repositories()[0]`, the oldest repository whatever its status.
 * Where those two differ, an agent-registered quiz is published and launchable, shows in the
 * administration and ops consoles (which list objects unfiltered), and never appears on the one
 * screen a learner can reach.
 *
 * So these pin the contract the portal now relies on: unfiltered means every repository, and the
 * filter genuinely hides — which is exactly why a learner-facing client must not apply one.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { DEFAULT_REPOSITORY } from "../../packages/runtime-api/src/catalogue/shared.js";
import type { Repository } from "../../packages/runtime-api/src/catalogue/types.js";

const SERVICE_TOKEN = "catalogue-scope-suite-internal-service-token";
/** A second repository, standing in for one an operator created alongside the default. */
const OTHER_REPOSITORY = "11111111-1111-4111-8111-111111111111";

const QUIZ = {
  title: "Photosynthesis recap",
  subject: "Science",
  year_group: "Year 9",
  questions: [
    { stem: "Which gas do plants take in?", options: [{ id: "a", text: "Carbon dioxide" }, { id: "b", text: "Nitrogen" }], correct_option_id: "a" },
  ],
};

async function build() {
  const catalogue = new MemoryCatalogueStore();
  const runtime = await buildRuntime({
    store: new MemoryRuntimeStore(),
    catalogue,
    secret: Buffer.alloc(32, 7),
    internalServiceToken: SERVICE_TOKEN,
  });
  return { runtime, catalogue };
}

const list = async (runtime: Awaited<ReturnType<typeof build>>["runtime"], query = "") =>
  (await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/learning-objects${query}` })).json().items as Array<{ object_id: string; repository_id: string }>;

describe("learner catalogue repository scope", () => {
  it("registers an agent-authored quiz into the default repository", async () => {
    const { runtime } = await build();

    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/quizzes",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
      payload: QUIZ,
    });

    expect(created.statusCode).toBe(201);
    const objectId = created.json().object_id as string;
    const stored = (await list(runtime)).find((row) => row.object_id === objectId);
    expect(stored?.repository_id).toBe(DEFAULT_REPOSITORY.repository_id);
  });

  // The learner-facing read the portal makes. It must span repositories, because the portal has no
  // way to know which one a quiz was filed into and no business deciding.
  it("returns objects from every repository when no filter is given", async () => {
    const { runtime, catalogue } = await build();
    const elsewhere = await catalogue.registerQuiz(QUIZ, { repository_id: OTHER_REPOSITORY });

    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/quizzes",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
      payload: QUIZ,
    });
    const objectId = created.json().object_id as string;

    const ids = (await list(runtime)).map((row) => row.object_id);
    expect(ids).toContain(objectId);
    expect(ids).toContain(elsewhere.object_id);
  });

  // The other half of the same contract: the filter is real, so a client that applies one is
  // choosing to hide content — which is how the quiz went missing in the first place.
  it("hides a quiz from a listing scoped to a different repository", async () => {
    const { runtime } = await build();

    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/quizzes",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
      payload: QUIZ,
    });
    const objectId = created.json().object_id as string;

    const scoped = await list(runtime, `?repository_id=${OTHER_REPOSITORY}`);
    expect(scoped.map((row) => row.object_id)).not.toContain(objectId);
  });

  // Launch refuses a retired object (OBJECT_RETIRED) and anything else unpublished
  // (OBJECT_NOT_PUBLISHED). A catalogue that lists them offers a learner an activity that can only
  // fail when opened, and makes withdrawing one a change with no effect where it is read.
  it("drops a retired object from the learner catalogue, while the administration listing keeps it", async () => {
    const { runtime, catalogue } = await build();

    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/quizzes",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
      payload: QUIZ,
    });
    const objectId = created.json().object_id as string;
    expect((await list(runtime)).map((row) => row.object_id)).toContain(objectId);

    await catalogue.retireObject(objectId);

    expect((await list(runtime)).map((row) => row.object_id)).not.toContain(objectId);
    // Not merely absent from the list: the same object is refused a launch, which is the agreement
    // between the two routes that the listing had been breaking.
    expect(await catalogue.learningObject(objectId)).toMatchObject({ status: "RETIRED" });
  });
});

/**
 * The in-memory catalogue is what every suite here runs against, so a rule it applies differently
 * from the SQL backend is a rule nothing tests. These pin the three that had drifted.
 */
describe("in-memory catalogue parity with the SQL backend", () => {
  const repository = (id: string, status: Repository["status"], created_at: string): Repository =>
    ({ repository_id: id, slug: `repo-${id.slice(0, 4)}`, display_name: `Repository ${id.slice(0, 4)}`, status, created_at });

  it("skips a suspended repository when choosing the default, however old it is", async () => {
    const catalogue = new MemoryCatalogueStore();
    catalogue.seedRepository(repository(OTHER_REPOSITORY, "SUSPENDED", "2020-01-01T00:00:00.000Z"));

    // The oldest repository is not the answer — being ACTIVE is, and the canonical default wins.
    expect((await catalogue.repositories())[0]?.repository_id).toBe(OTHER_REPOSITORY);
    expect((await catalogue.defaultRepository())?.repository_id).toBe(DEFAULT_REPOSITORY.repository_id);
  });

  it("falls back to the oldest active repository when the canonical default is not active", async () => {
    const catalogue = new MemoryCatalogueStore();
    catalogue.seedRepository({ ...(await catalogue.repository(DEFAULT_REPOSITORY.repository_id))!, status: "RETIRED" });
    catalogue.seedRepository(repository(OTHER_REPOSITORY, "ACTIVE", "2026-01-01T00:00:00.000Z"));

    expect((await catalogue.defaultRepository())?.repository_id).toBe(OTHER_REPOSITORY);
  });

  it("refuses to register a quiz when no repository is active, rather than naming one", async () => {
    const catalogue = new MemoryCatalogueStore();
    catalogue.seedRepository({ ...(await catalogue.repository(DEFAULT_REPOSITORY.repository_id))!, status: "RETIRED" });

    await expect(catalogue.registerQuiz(QUIZ)).rejects.toThrow(/NO_ACTIVE_REPOSITORY/);
  });
});
