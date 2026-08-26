/**
 * The learning-object catalogue.
 *
 * Previously a module-level constant: three fixed objects, one fixed repository, and a Map that any
 * caller could mutate. Nothing an operator registered survived a restart, and the identifiers a
 * descriptor bound to were minted fresh on every launch, so no two attempts at the same content
 * agreed on what had been delivered.
 *
 * The catalogue is now a store with the same two backends as the runtime state, and object versions
 * are real rows: a descriptor binds to the version that was actually published.
 */
import type { QuizContent, QuizDraft } from "../../../contracts/src/index.js";

export interface Repository {
  repository_id: string;
  slug: string;
  display_name: string;
  status: "DRAFT" | "ACTIVE" | "SUSPENDED" | "RETIRING" | "RETIRED";
  created_at: string;
}

export interface LearningObjectRow {
  object_id: string;
  repository_id: string;
  status: "DRAFT" | "VALIDATING" | "PUBLISHED" | "SUPERSEDED" | "SUSPENDED" | "RETIRED";
  active_object_version_id: string;
  active_package_version_id: string;
  created_at: string;
  title: string;
  description: string;
  duration: string;
  kind: string;
  module_path: string;
  /** Present only on objects whose content is a JSON payload rather than bundled code. */
  content_profile?: "quiz-json-v1";
  /** Provenance, so an operator can see which objects an agent authored. */
  authored_by?: string;
}

export interface PackageVersionRow {
  package_version_id: string;
  /** null for a shared, reusable player package that many learning objects point at. */
  object_id: string | null;
  semver: string;
  sha256: string;
  delivery_profile: "native-web-package";
  status: "UPLOADED" | "VALIDATING" | "VALIDATED" | "PUBLISHED" | "SUPERSEDED" | "QUARANTINED" | "RETIRED";
  published_at: string;
  module_path: string;
  shared_player?: true;
}

export interface ObjectVersionRow {
  object_version_id: string;
  object_id: string;
  semver: string;
  package_version_id: string;
  status: "DRAFT" | "VALIDATING" | "PUBLISHED" | "SUPERSEDED" | "RETIRED";
  published_at: string | null;
}

export interface RegisteredQuiz {
  object_id: string;
  object_version_id: string;
  package_version_id: string;
  package_version: string;
  content_version: string;
  question_count: number;
  title: string;
}

/** What a publisher supplies to register a code-bearing learning object. */
export interface ObjectRegistration {
  repository_id: string;
  title: string;
  description?: string;
  duration?: string;
  kind?: string;
  /** Path under the Player Shell origin that serves the package entry point. */
  module_path: string;
  semver: string;
  /** Integrity digest of the published package. Immutable once the version is published. */
  sha256: string;
  authored_by?: string;
}

export interface CatalogueStore {
  readonly kind: "postgres" | "memory";

  repositories(): Promise<Repository[]>;
  repository(repositoryId: string): Promise<Repository | undefined>;
  /**
   * The repository a caller gets when none is named: the canonical default where it is ACTIVE,
   * otherwise the oldest ACTIVE one, and undefined when none is.
   *
   * It is deliberately not "the first repository". A client that lists one repository's objects
   * picks by its own rule and diverges from this one the moment a tenant has more than the seeded
   * default — which is how agent-registered quizzes came to be published, launchable, and missing
   * from the learner catalogue. Learner-facing listings are unscoped for that reason.
   */
  defaultRepository(): Promise<Repository | undefined>;

  learningObjects(filter?: { repository_id?: string; status?: LearningObjectRow["status"] }): Promise<LearningObjectRow[]>;
  learningObject(objectId: string): Promise<LearningObjectRow | undefined>;
  objectVersion(objectVersionId: string): Promise<ObjectVersionRow | undefined>;

  packageVersions(filter?: { object_id?: string }): Promise<PackageVersionRow[]>;
  packageVersion(packageVersionId: string): Promise<PackageVersionRow | undefined>;

  /** Learner-facing structured content, including any marking key. */
  content(objectId: string): Promise<QuizContent | undefined>;

  /** Registers a code-bearing learning object and publishes its first version. */
  registerObject(registration: ObjectRegistration): Promise<LearningObjectRow>;
  /** Publishes a new immutable version of an existing object. */
  publishObjectVersion(objectId: string, input: { semver: string; module_path: string; sha256: string }): Promise<LearningObjectRow | undefined>;
  retireObject(objectId: string): Promise<LearningObjectRow | undefined>;

  /** Registers agent-authored quiz content against the shared, already-reviewed quiz player. */
  registerQuiz(draft: QuizDraft, options?: { repository_id?: string; authored_by?: string }): Promise<RegisteredQuiz>;

  /** Ensures the shared quiz-player package row exists. Idempotent. */
  ensureSharedPlayer(): Promise<void>;
}
