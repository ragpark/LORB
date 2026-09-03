/**
 * The ebook reader end to end in a real browser, against the bundled exemplar: the built reader and
 * its packaged EPUB are servable from /modules/ebook-player/ (Dockerfile.player-shell and the harness
 * both copy packages/ebook-player/dist there), the reader unpacks the book inside the sandboxed
 * module iframe, renders the spine with its EDUPUB semantics and in-archive image, and speaks the
 * ordinary shell protocol — handshake, content fetch, evidence.emit per quartile, completion on the
 * last page.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures.js";
import { IES_ISSUER, REPOSITORY_ID, startHarness, type Harness } from "./harness.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { EXAMPLE_EBOOK } from "../../packages/runtime-api/src/catalogue/shared.js";
import { packEpub } from "../../packages/ebook-player/scripts/build-exemplar.mjs";

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => harness?.stop());

async function launch(objectId: string) {
  const learnerToken = await issueIesToken(harness.iesPrivateKey, `ebook-learner-${randomUUID()}`, "lorb-runtime", IES_ISSUER);
  const launched = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "browser-suite", repository_id: REPOSITORY_ID,
      object_id: objectId, requested_launch_mode: "embedded-iframe", locale: "en-GB",
    },
  });
  expect(launched.statusCode).toBe(201);
  return { attemptId: launched.json().attempt_id as string, playerUrl: launched.json().player_url as string };
}

test("the exemplar EPUB opens, pages through its three spine items, and completes on the last", async ({ page }) => {
  const { attemptId, playerUrl } = await launch(EXAMPLE_EBOOK.object.object_id);

  await page.goto(playerUrl, { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");
  await expect(module.locator("h1").first()).toHaveText("Photosynthesis: how plants make food", { timeout: 15000 });
  await expect(module.getByText("Page 1 of 3")).toBeVisible();
  const pane = module.locator(".epub-body");
  await expect(pane.locator("h1")).toHaveText("1. What is photosynthesis?");
  // EDUPUB learning objectives survived sanitisation and are rendered.
  await expect(pane.locator('[epub\\:type~="learning-objective"]')).toHaveCount(3);

  // Table of contents drives navigation.
  await module.getByRole("button", { name: "Contents" }).click();
  await module.getByRole("button", { name: "2. Inside the leaf" }).click();
  await expect(module.getByText("Page 2 of 3")).toBeVisible();
  // The in-archive SVG figure is served to the DOM as a blob URL and actually loads.
  const figure = pane.locator("figure img");
  await expect(figure).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => figure.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  await module.getByRole("button", { name: "Next" }).first().click();
  await expect(module.getByText("Page 3 of 3")).toBeVisible();
  await expect(pane.locator('[epub\\:type~="question"]')).toHaveCount(4);
  // A revealable answer is a <details>, which needs no script — and no script ran to render it.
  await pane.locator("details summary").first().click();
  await expect(pane.locator("details").first()).toHaveAttribute("open", "");

  await expect.poll(async () => (await harness.store.getAttempt(attemptId))?.status, { timeout: 15000 }).toBe("COMPLETED");
  const verbs = (await harness.store.listOutbox({}))
    .map((row) => row.payload as { object?: { id?: string }; verb?: { display?: Record<string, string> }; result?: { response?: string } })
    .filter((statement) => String(statement?.object?.id ?? "").includes(EXAMPLE_EBOOK.object.object_id))
    .map((statement) => `${statement.verb?.display?.["en-GB"]}${statement.result?.response ? `:${statement.result.response}` : ""}`);
  expect(verbs).toEqual(["launched", "answered:p25", "answered:p50", "answered:p75", "completed"]);
});

test("a book's script never runs: an EPUB carrying one renders its text with the script stripped", async ({ page }) => {
  // Registered by the internal route against a scripted EPUB the test places on the player origin.
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const epub = packEpub({
    "META-INF/container.xml": '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "book.opf": '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="u">urn:x</dc:identifier><dc:title>Scripted</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="p" href="p.xhtml" media-type="application/xhtml+xml" properties="scripted"/></manifest><spine><itemref idref="p"/></spine></package>',
    "p.xhtml": '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>p</title><script>document.title="pwned";window.__epubRan=true;</script></head><body><h1 onclick="window.__epubRan=true">Only text</h1><p>Body copy.</p><script>window.__epubRan=true;</script><iframe src="https://example.invalid/"></iframe><a href="https://example.invalid/away">an external link</a></body></html>',
  });
  await mkdir(join(harness.playerRoot, "modules/ebook-player/fixtures"), { recursive: true });
  await writeFile(join(harness.playerRoot, "modules/ebook-player/fixtures/scripted.epub"), epub);

  const registered = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/internal/runtime/ebooks",
    headers: { authorization: "Bearer browser-suite-internal-service-token-0001", "idempotency-key": randomUUID() },
    payload: { title: "Scripted book", epub_url: "/modules/ebook-player/fixtures/scripted.epub" } as never,
  });
  expect(registered.statusCode).toBe(201);
  const { attemptId, playerUrl } = await launch(registered.json().object_id as string);

  await page.goto(playerUrl, { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");
  const pane = module.locator(".epub-body");
  await expect(pane.locator("h1")).toHaveText("Only text", { timeout: 15000 });
  await pane.locator("h1").click();
  expect(await pane.locator("script, iframe").count()).toBe(0);
  expect(await module.locator("body").evaluate(() => (window as unknown as { __epubRan?: boolean }).__epubRan ?? false)).toBe(false);
  // The external link is text with its destination shown, never a navigable href.
  const external = pane.locator("a[data-epub-external]");
  await expect(external).toHaveText("an external link");
  expect(await external.getAttribute("href")).toBeNull();
  // A one-page book completes on display.
  await expect.poll(async () => (await harness.store.getAttempt(attemptId))?.status, { timeout: 15000 }).toBe("COMPLETED");
});
