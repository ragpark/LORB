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
  /**
   * The content version this object version delivers, for objects whose payload is data. A
   * descriptor pins the object version, so this is what lets a launch keep serving the questions it
   * was issued against even after the quiz has been edited. Null for code-bearing objects.
   */
  content_version?: string | null;
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

/**
 * What a publisher may change about a learning object without publishing anything.
 *
 * Deliberately narrow: the catalogue entry an operator reads, and nothing a descriptor binds to.
 * `module_path`, `sha256` and the version chain are reachable only through publishing a new version,
 * so an edit can never change what a pinned attempt was actually delivered.
 */
export interface ObjectMetadataPatch {
  title?: string;
  description?: string;
  duration?: string;
  kind?: string;
}

/** The lifecycle states an administrator may move a registered object between. */
export type ObjectLifecycleStatus = "PUBLISHED" | "SUSPENDED" | "RETIRED";

/** What replacing a quiz's content produced: a new content version bound to a new object version. */
export interface ObjectContentRevision {
  object_id: string;
  object_version_id: string;
  package_version_id: string;
  semver: string;
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
  /** The repository a caller gets when none is named. Undefined once more than one exists. */
  defaultRepository(): Promise<Repository | undefined>;

  learningObjects(filter?: { repository_id?: string; status?: LearningObjectRow["status"] }): Promise<LearningObjectRow[]>;
  learningObject(objectId: string): Promise<LearningObjectRow | undefined>;
  objectVersion(objectVersionId: string): Promise<ObjectVersionRow | undefined>;
  /** Every version of one object, newest first. The version chain an operator audits an edit against. */
  objectVersions(objectId: string): Promise<ObjectVersionRow[]>;

  packageVersions(filter?: { object_id?: string }): Promise<PackageVersionRow[]>;
  packageVersion(packageVersionId: string): Promise<PackageVersionRow | undefined>;

  /** Learner-facing structured content, including any marking key. */
  content(objectId: string): Promise<QuizContent | undefined>;
  /** One historical content version, so a superseded attempt can still be read against what it was delivered. */
  contentRevision(objectId: string, contentVersion: string): Promise<QuizContent | undefined>;
  /**
   * The content one launched object version delivers, falling back to the object's current content
   * where the version names none — a descriptor issued before content versions were recorded.
   */
  contentForObjectVersion(objectId: string, objectVersionId: string): Promise<QuizContent | undefined>;

  /** Registers a code-bearing learning object and publishes its first version. */
  registerObject(registration: ObjectRegistration): Promise<LearningObjectRow>;
  /** Publishes a new immutable version of an existing object. */
  publishObjectVersion(objectId: string, input: { semver: string; module_path: string; sha256: string }): Promise<LearningObjectRow | undefined>;
  /** Edits the catalogue entry. Never touches the version chain. */
  updateObject(objectId: string, patch: ObjectMetadataPatch): Promise<LearningObjectRow | undefined>;
  /** Moves a registered object between the lifecycle states an administrator controls. */
  setObjectStatus(objectId: string, status: ObjectLifecycleStatus): Promise<LearningObjectRow | undefined>;
  retireObject(objectId: string): Promise<LearningObjectRow | undefined>;
  /**
   * Removes an object and everything that only exists to describe it. The caller is responsible for
   * establishing that nothing was ever delivered against it — evidence outlives the catalogue, and
   * an object with attempts is retired, never deleted.
   */
  deleteObject(objectId: string): Promise<boolean>;

  /**
   * Replaces an authored quiz's content with a new immutable content version, bound to a new object
   * version. The previous content version stays readable, so an attempt that was launched against it
   * still describes what the learner actually saw.
   */
  reviseQuizContent(objectId: string, draft: QuizDraft): Promise<ObjectContentRevision | undefined>;

  /** Registers agent-authored quiz content against the shared, already-reviewed quiz player. */
  registerQuiz(draft: QuizDraft, options?: { repository_id?: string; authored_by?: string }): Promise<RegisteredQuiz>;

  /** Ensures the shared quiz-player package row exists. Idempotent. */
  ensureSharedPlayer(): Promise<void>;
}
