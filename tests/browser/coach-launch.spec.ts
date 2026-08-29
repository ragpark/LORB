/**
 * The AI coach, end to end in a real browser: a code-bearing learning object whose launch context
 * names a relay endpoint, presented by the coach player, chatting through the shell's relay proxy
 * against the built-in demo provider — with the same evidence chain every other launch produces.
 *
 * What this pins: the module gets its settings from the version-pinned content route without a
 * bearer token; the conversation goes module → port → shell → relay, so the descriptor never enters
 * the module; and finishing the session completes the attempt through the same legal transition as
 * a quiz.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import {
  IES_ISSUER, REPOSITORY_ID, startHarness, type Harness,
} from "./harness.js";

let harness: Harness;

test.beforeAll(async () => {
  process.env.ADMIN_ALLOWED_ROLES = "admin";
  harness = await startHarness();
});
test.afterAll(async () => harness?.stop());

test("a coaching launch chats through the relay and completes like any other attempt", async ({ page }) => {
  const adminToken = await issueIesToken(harness.iesPrivateKey, "coach-admin", "lorb-runtime", IES_ISSUER, { role: "admin" });
  const moduleSha = createHash("sha256")
    .update(readFileSync(resolve(import.meta.dirname, "../../packages/coach-player/src/index.html")))
    .digest("hex");

  // Register the coaching object: code-bearing, presented by the coach player module.
  const created = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/publisher/learning-objects",
    headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    payload: {
      repository_id: REPOSITORY_ID,
      title: "Fractions coaching session",
      description: "A conversational AI coach for equivalent fractions.",
      duration: "10 minutes",
      kind: "ai-coach",
      module_path: "/modules/coach-player/index.html",
      semver: "1.0.0",
      sha256: moduleSha,
    },
  });
  expect(created.statusCode).toBe(201);
  const objectId = created.json().object_id as string;

  // The launch context names the endpoint and the topic — names, not URLs.
  const contextSet = await harness.runtime.app.inject({
    method: "PUT", url: `/api/v1/publisher/learning-objects/${objectId}/launch-context`,
    headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    payload: { launch_context: { settings: { llm_endpoint: "demo", topic: "equivalent fractions", title: "Fractions coach" } } },
  });
  expect(contextSet.statusCode).toBe(200);

  const learnerToken = await issueIesToken(harness.iesPrivateKey, "synthetic-coach-learner", "lorb-runtime", IES_ISSUER);
  const launch = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "browser-suite", repository_id: REPOSITORY_ID,
      object_id: objectId, requested_launch_mode: "embedded-iframe", locale: "en-GB",
    },
  });
  expect(launch.statusCode).toBe(201);
  const attemptId = launch.json().attempt_id as string;
  expect(decodeJwt(launch.json().signed_descriptor).object_id).toBe(objectId);

  await page.goto(launch.json().player_url as string, { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");

  // The coach greets first — via the relay's demo endpoint, which labels itself and echoes the
  // topic from the launch context, proving the settings arrived through the content route.
  const greeting = module.locator(".bubble.coach").first();
  await expect(greeting).toContainText("demo coach", { timeout: 15000 });
  await expect(greeting).toContainText("equivalent fractions");
  await expect(module.locator("#title")).toHaveText("Fractions coach");

  // A learner turn round-trips through shell → relay → shell → module.
  await module.locator("#input").fill("I think 2/4 and 1/2 are the same because you can halve both numbers.");
  await module.locator("#send").click();
  await expect(module.locator(".bubble.learner")).toContainText("2/4 and 1/2");
  await expect(module.locator(".bubble.coach").nth(1)).toContainText("halve both numbers", { timeout: 15000 });

  // Finishing completes the attempt through the same CREATED → STARTED → COMPLETED chain as a quiz.
  await module.locator("#finish").click();
  await expect.poll(async () => (await harness.store.getAttempt(attemptId))?.status, { timeout: 15000 }).toBe("COMPLETED");

  // And the evidence trail is the standard one: launched, one answered per turn, completed.
  const verbs = (await harness.store.listOutbox({}))
    .map((row) => row.payload as { object?: { id?: string }; verb?: { display?: Record<string, string> } })
    .filter((statement) => String(statement?.object?.id ?? "").includes(objectId))
    .map((statement) => statement.verb?.display?.["en-GB"]);
  expect(verbs).toContain("launched");
  expect(verbs).toContain("answered");
  expect(verbs).toContain("completed");
});
