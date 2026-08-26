# Operations Console

A read-mostly console for the people who run LORB: launches, attempts, evidence delivery, the
catalogue, and a test launcher.

It is not a learner, teacher or publisher surface. It answers one question — *what is the platform
doing right now* — and every projection it shows is fetched live from the API rather than held in the
bundle.

## What it shows

| Page | Source |
| --- | --- |
| Overview | Counts across every projection below, plus the environment |
| Repositories, Learning objects, Package versions | `GET /api/v1/runtime/…` |
| Attempts | `GET /api/v1/runtime/attempts` — pseudonyms only |
| Evidence outbox | `GET /api/v1/evidence/outbox` — status, attempts, last error |
| Test launcher | `POST /api/v1/runtime/launches` against a repository you own |

A test launch creates a real attempt against real content. The console says so before you use it.

## What it will not show

Learner identity. The API returns pseudonyms, and the console additionally refuses to render a
response containing an identifying field: it discards the value and raises `SUSPECTED_LEAK` rather
than displaying it. That guard is a rail against a future API change, not a substitute for the API
getting it right.

The evidence outbox is fetched with the statement payload discarded client-side, so learner-authored
content never reaches the operator's screen or the diagnostics log.

## Sign-in

Through your identity provider, using authorization code with PKCE. In a development build with no
provider configured, a local sign-in is used instead; that path is gated on the environment label and
the image refuses to build for a deployed environment without a provider.

The operator is identified by their pseudonym, from `GET /api/v1/admin/whoami`. No raw subject is
ever rendered.

## Running it

```sh
pnpm --filter ops-console dev      # http://localhost:5173
```

`VITE_ENVIRONMENT_LABEL` must be `PRODUCTION`, `STAGING` or `DEVELOPMENT`; anything else is a visible
start-up failure rather than a default. Outside production the console shows an environment notice
above everything a keyboard user can reach, so an operator always knows whether the records in front
of them are real.

Deployment: [README-deploy.md](README-deploy.md).

## Enforced controls

Environment-label validation and notice placement; leak detection; subject and secret redaction;
correlation identifiers on every request and idempotency keys on every state change; fixed launch
mode and locale; expired-session handling; no unsafe HTML; no wildcard messaging or CORS;
session-only token storage; authorization redaction in diagnostics; skip link as the first tab stop;
accessible dialog focus and Escape behaviour; the local sign-in confined to development; and
authorization code with PKCE rather than the implicit flow.

See `tests/anti-requirements/README-anti-requirements.md`.
