# AI coding prompt: refactor LORB into one deployable application

Copy the prompt below into an AI coding tool that has access to the LORB repository. Replace every value in angle brackets before starting, especially the Cookie platform deployment contract. If the platform is actually named differently (for example, “Coolify”), correct the name and links rather than letting the coding tool guess.

---

## Prompt

You are a senior TypeScript platform engineer working directly in the **LORB** repository. Refactor the whole repository from its current collection of separately deployed services into **one coherent pnpm monorepo application, built as one Docker image and run as one container**, suitable for deployment to the **Cookie Citizen Developer Platform**.

### Deployment contract — confirm this before changing code

Use the platform documentation at **<COOKIE_PLATFORM_DOCUMENTATION_URL>** and the following confirmed deployment details:

- Public application URL/origin: **<PUBLIC_ORIGIN_OR_PLATFORM_VARIABLE>**
- Container port variable or required port: **<PORT_CONTRACT>**
- Health-check path: **`/health`** (change only if Cookie requires another path)
- Persistent PostgreSQL connection variable: **<DATABASE_URL_VARIABLE>**
- Persistent filesystem support, if any: **<PERSISTENT_STORAGE_CONTRACT>**
- Docker build context and Dockerfile selection rules: **<BUILD_CONTRACT>**
- Runtime secrets/configuration mechanism: **<SECRETS_CONTRACT>**
- TLS/reverse-proxy behavior, including forwarded headers: **<TLS_PROXY_CONTRACT>**

Do **not** invent Cookie-specific settings, manifests, environment variables, CLI commands, or capabilities. If these details cannot be established from repository context or the supplied official documentation, stop after the audit and list the exact unanswered questions. Do not claim the application is deployable until the contract is known and verified.

### Current repository facts to validate

The repository is already a pnpm workspace; “single monorepo application” does **not** mean flattening every package into one directory. Today it contains:

- a Fastify Runtime API under `packages/runtime-api`, started by `src/server.ts`;
- browser applications for `admin-ui`, `ops-console`, `mock-consumer`, and `player-shell`;
- example learning packages consumed by the Player Shell;
- an Evidence API and Evidence Forwarder;
- synthetic/test-only IES and LRS services;
- several service-specific Dockerfiles and Railway configuration files;
- PostgreSQL migrations and seed data, while important runtime state is still held in memory.

Inspect the repository and correct this inventory before designing the target. Read `README.md`, `CONTRIBUTING.md`, all applicable `AGENTS.md` files, package manifests, Dockerfiles, environment examples, migrations, test documentation, and LORB specifications. Preserve the repository’s warnings, governance gates, and enforced anti-requirements. This refactor is not permission to relabel a draft or synthetic system as production-ready.

### Required target architecture

Implement a **modular monolith** with these properties:

1. **One repository, one lockfile, one root command surface.** Keep sensible workspace package boundaries and shared contracts, but make root-level `build`, `typecheck`, `test`, `dev`, and `start` commands cover every component required by the deployed application. Use `pnpm install --frozen-lockfile` in reproducible builds.
2. **One production process and one listening port.** A single Node/Fastify entry point must serve the APIs, built frontend assets, Player Shell, and learning packages. Do not use a process supervisor or run multiple web servers in the container merely to satisfy “one container.” Background evidence delivery may run as a lifecycle-managed in-process worker, with graceful startup/shutdown and failure handling.
3. **One public origin with explicit routes.** Prefer a route plan such as:
   - `/api/v1/runtime/*` — Runtime API
   - `/api/v1/evidence/*` — Evidence API
   - `/api/v1/admin/*` — Administration API
   - `/admin/*` — Administration UI SPA
   - `/ops/*` — Operations Console SPA
   - `/consumer/*` — non-production Mock Consumer, only when explicitly enabled
   - `/player/*` — Player Shell
   - `/content/*` — immutable/versioned learning package assets
   - `/health` and `/ready` — liveness and dependency-aware readiness

   You may improve these paths, but document the final routing table. Configure every Vite application with the correct base path and replace brittle build-time cross-service origins with same-origin relative URLs or a documented runtime configuration endpoint where feasible. SPA fallbacks must never swallow API, health, or static content 404s.
4. **External PostgreSQL, not a database inside the application container.** Apply migrations through a safe, explicit release/startup mechanism supported by Cookie. Make startup concurrency-safe and fail clearly. Replace in-memory state needed for restarts or multiple replicas with repository-backed PostgreSQL persistence; do not imply persistence where none exists. Retain test fixtures/in-memory adapters only behind explicit test or local-development boundaries.
5. **Production image quality.** Create one root multi-stage `Dockerfile` with a deterministic dependency layer, complete workspace builds, a minimal non-root runtime, production-only dependencies, `NODE_ENV=production`, one `EXPOSE`, an appropriate init/signal strategy, and no source code, compilers, package-manager cache, private keys, or test stubs unless required at runtime. Add a `.dockerignore`. The server must bind to `0.0.0.0` and honor Cookie’s injected port.
6. **Secure same-origin integration.** Re-evaluate CORS rather than blindly retaining the multi-origin configuration. Preserve strict CSP/Helmet behavior, iframe sandbox isolation, exact `postMessage` target/source validation, descriptor signature verification, JWT issuer/audience checks, actor binding, pseudonymisation, idempotency, redaction, UUID validation, attempt transitions, and content isolation. Trust forwarded headers only according to Cookie’s documented proxy topology. Never use wildcard origins as a shortcut.
7. **Secrets and URLs.** Validate configuration once at startup with a typed schema and actionable errors. Derive public callback/descriptor/player/content URLs from one canonical public origin where safe. Secrets must be runtime-only and must never be exposed through Vite bundles, runtime-config endpoints, logs, image layers, or committed files. Document key generation/rotation and distinguish public settings from secrets.
8. **Test-only services remain test-only.** The synthetic IES, stub LRS, Mock Consumer, and demo data must not silently become production dependencies. Decide and document whether each is (a) excluded from the production image, (b) available only behind an explicit non-production flag, or (c) replaced by a real external integration. Default production startup must fail closed if a required real integration is absent.
9. **Backward compatibility is intentional.** Keep API contracts and security behavior stable unless a change is necessary for the one-origin architecture. For every deliberate breaking change, add a migration note, update clients atomically, and add a regression test. Remove obsolete per-service Docker/Railway files only after their replacements are working and documented; do not leave contradictory deployment paths.
10. **Operational behavior is explicit.** Add structured logs, correlation IDs, graceful `SIGTERM` handling, dependency-aware readiness, bounded shutdown for the evidence worker, and a documented backup/restore and rollback strategy. Health endpoints must not disclose secrets or sensitive dependency details.

### Working method

Do the work in reviewable phases; do not perform a blind rewrite.

#### Phase 1 — audit and plan

1. Print the relevant repository tree and current workspace dependency graph.
2. Locate all entry points, listeners, hard-coded origins/ports, Vite build variables, static asset assumptions, in-memory stores, database access, scheduled/background work, health checks, Docker/Railway files, and test-only code.
3. Run the existing build, typecheck, and tests to establish a baseline. Record failures without hiding them.
4. Write `docs/architecture/single-container-plan.md` containing:
   - current-state component/deployment diagram;
   - target modular-monolith diagram;
   - final URL routing table;
   - package keep/merge/remove decisions;
   - persistence and migration plan;
   - environment-variable matrix (required/optional, build/runtime, secret/public, default);
   - security/threat-impact analysis;
   - staged migration and rollback plan;
   - confirmed Cookie platform constraints and links to their official sources;
   - open decisions and blockers.
5. If a platform detail or security/governance decision is unresolved, stop at a safe checkpoint and ask targeted questions. Otherwise continue.

#### Phase 2 — implement the modular monolith

1. Normalize workspace package manifests, root scripts, TypeScript project boundaries, and shared contracts without unnecessary churn.
2. Compose the Runtime, Evidence, and Admin routes into one Fastify application without starting nested servers.
3. Add lifecycle-managed evidence forwarding with an outbox-safe persistence model. Ensure retries are bounded/backed off, delivery is idempotent, and shutdown does not corrupt state.
4. Build every required frontend/content package and serve its output from the documented routes with correct cache headers. Hashed assets may be immutable; HTML and runtime config must not be cached as immutable.
5. Convert clients to same-origin/path-based configuration and make iframe and `postMessage` checks aware of the new paths without weakening origin checks.
6. Implement PostgreSQL repositories and migrations for all runtime state that must survive restarts. Use transactions and constraints for idempotency, uniqueness, legal state transitions, approvals, and outbox claiming.
7. Add typed startup configuration, liveness/readiness, structured logging, graceful shutdown, and proxy handling.
8. Replace deployment artifacts with one production Dockerfile, `.dockerignore`, and Cookie-specific configuration only where the official contract requires it.
9. Update `.env.example`, README, developer instructions, deployment runbook, migration procedure, rollback procedure, and architecture decision records. Clearly preserve all “draft,” “human review required,” “not certified,” and test-only labels that still apply.

#### Phase 3 — verify

Run and report the exact commands and results for:

- frozen-lockfile installation;
- root build and TypeScript checks;
- all unit, integration, anti-requirement, and end-to-end tests;
- migration up from an empty database and restart/idempotency behavior;
- lint/format checks if configured;
- `docker build` of the final image;
- container startup using only documented runtime variables;
- `/health` and `/ready` checks;
- smoke navigation for every UI route and deep-link refresh;
- a complete launch → Player Shell → state update → completion → evidence outbox/delivery flow;
- container restart proving required state persists;
- verification that the image runs as non-root, exposes/listens on one port, responds correctly to `SIGTERM`, and contains no secrets or development-only services;
- vulnerability/image scan when tooling is available.

Add automated deployment-contract tests that inspect the Dockerfile/image and prevent regressions to multiple listeners, missing frontend artifacts, wildcard origin checks, or in-memory production persistence. If Docker, PostgreSQL, browsers, or scanners are unavailable, mark those checks as not run and explain the environment limitation—never present them as passing.

### Definition of done

The task is complete only when:

- one clean checkout can be installed and fully built from the root with the frozen lockfile;
- one Docker build produces the complete deployable artifact;
- one container starts one application process on Cookie’s required port and serves all documented production routes;
- the application uses external PostgreSQL for restart-sensitive state and passes a restart persistence test;
- health/readiness, migrations, shutdown, evidence delivery, static routing, and deep links work in container-level tests;
- security and anti-requirement tests pass without weakened assertions;
- no secret is embedded in frontend output or image history;
- test/synthetic components are absent or fail-closed by default in production;
- the Cookie deployment and rollback instructions can be followed using only documented variables and platform features;
- obsolete deployment artifacts and documentation have been removed or clearly archived;
- repository warnings and unresolved governance blockers are accurately documented; and
- the final report lists changed files, architectural decisions, migrations, breaking changes, exact verification results, remaining risks, and any human approvals still required.

### Guardrails

- Do not rewrite working domain logic solely for style.
- Do not weaken or delete a failing security/anti-requirement test to make the refactor pass.
- Do not add `allow-same-origin`, wildcard CORS, wildcard `postMessage`, unsigned descriptors, shared hard-coded secrets, or sensitive logging.
- Do not ship default secrets, generated private keys, `.env` files, database data, or credentials.
- Do not bundle PostgreSQL, Docker-in-Docker, nginx, or a process supervisor into the final container unless the confirmed Cookie contract makes it unavoidable and the decision is documented.
- Do not use a mutable package-manager install or silently regenerate the lockfile during the image build.
- Do not claim high availability merely because the app is containerized; prove replica-safe migrations, state, and worker behavior first.
- Make small, cohesive commits with descriptive messages. Keep the repository buildable at each phase where practical.

Begin with the audit. Show evidence from the repository for each architectural conclusion, then present the implementation plan before editing application code.

---

## Suggested values to gather before use

At minimum, obtain the official Cookie documentation URL, its required container port behavior, whether it provides managed PostgreSQL, how it injects secrets, whether it runs release commands, and which proxy headers it sets. Without those answers, the prompt deliberately directs the coding tool to produce an audit rather than fabricate a deployment.
