/**
 * In-process catalogue, for the test suites and for `pnpm dev` without a database.
 */
import { randomUUID } from "node:crypto";
import type { QuizContent, QuizDraft } from "../../../contracts/src/index.js";
import { buildQuizRegistration, DEFAULT_REPOSITORY, EXAMPLE_OBJECTS, QUIZ_PLAYER, QUIZ_PLAYER_PACKAGE } from "./shared.js";
import type {
  CatalogueStore, LearningObjectRow, ObjectRegistration, ObjectVersionRow, PackageVersionRow,
  RegisteredQuiz, Repository,
} from "./types.js";

export class MemoryCatalogueStore implements CatalogueStore {
  readonly kind = "memory" as const;
  private readonly repositoriesById = new Map<string, Repository>();
  private readonly objects = new Map<string, LearningObjectRow>();
  private readonly objectVersions = new Map<string, ObjectVersionRow>();
  private readonly packages = new Map<string, PackageVersionRow>();
  private readonly contents = new Map<string, QuizContent>();

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
    this.objectVersions.clear();
    this.packages.clear();
    this.contents.clear();
    this.repositoriesById.set(DEFAULT_REPOSITORY.repository_id, {
      ...DEFAULT_REPOSITORY,
      status: "ACTIVE",
      created_at: "2026-08-12T09:14:00.000Z",
    });
    this.packages.set(QUIZ_PLAYER_PACKAGE.package_version_id, { ...QUIZ_PLAYER_PACKAGE });
    if (!seedExamples) return;
    for (const example of EXAMPLE_OBJECTS) {
      this.objects.set(example.object.object_id, { ...example.object });
      this.packages.set(example.package.package_version_id, { ...example.package });
      this.objectVersions.set(example.object.active_object_version_id, {
        object_version_id: example.object.active_object_version_id,
        object_id: example.object.object_id,
        semver: example.package.semver,
        package_version_id: example.package.package_version_id,
        status: "PUBLISHED",
        published_at: example.package.published_at,
      });
    }
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

  async learningObjects(filter: { repository_id?: string; status?: LearningObjectRow["status"] } = {}): Promise<LearningObjectRow[]> {
    return [...this.objects.values()]
      .filter((row) => !filter.repository_id || row.repository_id.toLowerCase() === filter.repository_id.toLowerCase())
      .filter((row) => !filter.status || row.status === filter.status)
      .map((row) => ({ ...row }));
  }

  async learningObject(objectId: string): Promise<LearningObjectRow | undefined> {
    const row = this.objects.get(objectId.toLowerCase());
    return row ? { ...row } : undefined;
  }

  async objectVersion(objectVersionId: string): Promise<ObjectVersionRow | undefined> {
    return this.objectVersions.get(objectVersionId.toLowerCase());
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

  async content(objectId: string): Promise<QuizContent | undefined> {
    return this.contents.get(objectId.toLowerCase());
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
    this.objectVersions.set(object_version_id, {
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
    const previous = this.objectVersions.get(object.active_object_version_id);
    if (previous) previous.status = "SUPERSEDED";
    const object_version_id = randomUUID();
    const package_version_id = randomUUID();
    const published_at = new Date().toISOString();
    this.packages.set(package_version_id, {
      package_version_id, object_id: object.object_id, semver: input.semver, sha256: input.sha256,
      delivery_profile: "native-web-package", status: "PUBLISHED", published_at, module_path: input.module_path,
    });
    this.objectVersions.set(object_version_id, {
      object_version_id, object_id: object.object_id, semver: input.semver, package_version_id,
      status: "PUBLISHED", published_at,
    });
    object.active_object_version_id = object_version_id;
    object.active_package_version_id = package_version_id;
    object.module_path = input.module_path;
    return { ...object };
  }

  async retireObject(objectId: string): Promise<LearningObjectRow | undefined> {
    const object = this.objects.get(objectId.toLowerCase());
    if (!object) return undefined;
    object.status = "RETIRED";
    return { ...object };
  }

  async registerQuiz(draft: QuizDraft, options: { repository_id?: string; authored_by?: string } = {}): Promise<RegisteredQuiz> {
    const repositoryId = options.repository_id ?? (await this.defaultRepository())?.repository_id ?? DEFAULT_REPOSITORY.repository_id;
    const built = buildQuizRegistration(draft, repositoryId, options.authored_by);
    this.objects.set(built.object.object_id, built.object);
    this.contents.set(built.object.object_id, built.content);
    this.objectVersions.set(built.object.active_object_version_id, {
      object_version_id: built.object.active_object_version_id,
      object_id: built.object.object_id,
      semver: built.objectVersionSemver,
      package_version_id: QUIZ_PLAYER.package_version_id,
      status: "PUBLISHED",
      published_at: built.object.created_at,
    });
    return built.registered;
  }

  async ensureSharedPlayer(): Promise<void> {
    if (!this.packages.has(QUIZ_PLAYER_PACKAGE.package_version_id)) {
      this.packages.set(QUIZ_PLAYER_PACKAGE.package_version_id, { ...QUIZ_PLAYER_PACKAGE });
    }
  }
}
