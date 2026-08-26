# Enforced controls

Properties the platform must hold, each with a test that fails if the control is removed. They are
kept together and named as controls, rather than scattered through feature suites, so that removing
one is a visible act rather than a silent consequence of a refactor.

## The controls

### Launch descriptors

| Control | Enforced by |
| --- | --- |
| No learner name, email, date of birth or arbitrary free text | `enforcement.spec.ts` — descriptor schema |
| No floating player reference (`…-latest`) | `enforcement.spec.ts` |
| No mutable package pointer | `enforcement.spec.ts` |
| Lifetime bounded to minutes | `contracts/src/index.ts` schema refinement |
| Signed by a configured key, verified by `kid` against the published JWKS | `signing-keys.spec.ts` |
| A descriptor signed by a retiring key still verifies; one signed by a key that has left the ring does not | `signing-keys.spec.ts` |

### Launch

| Control | Enforced by |
| --- | --- |
| An idempotency key is required | `enforcement.spec.ts` |
| An identical retry replays the original response | `enforcement.spec.ts` |
| A key reused for a *different* request is refused, not replayed | `enforcement.spec.ts` |
| An unknown, unpublished or cross-repository object is refused, never substituted | `enforcement.spec.ts`, `admin-enforcement.spec.ts` |
| Access tokens are audience-bound | `enforcement.spec.ts` |
| A pinned shared player wins over a launch policy, but only within its own repository | `admin-enforcement.spec.ts` |

### Attempts

| Control | Enforced by |
| --- | --- |
| Illegal lifecycle transitions are refused; terminal states are terminal | `enforcement.spec.ts`, `store/transitions.ts` |
| State writes use optimistic concurrency: one of two concurrent writers wins | `persistence.spec.ts` |
| A completion applied twice happens once | `persistence.spec.ts` |
| State keyed on anything that looks like personal data is refused | `runtime-api/src/app.ts` |
| An attempt whose session window passed reaches a terminal state | `persistence.spec.ts` |

### Evidence

| Control | Enforced by |
| --- | --- |
| A statement is bound to the actor its descriptor names | `enforcement.spec.ts` |
| A statement is bound to the attempt it was launched for | `evidence-api/src/app.ts` |
| Statement UUIDs deduplicate; a repeat has no second effect | `enforcement.spec.ts`, `persistence.spec.ts` |
| An accepted statement's payload cannot be rewritten, and cannot be deleted | `persistence.spec.ts` — database trigger |
| A failed delivery is retried, then dead-lettered — never discarded | `delivery.spec.ts` |
| A permanently rejected statement is not retried for ever | `delivery.spec.ts` |
| A replay names the statement it expects, so it cannot be aimed elsewhere | `delivery.spec.ts` |
| Two forwarder replicas never claim the same statement | `persistence.spec.ts` |

### Origins and isolation

| Control | Enforced by |
| --- | --- |
| No wildcard `postMessage` origin | `enforcement.spec.ts`, `postmessage.spec.ts` |
| No unlisted `postMessage` origin | `enforcement.spec.ts`, `postmessage.spec.ts` |
| No wildcard CORS, and no built-in origin nobody reviewed | `cors.spec.ts` |
| A wildcard or path in the configured origin list is refused at start-up | `cors.spec.ts` |
| The module iframe runs without `allow-same-origin` | `enforcement.spec.ts` |
| The opaque player origin is accepted on player routes only | `cors.spec.ts` |

### Logs and configuration

| Control | Enforced by |
| --- | --- |
| Credentials and learner-entered content are redacted at the serialiser | `enforcement.spec.ts` |
| A production process refuses in-memory persistence | `configuration.spec.ts` |
| …an ephemeral signing key | `configuration.spec.ts` |
| …the development identity provider | `configuration.spec.ts` |
| …example content in the catalogue | `configuration.spec.ts` |
| …an empty origin allow-list, or an unauthenticated learning record store | `configuration.spec.ts` |
| A deployed front end cannot be built without an identity provider | `learner-portal-deployment.spec.ts` |
| The local sign-in is reachable only in a development environment | the three front-end enforcement suites |

Run them with `pnpm test`. Several need a real Postgres, because the property does — optimistic
concurrency, `for update skip locked` claiming and the append-only trigger do not exist without one,
so a run with no database would be green and worthless. `pnpm test:browser` covers the one hop the
others cannot reach.

## postMessage origin policy

`originAllowed` implements two of the controls above and refuses the opaque origin a sandboxed module
reports, so the module channel cannot run over `postMessage` to a window origin at all.

Instead a module opens a `MessageChannel` and asks for it in a single `module.hello` message,
authenticated by `handshakeAllowed`, which requires all of:

- the message came from the shell's own iframe (`event.source === frame.contentWindow`);
- the origin is either the pinned package origin or the opaque `"null"` — never a wildcard;
- the message presents the per-launch nonce the shell placed in the iframe URL fragment.

The nonce is what binds the handshake to a *document* rather than to a *browsing context*. Window
identity alone is not enough: a redirect or a self-navigation keeps the same `WindowProxy` and the
same opaque origin, and `frame.src` still reads the pinned package URL, so nothing else can tell the
replacement document apart. Only a document the shell itself navigated to receives the fragment.

The shell accepts exactly one handshake per launch, carries all later traffic on the port, and ends
the session if the document under an established channel changes.

**Residual risk.** A `package_url` that 302s off-origin on the very first load carries the fragment to
the redirect target, and the embedding page cannot detect that from inside the browser. A `frame-src`
CSP on the Player Shell closes it at the browser level; the shipped nginx image serves modules from
the shell's own origin, so `frame-src 'self'` fits that topology — but it would break a deployment
that hosts packages on a separate origin, so it is not imposed here. Set it if your topology allows.

Covered by `tests/player-shell/postmessage.spec.ts` and `tests/browser/player-launch.spec.ts`.

## Agent connector

`tests/mcp-connector/` enforces the properties the connector was built against:

- A bad or missing token is rejected with `401` and a spec-shaped `WWW-Authenticate: Bearer`
  challenge; the pre-shared token mode is refused outright in production.
- `create_quiz` returns no answer key: no `correct_option_id`, no explanation, and no option or stem
  text it could be reconstructed from.
- `assign_quiz` is annotated `readOnlyHint: false, destructiveHint: false`, its description names the
  consent requirement, and it returns no launch descriptor, player URL, or platform learner
  identifier.
- A repeated idempotency key is a duplicate, not a second assignment.
- The `launched` → `answered` → `completed` chain goes through the real Evidence API, the real
  forwarder and the real read model — never canned data.
- The assignment record and the results read model hold pseudonyms only.
- An agent principal with no explicit teacher link sees nothing, rather than seeing every class.
