# Context-routed coach (example module)

A worked example of the launch-context path, end to end: a publisher versions a theme and settings
on a learning object, this module reads them, styles itself, and names a relay endpoint derived from
the course. The relay picks the concrete provider. Nothing here is specific to coaching — the same
path carries any "decide at the backend what this launch should do" requirement.

It is deliberately one static HTML file with no build step, like `example-coaching-chatbot`: the
point is the protocol, and a reader should be able to follow the whole path without a bundler in
the way.

## The path

1. **Publisher sets the context.** `PUT /api/v1/publisher/learning-objects/:objectId/launch-context`
   with `{theme, settings}`. This creates a new object version — context is versioned content, not
   mutable config.
2. **Shell hands over a pinned content URL.** The module opens a `MessageChannel`, sends
   `module.hello` with the launch nonce from its URL fragment, and the shell answers `shell.context`
   on that port carrying identifiers and a `content_url` already pinned to the descriptor's object
   version.
3. **Module fetches its context.** `GET {content_url}` returns `launch_context` alongside any
   authored content. Because the URL is version-pinned, an edit published mid-attempt cannot change
   the theme or settings under a learner who is halfway through.
4. **Module decides.** Theme selects a palette the module already ships. `settings.course` selects
   the endpoint *name* it will ask for.
5. **Module asks the shell to call the relay.** `relay.request` on the port; the shell holds the
   launch descriptor and makes the authenticated call; `relay.reply` comes back with the resolved
   endpoint and the provider's answer.

The module never holds the descriptor, and never learns the provider's URL or credentials. The
relay resolves a *name* to a configured endpoint, so rotating a provider or repointing a course is a
deployment change, not a content change.

## Why the endpoint is a name and not a URL

`settings.course` is publisher-supplied data. The module composes `coach-<course>` and checks it
against `^[a-z][a-z\d-]{0,63}$` before using it, falling back to `demo`. A course of `../etc` or a
300-character string is rejected rather than forwarded. Since the relay only ever looks a name up in
a configured map, a name that is not configured is a 404 — it can never become a request to an
address the publisher chose.

## Tier routing

The relay appends the learner's performance tier to the requested name and prefers a configured
variant: `coach-maths-gcse` becomes `coach-maths-gcse-support` or `-stretch` where those exist, and
falls back to the bare name where they do not. The module is told which endpoint answered, which is
why the trace panel shows it — a resolved name with a tier suffix is the visible evidence that
routing happened.

**The tier input is currently a stub.** `stubPriorPerformance` hashes the learner pseudonym; it is
deterministic per learner but is not a read of attempt history, and the relay's own comments say so.
Treat tier routing here as demonstrating the mechanism, not the judgement.

## Deploying it

The module is copied into the Player Shell image at `/modules/context-coach/`. Register it and set
its context with `scripts/publish-context-coach.sh`, and configure providers with
`RELAY_COACH_ENDPOINTS` on the registry app:

```json
{"coach-maths-gcse":         {"url": "https://…", "authorization": "Bearer …"},
 "coach-maths-gcse-support": {"url": "https://…", "authorization": "Bearer …"},
 "coach-maths-gcse-stretch": {"url": "https://…", "authorization": "Bearer …"}}
```

With nothing configured the relay answers from its built-in demo coach, which labels itself as
scaffolding and reports the routing decision it would have made. That is a useful first run: it
exercises the whole path without a provider.
