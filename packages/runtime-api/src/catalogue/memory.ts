/**
 * In-process catalogue, for the test suites and for `pnpm dev` without a database.
 */
import { randomUUID } from "node:crypto";
import type { ExternalEmbedDraft, LaunchContext, LtiToolDraft, QuizDraft } from "../../../contracts/src/index.js";
import {
  buildExternalEmbedRegistration, buildLtiToolRegistration, buildMediaRegistration, buildMediaRevision, buildQuizRegistration, buildQuizRevision,
  DEFAULT_REPOSITORY, EXAMPLE_OBJECTS, EXTERNAL_EMBED_PLAYER, EXTERNAL_EMBED_PLAYER_PACKAGE, LTI_PLAYER, LTI_PLAYER_PACKAGE, MEDIA_PLAYERS, MEDIA_PLAYER_PACKAGES,
  nextMinorSemver, QUIZ_PLAYER, QUIZ_PLAYER_PACKAGE,
} from "./shared.js";
import type {
  AnyContent, AnyMediaDraft, CatalogueStore, LaunchContextRevision, LearningObjectRow, MarketplacePricing, MediaKind, ObjectContentRevision,
  ObjectDeletion, ObjectLifecycleStatus, ObjectMetadataPatch, ObjectRegistration, ObjectVersionRow, PackageVersionRow, RegisteredExternalEmbed, RegisteredLtiTool,
  RegisteredMedia, RegisteredQuiz, Repository,
} from "./types.js";

export class MemoryCatalogueStore implements CatalogueStore {
  readonly kind = "memory" as const;
  private readonly repositoriesById = new Map<string, Repository>();
  private readonly objects = new Map<string, LearningObjectRow>();
  private readonly versions = new Map<string, ObjectVersionRow>();
  private readonly packages = new Map<string, PackageVersionRow>();
  private readonly contents = new Map<string, AnyContent>();
  /** Every content version ever written, keyed `objectId:contentVersion`. Nothing here is overwritten. */
  private readonly contentHistory = new Map<string, AnyContent>();

  constructor(options: { seedExamples?: boolean } = {}) {
    this.reset(options.seedExamples ?? true);
  }

  /**
   * Test seam. The in-memory catalogue seeds the bundled examples by default so the suites have
   * content to launch; a deployed environment seeds nothing unless the operator asks for it.
   */
  reset(seedExamples = true): void {
    this.repositoriesById.clear();
    this.objects.clear();
    this.versions.clear();
    this.packages.clear();
    this.contents.clear();
    this.contentHistory.clear();
    this.repositoriesById.set(DEFAULT_REPOSITORY.repository_id, {
      ...DEFAULT_REPOSITORY,
      status: "ACTIVE",
      created_at: "2026-08-12T09:14:00.000Z",
    });
    this.packages.set(QUIZ_PLAYER_PACKAGE.package_version_id, { ...QUIZ_PLAYER_PACKAGE });
    this.packages.set(LTI_PLAYER_PACKAGE.package_version_id, { ...LTI_PLAYER_PACKAGE });
    this.packages.set(EXTERNAL_EMBED_PLAYER_PACKAGE.package_version_id, { ...EXTERNAL_EMBED_PLAYER_PACKAGE });
    for (const kind of Object.keys(MEDIA_PLAYER_PACKAGES) as MediaKind[]) {
      this.packages.set(MEDIA_PLAYER_PACKAGES[kind].package_version_id, { ...MEDIA_PLAYER_PACKAGES[kind] });
    }
    if (!seedExamples) return;
    for (const example of EXAMPLE_OBJECTS) {
      this.objects.set(example.object.object_id, { ...example.object });
      this.packages.set(example.package.package_version_id, { ...example.package });
      this.versions.set(example.object.active_object_version_id, {
        object_version_id: example.object.active_object_version_id,
        object_id: example.object.object_id,
        semver: example.package.semver,
        package_version_id: example.package.package_version_id,
        status: "PUBLISHED",
        published_at: example.package.published_at,
      });
    }
  }

  /**
   * Test seam: a deployed repository is created through the admin surface
   * (routes/admin/repositories.ts); suites that need a second course add it here.
   */
  async addRepository(repository: { repository_id: string; slug: string; display_name: string }): Promise<void> {
    this.repositoriesById.set(repository.repository_id.toLowerCase(), {
      ...repository,
      status: "ACTIVE",
      created_at: new Date().toISOString(),
    });
  }

  async repositories(): Promise<Repository[]> {
    return [...this.repositoriesById.values()];
  }

  async repository(repositoryId: string): Promise<Repository | undefined> {
    return this.repositoriesById.get(repositoryId.toLowerCase());
  }

  async defaultRepository(): Promise<Repository | undefined> {
    return this.repositoriesById.get(DEFAULT_REPOSITORY.repository_id) ?? [...this.repositoriesById.values()][0];
  }

  async learningObjects(filter: { repository_id?: string; status?: LearningObjectRow["status"]; marketplace_listed?: boolean } = {}): Promise<LearningObjectRow[]> {
    return [...this.objects.values()]
      .filter((row) => !filter.repository_id || row.repository_id.toLowerCase() === filter.repository_id.toLowerCase())
      .filter((row) => !filter.status || row.status === filter.status)
      .filter((row) => filter.marketplace_listed === undefined || !!row.marketplace_listed === filter.marketplace_listed)
      .map((row) => ({ ...row }));
  }

  async learningObject(objectId: string): Promise<LearningObjectRow | undefined> {
    const row = this.objects.get(objectId.toLowerCase());
    return row ? { ...row } : undefined;
  }

  async objectVersion(objectVersionId: string): Promise<ObjectVersionRow | undefined> {
    return this.versions.get(objectVersionId.toLowerCase());
  }

  async objectVersions(objectId: string): Promise<ObjectVersionRow[]> {
    return [...this.versions.values()]
      .filter((row) => row.object_id.toLowerCase() === objectId.toLowerCase())
      .map((row) => ({ ...row }))
      .sort((a, b) => String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")));
  }

  async packageVersions(filter: { object_id?: string } = {}): Promise<PackageVersionRow[]> {
    return [...this.packages.values()]
      .filter((row) => !filter.object_id || row.object_id?.toLowerCase() === filter.object_id.toLowerCase())
      .map((row) => ({ ...row }));
  }

  async packageVersion(packageVersionId: string): Promise<PackageVersionRow | undefined> {
    const row = this.packages.get(packageVersionId.toLowerCase());
    return row ? { ...row } : undefined;
  }

  async content(objectId: string): Promise<AnyContent | undefined> {
    return this.contents.get(objectId.toLowerCase());
  }

  async contentRevision(objectId: string, contentVersion: string): Promise<AnyContent | undefined> {
    return this.contentHistory.get(`${objectId.toLowerCase()}:${contentVersion}`);
  }

  async contentForObjectVersion(objectId: string, objectVersionId: string): Promise<AnyContent | undefined> {
    const version = this.versions.get(objectVersionId.toLowerCase());
    if (!version || version.object_id.toLowerCase() !== objectId.toLowerCase()) return undefined;
    const pinned = version.content_version ? await this.contentRevision(objectId, version.content_version) : undefined;
    return pinned ?? this.content(objectId);
  }

  async registerObject(registration: ObjectRegistration): Promise<LearningObjectRow> {
    const object_id = randomUUID();
    const object_version_id = randomUUID();
    const package_version_id = randomUUID();
    const created_at = new Date().toISOString();
    this.packages.set(package_version_id, {
      package_version_id,
      object_id,
      semver: registration.semver,
      sha256: registration.sha256,
      delivery_profile: "native-web-package",
      status: "PUBLISHED",
      published_at: created_at,
      module_path: registration.module_path,
    });
    this.versions.set(object_version_id, {
      object_version_id, object_id, semver: registration.semver, package_version_id,
      status: "PUBLISHED", published_at: created_at,
    });
    const row: LearningObjectRow = {
      object_id,
      repository_id: registration.repository_id,
      status: "PUBLISHED",
      active_object_version_id: object_version_id,
      active_package_version_id: package_version_id,
      created_at,
      title: registration.title,
      description: registration.description ?? "",
      duration: registration.duration ?? "",
      kind: registration.kind ?? "native-web-package",
      module_path: registration.module_path,
      ...(registration.authored_by ? { authored_by: registration.authored_by } : {}),
    };
    this.objects.set(object_id, row);
    return { ...row };
  }

  async publishObjectVersion(objectId: string, input: { semver: string; module_path: string; sha256: string }): Promise<LearningObjectRow | undefined> {
    const object = this.objects.get(objectId.toLowerCase());
    if (!object) return undefined;
    const previous = this.versions.get(object.active_object_version_id);
    if (previous) previous.status = "SUPERSEDED";
    const object_version_id = randomUUID();
    const package_version_id = randomUUID();
    const published_at = new Date().toISOString();
    this.packages.set(package_version_id, {
      package_version_id, object_id: object.object_id, semver: input.semver, sha256: input.sha256,
      delivery_profile: "native-web-package", status: "PUBLISHED", published_at, module_path: input.module_path,
    });
    this.versions.set(object_version_id, {
      object_version_id, object_id: object.object_id, semver: input.semver, package_version_id,
      status: "PUBLISHED", published_at,
      launch_context: previous?.launch_context ?? null,
    });
    object.active_object_version_id = object_version_id;
    object.active_package_version_id = package_version_id;
    object.module_path = input.module_path;
    return { ...object };
  }

  async updateObject(objectId: string, patch: ObjectMetadataPatch): Promise<LearningObjectRow | undefined> {
    const object = this.objects.get(objectId.toLowerCase());
    if (!object) return undefined;
    for (const key of ["title", "description", "duration", "kind"] as const) {
      const value = patch[key];
      if (value !== undefined) object[key] = value;
    }
    return { ...object };
  }

  async setObjectStatus(objectId: string, status: ObjectLifecycleStatus): Promise<LearningObjectRow | undefined> {
    const object = this.objects.get(objectId.toLowerCase());
    if (!object) return undefined;
    object.status = status;
    return { ...object };
  }

  async retireObject(objectId: string): Promise<LearningObjectRow | undefined> {
    return this.setObjectStatus(objectId, "RETIRED");
  }

  async setMarketplaceListed(objectId: string, listed: boolean, pricing?: MarketplacePricing): Promise<LearningObjectRow | undefined> {
    const object = this.objects.get(objectId.toLowerCase());
    if (!object) return undefined;
    object.marketplace_listed = listed;
    if (pricing) {
      object.marketplace_price_cents = pricing.price_cents;
      object.marketplace_currency = pricing.currency;
      object.marketplace_billing_period = pricing.billing_period;
    }
    return { ...object };
  }

  /**
   * The in-process catalogue holds no attempts and no rosters, so it can enforce only the half of
   * the contract it can see: an object that is still deliverable is refused, and the caller checks
   * use against the runtime store it does hold.
   */
  async deleteObject(objectId: string): Promise<ObjectDeletion> {
    const id = objectId.toLowerCase();
    const object = this.objects.get(id);
    if (!object) return "NOT_FOUND";
    if (!["SUSPENDED", "RETIRED"].includes(object.status)) return "STATE_INVALID";
    this.objects.delete(id);
    this.contents.delete(id);
    for (const key of [...this.contentHistory.keys()]) if (key.startsWith(`${id}:`)) this.contentHistory.delete(key);
    for (const [key, row] of [...this.versions]) if (row.object_id.toLowerCase() === id) this.versions.delete(key);
    // The shared quiz player belongs to no object and outlives every one of them.
    for (const [key, row] of [...this.packages]) if (row.object_id?.toLowerCase() === id) this.packages.delete(key);
    return "DELETED";
  }

  async reviseQuizContent(objectId: string, draft: QuizDraft): Promise<ObjectContentRevision | undefined> {
    const object = this.objects.get(objectId.toLowerCase());
    if (!object || object.content_profile !== "quiz-json-v1") return undefined;
    const previous = this.contents.get(objectId.toLowerCase());
    const versions = await this.objectVersions(object.object_id);
    const built = buildQuizRevision(object, draft, previous?.content_version, versions.map((row) => row.semver));
    const superseded = this.versions.get(object.active_object_version_id);
    if (superseded) superseded.status = "SUPERSEDED";
    this.versions.set(built.revision.object_version_id, {
      object_version_id: built.revision.object_version_id,
      object_id: object.object_id,
      semver: built.revision.semver,
      package_version_id: QUIZ_PLAYER.package_version_id,
      status: "PUBLISHED",
      published_at: built.content.created_at,
      content_version: built.content.content_version,
      launch_context: superseded?.launch_context ?? null,
    });
    this.contents.set(object.object_id, built.content);
    this.contentHistory.set(`${object.object_id}:${built.content.content_version}`, built.content);
    object.active_object_version_id = built.revision.object_version_id;
    object.title = built.objectPatch.title;
    object.description = built.objectPatch.description;
    object.duration = built.objectPatch.duration;
    return built.revision;
  }

  async setLaunchContext(objectId: string, context: LaunchContext | null): Promise<LaunchContextRevision | undefined> {
    const object = this.objects.get(objectId.toLowerCase());
    if (!object) return undefined;
    const active = this.versions.get(object.active_object_version_id);
    if (!active) return undefined;
    const object_version_id = randomUUID();
    const semver = nextMinorSemver((await this.objectVersions(object.object_id)).map((row) => row.semver));
    active.status = "SUPERSEDED";
    this.versions.set(object_version_id, {
      object_version_id,
      object_id: object.object_id,
      semver,
      package_version_id: active.package_version_id,
      status: "PUBLISHED",
      published_at: new Date().toISOString(),
      content_version: active.content_version ?? null,
      launch_context: context,
    });
    object.active_object_version_id = object_version_id;
    return { object_id: object.object_id, object_version_id, semver, launch_context: context };
  }

  async registerQuiz(draft: QuizDraft, options: { repository_id?: string; authored_by?: string } = {}): Promise<RegisteredQuiz> {
    const repositoryId = options.repository_id ?? (await this.defaultRepository())?.repository_id ?? DEFAULT_REPOSITORY.repository_id;
    const built = buildQuizRegistration(draft, repositoryId, options.authored_by);
    this.objects.set(built.object.object_id, built.object);
    this.contents.set(built.object.object_id, built.content);
    this.contentHistory.set(`${built.object.object_id}:${built.content.content_version}`, built.content);
    this.versions.set(built.object.active_object_version_id, {
      object_version_id: built.object.active_object_version_id,
      object_id: built.object.object_id,
      semver: built.objectVersionSemver,
      package_version_id: QUIZ_PLAYER.package_version_id,
      status: "PUBLISHED",
      published_at: built.object.created_at,
      content_version: built.content.content_version,
    });
    return built.registered;
  }

  async registerMedia(kind: MediaKind, draft: AnyMediaDraft, options: { repository_id?: string; authored_by?: string } = {}): Promise<RegisteredMedia> {
    const repositoryId = options.repository_id ?? (await this.defaultRepository())?.repository_id ?? DEFAULT_REPOSITORY.repository_id;
    const built = buildMediaRegistration(kind, draft, repositoryId, options.authored_by);
    this.objects.set(built.object.object_id, built.object);
    this.contents.set(built.object.object_id, built.content);
    this.contentHistory.set(`${built.object.object_id}:${built.content.content_version}`, built.content);
    this.versions.set(built.object.active_object_version_id, {
      object_version_id: built.object.active_object_version_id,
      object_id: built.object.object_id,
      semver: built.objectVersionSemver,
      package_version_id: MEDIA_PLAYERS[kind].package_version_id,
      status: "PUBLISHED",
      published_at: built.object.created_at,
      content_version: built.content.content_version,
    });
    return built.registered;
  }

  async registerLtiTool(draft: LtiToolDraft, options: { repository_id?: string; authored_by?: string } = {}): Promise<RegisteredLtiTool> {
    const repositoryId = options.repository_id ?? (await this.defaultRepository())?.repository_id ?? DEFAULT_REPOSITORY.repository_id;
    const built = buildLtiToolRegistration(draft, repositoryId, options.authored_by);
    this.objects.set(built.object.object_id, built.object);
    this.contents.set(built.object.object_id, built.content);
    this.contentHistory.set(`${built.object.object_id}:${built.content.content_version}`, built.content);
    this.versions.set(built.object.active_object_version_id, {
      object_version_id: built.object.active_object_version_id,
      object_id: built.object.object_id,
      semver: built.objectVersionSemver,
      package_version_id: LTI_PLAYER.package_version_id,
      status: "PUBLISHED",
      published_at: built.object.created_at,
      content_version: built.content.content_version,
    });
    return built.registered;
  }

  async learningObjectByLtiClient(clientId: string, deploymentId: string): Promise<LearningObjectRow | undefined> {
    const row = [...this.objects.values()].find(
      (candidate) =>
        candidate.lti_client_id === clientId &&
        candidate.lti_deployment_id === deploymentId &&
        candidate.status === "PUBLISHED" &&
        candidate.content_profile === "lti-tool-v1",
    );
    return row ? { ...row } : undefined;
  }

  async registerExternalEmbed(draft: ExternalEmbedDraft, options: { repository_id?: string; authored_by?: string } = {}): Promise<RegisteredExternalEmbed> {
    const repositoryId = options.repository_id ?? (await this.defaultRepository())?.repository_id ?? DEFAULT_REPOSITORY.repository_id;
    const built = buildExternalEmbedRegistration(draft, repositoryId, options.authored_by);
    this.objects.set(built.object.object_id, built.object);
    this.contents.set(built.object.object_id, built.content);
    this.contentHistory.set(`${built.object.object_id}:${built.content.content_version}`, built.content);
    this.versions.set(built.object.active_object_version_id, {
      object_version_id: built.object.active_object_version_id,
      object_id: built.object.object_id,
      semver: built.objectVersionSemver,
      package_version_id: EXTERNAL_EMBED_PLAYER.package_version_id,
      status: "PUBLISHED",
      published_at: built.object.created_at,
      content_version: built.content.content_version,
    });
    return built.registered;
  }

  async reviseMediaContent(objectId: string, kind: MediaKind, draft: AnyMediaDraft): Promise<ObjectContentRevision | undefined> {
    const object = this.objects.get(objectId.toLowerCase());
    if (!object || object.content_profile !== MEDIA_PLAYERS[kind].content_profile) return undefined;
    const previous = this.contents.get(objectId.toLowerCase());
    const versions = await this.objectVersions(object.object_id);
    const built = buildMediaRevision(kind, object, draft, previous?.content_version, versions.map((row) => row.semver));
    const superseded = this.versions.get(object.active_object_version_id);
    if (superseded) superseded.status = "SUPERSEDED";
    this.versions.set(built.revision.object_version_id, {
      object_version_id: built.revision.object_version_id,
      object_id: object.object_id,
      semver: built.revision.semver,
      package_version_id: MEDIA_PLAYERS[kind].package_version_id,
      status: "PUBLISHED",
      published_at: built.content.created_at,
      content_version: built.content.content_version,
      launch_context: superseded?.launch_context ?? null,
    });
    this.contents.set(object.object_id, built.content);
    this.contentHistory.set(`${object.object_id}:${built.content.content_version}`, built.content);
    object.active_object_version_id = built.revision.object_version_id;
    object.title = built.objectPatch.title;
    object.description = built.objectPatch.description;
    object.duration = built.objectPatch.duration;
    return built.revision;
  }

  async ensureSharedPlayer(): Promise<void> {
    if (!this.packages.has(QUIZ_PLAYER_PACKAGE.package_version_id)) {
      this.packages.set(QUIZ_PLAYER_PACKAGE.package_version_id, { ...QUIZ_PLAYER_PACKAGE });
    }
    if (!this.packages.has(LTI_PLAYER_PACKAGE.package_version_id)) {
      this.packages.set(LTI_PLAYER_PACKAGE.package_version_id, { ...LTI_PLAYER_PACKAGE });
    }
    if (!this.packages.has(EXTERNAL_EMBED_PLAYER_PACKAGE.package_version_id)) {
      this.packages.set(EXTERNAL_EMBED_PLAYER_PACKAGE.package_version_id, { ...EXTERNAL_EMBED_PLAYER_PACKAGE });
    }
    for (const kind of Object.keys(MEDIA_PLAYER_PACKAGES) as MediaKind[]) {
      if (!this.packages.has(MEDIA_PLAYER_PACKAGES[kind].package_version_id)) {
        this.packages.set(MEDIA_PLAYER_PACKAGES[kind].package_version_id, { ...MEDIA_PLAYER_PACKAGES[kind] });
      }
    }
  }
}
