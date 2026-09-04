import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// tests/e2e/** run under the Playwright test runner (`pnpm exec playwright test`), not vitest —
// they use @playwright/test's own test()/expect(), which is incompatible with vitest's collector.
// `base` is relative so one built bundle works wherever it is mounted: at the root of its own
// static origin, or under a path prefix when the LORB app process serves it. Absolute asset
// URLs would resolve to the origin root and 404 under a prefix.
export default defineConfig({base:'./',plugins:[react()],server:{port:5176},test:{environment:'node',exclude:['**/node_modules/**','tests/e2e/**']}});
