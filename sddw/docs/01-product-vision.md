# 1. Product Vision — Spec Driven Development Workbench (SDDW)

## The problem

Pearson teams already practise Spec Driven Development (SDD) with the **SDD Companion**, a Copilot Studio agent. The agent is good at reasoning about a specification, but chat is the wrong container for the artefact it produces:

| Chat gives us | Enterprise specification management needs |
|---|---|
| A single linear transcript | A structured, sectioned document with completion state |
| One author at a time | Owners, contributors and reviewers working concurrently |
| Ephemeral context | Durable persistence with version history and audit trail |
| No lifecycle | Draft → Review → Certified → In Delivery → Released → Retired |
| No sign-off | Architecture, Privacy, Security and Product certification with evidence |
| No portfolio view | Dashboards, queues and reporting across product areas |

## The vision

> **SDDW is the enterprise system of record for Spec Driven Development and AI-assisted software delivery.**

It is *GitHub + Jira + Confluence + Copilot* narrowed to one job: taking a product idea from intent to a certified, delivery-ready specification, with AI as a service layer rather than the front door.

### Positioning

- **The web application is the primary UI.** Every module (dashboard, catalogue, editor, review, certification, delivery pack) is a first-class screen.
- **The SDD Companion is an AI service layer.** The UI calls typed, structured operations (`review`, `generate-adrs`, `reuse-review`, …) and renders structured results. The UI never sees or owns a prompt.
- **The Specification is the source of truth.** Everything else (reviews, approvals, deliverables, audit events) hangs off a Spec ID and a version.
- **Two artefacts, one truth.** Each specification is persisted as human-readable **Markdown** and a machine-readable **YAML manifest**, generated and maintained together from the same structured model.

## Who it is for

| Persona | Needs |
|---|---|
| Product Manager (spec owner) | Capture intent, personas, journeys; track completion; promote through stages |
| UX Architect | Own UX and accessibility sections; run critique and contradiction checks |
| Solution Architect | Author architecture, ADRs, NFRs, integration and data design; certify architecture |
| Engineering Lead | Consume the engineering plan and delivery pack; raise blockers |
| QA Lead | Own QA strategy; consume QA matrix and BDD scenarios |
| Privacy / Security reviewer | Review privacy, security, Responsible AI and safeguarding sections; grant approvals with evidence |
| Portfolio / Delivery lead | Dashboard: specs by stage, blockers, review and certification queues |

## Principles

1. **Structure over prose.** Sections, fields and indicators; never a giant text area.
2. **AI proposes, humans dispose.** Every AI result is a suggestion that a human accepts, edits or rejects, and that decision is audited.
3. **Certification is evidence-based.** An approval is a record with an approver, timestamp, and linked evidence, not a checkbox.
4. **Reuse first.** The Reuse Review surfaces existing platforms, components and patterns before new build is approved.
5. **Platform-native.** Runs on Cookie, authenticates with Pearson SSO, stores in Microsoft 365 (SharePoint or Dataverse) via Microsoft Graph, and uses the Nebula Design System.

## Success measures

- Time from first draft to Certified reduced (baseline captured from current chat-based practice).
- 100% of specifications in delivery have a Certified version with all four approvals and evidence.
- Every delivery pack traceable to a specification version.
- Review findings (warnings, risks, open questions) trend down between versions.
- Reuse Review adopted on every specification before Certified.
