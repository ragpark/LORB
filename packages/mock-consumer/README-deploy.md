# Railway non-production deployment

The sole deploy target is the `lorb-mock-consumer` Railway service in EU West
(Amsterdam). BLK-08 and BLK-09 prevent real-learner-data use. The MOCK badge and
environment banner must remain visible in every environment.

## Required service topology

A green Railway deployment only proves that each container answered its own
health check. A launch crosses public HTTPS origins in this order:

```text
browser -> Mock Consumer -> synthetic IES /dev-login
browser -> Mock Consumer -> Runtime API /api/v1/runtime/launches
browser -> Runtime API JWKS (descriptor verification)
browser -> Player Shell -> packaged activity
```

Create four services from this repository and give each one a generated public
domain. PostgreSQL is also required by the Runtime pre-deploy step, although the
current Runtime request path remains in-memory.

| Railway service | Config file | Public endpoint used by the launch |
| --- | --- | --- |
| Runtime API | `railway.json` | `https://<runtime-host>` |
| Mock Consumer | `railway.mock-consumer.json` | `https://<consumer-host>` |
| Player Shell and example package | `railway.player-shell.json` | `https://<shell-host>` |
| Synthetic IES | `railway.stub-ies.json` | `https://<ies-host>` |

Do not use Railway private `*.railway.internal` names: the browser must reach
every endpoint. Use exact origins (scheme plus host, with no path or trailing
slash) wherever an origin is requested.

## Mock Consumer configuration

Create a service distinct from the Runtime API and select
`railway.mock-consumer.json` as its Railway config file. Configure these service
variables before deploying:

```text
VITE_RUNTIME_API_BASE=https://<runtime-host>/api/v1/runtime
VITE_JWKS_URL=https://<runtime-host>/api/v1/runtime/jwks
VITE_PLAYER_SHELL_ORIGIN=https://<shell-host>
VITE_STUB_IES_ISSUER=https://<ies-host>
VITE_STUB_IES_LOGIN_URL=https://<ies-host>/dev-login
VITE_ENVIRONMENT_LABEL=RAILWAY-NON-PROD
VITE_ALLOWED_SHELL_ORIGINS=https://<shell-host>
```

Do **not** set `VITE_RUNTIME_ISSUER`. The Consumer derives it from the origin of
`VITE_RUNTIME_API_BASE`, preventing an issuer/JWKS mismatch.
`VITE_ALLOWED_SHELL_ORIGINS` must be an explicit comma-separated allow-list and
must never contain a wildcard. These are public Vite build-time values; do not
put secrets in them. Changing one requires redeploying the Consumer, not merely
restarting it.

The image build fails unless every required variable is present and the
environment label is exactly `RAILWAY-NON-PROD`. It serves the Vite output with
SPA fallback routing and checks `GET /health`; it intentionally has no database
or API pre-deploy command.

## Runtime API configuration

Configure the Runtime service with:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
PSEUDONYM_TENANT_SECRET=<64 hexadecimal characters from openssl rand -hex 32>
ALLOWED_CONSUMER_ORIGINS=https://<consumer-host>
IES_ISSUER=https://<ies-host>
IES_JWKS_URL=https://<ies-host>/.well-known/jwks.json
RUNTIME_PUBLIC_ISSUER=https://<runtime-host>
PLAYER_SHELL_ORIGIN=https://<shell-host>
EVIDENCE_API_ENDPOINT=https://<evidence-api-host>/api/v1/evidence/statements
PACKAGE_PUBLIC_URL=https://<shell-host>/module/index.html
```

`ALLOWED_CONSUMER_ORIGINS` is the browser CORS allow-list and must contain the
actual Consumer public origin. `RUNTIME_PUBLIC_ISSUER` must exactly equal the
origin used by `VITE_RUNTIME_API_BASE`, because it is written into and checked
against the descriptor. `PLAYER_SHELL_ORIGIN` must exactly equal both Consumer
shell variables. The bundled MVP activity is served by the Player Shell image
at `/module/index.html`.

The Evidence API endpoint is embedded in the descriptor but is not contacted
until the activity emits evidence. It does not explain a failure before the
Player Shell opens. Do not define `PORT` on any service; Railway injects it.

## Synthetic IES configuration

Configure the synthetic IES service with:

```text
IES_PUBLIC_ISSUER=https://<ies-host>
```

This must exactly equal Runtime's `IES_ISSUER` and Consumer's
`VITE_STUB_IES_ISSUER`. The synthetic IES is strictly non-production.

## Connectivity checks

After redeploying all variable changes, run:

```bash
curl -fsS https://<runtime-host>/health
curl -fsS https://<runtime-host>/api/v1/runtime/jwks
curl -fsS https://<shell-host>/health
curl -fsS https://<shell-host>/module/index.html
curl -fsS https://<ies-host>/health
curl -fsS https://<ies-host>/.well-known/jwks.json
curl -i -X OPTIONS https://<runtime-host>/api/v1/runtime/launches \
  -H 'Origin: https://<consumer-host>' \
  -H 'Access-Control-Request-Method: POST'
```

The final response must include
`access-control-allow-origin: https://<consumer-host>`. In browser developer
tools, a successful journey shows `POST /dev-login` (200), catalogue GETs (200),
`POST /launches` (201), a Runtime JWKS GET (200), and the Player Shell document
(200).

The generic “This activity could not be opened” page covers browser-side CORS,
descriptor issuer/JWKS verification, and player-origin failures. Those failures
can leave every server log clean. Use the Consumer Diagnostics drawer and the
browser Network and Console panels. A correlation ID identifies only a request
that reached the Runtime.
