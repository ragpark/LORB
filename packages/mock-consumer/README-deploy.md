# Railway non-production deployment

The sole deploy target is the `lorb-mock-consumer` Railway service in EU West (Amsterdam). BLK-08 and BLK-09 prevent real-learner-data use. The MOCK badge and environment banner must remain visible in every environment.

## Service configuration

Create a service distinct from the Runtime API, Evidence API and operations console. Connect it to this repository and select `railway.mock-consumer.json` as its Railway configuration file. That configuration builds `Dockerfile.mock-consumer`, serves the Vite output through nginx with SPA fallback routing, and checks `GET /health`. It intentionally has no database or API pre-deployment command.

Configure these Railway service variables before deploying:

```text
VITE_RUNTIME_API_BASE=https://<runtime-api-non-production-host>/api/v1/runtime
VITE_JWKS_URL=https://<runtime-api-non-production-host>/api/v1/runtime/jwks
VITE_PLAYER_SHELL_ORIGIN=https://<player-shell-non-production-host>
VITE_STUB_IES_ISSUER=https://<stub-ies-non-production-host>
VITE_STUB_IES_LOGIN_URL=https://<stub-ies-non-production-host>/dev-login
VITE_ENVIRONMENT_LABEL=RAILWAY-NON-PROD
VITE_ALLOWED_SHELL_ORIGINS=https://<player-shell-non-production-host>
```

Confirm that every URL points only to a non-production service. `VITE_ALLOWED_SHELL_ORIGINS` must be an explicit comma-separated allow-list and must never contain a wildcard. These values are public Vite build-time configuration, so do not put secrets or tokens in them.

The container build fails unless the environment label is exactly `RAILWAY-NON-PROD`, every required variable is present, and the shell allow-list is not `*`. The static application is built with `pnpm --filter mock-consumer build` and copied from `packages/mock-consumer/dist` into the runtime image.
