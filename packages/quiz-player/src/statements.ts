/**
 * Marking and xAPI statement construction for the generic quiz player.
 *
 * Deliberately DOM-free so the same code paths the browser runs can be exercised directly by the
 * end-to-end smoke test. Marking is client-side, which is acceptable for this PoC and stated as a
 * limitation: the content payload the player fetches carries the marking key. That key is served
 * only on the learner-facing content route and never crosses the agent-facing MCP surface.
 */
import { xapiVerbs, type QuizContent, type QuizQuestionDraft } from "../../contracts/src/index.js";

/** The non-sensitive descriptor fields the Player Shell relays to an embedded module. */
export interface ShellContext {
  repository_id: string;
  object_id: string;
  object_version_id: string;
  package_version_id: string;
  attempt_id: string;
  correlation_id: string;
  /** LORB pseudonym. The player never sees, and must never emit, a platform learner identifier. */
  pseudonym: string;
  content_url: string;
}

export interface XapiStatement {
  id: string;
  actor: { objectType: "Agent"; account: { homePage: "https://lorb.example/pseudonym"; name: string } };
  verb: { id: string; display: Record<"en-GB", string> };
  object: { id: string; objectType: "Activity" };
  result?: { response?: string; success?: boolean; completion?: boolean; score?: { scaled: number } };
  context: { extensions: Record<string, string> };
  timestamp: string;
}

export type NewId = () => string;

const activityId = (ctx: ShellContext) => `https://lorb.example/objects/${ctx.object_id}/versions/${ctx.object_version_id}`;
const questionActivityId = (ctx: ShellContext, index: number) => `${activityId(ctx)}/questions/${index + 1}`;

function base(ctx: ShellContext, newId: NewId, verb: keyof typeof xapiVerbs, objectId: string): XapiStatement {
  return {
    id: newId(),
    actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: ctx.pseudonym } },
    verb: { id: xapiVerbs[verb], display: { "en-GB": verb } },
    object: { id: objectId, objectType: "Activity" },
    context: {
      extensions: {
        "https://lorb.example/xapi/repository_id": ctx.repository_id,
        "https://lorb.example/xapi/attempt_id": ctx.attempt_id,
        "https://lorb.example/xapi/package_version_id": ctx.package_version_id,
        "https://lorb.example/xapi/correlation_id": ctx.correlation_id,
        "https://lorb.example/xapi/completion_authority": "PACKAGE",
      },
    },
    timestamp: new Date().toISOString(),
  };
}

export const launchedStatement = (ctx: ShellContext, newId: NewId): XapiStatement =>
  base(ctx, newId, "launched", activityId(ctx));

export function isCorrect(question: QuizQuestionDraft, chosenOptionId: string): boolean {
  return question.correct_option_id === chosenOptionId;
}

/** One statement per question. `result.response` carries the chosen *option id*, never free text. */
export function answeredStatement(ctx: ShellContext, newId: NewId, question: QuizQuestionDraft, index: number, chosenOptionId: string): XapiStatement {
  const statement = base(ctx, newId, "answered", questionActivityId(ctx, index));
  statement.result = { response: chosenOptionId, success: isCorrect(question, chosenOptionId) };
  return statement;
}

export interface QuizMark {
  correct: number;
  total: number;
  scaled: number;
  success: boolean;
}

/** Marks the whole quiz. `answers` is question index -> chosen option id; unanswered counts wrong. */
export function markQuiz(content: QuizContent, answers: ReadonlyArray<string | undefined>): QuizMark {
  const total = content.questions.length;
  let correct = 0;
  content.questions.forEach((question, index) => {
    const chosen = answers[index];
    if (chosen !== undefined && isCorrect(question, chosen)) correct += 1;
  });
  const scaled = total === 0 ? 0 : Number((correct / total).toFixed(4));
  // A pass mark is a pedagogic policy decision LORB-001 has not taken. 0.6 is a placeholder for this
  // PoC only and must not be read as a LORB grading rule.
  return { correct, total, scaled, success: scaled >= 0.6 };
}

export function completedStatement(ctx: ShellContext, newId: NewId, mark: QuizMark): XapiStatement {
  const statement = base(ctx, newId, "completed", activityId(ctx));
  statement.result = { completion: true, success: mark.success, score: { scaled: mark.scaled } };
  return statement;
}

/** The full verb chain a completed attempt produces, in emission order. */
export function quizStatementChain(ctx: ShellContext, newId: NewId, content: QuizContent, answers: ReadonlyArray<string | undefined>): XapiStatement[] {
  const mark = markQuiz(content, answers);
  const chain: XapiStatement[] = [launchedStatement(ctx, newId)];
  content.questions.forEach((question, index) => {
    const chosen = answers[index];
    if (chosen === undefined) return;
    chain.push(answeredStatement(ctx, newId, question, index, chosen));
  });
  chain.push(completedStatement(ctx, newId, mark));
  return chain;
}
