import { defineConfig } from "@playwright/test";

/**
 * Browser coverage for the Player Shell to module channel — the one hop the vitest suites cannot
 * reach, because the sandbox semantics that break it only exist in a real browser.
 *
 * The suite starts its own Runtime API and static player origin (see tests/browser/harness.ts), so
 * there is no webServer here; it does need the player bundles built first:
 *   pnpm --filter player-shell build && pnpm --filter quiz-player build
 */
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  // The harness binds fixed ports, so workers must not run in parallel.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    // Same escape hatch packages/admin-ui uses, for environments with a pre-installed browser.
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH },
    trace: "retain-on-failure",
  },
});
