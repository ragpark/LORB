/**
 * The upgrade path, run against a real database.
 *
 * Every other Postgres suite starts from a database with all migrations already applied, which is
 * the one case an upgrade cannot go wrong in. The case that matters is the other one: a database
 * that already carries content under the original schema, being migrated forward.
 *
 * Migration 007 is additive, which makes it look safe. It is not, by itself: it adds
 * `active_package_version_id` to `learning_object` as a nullable column and creates `object_version`
 * empty, and the catalogue reads a null active package as "this object has nothing to deliver" and
 * hides the row. Without a backfill, upgrading takes every previously published object out of the
 * catalogue and out of every launch, silently.
 *
 * So this applies the migrations in order into a throwaway schema, with pre-007 content in place
 * before 007 runs, and asserts the content is still there afterwards.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDatabase = DATABASE_URL ? describe : describe.skip;

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../packages/runtime-api/src/db/migrations");

/** Migrations up to but not including the one under test, then the rest. */
async function migrations(): Promise<string[]> {
  return (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
}

describeIfDatabase("upgrading a database that already has content", () => {
  const schema = `migration_test_${randomUUID().replace(/-/g, "")}`;
  let client: pg.Client;
  const objectId = randomUUID();
  const repositoryId = randomUUID();
  const packageVersionId = randomUUID();

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`create schema ${schema}`);
    // Unqualified names in the migrations resolve here, so the real database is untouched.
    await client.query(`set search_path to ${schema}`);

    const files = await migrations();
    const upgrade = files.indexOf("007_production_runtime.sql");
    expect(upgrade, "007 must exist for this suite to mean anything").toBeGreaterThan(-1);

    for (const filename of files.slice(0, upgrade)) {
      await client.query(await readFile(join(migrationsDirectory, filename), "utf8"));
    }

    // Content as the original schema held it: an object pointing at nothing, and a published package
    // version that is the only record of what the object actually delivers.
    await client.query(
      `insert into repository (repository_id, slug, display_name, status) values ($1, $2, 'Migration suite', 'ACTIVE')`,
      [repositoryId, `migration-${repositoryId.slice(0, 8)}`],
    );
    await client.query(
      `insert into learning_object (object_id, repository_id, active_object_version_id, status)
       values ($1, $2, null, 'PUBLISHED')`,
      [objectId, repositoryId],
    );
    await client.query(
      `insert into package_version
         (package_version_id, package_id, object_id, semver, sha256, delivery_profile, entry_point, status, published_at)
       values ($1, $2, $3, '1.0.0', $4, 'native-web-package', '/modules/legacy/index.html', 'PUBLISHED', now())`,
      [packageVersionId, randomUUID(), objectId, "b".repeat(64)],
    );

    for (const filename of files.slice(upgrade)) {
      await client.query(await readFile(join(migrationsDirectory, filename), "utf8"));
    }
  });

  afterAll(async () => {
    await client?.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
    await client?.end().catch(() => undefined);
  });

  it("keeps a published object deliverable, rather than hiding it behind a null active package", async () => {
    const { rows } = await client.query(
      `select active_package_version_id, active_object_version_id, title, module_path
         from learning_object where object_id = $1`,
      [objectId],
    );
    expect(rows[0].active_package_version_id).toBe(packageVersionId);
    expect(rows[0].active_object_version_id).not.toBeNull();
    // A blank title would list as an unnamed row in every catalogue view.
    expect(rows[0].title).not.toBe("");
    expect(rows[0].module_path).toBe("/modules/legacy/index.html");
  });

  it("gives the object a version row for descriptors and attempts to bind to", async () => {
    const { rows } = await client.query(
      `select object_version_id, semver, package_version_id, status from object_version where object_id = $1`,
      [objectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].semver).toBe("1.0.0");
    expect(rows[0].package_version_id).toBe(packageVersionId);
    expect(rows[0].status).toBe("PUBLISHED");
  });

  it("is idempotent: applying the migration again changes nothing", async () => {
    const before = await client.query(`select object_version_id from object_version where object_id = $1`, [objectId]);
    await client.query(await readFile(join(migrationsDirectory, "007_production_runtime.sql"), "utf8"));
    const after = await client.query(`select object_version_id from object_version where object_id = $1`, [objectId]);
    expect(after.rows).toEqual(before.rows);
  });
});
