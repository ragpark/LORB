/**
 * The ebook kind: an EPUB 3 file read by the shared ebook reader, registered the same way video,
 * document and audio are (one JSON payload against one fixed player). What matters here: both
 * registration surfaces accept an ebook draft and bind it to the ebook player; `epub_url` admits
 * exactly an https URL or a /modules/… path on the Player Shell origin, nothing else; the preview
 * route returns the book's location and metadata rather than the book; and the bundled exemplar is
 * (a) seeded into the default repository with real content and a content-versioned object version,
 * and (b) packaged as a valid EPUB 3 archive whose spine, nav and manifest agree with each other.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { EXAMPLE_EBOOK, EXAMPLE_EBOOK_EPUB_PATH, MEDIA_PLAYERS } from "../../packages/runtime-api/src/catalogue/shared.js";
import { ebookDraftSchema } from "../../packages/contracts/src/index.js";
import { buildExemplar, entriesOf, EXEMPLAR_FILE_NAME } from "../../packages/ebook-player/scripts/build-exemplar.mjs";

const SERVICE_TOKEN = "ebook-test-service-token-0123456789";
const catalogues = new WeakMap<object, MemoryCatalogueStore>();
const catalogueOf = (runtime: object) => catalogues.get(runtime)!;

async function setup() {
  const ies = await generateKeyPair("ES256");
  const issuer = `https://ies.ebook-${randomUUID()}.test`;
  const catalogue = new MemoryCatalogueStore({ seedExamples: true });
  const store = new MemoryRuntimeStore();
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.ebook-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 12), store, catalogue, internalServiceToken: SERVICE_TOKEN,
  });
  const adminToken = await issueIesToken(ies.privateKey, "ebook-admin", "lorb-runtime", issuer, { role: "admin" });
  const learnerToken = await issueIesToken(ies.privateKey, "ebook-learner", "lorb-runtime", issuer, {});
  const repository = (await catalogue.defaultRepository())!;
  catalogues.set(runtime, catalogue);
  const post = (url: string, payload: unknown, token = adminToken) =>
    runtime.app.inject({
      method: "POST", url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      payload: payload as never,
    });
  return { runtime, catalogue, post, adminToken, learnerToken, repositoryId: repository.repository_id };
}

const ebookDraft = {
  title: "Rivers and flooding",
  epub_url: "https://books.test/rivers.epub",
  author: "Geography team",
  reading_minutes: 20,
};

describe("ebook registration", () => {
  it("registers an ebook through the publisher route against the shared ebook reader", async () => {
    const { runtime, catalogue, post, repositoryId } = await setup();
    const response = await post("/api/v1/publisher/learning-objects/ebooks", { repository_id: repositoryId, ...ebookDraft });
    expect(response.statusCode).toBe(201);
    const object = await catalogue.learningObject(response.json().object_id as string);
    expect(object?.module_path).toBe("/modules/ebook-player/index.html");
    expect(object?.kind).toBe("ebook-json");
    expect(object?.content_profile).toBe("ebook-json-v1");
    expect(object?.duration).toBe("20 minutes");
    const content = await catalogue.content(object!.object_id);
    expect(content).toMatchObject({ epub_url: ebookDraft.epub_url, author: "Geography team", content_version: "1" });
    await runtime.app.close();
  });

  it("registers an ebook through the internal service route", async () => {
    const { runtime, catalogue, post } = await setup();
    const response = await post("/api/v1/internal/runtime/ebooks", { title: "Agent reader", epub_url: "/modules/ebook-player/exemplar/photosynthesis-reader.epub" }, SERVICE_TOKEN);
    expect(response.statusCode).toBe(201);
    const object = await catalogue.learningObject(response.json().object_id as string);
    expect(object?.content_profile).toBe("ebook-json-v1");
    expect(object?.authored_by).toBe("mcp-connector");
    expect(object?.duration).toBe("Self-paced");
    await runtime.app.close();
  });

  it("refuses a non-admin caller on the publisher route", async () => {
    const { runtime, post, learnerToken, repositoryId } = await setup();
    const response = await post("/api/v1/publisher/learning-objects/ebooks", { repository_id: repositoryId, ...ebookDraft }, learnerToken);
    expect(response.statusCode).toBe(403);
    await runtime.app.close();
  });

  it("admits only an https URL or a /modules/… .epub path as the book's location", async () => {
    const accepted = ["https://books.test/a.epub", "https://books.test/download?id=9", "/modules/ebook-player/exemplar/photosynthesis-reader.epub", "/modules/partner/books/ch.1-2.epub"];
    const refused = ["http://books.test/a.epub", "ftp://books.test/a.epub", "/modules/ebook-player/index.html", "/other/book.epub", "modules/x.epub", "javascript:alert(1)", "https://", ""];
    for (const epub_url of accepted) expect(ebookDraftSchema.safeParse({ title: "t", epub_url }).success, epub_url).toBe(true);
    for (const epub_url of refused) expect(ebookDraftSchema.safeParse({ title: "t", epub_url }).success, epub_url).toBe(false);

    const { runtime, post, repositoryId } = await setup();
    const response = await post("/api/v1/publisher/learning-objects/ebooks", { repository_id: repositoryId, title: "Plain http", epub_url: "http://books.test/a.epub" });
    expect(response.statusCode).toBe(400);
    await runtime.app.close();
  });

  it("refuses to publish a code package version over an ebook — or any other data-authored object", async () => {
    const { runtime, post, repositoryId } = await setup();
    const video = await post("/api/v1/publisher/learning-objects/videos", { repository_id: repositoryId, title: "Cell division", source: { kind: "youtube", video_id: "dQw4w9WgXcQ" } });
    expect(video.statusCode).toBe(201);
    for (const objectId of [EXAMPLE_EBOOK.object.object_id, video.json().object_id as string]) {
      const rejected = await post(`/api/v1/publisher/learning-objects/${objectId}/versions`, {
        semver: "2.0.0", module_path: "/modules/something-else/index.html", sha256: "a".repeat(64),
      });
      expect(rejected.statusCode, objectId).toBe(409);
      expect(rejected.json().code).toBe("LEARNING_OBJECT_CONTENT_UNSUPPORTED");
    }
    // The reader binding is untouched.
    expect((await catalogueOf(runtime).learningObject(EXAMPLE_EBOOK.object.object_id))?.module_path).toBe(MEDIA_PLAYERS.ebook.module_path);
    await runtime.app.close();
  });

  it("previews an ebook as its location and metadata, never the book", async () => {
    const { runtime, adminToken } = await setup();
    const response = await runtime.app.inject({
      method: "GET", url: `/api/v1/admin/learning-objects/${EXAMPLE_EBOOK.object.object_id}/preview`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: "ebook", epub_url: EXAMPLE_EBOOK_EPUB_PATH, author: "LORB exemplar content", language: "en-GB", reading_minutes: 12 });
    await runtime.app.close();
  });
});

describe("the exemplar ebook", () => {
  it("is seeded into the default repository with content and a content-versioned object version", async () => {
    const catalogue = new MemoryCatalogueStore({ seedExamples: true });
    const object = await catalogue.learningObject(EXAMPLE_EBOOK.object.object_id);
    expect(object).toMatchObject({
      repository_id: (await catalogue.defaultRepository())!.repository_id,
      status: "PUBLISHED",
      kind: "ebook-json",
      content_profile: "ebook-json-v1",
      module_path: MEDIA_PLAYERS.ebook.module_path,
      active_package_version_id: MEDIA_PLAYERS.ebook.package_version_id,
    });
    expect(await catalogue.packageVersion(MEDIA_PLAYERS.ebook.package_version_id)).toMatchObject({ shared_player: true });
    const version = await catalogue.objectVersion(object!.active_object_version_id);
    expect(version).toMatchObject({ status: "PUBLISHED", content_version: "1", package_version_id: MEDIA_PLAYERS.ebook.package_version_id });
    expect(await catalogue.contentForObjectVersion(object!.object_id, version!.object_version_id)).toMatchObject({ epub_url: EXAMPLE_EBOOK_EPUB_PATH });
    expect((await catalogue.learningObjects({ repository_id: object!.repository_id })).map((row) => row.object_id)).toContain(object!.object_id);
    // Not seeded where examples are off — same gate as the other bundled examples.
    expect(await new MemoryCatalogueStore({ seedExamples: false }).learningObject(EXAMPLE_EBOOK.object.object_id)).toBeUndefined();
  });

  it("packages as a valid EPUB 3 archive whose spine, nav and manifest agree", () => {
    const bytes = buildExemplar();
    // Local file header at offset 0: compression method at bytes 8–9 (0 = stored), file name at 30.
    expect(bytes[0]).toBe(0x50); expect(bytes[1]).toBe(0x4b);
    expect(bytes[8]! | (bytes[9]! << 8)).toBe(0);
    const nameLength = bytes[26]! | (bytes[27]! << 8);
    expect(Buffer.from(bytes.subarray(30, 30 + nameLength)).toString("utf8")).toBe("mimetype");

    const entries = entriesOf(bytes);
    expect(entries["mimetype"]).toBe("application/epub+zip");
    const rootfile = /full-path="([^"]+)"/.exec(entries["META-INF/container.xml"] ?? "")?.[1];
    expect(rootfile).toBe("OEBPS/package.opf");
    const opf = entries[rootfile!]!;
    expect(opf).toContain('version="3.0"');
    expect(opf).toContain("<dc:title>Photosynthesis: how plants make food</dc:title>");

    const manifest = Array.from(opf.matchAll(/<item\s+id="([^"]+)"\s+href="([^"]+)"\s+media-type="([^"]+)"(?:\s+properties="([^"]+)")?/g))
      .map((m) => ({ id: m[1]!, href: `OEBPS/${m[2]!}`, mediaType: m[3]!, properties: m[4] ?? "" }));
    for (const item of manifest) expect(entries[item.href], item.href).toBeDefined();
    const nav = manifest.find((item) => item.properties.split(/\s+/).includes("nav"));
    expect(nav?.mediaType).toBe("application/xhtml+xml");

    const spine = Array.from(opf.matchAll(/<itemref\s+idref="([^"]+)"/g)).map((m) => m[1]!);
    expect(spine).toHaveLength(3);
    const spineHrefs = spine.map((id) => manifest.find((item) => item.id === id)!.href);
    for (const href of spineHrefs) {
      const page = entries[href]!;
      expect(page).toContain('xmlns:epub="http://www.idpf.org/2007/ops"');
      expect(page).toContain("epub:type=");
      expect(page).toContain("<link rel=\"stylesheet\"");
    }
    // Every table-of-contents entry points at a spine item, in spine order.
    const tocHrefs = Array.from(entries[nav!.href]!.matchAll(/<li><a href="([^"]+)">/g)).map((m) => `OEBPS/${m[1]!}`);
    expect(tocHrefs).toEqual(spineHrefs);
    // EDUPUB semantics are present: objectives on the way in, an assessment at the end.
    expect(entries[spineHrefs[0]!]).toContain('epub:type="learning-objectives"');
    expect(entries[spineHrefs[2]!]).toContain('epub:type="chapter assessment"');
    expect(entries[spineHrefs[2]!]).toContain('epub:type="answer"');
    // The catalogue seed addresses exactly the file this build produces.
    expect(EXAMPLE_EBOOK_EPUB_PATH.endsWith(`/${EXEMPLAR_FILE_NAME}`)).toBe(true);
    expect(EXAMPLE_EBOOK.content.epub_url).toBe(EXAMPLE_EBOOK_EPUB_PATH);
  });
});
