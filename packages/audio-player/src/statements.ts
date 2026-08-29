/**
 * xAPI statement construction for the generic audio player. Same verb-reuse reasoning as
 * video-player/src/statements.ts: launched / answered(quartile) / completed, no new verbs.
 */
import { xapiVerbs } from "../../contracts/src/index.js";

export interface ShellContext {
  repository_id: string;
  object_id: string;
  object_version_id: string;
  package_version_id: string;
  attempt_id: string;
  correlation_id: string;
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

export function quartilesCrossed(previousFraction: number, fraction: number): Array<25 | 50 | 75> {
  const marks: Array<[number, 25 | 50 | 75]> = [[0.25, 25], [0.5, 50], [0.75, 75]];
  return marks.filter(([threshold]) => previousFraction < threshold && fraction >= threshold).map(([, quartile]) => quartile);
}
