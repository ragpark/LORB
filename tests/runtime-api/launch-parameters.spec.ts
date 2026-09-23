/**
 * Launch parameters: the publisher declares, the consumer chooses, per launch.
 *
 * This is the only path by which a value chosen outside LORB reaches a third party's URL, so the
 * declaration is an allow-list rather than a schema. Two properties carry the whole design and are
 * pinned here:
 *
 *  - A name the object does not declare, or a value outside that name's declared list, is refused.
 *    Not dropped, not sanitised — refused, because silently ignoring a choice hands a teacher an
 *    activity configured differently from the one they asked for, and silently accepting one lets
 *    anyone who can request a launch append what they like to an origin the deployment already
 *    trusts. Without this an external embed becomes an open redirect wearing a feature's clothes.
 *
 *  - The choice does not publish a version. Launch context (migration 009) is the publisher's
 *    decision pinned to an object version; these are the consumer's decision recorded on the
 *    attempt. Two teachers launching the same object may legitimately differ, and the catalogue must
 *    not move underneath either of them.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { embedUrlWithParameters, externalEmbedDraftSchema, launchRequestSchema } from "../../packages/contracts/src/index.js";

const ISSUER = "https://identity.launch-parameters.test";
const TRUSTED_ORIGIN = "https://sow-planner.example.com";

const PARAMETERS = [
  { name: "subject", label: "Subject", values: ["biology", "chemistry", "physics"], default: "biology" },
  { name: "keyStage", label: "Key stage", values: ["KS3", "KS4"], default: "KS3" },
];

async function setup() {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const store = new MemoryRuntimeStore();
  const catalogue = new MemoryCatalogueStore({ seedExamples: false });
  const runtime = await buildRuntime({
    iesKey: keys.publicKey, iesIssuer: ISSUER, playerOrigin: `https://player.launch-parameters-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 23), store, catalogue, allowedExternalEmbedOrigins: [TRUSTED_ORIGIN],
  });
  const adminToken = await issueIesToken(keys.privateKey, "parameters-admin", "lorb-runtime", ISSUER, { role: "admin" });
  const learnerToken = await issueIesToken(keys.privateKey, "parameters-learner", "lorb-runtime", ISSUER, {});
  const repository = (await catalogue.defaultRepository())!;

  const register = async (parameters?: unknown) => {
    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/publisher/learning-objects/external-embeds",
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
      payload: {
        repository_id: repository.repository_id,
        title: "Scheme of work planner",
        // A hash-routed application, which is the shape that makes naive string concatenation wrong.
        embed_url: `${TRUSTED_ORIGIN}/curriculum?subject=biology&keyStage=KS3#/`,
        ...(parameters === undefined ? {} : { parameters }),
      } as never,
    });
    expect(created.statusCode).toBe(201);
    return created.json().object_id as string;
  };

  const launch = (objectId: string, launchParameters?: Record<string, string>) => runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "launch-parameters-suite",
      repository_id: repository.repository_id, object_id: objectId,
      requested_launch_mode: "embedded-iframe", locale: "en-GB",
      ...(launchParameters === undefined ? {} : { launch_parameters: launchParameters }),
    } as never,
  });

  return { runtime, store, register, launch, learnerToken };
}

describe("the parameter declaration", () => {
  const draft = (parameters: unknown) => ({
    title: "Scheme of work planner",
    embed_url: `${TRUSTED_ORIGIN}/curriculum`,
    parameters,
  });

  it("accepts a declaration naming a value list", () => {
    expect(externalEmbedDraftSchema.safeParse(draft(PARAMETERS)).success).toBe(true);
  });

  it("refuses a default that is not one of the declared values", () => {
    expect(externalEmbedDraftSchema.safeParse(draft([
      { name: "subject", label: "Subject", values: ["biology"], default: "geography" },
    ])).success).toBe(false);
  });

  it("refuses an empty value list, because a parameter with no permitted values permits anything or nothing", () => {
    expect(externalEmbedDraftSchema.safeParse(draft([{ name: "subject", label: "Subject", values: [] }])).success).toBe(false);
  });

  it("refuses two declarations of the same name", () => {
    expect(externalEmbedDraftSchema.safeParse(draft([
      { name: "subject", label: "Subject", values: ["biology"] },
      { name: "subject", label: "Subject again", values: ["chemistry"] },
    ])).success).toBe(false);
  });

  it("refuses a value carrying URL punctuation, so a declared value can never restructure the address", () => {
    for (const hostile of ["biology&admin=1", "biology#/other", "../../etc", "https://elsewhere.example"]) {
      expect(externalEmbedDraftSchema.safeParse(draft([{ name: "subject", label: "Subject", values: [hostile] }])).success).toBe(false);
    }
  });

  it("keeps launch_parameters optional on the launch request, so every existing consumer is unaffected", () => {
    const base = {
      contract_version: "1.0", consumer_id: "c", repository_id: randomUUID(), object_id: randomUUID(),
      requested_launch_mode: "embedded-iframe", locale: "en-GB",
    };
    expect(launchRequestSchema.safeParse(base).success).toBe(true);
    expect(launchRequestSchema.safeParse({ ...base, launch_parameters: { subject: "biology" } }).success).toBe(true);
  });
});

describe("a launch against a declared parameter", () => {
  it("records the chosen values on the attempt", async () => {
    const h = await setup();
    const objectId = await h.register(PARAMETERS);
    const launched = await h.launch(objectId, { subject: "chemistry", keyStage: "KS4" });
    expect(launched.statusCode).toBe(201);

    const attempt = await h.store.getAttempt(launched.json().attempt_id);
    expect(attempt?.launch_parameters).toEqual({ subject: "chemistry", keyStage: "KS4" });
  });

  it("fills in the declared defaults for anything the caller did not choose", async () => {
    const h = await setup();
    const objectId = await h.register(PARAMETERS);
    const launched = await h.launch(objectId, { subject: "physics" });

    const attempt = await h.store.getAttempt(launched.json().attempt_id);
    expect(attempt?.launch_parameters).toEqual({ subject: "physics", keyStage: "KS3" });
  });

  it("serves the resolved values to the player surface, scoped to its own attempt", async () => {
    const h = await setup();
    const objectId = await h.register(PARAMETERS);
    const launched = await h.launch(objectId, { subject: "chemistry" });
    const descriptor = launched.json().signed_descriptor as string;
    const attemptId = launched.json().attempt_id as string;

    const served = await h.runtime.app.inject({
      method: "GET", url: `/api/v1/runtime/attempts/${attemptId}/launch-parameters`,
      headers: { authorization: `Bearer ${descriptor}` },
    });
    expect(served.statusCode).toBe(200);
    expect(served.json().parameters).toEqual({ subject: "chemistry", keyStage: "KS3" });
  });

  it("refuses a descriptor for a different attempt", async () => {
    const h = await setup();
    const objectId = await h.register(PARAMETERS);
    const mine = await h.launch(objectId, { subject: "biology" });
    const theirs = await h.launch(objectId, { subject: "physics" });

    const crossed = await h.runtime.app.inject({
      method: "GET", url: `/api/v1/runtime/attempts/${theirs.json().attempt_id}/launch-parameters`,
      headers: { authorization: `Bearer ${mine.json().signed_descriptor}` },
    });
    expect(crossed.statusCode).toBe(403);
  });

  it("does not publish a version: the object still points at the version it did before", async () => {
    const h = await setup();
    const objectId = await h.register(PARAMETERS);
    const before = await h.launch(objectId, { subject: "biology" });
    const after = await h.launch(objectId, { subject: "physics" });

    expect(after.json().attempt_id).not.toBe(before.json().attempt_id);
    const one = await h.store.getAttempt(before.json().attempt_id);
    const two = await h.store.getAttempt(after.json().attempt_id);
    expect(two?.object_version_id).toBe(one?.object_version_id);
    expect(two?.launch_parameters).not.toEqual(one?.launch_parameters);
  });
});

describe("the allow-list, which is the control", () => {
  it("refuses a value the object does not declare", async () => {
    const h = await setup();
    const objectId = await h.register(PARAMETERS);
    const launched = await h.launch(objectId, { subject: "geography" });

    expect(launched.statusCode).toBe(400);
    expect(launched.json().code).toBe("LAUNCH_PARAMETERS_INVALID");
  });

  it("refuses a name the object does not declare", async () => {
    const h = await setup();
    const objectId = await h.register(PARAMETERS);
    const launched = await h.launch(objectId, { redirectTo: "biology" });

    expect(launched.statusCode).toBe(400);
    expect(launched.json().code).toBe("LAUNCH_PARAMETERS_INVALID");
  });

  it("refuses parameters against an object that declares none, rather than ignoring them", async () => {
    const h = await setup();
    const objectId = await h.register();
    const launched = await h.launch(objectId, { subject: "biology" });

    expect(launched.statusCode).toBe(400);
    expect(launched.json().code).toBe("LAUNCH_PARAMETERS_INVALID");
  });

  it("creates no attempt when it refuses", async () => {
    const h = await setup();
    const objectId = await h.register(PARAMETERS);
    await h.launch(objectId, { subject: "geography" });

    expect(await h.store.listAttempts({})).toHaveLength(0);
  });

  it("leaves an object that declares none exactly as it was", async () => {
    const h = await setup();
    const objectId = await h.register();
    const launched = await h.launch(objectId);

    expect(launched.statusCode).toBe(201);
    const attempt = await h.store.getAttempt(launched.json().attempt_id);
    expect(attempt?.launch_parameters).toBeUndefined();
  });
});

describe("applying the parameters to the address", () => {
  it("puts them in the query string, not inside a hash route", () => {
    const merged = embedUrlWithParameters(`${TRUSTED_ORIGIN}/curriculum?subject=biology&keyStage=KS3#/`, {
      subject: "chemistry", keyStage: "KS4",
    });
    const url = new URL(merged);
    expect(url.searchParams.get("subject")).toBe("chemistry");
    expect(url.searchParams.get("keyStage")).toBe("KS4");
    // The fragment is the part naive concatenation destroys: appended to the end of that string, the
    // parameters land inside the route and the router never sees them.
    expect(url.hash).toBe("#/");
    expect(merged.indexOf("?")).toBeLessThan(merged.indexOf("#"));
  });

  it("overrides a value the registered address already carried", () => {
    const merged = embedUrlWithParameters(`${TRUSTED_ORIGIN}/curriculum?subject=biology`, { subject: "physics" });
    expect(new URL(merged).searchParams.getAll("subject")).toEqual(["physics"]);
  });

  it("adds a parameter to an address that had no query string at all", () => {
    const merged = embedUrlWithParameters(`${TRUSTED_ORIGIN}/curriculum`, { subject: "physics" });
    expect(new URL(merged).searchParams.get("subject")).toBe("physics");
  });

  it("leaves the address untouched when the launch carries nothing", () => {
    const original = `${TRUSTED_ORIGIN}/curriculum?subject=biology#/`;
    expect(embedUrlWithParameters(original, {})).toBe(original);
  });

  it("never changes the origin, whatever it is handed", () => {
    const merged = embedUrlWithParameters(`${TRUSTED_ORIGIN}/curriculum`, { subject: "physics" });
    expect(new URL(merged).origin).toBe(TRUSTED_ORIGIN);
  });
});
