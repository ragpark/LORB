/**
 * Values shared by both catalogue backends.
 */
import { randomUUID } from "node:crypto";
import { quizContentSchema, type QuizContent, type QuizDraft } from "../../../contracts/src/index.js";
import type { LearningObjectRow, ObjectContentRevision, PackageVersionRow, RegisteredQuiz } from "./types.js";

/**
 * One fixed, already-reviewed player package version shared by every authored quiz. A quiz author —
 * a person or an agent — supplies JSON content, never executable code, so no per-quiz bundle enters
 * the catalogue and there is no per-quiz code-injection surface. Bumping this identifier is a
 * content-model change.
 */
export const QUIZ_PLAYER = {
  package_version_id: "5cbe1b8a-2f2a-4a5c-9f8b-6d1c0a7e4b21",
  package_id: "5cbe1b8a-2f2a-4a5c-9f8b-6d1c0a7e4b22",
  semver: "1.0.0",
  module_path: "/modules/quiz-player/index.html",
  sha256: "9f0c4c9d0f1a4a4b8f0f7b2d0a1c6e3f5d8b2a7c4e9f1b3d6a8c0e2f4b6d8a10",
} as const;

export const QUIZ_PLAYER_PACKAGE: PackageVersionRow = {
  package_version_id: QUIZ_PLAYER.package_version_id,
  object_id: null,
  semver: QUIZ_PLAYER.semver,
  sha256: QUIZ_PLAYER.sha256,
  delivery_profile: "native-web-package",
  status: "PUBLISHED",
  published_at: "2026-08-20T08:00:00.000Z",
  module_path: QUIZ_PLAYER.module_path,
  shared_player: true,
};

/** The repository every deployment starts with when an operator has registered none of their own. */
export const DEFAULT_REPOSITORY = {
  repository_id: "b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d",
  slug: "default",
  display_name: "Default repository",
} as const;

/** Builds the rows a quiz registration produces, so both backends agree on their shape. */
export function buildQuizRegistration(
  draft: QuizDraft,
  repositoryId: string,
  authoredBy: string | undefined,
): { object: LearningObjectRow; content: QuizContent; registered: RegisteredQuiz; objectVersionSemver: string } {
  const object_id = randomUUID();
  const object_version_id = randomUUID();
  const created_at = new Date().toISOString();
  const content = quizContentSchema.parse({ ...draft, object_id, content_version: "1", created_at });
  const object: LearningObjectRow = {
    object_id,
    repository_id: repositoryId,
    status: "PUBLISHED",
    active_object_version_id: object_version_id,
    active_package_version_id: QUIZ_PLAYER.package_version_id,
    created_at,
    title: draft.title,
    description: draft.description ?? `A ${draft.questions.length}-question quiz rendered by the shared quiz player.`,
    duration: `${Math.max(1, Math.round(draft.questions.length * 0.75))} minutes`,
    kind: "quiz-json",
    module_path: QUIZ_PLAYER.module_path,
    content_profile: "quiz-json-v1",
    ...(authoredBy ? { authored_by: authoredBy } : {}),
  };
  return {
    object,
    content,
    objectVersionSemver: "1.0.0",
    registered: {
      object_id,
      object_version_id,
      package_version_id: QUIZ_PLAYER.package_version_id,
      package_version: QUIZ_PLAYER.semver,
      content_version: content.content_version,
      question_count: draft.questions.length,
      title: draft.title,
    },
  };
}

/**
 * The version an edit publishes next.
 *
 * Editing a quiz does not overwrite the version an attempt was launched against; it supersedes it,
 * and a superseded version needs a successor whose identifier is larger than every one already
 * issued. Taking the highest existing version rather than counting revisions means a catalogue that
 * was published into by hand still gets a version nobody has used.
 */
export function nextMinorSemver(existing: string[]): string {
  const parsed = existing
    .map((value) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])] as const);
  if (parsed.length === 0) return "1.0.0";
  const highest = parsed.reduce((best, current) =>
    current[0] !== best[0] ? (current[0] > best[0] ? current : best)
      : current[1] !== best[1] ? (current[1] > best[1] ? current : best)
        : current[2] > best[2] ? current : best);
  return `${highest[0]}.${highest[1] + 1}.0`;
}

/** The content version an edit writes: the previous one incremented, starting at 1. */
export function nextContentVersion(previous: string | undefined): string {
  const numeric = Number.parseInt(previous ?? "0", 10);
  return String((Number.isFinite(numeric) ? numeric : 0) + 1);
}

/**
 * Builds the rows a quiz *edit* produces. The object keeps its identity — every assignment, smart
 * link and class result already points at it — while the content, the content version and the object
 * version are all new.
 */
export function buildQuizRevision(
  object: LearningObjectRow,
  draft: QuizDraft,
  previousContentVersion: string | undefined,
  existingSemvers: string[],
): { content: QuizContent; revision: ObjectContentRevision; objectPatch: Pick<LearningObjectRow, "title" | "description" | "duration"> } {
  const object_version_id = randomUUID();
  const content_version = nextContentVersion(previousContentVersion);
  const semver = nextMinorSemver(existingSemvers);
  const content = quizContentSchema.parse({
    ...draft,
    object_id: object.object_id,
    content_version,
    created_at: new Date().toISOString(),
  });
  return {
    content,
    revision: {
      object_id: object.object_id,
      object_version_id,
      package_version_id: QUIZ_PLAYER.package_version_id,
      semver,
      content_version,
      question_count: draft.questions.length,
      title: draft.title,
    },
    objectPatch: {
      title: draft.title,
      description: draft.description ?? object.description,
      duration: `${Math.max(1, Math.round(draft.questions.length * 0.75))} minutes`,
    },
  };
}

/** The bundled example content, published only where SEED_EXAMPLE_CONTENT is enabled. */
export const EXAMPLE_OBJECTS: { object: LearningObjectRow; package: PackageVersionRow }[] = [
  {
    object: {
      object_id: "c8a2d3e4-7f4b-4a2c-8b6e-2f3a4b5c6d7e",
      repository_id: DEFAULT_REPOSITORY.repository_id,
      status: "PUBLISHED",
      active_object_version_id: "d9b3e4f5-8a5c-4b3d-9c7f-3a4b5c6d7e8f",
      active_package_version_id: "eaa4f506-9b6d-4c4e-ad80-4b5c6d7e8f90",
      created_at: "2026-08-12T09:22:00.000Z",
      title: "Maths foundations: ratios and proportion",
      description: "A native-web-package activity with a single completion checkpoint.",
      duration: "20 minutes",
      kind: "native-web-package",
      module_path: "/module/index.html",
    },
    package: {
      package_version_id: "eaa4f506-9b6d-4c4e-ad80-4b5c6d7e8f90",
      object_id: "c8a2d3e4-7f4b-4a2c-8b6e-2f3a4b5c6d7e",
      semver: "1.4.0",
      sha256: "4f3c9a182fd1b9534f3c9a182fd1b9534f3c9a182fd1b9534f3c9a182fd1b953",
      delivery_profile: "native-web-package",
      status: "PUBLISHED",
      published_at: "2026-08-12T10:04:00.000Z",
      module_path: "/module/index.html",
    },
  },
  {
    object: {
      object_id: "9fa1bff9-e205-44ee-a08d-df208bb1c8c4",
      repository_id: DEFAULT_REPOSITORY.repository_id,
      status: "PUBLISHED",
      active_object_version_id: "7e08c389-8166-400c-920a-4d2d6166fce3",
      active_package_version_id: "6978ab59-f291-4de4-ac25-d51218fc3751",
      created_at: "2026-08-13T11:05:00.000Z",
      title: "Reflective Practice Studio",
      description: "A React web experience that emits xAPI statements for delivery to the learning record store.",
      duration: "8 minutes",
      kind: "react-xapi-experience",
      module_path: "/modules/reflective-practice-studio/index.html",
    },
    package: {
      package_version_id: "6978ab59-f291-4de4-ac25-d51218fc3751",
      object_id: "9fa1bff9-e205-44ee-a08d-df208bb1c8c4",
      semver: "1.0.0",
      sha256: "62f030c5bd0f1fd606f1548a3070797730d025cb330e32837519098c44f0bd13",
      delivery_profile: "native-web-package",
      status: "PUBLISHED",
      published_at: "2026-08-13T11:06:00.000Z",
      module_path: "/modules/reflective-practice-studio/index.html",
    },
  },
  {
    object: {
      object_id: "1d3cf15e-653b-446e-8398-a7b5fe0d32d9",
      repository_id: DEFAULT_REPOSITORY.repository_id,
      status: "PUBLISHED",
      active_object_version_id: "9592a8f2-e82b-48ea-b5a4-a0fa909ec111",
      active_package_version_id: "7a78d88e-4ef2-4bce-a4a7-8b4d19d22013",
      created_at: "2026-08-13T11:12:00.000Z",
      title: "Career Coach Check-in",
      description: "A chatbot-style coaching tool that guides a learner through a short reflective conversation.",
      duration: "5 minutes",
      kind: "coaching-chatbot",
      module_path: "/modules/career-coach-chat/index.html",
    },
    package: {
      package_version_id: "7a78d88e-4ef2-4bce-a4a7-8b4d19d22013",
      object_id: "1d3cf15e-653b-446e-8398-a7b5fe0d32d9",
      semver: "1.0.0",
      sha256: "4ae991392399628e60ae327c2215fddbf5d082c80ff9aaf6e9f047886f6edd8b",
      delivery_profile: "native-web-package",
      status: "PUBLISHED",
      published_at: "2026-08-13T11:13:00.000Z",
      module_path: "/modules/career-coach-chat/index.html",
    },
  },
];
