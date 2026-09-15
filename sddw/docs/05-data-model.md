# 5. Data Model

The model is storage-agnostic. `src/domain/types.ts` is the executable form of this document.

## 5.1 Entities

```
Specification 1---* SpecificationVersion 1---* Section
Specification 1---* Review 1---* Finding
Specification 1---* Approval 1---* Evidence
Specification 1---* Deliverable (DeliveryPack) 1---* DeliveryItem
Specification 1---* AuditEvent
Specification *---* User (owner, contributors, reviewers)
```

### Specification (header / current state)

| Field | Type | Notes |
|---|---|---|
| id | string | `SPEC-<AREA>-<seq>` e.g. `SPEC-LRN-0042` |
| title | string | |
| productArea | enum/lookup | e.g. Learning, Assessment, Platform |
| status | `Active` \| `On hold` \| `Archived` | operational status, distinct from lifecycle |
| lifecycleStage | `Draft` \| `Review` \| `Certified` \| `In Delivery` \| `Released` \| `Retired` | |
| owner | UserRef | |
| contributors | UserRef[] | |
| tags | string[] | |
| currentVersion | SemVer string | `major.minor` — major bumps on certification, minor on saves after certification |
| completion | number 0–100 | derived |
| createdAt / updatedAt / updatedBy | | |
| dataClassification | `internal` default | |

### SpecificationVersion

| Field | Type | Notes |
|---|---|---|
| specId, version | | composite key |
| sections | Record<SectionKey, Section> | structured content |
| markdown | string | generated |
| manifestYaml | string | generated |
| certifiedAt, certifiedVersionOf | | set when this version was certified |
| etag | string | optimistic concurrency |

### Section

Every section shares an envelope and has a typed `content` payload.

| Field | Type |
|---|---|
| key | SectionKey (see below) |
| group | `Product` \| `UX` \| `Architecture` \| `Data` \| `Engineering` \| `QA` \| `Operations` |
| completion | `empty` \| `partial` \| `complete` |
| content | typed per section |
| lastEditedBy, lastEditedAt, source (`human` \| `ai`) | |

### SectionKey → Group

| Group | Sections |
|---|---|
| Product | productIntent, personas, userJourneys |
| UX | uxRequirements, accessibilityRequirements |
| Architecture | architecture, adrs, nfrs, integrationDesign |
| Data | dataDesign, security, privacy, responsibleAi, safeguarding |
| Engineering | engineeringPlan |
| QA | qaStrategy |
| Operations | devOpsStrategy, operationalReadiness |

### Review and Finding

| Review | Finding |
|---|---|
| id, specId, version | id, reviewId |
| kind: `ai-review` \| `critique` \| `contradictions` \| `constitution` \| `reuse` \| `architecture` \| `privacy` \| `human` | category: `warning` \| `risk` \| `open-question` \| `suggested-change` |
| status: `queued` \| `running` \| `complete` \| `failed` | severity: `blocker` \| `high` \| `medium` \| `low` |
| requestedBy, requestedAt, completedAt | sectionKey, title, rationale, suggestion? |
| agentVersion, correlationId | status: `open` \| `accepted` \| `rejected` \| `resolved`, resolvedBy, resolution |

### Approval and Evidence

| Approval | Evidence |
|---|---|
| id, specId, version | id, approvalId |
| type: `architecture` \| `privacy` \| `security` \| `product` | kind: `link` \| `file` \| `review-run` |
| status: `pending` \| `approved` \| `rejected` \| `waived` | uri / driveItemId / reviewId |
| approver, decidedAt, comment, waiverReason, secondApprover | addedBy, addedAt |

### DeliveryPack and DeliveryItem

| DeliveryPack | DeliveryItem |
|---|---|
| id, specId, version, generatedAt, generatedBy, reviewId | id, packId, type: `epic` \| `story` \| `acceptance-criterion` \| `adr` \| `task` \| `qa-case` \| `bdd-scenario` \| `devops-check` |
| exportedTo: Jira key / ADO id | key, title, body, parentId, tracesTo: SectionKey[] / requirement IDs |

### AuditEvent

| Field | Notes |
|---|---|
| id, specId, version | |
| action | `created`, `section.updated`, `stage.promoted`, `stage.demoted`, `ai.run`, `ai.accepted`, `ai.rejected`, `approval.set`, `evidence.added`, `pack.generated`, `pack.exported` |
| actor (UserRef), at | |
| summary, before?, after? | small JSON snapshots, not full documents |

## 5.2 Lifecycle state machine

```
 Draft --promote--> Review --promote--> Certified --promote--> In Delivery --promote--> Released --promote--> Retired
   ^                  |                    |
   +------demote------+                    +------demote (new draft version)------> Draft
```

Guards (enforced in `src/domain/lifecycle.ts`):

| Transition | Guard |
|---|---|
| Draft → Review | completion ≥ 60%, Product Intent complete |
| Review → Certified | completion ≥ 90%, no open blocker findings, 4/4 approvals approved or waived |
| Certified → In Delivery | delivery pack generated for the certified version |
| In Delivery → Released | at least one release evidence link |
| Released → Retired | retirement reason |
| Any edit while Certified/In Delivery | creates a new Draft version and marks certification stale |

## 5.3 Manifest (YAML) shape

```yaml
sddw: 1
spec:
  id: SPEC-LRN-0042
  title: Offline Reader
  productArea: Learning
  version: "1.4"
  lifecycleStage: Review
  owner: jane.doe@pearson.com
  contributors: [a.khan@pearson.com]
  tags: [mobile, offline]
sections:
  productIntent: { completion: complete, updatedAt: 2026-09-14T10:02:00Z }
  personas:      { completion: complete, count: 3 }
  ...
certification:
  architecture: approved
  privacy: pending
  security: approved
  product: approved
review:
  openFindings: 4
  blockers: 1
```

The Markdown document is generated section by section from the same model (see `src/domain/manifest.ts`).
