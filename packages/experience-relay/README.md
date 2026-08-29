# Experience relay

How a sandboxed player reaches an AI provider without ever holding a key. The player authenticates
with its launch descriptor — the same credential it uses to save state and emit evidence — and names
an endpoint; the relay resolves that name to a URL and credentials from operator configuration,
calls the provider server-side, and returns only the reply.

Mounted on the Runtime API process (`src/server.ts`), like the Evidence API.

## Route

`POST /api/v1/relay/coach/messages` — `Authorization: Bearer <launch descriptor>`

```json
{ "endpoint": "coach-default",
  "messages": [{ "role": "learner", "content": "..." }],
  "context": { "topic": "photosynthesis" } }
```

Response: `{ "endpoint": "...", "reply": "...", "correlation_id": "..." }`

A learning object's launch context names the endpoint (`settings.llm_endpoint`); the player passes
it through. An endpoint is a name, never a URL — the request schema refuses anything URL-shaped.

## Configuration

`RELAY_COACH_ENDPOINTS` — a JSON object of name → `{ "url", "authorization"? }`:

```json
{ "coach-default": { "url": "https://your-langgraph.example/coach",
                     "authorization": "Bearer <provider key>" } }
```

URLs must be https (localhost excepted, for development). The provider receives
`{ attempt_id, object_id, pseudonym, correlation_id, messages, context }` and answers with a JSON
body carrying `reply` (or `content`/`message`). Credentials never appear in responses or logs.

The built-in `demo` endpoint answers locally with a canned, clearly-labelled coaching turn and calls
nothing — it exists so the full journey works before any provider is configured, and it is shadowed
the moment an operator configures a real endpoint under that name.
