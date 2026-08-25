/**
 * Postgres catalogue.
 *
 * Registration and publication happen in one transaction each, because a learning object whose
 * active_package_version_id points at a package row that failed to insert is a catalogue that
 * resolves a launch to nothing. Published package versions are never updated in place: publishing a
 * new version inserts a new immutable row and supersedes the old one.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { quizContentSchema, type QuizContent, type QuizDraft } from "../../../contracts/src/index.js";
import { buildQuizRegistration, DEFAULT_REPOSITORY, EXAMPLE_OBJECTS, QUIZ_PLAYER, QUIZ_PLAYER_PACKAGE } from "./shared.js";
import type {
  CatalogueStore, LearningObjectRow, ObjectRegistration, ObjectVersionRow, PackageVersionRow,
  RegisteredQuiz, Repository,
} from "./types.js";

const iso = (value: Date | string | null | undefined): string =>
  value === null || value === undefined ? "" : (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

function toObject(row: Record<string, any>): LearningObjectRow {
  return {
    object_id: row.object_id,
    repository_id: row.repository_id,
    status: row.status,
    active_object_version_id: row.active_object_version_id,
    active_package_version_id: row.active_package_version_id,
    created_at: iso(row.created_at),
    title: row.title,
    description: row.description,
    duration: row.duration,
    kind: row.kind,
    module_path: row.module_path,
    ...(row.content_profile ? { content_profile: row.content_profile } : {}),
    ...(row.authored_by ? { authored_by: row.authored_by } : {}),
  };
}

function toPackage(row: Record<string, any>): PackageVersionRow {
  return {
    package_version_id: row.package_version_id,
    object_id: row.object_id ?? null,
    semver: row.semver,
    sha256: row.sha256,
    delivery_profile: row.delivery_profile,
    status: row.status,
    published_at: iso(row.published_at),
    module_path: row.module_path || row.entry_point || "",
    ...(row.shared_player ? { shared_player: true as const } : {}),
  };
}

export class PostgresCatalogueStore implements CatalogueStore {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: pg.Pool) {}

  async repositories(): Promise<Repository[]> {
    const result = await this.pool.query("select repository_id, slug, display_name, status, created_at from repository order by created_at asc");
    return result.rows.map((row) => ({ ...row, created_at: iso(row.created_at) }));
  }

  async repository(repositoryId: string): Promise<Repository | undefined> {
    const result = await this.pool.query(
      "select repository_id, slug, display_name, status, created_at from repository where lower(repository_id::text) = $1",
      [repositoryId.toLowerCase()],
    );
    return result.rows[0] ? { ...result.rows[0], created_at: iso(result.rows[0].created_at) } : undefined;
  }

  async defaultRepository(): Promise<Repository | undefined> {
    const result = await this.pool.query(
      `select repository_id, slug, display_name, status, created_at from repository
       where status = 'ACTIVE' order by (repository_id = $1) desc, created_at asc limit 1`,
      [DEFAULT_REPOSITORY.repository_id],
    );
    return result.rows[0] ? { ...result.rows[0], created_at: iso(result.rows[0].created_at) } : undefined;
  }

  async learningObjects(filter: { repository_id?: string; status?: LearningObjectRow["status"] } = {}): Promise<LearningObjectRow[]> {
    const values: unknown[] = [];
    const clauses: string[] = ["active_package_version_id is not null"];
    if (filter.repository_id) { values.push(filter.repository_id.toLowerCase()); clauses.push(`lower(repository_id::text) = $${values.length}`); }
    if (filter.status) { values.push(filter.status); clauses.push(`status = $${values.length}`); }
    const result = await this.pool.query(`select * from learning_object where ${clauses.join(" and ")} order by created_at asc`, values);
    return result.rows.map(toObject);
  }

  async learningObject(objectId: string): Promise<LearningObjectRow | undefined> {
    const result = await this.pool.query("select * from learning_object where lower(object_id::text) = $1", [objectId.toLowerCase()]);
    return result.rows[0]?.active_package_version_id ? toObject(result.rows[0]) : undefined;
  }

  async objectVersion(objectVersionId: string): Promise<ObjectVersionRow | undefined> {
    const result = await this.pool.query("select * from object_version where lower(object_version_id::text) = $1", [objectVersionId.toLowerCase()]);
    const row = result.rows[0];
    return row ? { ...row, published_at: row.published_at ? iso(row.published_at) : null } : undefined;
  }

  async packageVersions(filter: { object_id?: string } = {}): Promise<PackageVersionRow[]> {
    const result = filter.object_id
      ? await this.pool.query("select * from package_version where lower(object_id::text) = $1 order by published_at asc", [filter.object_id.toLowerCase()])
      : await this.pool.query("select * from package_version order by published_at asc");
    return result.rows.map(toPackage);
  }

  async packageVersion(packageVersionId: string): Promise<PackageVersionRow | undefined> {
    const result = await this.pool.query("select * from package_version where lower(package_version_id::text) = $1", [packageVersionId.toLowerCase()]);
    return result.rows[0] ? toPackage(result.rows[0]) : undefined;
  }

  async content(objectId: string): Promise<QuizContent | undefined> {
    const result = await this.pool.query("select payload from learning_object_content where lower(object_id::text) = $1", [objectId.toLowerCase()]);
    if (!result.rows[0]) return undefined;
    const parsed = quizContentSchema.safeParse(result.rows[0].payload);
    return parsed.success ? parsed.data : undefined;
  }

  async registerObject(registration: ObjectRegistration): Promise<LearningObjectRow> {
    const object_id = randomUUID();
    const object_version_id = randomUUID();
    const package_version_id = randomUUID();
    const package_id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into learning_object (object_id, repository_id, active_object_version_id, active_package_version_id,
           status, title, description, duration, kind, module_path, authored_by)
         values ($1,$2,$3,$4,'PUBLISHED',$5,$6,$7,$8,$9,$10)`,
        [object_id, registration.repository_id, object_version_id, package_version_id, registration.title,
         registration.description ?? "", registration.duration ?? "", registration.kind ?? "native-web-package",
         registration.module_path, registration.authored_by ?? null],
      );
      await client.query(
        `insert into package_version (package_version_id, package_id, object_id, semver, sha256, delivery_profile,
           entry_point, module_path, status, published_at)
         values ($1,$2,$3,$4,$5,'native-web-package',$6,$6,'PUBLISHED', now())`,
        [package_version_id, package_id, object_id, registration.semver, registration.sha256, registration.module_path],
      );
      await client.query(
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at)
         values ($1,$2,$3,$4,'PUBLISHED', now())`,
        [object_version_id, object_id, registration.semver, package_version_id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return (await this.learningObject(object_id))!;
  }

  async publishObjectVersion(objectId: string, input: { semver: string; module_path: string; sha256: string }): Promise<LearningObjectRow | undefined> {
    const existing = await this.learningObject(objectId);
    if (!existing) return undefined;
    const object_version_id = randomUUID();
    const package_version_id = randomUUID();
    const package_id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("update object_version set status = 'SUPERSEDED' where object_id = $1 and status = 'PUBLISHED'", [existing.object_id]);
      await client.query("update package_version set status = 'SUPERSEDED' where object_id = $1 and status = 'PUBLISHED'", [existing.object_id]);
      await client.query(
        `insert into package_version (package_version_id, package_id, object_id, semver, sha256, delivery_profile,
           entry_point, module_path, status, published_at)
         values ($1,$2,$3,$4,$5,'native-web-package',$6,$6,'PUBLISHED', now())`,
        [package_version_id, package_id, existing.object_id, input.semver, input.sha256, input.module_path],
      );
      await client.query(
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at)
         values ($1,$2,$3,$4,'PUBLISHED', now())`,
        [object_version_id, existing.object_id, input.semver, package_version_id],
      );
      await client.query(
        `update learning_object set active_object_version_id = $2, active_package_version_id = $3,
           module_path = $4, updated_at = now() where object_id = $1`,
        [existing.object_id, object_version_id, package_version_id, input.module_path],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.learningObject(existing.object_id);
  }

  async retireObject(objectId: string): Promise<LearningObjectRow | undefined> {
    const result = await this.pool.query(
      "update learning_object set status = 'RETIRED', retired_at = now(), updated_at = now() where lower(object_id::text) = $1 returning *",
      [objectId.toLowerCase()],
    );
    return result.rows[0] ? toObject(result.rows[0]) : undefined;
  }

  async registerQuiz(draft: QuizDraft, options: { repository_id?: string; authored_by?: string } = {}): Promise<RegisteredQuiz> {
    await this.ensureSharedPlayer();
    const repositoryId = options.repository_id ?? (await this.defaultRepository())?.repository_id;
    if (!repositoryId) throw new Error("NO_ACTIVE_REPOSITORY");
    const built = buildQuizRegistration(draft, repositoryId, options.authored_by);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into learning_object (object_id, repository_id, active_object_version_id, active_package_version_id,
           status, title, description, duration, kind, module_path, content_profile, authored_by, created_at)
         values ($1,$2,$3,$4,'PUBLISHED',$5,$6,$7,$8,$9,'quiz-json-v1',$10,$11)`,
        [built.object.object_id, repositoryId, built.object.active_object_version_id, QUIZ_PLAYER.package_version_id,
         built.object.title, built.object.description, built.object.duration, built.object.kind,
         built.object.module_path, built.object.authored_by ?? null, built.object.created_at],
      );
      await client.query(
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at)
         values ($1,$2,$3,$4,'PUBLISHED', now())`,
        [built.object.active_object_version_id, built.object.object_id, built.objectVersionSemver, QUIZ_PLAYER.package_version_id],
      );
      await client.query(
        `insert into learning_object_content (object_id, content_profile, content_version, payload)
         values ($1,'quiz-json-v1',$2,$3)`,
        [built.object.object_id, built.content.content_version, JSON.stringify(built.content)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return built.registered;
  }

  async ensureSharedPlayer(): Promise<void> {
    await this.pool.query(
      `insert into package_version (package_version_id, package_id, object_id, semver, sha256, delivery_profile,
         entry_point, module_path, status, published_at, shared_player)
       values ($1,$2,null,$3,$4,'native-web-package',$5,$5,'PUBLISHED',$6,true)
       on conflict (package_version_id) do nothing`,
      [QUIZ_PLAYER.package_version_id, QUIZ_PLAYER.package_id, QUIZ_PLAYER.semver, QUIZ_PLAYER.sha256,
       QUIZ_PLAYER.module_path, QUIZ_PLAYER_PACKAGE.published_at],
    );
  }

  /**
   * Publishes the bundled example content. Called only where the operator has opted in; production
   * configuration refuses the flag outright, so a deployed catalogue contains only what was
   * registered through the publisher surface.
   */
  async seedExamples(): Promise<void> {
    await this.pool.query(
      `insert into repository (repository_id, slug, display_name, status)
       values ($1,$2,$3,'ACTIVE') on conflict (repository_id) do nothing`,
      [DEFAULT_REPOSITORY.repository_id, DEFAULT_REPOSITORY.slug, DEFAULT_REPOSITORY.display_name],
    );
    await this.ensureSharedPlayer();
    for (const example of EXAMPLE_OBJECTS) {
      await this.pool.query(
        `insert into learning_object (object_id, repository_id, active_object_version_id, active_package_version_id,
           status, title, description, duration, kind, module_path, created_at)
         values ($1,$2,$3,$4,'PUBLISHED',$5,$6,$7,$8,$9,$10)
         on conflict (object_id) do update set
           active_object_version_id = excluded.active_object_version_id,
           active_package_version_id = excluded.active_package_version_id,
           title = excluded.title, description = excluded.description, duration = excluded.duration,
           kind = excluded.kind, module_path = excluded.module_path, updated_at = now()`,
        [example.object.object_id, example.object.repository_id, example.object.active_object_version_id,
         example.object.active_package_version_id, example.object.title, example.object.description,
         example.object.duration, example.object.kind, example.object.module_path, example.object.created_at],
      );
      await this.pool.query(
        `insert into package_version (package_version_id, package_id, object_id, semver, sha256, delivery_profile,
           entry_point, module_path, status, published_at)
         values ($1,$2,$3,$4,$5,'native-web-package',$6,$6,'PUBLISHED',$7)
         on conflict (package_version_id) do nothing`,
        [example.package.package_version_id, randomUUID(), example.package.object_id, example.package.semver,
         example.package.sha256, example.package.module_path, example.package.published_at],
      );
      await this.pool.query(
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at)
         values ($1,$2,$3,$4,'PUBLISHED',$5) on conflict (object_version_id) do nothing`,
        [example.object.active_object_version_id, example.object.object_id, example.package.semver,
         example.package.package_version_id, example.package.published_at],
      );
    }
  }
}
