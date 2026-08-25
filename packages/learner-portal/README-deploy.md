# Railway non-production deployment

The sole deploy target is the `lorb-learner-portal` Railway service in EU West
(Amsterdam). BLK-08 and BLK-09 prevent real-learner-data use. The MOCK badge and
environment banner must remain visible in every environment.

## Required service topology

A green Railway deployment only proves that each container answered its own
health check. A launch crosses public HTTPS origins in this order:

```text
browser -> Learner Portal -> synthetic IES /dev-login
browser -> Learner Portal -> Runtime API /api/v1/runtime/launches
browser -> Runtime API JWKS (descriptor verification)
browser -> Player Shell -> packaged activity
```

Create four services from this repository and give each one a generated public
domain. PostgreSQL is also required by the Runtime pre-deploy step, although the
current Runtime request path remains in-memory.

| Railway service | Config file | Public endpoint used by the launch |
| --- | --- | --- |
| Runtime API | `railway.json` | `https://<runtime-host>` |
| Learner Portal | `railway.learner-portal.json` | `https://<consumer-host>` |
| Player Shell and example package | `railway.player-shell.json` | `https://<shell-host>` |
| Synthetic IES | `railway.stub-ies.json` | `https://<ies-host>` |

Do not use Railway private `*.railway.internal` names: the browser must reach
every endpoint. Use exact origins (scheme plus host, with no path or trailing
slash) wherever an origin is requested.

### Record the four public domains first

In Railway, open **Settings -> Networking -> Public Networking** for each
service and generate a domain. Write the resulting values down once. For
example, suppose Railway gives you:

```text
RUNTIME_DOMAIN=https://lorb-runtime.up.railway.app
CONSUMER_DOMAIN=https://lorb-consumer.up.railway.app
SHELL_DOMAIN=https://lorb-shell.up.railway.app
IES_DOMAIN=https://lorb-ies.up.railway.app
```

The names on the left above are only a worksheet; do not add them as Railway
variables. In the instructions below, replace `lorb-runtime`, `lorb-consumer`,
`lorb-shell`, and `lorb-ies` with the real hostnames Railway assigned. Keep
`https://`, do not add a trailing `/`, and do not substitute one service's
domain for another.

## Learner Portal configuration

On the **Learner Portal service only**, set **Settings -> Build -> Railway Config
File** to `/railway.learner-portal.json`. Then open that service's **Variables**
tab and add exactly these variables (using the example domains above):

```text
VITE_RUNTIME_API_BASE=https://lorb-runtime.up.railway.app/api/v1/runtime
VITE_JWKS_URL=https://lorb-runtime.up.railway.app/api/v1/runtime/jwks
VITE_PLAYER_SHELL_ORIGIN=https://lorb-shell.up.railway.app
VITE_STUB_IES_ISSUER=https://lorb-ies.up.railway.app
VITE_STUB_IES_LOGIN_URL=https://lorb-ies.up.railway.app/dev-login
VITE_ENVIRONMENT_LABEL=RAILWAY-NON-PROD
VITE_ALLOWED_SHELL_ORIGINS=https://lorb-shell.up.railway.app
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

On the **Runtime API service only**, set **Settings -> Build -> Railway Config
File** to `/railway.json`. Connect a Railway PostgreSQL service, then open the
Runtime service's **Variables** tab and add exactly these variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
PSEUDONYM_TENANT_SECRET=<64 hexadecimal characters from openssl rand -hex 32>
ALLOWED_CONSUMER_ORIGINS=https://lorb-consumer.up.railway.app
IES_ISSUER=https://lorb-ies.up.railway.app
IES_JWKS_URL=https://lorb-ies.up.railway.app/.well-known/jwks.json
RUNTIME_PUBLIC_ISSUER=https://lorb-runtime.up.railway.app
PLAYER_SHELL_ORIGIN=https://lorb-shell.up.railway.app
EVIDENCE_API_ENDPOINT=https://<evidence-api-host>/api/v1/evidence/statements
PACKAGE_PUBLIC_URL=https://lorb-shell.up.railway.app/module/index.html
```

Generate `PSEUDONYM_TENANT_SECRET` by running `openssl rand -hex 32` and paste
the output as its value. Keep `DATABASE_URL` as a Railway reference, changing
`Postgres` only if the database service has a different Railway service name.
`EVIDENCE_API_ENDPOINT` must be the public URL of your separately deployed
Evidence API. It is not the Consumer, Shell, or IES URL.

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

On the **Synthetic IES service only**, set **Settings -> Build -> Railway Config
File** to `/railway.stub-ies.json`. Then add this one variable in that service's
**Variables** tab:

```text
IES_PUBLIC_ISSUER=https://lorb-ies.up.railway.app
```

This must exactly equal Runtime's `IES_ISSUER` and Consumer's
`VITE_STUB_IES_ISSUER`. The synthetic IES is strictly non-production.

## Player Shell configuration

On the **Player Shell service only**, set **Settings -> Build -> Railway Config
File** to `/railway.player-shell.json`. No service variables are required for
the current Player Shell image. Generate its public domain and use that exact
domain everywhere `https://lorb-shell.up.railway.app` appears in the examples
above.

## Final service-by-service check

Before redeploying, the Railway canvas should contain the following settings:

| Service | Variable | Value points to |
| --- | --- | --- |
| Learner Portal | `VITE_RUNTIME_API_BASE` | Runtime API domain plus `/api/v1/runtime` |
| Learner Portal | `VITE_JWKS_URL` | Runtime API domain plus `/api/v1/runtime/jwks` |
| Learner Portal | `VITE_PLAYER_SHELL_ORIGIN` | Player Shell domain only |
| Learner Portal | `VITE_ALLOWED_SHELL_ORIGINS` | Player Shell domain only |
| Learner Portal | `VITE_STUB_IES_ISSUER` | Synthetic IES domain only |
| Learner Portal | `VITE_STUB_IES_LOGIN_URL` | Synthetic IES domain plus `/dev-login` |
| Runtime API | `ALLOWED_CONSUMER_ORIGINS` | Learner Portal domain only |
| Runtime API | `RUNTIME_PUBLIC_ISSUER` | Runtime API's own domain only |
| Runtime API | `PLAYER_SHELL_ORIGIN` | Player Shell domain only |
| Runtime API | `PACKAGE_PUBLIC_URL` | Player Shell domain plus `/module/index.html` |
| Runtime API | `IES_ISSUER` | Synthetic IES domain only |
| Runtime API | `IES_JWKS_URL` | Synthetic IES domain plus `/.well-known/jwks.json` |
| Synthetic IES | `IES_PUBLIC_ISSUER` | Synthetic IES's own domain only |
| Player Shell | _(none)_ | No variables required |

Redeploy the **Synthetic IES**, then **Player Shell**, then **Runtime API**, and
finally the **Learner Portal**. The ordering ensures that every public dependency
is available when the Consumer is rebuilt with its `VITE_*` values.

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
