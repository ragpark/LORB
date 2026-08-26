/**
 * The browser suite's diagnostics.
 *
 * A Playwright failure says what was not on screen; it does not say why. For this suite the "why" is
 * almost always something only the browser saw — a blocked cross-origin fetch, a rejected key set, a
 * script that threw during the handshake — and none of it reaches the terminal. On a developer's
 * machine that is fine, because the trace viewer is one command away. In CI it is not: the trace is
 * an artefact somebody has to download, and a failure that reproduces only on the runner's browser
 * version is exactly the failure nobody can reproduce locally to look at.
 *
 * So every test in this suite runs with a listener on the console, uncaught errors, failed requests
 * and error responses, and on failure prints them — plus the Player Shell's own status line, which
 * distinguishes "the shell never opened the activity" from "the module opened and rendered nothing".
 * The output goes to stdout rather than only to an attachment, because a CI log is the one artefact
 * that is always readable.
 */
import { test as base, expect } from "@playwright/test";

/** The shell writes a human-readable outcome here; it is the fastest signal of where a launch died. */
const SHELL_STATUS = "#status";

/**
 * Every URL in this suite carries a signed descriptor in its fragment, which is hundreds of
 * characters of base64 and drowns the report it appears in. The path identifies the document; the
 * descriptor's contents are in the launch response the test already has.
 */
const shorten = (url: string): string => (url ? url.split("#")[0]! + (url.includes("#") ? "#…" : "") : "(blank)");

export const test = base.extend<{ browserDiagnostics: void }>({
  browserDiagnostics: [
    async ({ page }, use, testInfo) => {
      const lines: string[] = [];

      page.on("console", (message) => lines.push(`console.${message.type()}: ${message.text()}`));
      page.on("pageerror", (error) => lines.push(`pageerror: ${error.message}`));
      page.on("requestfailed", (request) =>
        lines.push(`requestfailed: ${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "unknown"}`));
      page.on("response", (response) => {
        if (response.status() >= 400) lines.push(`response ${response.status()}: ${response.request().method()} ${response.url()}`);
      });

      await use();

      if (testInfo.status === testInfo.expectedStatus) return;

      // Best effort throughout: the page may already be closing, and a diagnostic that throws would
      // replace the real failure with its own.
      for (const frame of page.frames()) {
        try {
          const status = await frame.locator(SHELL_STATUS).first().textContent({ timeout: 500 });
          if (status) lines.push(`shell status (${shorten(frame.url())}): ${status.trim()}`);
          const moduleSrc = await frame.locator("#module").first().getAttribute("src", { timeout: 500 });
          lines.push(`module src (${shorten(frame.url())}): ${shorten(moduleSrc ?? "")}`);
        } catch {
          // Not a shell document, or the frame is gone. Nothing to report from it.
        }
      }
      lines.push(`frames: ${page.frames().map((frame) => shorten(frame.url())).join(", ")}`);

      const report = lines.length ? lines.join("\n") : "(the browser reported nothing)";
      console.log(`\n--- browser diagnostics for "${testInfo.title}" ---\n${report}\n--- end diagnostics ---\n`);
      await testInfo.attach("browser-diagnostics", { body: report, contentType: "text/plain" });
    },
    { auto: true },
  ],
});

export { expect };
