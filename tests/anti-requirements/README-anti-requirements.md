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

`originAllowed` implements two of the 15 controls: wildcard postMessage rejection and allow-listed
postMessage origins. It was changed to also accept the **opaque** origin a correctly sandboxed module
reports, authenticated by window identity instead of by origin string. This is a change to
anti-requirement enforcement and needs human LORB-001 re-review; it is covered by
`tests/player-shell/postmessage.spec.ts`.

Why: a module runs in `sandbox="allow-scripts"` without `allow-same-origin`, so its document has an
opaque origin that the browser reports to the receiver as the literal string `"null"`. That can never
equal the pinned package origin, so the shell was silently dropping **every** message from every
correctly sandboxed module — completions included. The sandbox anti-requirement and the origin
anti-requirement were, in combination, making the module channel inoperable.

What is unchanged: a wildcard origin is still refused outright, and a *concrete* origin must still be
both allow-listed and equal to the origin the iframe was actually navigated to. What is added: when the
origin is opaque, the shell requires `event.source === frame.contentWindow` — a live window reference
the browser supplies, which no other document can forge. That is a stronger check than a claimed
origin string, not a weaker one.

The reverse direction (shell to module) uses a `MessageChannel` rather than a wildcard `postMessage`,
so no wildcard target is introduced anywhere.
