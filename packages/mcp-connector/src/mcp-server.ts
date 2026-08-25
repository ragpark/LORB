// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION — BLOCKED BY BLK-02, BLK-03, BLK-07, BLK-08, BLK-09, BLK-11.
import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { quizQuestionDraftSchema } from "../../contracts/src/index.js";
import { IdempotencyStore } from "./idempotency.js";
import { LorbServiceError, type BatchLaunch, type LorbClients, type RosterLearner } from "./lorb-clients.js";

export const CONNECTOR_NAME = "lorb-mcp-connector";
export const CONNECTOR_VERSION = "0.1.0";

const DRAFT_BANNER = "DRAFT — NOT CERTIFIED — LOCAL DEV / REVIEW ENVIRONMENT ONLY. Synthetic data only.";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

function serviceMessage(error: unknown, fallback: string): string {
  if (error instanceof LorbServiceError) {
    if (error.status === 404) return "That identifier was not found in the LORB review environment.";
    if (error.status === 401 || error.status === 403) return "The connector is not authorised to call that LORB service. Check its service credential configuration.";
    if (error.status === 503) return "That LORB service is not configured in this environment.";
  }
  return fallback;
}

/** Question shape accepted by `create_quiz`. Structurally identical to the stored content contract. */
const questionInput = z.object({
  stem: z.string().min(1).max(600).describe("The question as the learner reads it."),
  options: z.array(z.object({
    id: z.string().regex(/^[a-z\d_-]{1,16}$/).describe("Short stable option identifier, e.g. \"a\"."),
    text: z.string().min(1).max(300),
  })).min(2).max(6),
  correct_option_id: z.string().regex(/^[a-z\d_-]{1,16}$/).describe("Must match one of the option ids. Never echoed back in the tool result."),
  explanation: z.string().max(1000).optional().describe("Shown to the learner after submission. Never echoed back in the tool result."),
});

export interface McpServerDeps {
  clients: LorbClients;
  assignIdempotency: IdempotencyStore<Record<string, unknown>>;
  newId?: () => string;
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const newId = deps.newId ?? randomUUID;
  const server = new McpServer(
    { name: CONNECTOR_NAME, version: CONNECTOR_VERSION },
    {
      capabilities: { resources: {}, tools: {} },
      instructions: [
        DRAFT_BANNER,
        "This connector drafts and assigns quizzes in a LORB review environment.",
        "Read class:// resources before drafting so questions match what the class has actually been taught.",
        "assign_quiz creates real learner assignments — always confirm with the teacher before calling it.",
      ].join(" "),
    },
  );

  // ---------------------------------------------------------------- resources

  server.registerResource(
    "class-recent-topics",
    new ResourceTemplate("class://{classId}/recent-topics", { list: undefined }),
    {
      title: "Class recent topics",
      description: "Topics recently taught to a class, so generated content is contextually relevant. Synthetic roster data only.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const classId = String(variables.classId);
      const topics = await deps.clients.getRecentTopics(classId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...topics, source: "stub-roster (non-production)" }, null, 2) }] };
    },
  );

  server.registerResource(
    "class-summary",
    new ResourceTemplate("class://{classId}", { list: undefined }),
    {
      title: "Class summary",
      description: "Name, year group, subject, and learner count for a class. Synthetic roster data only; no learner names or identifiers.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const classId = String(variables.classId);
      const summary = await deps.clients.getClass(classId);
      // Learner identifiers and display names are deliberately not exposed on this resource.
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...summary, source: "stub-roster (non-production)" }, null, 2) }] };
    },
  );

  server.registerResource(
    "quiz-results",
    new ResourceTemplate("quiz://{objectId}/results", { list: undefined }),
    {
      title: "Quiz results",
      description: "Aggregated completion and score data for one quiz, read from the LORB Evidence API. Learners are identified by LORB pseudonym only.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const objectId = String(variables.objectId);
      const results = await deps.clients.getActivityResults(objectId);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            ...results,
            // Pseudonyms are what the evidence store holds. Mapping one back to a named learner is a
            // display-layer concern for whoever holds the roster, never something written into a
            // stored xAPI statement.
            pseudonym_note: "Learners are identified by LORB pseudonym. Resolve to a name only at the point of display.",
            source: "LORB Evidence API activity read model",
          }, null, 2),
        }],
      };
    },
  );

  // -------------------------------------------------------------------- tools

  // Discovery. Without this an agent can only read a class whose id it was handed, so every
  // workflow started with a human copying a UUID out of the Consumer UI. Read-only: the roster is
  // created and changed by a signed-in teacher on the web, and there is no tool here that writes to
  // it. The projection this calls returns names, year groups, subjects and counts — never learner
  // names or identifiers.
  server.registerTool(
    "list_classes",
    {
      title: "List the classes available in LORB",
      description: [
        "Lists the classes a teacher has set up, with year group, subject and learner count, so a class can be",
        "chosen without knowing its identifier in advance. Returns no learner names or identifiers.",
        "Read class:// resources for what a class has recently been taught before drafting content for it.",
      ].join(" "),
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      let list;
      try {
        list = await deps.clients.listClasses();
      } catch (error) {
        return failure(serviceMessage(error, "The class list could not be read from LORB."));
      }
      return json({
        classes: list.items.map((entry) => ({
          class_id: entry.class_id,
          name: entry.name,
          year_group: entry.year_group,
          subject: entry.subject,
          learner_count: entry.learner_count,
        })),
        source: "LORB roster (non-production)",
      });
    },
  );

  server.registerTool(
    "create_quiz",
    {
      title: "Create a quiz learning object",
      description: [
        "Registers a drafted quiz in the LORB catalogue as a new learning object with an immutable content payload,",
        "rendered by the fixed, already-reviewed quiz-player package version. No code is generated or uploaded.",
        "The answer key you supply is stored for the player to mark against and is never returned by this tool.",
        "This creates a catalogue entry only — it does not assign anything to any learner.",
      ].join(" "),
      inputSchema: {
        title: z.string().min(1).max(200),
        description: z.string().max(600).optional(),
        subject: z.string().max(80).optional(),
        year_group: z.string().max(40).optional(),
        questions: z.array(questionInput).min(1).max(25),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const draft = { title: args.title, description: args.description, subject: args.subject, year_group: args.year_group, questions: args.questions };
      // Validate against the stored content contract before calling LORB, so a malformed draft fails
      // with a usable message rather than an opaque 400.
      for (const [index, question] of draft.questions.entries()) {
        const parsed = quizQuestionDraftSchema.safeParse(question);
        if (!parsed.success) return failure(`Question ${index + 1} is not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      }
      let registered;
      try {
        registered = await deps.clients.createQuiz(draft, newId());
      } catch (error) {
        return failure(serviceMessage(error, "The quiz could not be registered in the LORB catalogue."));
      }
      // Only object_id and package_version leave this tool. No stems, no options, and above all no
      // correct_option_id or explanation: an agent transcript is not a safe place for a marking key.
      return json({
        object_id: registered.object_id,
        package_version: registered.package_version,
        question_count: registered.question_count,
        answer_key_returned: false,
        next_step: "Confirm with the teacher, then call assign_quiz with a class_id and an idempotency_key.",
      });
    },
  );

  server.registerTool(
    "assign_quiz",
    {
      title: "Assign a quiz to a class",
      description: [
        "CONSENT-CRITICAL: this affects real learners — confirm with the teacher before calling.",
        "Resolves the class roster and creates a LORB assignment, deriving one pseudonymous launch identity per learner",
        "through the platform's normal launch path. Learners open the quiz through their usual signed-in launch;",
        "no shareable or login-free link is created.",
        "Supply a stable idempotency_key: calling again with the same key returns the original result instead of re-assigning.",
      ].join(" "),
      inputSchema: {
        object_id: z.string().uuid().describe("The object_id returned by create_quiz."),
        class_id: z.string().min(1).max(64).describe("The class to assign to, as used by class:// resources."),
        idempotency_key: z.string().min(8).max(200).describe("Client-supplied. Reuse it verbatim on retry to avoid re-assigning."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      // Layer 1 of 3: guards a repeated agent call. The Runtime API still enforces its own launch
      // idempotency, and the Evidence API still deduplicates statement UUIDs.
      const key = `${args.object_id}:${args.class_id}:${args.idempotency_key}`;
      const existing = deps.assignIdempotency.get(key);
      if (existing) return json({ ...existing.value, duplicate: true, first_assigned_at: existing.created_at });

      let roster: RosterLearner[];
      try {
        roster = (await deps.clients.getRoster(args.class_id)).learners;
      } catch (error) {
        return failure(serviceMessage(error, "That class roster could not be resolved."));
      }
      if (roster.length === 0) return failure("That class has no learners on its roster, so there is nothing to assign.");

      let batch: BatchLaunch;
      try {
        batch = await deps.clients.launchBatch(args.object_id, roster, args.idempotency_key);
      } catch (error) {
        return failure(serviceMessage(error, "The assignment could not be created in LORB."));
      }

      const result = {
        assignment_id: batch.assignment_id,
        object_id: batch.object_id,
        class_id: args.class_id,
        assigned_count: batch.assigned_count,
        // Pseudonyms only. Pairing them with learner names here would hand the agent a
        // re-identification table for the whole class; a teacher who needs that reads it in the
        // Consumer UI, where the roster already lives and the pairing never leaves the request.
        pseudonyms: batch.learners.map((learner) => learner.pseudonym),
        results_resource: `quiz://${batch.object_id}/results`,
        duplicate: false,
      };
      deps.assignIdempotency.set(key, result);
      return json(result);
    },
  );

  return server;
}
