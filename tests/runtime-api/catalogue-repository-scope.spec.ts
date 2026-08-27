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
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { DEFAULT_REPOSITORY } from "../../packages/runtime-api/src/catalogue/shared.js";

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
  const keys = await generateKeyPair("ES256");
  const issuer = "https://ies.catalogue-scope.test";
  const runtime = await buildRuntime({
    store: new MemoryRuntimeStore(),
    catalogue,
    secret: Buffer.alloc(32, 7),
    internalServiceToken: SERVICE_TOKEN,
    iesKey: keys.publicKey as never,
    iesIssuer: issuer,
  });
  // The catalogue is read as a signed-in learner: any subject the provider vouches for.
  const learnerToken = await issueIesToken(keys.privateKey as never, "catalogue-scope-learner", "lorb-runtime", issuer, {});
  return { runtime, catalogue, learnerToken };
}

const list = async ({ runtime, learnerToken }: Awaited<ReturnType<typeof build>>, query = "") =>
  (await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/learning-objects${query}`, headers: { authorization: `Bearer ${learnerToken}` } })).json().items as Array<{ object_id: string; repository_id: string }>;

describe("learner catalogue repository scope", () => {
  it("registers an agent-authored quiz into the default repository", async () => {
    const built = await build();
    const { runtime } = built;

    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/quizzes",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
      payload: QUIZ,
    });

    expect(created.statusCode).toBe(201);
    const objectId = created.json().object_id as string;
    const stored = (await list(built)).find((row) => row.object_id === objectId);
    expect(stored?.repository_id).toBe(DEFAULT_REPOSITORY.repository_id);
  });

  // The learner-facing read the portal makes. It must span repositories, because the portal has no
  // way to know which one a quiz was filed into and no business deciding.
  it("returns objects from every repository when no filter is given", async () => {
    const built = await build();
    const { runtime, catalogue } = built;
    const elsewhere = await catalogue.registerQuiz(QUIZ, { repository_id: OTHER_REPOSITORY });

    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/quizzes",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
      payload: QUIZ,
    });
    const objectId = created.json().object_id as string;

    const ids = (await list(built)).map((row) => row.object_id);
    expect(ids).toContain(objectId);
    expect(ids).toContain(elsewhere.object_id);
  });

  // The other half of the same contract: the filter is real, so a client that applies one is
  // choosing to hide content — which is how the quiz went missing in the first place.
  it("hides a quiz from a listing scoped to a different repository", async () => {
    const built = await build();
    const { runtime } = built;

    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/quizzes",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
      payload: QUIZ,
    });
    const objectId = created.json().object_id as string;

    const scoped = await list(built, `?repository_id=${OTHER_REPOSITORY}`);
    expect(scoped.map((row) => row.object_id)).not.toContain(objectId);
  });
});
