/**
 * The learning record store's contract.
 *
 * This is the box the architecture diagram has always had and the platform never owned: `LRS_ENDPOINT`
 * pointed either at somebody else's product or, in development, at an in-memory stub that lost
 * everything on restart. What is checked here is the behaviour the evidence forwarder is built
 * against and would silently corrupt evidence without:
 *
 *   - a redelivered statement is a no-op, and a *different* statement under the same id is refused
 *     rather than overwriting what is stored;
 *   - a statement is never modified or deleted once accepted;
 *   - a store with no credentials configured accepts nothing;
 *   - an actor that identifies a person is refused, because the whole evidence chain is pseudonymous
 *     and this store is where that would leak.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildLrs, testConfig } from "../../packages/lrs/src/app.js";
import { MemoryLrsStore } from "../../packages/lrs/src/store.js";
import { identifiesAPerson, statementDigest } from "../../packages/lrs/src/statement.js";
import { agentFilter } from "../../packages/lrs/src/app.js";

const TOKEN = "a-test-bearer-token-of-sufficient-length";

async function setup(overrides = {}) {
  const config = testConfig({ credentials: [{ kind: "bearer", token: TOKEN }], ...overrides });
  const { app, store } = await buildLrs({ config, store: new MemoryLrsStore() });
  const auth = { authorization: `Bearer ${TOKEN}`, "x-experience-api-version": "1.0.3" };
  return { app, store, config, auth };
}

const statement = (overrides: Record<string, unknown> = {}) => ({
  actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: "a".repeat(64) } },
  verb: { id: "http://adlnet.gov/expapi/verbs/completed", display: { "en-GB": "completed" } },
  object: { id: "https://lorb.example/activities/ratios", objectType: "Activity" },
  result: { completion: true, score: { scaled: 0.8 } },
  context: { registration: randomUUID(), extensions: { "https://lorb.example/xapi/attempt_id": randomUUID() } },
  timestamp: "2026-08-27T09:00:00.000Z",
  ...overrides,
});

describe("learning record store", () => {
  it("stores a statement under the id the caller names, and returns it", async () => {
    const { app, auth } = await setup();
    const id = randomUUID();
    const put = await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: statement() });
    expect(put.statusCode).toBe(204);
    expect(put.headers["x-experience-api-version"]).toBe("1.0.3");

    const read = await app.inject({ method: "GET", url: `/statements?statementId=${id}`, headers: auth });
    expect(read.statusCode).toBe(200);
    expect(read.json().id).toBe(id);
    expect(read.json().result.score.scaled).toBe(0.8);
  });

  it("treats a redelivery as a no-op and a different statement under the same id as a conflict", async () => {
    const { app, store, auth } = await setup();
    const id = randomUUID();
    const body = statement();
    expect((await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: body })).statusCode).toBe(204);
    // The forwarder redelivers after a lost response; that must not produce a second record.
    expect((await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: body })).statusCode).toBe(204);
    expect(await store.count()).toBe(1);

    const conflicting = await app.inject({
      method: "PUT", url: `/statements?statementId=${id}`, headers: auth,
      payload: statement({ result: { completion: true, score: { scaled: 0.1 } } }),
    });
    expect(conflicting.statusCode).toBe(409);
    // What was stored first is what is still stored.
    const read = await app.inject({ method: "GET", url: `/statements?statementId=${id}`, headers: auth });
    expect(read.json().result.score.scaled).toBe(0.8);
  });

  it("refuses a statement whose body disagrees with the id it was addressed to", async () => {
    const { app, auth } = await setup();
    const response = await app.inject({
      method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth,
      payload: statement({ id: randomUUID() }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("ID_MISMATCH");
  });

  it("accepts a batch by POST and answers with the ids it stored", async () => {
    const { app, store, auth } = await setup();
    const response = await app.inject({ method: "POST", url: "/statements", headers: auth, payload: [statement(), statement()] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
    expect(await store.count()).toBe(2);
  });

  it("refuses an actor that identifies a person, however the identifier is carried", async () => {
    const { app, auth } = await setup();
    for (const actor of [
      { mbox: "mailto:learner@example.test" },
      { name: "A Learner", account: { homePage: "https://lorb.example/pseudonym", name: "b".repeat(64) } },
      { openid: "https://example.test/learner" },
      { mbox_sha1sum: "0".repeat(40) },
    ]) {
      const response = await app.inject({
        method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth, payload: statement({ actor }),
      });
      expect(response.statusCode, JSON.stringify(actor)).toBe(400);
      expect(response.json().error).toBe("ACTOR_IDENTIFIES_A_PERSON");
    }
    // And through a group's membership, which is the shape that would otherwise slip past.
    expect(identifiesAPerson({ objectType: "Group", member: [{ mbox: "mailto:learner@example.test" }] })).toBe(true);
  });

  it("stores an identified actor only where the deployment has deliberately allowed it", async () => {
    const { app, auth } = await setup({ requirePseudonymousActor: false });
    const response = await app.inject({
      method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth,
      payload: statement({ actor: { mbox: "mailto:learner@example.test" } }),
    });
    expect(response.statusCode).toBe(204);
  });

  it("accepts nothing without a credential, and nothing with the wrong one", async () => {
    const { app } = await setup();
    const id = randomUUID();
    const unauthenticated = await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, payload: statement() });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["www-authenticate"]).toContain("Bearer");

    const wrong = await app.inject({
      method: "PUT", url: `/statements?statementId=${id}`,
      headers: { authorization: "Bearer not-the-configured-token-at-all" }, payload: statement(),
    });
    expect(wrong.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/statements" })).statusCode).toBe(401);
  });

  it("accepts basic authentication as well as bearer, so a rotation can run both at once", async () => {
    const { app } = await setup({
      credentials: [
        { kind: "bearer", token: TOKEN },
        { kind: "basic", username: "forwarder", password: "a-long-enough-password" },
      ],
    });
    const basic = Buffer.from("forwarder:a-long-enough-password").toString("base64");
    const response = await app.inject({
      method: "PUT", url: `/statements?statementId=${randomUUID()}`,
      headers: { authorization: `Basic ${basic}` }, payload: statement(),
    });
    expect(response.statusCode).toBe(204);
  });

  it("refuses a client speaking a version of xAPI it does not", async () => {
    const { app, auth } = await setup();
    const response = await app.inject({
      method: "PUT", url: `/statements?statementId=${randomUUID()}`,
      headers: { ...auth, "x-experience-api-version": "2.0.0" }, payload: statement(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VERSION_NOT_SUPPORTED");
  });

  it("filters a query by actor, verb, activity and attempt, and pages through the rest", async () => {
    const { app, auth } = await setup();
    const learner = "c".repeat(64);
    const attempt = randomUUID();
    for (let index = 0; index < 5; index += 1) {
      await app.inject({
        method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth,
        payload: statement({
          actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: learner } },
          verb: { id: "http://adlnet.gov/expapi/verbs/answered", display: { "en-GB": "answered" } },
          context: { extensions: { "https://lorb.example/xapi/attempt_id": attempt } },
        }),
      });
    }
    await app.inject({ method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth, payload: statement() });

    const byActor = await app.inject({ method: "GET", url: `/statements?agent=${learner}`, headers: auth });
    expect(byActor.json().statements).toHaveLength(5);
    const byVerb = await app.inject({ method: "GET", url: "/statements?verb=http://adlnet.gov/expapi/verbs/completed", headers: auth });
    expect(byVerb.json().statements).toHaveLength(1);
    const byAttempt = await app.inject({ method: "GET", url: `/statements?attempt_id=${attempt}`, headers: auth });
    expect(byAttempt.json().statements).toHaveLength(5);

    const firstPage = await app.inject({ method: "GET", url: `/statements?agent=${learner}&limit=2`, headers: auth });
    expect(firstPage.json().statements).toHaveLength(2);
    expect(firstPage.json().more).toContain("cursor=");
    const secondPage = await app.inject({ method: "GET", url: firstPage.json().more, headers: auth });
    expect(secondPage.json().statements).toHaveLength(2);
    // Paging is a walk, not a repeat: no statement appears on two pages.
    const seen = [...firstPage.json().statements, ...secondPage.json().statements].map((s: { id: string }) => s.id);
    expect(new Set(seen).size).toBe(4);
  });

  it("hides a voided statement from queries but still answers for it by id", async () => {
    const { app, auth } = await setup();
    const target = randomUUID();
    await app.inject({ method: "PUT", url: `/statements?statementId=${target}`, headers: auth, payload: statement() });
    const void_ = await app.inject({
      method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth,
      payload: statement({
        verb: { id: "http://adlnet.gov/expapi/verbs/voided", display: { "en-GB": "voided" } },
        object: { objectType: "StatementRef", id: target },
      }),
    });
    expect(void_.statusCode).toBe(204);

    const listed = await app.inject({ method: "GET", url: "/statements", headers: auth });
    expect(listed.json().statements.map((s: { id: string }) => s.id)).not.toContain(target);
    // The evidence is not gone — voiding is an assertion about a statement, not a delete.
    expect((await app.inject({ method: "GET", url: `/statements?statementId=${target}`, headers: auth })).statusCode).toBe(200);
  });

  it("applies a void that arrives before the statement it voids", async () => {
    const { app, auth } = await setup();
    const target = randomUUID();
    await app.inject({
      method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth,
      payload: statement({
        verb: { id: "http://adlnet.gov/expapi/verbs/voided", display: { "en-GB": "voided" } },
        object: { objectType: "StatementRef", id: target },
      }),
    });
    await app.inject({ method: "PUT", url: `/statements?statementId=${target}`, headers: auth, payload: statement() });
    const listed = await app.inject({ method: "GET", url: "/statements", headers: auth });
    expect(listed.json().statements.map((s: { id: string }) => s.id)).not.toContain(target);
  });

  it("says which version of xAPI it speaks without being asked for a credential", async () => {
    const { app } = await setup();
    const about = await app.inject({ method: "GET", url: "/about" });
    expect(about.statusCode).toBe(200);
    expect(about.json().version).toContain("1.0.3");
  });

  it("is idempotent for a statement that carries no timestamp of its own", async () => {
    const { app, store, auth } = await setup();
    const id = randomUUID();
    // No timestamp: the store fills one in from its own clock. Digesting the filled-in value would
    // give the same request a new identity every time it arrived, so a retry would be a conflict.
    const body = { ...statement(), timestamp: undefined };
    delete (body as { timestamp?: unknown }).timestamp;
    expect((await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: body })).statusCode).toBe(204);
    expect((await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: body })).statusCode).toBe(204);
    expect(await store.count()).toBe(1);
  });

  it("accepts the representation it handed back as the statement it already holds", async () => {
    const { app, store, auth } = await setup();
    const id = randomUUID();
    const body = statement();
    delete (body as { timestamp?: unknown }).timestamp;
    expect((await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: body })).statusCode).toBe(204);

    // Read it back and send it straight in again. What comes out carries the timestamp and `stored`
    // this store assigned, so it never arrived in that form — and it is still the same statement.
    const representation = (await app.inject({ method: "GET", url: `/statements?statementId=${id}`, headers: auth })).json();
    const replay = await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: representation });
    expect(replay.statusCode).toBe(204);
    expect(await store.count()).toBe(1);

    // The original timestamp-less request is still a duplicate too: both round trips have to work.
    expect((await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: body })).statusCode).toBe(204);
    expect(await store.count()).toBe(1);

    // And a genuinely different statement under that id is still refused.
    const different = { ...representation, result: { completion: false } };
    expect((await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: different })).statusCode).toBe(409);
  });

  it("refuses a batch that conflicts with itself, not only with what is stored", async () => {
    const { app, store, auth } = await setup();
    const id = randomUUID();
    const before = await store.count();
    // Both entries name the same id and disagree. Neither is stored when the batch is checked, so a
    // check that only reads the store would write the first and report success for both.
    const response = await app.inject({
      method: "POST", url: "/statements", headers: auth,
      payload: [statement({ id, result: { completion: true } }), statement({ id, result: { completion: false } })],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain("statement 1");
    expect(await store.count()).toBe(before);

    // The same id twice with the same content is a duplicate, not a conflict. One body, sent twice:
    // two calls to the fixture would differ by their random registration and be a real conflict.
    const twice = statement({ id });
    const agreeing = await app.inject({
      method: "POST", url: "/statements", headers: auth,
      payload: [twice, twice],
    });
    expect(agreeing.statusCode).toBe(200);
    expect(await store.count()).toBe(before + 1);
  });

  it("stores nothing from a batch that conflicts part way through", async () => {
    const { app, store, auth } = await setup();
    const taken = randomUUID();
    await app.inject({ method: "PUT", url: `/statements?statementId=${taken}`, headers: auth, payload: statement() });
    const before = await store.count();

    // The first entry has no id of its own, so if it were written the caller would never learn the
    // id it was written under — and a retry of the batch would store it a second time.
    const response = await app.inject({
      method: "POST", url: "/statements", headers: auth,
      payload: [statement(), { ...statement({ id: taken }), result: { completion: false } }],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain("statement 1");
    expect(await store.count()).toBe(before);
  });

  it("serves `stored` from its own clock, whatever the sender said", async () => {
    const { app, auth } = await setup();
    const id = randomUUID();
    await app.inject({
      method: "PUT", url: `/statements?statementId=${id}`, headers: auth,
      payload: statement({ stored: "1999-01-01T00:00:00.000Z" }),
    });
    const read = await app.inject({ method: "GET", url: `/statements?statementId=${id}`, headers: auth });
    expect(read.json().stored).toBeDefined();
    expect(read.json().stored).not.toBe("1999-01-01T00:00:00.000Z");

    // And a statement that arrived without one is not returned without provenance.
    const bare = randomUUID();
    await app.inject({ method: "PUT", url: `/statements?statementId=${bare}`, headers: auth, payload: statement() });
    const listed = await app.inject({ method: "GET", url: `/statements?statementId=${bare}`, headers: auth });
    expect(listed.json().stored).toBeDefined();
  });

  it("filters on an xAPI Agent as well as on the platform's shorthand", async () => {
    const { app, auth } = await setup();
    const learner = "9".repeat(64);
    await app.inject({
      method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth,
      payload: statement({ actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: learner } } }),
    });

    const asAgent = encodeURIComponent(JSON.stringify({ objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: learner } }));
    const standard = await app.inject({ method: "GET", url: `/statements?agent=${asAgent}`, headers: auth });
    expect(standard.json().statements).toHaveLength(1);
    const shorthand = await app.inject({ method: "GET", url: `/statements?agent=${learner}`, headers: auth });
    expect(shorthand.json().statements).toHaveLength(1);

    // An Agent this store could never hold a statement for matches nothing, not everything.
    const byMbox = encodeURIComponent(JSON.stringify({ mbox: "mailto:learner@example.test" }));
    expect((await app.inject({ method: "GET", url: `/statements?agent=${byMbox}`, headers: auth })).json().statements).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/statements?agent=%7Bnot-json", headers: auth })).statusCode).toBe(400);
  });

  it("reads an agent filter out of either shape", () => {
    expect(agentFilter(undefined)).toBeUndefined();
    expect(agentFilter("abc")).toBe("abc");
    expect(agentFilter(JSON.stringify({ account: { homePage: "h", name: "abc" } }))).toBe("abc");
    expect(agentFilter(JSON.stringify({ mbox: "mailto:a@b.test" }))).toBe("UNMATCHABLE");
    expect(agentFilter("{oops")).toBe("UNPARSEABLE");
    expect(agentFilter(JSON.stringify({ objectType: "Agent" }))).toBe("UNPARSEABLE");
  });

  it("digests a statement independently of key order and of the store's own clock", async () => {
    const first = statementDigest({ actor: { account: { homePage: "h", name: "n" } }, verb: { id: "v" }, object: { id: "o" }, timestamp: "2026-08-27T09:00:00.000Z" } as never);
    const reordered = statementDigest({ timestamp: "2026-08-27T09:00:00.000Z", object: { id: "o" }, verb: { id: "v" }, actor: { account: { name: "n", homePage: "h" } } } as never);
    expect(reordered).toBe(first);
    const stored = statementDigest({ actor: { account: { homePage: "h", name: "n" } }, verb: { id: "v" }, object: { id: "o" }, timestamp: "2026-08-27T09:00:00.000Z", stored: "2026-08-27T10:00:00.000Z" } as never);
    expect(stored).toBe(first);
  });

  it("does not confuse a `stored` key inside somebody's telemetry with its own", async () => {
    const { app, auth } = await setup();
    const id = randomUUID();
    const telemetry = (value: string) => statement({
      result: { extensions: { "https://example.test/xapi/sensor": { stored: value } } },
    });
    expect((await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: telemetry("first") })).statusCode).toBe(204);
    // Two genuinely different statements. Stripping every key named `stored` would digest them the
    // same and report the second as a duplicate, silently keeping the first.
    const second = await app.inject({ method: "PUT", url: `/statements?statementId=${id}`, headers: auth, payload: telemetry("second") });
    expect(second.statusCode).toBe(409);
  });
});
