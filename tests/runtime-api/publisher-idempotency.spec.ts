/**
 * The Publisher API's idempotency, which for a while was a header check and nothing else.
 *
 * Every publisher mutation demands an `Idempotency-Key`, and demanding it was all that happened: the
 * key was never read back and never recorded. A client that lost the response to a registration and
 * retried it — exactly what an idempotency key exists to make safe — registered the object a second
 * time. A retried version publication either published a second version or failed on the semver
 * uniqueness constraint, which is a confusing error rather than the original answer.
 *
 * Needs Postgres: the publisher's authorisation is repository membership, and the audit trail it
 * writes is enforced by database triggers.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { PostgresCatalogueStore } from "../../packages/runtime-api/src/catalogue/postgres.js";
import { PostgresRuntimeStore } from "../../packages/runtime-api/src/store/postgres.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDatabase = DATABASE_URL ? describe : describe.skip;
const ISSUER = "https://ies.publisher-idempotency.test";

describeIfDatabase("Publisher API idempotency", () => {
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  let pool: pg.Pool;
  let catalogue: PostgresCatalogueStore;
  let token: string;
  let repositoryId: string;

  beforeAll(async () => {
    process.env.ADMIN_ALLOWED_ROLES = "admin";
    const keys = await generateKeyPair("ES256");
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    catalogue = new PostgresCatalogueStore(pool);
    runtime = await buildRuntime({
      iesKey: keys.publicKey, iesIssuer: ISSUER,
      playerOrigin: "https://player.publisher-idempotency.test",
      secret: Buffer.alloc(32, 9), store: new PostgresRuntimeStore(pool), catalogue,
    });
    token = await issueIesToken(keys.privateKey as never, `publisher-${randomUUID().slice(0, 8)}`, "lorb-runtime", ISSUER, { role: "admin" });

    // Creating a repository grants the caller owner membership, which is what authorises publishing.
    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/admin/repositories",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      payload: { slug: `pub-${randomUUID().slice(0, 8)}`, display_name: "Publisher idempotency suite" },
    });
    expect(created.statusCode).toBe(201);
    repositoryId = created.json().repository_id;
  });

  afterAll(async () => {
    await runtime?.app.close();
    await pool?.end();
  });

  const registration = () => ({
    repository_id: repositoryId,
    title: "Retryable registration",
    module_path: "/modules/retryable/index.html",
    semver: "1.0.0",
    sha256: "c".repeat(64),
  });

  const register = (key: string, body: Record<string, unknown> = registration()) =>
    runtime.app.inject({
      method: "POST", url: "/api/v1/publisher/learning-objects",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      payload: body,
    });

  it("registers one object however many times the request is retried", async () => {
    const key = randomUUID();
    const first = await register(key);
    expect(first.statusCode).toBe(201);
    const objectId = first.json().object_id as string;

    const retry = await register(key);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().object_id).toBe(objectId);

    const objects = await catalogue.learningObjects({ repository_id: repositoryId });
    expect(objects.filter((object) => object.title === "Retryable registration")).toHaveLength(1);
  });

  it("refuses the key when the retried body is not the same request", async () => {
    const key = randomUUID();
    expect((await register(key)).statusCode).toBe(201);
    const different = await register(key, { ...registration(), title: "A different object entirely" });
    expect(different.statusCode).toBe(409);
    expect(different.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("publishes one version however many times publication is retried", async () => {
    const created = await register(randomUUID(), { ...registration(), title: "Versioned object" });
    const objectId = created.json().object_id as string;
    const key = randomUUID();
    const body = { semver: "1.1.0", module_path: "/modules/retryable/v2/index.html", sha256: "d".repeat(64) };

    const publish = (idempotencyKey: string) =>
      runtime.app.inject({
        method: "POST", url: `/api/v1/publisher/learning-objects/${objectId}/versions`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey },
        payload: body,
      });

    const first = await publish(key);
    expect(first.statusCode).toBe(201);
    // Without a recorded claim this second call hit the semver uniqueness constraint instead of
    // replaying the answer the caller lost.
    const retry = await publish(key);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().active_package_version_id).toBe(first.json().active_package_version_id);

    const versions = await catalogue.packageVersions({ object_id: objectId });
    expect(versions.filter((version) => version.semver === "1.1.0")).toHaveLength(1);
  });

  it("frees the key when the request it claimed was rejected", async () => {
    const key = randomUUID();
    // A module path that could escape the player origin is refused, and nothing is created — so the
    // key must not be held against a corrected retry.
    const rejected = await register(key, { ...registration(), module_path: "/modules/../../etc/passwd" });
    expect(rejected.statusCode).toBe(400);

    const corrected = await register(key, { ...registration(), title: "Corrected after rejection" });
    expect(corrected.statusCode).toBe(201);
  });
});
