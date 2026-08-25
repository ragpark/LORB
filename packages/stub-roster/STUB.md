# Stub Roster
// STUB — NOT PRODUCTION — BLOCKED BY BLK-02, BLK-03, BLK-07.

Test-only, non-production class/roster simulator. LORB-001 has no class, cohort, or
roster concept of its own; this stub exists so the MCP agent connector
(`packages/mcp-connector`) has something to resolve `class://{classId}` against
during local proof-of-concept work.

Everything it serves is synthetic. The learner identifiers it returns are the same
`synthetic-*` shape the synthetic IES (`packages/stub-ies`) accepts, so a roster
entry and a real IES login for the same learner derive the *same* LORB pseudonym
through the unchanged pseudonymisation function. It holds no real people, no real
timetable, and no entitlement decisions.

Removal blockers: a real roster/entitlement source requires the accountable owner
(BLK-03), the privacy design for holding class membership (BLK-07), and the
portfolio-reuse decision (BLK-02). Do not deploy this anywhere but a local dev or
Railway review environment.

## Superseded by the Runtime API roster (BLK-02, BLK-03 and BLK-07 now implicated)

A persisted roster now exists in the Runtime API (`004_roster.sql`, the
`/api/v1/admin/classes` routes, and the read-only `/api/v1/internal/roster`
projection the MCP connector uses). It was built on an explicit instruction to
build a real roster source rather than extend this synthetic one.

That changes the status of three blockers. They were previously open but not
implicated, because LORB held no class or membership data at all. They are now
**open and implicated**: the schema holds class membership, and closing BLK-07 in
particular is a precondition for this feature holding data about any real person.
Nothing in that work has been done. This is a proof of concept.

This stub is no longer on the connector's path and is kept only for the
compose profile and for tests that need a roster with no database behind it.
