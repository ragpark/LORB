# Railway non-production deployment

The only deployment target for this console is Railway EU West (Amsterdam), in a distinct `lorb-ops-console` non-production project. BLK-08 (Railway procurement/security assessment) and BLK-09 (UK residency) prevent this configuration being used for real learner data.

Build with `pnpm --filter ops-console build` and serve `dist/` as static files. Confirm every permitted `VITE_*` variable points only to non-production API projects. Never select a production Railway environment. The console must not be exposed publicly unless the DRAFT banner and `RAILWAY-NON-PROD` label make its status unmistakable.
