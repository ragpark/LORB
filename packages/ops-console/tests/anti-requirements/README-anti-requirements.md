# Console enforcement controls

What `console-enforcement.spec.ts` guards, and why each one matters here rather than in the API.

| # | Control | Why the console has to hold it |
| --- | --- | --- |
| 1 | The environment notice precedes the first interactive element | An operator learns whether the records are real before they can act on them |
| 2 | Only the known environment labels start the console | An unrecognised label is a visible failure, never a silent default |
| 2a | No notice in production | A banner that is always on stops being read |
| 2b | The local sign-in is confined to a development environment | A deployed console that could name a subject to get a token has no authentication |
| 2c | Authorization code with PKCE, never the implicit flow | A token in a URL fragment ends up in history and referrers |
| 2d | No fabricated operator identity | The operator is their pseudonym, from `whoami`, or nothing |
| 3 | Identifying fields are detected, not rendered | The guard is a rail against a future API change, not a substitute for the API being right |
| 4 | Raw subjects and tenant secrets are stripped from anything displayed | Neither is an operator's business, and both are recoverable from a screenshot |
| 5 | A correlation identifier on every request | It is the only handle on a report of "it failed for a learner" |
| 6 | An idempotency key on every state change | A retried launch must not create a second attempt |
| 7 | Launch mode and locale are fixed | The console tests the platform, not the caller's ability to vary a parameter |
| 8 | Replay preserves provenance | A requeued statement keeps its identity, so it is not counted twice |
| 9 | An expired session redirects to sign-in | Rather than a wall of 401s the operator has to interpret |
| 10 | No unsafe HTML rendering | Projections come from the API; the API's content is not markup |
| 11 | No wildcard messaging or CORS | Two of the enforced platform controls, held on this side too |
| 12 | Tokens live for the session only | A token in `localStorage` survives the tab and is readable by any script on the origin |
| 13 | Authorization is redacted before anything reaches the diagnostics log | The log is the first thing pasted into a ticket |
| 14 | The skip link is the first tab stop | Keyboard users reach the content without traversing the chrome |
| 15 | Dialog focus, restoration and Escape are delegated to Radix | Hand-rolled focus traps are where accessibility regressions live |

Two further cases check that live projections are loaded rather than bundled fixtures, and that
resource paths are joined without dropping the runtime path segment — both were real defects.
