# LORB-001 MVP anti-requirements

The 15 automated controls from Sections 6.2, 6.3, and 8 are: prohibited descriptor PII; pinned player reference; immutable package version UUID; launch idempotency required; launch replay; runtime audience; evidence actor binding; evidence UUID; evidence deduplication; wildcard postMessage rejection; allow-listed postMessage origins; sandbox without same-origin; sensitive log exclusion; non-wildcard CORS; and legal attempt transitions.

Approximately 75 controls outside this slice—including provider adapters, PRIZM coexistence, SCORM, LTI, xAPI batching, external callbacks, multi-tenant administration, production hosting, real identity, entitlement, monitoring, accessibility certification, privacy certification, and threat modelling—are **out of MVP scope and not yet enforced**. They must be added in later reviewed slices.

## MCP agent connector proof of concept

`tests/mcp-connector/mcp-smoke.spec.ts` adds an end-to-end smoke test for the agent connector. It is
**not** a sixteenth certified control and clears nothing above. It does enforce, in the same style, the
non-negotiables the connector was built against:

- MCP `initialize` and `tools/list` succeed against the PoC bearer token, and a bad or missing token is
  rejected with `401` plus a spec-shaped `WWW-Authenticate: Bearer` challenge.
- `create_quiz` returns no answer key: no `correct_option_id`, no explanation, and no option or stem
  text the key could be reconstructed from.
- `assign_quiz` is annotated `readOnlyHint: false, destructiveHint: false`, its description names the
  consent requirement, and it returns no launch descriptor, player URL, or platform learner identifier.
- A repeated `idempotency_key` is treated as a duplicate rather than re-assigning; the Runtime API's
  own launch idempotency and the Evidence API's statement UUID deduplication both still apply and are
  asserted independently.
- The `launched` → `answered` → `completed` chain is emitted through the real Evidence API, forwarded
  by the real forwarder, and read back through the Evidence read model — never from canned data.
- The Runtime assignment record and the results read model hold LORB pseudonyms only.

Three changes this work makes to enforced surfaces — the widened xAPI verb/result contract, the added
null-origin CORS route, and the new internal service-credentialled Runtime routes — are listed for human
LORB-001 re-review in the repository README and are not treated as reviewed by these tests passing.


## postMessage origin policy (player shell)

`originAllowed` implements two of the 15 controls — wildcard postMessage rejection and allow-listed
postMessage origins — and is **unchanged**. It still refuses the opaque origin a sandboxed module
reports, so no enforced control is relaxed.

Instead the module channel runs over a `MessageChannel`. A module opens the channel and asks for it in
a single `module.hello` message authenticated by `handshakeAllowed`, which requires all of:

- the message came from the shell's own iframe (`event.source === frame.contentWindow`);
- the origin is either the pinned package origin or the opaque `"null"` — never a wildcard;
- the message presents the per-launch nonce the shell placed in the iframe URL fragment.

The nonce is what binds the handshake to a *document* rather than to a *browsing context*. Window
identity alone is not sufficient: a redirect or a self-navigation keeps the same `WindowProxy` and the
same opaque origin, and `frame.src` still reads the pinned package URL, so nothing else can tell the
replacement document apart. Only a document the shell itself navigated to receives the fragment.

The shell additionally accepts exactly one handshake per launch, carries all later traffic on the port
(the window is never used again), and ends the session if the document under an established channel
changes.

Known residual risk, for review: a `package_url` that 302s off-origin on the very first load carries
the fragment to the redirect target, and the embedding page cannot detect that from inside the
browser. A `frame-src` CSP on the Player Shell would close it at the browser level; the shipped nginx
image serves modules from the shell's own origin, so `frame-src 'self'` would fit that topology, but it
would break a deployment that hosts packages on a separate origin and so is not imposed here.

Covered by `tests/player-shell/postmessage.spec.ts`.
