/**
 * The teacher-facing preview: a read-only look at what an object delivers, without a real launch.
 * What matters here: each of the four data-authored kinds returns the content a teacher would
 * actually want to review, a quiz's marking key never comes back, an unsupported (code-bundled) kind
 * refuses cleanly rather than pretending to have something to show, and a caller who is merely an
 * admin — no repository membership required — can still preview.
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
  const issuer = `https://ies.preview-${randomUUID()}.test`;
  const catalogue = new MemoryCatalogueStore({ seedExamples: true });
  const store = new MemoryRuntimeStore();
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.preview-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 4), store, catalogue,
  });
  const token = await issueIesToken(ies.privateKey, "preview-admin", "lorb-runtime", issuer, { role: "admin" });
  const learnerToken = await issueIesToken(ies.privateKey, "preview-learner", "lorb-runtime", issuer, {});
  const repository = (await catalogue.defaultRepository())!;

  const call = (method: "GET" | "POST", url: string, payload?: unknown, as = token) =>
    runtime.app.inject({
      method, url,
      headers: { authorization: `Bearer ${as}`, ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}) },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  return { runtime, catalogue, call, repositoryId: repository.repository_id, learnerToken };
}

describe("learning object preview", () => {
  it("previews a quiz without its marking key", async () => {
    const { runtime, call, repositoryId } = await setup();
    const quiz = await call("POST", "/api/v1/publisher/learning-objects/quizzes", {
      repository_id: repositoryId, title: "Preview quiz",
      questions: [{ stem: "2 + 2?", options: [{ id: "a", text: "4" }, { id: "b", text: "5" }], correct_option_id: "a", explanation: "Basic addition" }],
    });
    expect(quiz.statusCode).toBe(201);

    const preview = await call("GET", `/api/v1/admin/learning-objects/${quiz.json().object_id}/preview`);
    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    expect(body.kind).toBe("quiz");
    expect(body.questions).toEqual([{ stem: "2 + 2?", options: [{ id: "a", text: "4" }, { id: "b", text: "5" }] }]);
    expect(preview.body).not.toContain("correct_option_id");
    expect(preview.body).not.toContain("Basic addition");
  });

  it("previews a video, document, and audio object with their actual content", async () => {
    const { runtime, call, repositoryId } = await setup();
    const video = await call("POST", "/api/v1/publisher/learning-objects/videos", {
      repository_id: repositoryId, title: "Preview video", source: { kind: "youtube", video_id: "dQw4w9WgXcQ" },
    });
    const document = await call("POST", "/api/v1/publisher/learning-objects/documents", {
      repository_id: repositoryId, title: "Preview slides", source_format: "pptx",
      pages: [{ index: 0, image_url: "https://files.test/page-0.png" }],
    });
    const audio = await call("POST", "/api/v1/publisher/learning-objects/audio", {
      repository_id: repositoryId, title: "Preview audio", source: { url: "https://files.test/intro.mp3", mime_type: "audio/mpeg" },
    });

    const videoPreview = await call("GET", `/api/v1/admin/learning-objects/${video.json().object_id}/preview`);
    expect(videoPreview.json()).toMatchObject({ kind: "video", source: { kind: "youtube", video_id: "dQw4w9WgXcQ" } });

    const documentPreview = await call("GET", `/api/v1/admin/learning-objects/${document.json().object_id}/preview`);
    expect(documentPreview.json()).toMatchObject({ kind: "document", pages: [{ index: 0, image_url: "https://files.test/page-0.png" }] });

    const audioPreview = await call("GET", `/api/v1/admin/learning-objects/${audio.json().object_id}/preview`);
    expect(audioPreview.json()).toMatchObject({ kind: "audio", source: { url: "https://files.test/intro.mp3", mime_type: "audio/mpeg" } });

    await runtime.app.close();
  });

  it("reports an unsupported kind for a code-bundled object, rather than pretending to preview it", async () => {
    const { runtime, catalogue, call } = await setup();
    const [seeded] = await catalogue.learningObjects({ status: "PUBLISHED" });
    const preview = await call("GET", `/api/v1/admin/learning-objects/${seeded!.object_id}/preview`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().kind).toBe("unsupported");
    await runtime.app.close();
  });

  it("refuses an unpublished or unknown object", async () => {
    const { runtime, call } = await setup();
    const missing = await call("GET", `/api/v1/admin/learning-objects/${randomUUID()}/preview`);
    expect(missing.statusCode).toBe(404);
    await runtime.app.close();
  });

  it("refuses a non-admin caller", async () => {
    const { runtime, call, catalogue, learnerToken } = await setup();
    const [seeded] = await catalogue.learningObjects({ status: "PUBLISHED" });
    const response = await call("GET", `/api/v1/admin/learning-objects/${seeded!.object_id}/preview`, undefined, learnerToken);
    expect(response.statusCode).toBe(403);
    await runtime.app.close();
  });
});
