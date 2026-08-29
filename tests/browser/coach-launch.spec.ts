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

/**
 * The multi-course pattern: a second course gets its own coaching object — same module file, same
 * player, its own launch context. What this pins is that the context travels with the object, not
 * the player: two objects registered against the identical module sha present different titles,
 * open on different topics, and would name different provider endpoints, with no policy involved.
 */
test("a second course reuses the coach module with its own launch context", async ({ page }) => {
  const adminToken = await issueIesToken(harness.iesPrivateKey, "coach-admin", "lorb-runtime", IES_ISSUER, { role: "admin" });
  const moduleSha = createHash("sha256")
    .update(readFileSync(resolve(import.meta.dirname, "../../packages/coach-player/src/index.html")))
    .digest("hex");
  // The second course exists first — in production this is the admin repositories surface.
  const scienceRepository = randomUUID();
  await harness.catalogue.addRepository({ repository_id: scienceRepository, slug: "science", display_name: "Science" });

  const register = async (repositoryId: string, title: string, settings: Record<string, string>) => {
    const created = await harness.runtime.app.inject({
      method: "POST", url: "/api/v1/publisher/learning-objects",
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
      payload: {
        repository_id: repositoryId, title, duration: "10 minutes", kind: "ai-coach",
        module_path: "/modules/coach-player/index.html", semver: "1.0.0", sha256: moduleSha,
      },
    });
    expect(created.statusCode).toBe(201);
    const objectId = created.json().object_id as string;
    const contextSet = await harness.runtime.app.inject({
      method: "PUT", url: `/api/v1/publisher/learning-objects/${objectId}/launch-context`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
      payload: { launch_context: { settings } },
    });
    expect(contextSet.statusCode).toBe(200);
    return objectId;
  };

  const maths = await register(REPOSITORY_ID, "Fractions coaching session",
    { llm_endpoint: "demo", topic: "equivalent fractions", title: "Fractions coach" });
  const science = await register(scienceRepository, "Photosynthesis coaching session",
    { llm_endpoint: "demo", topic: "photosynthesis", title: "Science coach" });

  const learnerToken = await issueIesToken(harness.iesPrivateKey, "synthetic-two-course-learner", "lorb-runtime", IES_ISSUER);
  const launchOf = async (repositoryId: string, objectId: string) => {
    const launch = await harness.runtime.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
      payload: {
        contract_version: "1.0", consumer_id: "browser-suite", repository_id: repositoryId,
        object_id: objectId, requested_launch_mode: "embedded-iframe", locale: "en-GB",
      },
    });
    expect(launch.statusCode).toBe(201);
    return launch.json().player_url as string;
  };

  // The same learner opens each course's coach: same module, but each greets with its own
  // identity — the second course's context never bleeds into the first's.
  await page.goto(await launchOf(REPOSITORY_ID, maths), { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");
  await expect(module.locator("#title")).toHaveText("Fractions coach", { timeout: 15000 });
  await expect(module.locator(".bubble.coach").first()).toContainText("equivalent fractions", { timeout: 15000 });

  // The two player URLs differ only in their fragment, and a hash-only navigation does not reload
  // the document — leave the page first so the second launch starts a fresh shell, as a real
  // learner's would.
  await page.goto("about:blank");
  await page.goto(await launchOf(scienceRepository, science), { waitUntil: "networkidle" });
  await expect(module.locator("#title")).toHaveText("Science coach", { timeout: 15000 });
  await expect(module.locator(".bubble.coach").first()).toContainText("photosynthesis", { timeout: 15000 });
  await expect(module.locator(".bubble.coach").first()).not.toContainText("fractions");
});

/**
 * Coach player v2 — the launch-policy demonstration target. What matters here is that v2 speaks the
 * identical shell protocol and completes the identical evidence chain, because a launch policy
 * substitutes the renderer without the object knowing: v2 has to be a drop-in. The policy routing
 * itself is proven in tests/runtime-api/admin-enforcement.spec.ts (the resolver prefers the active
 * policy's matched rule); this pins that what the policy routes *to* actually works.
 */
test("coach player v2 is a drop-in: same protocol, same evidence, visibly v2", async ({ page }) => {
  const adminToken = await issueIesToken(harness.iesPrivateKey, "coach-admin", "lorb-runtime", IES_ISSUER, { role: "admin" });
  const moduleSha = createHash("sha256")
    .update(readFileSync(resolve(import.meta.dirname, "../../packages/coach-player/src/v2/index.html")))
    .digest("hex");

  const created = await harness.runtime.app.inject({
    method: "POST", url: "/api/v1/publisher/learning-objects",
    headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    payload: {
      repository_id: REPOSITORY_ID, title: "Fractions coaching (v2 renderer)", duration: "10 minutes",
      kind: "ai-coach", module_path: "/modules/coach-player/v2/index.html", semver: "2.0.0", sha256: moduleSha,
    },
  });
  expect(created.statusCode).toBe(201);
  const objectId = created.json().object_id as string;
  const contextSet = await harness.runtime.app.inject({
    method: "PUT", url: `/api/v1/publisher/learning-objects/${objectId}/launch-context`,
    headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    payload: { launch_context: { settings: { llm_endpoint: "demo", topic: "equivalent fractions", title: "Fractions coach" } } },
  });
  expect(contextSet.statusCode).toBe(200);

  const learnerToken = await issueIesToken(harness.iesPrivateKey, "synthetic-v2-learner", "lorb-runtime", IES_ISSUER);
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

  await page.goto(launch.json().player_url as string, { waitUntil: "networkidle" });
  const module = page.frameLocator("#module");

  // Visibly v2, with the same publisher-authored identity from the launch context.
  await expect(module.locator(".badge")).toHaveText("V2", { timeout: 15000 });
  await expect(module.locator("#title")).toHaveText("Fractions coach");
  await expect(module.locator(".bubble.coach").first()).toContainText("equivalent fractions", { timeout: 15000 });

  // A learner turn round-trips, and finishing completes the attempt — the identical chain as v1.
  await module.locator("#input").fill("Halving top and bottom keeps the value the same.");
  await module.locator("#send").click();
  await expect(module.locator(".bubble.coach").nth(1)).toContainText("keeps the value", { timeout: 15000 });
  await module.locator("#finish").click();
  await expect.poll(async () => (await harness.store.getAttempt(attemptId))?.status, { timeout: 15000 }).toBe("COMPLETED");
});

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
