import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: { baseURL: 'http://localhost:5176', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5176',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
