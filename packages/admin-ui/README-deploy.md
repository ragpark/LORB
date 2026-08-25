# Railway non-production deployment

This deployment is dedicated to non-production use. BLK-03 (accountable owner), BLK-08 (Railway
procurement/security assessment), and BLK-09 (UK residency) remain open blockers. **Real learner data
is prohibited.** Do not present this service as production-ready or connect it to production services.

## Create the Railway service

1. Deploy from the same GitHub repository as the rest of LORB.
2. Use a separate Railway project/service named `lorb-admin-ui`.
3. Keep the Railway service root directory at the repository root. Do not set it to
   `packages/admin-ui`.
4. Select `Dockerfile.admin-ui` as the service Dockerfile. The config-as-code file for this service is
   `railway.admin-ui.json`; like the Ops Console, it has no database setup pre-deploy command — this
   service is a static bundle served over nginx.
5. Configure the service port as `8080` and health check path as `/health`.
6. Generate a separate public domain for the workspace. Do not reuse the Runtime API or Ops Console
   domain.
7. Set `VITE_ENVIRONMENT_LABEL=RAILWAY-NON-PROD`. The image build intentionally fails for any other
   value.
8. Configure the other required `VITE_*` variables for the non-production environment (see below). API
   URLs must reference non-production services only.
9. Deploy or redeploy the service, then verify the DRAFT banner and `RAILWAY-NON-PROD` environment
   label remain visible, and sign-in succeeds against the non-production `dev-identity` deployment.

Every `VITE_*` variable is embedded into the static bundle at build time. Changing any of these Railway
variables therefore requires a rebuild/redeploy; restarting an existing image is not sufficient.

## Required variables

- `VITE_ADMIN_API_BASE` — the Runtime API's admin prefix (for example,
  `https://runtime-nonprod.example/api/v1/admin`).
- `VITE_DEVELOPMENT_IDENTITY_LOGIN_URL` — the non-production `dev-identity` dev-login endpoint (for example,
  `https://ies-nonprod.example/dev-login`).
- `VITE_ENVIRONMENT_LABEL` — must be `RAILWAY-NON-PROD` on this deployment.

The Runtime API this workspace talks to must also have `DATABASE_URL` (migrations `001` and `003`
applied), `ADMIN_ALLOWED_ROLES`, and `ADMIN_APPROVAL_REQUIRED_FOR` configured — see the root
`.env.example`. `ADMIN_APPROVAL_REQUIRED_FOR` action-type names must match the route handlers exactly
(for example, `launch_policy_version.publish` and `launch_policy_version.activate`, not
`launch_policy.activate`) — a mismatch silently blocks the corresponding transition with
`ADMIN_REQUEST_INVALID` rather than skipping the approval step.

On the Ops Console deployment, also set `VITE_ADMIN_UI_ORIGIN` to this workspace's public domain so its
"Administration workspace" link resolves correctly.

This service must never be used with real learner data. Do not remove or bypass the DRAFT banner,
environment label, separation-of-duties enforcement, audit logging, or any other existing
anti-requirement enforcement.
