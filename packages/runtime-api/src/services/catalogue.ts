// STUB — NOT PRODUCTION — BLOCKED BY BLK-03. Synthetic in-memory catalogue projection, extracted
// from app.ts so the internal quiz-authoring surface can extend it without duplicating the seed.
import { randomUUID } from "node:crypto";
import { quizContentSchema, type QuizContent, type QuizDraft } from "../../../contracts/src/index.js";

export interface LearningObjectRow {
  object_id: string;
  repository_id: string;
  status: "PUBLISHED" | "DRAFT";
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
  authored_by?: "mcp-connector";
}

export interface PackageVersionRow {
  package_version_id: string;
  /** null for a shared, reusable player package that many learning objects point at. */
  object_id: string | null;
  semver: string;
  sha256: string;
  delivery_profile: "native-web-package";
  status: "PUBLISHED";
  published_at: string;
  shared_player?: true;
}

export const REPOSITORY = {
  repository_id: "b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d",
  slug: "maths-foundations",
  display_name: "Maths foundations",
  status: "ACTIVE",
  created_at: "2026-08-12T09:14:00.000Z",
};

// One fixed, already-reviewed player package version shared by every agent-authored quiz. An agent
// never registers a new package version, and never supplies executable code — only JSON content that
// this player renders. Bumping this identifier is a content-model change requiring re-review.
export const QUIZ_PLAYER = {
  package_version_id: "5cbe1b8a-2f2a-4a5c-9f8b-6d1c0a7e4b21",
  semver: "1.0.0",
  module_path: "/modules/quiz-player/index.html",
} as const;

const SEED_LEARNING_OBJECTS: LearningObjectRow[] = [
  {object_id:"c8a2d3e4-7f4b-4a2c-8b6e-2f3a4b5c6d7e",repository_id:REPOSITORY.repository_id,status:"PUBLISHED",active_object_version_id:"d9b3e4f5-8a5c-4b3d-9c7f-3a4b5c6d7e8f",active_package_version_id:"eaa4f506-9b6d-4c4e-ad80-4b5c6d7e8f90",created_at:"2026-08-12T09:22:00.000Z",title:"Maths foundations: ratios and proportion",description:"A native-web-package activity with a single completion checkpoint.",duration:"20 minutes",kind:"native-web-package",module_path:"/module/index.html"},
  {object_id:"9fa1bff9-e205-44ee-a08d-df208bb1c8c4",repository_id:REPOSITORY.repository_id,status:"PUBLISHED",active_object_version_id:"7e08c389-8166-400c-920a-4d2d6166fce3",active_package_version_id:"6978ab59-f291-4de4-ac25-d51218fc3751",created_at:"2026-08-13T11:05:00.000Z",title:"Reflective Practice Studio",description:"A React web experience that emits xAPI statements for delivery to the LORB learning record store.",duration:"8 minutes",kind:"react-xapi-experience",module_path:"/modules/reflective-practice-studio/index.html"},
  {object_id:"1d3cf15e-653b-446e-8398-a7b5fe0d32d9",repository_id:REPOSITORY.repository_id,status:"PUBLISHED",active_object_version_id:"9592a8f2-e82b-48ea-b5a4-a0fa909ec111",active_package_version_id:"7a78d88e-4ef2-4bce-a4a7-8b4d19d22013",created_at:"2026-08-13T11:12:00.000Z",title:"Career Coach Check-in",description:"A chatbot-style coaching tool that guides a learner through a short reflective conversation.",duration:"5 minutes",kind:"coaching-chatbot",module_path:"/modules/career-coach-chat/index.html"},
];

const SEED_PACKAGE_VERSIONS: PackageVersionRow[] = [
  {package_version_id:"eaa4f506-9b6d-4c4e-ad80-4b5c6d7e8f90",object_id:"c8a2d3e4-7f4b-4a2c-8b6e-2f3a4b5c6d7e",semver:"1.4.0",sha256:"4f3c9a182fd1b953",delivery_profile:"native-web-package",status:"PUBLISHED",published_at:"2026-08-12T10:04:00.000Z"},
  {package_version_id:"6978ab59-f291-4de4-ac25-d51218fc3751",object_id:"9fa1bff9-e205-44ee-a08d-df208bb1c8c4",semver:"1.0.0",sha256:"62f030c5bd0f1fd606f1548a3070797730d025cb330e32837519098c44f0bd13",delivery_profile:"native-web-package",status:"PUBLISHED",published_at:"2026-08-13T11:06:00.000Z"},
  {package_version_id:"7a78d88e-4ef2-4bce-a4a7-8b4d19d22013",object_id:"1d3cf15e-653b-446e-8398-a7b5fe0d32d9",semver:"1.0.0",sha256:"4ae991392399628e60ae327c2215fddbf5d082c80ff9aaf6e9f047886f6edd8b",delivery_profile:"native-web-package",status:"PUBLISHED",published_at:"2026-08-13T11:13:00.000Z"},
  // Shared, reusable player. Not owned by any one learning object: every quiz authored through the
  // internal quiz surface points its active_package_version_id at this immutable row.
  {package_version_id:QUIZ_PLAYER.package_version_id,object_id:null,semver:QUIZ_PLAYER.semver,sha256:"9f0c4c9d0f1a4a4b8f0f7b2d0a1c6e3f5d8b2a7c4e9f1b3d6a8c0e2f4b6d8a10",delivery_profile:"native-web-package",status:"PUBLISHED",published_at:"2026-08-20T08:00:00.000Z",shared_player:true},
];

export const learningObjectById = new Map<string, LearningObjectRow>();
export const packageVersionById = new Map<string, PackageVersionRow>();
/** Structured quiz content keyed by object_id. Data only — never code. */
export const quizContentByObjectId = new Map<string, QuizContent>();

export function resetCatalogue(): void {
  learningObjectById.clear();
  packageVersionById.clear();
  quizContentByObjectId.clear();
  for (const row of SEED_LEARNING_OBJECTS) learningObjectById.set(row.object_id, { ...row });
  for (const row of SEED_PACKAGE_VERSIONS) packageVersionById.set(row.package_version_id, { ...row });
}
resetCatalogue();

export const learningObjects = (): LearningObjectRow[] => [...learningObjectById.values()];
export const packageVersions = (): PackageVersionRow[] => [...packageVersionById.values()];

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
 * Registers an agent-authored quiz as a new learning object plus an immutable content payload,
 * reusing the fixed quiz-player package version. No new package version is created, so no new
 * executable code enters the catalogue.
 */
export function registerQuizObject(draft: QuizDraft): RegisteredQuiz {
  const object_id = randomUUID();
  const object_version_id = randomUUID();
  const created_at = new Date().toISOString();
  const content = quizContentSchema.parse({ ...draft, object_id, content_version: "1", created_at });
  quizContentByObjectId.set(object_id, content);
  learningObjectById.set(object_id, {
    object_id,
    repository_id: REPOSITORY.repository_id,
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
    authored_by: "mcp-connector",
  });
  return {
    object_id,
    object_version_id,
    package_version_id: QUIZ_PLAYER.package_version_id,
    package_version: QUIZ_PLAYER.semver,
    content_version: content.content_version,
    question_count: draft.questions.length,
    title: draft.title,
  };
}
