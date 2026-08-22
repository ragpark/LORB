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
