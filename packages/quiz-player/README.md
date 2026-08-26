# Quiz player

One reusable native-web-package player for multiple-choice quizzes. It contains **no quiz content**:
it renders a structured JSON payload attached to a learning object and fetched at runtime from
`GET /api/v1/runtime/learning-objects/:objectId/content`.

This is the whole point of the package. Whoever drafts a quiz — a person or an agent — produces
*data*, registered against this one fixed, already-reviewed package version. Nobody generates or
registers a JavaScript bundle per quiz, so there is no per-quiz code-injection surface to review, and
bumping the package version identifier is a content-model change rather than a routine deploy.

## Evidence

On a completed attempt the player emits, over the Player Shell's `evidence.emit` channel:

1. `launched` — once, when the content payload has loaded.
2. `answered` — once per answered question, carrying `result.response` (the chosen **option id**,
   never free text) and `result.success`.
3. `completed` — once, carrying `result.score.scaled`, `result.success`, and `result.completion`.

The actor is the LORB pseudonym relayed in `shell.context`, using the existing pseudonymisation
scheme unchanged. The player never sees a platform learner identifier and never emits one.

## Known limitations

- **Marking is client-side.** The content payload the player fetches therefore contains
  `correct_option_id`. That key is served only on the learner-facing content route and is returned by
  no administration, publisher or agent-facing surface — but a determined learner can read it from
  their own browser. Suitable for formative practice; not suitable for a graded assessment. Moving
  marking behind the Evidence API would close it, at the cost of a round trip per question.
- **The 0.6 pass mark in `markQuiz` is a default, not a policy.** A grading policy belongs in the
  delivery-profile manifest, and none has been agreed.
- `statements.ts` is DOM-free so the end-to-end suite exercises the same marking and statement
  construction the browser runs, rather than a second copy of it.
