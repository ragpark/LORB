# quiz-player

> **DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED — LOCAL DEV ONLY.**

One reusable native-web-package player for multiple-choice quizzes. It contains **no quiz content**:
it renders a structured JSON payload attached to a learning object and fetched at runtime from
`GET /api/v1/runtime/learning-objects/:objectId/content`.

This is the whole point of the package. An AI agent that drafts a quiz produces *data*, registered
against this one fixed, already-reviewed package version — it never generates or registers a
JavaScript bundle, so there is no per-quiz code-injection surface to review.

## Evidence

On a completed attempt the player emits, over the Player Shell's `evidence.emit` channel:

1. `launched` — once, when the content payload has loaded.
2. `answered` — once per answered question, carrying `result.response` (the chosen **option id**,
   never free text) and `result.success`.
3. `completed` — once, carrying `result.score.scaled`, `result.success`, and `result.completion`.

The actor is the LORB pseudonym relayed in `shell.context`, using the existing pseudonymisation
scheme unchanged. The player never sees a platform learner identifier and never emits one.

## PoC limitations

- Marking is **client-side**. The content payload the player fetches therefore contains
  `correct_option_id`. That key is served only on the learner-facing content route; it is never
  returned by the agent-facing MCP connector.
- The 0.6 pass mark in `markQuiz` is a placeholder. LORB-001 has taken no grading policy decision.
- `statements.ts` is DOM-free so the end-to-end smoke test exercises the same marking and statement
  construction the browser runs.
