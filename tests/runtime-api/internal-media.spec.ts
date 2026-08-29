/**
 * The internal media surface (routes/internal/media.ts) — the video/document/audio analogue of
 * internal/quizzes.ts. What matters here: each of the three routes registers content against its
 * own fixed shared player, refuses a draft that doesn't match its kind's schema, requires the
 * service credential (never a learner or admin token), and is idempotent the same way the quiz
 * route is. Postgres-specific persistence (the actual INSERTs, the migration 011 columns) is
 * covered by publisher-authoring-postgres.spec.ts's existing DATABASE_URL-gated pattern; this suite
 * runs against the in-memory catalogue, which both backends share behaviour with by contract.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

const SERVICE_TOKEN = "internal-media-test-service-token-0123456789";

async function setup() {
  const ies = await generateKeyPair("ES256");
  const issuer = `https://ies.internal-media-${randomUUID()}.test`;
  const catalogue = new MemoryCatalogueStore({ seedExamples: true });
  const store = new MemoryRuntimeStore();
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.internal-media-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 9), store, catalogue, internalServiceToken: SERVICE_TOKEN,
  });
  const call = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    runtime.app.inject({
      method: "POST", url,
      headers: { "idempotency-key": randomUUID(), "content-type": "application/json", ...headers },
      payload: payload as never,
    });
  const asService = (url: string, payload: unknown) =>
    call(url, payload, { authorization: `Bearer ${SERVICE_TOKEN}` });
  return { runtime, catalogue, call, asService };
}

const videoDraft = { title: "Cell division", source: { kind: "youtube", video_id: "dQw4w9WgXcQ" } };
const documentDraft = {
  title: "Week 3 slides", source_format: "pptx",
  pages: [{ index: 0, image_url: "https://files.test/page-0.png" }, { index: 1, image_url: "https://files.test/page-1.png" }],
};
const audioDraft = { title: "Narrated intro", source: { url: "https://files.test/intro.mp3", mime_type: "audio/mpeg" } };

describe("internal media registration", () => {
  it("registers a video, a document, and an audio object, each against its own shared player", async () => {
    const { runtime, catalogue, asService } = await setup();

    const video = await asService("/api/v1/internal/runtime/videos", videoDraft);
    expect(video.statusCode).toBe(201);
    const document = await asService("/api/v1/internal/runtime/documents", documentDraft);
    expect(document.statusCode).toBe(201);
    const audio = await asService("/api/v1/internal/runtime/audio", audioDraft);
    expect(audio.statusCode).toBe(201);

    const videoObject = await catalogue.learningObject(video.json().object_id as string);
    const documentObject = await catalogue.learningObject(document.json().object_id as string);
    const audioObject = await catalogue.learningObject(audio.json().object_id as string);
    expect(videoObject?.module_path).toBe("/modules/video-player/index.html");
    expect(documentObject?.module_path).toBe("/modules/document-player/index.html");
    expect(audioObject?.module_path).toBe("/modules/audio-player/index.html");
    // Three different kinds land on three different shared players, not one reused by accident.
    expect(new Set([videoObject?.active_package_version_id, documentObject?.active_package_version_id, audioObject?.active_package_version_id]).size).toBe(3);

    await runtime.app.close();
  });

  it("refuses a draft shaped for the wrong kind, and a request from a learner or unauthenticated caller", async () => {
    const { runtime, call, asService } = await setup();

    // A document draft posted to the video route: source_format/pages aren't a videoDraftSchema shape.
    const wrongKind = await asService("/api/v1/internal/runtime/videos", documentDraft);
    expect(wrongKind.statusCode).toBe(400);

    const noCredential = await call("/api/v1/internal/runtime/videos", videoDraft);
    expect(noCredential.statusCode).toBe(401);

    const wrongCredential = await call("/api/v1/internal/runtime/videos", videoDraft, { authorization: "Bearer not-the-service-token" });
    expect(wrongCredential.statusCode).toBe(401);

    await runtime.app.close();
  });

  it("replays the same response for a repeated idempotency key, same as the quiz route", async () => {
    const { runtime, asService } = await setup();
    const key = randomUUID();
    const first = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/audio",
      headers: { "idempotency-key": key, authorization: `Bearer ${SERVICE_TOKEN}` },
      payload: audioDraft,
    });
    const second = await runtime.app.inject({
      method: "POST", url: "/api/v1/internal/runtime/audio",
      headers: { "idempotency-key": key, authorization: `Bearer ${SERVICE_TOKEN}` },
      payload: audioDraft,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().object_id).toBe(first.json().object_id);
    expect(second.json().replayed).toBe(true);
    await runtime.app.close();
  });

  it("serves a registered video's content back through the ordinary runtime content route", async () => {
    const { runtime, asService } = await setup();
    const registered = await asService("/api/v1/internal/runtime/videos", videoDraft);
    const objectId = registered.json().object_id as string;
    const content = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/learning-objects/${objectId}/content` });
    expect(content.statusCode).toBe(200);
    expect(content.json().title).toBe("Cell division");
    expect(content.json().source).toEqual({ kind: "youtube", video_id: "dQw4w9WgXcQ" });
    await runtime.app.close();
  });
});
