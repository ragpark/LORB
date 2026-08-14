# Railway non-production deployment

The sole deploy target is the `lorb-mock-consumer` Railway project in EU West (Amsterdam). BLK-08 and BLK-09 prevent real-learner-data use. Confirm every variable points only to non-production API projects before deployment. The MOCK badge and environment banner must remain visible in every environment. Build with `pnpm --filter mock-consumer build` and publish `packages/mock-consumer/dist` as static files; there is no frontend server runtime.
