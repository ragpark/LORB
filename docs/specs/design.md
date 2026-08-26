# LORB — Learning Object Repository and Broker

The human-readable half of the record. [`spec.yaml`](spec.yaml) holds the structured version;
neither silently overrides the other, and a contradiction between them is a blocking question rather
than a preference.

This document explains the decisions that are not obvious from the code, and the ones that were made
against a plausible alternative. Where something is not built, it says so.

---

## 1. Product intent

LORB registers, resolves, launches, presents and instruments reusable learning objects. A consumer
asks for a launch; LORB answers with a short-lived signed descriptor naming exactly one immutable
version of one piece of content, hosts that content in a sandboxed player, holds the attempt's state
and lifecycle, and delivers the resulting xAPI evidence to a learning record store.

**Audience:** corporate, higher education, K-12 and adult. Children's data is therefore in scope, and
age-appropriate treatment is driven by the declared product context — never inferred from a learner's
behaviour.

**Not:** an LMS, an SIS, a CMS, an authoring tool, a gradebook, an analytics dashboard, an
entitlement engine, an identity provider, or an AI runtime. Each of those exclusions is load-bearing:
LORB brokers a launch and owns the evidence trail, and every capability it declines is one somebody
else already does better.

## 2. Identity, and why LORB has none of its own

Learners and administrators sign in through the institution's own identity provider. LORB verifies
access tokens against that provider's JWKS and does nothing else with identity: it issues no
credential, holds no password, and stores no directory.

What it stores is a pseudonym — `HMAC-SHA-256(tenant secret, issuer | subject | purpose)` — and that
pseudonym is the actor on every attempt and every xAPI statement.

The consequential decision is that **the reverse mapping is never stored**. A class result is built
by recomputing each roster member's pseudonym at read time and matching; the pairing exists for the
duration of that request and then it is gone. The obvious alternative — a `learner_id → pseudonym`
table — would make several features simpler and would also be a standing re-identification table
sitting in the database, which is precisely the artefact pseudonymisation is supposed to avoid. The
cost of the choice is real: results queries recompute, and rotating the tenant secret orphans every
historical actor. Both are accepted deliberately.

### The development sign-in

A build with no provider configured falls back to a local sign-in that mints a token for whatever
subject it is handed. That is not authentication, and it is confined by the same build-time check
twice over: an image not labelled `DEVELOPMENT` must name a real provider, and must carry no
development sign-in endpoint at all.

The endpoint *is* a build argument, which it briefly was not. Refusing it outright looked stricter and
was not: it left the localhost default compiled into every image, so a development deployment could
not sign in at all — the browser tried to reach the developer's own machine — while doing nothing
about the risk, which is a non-development image carrying a sign-as-anyone path. The ban now sits on
that condition instead of on the argument.

What this does not do is make a deployed development environment safe to put real people in. A
development identity provider reachable on the internet is a way in for anyone who finds it,
whether or not a front end offers the button. That is a property of choosing to deploy one.

## 3. Persistence, and why in-memory is refused

Postgres is the system of record for attempts, launches, idempotency records, the evidence outbox,
assignments, smart links, the catalogue, the roster and the audit trail. A replica holds nothing that
matters and can be replaced at any moment.

An in-process implementation of the same interface exists for tests and for `pnpm dev` without a
database. Production configuration refuses to start when it would be selected, and the readiness
probe reports not-ready if a production replica somehow reaches it. Two backends behind one
asynchronous interface is a small ongoing cost; the alternative — a synchronous store — is what tied
the earlier implementation to a single process, so the interface is asynchronous throughout even
where the in-memory backend does not need it to be.

**Attempt state uses optimistic concurrency**, and the revision check is in the `where` clause of a
single statement rather than a read followed by a write. A read-then-write leaves a window in which
another replica bumps the revision between the two, and both writers believe they applied cleanly.

## 4. The launch contract

`POST /api/v1/runtime/launches` requires an idempotency key, verifies the caller's access token
against the configured provider, resolves the object, applies the launch policy governing the
repository, and returns a JWS descriptor.

Four decisions worth naming:

**An unknown, unpublished or cross-repository object is refused.** The earlier implementation fell
back to a default package. That is a silent substitution: the learner gets an activity nobody
assigned, and the evidence records a different object than was launched. A 404 is the correct answer.

**A pinned player wins over a launch policy.** A policy routes a renderer for content that does not
care which one it gets. Content whose payload only one player can present does care, and letting a
policy override that pin silently substituted the renderer. The pin is honoured only when the object
actually belongs to the repository being launched — otherwise naming any known shared-player object
alongside any repository would bypass that repository's policy, since the request carries both
identifiers and nothing forces them to agree.

**An idempotency key replayed against a different body is refused, not replayed.** Replaying would
hand the caller a response to a request they did not make.

**The descriptor names an object version and a package version explicitly.** Never "latest". Evidence
recorded against a descriptor therefore says what was actually delivered, which is the whole reason
the versions are immutable.

## 5. The signing key ring

Descriptors are signed ES256 with a key that comes from configuration and is shared by every replica.
The previous per-process keypair made a descriptor verifiable only on the replica that issued it, and
only until that process restarted.

Rotation uses an overlap window rather than a cut-over: one `ACTIVE` key signs, one or more
`RETIRING` keys stay in the JWKS and stay accepted on verification. Verification resolves by the
`kid` the token names rather than trying every key, so a token signed by a key that has left the ring
fails immediately instead of being probed against keys it was never meant for. Descriptor lifetime is
minutes, so the overlap needs to be short — but it cannot be zero.

## 6. Evidence

Acceptance and delivery are separated. The Evidence API binds a statement to the pseudonym its
descriptor names and the attempt it was launched for, writes it to a durable outbox, and answers 202.
A worker delivers from that outbox.

The separation is the point: a learner's activity must not depend on the learning record store being
reachable at that moment, and a statement that was accepted must never be lost because delivery
failed. The previous implementation walked an in-memory map once and marked anything that was not a
200 as failed, permanently — so a learning record store that was briefly unreachable silently
destroyed the evidence for every attempt in that window.

What replaces it:

- Rows are claimed with `for update skip locked`, so every replica can run a forwarder and no
  statement is delivered twice. A row held by a worker that died is reclaimed after a stall window.
- A transient failure retries with exponential backoff and full jitter. Without jitter every replica
  retries the same batch at the same instant after an outage, which is when the receiver can least
  absorb it.
- A 4xx that is not 408 or 429 is **not** retried. A statement the receiver considers malformed will
  not become well-formed on the tenth attempt, and retrying it starves the queue behind it.
- Exhausted or permanently rejected statements become dead letters: visible, replayable, never
  discarded. A database trigger refuses any update to an accepted statement's payload and refuses
  deletes outright, so a correction is a superseding statement rather than a rewrite.
- Delivery uses `PUT /statements?statementId=…`, which is what makes it idempotent at the receiver.

## 7. The player boundary

The Player Shell embeds a module in an iframe sandboxed without `allow-same-origin`. The module's
origin is therefore opaque, which means a `postMessage` aimed at the package origin never arrives and
messages from the module arrive with the origin string `"null"`.

Rather than relax the origin policy, the two establish a `MessageChannel`. A module asks for it in a
single `module.hello` message authenticated by three things together: the message came from the
shell's own iframe, the origin is the pinned package origin or the opaque `"null"` (never a
wildcard), and it presents the per-launch nonce the shell placed in the iframe URL fragment.

The nonce binds the handshake to a *document*, not to a browsing context. Window identity alone is
not enough: a redirect or a self-navigation keeps the same `WindowProxy` and the same opaque origin,
and `frame.src` still reads the pinned package URL, so nothing else distinguishes a replacement
document. Only a document the shell itself navigated to receives the fragment.

The residual risk, stated rather than hidden: a `package_url` that redirects off-origin on the very
first load carries the fragment to the redirect target, and the embedding page cannot detect that
from inside the browser. `frame-src 'self'` closes it where the topology allows.

A module may open its channel more than once, and the shell accepts the later `module.hello` rather
than ignoring it. A framework that mounts, tears down and remounts its root closes the first port and
sends a fresh hello; while the shell kept the first port it went on replying down a channel whose
other end was closed, and the module waited for a context that could never arrive — no error, no
console output, an activity that simply never started. Accepting the later hello is no weaker than
accepting the first: every check still applies, and the launch nonce is what authenticates it, so a
document that replaced the module in the same browsing context has already ended the session.

The opaque origin reaches further than the module. A consumer that embeds the *shell* the same way —
which the Learner Portal does — gives the shell an opaque origin too, so the shell's own calls also
arrive as `Origin: null`. Every route a launch needs therefore accepts `"null"`: the key set, attempt
state, completion, content, and evidence. Evidence was the one that did not, and the failure was
silent — the activity rendered, played and completed while the browser refused every statement before
it left the page. Nothing else accepts `"null"`, and no wildcard exists anywhere in the policy.

## 8. Administration and separation of duties

Repository membership carries authorisation; every administrative action is checked against it.
Actions listed in `ADMIN_APPROVAL_REQUIRED_FOR` cannot be performed directly: one administrator
requests, a different one approves, and only then can it be executed.

Three layers enforce that, and the third is the one that matters: the workspace disables the control,
the API refuses the call, and a Postgres `CHECK` constraint refuses a row whose approver equals its
requester. The first two can be bypassed by a client or a bug. The third cannot be bypassed at all.

Immutability works the same way. A player version's module URL, origin and integrity hash freeze once
it leaves `REGISTERED`/`TESTING`; a published launch-policy version's rules and semver freeze on
publication. Both are database triggers, not application checks, because the property being protected
is "what a launch resolves to only changes through a version somebody approved".

## 9. The agent connector

A remote MCP server that lets a teacher's assistant draft a quiz, register it, assign it and read
back results — through the real pipeline, not a mock of it.

**A quiz is data, not code.** `create_quiz` writes a structured JSON payload rendered by one fixed,
already-reviewed player package. Nobody registers a bundle per quiz, so there is no per-quiz
code-injection surface and bumping the package version is a content-model change rather than a
routine deploy. The answer key is served only on the learner-facing content route.

**Two trust domains that never share a credential.** The agent session authenticates against the
identity provider; the connector reaches the Runtime API's internal surface with a separate service
credential. Configuration refuses to start if they are the same value.

**Roster access is scoped by an explicit link.** The service credential authenticates the *connector*,
not the person using it, so on its own it scopes nothing — and for a time it did not, which meant any
authenticated teacher could read any other teacher's class metadata. Scoping needs the agent's
identity to resolve to a teacher, and that cannot be computed: nothing joins an agent principal to a
portal account, deliberately. So the link is explicit and teacher-created, and it fails closed — an
unlinked principal sees an empty class list and a 404 on any class it names, including one whose
identifier it already knows.

An inferred join, on a matching email say, would be more convenient and would be wrong for one person
in a thousand — which is the wrong error to make about who can see a child's results.

## 10. Smart links

A published object can have a durable, revocable link that opens straight into the Player Shell with
no consumer application and no sign-in. The learner is a pseudonym derived from a random identifier
in a long-lived cookie, namespaced by a fixed `smart-link` issuer so it can never collide with a
pseudonym from a genuine sign-in. The token is stored only as a hash and returned once.

The trade-off is the feature, not a flaw in it: anyone holding the link can launch that object,
indefinitely, anonymously. That suits an open resource. It does not suit graded work, which is why
class assignment goes through the authenticated path instead and never returns a descriptor to the
assigning caller.

## 11. Operations

Structured JSON logs redacted at the serialiser — a redaction that depends on every call site
remembering it is a redaction that will leak. Prometheus metrics with route labels taken from the
matched route rather than the raw URL, because an unbounded label set is how a metrics endpoint
becomes an outage. A correlation identifier on every request, echoed to the client and written to
every log line for that request.

Liveness (`/health`) is deliberately dependency-free and readiness (`/ready`) is not. Wiring liveness
to the database turns a database blip into a rolling restart of the whole fleet at exactly the moment
the database is least able to cope with a fleet of reconnects.

Runbooks in [`../runbooks/`](../runbooks/).

## 12. What is not built

Named in the original scope, deliberately absent, and not stubbed — a caller gets a 404, not a
pretend answer:

- **Integrator and callback APIs.** Outbound event delivery to third-party systems.
- **Provider adapters.** Content hosted and run by an external provider.
- **SCORM, cmi5 and LTI.** Only the native web package delivery profile exists.
- **PRIZM coexistence and migration.** No authority model, no import.
- **Developer portal.**

Adding any of them is new work against this record, not a gap in it.

## 13. What the code cannot decide

Listed in `spec.yaml` under `operator_prerequisites`, and repeated here because it would be worse to
leave implicit: data residency, a data protection impact assessment, a manual accessibility audit, a
threat model against the deployed topology, the learning record store contract, and who may publish
content and under what review.

None of these blocks the software, and none of them is a defect. They are decisions belonging to
whoever deploys LORB and owns the data in it, and the platform is built so that each can be answered
without changing code — the residency choice is a database location, the retention decision is a
learning record store contract, the publishing decision is a membership grant.

## 14. For contributors and coding agents

The anti-requirements in `spec.yaml` are constraints on every change, and most have a test that fails
if the control is removed. Before changing one, understand what it is protecting; several exist
because the obvious implementation was tried and was wrong.

Treat as contract changes, needing a review that considers every consumer rather than only the caller
that prompted them:

- the launch descriptor schema
- the pseudonymisation function, its inputs, or the tenant secret
- the error taxonomy
- the postMessage protocol
- the xAPI statement contract
- anything in the enforced-control list

And two rules that hold whoever is writing the code:

- **Do not weaken pseudonymisation to simplify a test.** If a test needs the mapping, the test is
  asking the wrong question.
- **Do not add a second way in.** Every credential path that exists is one somebody has to reason
  about; a development shortcut left reachable in production is how a platform with good
  authentication ends up with none.
