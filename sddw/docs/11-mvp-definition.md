# 11. MVP Definition

**Goal:** replace chat as the place where specifications live, for one or two pilot product areas, in 8 weeks.

## In scope (MVP)

| Module | MVP content |
|---|---|
| Dashboard | Stage counts, open blockers, pending reviews, certification queue, recently modified (FR-DASH-1..5) |
| Catalogue | List, filter, sort, search on title/ID, create specification (FR-CAT-1..5) |
| Editor | All 17 sections with structured editors, completion indicators, autosave with etag, Markdown + YAML preview (FR-EDIT-1..6) |
| AI panel | All seven actions via the gateway, async runs, proposal accept/edit/reject, runs persisted (FR-AI-1..5) |
| Review | Findings by category, resolve/dismiss, reviewer verdicts, blocker gate (FR-REV-1..4) |
| Certification | Four approvals with evidence, group-based authorisation, no self-approval, certification of a version (FR-CERT-1..5) |
| Delivery pack | Generate from Certified version, structured tables, export Markdown/JSON/CSV (FR-DEL-1..3) |
| Lifecycle | Full state machine with guards and audit trail (FR-LIFE-1..4) |
| Persistence | **SharePoint-first** adapter; Dataverse adapter compiled but feature-flagged |
| Platform | Deployed on Cookie, SSO, Nebula shell, WCAG AA automated checks |

## Out of scope (MVP)

Version diffing UI, comments/@mentions, presence, Jira/ADO push, saved filter views, finding trends, localisation beyond en-GB, Dataverse as default.

## Exit criteria

- 10 real specifications migrated from chat transcripts by the pilot teams.
- 2 specifications certified end-to-end with evidence.
- 1 delivery pack consumed by an engineering team.
- Zero P1 accessibility defects.
- SDD Companion gateway contract `/v1` frozen.
