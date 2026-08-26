/**
 * The browser suite's diagnostics.
 *
 * A Playwright failure says what was not on screen; it does not say why. For this suite the "why" is
 * almost always something only the browser saw — a blocked cross-origin fetch, a rejected key set, a
 * script that threw during the handshake — and none of it reaches the terminal. On a developer's
 * machine that is fine, because the trace viewer is one command away. In CI it is not: the trace is
 * an artefact somebody has to download, and a failure that reproduces only on the runner's browser
 * version is exactly the one nobody can reproduce locally to look at.
 *
 * So every test in this suite runs with listeners on the console, uncaught errors, failed requests
 * and every response, and on failure reports them along with what each frame actually rendered.
 *
 * The report is appended to the failure message rather than left in an attachment. Attachment
 * previews are truncated in the reporter's output — a longer report loses exactly the lines that
 * matter — and stdout written during a test does not reach the CI log at all. The failure message is
 * the one channel that is always printed, in full, wherever the suite runs.
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
      const events: string[] = [];
      const traffic: string[] = [];

      page.on("console", (message) => events.push(`console.${message.type()}: ${message.text()}`));
      page.on("pageerror", (error) => events.push(`pageerror: ${error.message}`));
      page.on("requestfailed", (request) =>
        events.push(`requestfailed: ${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "unknown"}`));
      // Every response, not only the failures. A launch that renders nothing without erroring is the
      // hard case, and what settles it is which requests were made at all: the module's own bundle,
      // then its content payload. A blocked subresource can arrive here as a plain 200 that the
      // browser then discards, so "no error" is not evidence that a fetch succeeded.
      page.on("response", (response) => traffic.push(`${response.status()} ${response.request().method()} ${shorten(response.url())}`));

      await use();

      if (testInfo.status === testInfo.expectedStatus) return;

      // Ordered by what answers the question fastest. Best effort throughout: the page may already
      // be closing, and a diagnostic that throws would replace the real failure with its own.
      const lines: string[] = [];

      for (const frame of page.frames()) {
        try {
          const rendered = (await frame.locator("body").first().innerText({ timeout: 500 })).replace(/\s+/g, " ").trim();
          // "Nothing at all" means the document's script never ran; a player's own waiting or error
          // state means it ran and did not get what it needed.
          lines.push(`rendered ${shorten(frame.url())}: ${rendered.slice(0, 300) || "(empty)"}`);
        } catch {
          // The frame is gone, or never had a document.
        }
      }

      lines.push(`requests:\n  ${traffic.slice(0, 40).join("\n  ") || "(none)"}`);
      lines.push(events.length
        ? `events:\n  ${events.slice(0, 40).join("\n  ")}`
        : "events: none — no console output, no uncaught error, no failed request");

      for (const frame of page.frames()) {
        try {
          const status = await frame.locator(SHELL_STATUS).first().textContent({ timeout: 500 });
          if (status) lines.push(`shell status ${shorten(frame.url())}: ${status.trim()}`);
          const moduleSrc = await frame.locator("#module").first().getAttribute("src", { timeout: 500 });
          lines.push(`module src ${shorten(frame.url())}: ${shorten(moduleSrc ?? "")}`);
        } catch {
          // Not a shell document, or the frame is gone.
        }
      }

      const report = `browser diagnostics\n${lines.join("\n")}`;
      // Appended to the failure itself. An attachment preview is truncated by the reporter and
      // stdout from inside a test is dropped in CI; the error message survives both.
      // Both fields: the reporter prints the stack when there is one and the message otherwise, and
      // which of the two an expect() failure carries is not something to depend on.
      for (const error of testInfo.errors) {
        error.message = `${error.message ?? ""}\n\n${report}`;
        if (error.stack) error.stack = `${error.stack}\n\n${report}`;
      }
      if (!testInfo.errors.length) await testInfo.attach("browser-diagnostics", { body: report, contentType: "text/plain" });
    },
    { auto: true },
  ],
});

export { expect };
