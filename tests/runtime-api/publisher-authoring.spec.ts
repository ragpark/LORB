/**
 * Authoring, editing and withdrawing learning objects through the Publisher API.
 *
 * The catalogue could be added to and never corrected. A title typed wrong stayed wrong; a quiz
 * whose marking key sat on the wrong option could only be replaced by a second quiz with a different
 * identifier, leaving the mis-keyed one in the catalogue and every assignment pointing at it. What is
 * checked here is that correcting those things is possible *and* that correcting them cannot rewrite
 * what a learner was already delivered:
 *
 *   - an edit changes what the catalogue says, never what a launch resolves to;
 *   - editing content supersedes a version rather than overwriting one, and the superseded content
 *     stays readable;
 *   - an object that has been launched or assigned is retired, never deleted;
 *   - a suspended or retired object loses its login-free smart link in the same action.
 *
 * The suite runs against the in-memory catalogue: repository membership lives in the administration
 * database, and everything above is true of both backends.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import type { QuizContent } from "../../packages/contracts/src/index.js";

async function setup() {
  const ies = await generateKeyPair("ES256");
  const issuer = `https://ies.authoring-${randomUUID()}.test`;
  const catalogue = new MemoryCatalogueStore({ seedExamples: true });
  const store = new MemoryRuntimeStore();
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.authoring-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 5), store, catalogue,
  });
  const token = await issueIesToken(ies.privateKey, "authoring-admin", "lorb-runtime", issuer, { role: "admin" });
  const learnerToken = await issueIesToken(ies.privateKey, "authoring-learner", "lorb-runtime", issuer, {});
  const repository = (await catalogue.defaultRepository())!;

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, as = token) =>
    runtime.app.inject({
      method, url,
      headers: {
        authorization: `Bearer ${as}`,
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  return { runtime, store, catalogue, call, token, learnerToken, repositoryId: repository.repository_id };
}

const quiz = (title = "Fractions check-in") => ({
  title,
  description: "Three questions on equivalent fractions.",
  questions: [
    { stem: "Which is equivalent to 1/2?", options: [{ id: "a", text: "2/4" }, { id: "b", text: "1/3" }], correct_option_id: "a" },
  ],
});

const packagedObject = (repositoryId: string) => ({
  repository_id: repositoryId,
  title: "Ratios and proportion",
  description: "A packaged activity.",
  duration: "20 minutes",
  module_path: "/modules/ratios/index.html",
  semver: "1.0.0",
  sha256: "a".repeat(64),
});

describe("Publisher authoring and CRUD", () => {
  it("authors a quiz, reads it back with its marking key, and lists it in the catalogue", async () => {
    const { call, repositoryId } = await setup();

    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", { repository_id: repositoryId, ...quiz() });
    expect(created.statusCode).toBe(201);
    const objectId = created.json().object_id as string;
    expect(created.json().question_count).toBe(1);

    const detail = await call("GET", `/api/v1/publisher/learning-objects/${objectId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().editable_content).toBe(true);
    expect(detail.json().versions).toHaveLength(1);

    const content = await call("GET", `/api/v1/publisher/learning-objects/${objectId}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.headers["cache-control"]).toBe("no-store");
    expect(content.json().questions[0].correct_option_id).toBe("a");
  });

  it("refuses to author a quiz for anyone who is not an administrator", async () => {
    const { call, learnerToken, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", { repository_id: repositoryId, ...quiz() }, learnerToken);
    expect(created.statusCode).toBe(403);
    expect(created.json().code).toBe("ADMIN_AUDIT_DENIED");
  });

  it("edits the catalogue entry without moving what a launch resolves to", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects", packagedObject(repositoryId));
    const before = created.json();

    const edited = await call("PATCH", `/api/v1/publisher/learning-objects/${before.object_id}`, {
      title: "Ratios and proportion (revised)",
      description: "Now with worked examples.",
      duration: "25 minutes",
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().title).toBe("Ratios and proportion (revised)");
    expect(edited.json().duration).toBe("25 minutes");
    // The version chain is untouched, so an attempt pinned to it still describes what was delivered.
    expect(edited.json().active_package_version_id).toBe(before.active_package_version_id);
    expect(edited.json().active_object_version_id).toBe(before.active_object_version_id);
    expect(edited.json().module_path).toBe(before.module_path);
  });

  it("refuses an edit that tries to repoint the package", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects", packagedObject(repositoryId));
    const rejected = await call("PATCH", `/api/v1/publisher/learning-objects/${created.json().object_id}`, {
      title: "Fine", module_path: "/modules/somewhere-else/index.html",
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe("ADMIN_REQUEST_INVALID");
  });

  it("refuses an edit that changes nothing", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects", packagedObject(repositoryId));
    const rejected = await call("PATCH", `/api/v1/publisher/learning-objects/${created.json().object_id}`, {});
    expect(rejected.statusCode).toBe(400);
  });

  it("supersedes a quiz's content rather than overwriting it, and keeps the superseded version readable", async () => {
    const { call, catalogue, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", { repository_id: repositoryId, ...quiz() });
    const objectId = created.json().object_id as string;
    const firstVersionId = created.json().object_version_id as string;

    const revised = await call("PUT", `/api/v1/publisher/learning-objects/${objectId}/content`, {
      title: "Fractions check-in (corrected)",
      questions: [
        { stem: "Which is equivalent to 1/2?", options: [{ id: "a", text: "2/4" }, { id: "b", text: "1/3" }], correct_option_id: "a" },
        { stem: "Which is equivalent to 1/4?", options: [{ id: "a", text: "2/8" }, { id: "b", text: "3/4" }], correct_option_id: "a" },
      ],
    });
    expect(revised.statusCode).toBe(200);
    expect(revised.json().content_version).toBe("2");
    expect(revised.json().question_count).toBe(2);
    expect(revised.json().object_version_id).not.toBe(firstVersionId);

    // The object keeps its identity, so every assignment and smart link still points at it.
    const detail = await call("GET", `/api/v1/publisher/learning-objects/${objectId}`);
    expect(detail.json().object_id).toBe(objectId);
    expect(detail.json().title).toBe("Fractions check-in (corrected)");
    expect(detail.json().versions).toHaveLength(2);
    expect(detail.json().versions.find((v: { object_version_id: string }) => v.object_version_id === firstVersionId).status).toBe("SUPERSEDED");

    // What the first version's learners answered is still readable at the version they answered it at.
    const original = await catalogue.contentRevision(objectId, "1") as QuizContent | undefined;
    expect(original?.questions).toHaveLength(1);
    expect(((await catalogue.content(objectId)) as QuizContent | undefined)?.questions).toHaveLength(2);
  });

  it("keeps serving a launched version its own questions after the quiz has been edited", async () => {
    const { runtime, call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", { repository_id: repositoryId, ...quiz() });
    const objectId = created.json().object_id as string;
    const launchedVersionId = created.json().object_version_id as string;

    await call("PUT", `/api/v1/publisher/learning-objects/${objectId}/content`, {
      title: "Fractions check-in",
      questions: [
        { stem: "Which is equivalent to 1/2?", options: [{ id: "a", text: "2/4" }, { id: "b", text: "1/3" }], correct_option_id: "a" },
        { stem: "And 1/4?", options: [{ id: "a", text: "2/8" }, { id: "b", text: "3/4" }], correct_option_id: "a" },
      ],
    });

    // What the player fetches is pinned to the object version its descriptor named, so a learner
    // half way through the one-question version is not suddenly given a two-question one.
    const pinned = await runtime.app.inject({
      method: "GET", url: `/api/v1/runtime/learning-objects/${objectId}/content?object_version_id=${launchedVersionId}`,
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().questions).toHaveLength(1);
    expect(pinned.json().content_version).toBe("1");

    // A launch issued now gets the edited version.
    const current = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/learning-objects/${objectId}/content` });
    expect(current.json().questions).toHaveLength(2);
  });

  it("refuses to edit the content of an object whose payload is code rather than data", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects", packagedObject(repositoryId));
    const rejected = await call("PUT", `/api/v1/publisher/learning-objects/${created.json().object_id}/content`, quiz());
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("LEARNING_OBJECT_CONTENT_UNSUPPORTED");
  });

  it("refuses quiz content whose marking key names an option that is not offered", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", { repository_id: repositoryId, ...quiz() });
    const rejected = await call("PUT", `/api/v1/publisher/learning-objects/${created.json().object_id}/content`, {
      title: "Broken", questions: [{ stem: "Pick one", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correct_option_id: "c" }],
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("refuses to publish a code package version for an authored quiz", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", { repository_id: repositoryId, ...quiz() });
    const rejected = await call("POST", `/api/v1/publisher/learning-objects/${created.json().object_id}/versions`, {
      semver: "2.0.0", module_path: "/modules/not-the-quiz-player/index.html", sha256: "b".repeat(64),
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("LEARNING_OBJECT_CONTENT_UNSUPPORTED");
  });

  it("suspends, restores and retires an object, and revokes its smart link when it leaves the catalogue", async () => {
    const { call, store, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects", packagedObject(repositoryId));
    const objectId = created.json().object_id as string;

    const link = await call("POST", `/api/v1/admin/learning-objects/${objectId}/smart-link`);
    expect(link.statusCode).toBe(201);

    const suspended = await call("POST", `/api/v1/publisher/learning-objects/${objectId}/suspend`);
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().status).toBe("SUSPENDED");
    expect(await store.activeSmartLinkForObject(objectId)).toBeUndefined();

    // A suspended object is not launchable, and asking again is refused rather than silently ignored.
    expect((await call("POST", `/api/v1/publisher/learning-objects/${objectId}/suspend`)).statusCode).toBe(409);

    const restored = await call("POST", `/api/v1/publisher/learning-objects/${objectId}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().status).toBe("PUBLISHED");

    const retired = await call("POST", `/api/v1/publisher/learning-objects/${objectId}/retire`);
    expect(retired.statusCode).toBe(200);
    expect(retired.json().status).toBe("RETIRED");
    // Retirement is the end of the line: it does not reverse.
    expect((await call("POST", `/api/v1/publisher/learning-objects/${objectId}/restore`)).statusCode).toBe(409);
    expect((await call("PATCH", `/api/v1/publisher/learning-objects/${objectId}`, { title: "Too late" })).statusCode).toBe(409);
  });

  it("deletes a withdrawn object that was never delivered, and refuses to delete one that was", async () => {
    const { call, store, catalogue, repositoryId } = await setup();

    const disposable = await call("POST", "/api/v1/publisher/learning-objects", packagedObject(repositoryId));
    const disposableId = disposable.json().object_id as string;

    // A published object is one a launch can still resolve, so it is withdrawn first rather than
    // deleted out from under a launch that is already in flight.
    const tooSoon = await call("DELETE", `/api/v1/publisher/learning-objects/${disposableId}`);
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json().code).toBe("LEARNING_OBJECT_DELIVERABLE");
    expect(await catalogue.learningObject(disposableId)).toBeDefined();

    expect((await call("POST", `/api/v1/publisher/learning-objects/${disposableId}/suspend`)).statusCode).toBe(200);
    const deleted = await call("DELETE", `/api/v1/publisher/learning-objects/${disposableId}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().deleted).toBe(true);
    expect(await catalogue.learningObject(disposableId)).toBeUndefined();
    expect(await catalogue.packageVersions({ object_id: disposableId })).toHaveLength(0);

    const launched = await call("POST", "/api/v1/publisher/learning-objects", {
      ...packagedObject(repositoryId), module_path: "/modules/launched/index.html",
    });
    const launchedId = launched.json().object_id as string;
    await store.createAttempt({
      attempt_id: randomUUID(), repository_id: repositoryId, object_id: launchedId,
      object_version_id: launched.json().active_object_version_id,
      package_version_id: launched.json().active_package_version_id,
      pseudonym: "f".repeat(64), consumer_id: "test", status: "COMPLETED", revision: 1,
      correlation_id: randomUUID(), created_at: new Date().toISOString(), source: "consumer",
    });
    expect((await call("POST", `/api/v1/publisher/learning-objects/${launchedId}/retire`)).statusCode).toBe(200);
    const refused = await call("DELETE", `/api/v1/publisher/learning-objects/${launchedId}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("LEARNING_OBJECT_IN_USE");
    expect(await catalogue.learningObject(launchedId)).toBeDefined();
  });

  it("refuses to delete an object that has been assigned", async () => {
    const { call, store, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects", packagedObject(repositoryId));
    const objectId = created.json().object_id as string;
    await store.recordAssignment({
      assignment_id: randomUUID(), object_id: objectId, created_at: new Date().toISOString(),
      source: "class", pseudonyms: ["e".repeat(64)],
    });
    expect((await call("POST", `/api/v1/publisher/learning-objects/${objectId}/suspend`)).statusCode).toBe(200);
    const refused = await call("DELETE", `/api/v1/publisher/learning-objects/${objectId}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("LEARNING_OBJECT_IN_USE");
  });

  it("replays a retried edit rather than applying it twice", async () => {
    const { runtime, call, token, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", { repository_id: repositoryId, ...quiz() });
    const objectId = created.json().object_id as string;
    const key = randomUUID();
    const payload = {
      title: "Fractions check-in (v2)",
      questions: [{ stem: "1/2 is?", options: [{ id: "a", text: "2/4" }, { id: "b", text: "1/3" }], correct_option_id: "a" }],
    };
    const request = {
      method: "PUT" as const, url: `/api/v1/publisher/learning-objects/${objectId}/content`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key }, payload,
    };
    const first = await runtime.app.inject(request);
    const second = await runtime.app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // One edit, one new version — a lost response and its retry must not publish twice.
    expect(second.json().object_version_id).toBe(first.json().object_version_id);
    expect(second.json().content_version).toBe(first.json().content_version);
    const detail = await call("GET", `/api/v1/publisher/learning-objects/${objectId}`);
    expect(detail.json().versions).toHaveLength(2);
  });

  it("demands an idempotency key on every mutation", async () => {
    const { runtime, call, token, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects", packagedObject(repositoryId));
    const objectId = created.json().object_id as string;
    for (const [method, url] of [
      ["PATCH", `/api/v1/publisher/learning-objects/${objectId}`],
      ["DELETE", `/api/v1/publisher/learning-objects/${objectId}`],
      ["POST", `/api/v1/publisher/learning-objects/${objectId}/suspend`],
    ] as const) {
      const response = await runtime.app.inject({
        method, url, headers: { authorization: `Bearer ${token}` },
        ...(method === "PATCH" ? { payload: { title: "x" } as never } : {}),
      });
      expect(response.json().code, `${method} ${url}`).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
  });
});
