# LORB-001 — Learning Object Repository and Broker

**Status:** 🟠 DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED
**Lifecycle stage:** Data and Integration complete
**Sections captured:** Metadata, Reuse Review (progressing), Product Intent, UX and Accessibility, Architecture, Data and Integration
**Sections owed:** Responsible AI and Safeguarding, Security (formal), Engineering, QA, DevOps, Certification
**Blockers open:** 17 (7 critical, 9 material, 1 minor)
**Anti-requirements on record:** ~90
**Accountable owner:** OPEN (BLK-03)
**Language:** en-GB

---

## ⚠️ For Agentic AI Tooling (ChatGPT Codex, etc.)

This document is a snapshot of the persisted LORB-001 specification record.
The persisted record remains the source of truth.

**Codex must:**
- Treat this document as **constraints**, not permissions
- Never generate code that violates any anti-requirement in Section 9
- Never treat an open blocker (Section 8) as closed
- Never ratify an ADR
- Never claim compliance with an open contract item
- Pause and escalate when an instruction conflicts with this document
- Route decisions to the accountable human owner

**Codex must not:**
- Approve this specification
- Certify architecture, privacy, security or accessibility
- Merge code that closes a blocker without human ratification
- Deploy software
- Accept a shortcut that violates SDD Non-Negotiable Rules

---

## 1. Product Intent

LORB is a metadata-driven, repository-scoped platform capability for registering,
resolving, launching, presenting and instrumenting reusable learning objects
across ActiveHub and approved consuming platforms.

**Positioning:**
- Net-new capability within ActiveHub
- Replicates PRIZM (does not reuse or replace); coexistence + phased migration
- Authentication reused from ActiveHub + IES
- Audience: corporate, HE, **K-12** and adult
- **Children's data in scope** (K-12)
- **Personal data in scope** as processor — launch contracts carry pseudonymous user identifier
- xAPI actors are pseudonymous

**Goals:** G-01 canonical learning-object model; G-02 stable launch contract;
G-03 decouple consumers/players/providers; G-04 governed extensibility;
G-05 progress and evidence services; G-06 observable operations;
G-07 controlled migration and coexistence.

**Non-goals:** LORB is not an LMS, SIS, CMS, authoring system, gradebook
dashboard, analytics dashboard, entitlement engine, identity provider or AI
runtime. LORB does not replace PRIZM.

**Success measures:** 22 measures with proposed targets and instrumentation
approach (E.1 through E.10e). All are PROPOSED, none are certified.

**Risks:** 20 named risks (R-01 through R-20) with consequences and required
responses. R-20 explicitly warns that success metrics existing only in the
specification would repeat the AHCTL-02 failure mode.

## 2. UX and Accessibility

**Design system:** Pearson Design System (ActiveHub-approved layer; specific
version OPEN).
**Accessibility standard:** WCAG 2.2 AA on management surfaces and
LORB-controlled player chrome.
**EAA:** design for alignment by default; legal scope determination required.
**Language:** en-GB.
**Personas:** 6 primary (Learner, Teacher, Curriculum Service, Consuming
Platform, Content Publisher, Platform Integrator), 4 supporting
(Content Ops, Repository Admin, Player Admin, Launch Policy Admin, Ops Admin),
3 non-human (Curriculum Service, Consuming Platform, Automated Ingestion).

**Player chrome:** Unified shell with delivery-profile modules.
15 mandatory common chrome items + 8 conditional + 6 explicit exclusions.

**Error taxonomy:** 22 machine-readable codes (LAUNCH_CONTEXT_INVALID,
AUTHENTICATION_EXPIRED, ACCESS_DENIED, ENTITLEMENT_UNAVAILABLE, OBJECT_NOT_FOUND,
OBJECT_NOT_PUBLISHED, OBJECT_RETIRED, PACKAGE_UNAVAILABLE, PLAYER_UNSUPPORTED,
BROWSER_UNSUPPORTED, NETWORK_INTERRUPTED, PROVIDER_UNAVAILABLE, STATE_LOAD_FAILED,
STATE_SAVE_FAILED, ATTEMPT_CONFLICT, ATTEMPT_LIMIT_REACHED, SESSION_EXPIRED,
CONTENT_SECURITY_BLOCKED, PLAYER_RUNTIME_ERROR, EVIDENCE_DELIVERY_DELAYED,
UNKNOWN_ERROR + one canonical fallback). Instrumentation target: ≥95% not
UNKNOWN_ERROR.

**Cross-platform UX contract:** 20 explicit "LORB shall not" rules; 20 required
consumer inputs.

**Age-appropriate design:** driven by declared product context, **not inferred
from behaviour**. UK ICO Children's Code mapping is OPEN.

**Voice:** British English; friendly, calm, concise, non-blaming, action-oriented.
Prohibited language list captured (e.g. no "invalid JWT", no "403" shown to
learners).

## 3. Architecture

**Hosting:** Railway EU West (Amsterdam) for stateless application plane.
**⚠️ UK residency conflict:** Railway has no UK region. Learner data must live
outside Railway in a UK-hosted Pearson data plane. Recorded as ADR-17.

**Pattern:** Mixed model — Runtime, Control Plane, Workers as deployable units;
Player Shell + Modules, Admin/Publisher App and Developer Portal as separate
presentation deployments.

**Logical components:** 17 consolidated into named bounded modules
(Edge/API ingress, ActiveHub runtime BFF, Identity/token adapter, Repository,
Learning-object registry, Package and version service, Ingestion and validation,
Catalogue search, Launch resolver, Launch-policy engine, Descriptor and token
issuer, Player shell, Player-module registry, Provider-adapter framework,
State and attempt service, Evidence and callback service, Admin/audit/ops).

**Tenancy:** Multi-repository shared platform with 5 isolation levels
(PlatformTenant, Repository, Consumer, Organisation, LearningObjectAndVersion).

**Domain:** Learning Experience Delivery. **Accountable Technical Owner: OPEN** (BLK-03).

**Technical Hub reuse:** IES/ForgeRock for identity; Entra ID for workforce
(where approved); OAuth2/OIDC + RBAC + repository-scoped ABAC for authorisation;
Autobahn/Kafka for enterprise events; durable outbox for Railway-local work;
OpenTelemetry to approved enterprise destination; Pearson gateway/WAF for
public API; DAC/GCP for analytics projections; LORB-local Postgres full-text
search initially; upstream-preferred or UK S3-compatible for assets.

**BFFs:** ActiveHub Runtime BFF, LORB Administration BFF, Developer Portal API.

**Launch flow:** Mixed model — standard embedded, redirect (LTI/provider),
one-shot resolver. Descriptors are short-lived asymmetric JWS signed with
JWKS-rotated keys.

**State and attempt:** attempt-state + learner-object state; 8-state attempt
FSM (CREATED → STARTED → SUSPENDED → RESUMED → COMPLETED / ABANDONED / EXPIRED /
VOIDED); UK-resident storage.

**LRS:** External approved LRS reused; Spectrum preferred but not confirmed
(BLK-12).

**PRIZM coexistence:** 5-state authority model, one-way import,
active-attempt migration prohibited, consumer sees a stable facade.

**ADRs:** 25 recorded (ADR-01 through ADR-19 primary + ADR-20 through ADR-25
recommended additional). All DRAFT, none ratified.

**Anti-requirements:** 40 explicit architectural refusals.

## 4. Data and Integration

### 4.1 Entity Model
~40 canonical entities using UUIDv7 (UUIDv4 permitted where standards require).
Slugs are aliases only; never used for authorisation or as partition keys.

Entities carrying pseudonymous learner reference: 11.
Entities explicitly prohibited from carrying pseudonymous learner reference: 14.

### 4.2 Systems of Record
LORB owns 21 entity classes.
Federated: IES (identity), GPS (course/roster/assignment), Entitlement
(commercial access), ActiveHub (consumer UX context), Spectrum LRS (durable
xAPI), DAC/GCP (analytics), Insights (teacher visualisation), Providers
(runtime), PRIZM (during coexistence).

### 4.3 API Surfaces
6 public surfaces behind Pearson gateway:
- Runtime `/api/v1/runtime`
- Publisher `/api/v1/publisher`
- Administration `/api/v1/admin`
- Integrator `/api/v1/integrator`
- Evidence `/api/v1/evidence`
- Callback `/api/v1/callbacks`

All state-changing endpoints require idempotency.
All errors use RFC 9457 problem details format.
The 22 UX error codes are a public subset of the API error catalogue.

**API versioning:** Six surfaces share `/api/v1/*`; per-surface deprecation
notice periods differ. Independence policy OPEN (BLK-14).

### 4.4 Events and Callbacks
- ~40 event types produced under `lorb.<domain>.<event>.v1` convention
- 13 candidate semantic subscriptions from GPS, entitlement, ActiveHub, IES,
  provider registry (physical topic names OPEN — BLK-10)
- 11 supported integrator callback types, 8 explicitly not exposed
- Delivery: at-least-once, signed, HTTPS, DLQ
- Receiver contract: dedupe on `(subscription_id, event_id)`; return 2xx for
  duplicates; do not repeat business effect
- Envelope: CloudEvents 1.0; schemas: JSON Schema with SemVer
- No global ordering; per-aggregate ordering where broker supports

### 4.5 Schema Contracts
- **Launch descriptor:** compact JWS, `alg=ES256`, `typ=lorb-launch+jwt`,
  20 required claims + 16 conditional. Explicitly prohibits: learner name,
  email, DoB, class roster, arbitrary free text, provider secrets, arbitrary
  return_url, arbitrary theme tokens, arbitrary callback endpoint.
- **Player manifest:** immutable versioned manifest with viewport, security,
  accessibility subsections.
- **Package manifest:** 20 required fields + 5 conditional + 5 prohibited.
- **xAPI profile:** LORB Core Evidence Profile (11 verbs, 10 contextual
  extensions, actor is pseudonymous account object, no learner audio/uploaded
  image/unbounded free text). Compatibility with unnamed Pearson profile
  refused until profile is named (BLK-13).
- **postMessage protocol:** versioned; 12 message types; explicit origin
  validation; no wildcard origins.
- **Accessibility declaration:** 26 required fields + 5 conditional; formal
  versioned schema at `https://contracts.lorb.example/schemas/accessibility-
  declaration/1.0`.

# 10. Codex Usage Notes

**When using this document as Codex context:**
- Load Section 9 (anti-requirements) into the system prompt so Codex applies
  them as constraints on every generation
- Load Section 8 (blockers) so Codex does not attempt to close a blocker
  through code
- When Codex is asked to implement an endpoint, cross-reference the API
  surface in Section 4.3 and the schema contract in Section 4.5
- When Codex is asked to implement an event producer or consumer,
  cross-reference Section 4.4 delivery guarantees and pseudonym enrichment
  rules
- When Codex is asked to implement pseudonymisation, use the exact HMAC-SHA-256
  formulation in Section 4.6 and route the tenant-specific secret through a
  UK-hosted secret manager, not Railway variables
- When Codex generates test scaffolding, require the 16 fixture types per
  contract from Section 4.10 with synthetic identities only
- When Codex proposes a change that touches a public contract, require the
  6-state lifecycle transition and appropriate deprecation notice from Section
  4.11
- If Codex is asked to accept a shortcut that violates any anti-requirement,
  pause and escalate to the accountable owner

**The Codex workflow must never:**
- Merge code that closes a blocker without human ratification
- Deploy software from this specification
- Certify architecture, privacy, security or accessibility
- Ratify an ADR
- Bypass the residency constraint in ADR-17
- Weaken pseudonymisation to simplify testing
