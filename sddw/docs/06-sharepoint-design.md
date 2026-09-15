# 6. SharePoint Design (Option A)

A single SharePoint site `SDDW` holds four lists and one document library, accessed through Microsoft Graph with delegated permissions.

## 6.1 Lists

### Specifications
| Column | Type | Indexed |
|---|---|---|
| Title | text | |
| SpecId | text (unique) | yes |
| ProductArea | choice | yes |
| Status | choice | yes |
| LifecycleStage | choice | yes |
| Owner | person | yes |
| Contributors | person (multi) | |
| Tags | managed metadata or multi-choice | |
| CurrentVersion | text | |
| Completion | number | |
| DataClassification | choice | |
| ManifestJson | multiline (plain) | current structured model (≤ 63k chars; larger models spill to the library) |

### Reviews
SpecId (indexed), Version, Kind, Status, RequestedBy, RequestedAt, CompletedAt, AgentVersion, CorrelationId, FindingsJson (multiline), OpenBlockers (number, indexed).

### Approvals
SpecId (indexed), Version, ApprovalType (choice), Status (choice, indexed), Approver (person), DecidedAt, Comment, WaiverReason, SecondApprover, EvidenceJson.

### Deliverables
SpecId (indexed), Version, GeneratedAt, GeneratedBy, ReviewId, ExportedTo, ItemsJson (multiline) or pointer to file in library.

### AuditEvents
SpecId (indexed), Version, Action (choice, indexed), Actor (person), At, Summary, BeforeJson, AfterJson. Item-level permissions: contribute-only, no edit/delete (via list settings + retention label).

## 6.2 Document library `SpecDocuments`

```
/SpecDocuments/
  SPEC-LRN-0042/
    v1.3/spec.md
    v1.3/manifest.yaml
    v1.3/model.json
    v1.4/spec.md
    v1.4/manifest.yaml
    v1.4/model.json
    evidence/dpia-2026-09.pdf
```

Versioning on the library is enabled for belt-and-braces; the canonical version is the folder.

## 6.3 Graph calls used

| Operation | Graph |
|---|---|
| List/filter specs | `GET /sites/{site}/lists/{Specifications}/items?expand=fields&$filter=fields/LifecycleStage eq 'Review'` (indexed columns only) |
| Create spec | `POST /sites/{site}/lists/{Specifications}/items` |
| Update header | `PATCH .../items/{id}/fields` with `If-Match` etag |
| Save version files | `PUT /sites/{site}/drives/{drive}/root:/SPEC-…/v1.4/spec.md:/content` |
| Search | `POST /search/query` (entityTypes listItem, driveItem) |
| People | `GET /users?$search`, `GET /me/memberOf` (approver groups) |

## 6.4 Security

- Site members = all SDD practitioners (read/contribute).
- Approvals list: contribute for the four approver Entra groups; UI additionally enforces type-to-group mapping.
- AuditEvents list: "Add items" only; edits blocked by retention label and a Power Automate flow that reverts changes.
- Delegated Graph scopes: `Sites.ReadWrite.All` (or `Sites.Selected` + app grant for the SDDW site), `Files.ReadWrite.All`, `User.ReadBasic.All`, `GroupMember.Read.All`.

## 6.5 Strengths and limits

| Strengths | Limits |
|---|---|
| Zero provisioning beyond a site; teams already know SharePoint | List view threshold (5,000) forces indexed filters and paging |
| Documents are natural (Markdown/YAML as files, Office preview) | No relational integrity; JSON blobs for findings/items |
| Cheap; covered by existing M365 licences | Weak concurrency (etag per item), no server-side business rules |
| Retention labels give compliance out of the box | Reporting across lists requires client joins or Power BI |
