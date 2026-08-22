import { describe, expect, it } from "vitest";
import { originAllowed } from "../../packages/player-shell/src/postmessage.js";

/**
 * A module runs sandboxed without `allow-same-origin`, so its document has an opaque origin that the
 * browser reports to the receiver as the literal string "null". Before this was handled, every
 * message a correctly sandboxed module sent was dropped by the shell — including the completion that
 * moves an attempt to COMPLETED — because "null" can never equal the pinned package origin.
 */
const SHELL_IFRAME = Symbol("frame.contentWindow");
const OTHER_WINDOW = Symbol("some other window");
const PACKAGE_ORIGIN = "http://localhost:3200";

describe("player shell postMessage origin policy", () => {
  it("accepts the opaque origin of a correctly sandboxed module from our own iframe", () => {
    expect(originAllowed("null", PACKAGE_ORIGIN, PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME)).toBe(true);
  });

  it("still accepts a concrete origin that matches the pinned package origin", () => {
    expect(originAllowed(PACKAGE_ORIGIN, PACKAGE_ORIGIN, PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME)).toBe(true);
  });

  // The opaque origin carries no information, so window identity is what authenticates it. event.source
  // is supplied by the browser and cannot be forged to equal our frame.contentWindow.
  it("rejects the opaque origin when the message came from any other window", () => {
    expect(originAllowed("null", PACKAGE_ORIGIN, PACKAGE_ORIGIN, OTHER_WINDOW, SHELL_IFRAME)).toBe(false);
  });

  it("rejects a wildcard origin outright, even from our own iframe", () => {
    expect(originAllowed("*", "*", "*", SHELL_IFRAME, SHELL_IFRAME)).toBe(false);
    expect(originAllowed("*", PACKAGE_ORIGIN, PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME)).toBe(false);
  });

  it("rejects an unlisted concrete origin", () => {
    expect(originAllowed("http://evil.example", PACKAGE_ORIGIN, "http://evil.example", SHELL_IFRAME, SHELL_IFRAME)).toBe(false);
  });

  it("rejects a listed origin that is not the origin the iframe was navigated to", () => {
    expect(originAllowed(PACKAGE_ORIGIN, PACKAGE_ORIGIN, "http://elsewhere.example", SHELL_IFRAME, SHELL_IFRAME)).toBe(false);
  });
});
