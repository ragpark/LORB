/**
 * The three generic media players (video, document, audio), end to end in a real browser.
 *
 * What this pins, beyond the contract/registration coverage in internal-media.spec.ts: the built
 * players are actually servable — Dockerfile.player-shell and the browser-test harness both have to
 * build and copy packages/{video,document,audio}-player/dist to /modules/<kind>-player/, the same
 * packaging step coach-player needed (tests/browser/coach-launch.spec.ts) — and that each one speaks
 * the ordinary shell protocol: handshake, content fetch, evidence.emit, experience.complete.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures.js";
import { INTERNAL_SERVICE_TOKEN, IES_ISSUER, REPOSITORY_ID, startHarness, type Harness } from "./harness.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => harness?.stop());

async function registerMedia(kind: "videos" | "documents" | "audio", draft: unknown) {
  const response = await harness.runtime.app.inject({
    method: "POST", url: `/api/v1/internal/runtime/${kind}`,
    headers: { authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
    payload: draft as never,
  });
  expect(response.statusCode).toBe(201);
  return response.json().object_id as string;
}

async function launch(objectId: string) {
  const learnerToken = await issueIesToken(harness.iesPrivateKey, `media-learner-${randomUUID()}`, "lorb-runtime", IES_ISSUER);
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

test("a video object loads, and Mark as watched completes the attempt", async ({ page }) => {
  const objectId = await registerMedia("videos", {
    title: "Cell division", description: "A short overview.",
    source: { kind: "file", url: "https://example.invalid/cell-division.mp4", mime_type: "video/mp4" },
  });
  const { attemptId, playerUrl } = await launch(objectId);

  await page.goto(playerUrl, { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");
  await expect(module.locator("h1")).toHaveText("Cell division", { timeout: 15000 });
  await module.getByRole("button", { name: "Mark as watched" }).click();

  await expect.poll(async () => (await harness.store.getAttempt(attemptId))?.status, { timeout: 15000 }).toBe("COMPLETED");
  const verbs = (await harness.store.listOutbox({}))
    .map((row) => row.payload as { object?: { id?: string }; verb?: { display?: Record<string, string> } })
    .filter((statement) => String(statement?.object?.id ?? "").includes(objectId))
    .map((statement) => statement.verb?.display?.["en-GB"]);
  expect(verbs).toEqual(["launched", "completed"]);
});

test("a document object pages forward, completing on the last page", async ({ page }) => {
  const objectId = await registerMedia("documents", {
    title: "Week 3 slides", source_format: "pptx",
    pages: [
      { index: 0, image_url: "https://example.invalid/page-0.png" },
      { index: 1, image_url: "https://example.invalid/page-1.png" },
    ],
  });
  const { attemptId, playerUrl } = await launch(objectId);

  await page.goto(playerUrl, { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");
  await expect(module.locator("h1")).toHaveText("Week 3 slides", { timeout: 15000 });
  await expect(module.getByText("Page 1 of 2")).toBeVisible();
  await module.getByRole("button", { name: "Next" }).click();
  await expect(module.getByText("Page 2 of 2")).toBeVisible();

  // Reaching the last page completes automatically — no separate "finish" action for a document.
  await expect.poll(async () => (await harness.store.getAttempt(attemptId))?.status, { timeout: 15000 }).toBe("COMPLETED");
});

test("a one-page document completes on display — its only page is already its last", async ({ page }) => {
  // A single-page document's Next and Previous are both disabled from the start, so nothing ever
  // calls goTo — completion has to fire from reaching the last page on load, not only from paging.
  const objectId = await registerMedia("documents", {
    title: "One-page handout", source_format: "docx",
    pages: [{ index: 0, image_url: "https://example.invalid/page-0.png" }],
  });
  const { attemptId, playerUrl } = await launch(objectId);

  await page.goto(playerUrl, { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");
  await expect(module.getByText("Page 1 of 1")).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await harness.store.getAttempt(attemptId))?.status, { timeout: 15000 }).toBe("COMPLETED");
});

test("an audio object loads, and Mark as listened completes the attempt", async ({ page }) => {
  const objectId = await registerMedia("audio", {
    title: "Narrated intro",
    source: { url: "https://example.invalid/intro.mp3", mime_type: "audio/mpeg" },
  });
  const { attemptId, playerUrl } = await launch(objectId);

  await page.goto(playerUrl, { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");
  await expect(module.locator("h1")).toHaveText("Narrated intro", { timeout: 15000 });
  await module.getByRole("button", { name: "Mark as listened" }).click();

  await expect.poll(async () => (await harness.store.getAttempt(attemptId))?.status, { timeout: 15000 }).toBe("COMPLETED");
});
