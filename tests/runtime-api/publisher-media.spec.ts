/**
 * Registering video, document, and audio learning objects through the Publisher API — the
 * person-reachable counterpart to the internal service surface the agent connector uses
 * (tests/runtime-api/internal-media.spec.ts covers that one). Same authoring shape and trust model
 * as authoring a quiz: an administrator, repository membership, structured JSON content, never a
 * bundle. What matters here: an admin token succeeds and a learner token is refused (same as the
 * quiz route), each kind lands on its own shared player, and the document-upload convenience route
 * converts a file through the document-converter service before registering it — or refuses cleanly
 * when that service isn't configured.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

async function setup(options: { documentConverterUrl?: string; fetchImpl?: typeof fetch } = {}) {
  const ies = await generateKeyPair("ES256");
  const issuer = `https://ies.publisher-media-${randomUUID()}.test`;
  const catalogue = new MemoryCatalogueStore({ seedExamples: true });
  const store = new MemoryRuntimeStore();
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.publisher-media-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 6), store, catalogue, documentConverterUrl: options.documentConverterUrl,
  });
  if (options.fetchImpl) vi.stubGlobal("fetch", options.fetchImpl);
  const token = await issueIesToken(ies.privateKey, "media-admin", "lorb-runtime", issuer, { role: "admin" });
  const learnerToken = await issueIesToken(ies.privateKey, "media-learner", "lorb-runtime", issuer, {});
  const repository = (await catalogue.defaultRepository())!;

  const call = (url: string, payload: unknown, as = token) =>
    runtime.app.inject({
      method: "POST", url,
      headers: { authorization: `Bearer ${as}`, "idempotency-key": randomUUID() },
      payload: payload as never,
    });

  return { runtime, catalogue, call, repositoryId: repository.repository_id };
}

const videoDraft = { title: "Cell division", source: { kind: "youtube", video_id: "dQw4w9WgXcQ" } };
const documentDraft = {
  title: "Week 3 slides", source_format: "pptx",
  pages: [{ index: 0, image_url: "https://files.test/page-0.png" }],
};
const audioDraft = { title: "Narrated intro", source: { url: "https://files.test/intro.mp3", mime_type: "audio/mpeg" } };

describe("publisher media registration", () => {
  it("registers a video, a document, and an audio object as an administrator", async () => {
    const { runtime, catalogue, call, repositoryId } = await setup();

    const video = await call("/api/v1/publisher/learning-objects/videos", { repository_id: repositoryId, ...videoDraft });
    expect(video.statusCode).toBe(201);
    const document = await call("/api/v1/publisher/learning-objects/documents", { repository_id: repositoryId, ...documentDraft });
    expect(document.statusCode).toBe(201);
    const audio = await call("/api/v1/publisher/learning-objects/audio", { repository_id: repositoryId, ...audioDraft });
    expect(audio.statusCode).toBe(201);

    const videoObject = await catalogue.learningObject(video.json().object_id as string);
    const documentObject = await catalogue.learningObject(document.json().object_id as string);
    const audioObject = await catalogue.learningObject(audio.json().object_id as string);
    expect(videoObject?.module_path).toBe("/modules/video-player/index.html");
    expect(documentObject?.module_path).toBe("/modules/document-player/index.html");
    expect(audioObject?.module_path).toBe("/modules/audio-player/index.html");
    expect(video.json().repository_id).toBe(repositoryId);

    await runtime.app.close();
  });

  it("refuses a draft shaped for the wrong kind", async () => {
    const { runtime, call, repositoryId } = await setup();
    // A document draft posted to the video route: source_format/pages aren't a videoDraftSchema shape.
    const wrongKind = await call("/api/v1/publisher/learning-objects/videos", { repository_id: repositoryId, ...documentDraft });
    expect(wrongKind.statusCode).toBe(400);
    await runtime.app.close();
  });

  it("refuses a non-admin caller", async () => {
    const ies = await generateKeyPair("ES256");
    const issuer = `https://ies.publisher-media-refuse-${randomUUID()}.test`;
    const catalogue = new MemoryCatalogueStore({ seedExamples: true });
    const store = new MemoryRuntimeStore();
    const runtime = await buildRuntime({
      iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.publisher-media-refuse-${randomUUID()}.test`,
      secret: Buffer.alloc(32, 7), store, catalogue,
    });
    const learnerToken = await issueIesToken(ies.privateKey, "media-learner", "lorb-runtime", issuer, {});
    const repository = (await catalogue.defaultRepository())!;
    const response = await runtime.app.inject({
      method: "POST", url: "/api/v1/publisher/learning-objects/audio",
      headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
      payload: { repository_id: repository.repository_id, ...audioDraft } as never,
    });
    expect(response.statusCode).toBe(403);
    await runtime.app.close();
  });

  it("refuses a document upload when no document-converter is configured", async () => {
    const { runtime, call } = await setup();
    const response = await call("/api/v1/publisher/learning-objects/documents/upload", {
      title: "Week 3 slides", source_format: "pptx", filename: "week-3.pptx", content_base64: "Zm9v",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("DOCUMENT_CONVERTER_NOT_CONFIGURED");
    await runtime.app.close();
  });

  it("converts and registers a document upload through a configured document-converter", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(String(url)).toBe("https://converter.test/convert");
      return new Response(JSON.stringify({
        conversion_id: randomUUID(), page_count: 1,
        draft: { title: "Week 3 slides", source_format: "pptx", pages: [{ index: 0, image_url: "https://files.test/page-0.png" }] },
      }), { status: 201 });
    });
    const { runtime, catalogue, call } = await setup({ documentConverterUrl: "https://converter.test", fetchImpl: fetchSpy as never });

    const response = await call("/api/v1/publisher/learning-objects/documents/upload", {
      title: "Week 3 slides", source_format: "pptx", filename: "week-3.pptx", content_base64: "Zm9v",
    });
    expect(response.statusCode).toBe(201);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const registered = await catalogue.learningObject(response.json().object_id as string);
    expect(registered?.module_path).toBe("/modules/document-player/index.html");

    vi.unstubAllGlobals();
    await runtime.app.close();
  });

  it("turns a document-converter failure into a clean refusal, not an exception", async () => {
    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    const { runtime, call } = await setup({ documentConverterUrl: "https://converter.test", fetchImpl: failing as never });
    const response = await call("/api/v1/publisher/learning-objects/documents/upload", {
      title: "Week 3 slides", source_format: "pptx", filename: "week-3.pptx", content_base64: "Zm9v",
    });
    expect(response.statusCode).toBe(502);
    vi.unstubAllGlobals();
    await runtime.app.close();
  });
});
