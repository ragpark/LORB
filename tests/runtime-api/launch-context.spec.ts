/**
 * Launch context: publisher-authored configuration an object carries into its own launch.
 *
 * The contract under test is the versioning rule, because that is the part that protects a learner:
 * setting a context publishes a new object version, an attempt launched before the change keeps the
 * context its descriptor pinned, and a content edit carries the context forward rather than silently
 * dropping the theme. The validation rules are the security posture: a theme is a token, never a
 * URL, and settings are small named scalars — the module is sandboxed and this payload must never
 * become a resource-loading or secret-carrying channel.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

async function setup() {
  const ies = await generateKeyPair("ES256");
  const issuer = `https://ies.launch-context-${randomUUID()}.test`;
  const catalogue = new MemoryCatalogueStore({ seedExamples: true });
  const store = new MemoryRuntimeStore();
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.launch-context-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 6), store, catalogue,
  });
  const token = await issueIesToken(ies.privateKey, "launch-context-admin", "lorb-runtime", issuer, { role: "admin" });

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    runtime.app.inject({
      method, url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  const authorQuiz = async () => {
    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", {
      title: "Launch context quiz",
      questions: [
        { stem: "Which is equivalent to 1/2?", options: [{ id: "a", text: "2/4" }, { id: "b", text: "1/3" }], correct_option_id: "a" },
      ],
    });
    expect(created.statusCode).toBe(201);
    return created.json() as { object_id: string; object_version_id: string };
  };

  return { runtime, catalogue, call, authorQuiz, token };
}

describe("launch context", () => {
  it("publishes a new object version carrying the context, and the content route serves it", async () => {
    const { call, catalogue, authorQuiz } = await setup();
    const quiz = await authorQuiz();

    const set = await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/launch-context`, {
      launch_context: { theme: "midnight", settings: { hints_enabled: true } },
    });
    expect(set.statusCode).toBe(200);
    const revision = set.json() as { object_version_id: string; semver: string; launch_context: { theme: string } };
    expect(revision.object_version_id).not.toBe(quiz.object_version_id);
    expect(revision.launch_context.theme).toBe("midnight");

    const object = (await catalogue.learningObject(quiz.object_id))!;
    expect(object.active_object_version_id).toBe(revision.object_version_id);

    const content = await call("GET", `/api/v1/runtime/learning-objects/${quiz.object_id}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.json().launch_context).toEqual({ theme: "midnight", settings: { hints_enabled: true } });
  });

  it("keeps a pinned attempt on the context its descriptor named", async () => {
    const { call, authorQuiz } = await setup();
    const quiz = await authorQuiz();
    // The version an attempt would have pinned before any context existed.
    const pinnedVersion = quiz.object_version_id;

    const set = await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/launch-context`, {
      launch_context: { theme: "midnight" },
    });
    expect(set.statusCode).toBe(200);

    const pinned = await call("GET", `/api/v1/runtime/learning-objects/${quiz.object_id}/content?object_version_id=${pinnedVersion}`);
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().launch_context).toBeUndefined();

    const current = await call("GET", `/api/v1/runtime/learning-objects/${quiz.object_id}/content`);
    expect(current.json().launch_context).toEqual({ theme: "midnight" });
  });

  it("carries the context forward through a content edit", async () => {
    const { call, authorQuiz } = await setup();
    const quiz = await authorQuiz();
    await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/launch-context`, {
      launch_context: { theme: "high-contrast" },
    });

    const edited = await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/content`, {
      title: "Launch context quiz, revised",
      questions: [
        { stem: "Which is equivalent to 2/4?", options: [{ id: "a", text: "1/2" }, { id: "b", text: "1/3" }], correct_option_id: "a" },
      ],
    });
    expect(edited.statusCode).toBe(200);

    const content = await call("GET", `/api/v1/runtime/learning-objects/${quiz.object_id}/content`);
    expect(content.json().launch_context).toEqual({ theme: "high-contrast" });
  });

  it("clears the context with null, again as a new version", async () => {
    const { call, catalogue, authorQuiz } = await setup();
    const quiz = await authorQuiz();
    await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/launch-context`, { launch_context: { theme: "midnight" } });
    const before = (await catalogue.learningObject(quiz.object_id))!.active_object_version_id;

    const cleared = await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/launch-context`, { launch_context: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().object_version_id).not.toBe(before);

    const content = await call("GET", `/api/v1/runtime/learning-objects/${quiz.object_id}/content`);
    expect(content.json().launch_context).toBeUndefined();
  });

  it("refuses a theme that is not a token, oversized settings, and unknown fields", async () => {
    const { call, authorQuiz } = await setup();
    const quiz = await authorQuiz();
    const refuse = async (launch_context: unknown) => {
      const response = await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/launch-context`, { launch_context });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("ADMIN_REQUEST_INVALID");
    };
    await refuse({ theme: "https://evil.example/steal.css" });
    await refuse({ theme: "Midnight" });
    await refuse({ stylesheet_url: "https://evil.example/steal.css" });
    await refuse({ settings: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key_${i}`, true])) });
    await refuse({ settings: { endpoint: { nested: "object" } } });
  });

  it("refuses the edit on a retired object and requires an administrator", async () => {
    const { call, runtime, authorQuiz } = await setup();
    const quiz = await authorQuiz();
    await call("POST", `/api/v1/publisher/learning-objects/${quiz.object_id}/retire`);
    const retired = await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/launch-context`, { launch_context: { theme: "midnight" } });
    expect(retired.statusCode).toBe(409);

    const anonymous = await runtime.app.inject({
      method: "PUT", url: `/api/v1/publisher/learning-objects/${quiz.object_id}/launch-context`,
      headers: { "idempotency-key": randomUUID() }, payload: { launch_context: { theme: "midnight" } },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
