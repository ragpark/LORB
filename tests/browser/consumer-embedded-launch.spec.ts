/**
 * The Player Shell embedded the way the Learner Portal embeds it.
 *
 * Every other browser test opens the shell as a top-level page, which is what a smart link does. The
 * Consumer UI does not: it puts the shell in `<iframe sandbox="allow-scripts">`, so the shell itself
 * gets an opaque origin, and the module the shell then loads is nested two deep.
 *
 * That difference was the whole of issue #48's remaining symptom — a quiz played from a smart link
 * and showed nothing through the Consumer — and nothing in the suite covered it.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";

import { addFixturePage, IES_ISSUER, PLAYER_ORIGIN, REPOSITORY_ID, startHarness, type Harness } from "./harness.js";

let harness: Harness;

// Not serial. The suite shares one harness through beforeAll, but the tests do not share state with
// each other — each creates its own object, launch and attempt. Under "serial" the first failure
// skips the rest, which hides the one thing worth knowing when a launch stops working: whether it
// broke for every module or only for the content-driven ones.
test.describe.configure({ mode: "default" });

test.beforeAll(async () => {
  harness = await startHarness();
  // Stands in for the Learner Portal's launch screen: the shell in a sandboxed iframe, nothing else.
  await addFixturePage(
    harness,
    "consumer.html",
    `<!doctype html><html><body>
      <iframe id="shell" title="Learning activity" sandbox="allow-scripts" width="1000" height="800"></iframe>
      <script>
        document.getElementById('shell').src = decodeURIComponent(location.hash.slice(1));
      </script>
    </body></html>`,
  );
});

test.afterAll(async () => harness?.stop());

async function launchQuiz(subject: string) {
  const quiz = await harness.catalogue.registerQuiz({
    title: "Consumer-embedded launch",
    questions: [{ stem: "Did this render?", options: [{ id: "a", text: "Yes" }, { id: "b", text: "No" }], correct_option_id: "a" }],
  } as never);
  const token = await issueIesToken(harness.iesPrivateKey, subject, "lorb-runtime", IES_ISSUER);
  const response = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "learner-portal", repository_id: REPOSITORY_ID,
      object_id: quiz.object_id, requested_launch_mode: "embedded-iframe", locale: "en-GB",
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { playerUrl: body.player_url as string, attemptId: body.attempt_id as string };
}

/** The quiz has rendered when its first question stem is on screen inside the module. */
const questionVisible = (frame: ReturnType<Page["frameLocator"]>) => frame.getByText("Did this render?");

test("a quiz plays when the shell is opened directly, as a smart link opens it", async ({ page }) => {
  const { playerUrl } = await launchQuiz("synthetic-direct-1");
  await page.goto(playerUrl, { waitUntil: "networkidle" });
  await expect(questionVisible(page.frameLocator("#module"))).toBeVisible({ timeout: 10_000 });
});

test("a quiz plays when the shell is embedded in a sandboxed consumer iframe", async ({ page }) => {
  const { playerUrl } = await launchQuiz("synthetic-embedded-1");
  await page.goto(`${PLAYER_ORIGIN}/consumer.html#${encodeURIComponent(playerUrl)}`, { waitUntil: "networkidle" });
  const module = page.frameLocator("#shell").frameLocator("#module");
  await expect(questionVisible(module)).toBeVisible({ timeout: 10_000 });
});

test("the module can address the shell when nested two deep", async ({ page }) => {
  // The direct cause, isolated. The module resolves the shell's origin from document.referrer, and a
  // document with an opaque origin sends none — so the handshake is abandoned before it is attempted.
  const { playerUrl } = await launchQuiz("synthetic-embedded-2");
  await page.goto(`${PLAYER_ORIGIN}/consumer.html#${encodeURIComponent(playerUrl)}`, { waitUntil: "networkidle" });
  // The shell still sends no referrer — that is a browser rule, not something to fix. What matters
  // is that the module no longer abandons the handshake when it is missing.
  const referrer = await page.frameLocator("#shell").frameLocator("#module").locator("body").evaluate(() => document.referrer);
  expect(referrer, "a sandboxed shell has an opaque origin and sends no referrer").toBe("");
  await expect(questionVisible(page.frameLocator("#shell").frameLocator("#module"))).toBeVisible({ timeout: 10_000 });
});

test("evidence survives the sandboxed consumer embedding", async ({ page }) => {
  // The shell's own fetches carry an opaque origin in this topology, evidence included. While the
  // Evidence API refused "null" the launch still rendered, still played and still completed — and
  // every statement was blocked by the browser before it left the page. Nothing on screen said so,
  // which is why this asserts on the outbox rather than on the module.
  const { playerUrl, attemptId } = await launchQuiz("synthetic-embedded-3");
  await page.goto(`${PLAYER_ORIGIN}/consumer.html#${encodeURIComponent(playerUrl)}`, { waitUntil: "networkidle" });
  await expect(questionVisible(page.frameLocator("#shell").frameLocator("#module"))).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(async () => (await harness.store.listOutbox({})).filter((row) => row.attempt_id === attemptId).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
});
