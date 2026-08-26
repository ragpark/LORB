# Administration workspace enforcement controls

Tested in `admin-ui-enforcement.spec.ts` (this surface) and
`tests/runtime-api/admin-enforcement.spec.ts` at the repository root. Several are only meaningfully
enforceable on the server or in the database, and are marked as such — a control a client enforces
alone is a control a different client does not.

1. The environment notice renders before the first interactive element, and not at all in production.
2. Only the known environment labels start the workspace.
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
25. The Simulate action is present on launch policy versions but disabled, with a tooltip saying so.
26. The local sign-in is reachable only in a development environment, and the configured identity provider is preferred wherever one exists.
27. Sign-in uses authorization code with PKCE, never the implicit flow.

## Departures worth knowing about

- **`GET /api/v1/admin/whoami` exists** although no design named it. Disabling "Approve" for the
  principal who raised a request requires the client to know its own pseudonym, and a pseudonym is
  an HMAC of the subject computed only on the server — so without this route the first of the three
  separation-of-duties layers cannot exist at all.
- **There is no router.** The workspace follows the same single-`App.tsx`, page-state pattern as the
  other two front ends. Consistency across three surfaces was worth more than the routing library.
- **Publisher content management lives on the API, not in a separate UI.** Registration and
  versioning go through `POST /api/v1/publisher/learning-objects`; the workspace lists the catalogue
  and manages smart links. A publisher-facing interface is a reasonable thing to build next and is
  not built.
