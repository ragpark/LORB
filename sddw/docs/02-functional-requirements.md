# 2. Functional Requirements

Requirements use the form `FR-<module>-<n>` and MoSCoW priority (M = Must for MVP, S = Should, C = Could).

## FR-DASH — Dashboard

| ID | Requirement | Priority |
|---|---|---|
| FR-DASH-1 | Show count of specifications per lifecycle stage (Draft, Review, Certified, In Delivery, Released, Retired) with drill-through to the catalogue pre-filtered by stage. | M |
| FR-DASH-2 | List open blockers (review findings of severity *blocker* not yet resolved) across all specifications the user can see. | M |
| FR-DASH-3 | List pending reviews: specifications in *Review* stage where the current user is a reviewer, or where a review run has unresolved findings. | M |
| FR-DASH-4 | Show the certification queue: specifications in *Review* or *Certified* with at least one approval outstanding, grouped by approval type. | M |
| FR-DASH-5 | Show the 10 most recently modified specifications with modifier and relative time. | M |
| FR-DASH-6 | Filter the dashboard by Product Area. | S |

## FR-CAT — Specification Catalogue

| ID | Requirement | Priority |
|---|---|---|
| FR-CAT-1 | List specifications with Spec ID, title, product area, owner, status, lifecycle stage, version, completion %, last modified. | M |
| FR-CAT-2 | Filter by Product Area, Owner, Status, Tag, Lifecycle Stage (multi-select, combinable). | M |
| FR-CAT-3 | Full-text search on title and Spec ID; Should extend to section content. | M/S |
| FR-CAT-4 | Sort by any visible column. | M |
| FR-CAT-5 | Create a new specification (title, product area, owner defaults to current user) generating a Spec ID `SPEC-<area>-<seq>`. | M |
| FR-CAT-6 | Save and recall named filter views. | C |

## FR-EDIT — Specification Editor

| ID | Requirement | Priority |
|---|---|---|
| FR-EDIT-1 | Present the specification as seven groups: Product, UX, Architecture, Data, Engineering, QA, Operations, each containing its sections (see Data Model). | M |
| FR-EDIT-2 | Each section shows a completion indicator (Empty / Partial / Complete) computed from required fields; each group shows aggregate completion. | M |
| FR-EDIT-3 | Sections are edited as structured fields (text, rich text, lists, tables) — never as a single document text area. | M |
| FR-EDIT-4 | Autosave drafts with optimistic concurrency (ETag / row version); on conflict show the diff and let the user merge. | M |
| FR-EDIT-5 | Show header metadata: Spec ID, Title, Product Area, Status, Lifecycle Stage, Owner, Contributors, Version. | M |
| FR-EDIT-6 | Render a read-only Markdown preview and YAML manifest preview that are regenerated from the structured model. | M |
| FR-EDIT-7 | Version history: list versions, view a version, diff two versions section by section. | S |
| FR-EDIT-8 | Section-level comments with @mention (Graph users). | S |
| FR-EDIT-9 | Presence indicator showing who else has the specification open. | C |

## FR-AI — AI Assistant Panel

| ID | Requirement | Priority |
|---|---|---|
| FR-AI-1 | Side panel docked to the editor offering actions: Generate Section, Critique Section, Detect Contradictions, Review Against Constitution, Run Reuse Review, Generate ADRs, Generate Delivery Pack. | M |
| FR-AI-2 | Each action calls the SDD Companion service layer with the specification (or section) context and renders a **structured** result; the UI contains no prompt text. | M |
| FR-AI-3 | Generated content is shown as a proposal with Accept / Edit / Reject; accepting writes into the section and records an audit event with `source = ai`. | M |
| FR-AI-4 | Show run status (queued, running, complete, failed) and allow cancellation; long runs are asynchronous and polled. | M |
| FR-AI-5 | Persist every AI run (request, result, decision) as a Review record for traceability. | M |
| FR-AI-6 | Allow the user to add free-text guidance to an action (e.g. "focus on offline learners") that is passed as a structured `guidance` field. | S |

## FR-REV — Review Workspace

| ID | Requirement | Priority |
|---|---|---|
| FR-REV-1 | Show findings grouped into Warnings, Risks, Open Questions and Suggested Changes, each with severity, affected section, rationale and status (Open, Accepted, Rejected, Resolved). | M |
| FR-REV-2 | Resolve a finding by applying the suggested change, editing the section, or dismissing with a reason. | M |
| FR-REV-3 | Assign human reviewers and capture their verdict (Approve, Request changes) per review round. | M |
| FR-REV-4 | Block promotion from Review to Certified while any *blocker* finding is Open. | M |
| FR-REV-5 | Show finding trend across versions. | C |

## FR-CERT — Certification Workspace

| ID | Requirement | Priority |
|---|---|---|
| FR-CERT-1 | Track four approvals: Architecture, Privacy, Security, Product, each with Pending / Approved / Rejected / Waived, approver, date and comment. | M |
| FR-CERT-2 | Attach evidence to each approval (links, uploaded files stored alongside the specification, or referenced review runs). | M |
| FR-CERT-3 | Only users in the corresponding approver group can set an approval; owners cannot self-approve their own specification. | M |
| FR-CERT-4 | A specification becomes Certified only when all four approvals are Approved or Waived (Waived requires a reason and a second approver). | M |
| FR-CERT-5 | Certification applies to a specific version; any later edit creates a new Draft version and marks certification as stale. | M |

## FR-DEL — Delivery Pack Generator

| ID | Requirement | Priority |
|---|---|---|
| FR-DEL-1 | Generate from a Certified version: Epics, Stories, Acceptance Criteria, ADRs, Tasks, QA Matrix, BDD Scenarios, DevOps Checklist. | M |
| FR-DEL-2 | Display the pack as structured, editable tables, with traceability from each item back to the originating section. | M |
| FR-DEL-3 | Export as Markdown, JSON and CSV. | M |
| FR-DEL-4 | Push epics and stories to Jira / Azure DevOps via connector. | S |
| FR-DEL-5 | Regenerate a pack for a new version and show the delta. | S |

## FR-LIFE — Lifecycle and Audit

| ID | Requirement | Priority |
|---|---|---|
| FR-LIFE-1 | Stages: Draft → Review → Certified → In Delivery → Released → Retired, with permitted transitions defined in code (see `src/domain/lifecycle.ts`). | M |
| FR-LIFE-2 | Promotion requires the guard conditions for the target stage (completion threshold, no open blockers, approvals). | M |
| FR-LIFE-3 | Demotion (e.g. Review → Draft) is allowed with a reason. | M |
| FR-LIFE-4 | Every create, edit, promotion, AI run, approval and export writes an immutable audit event (who, when, what, before/after summary). | M |
| FR-LIFE-5 | Audit trail is viewable per specification and exportable. | S |

## FR-PERS — Persistence

| ID | Requirement | Priority |
|---|---|---|
| FR-PERS-1 | Persist the structured model plus generated `spec.md` and `manifest.yaml` on every saved version. | M |
| FR-PERS-2 | Storage provider is pluggable (SharePoint or Dataverse) behind a single repository interface. | M |
| FR-PERS-3 | Support at least 5,000 specifications and 50 versions each without UI degradation (paged queries). | S |
