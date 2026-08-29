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
import type {
  AudioContent, AudioDraft, DocumentContent, DocumentDraft, LaunchContext, QuizContent, QuizDraft, VideoContent, VideoDraft,
} from "../../../contracts/src/index.js";

/** The three media kinds registered alongside quizzes, each behind one fixed shared player. */
export type MediaKind = "video" | "document" | "audio";
export type AnyMediaContent = VideoContent | DocumentContent | AudioContent;
export type AnyMediaDraft = VideoDraft | DocumentDraft | AudioDraft;
/** Everything a learning object's content route may serve. */
export type AnyContent = QuizContent | AnyMediaContent;

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
  content_profile?: "quiz-json-v1" | "video-json-v1" | "document-json-v1" | "audio-json-v1";
  /** Provenance, so an operator can see which objects an agent authored. */
  authored_by?: string;
  /** Whether this repository has opted this object in to cross-repository marketplace discovery.
   *  Absent (or false) means the object is reachable only within its own repository, same as every
   *  object registered before the marketplace existed. */
  marketplace_listed?: boolean;
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
  /**
   * Publisher-authored launch configuration this object version carries into its own launch — a
   * theme token, small named settings. Versioned with the object for the same reason content is: a
   * descriptor pins the version, so a context edit published mid-attempt cannot restyle or
   * reconfigure the experience under a learner who is already inside it.
   */
  launch_context?: LaunchContext | null;
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

/** What registering a video, document, or audio object produces — the media analogue of
 * RegisteredQuiz, minus the quiz-only question_count. */
export interface RegisteredMedia {
  object_id: string;
  object_version_id: string;
  package_version_id: string;
  package_version: string;
  content_version: string;
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

/**
 * What a deletion did, or why it did nothing.
 *
 * A boolean was not enough once the refusals became the interesting part: `IN_USE` and
 * `STATE_INVALID` are the two the caller has to tell apart, and the check that produces them has to
 * happen inside the same transaction as the delete to mean anything.
 */
export type ObjectDeletion = "DELETED" | "NOT_FOUND" | "IN_USE" | "STATE_INVALID";

/** The lifecycle states an administrator may move a registered object between. */
export type ObjectLifecycleStatus = "PUBLISHED" | "SUSPENDED" | "RETIRED";

/** What setting a launch context produced: a new object version carrying it. */
export interface LaunchContextRevision {
  object_id: string;
  object_version_id: string;
  semver: string;
  launch_context: LaunchContext | null;
}

/** What replacing a quiz's content produced: a new content version bound to a new object version. */
export interface ObjectContentRevision {
  object_id: string;
  object_version_id: string;
  package_version_id: string;
  semver: string;
  content_version: string;
  /** Quiz-only; absent for a video, document, or audio revision. */
  question_count?: number;
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

  learningObjects(filter?: { repository_id?: string; status?: LearningObjectRow["status"]; marketplace_listed?: boolean }): Promise<LearningObjectRow[]>;
  learningObject(objectId: string): Promise<LearningObjectRow | undefined>;
  objectVersion(objectVersionId: string): Promise<ObjectVersionRow | undefined>;
  /** Every version of one object, newest first. The version chain an operator audits an edit against. */
  objectVersions(objectId: string): Promise<ObjectVersionRow[]>;

  packageVersions(filter?: { object_id?: string }): Promise<PackageVersionRow[]>;
  packageVersion(packageVersionId: string): Promise<PackageVersionRow | undefined>;

  /** Learner-facing structured content, including any marking key. Quiz, video, document, or audio. */
  content(objectId: string): Promise<AnyContent | undefined>;
  /** One historical content version, so a superseded attempt can still be read against what it was delivered. */
  contentRevision(objectId: string, contentVersion: string): Promise<AnyContent | undefined>;
  /**
   * The content one launched object version delivers, falling back to the object's current content
   * where the version names none — a descriptor issued before content versions were recorded.
   */
  contentForObjectVersion(objectId: string, objectVersionId: string): Promise<AnyContent | undefined>;

  /** Registers a code-bearing learning object and publishes its first version. */
  registerObject(registration: ObjectRegistration): Promise<LearningObjectRow>;
  /** Publishes a new immutable version of an existing object. */
  publishObjectVersion(objectId: string, input: { semver: string; module_path: string; sha256: string }): Promise<LearningObjectRow | undefined>;
  /** Edits the catalogue entry. Never touches the version chain. */
  updateObject(objectId: string, patch: ObjectMetadataPatch): Promise<LearningObjectRow | undefined>;
  /** Moves a registered object between the lifecycle states an administrator controls. */
  setObjectStatus(objectId: string, status: ObjectLifecycleStatus): Promise<LearningObjectRow | undefined>;
  /** Opts an object in or out of cross-repository marketplace discovery. Changes nothing else about
   *  it — not its version chain, not its content, not which repository owns it. */
  setMarketplaceListed(objectId: string, listed: boolean): Promise<LearningObjectRow | undefined>;
  retireObject(objectId: string): Promise<LearningObjectRow | undefined>;
  /**
   * Removes an object and everything that only exists to describe it.
   *
   * Refuses an object that is still deliverable, and — where the backend can see them — one with an
   * attempt or an assignment against it. Both checks happen under a lock on the object row, in the
   * same transaction as the delete: a check made beforehand can be true when it is read and false by
   * the time the rows go, which is precisely the case that leaves a learner's record pointing at
   * nothing. Evidence outlives the catalogue, and an object that was delivered is retired.
   */
  deleteObject(objectId: string): Promise<ObjectDeletion>;

  /**
   * Replaces an authored quiz's content with a new immutable content version, bound to a new object
   * version. The previous content version stays readable, so an attempt that was launched against it
   * still describes what the learner actually saw.
   */
  reviseQuizContent(objectId: string, draft: QuizDraft): Promise<ObjectContentRevision | undefined>;

  /**
   * Replaces a video, document, or audio object's content with a new immutable content version,
   * bound to a new object version. Refuses (returns undefined) an object whose content_profile does
   * not match `kind` — same guard reviseQuizContent applies for quizzes.
   */
  reviseMediaContent(objectId: string, kind: MediaKind, draft: AnyMediaDraft): Promise<ObjectContentRevision | undefined>;

  /**
   * Sets or clears the launch context by publishing a new object version that carries it, with the
   * current package and content bindings copied across unchanged. Follows the same rule as every
   * other edit that reaches a descriptor: never in place. Versions published by other paths carry
   * the active version's context forward, so a content edit does not silently drop the theme.
   */
  setLaunchContext(objectId: string, context: LaunchContext | null): Promise<LaunchContextRevision | undefined>;

  /** Registers agent-authored quiz content against the shared, already-reviewed quiz player. */
  registerQuiz(draft: QuizDraft, options?: { repository_id?: string; authored_by?: string }): Promise<RegisteredQuiz>;

  /** Registers agent- or publisher-authored video/document/audio content against the shared,
   * already-reviewed player for that kind. The document-player expects `draft` to already carry
   * pre-rasterised page image URLs — see packages/document-converter. */
  registerMedia(kind: MediaKind, draft: AnyMediaDraft, options?: { repository_id?: string; authored_by?: string }): Promise<RegisteredMedia>;

  /** Ensures every shared player package row exists (quiz, video, document, audio). Idempotent. */
  ensureSharedPlayer(): Promise<void>;
}
