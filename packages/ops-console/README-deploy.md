# Railway non-production deployment

This deployment is dedicated to non-production use. BLK-08 (Railway procurement/security assessment) and BLK-09 (UK residency) remain open blockers. **Real learner data is prohibited.** Do not present this service as production-ready or connect it to production services.

## Create the Railway service

1. Deploy from the same GitHub repository as the rest of LORB.
2. Use a separate Railway project/service named `lorb-ops-console`.
3. Keep the Railway service root directory at the repository root. Do not set it to `packages/ops-console`.
4. Select `Dockerfile.ops-console` as the service Dockerfile. The optional config-as-code file for this service is `railway.ops-console.json`; unlike the Runtime API configuration, it has no database setup pre-deploy command.
5. Configure the service port as `8080` and health check path as `/health`.
6. Generate a separate public domain for the console. Do not reuse a Runtime API domain.
7. Set `VITE_ENVIRONMENT_LABEL=RAILWAY-NON-PROD`. The image build intentionally fails for any other value.
8. Configure the other required `VITE_*` variables for the non-production environment. API URLs must reference non-production services only.
9. Deploy or redeploy the service, then verify the DRAFT banner and `RAILWAY-NON-PROD` environment label remain visible.

Every `VITE_*` variable is embedded into the static bundle at build time. Changing any of these Railway variables therefore requires a rebuild/redeploy; restarting an existing image is not sufficient.

The browser connects to the APIs through their non-production public HTTPS domains. Set `VITE_RUNTIME_API_BASE` to the Runtime API prefix (for example, `https://runtime-nonprod.example/api/v1/runtime`) and set `VITE_EVIDENCE_API_BASE` to the Evidence API prefix (for example, `https://evidence-nonprod.example/api/v1/evidence`). Set `VITE_ALLOWED_API_ORIGINS` to the exact comma-separated origins only (for example, `https://runtime-nonprod.example,https://evidence-nonprod.example`), without API paths, trailing slashes, or wildcards. A successful `/health` response confirms service health; the console itself calls concrete resources such as `repositories`, not the unimplemented `/api/v1/runtime/` root route.

This service must never be used with real learner data. Do not remove or bypass the DRAFT banner, environment label, origin allow-list, or any other existing anti-requirement enforcement.
