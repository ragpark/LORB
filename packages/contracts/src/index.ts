import { z } from "zod";
const uuid = z.string().uuid();
export const launchRequestSchema = z.object({contract_version:z.literal("1.0"),consumer_id:z.string().min(1),repository_id:uuid,object_id:uuid,requested_launch_mode:z.literal("embedded-iframe"),locale:z.literal("en-GB")}).strict();
export const descriptorSchema = z.object({iss:z.string().url(),aud:z.literal("lorb-player"),iat:z.number().int(),nbf:z.number().int(),exp:z.number().int(),jti:uuid,sub:z.string().regex(/^[a-f\d]{64}$/),tenant_id:z.string().regex(/^[a-z\d][a-z\d-]{1,62}$/),repository_id:uuid,consumer_id:z.string().min(1),object_id:uuid,object_version_id:uuid,package_version_id:uuid,delivery_profile:z.literal("native-web-package"),launch_mode:z.literal("embedded-iframe"),player_ref:z.string().regex(/^[a-z][a-z\d-]*-v\d+$/),correlation_id:uuid,locale:z.literal("en-GB"),attempt_id:uuid,state_endpoint:z.string().url(),evidence_endpoint:z.string().url(),package_url:z.string().url(),session_config:z.object({expires_at:z.string().datetime()}),telemetry_config:z.object({correlation_header:z.literal("X-Correlation-ID")}),contract_version:z.literal("1.0")}).strict().refine((v: {exp:number;iat:number})=>v.exp-v.iat>=60&&v.exp-v.iat<=900,"descriptor lifetime must be between 60 and 900 seconds");

// Verb chain accepted by the Evidence API. `completed` is the original MVP verb and is unchanged;
// `launched` and `answered` were added for the generic quiz player (packages/quiz-player), which
// reports one `answered` statement per question before its single `completed` statement. Widening
// this contract is a material change to an enforced anti-requirement surface and needs the human
// LORB-001 re-review the README requires.
export const xapiVerbs = {
  launched: "http://adlnet.gov/expapi/verbs/launched",
  answered: "http://adlnet.gov/expapi/verbs/answered",
  completed: "http://adlnet.gov/expapi/verbs/completed",
} as const;
const verbSchema = z.discriminatedUnion("id", [
  z.object({id:z.literal(xapiVerbs.launched),display:z.object({"en-GB":z.literal("launched")})}),
  z.object({id:z.literal(xapiVerbs.answered),display:z.object({"en-GB":z.literal("answered")})}),
  z.object({id:z.literal(xapiVerbs.completed),display:z.object({"en-GB":z.literal("completed")})}),
]);
// `response` carries an option identifier only (never free text), so a marking result can never
// become a channel for learner-authored personal data.
const resultSchema = z.object({
  response: z.string().regex(/^[a-z\d_-]{1,16}$/).optional(),
  success: z.boolean().optional(),
  completion: z.boolean().optional(),
  score: z.object({scaled:z.number().min(-1).max(1)}).strict().optional(),
}).strict();
export const xapiStatementSchema=z.object({id:uuid,actor:z.object({objectType:z.literal("Agent"),account:z.object({homePage:z.literal("https://lorb.example/pseudonym"),name:z.string().regex(/^[a-f\d]{64}$/)})}),verb:verbSchema,object:z.object({id:z.string().url(),objectType:z.literal("Activity")}),result:resultSchema.optional(),context:z.object({extensions:z.object({"https://lorb.example/xapi/repository_id":uuid,"https://lorb.example/xapi/attempt_id":uuid,"https://lorb.example/xapi/package_version_id":uuid,"https://lorb.example/xapi/correlation_id":uuid,"https://lorb.example/xapi/completion_authority":z.literal("PACKAGE")})}),timestamp:z.string().datetime()}).strict();
export const messageTypes=["module.hello","shell.context","module.ready","state.put","evidence.emit","experience.complete","experience.exit","experience.error"] as const;
export const postMessageSchema=z.object({protocol:z.literal("lorb-player"),version:z.literal("1.0"),type:z.enum(messageTypes),message_id:uuid,correlation_id:uuid,reply_to:uuid.nullable(),sent_at:z.string().datetime(),payload:z.record(z.unknown())}).strict();

// ---------------------------------------------------------------------------
// Quiz content payloads (packages/quiz-player)
//
// A quiz is *data*, not code: an agent-authored payload rendered by one fixed,
// already-reviewed player package version. Nothing here is ever compiled or
// evaluated — the player reads it as JSON.
// ---------------------------------------------------------------------------
const optionId = z.string().regex(/^[a-z\d_-]{1,16}$/);
export const quizQuestionDraftSchema = z.object({
  stem: z.string().min(1).max(600),
  options: z.array(z.object({id:optionId,text:z.string().min(1).max(300)}).strict()).min(2).max(6),
  correct_option_id: optionId,
  explanation: z.string().max(1000).optional(),
}).strict()
  .refine(q => new Set(q.options.map(o => o.id)).size === q.options.length, {message:"option ids must be unique"})
  .refine(q => q.options.some(o => o.id === q.correct_option_id), {message:"correct_option_id must match one of the options"});
export const quizDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  subject: z.string().max(80).optional(),
  year_group: z.string().max(40).optional(),
  questions: z.array(quizQuestionDraftSchema).min(1).max(25),
}).strict();
export const quizContentSchema = quizDraftSchema.extend({
  object_id: uuid,
  content_version: z.string().regex(/^\d+$/),
  created_at: z.string().datetime(),
}).strict();
export type QuizQuestionDraft = z.infer<typeof quizQuestionDraftSchema>;
export type QuizDraft = z.infer<typeof quizDraftSchema>;
export type QuizContent = z.infer<typeof quizContentSchema>;
