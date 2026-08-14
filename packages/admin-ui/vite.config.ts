import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// tests/e2e/** run under the Playwright test runner (`pnpm exec playwright test`), not vitest —
// they use @playwright/test's own test()/expect(), which is incompatible with vitest's collector.
export default defineConfig({plugins:[react()],server:{port:5176},test:{environment:'node',exclude:['**/node_modules/**','tests/e2e/**']}});
