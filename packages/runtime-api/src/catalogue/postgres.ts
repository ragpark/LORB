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
import {
  audioContentSchema, documentContentSchema, quizContentSchema, videoContentSchema, type LaunchContext, type QuizDraft,
} from "../../../contracts/src/index.js";
import {
  buildMediaRegistration, buildMediaRevision, buildQuizRegistration, buildQuizRevision,
  DEFAULT_REPOSITORY, EXAMPLE_OBJECTS, MEDIA_PLAYERS, MEDIA_PLAYER_PACKAGES, nextMinorSemver, QUIZ_PLAYER, QUIZ_PLAYER_PACKAGE,
} from "./shared.js";
import type {
  AnyContent, AnyMediaDraft, CatalogueStore, LaunchContextRevision, LearningObjectRow, MediaKind, ObjectContentRevision, ObjectLifecycleStatus,
  ObjectMetadataPatch, ObjectDeletion, ObjectRegistration, ObjectVersionRow, PackageVersionRow, RegisteredMedia, RegisteredQuiz, Repository,
} from "./types.js";

const CONTENT_SCHEMAS = { video: videoContentSchema, document: documentContentSchema, audio: audioContentSchema } as const;
/** Parses a stored payload against whichever schema its content_profile names — quiz included. */
function parseContent(contentProfile: string | null | undefined, payload: unknown): AnyContent | undefined {
  const schema = contentProfile === "video-json-v1" ? CONTENT_SCHEMAS.video
    : contentProfile === "document-json-v1" ? CONTENT_SCHEMAS.document
    : contentProfile === "audio-json-v1" ? CONTENT_SCHEMAS.audio
    : quizContentSchema; // covers 'quiz-json-v1' and legacy rows written before content_profile was stored on this table
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

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
    marketplace_listed: !!row.marketplace_listed,
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

  async learningObjects(filter: { repository_id?: string; status?: LearningObjectRow["status"]; marketplace_listed?: boolean } = {}): Promise<LearningObjectRow[]> {
    const values: unknown[] = [];
    const clauses: string[] = ["active_package_version_id is not null"];
    if (filter.repository_id) { values.push(filter.repository_id.toLowerCase()); clauses.push(`lower(repository_id::text) = $${values.length}`); }
    if (filter.status) { values.push(filter.status); clauses.push(`status = $${values.length}`); }
    if (filter.marketplace_listed !== undefined) { values.push(filter.marketplace_listed); clauses.push(`marketplace_listed = $${values.length}`); }
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

  async objectVersions(objectId: string): Promise<ObjectVersionRow[]> {
    const result = await this.pool.query(
      "select * from object_version where lower(object_id::text) = $1 order by coalesce(published_at, created_at) desc",
      [objectId.toLowerCase()],
    );
    return result.rows.map((row) => ({ ...row, published_at: row.published_at ? iso(row.published_at) : null }));
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

  async content(objectId: string): Promise<AnyContent | undefined> {
    const result = await this.pool.query("select content_profile, payload from learning_object_content where lower(object_id::text) = $1", [objectId.toLowerCase()]);
    if (!result.rows[0]) return undefined;
    return parseContent(result.rows[0].content_profile, result.rows[0].payload);
  }

  async contentRevision(objectId: string, contentVersion: string): Promise<AnyContent | undefined> {
    const result = await this.pool.query(
      "select content_profile, payload from learning_object_content_version where lower(object_id::text) = $1 and content_version = $2",
      [objectId.toLowerCase(), contentVersion],
    );
    if (!result.rows[0]) return undefined;
    return parseContent(result.rows[0].content_profile, result.rows[0].payload);
  }

  async contentForObjectVersion(objectId: string, objectVersionId: string): Promise<AnyContent | undefined> {
    const version = await this.objectVersion(objectVersionId);
    if (!version || version.object_id.toLowerCase() !== objectId.toLowerCase()) return undefined;
    const pinned = version.content_version ? await this.contentRevision(objectId, version.content_version) : undefined;
    return pinned ?? this.content(objectId);
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
    const superseded = await this.objectVersion(existing.active_object_version_id);
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
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at, launch_context)
         values ($1,$2,$3,$4,'PUBLISHED', now(), $5)`,
        [object_version_id, existing.object_id, input.semver, package_version_id,
         superseded?.launch_context ? JSON.stringify(superseded.launch_context) : null],
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

  /**
   * Edits the catalogue entry, and only the catalogue entry.
   *
   * The column list is fixed here rather than assembled from the caller's keys: an update whose
   * columns come from a request body is one careless spread away from letting a title edit rewrite
   * `active_package_version_id`, which is the pointer a launch resolves through.
   */
  async updateObject(objectId: string, patch: ObjectMetadataPatch): Promise<LearningObjectRow | undefined> {
    const result = await this.pool.query(
      `update learning_object set
         title = coalesce($2, title),
         description = coalesce($3, description),
         duration = coalesce($4, duration),
         kind = coalesce($5, kind),
         updated_at = now()
       where lower(object_id::text) = $1 returning *`,
      [objectId.toLowerCase(), patch.title ?? null, patch.description ?? null, patch.duration ?? null, patch.kind ?? null],
    );
    return result.rows[0] ? toObject(result.rows[0]) : undefined;
  }

  async setObjectStatus(objectId: string, status: ObjectLifecycleStatus): Promise<LearningObjectRow | undefined> {
    const result = await this.pool.query(
      `update learning_object set status = $2,
         retired_at = case when $2 = 'RETIRED' then now() else null end,
         updated_at = now()
       where lower(object_id::text) = $1 returning *`,
      [objectId.toLowerCase(), status],
    );
    return result.rows[0] ? toObject(result.rows[0]) : undefined;
  }

  async retireObject(objectId: string): Promise<LearningObjectRow | undefined> {
    return this.setObjectStatus(objectId, "RETIRED");
  }

  async setMarketplaceListed(objectId: string, listed: boolean): Promise<LearningObjectRow | undefined> {
    const result = await this.pool.query(
      "update learning_object set marketplace_listed = $2, updated_at = now() where lower(object_id::text) = $1 returning *",
      [objectId.toLowerCase(), listed],
    );
    return result.rows[0] ? toObject(result.rows[0]) : undefined;
  }

  /**
   * Removes the object and the rows that exist only to describe it.
   *
   * Everything that decides whether the deletion may happen is done here rather than by the caller,
   * under `for update` on the object row and inside the transaction that does the deleting. A check
   * made before the transaction is a check of the past: migration 007 deliberately dropped the
   * foreign key from `attempt` to `package_version` so that an attempt survives whatever happens to
   * the catalogue, which means nothing underneath this stops a launch that lands between the check
   * and the delete. Refusing an object that is still deliverable closes the same race from the other
   * end — a launch resolves a PUBLISHED object only, so an object that has already been withdrawn
   * cannot acquire a new attempt while this runs.
   *
   * `class_assignment` is read as well as the runtime `assignment` table. They are different tables
   * written by different surfaces — a teacher assigning work to a class writes the first, an agent
   * or internal batch the second — and an object deleted out from under either leaves a roster
   * pointing at nothing.
   */
  async deleteObject(objectId: string): Promise<ObjectDeletion> {
    const id = objectId.toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query(
        "select object_id, status from learning_object where lower(object_id::text) = $1 for update",
        [id],
      );
      if (!existing.rows[0]) {
        await client.query("rollback");
        return "NOT_FOUND";
      }
      const realId = existing.rows[0].object_id;
      if (!["SUSPENDED", "RETIRED"].includes(existing.rows[0].status)) {
        await client.query("rollback");
        return "STATE_INVALID";
      }
      const inUse = await client.query(
        `select 1 from attempt where object_id = $1
         union all select 1 from assignment where object_id = $1
         union all select 1 from class_assignment where object_id = $1
         limit 1`,
        [realId],
      );
      if (inUse.rowCount) {
        await client.query("rollback");
        return "IN_USE";
      }
      await client.query("delete from learning_object_content_version where object_id = $1", [realId]);
      await client.query("delete from learning_object_content where object_id = $1", [realId]);
      await client.query("delete from object_version where object_id = $1", [realId]);
      await client.query("delete from smart_link where object_id = $1", [realId]);
      await client.query("delete from package_version where object_id = $1", [realId]);
      // A bookmark is a discovery record, not evidence — unlike attempt/assignment/class_assignment
      // above, its presence never refuses this delete, and it does not survive the object it points
      // at. Left alone, learning_object's default ON DELETE RESTRICT foreign key would turn a delete
      // of any object someone had merely bookmarked into an uncaught database error.
      await client.query("delete from marketplace_import where object_id = $1", [realId]);
      await client.query("delete from learning_object where object_id = $1", [realId]);
      await client.query("commit");
      return "DELETED";
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reviseQuizContent(objectId: string, draft: QuizDraft): Promise<ObjectContentRevision | undefined> {
    const object = await this.learningObject(objectId);
    if (!object || object.content_profile !== "quiz-json-v1") return undefined;
    const previous = await this.content(object.object_id);
    const versions = await this.objectVersions(object.object_id);
    const supersededContext = versions.find((row) => row.object_version_id === object.active_object_version_id)?.launch_context ?? null;
    const built = buildQuizRevision(object, draft, previous?.content_version, versions.map((row) => row.semver));
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("update object_version set status = 'SUPERSEDED' where object_id = $1 and status = 'PUBLISHED'", [object.object_id]);
      await client.query(
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at, content_version, launch_context)
         values ($1,$2,$3,$4,'PUBLISHED', now(), $5, $6)`,
        [built.revision.object_version_id, object.object_id, built.revision.semver,
         QUIZ_PLAYER.package_version_id, built.content.content_version,
         supersededContext ? JSON.stringify(supersededContext) : null],
      );
      await client.query(
        `insert into learning_object_content_version (object_id, content_profile, content_version, payload)
         values ($1,'quiz-json-v1',$2,$3) on conflict (object_id, content_version) do nothing`,
        [object.object_id, built.content.content_version, JSON.stringify(built.content)],
      );
      await client.query(
        `insert into learning_object_content (object_id, content_profile, content_version, payload)
         values ($1,'quiz-json-v1',$2,$3)
         on conflict (object_id) do update set content_version = excluded.content_version,
           payload = excluded.payload, updated_at = now()`,
        [object.object_id, built.content.content_version, JSON.stringify(built.content)],
      );
      await client.query(
        `update learning_object set active_object_version_id = $2, title = $3, description = $4,
           duration = $5, updated_at = now() where object_id = $1`,
        [object.object_id, built.revision.object_version_id, built.objectPatch.title,
         built.objectPatch.description, built.objectPatch.duration],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return built.revision;
  }

  async reviseMediaContent(objectId: string, kind: MediaKind, draft: AnyMediaDraft): Promise<ObjectContentRevision | undefined> {
    const object = await this.learningObject(objectId);
    if (!object || object.content_profile !== MEDIA_PLAYERS[kind].content_profile) return undefined;
    const previous = await this.content(object.object_id);
    const versions = await this.objectVersions(object.object_id);
    const supersededContext = versions.find((row) => row.object_version_id === object.active_object_version_id)?.launch_context ?? null;
    const built = buildMediaRevision(kind, object, draft, previous?.content_version, versions.map((row) => row.semver));
    const contentProfile = MEDIA_PLAYERS[kind].content_profile;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("update object_version set status = 'SUPERSEDED' where object_id = $1 and status = 'PUBLISHED'", [object.object_id]);
      await client.query(
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at, content_version, launch_context)
         values ($1,$2,$3,$4,'PUBLISHED', now(), $5, $6)`,
        [built.revision.object_version_id, object.object_id, built.revision.semver,
         MEDIA_PLAYERS[kind].package_version_id, built.content.content_version,
         supersededContext ? JSON.stringify(supersededContext) : null],
      );
      await client.query(
        `insert into learning_object_content_version (object_id, content_profile, content_version, payload)
         values ($1,$2,$3,$4) on conflict (object_id, content_version) do nothing`,
        [object.object_id, contentProfile, built.content.content_version, JSON.stringify(built.content)],
      );
      await client.query(
        `insert into learning_object_content (object_id, content_profile, content_version, payload)
         values ($1,$2,$3,$4)
         on conflict (object_id) do update set content_version = excluded.content_version,
           payload = excluded.payload, updated_at = now()`,
        [object.object_id, contentProfile, built.content.content_version, JSON.stringify(built.content)],
      );
      await client.query(
        `update learning_object set active_object_version_id = $2, title = $3, description = $4,
           duration = $5, updated_at = now() where object_id = $1`,
        [object.object_id, built.revision.object_version_id, built.objectPatch.title,
         built.objectPatch.description, built.objectPatch.duration],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return built.revision;
  }

  async setLaunchContext(objectId: string, context: LaunchContext | null): Promise<LaunchContextRevision | undefined> {
    const object = await this.learningObject(objectId);
    if (!object) return undefined;
    const active = await this.objectVersion(object.active_object_version_id);
    if (!active) return undefined;
    const object_version_id = randomUUID();
    const semver = nextMinorSemver((await this.objectVersions(object.object_id)).map((row) => row.semver));
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("update object_version set status = 'SUPERSEDED' where object_id = $1 and status = 'PUBLISHED'", [object.object_id]);
      await client.query(
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at, content_version, launch_context)
         values ($1,$2,$3,$4,'PUBLISHED', now(), $5, $6)`,
        [object_version_id, object.object_id, semver, active.package_version_id,
         active.content_version ?? null, context ? JSON.stringify(context) : null],
      );
      await client.query(
        "update learning_object set active_object_version_id = $2, updated_at = now() where object_id = $1",
        [object.object_id, object_version_id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { object_id: object.object_id, object_version_id, semver, launch_context: context };
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
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at, content_version)
         values ($1,$2,$3,$4,'PUBLISHED', now(), $5)`,
        [built.object.active_object_version_id, built.object.object_id, built.objectVersionSemver,
         QUIZ_PLAYER.package_version_id, built.content.content_version],
      );
      await client.query(
        `insert into learning_object_content (object_id, content_profile, content_version, payload)
         values ($1,'quiz-json-v1',$2,$3)`,
        [built.object.object_id, built.content.content_version, JSON.stringify(built.content)],
      );
      await client.query(
        `insert into learning_object_content_version (object_id, content_profile, content_version, payload)
         values ($1,'quiz-json-v1',$2,$3) on conflict (object_id, content_version) do nothing`,
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

  async registerMedia(kind: MediaKind, draft: AnyMediaDraft, options: { repository_id?: string; authored_by?: string } = {}): Promise<RegisteredMedia> {
    await this.ensureSharedPlayer();
    const repositoryId = options.repository_id ?? (await this.defaultRepository())?.repository_id;
    if (!repositoryId) throw new Error("NO_ACTIVE_REPOSITORY");
    const built = buildMediaRegistration(kind, draft, repositoryId, options.authored_by);
    const player = MEDIA_PLAYERS[kind];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into learning_object (object_id, repository_id, active_object_version_id, active_package_version_id,
           status, title, description, duration, kind, module_path, content_profile, authored_by, created_at)
         values ($1,$2,$3,$4,'PUBLISHED',$5,$6,$7,$8,$9,$10,$11,$12)`,
        [built.object.object_id, repositoryId, built.object.active_object_version_id, player.package_version_id,
         built.object.title, built.object.description, built.object.duration, built.object.kind,
         built.object.module_path, player.content_profile, built.object.authored_by ?? null, built.object.created_at],
      );
      await client.query(
        `insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at, content_version)
         values ($1,$2,$3,$4,'PUBLISHED', now(), $5)`,
        [built.object.active_object_version_id, built.object.object_id, built.objectVersionSemver,
         player.package_version_id, built.content.content_version],
      );
      await client.query(
        `insert into learning_object_content (object_id, content_profile, content_version, payload)
         values ($1,$2,$3,$4)`,
        [built.object.object_id, player.content_profile, built.content.content_version, JSON.stringify(built.content)],
      );
      await client.query(
        `insert into learning_object_content_version (object_id, content_profile, content_version, payload)
         values ($1,$2,$3,$4) on conflict (object_id, content_version) do nothing`,
        [built.object.object_id, player.content_profile, built.content.content_version, JSON.stringify(built.content)],
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
    for (const kind of Object.keys(MEDIA_PLAYERS) as MediaKind[]) {
      const player = MEDIA_PLAYERS[kind];
      await this.pool.query(
        `insert into package_version (package_version_id, package_id, object_id, semver, sha256, delivery_profile,
           entry_point, module_path, status, published_at, shared_player)
         values ($1,$2,null,$3,$4,'native-web-package',$5,$5,'PUBLISHED',$6,true)
         on conflict (package_version_id) do nothing`,
        [player.package_version_id, player.package_id, player.semver, player.sha256,
         player.module_path, MEDIA_PLAYER_PACKAGES[kind].published_at],
      );
    }
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
