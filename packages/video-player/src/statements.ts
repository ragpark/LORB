/**
 * xAPI statement construction for the generic video player.
 *
 * Reuses the three verbs the Evidence API already accepts (launched / answered / completed) rather
 * than widening that contract, which the quiz-player README flags as needing the human LORB-001
 * re-review. `answered` was defined for one-answer-per-question, but its `result.response` field is
 * just a short token (`^[a-z\d_-]{1,16}$`), so it fits a watch-progress checkpoint just as well: this
 * player emits one per quartile reached (`p25`, `p50`, `p75`), and reserves `completed` for the point
 * the learner actually finishes the video rather than merely opening it.
 *
 * DOM-free by the same reasoning as quiz-player/src/statements.ts, so the same statement-construction
 * code path an end-to-end test exercises is the one the browser runs.
 */
import { xapiVerbs } from "../../contracts/src/index.js";

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

export const activityId = (ctx: ShellContext) => `https://lorb.example/objects/${ctx.object_id}/versions/${ctx.object_version_id}`;

function base(ctx: ShellContext, newId: NewId, verb: keyof typeof xapiVerbs): XapiStatement {
  return {
    id: newId(),
    actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: ctx.pseudonym } },
    verb: { id: xapiVerbs[verb], display: { "en-GB": verb } },
    object: { id: activityId(ctx), objectType: "Activity" },
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

export const launchedStatement = (ctx: ShellContext, newId: NewId): XapiStatement => base(ctx, newId, "launched");

/** One quartile checkpoint, e.g. quartile = 25 -> response "p25". Never re-emit an already-passed one. */
export function progressStatement(ctx: ShellContext, newId: NewId, quartile: 25 | 50 | 75): XapiStatement {
  const statement = base(ctx, newId, "answered");
  statement.result = { response: `p${quartile}` };
  return statement;
}

export function completedStatement(ctx: ShellContext, newId: NewId): XapiStatement {
  const statement = base(ctx, newId, "completed");
  statement.result = { completion: true, success: true };
  return statement;
}

/** Which quartile checkpoints `fraction` (0..1 of duration watched) has newly crossed. */
export function quartilesCrossed(previousFraction: number, fraction: number): Array<25 | 50 | 75> {
  const marks: Array<[number, 25 | 50 | 75]> = [[0.25, 25], [0.5, 50], [0.75, 75]];
  return marks.filter(([threshold]) => previousFraction < threshold && fraction >= threshold).map(([, quartile]) => quartile);
}
