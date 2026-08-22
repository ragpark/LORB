import { describe, expect, it } from "vitest";
import { handshakeAllowed, handshakeNonceFrom, originAllowed } from "../../packages/player-shell/src/postmessage.js";

/**
 * A module runs sandboxed without `allow-same-origin`, so its document has an opaque origin the
 * browser reports as the literal string "null". `originAllowed` is unchanged and still refuses that,
 * which is why the module channel now runs over a MessagePort obtained through a nonce-authenticated
 * handshake rather than over ambient window messages.
 */
const SHELL_IFRAME = Symbol("frame.contentWindow");
const OTHER_WINDOW = Symbol("some other window");
const PACKAGE_ORIGIN = "http://localhost:3200";
const NONCE = "6f1c9d2a-6e3a-4f1b-9a7d-1e2f3a4b5c6d";

describe("originAllowed (unchanged enforced control)", () => {
  it("rejects a wildcard origin", () => {
    expect(originAllowed("*", "*", "*", SHELL_IFRAME, SHELL_IFRAME)).toBe(false);
  });
  it("rejects an unlisted origin", () => {
    expect(originAllowed("http://evil.example", PACKAGE_ORIGIN, "http://evil.example", SHELL_IFRAME, SHELL_IFRAME)).toBe(false);
  });
  it("rejects the opaque origin of a sandboxed module", () => {
    expect(originAllowed("null", PACKAGE_ORIGIN, PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME)).toBe(false);
  });
  it("accepts a listed origin that matches the navigated origin and window", () => {
    expect(originAllowed(PACKAGE_ORIGIN, PACKAGE_ORIGIN, PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME)).toBe(true);
  });
});

describe("handshakeAllowed", () => {
  it("accepts an opaque-origin module from our iframe presenting the launch nonce", () => {
    expect(handshakeAllowed("null", PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME, NONCE, NONCE)).toBe(true);
  });

  /**
   * The core of the P1 review finding on #44: a redirect or a self-navigation keeps the *same*
   * WindowProxy and the *same* opaque origin, so window identity alone cannot tell the replacement
   * document apart. Only the nonce can, because the replacement never received the fragment.
   */
  it("rejects a document in our own iframe that cannot present the nonce", () => {
    expect(handshakeAllowed("null", PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME, undefined, NONCE)).toBe(false);
    expect(handshakeAllowed("null", PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME, "", NONCE)).toBe(false);
    expect(handshakeAllowed("null", PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME, "a-guess", NONCE)).toBe(false);
  });

  it("rejects a correct nonce presented from any other window", () => {
    expect(handshakeAllowed("null", PACKAGE_ORIGIN, OTHER_WINDOW, SHELL_IFRAME, NONCE, NONCE)).toBe(false);
  });

  it("rejects a wildcard origin even with the nonce", () => {
    expect(handshakeAllowed("*", PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME, NONCE, NONCE)).toBe(false);
  });

  it("rejects a concrete origin that is not the package origin", () => {
    expect(handshakeAllowed("http://evil.example", PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME, NONCE, NONCE)).toBe(false);
  });

  it("accepts a non-sandboxed module served from the package origin", () => {
    expect(handshakeAllowed(PACKAGE_ORIGIN, PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME, NONCE, NONCE)).toBe(true);
  });

  it("never accepts an empty expected nonce, so a misconfigured shell fails closed", () => {
    expect(handshakeAllowed("null", PACKAGE_ORIGIN, SHELL_IFRAME, SHELL_IFRAME, "", "")).toBe(false);
  });
});

describe("handshakeNonceFrom", () => {
  it("reads the nonce from a fragment", () => {
    expect(handshakeNonceFrom(`#lorb_handshake=${NONCE}`)).toBe(NONCE);
    expect(handshakeNonceFrom(`#other=1&lorb_handshake=${NONCE}`)).toBe(NONCE);
  });
  it("returns undefined when absent", () => {
    expect(handshakeNonceFrom("#other=1")).toBeUndefined();
    expect(handshakeNonceFrom("")).toBeUndefined();
  });
});
