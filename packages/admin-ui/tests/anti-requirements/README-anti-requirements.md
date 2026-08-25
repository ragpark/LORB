# LORB-001 Administration workspace anti-requirements

The 25 automated controls from Section 13 of the Administration workspace brief, tested in
`admin-ui-enforcement.spec.ts` (UI-side) and `tests/runtime-api/admin-enforcement.spec.ts` at the
repo root (API/DB-side — several of these are only meaningfully enforceable server-side, and are
noted as such below):

1. DRAFT banner renders before the first interactive element.
2. Environment pill accepts only `LOCAL-DEV` or `RAILWAY-NON-PROD`.
3. "ActiveHub" and "Pearson" never appear in the UI source/bundle.
4. Non-admin users are denied at every admin route (Section 6.2 — API-authoritative).
5. Unauthenticated requests are denied at every admin route (Section 6.1 — API-authoritative).
6. Requests without the correct repository membership are denied (Section 6.3 — API-authoritative).
7. Every state-changing admin request requires `Idempotency-Key` (Section 6.1).
8. Every mutation writes its audit record in the same transaction (Section 7 — API-authoritative).
9. Denied requests write an `audit_record` with `outcome: 'DENIED'` (Section 7).
10. `audit_record` UPDATE and DELETE fail at the Postgres trigger (Section 5 — DB-authoritative).
11. Approved/active/deprecated/suspended/retired `player_version` rows are immutable (Section 5).
12. Published/superseded/retired `launch_policy_version` rows are immutable (Section 5).
13. Player version registration rejects integrity algorithms weaker than `sha384` (Section 8.3).
14. Player version registration rejects a `module_origin` outside the allow-list (Section 8.3).
15. Separation of duties: a principal cannot approve their own request, at UI, API and DB layers (Section 12).
16. `approval-requests/:id/execute` rejects requests that are not `APPROVED` (Section 8.7).
17. The UI never renders a raw IES subject — the header identifies the operator by pseudonym via `GET /admin/whoami`.
18. Tokens live only in `sessionStorage`, never `localStorage` (Section 6.1).
19. No `dangerouslySetInnerHTML` anywhere in the UI codebase.
20. Wildcard CORS is never configured or documented (Section 6, cross-referenced against runtime-api's CORS setup).
21. Diagnostics and logs never contain raw subjects, tenant secrets, private keys, bearer tokens, or descriptor payloads (Section 11).
22. No blue-and-white Pearson-style palette (banned hex values and Tailwind `blue-*` classes).
23. No route, component, or endpoint offers correction of an accepted xAPI statement (Section 7).
24. The launch resolver prefers the active `launch_policy_version` when matched, and falls back to the pre-existing default resolver otherwise (Section 8.5 — API-authoritative, requires `DATABASE_URL`).
25. The Simulate action is present on launch policy versions but disabled, with a "Deferred to Wave 2" tooltip (Section 9.3).

## Known gaps against the brief (documented for the accountable owner — BLK-03)

- **Section 14's Publisher UI cross-slice update was not implemented.** No such package exists in
  this repository (the existing packages are `runtime-api`, `learner-portal`, `ops-console`,
  `player-shell`, `dev-identity`, `dev-lrs`, `evidence-api`, `evidence-forwarder`, `contracts`,
  `example-module`, `test-client`). There is nothing to add repository-scoped ABAC to.
- **A `GET /api/v1/admin/whoami` endpoint was added** beyond Section 8's literal endpoint list. It
  is structurally required for Section 12's UI-layer self-approval disablement — the client cannot
  disable "Approve" for its own requests without knowing its own pseudonym, and pseudonyms are not
  derivable client-side (they are an HMAC of the real subject, computed only server-side).
- **The Admin UI does not use `@tanstack/react-router` or per-view route files.** It follows the
  same single-`App.tsx`, page-state pattern already used successfully by `learner-portal` and
  `ops-console` in this repository, to keep the surface area consistent and reviewable. Section 3's
  file tree was treated as a structural suggestion, not a literal requirement, given the size of
  this slice.
