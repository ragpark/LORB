# Spec Driven Development Workbench (SDDW)

![Cookie Platform](https://img.shields.io/badge/Cookie-citizen%20app-blue)
![Stage](https://img.shields.io/badge/stage-development-yellow)

> **Internal — Pearson internal use only.** Specifications may describe unreleased products. Do not share access, screenshots or exports outside Pearson.

SDDW is the collaborative front-end and system of record for Spec Driven Development. It replaces chat as the place where specifications live: structured editing, lifecycle management (Draft → Review → Certified → In Delivery → Released → Retired), evidence-based certification, a full audit trail, and AI assistance from the existing **SDD Companion** Copilot Studio agent, which acts as a service layer behind the application rather than as the primary UI.

The full design pack lives in [`docs/`](docs/): product vision, functional and non-functional requirements, ASCII wireframes, data model, SharePoint and Dataverse designs with a comparison and recommendation, component hierarchy, API layer, security model, MVP definition, roadmap and ADRs.

## Intended users

| Audience | Access |
|----------|--------|
| Product managers, UX and solution architects, engineering and QA leads practising SDD | SSO group `cookie-app-sdd-workbench` — request via the SDD Companion Teams channel |
| Architecture / Privacy / Security / Product approvers | As above, plus the matching `sddw-approvers-*` Entra group for approval rights |
| All Pearson staff | No — request access from the product owner |

In-app roles are derived from the specification (owner, contributor) and Entra groups (approvers, `sddw-admins`); see [`docs/10-security-model.md`](docs/10-security-model.md).

## Features

- **Dashboard** — specifications by stage, open blockers, pending reviews, certification queue, recently modified
- **Specification Catalogue** — search, filter (product area, owner, status, tag, stage), sort, create
- **Specification Editor** — 18 structured sections in 7 groups with completion indicators, autosave with optimistic concurrency, generated Markdown and YAML manifest views, version history, audit trail
- **AI Assistant panel** — Generate/Critique Section, Detect Contradictions, Review Against Constitution, Reuse Review, Architecture/Privacy Review, Generate ADRs, Generate Delivery Pack; structured proposals with Accept / Reject and audit
- **Review Workspace** — warnings, risks, open questions, suggested changes; resolve/dismiss; reviewer verdicts; blocker gate on certification
- **Certification Workspace** — Architecture, Privacy, Security and Product approvals with evidence, group-based authorisation, no self-approval, waivers with second approver
- **Delivery Pack** — epics, stories, acceptance criteria, ADRs, tasks, QA matrix, BDD scenarios, DevOps checklist with traceability; export Markdown / JSON / CSV
- **Pluggable persistence** — SharePoint (MVP default), Dataverse, or in-memory demo data, behind one repository interface

## Architecture

```mermaid
flowchart LR
    User -->|HTTPS / SSO| App["SDDW SPA + Node host\n(GKE pod, :8080)"]
    App -->|MSAL delegated token| Graph["Microsoft Graph\nSharePoint lists + library"]
    App -->|MSAL delegated token| DV["Dataverse Web API\n(option B)"]
    App -->|REST /v1 (async runs)| GW["SDD Companion Gateway"]
    GW --> Agent["SDD Companion\n(Copilot Studio)"]
    GW -->|reads spec model| Graph
```

The pod is stateless. Specifications, reviews, approvals, delivery packs and audit events are stored in Microsoft 365 (SharePoint lists and a document library holding `spec.md`, `manifest.yaml` and `model.json` per version) or in Dataverse. No database or bucket is provisioned on Cookie.

## Running locally

**Prerequisites:** Node 22+

```bash
npm install
cp .env.example .env        # defaults to mock storage and the mock Companion — no credentials needed
npm run dev                 # Vite dev server on http://localhost:5173
```

Production-style run (what the container does):

```bash
npm run build && npm start  # serves dist/ on http://localhost:8080 — /health returns 200
```

Tests and type checks: `npm test`, `npm run typecheck`.

With `STORAGE_PROVIDER=mock` the app loads seeded demonstration data and a mock Companion that returns realistic structured results, so every screen is usable offline.

## Configuration

All variables are non-secret and are served to the browser from `/app-config.json` by [`server/index.mjs`](server/index.mjs).

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Listen port (default `8080`, required by Cookie) |
| `STORAGE_PROVIDER` | Yes | `mock`, `sharepoint` or `dataverse` |
| `ENTRA_TENANT_ID` | For sharepoint/dataverse/companion | Entra tenant for MSAL |
| `ENTRA_CLIENT_ID` | For sharepoint/dataverse/companion | SPA app registration client ID (PKCE, no secret) |
| `SHAREPOINT_SITE_ID` | For sharepoint | Graph site ID of the SDDW site |
| `SHAREPOINT_DRIVE_ID` | For sharepoint | Graph drive ID of the `SpecDocuments` library |
| `DATAVERSE_ORG_URL` | For dataverse | e.g. `https://org.crm11.dynamics.com` |
| `COMPANION_BASE_URL` | No | SDD Companion gateway base URL; empty = built-in mock |
| `COMPANION_SCOPE` | No | OAuth scope for the gateway (defaults to `<base>/.default`) |

Platform-injected variables (`APP_SECRET_KEY`, `SESSION_KEY`, `OIDC_*`) configure the SSO sidecar and are not read by the app.

## Contributors

| Name | Role | Team |
|------|------|------|
| Product owner (to be confirmed) | Product owner | SDD Companion |

## Contributing

This is an internal Pearson application. Access is restricted via SSO.

**To request access:** contact the product owner or post in the SDD Companion Teams channel.

**To contribute code:**
1. Discuss the change first (channel or ticket); large changes should themselves be captured as an SDDW specification.
2. Branch from `dev`; keep domain logic in `src/domain` pure and covered by tests.
3. Follow the [Cookie build standards](https://portal.cookie.pearsondev.tech/docs/build-standards) — port 8080, `/health`, SIF base image.
4. Open a PR against `dev`; product owner approval required.

Do not share this repo, the app URL or any specification content outside Pearson. This app handles **internal** data.
