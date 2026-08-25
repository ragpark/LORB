/**
 * Browser coverage for the Player Shell to module channel.
 *
 * This is the hop nothing else tests. The MCP smoke test builds xAPI statements and posts them to the
 * Evidence API directly, so it stayed green while the channel was completely broken for every module
 * in the repository (fixed in #44). Only a real browser exercises the sandbox semantics that broke it:
 * a module without `allow-same-origin` has an opaque origin, so a postMessage aimed at the package
 * origin is dropped and a message it sends arrives with the origin string "null".
 *
 * Requires the player bundles to be built; the harness says so explicitly if they are not.
 */
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";

import {
  addFixturePage,
  IES_ISSUER,
  INTERNAL_SERVICE_TOKEN,
  REPOSITORY_ID,
  RUNTIME_ORIGIN,
  startHarness,
  type Harness,
} from "./harness.js";

const EXAMPLE_MODULE_OBJECT = "c8a2d3e4-7f4b-4a2c-8b6e-2f3a4b5c6d7e";

let harness: Harness;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  harness = await startHarness();
  await addFixturePage(
    harness,
    "impersonator.html",
    // Stands in for a document that replaced the module in its own iframe: same WindowProxy, same
    // opaque origin, and frame.src still reads the pinned package URL. It has no launch nonce.
    `<!doctype html><html><body><script>
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) { parent.postMessage({ stolen: event.data }, '*'); };
      channel.port1.start();
      parent.postMessage({
        protocol: 'lorb-player', version: '1.0', type: 'module.hello',
        message_id: crypto.randomUUID(), correlation_id: crypto.randomUUID(), reply_to: null,
        sent_at: new Date().toISOString(), payload: {}
      }, document.referrer ? new URL(document.referrer).origin : '*', [channel.port2]);
    </script></body></html>`,
  );
});

test.afterAll(async () => harness?.stop());

/** Mints a launch the same way a consumer would: an IES-authenticated POST to /launches. */
async function launch(objectId: string, subject: string) {
  const token = await issueIesToken(harness.iesPrivateKey, subject, "lorb-runtime", IES_ISSUER);
  const response = await harness.runtime.app.inject({
    method: "POST",
    url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "browser-suite", repository_id: REPOSITORY_ID,
      object_id: objectId, requested_launch_mode: "embedded-iframe", locale: "en-GB",
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { playerUrl: body.player_url as string, attemptId: body.attempt_id as string, descriptor: decodeJwt(body.signed_descriptor) };
}

const attemptStatus = async (attemptId: string) => (await harness.store.getAttempt(attemptId))?.status;

const statementsFor = async (objectId: string) =>
  (await harness.store.listOutbox({}))
    .map((row) => row.payload as any)
    .filter((statement) => String(statement?.object?.id ?? "").includes(objectId));

async function openLaunch(page: Page, playerUrl: string) {
  await page.goto(playerUrl, { waitUntil: "networkidle" });
  return page.frameLocator("#module");
}

test("a quiz launch drives the full xAPI verb chain through the shell", async ({ page }) => {
  // Register an agent-authored quiz and assign it, through the internal surface the MCP connector uses.
  const created = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/internal/runtime/quizzes",
    headers: { authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
    payload: {
      title: "Browser suite quiz", subject: "Mathematics", year_group: "Year 9",
      questions: [
        { stem: "Increase 80 by 25%.", options: [{ id: "a", text: "One hundred" }, { id: "b", text: "One hundred and five" }], correct_option_id: "a" },
        { stem: "Simplify 12:18.", options: [{ id: "a", text: "Two to three" }, { id: "b", text: "Three to two" }], correct_option_id: "a" },
      ],
    },
  });
  expect(created.statusCode).toBe(201);
  const objectId = created.json().object_id as string;

  const assigned = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/internal/runtime/launch-batch",
    headers: { authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
    payload: { object_id: objectId, learners: [{ learner_id: "synthetic-browser-01" }, { learner_id: "synthetic-browser-02" }] },
  });
  expect(assigned.statusCode).toBe(201);

  const { playerUrl, attemptId } = await launch(objectId, "synthetic-browser-01");
  expect(await attemptStatus(attemptId)).toBe("CREATED");

  const module = await openLaunch(page, playerUrl);
  // Reaching the questions at all proves the whole handshake: module.hello with the launch nonce,
  // shell.context back down the port, and the content fetch from the sandboxed opaque origin.
  await expect(module.getByText("Browser suite quiz")).toBeVisible();
  await module.locator('input[name="question-0"][value="a"]').check();
  await module.getByRole("button", { name: /Next/ }).click();
  await module.locator('input[name="question-1"][value="b"]').check();
  await module.getByRole("button", { name: /Review/ }).click();
  await module.getByRole("button", { name: "Submit quiz" }).click();
  await expect(module.getByText("You scored 1 out of 2.")).toBeVisible();

  await expect.poll(async () => attemptStatus(attemptId), { timeout: 10000 }).toBe("COMPLETED");

  const statements = await statementsFor(objectId);
  expect(statements.map((s) => s.verb.display["en-GB"])).toEqual(["launched", "answered", "answered", "completed"]);
  expect(statements.filter((s) => s.verb.display["en-GB"] === "answered").map((s) => s.result)).toEqual([
    { response: "a", success: true },
    { response: "b", success: false },
  ]);
  expect(statements.at(-1)!.result).toEqual({ completion: true, success: false, score: { scaled: 0.5 } });
  // The actor is the pseudonym, never a platform learner identifier.
  for (const statement of statements) {
    expect(statement.actor.account.name).toMatch(/^[\da-f]{64}$/);
    expect(JSON.stringify(statement)).not.toContain("synthetic-browser-01");
  }

  const results = (await harness.runtime.app.inject({ method: "GET", url: `/api/v1/evidence/activity-results?object_id=${objectId}` })).json();
  expect(results).toMatchObject({ assigned_count: 2, completed_count: 1, average_score_scaled: 0.5 });
  expect(results.not_started_pseudonyms).toHaveLength(1);
});

test("a plain native-web-package module completes through the same channel", async ({ page }) => {
  const { playerUrl, attemptId } = await launch(EXAMPLE_MODULE_OBJECT, "synthetic-browser-03");
  const module = await openLaunch(page, playerUrl);
  await module.locator("#complete").click();
  // example-module has no build step and no framework: it exercises the handshake from a script that
  // runs during parsing, which is the case that first broke the shell's navigation detection.
  await expect.poll(async () => attemptStatus(attemptId), { timeout: 10000 }).toBe("COMPLETED");
});

test("a document that replaces the module in its own iframe cannot take over the session", async ({ page }) => {
  const { playerUrl, attemptId } = await launch(EXAMPLE_MODULE_OBJECT, "synthetic-browser-04");
  await page.goto(playerUrl, { waitUntil: "networkidle" });

  const stolen: string[] = [];
  await page.exposeFunction("__stolen", (payload: string) => void stolen.push(payload));
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      const data = event.data as { stolen?: unknown } | null;
      if (data && data.stolen) (window as unknown as { __stolen(p: string): void }).__stolen(JSON.stringify(data.stolen));
    });
  });

  // The module navigates its own browsing context away from the packaged document.
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>("#module")!.contentWindow!.location.replace("/impersonator.html");
  });
  await expect(page.locator("#status")).toHaveText(/closed/i, { timeout: 10000 });

  // frame.src is unchanged by a navigation the module initiates, which is exactly why it cannot be
  // used to identify the loaded document — the regression this test exists to guard.
  expect(await page.locator("#module").getAttribute("src")).toContain("/module/index.html");
  expect(stolen).toHaveLength(0);
  expect(await attemptStatus(attemptId)).toBe("CREATED");
});

test("a document with no launch nonce cannot open a channel, even before one exists", async ({ page }) => {
  // The previous test proves the navigation teardown fires. It cannot prove the *nonce* does its job,
  // because teardown happens first and masks it. Here the real module never handshakes — its bundle is
  // blocked — so no session is ever established, no teardown can fire, and the launch nonce is the only
  // thing standing between an impersonating document and the launch context. This is the regression
  // guard for the P1 review finding on #44.
  const created = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/internal/runtime/quizzes",
    headers: { authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`, "idempotency-key": randomUUID() },
    payload: { title: "Nonce isolation quiz", questions: [{ stem: "One?", options: [{ id: "a", text: "Yes" }, { id: "b", text: "No" }], correct_option_id: "a" }] },
  });
  const objectId = created.json().object_id as string;
  const { playerUrl, attemptId } = await launch(objectId, "synthetic-browser-05");

  await page.route("**/modules/quiz-player/assets/*.js", (route) => route.abort());
  const stolen: string[] = [];
  await page.exposeFunction("__stolen", (payload: string) => void stolen.push(payload));
  await page.goto(playerUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      const data = event.data as { stolen?: unknown } | null;
      if (data && data.stolen) (window as unknown as { __stolen(p: string): void }).__stolen(JSON.stringify(data.stolen));
    });
  });

  // No port was ever established, so nothing tears the session down: the handshake is evaluated on its
  // merits, and the impersonator has no fragment to read a nonce from.
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>("#module")!.contentWindow!.location.replace("/impersonator.html");
  });
  await page.waitForTimeout(2000);

  expect(stolen).toHaveLength(0);
  expect(await attemptStatus(attemptId)).toBe("CREATED");
  expect(await statementsFor(objectId)).toHaveLength(0);
});
