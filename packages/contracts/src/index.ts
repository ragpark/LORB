import { z } from "zod";
const uuid = z.string().uuid();
export const launchRequestSchema = z.object({contract_version:z.literal("1.0"),consumer_id:z.string().min(1),repository_id:uuid,object_id:uuid,requested_launch_mode:z.literal("embedded-iframe"),locale:z.literal("en-GB")}).strict();
export const descriptorSchema = z.object({iss:z.string().url(),aud:z.literal("lorb-player"),iat:z.number().int(),nbf:z.number().int(),exp:z.number().int(),jti:uuid,sub:z.string().regex(/^[a-f\d]{64}$/),tenant_id:z.string().regex(/^[a-z\d][a-z\d-]{1,62}$/),repository_id:uuid,consumer_id:z.string().min(1),object_id:uuid,object_version_id:uuid,package_version_id:uuid,delivery_profile:z.literal("native-web-package"),launch_mode:z.literal("embedded-iframe"),player_ref:z.string().regex(/^[a-z][a-z\d-]*-v\d+$/),correlation_id:uuid,locale:z.literal("en-GB"),attempt_id:uuid,state_endpoint:z.string().url(),evidence_endpoint:z.string().url(),package_url:z.string().url(),session_config:z.object({expires_at:z.string().datetime()}),telemetry_config:z.object({correlation_header:z.literal("X-Correlation-ID")}),contract_version:z.literal("1.0"),
  /** The launched object's content profile, so the Player Shell can recognise an LTI tool launch
   *  before ever creating the sandboxed module iframe every other kind uses. Optional and additive —
   *  absent on a descriptor for a code-bundled object, exactly as before this claim existed. */
  content_profile:z.string().optional()}).strict().refine((v: {exp:number;iat:number})=>v.exp-v.iat>=60&&v.exp-v.iat<=900,"descriptor lifetime must be between 60 and 900 seconds");

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
// relay.request/relay.reply: a module asks the shell to make one descriptor-authenticated call to
// the experience relay and answer on the port. The module never holds the descriptor; the shell
// never interprets the conversation. Protocol surface widened for the AI coach — see PR notes.
export const messageTypes=["module.hello","shell.context","module.ready","state.put","evidence.emit","relay.request","relay.reply","experience.complete","experience.exit","experience.error"] as const;
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

// ---------------------------------------------------------------------------
// Video content payloads (packages/video-player)
//
// Data, not code, same as the quiz: a file the runtime already hosts, or a
// YouTube video by id. The player never receives an arbitrary embed URL —
// only a video_id it builds the iframe src from itself — so this cannot
// become a way to smuggle a third-party origin into the sandboxed launch.
// ---------------------------------------------------------------------------
export const videoSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), url: z.string().url(), mime_type: z.enum(["video/mp4", "video/webm"]) }).strict(),
  z.object({ kind: z.literal("youtube"), video_id: z.string().regex(/^[A-Za-z0-9_-]{6,20}$/) }).strict(),
]);
export const videoDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  source: videoSourceSchema,
  poster_url: z.string().url().optional(),
  duration_seconds: z.number().int().positive().max(21600).optional(),
  captions_url: z.string().url().optional(),
}).strict();
export const videoContentSchema = videoDraftSchema.extend({
  object_id: uuid,
  content_version: z.string().regex(/^\d+$/),
  created_at: z.string().datetime(),
}).strict();
export type VideoSource = z.infer<typeof videoSourceSchema>;
export type VideoDraft = z.infer<typeof videoDraftSchema>;
export type VideoContent = z.infer<typeof videoContentSchema>;

// ---------------------------------------------------------------------------
// Document content payloads (packages/document-player)
//
// A PowerPoint or Word file is never shipped to the sandboxed player as-is:
// an offline conversion step (see packages/document-converter) rasterises it
// server-side to one image per page. The player only ever renders images it
// is handed — never a native Office or PDF viewer plugin, which a strictly
// sandboxed iframe cannot reliably host anyway. pdf_url, if present, is
// offered purely as an original-fidelity download link, never as the render
// surface.
// ---------------------------------------------------------------------------
export const documentPageSchema = z.object({
  index: z.number().int().min(0),
  image_url: z.string().url(),
}).strict();
const documentPagesInOrder = { message: "pages must be contiguous, zero-indexed, and in reading order" } as const;
const documentBaseSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  source_format: z.enum(["pptx", "ppt", "docx", "doc"]),
  pages: z.array(documentPageSchema).min(1).max(500),
  pdf_url: z.string().url().optional(),
}).strict();
export const documentDraftSchema = documentBaseSchema
  .refine((d) => d.pages.every((page, position) => page.index === position), documentPagesInOrder);
export const documentContentSchema = documentBaseSchema.extend({
  object_id: uuid,
  content_version: z.string().regex(/^\d+$/),
  created_at: z.string().datetime(),
}).strict()
  .refine((d) => d.pages.every((page, position) => page.index === position), documentPagesInOrder);
export type DocumentPage = z.infer<typeof documentPageSchema>;
export type DocumentDraft = z.infer<typeof documentDraftSchema>;
export type DocumentContent = z.infer<typeof documentContentSchema>;

// ---------------------------------------------------------------------------
// Audio content payloads (packages/audio-player)
// ---------------------------------------------------------------------------
export const audioDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  source: z.object({ url: z.string().url(), mime_type: z.enum(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav"]) }).strict(),
  duration_seconds: z.number().int().positive().max(21600).optional(),
  transcript_url: z.string().url().optional(),
}).strict();
export const audioContentSchema = audioDraftSchema.extend({
  object_id: uuid,
  content_version: z.string().regex(/^\d+$/),
  created_at: z.string().datetime(),
}).strict();
export type AudioDraft = z.infer<typeof audioDraftSchema>;
export type AudioContent = z.infer<typeof audioContentSchema>;

// ---------------------------------------------------------------------------
// LTI 1.3 tool launch content (Resource Link launch only — no Assignment &
// Grades Services, no Deep Linking)
//
// Not a bundle, and not rendered by a sandboxed "module" iframe the way
// quiz/video/document/audio are: the Player Shell itself drives the OIDC
// third-party-login handshake for this content profile, because the launch
// needs real form submission and redirect navigation a sandboxed module
// iframe cannot perform. `client_id` and `deployment_id` are assigned by
// LORB (acting as the LTI Platform) at registration — never accepted from
// the draft — so a tool vendor's own configuration is told these values,
// not permitted to choose them.
// ---------------------------------------------------------------------------
const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), "must be an https URL");
export const ltiToolDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  tool_name: z.string().min(1).max(120),
  /** The tool's own OIDC third-party-initiated login endpoint — where a launch begins. */
  oidc_login_url: httpsUrl,
  /** Where the tool actually opens once the launch's id_token has been delivered. Also the exact
   *  redirect_uri LORB requires the tool's authentication request to name, so a launch cannot be
   *  redirected anywhere the registering repository did not choose. */
  target_link_uri: httpsUrl,
}).strict();
export const ltiToolContentSchema = ltiToolDraftSchema.extend({
  object_id: uuid,
  content_version: z.string().regex(/^\d+$/),
  created_at: z.string().datetime(),
  client_id: z.string().min(1).max(120),
  deployment_id: z.string().min(1).max(120),
}).strict();
export type LtiToolDraft = z.infer<typeof ltiToolDraftSchema>;
export type LtiToolContent = z.infer<typeof ltiToolContentSchema>;

// ---------------------------------------------------------------------------
// Launch context (publisher-authored, versioned with the object)
//
// Configuration a published object carries into its own launch: which theme
// the module should present, and small named settings the module interprets.
// It is data about the experience, never the learner's business and never a
// place for secrets or resource URLs — the module runs sandboxed under a
// strict CSP, so a theme is a *token* the module resolves against assets it
// already ships, and anything credentialed stays server-side.
// ---------------------------------------------------------------------------
const launchThemeToken = z.string().regex(/^[a-z][a-z\d-]{0,31}$/, "a theme is a lowercase token, not a URL");
const launchSettingValue = z.union([z.string().max(256), z.number().finite(), z.boolean()]);
export const launchContextSchema = z.object({
  theme: launchThemeToken.optional(),
  settings: z.record(z.string().regex(/^[a-z][a-z\d_]{0,63}$/), launchSettingValue).optional(),
}).strict()
  .refine((value) => Object.keys(value.settings ?? {}).length <= 16, { message: "at most 16 settings" });
export type LaunchContext = z.infer<typeof launchContextSchema>;

// ---------------------------------------------------------------------------
// Coach relay (packages/experience-relay)
//
// The conversation a coaching player has with its provider goes through a
// server-side relay: the player authenticates with its launch descriptor and
// names an endpoint; the relay holds the real URL and credentials. Nothing
// here ever carries a key, and the endpoint is a name, never an address.
// ---------------------------------------------------------------------------
const relayEndpointName = z.string().regex(/^[a-z][a-z\d-]{0,63}$/, "an endpoint is a configured name, not a URL");
export const coachRelayRequestSchema = z.object({
  endpoint: relayEndpointName,
  messages: z.array(z.object({
    role: z.enum(["learner", "coach"]),
    content: z.string().min(1).max(4000),
  }).strict()).min(1).max(32),
  /** Small named scalars from the object's launch context, passed through for the provider. */
  context: z.record(z.string().regex(/^[a-z][a-z\d_]{0,63}$/), z.union([z.string().max(256), z.number().finite(), z.boolean()])).optional(),
}).strict()
  .refine((value) => Object.keys(value.context ?? {}).length <= 16, { message: "at most 16 context entries" });
export type CoachRelayRequest = z.infer<typeof coachRelayRequestSchema>;
