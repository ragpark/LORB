# 7. Dataverse Design (Option B)

Publisher prefix `sddw`. All tables are user-owned (record ownership drives security) except the audit table which is organisation-owned.

## 7.1 Tables

| Table | Key columns | Notes |
|---|---|---|
| `sddw_specification` | sddw_specid (alt key), sddw_title, sddw_productarea (choice), sddw_status (choice), sddw_lifecyclestage (choice), ownerid, sddw_currentversion, sddw_completion, sddw_dataclassification, sddw_tags (multi-choice) | header |
| `sddw_specificationversion` | sddw_specification (lookup), sddw_version, sddw_modeljson (memo), sddw_markdown (memo), sddw_manifestyaml (memo), sddw_certifiedon, rowversion | one row per saved version |
| `sddw_section` | sddw_version (lookup), sddw_key (choice), sddw_group (choice), sddw_completion (choice), sddw_contentjson (memo), sddw_source (choice) | normalised for reporting; optional in MVP (modeljson is canonical) |
| `sddw_contributor` | sddw_specification (lookup), systemuser (lookup), sddw_role (choice: owner, contributor, reviewer) | N:N via intersect table |
| `sddw_review` | sddw_specification, sddw_version, sddw_kind, sddw_status, sddw_requestedby, sddw_completedon, sddw_agentversion, sddw_correlationid | |
| `sddw_finding` | sddw_review (lookup), sddw_category, sddw_severity, sddw_sectionkey, sddw_title, sddw_rationale, sddw_suggestion, sddw_status, sddw_resolvedby, sddw_resolution | |
| `sddw_approval` | sddw_specification, sddw_version, sddw_type, sddw_status, sddw_approver, sddw_decidedon, sddw_comment, sddw_waiverreason, sddw_secondapprover | |
| `sddw_evidence` | sddw_approval (lookup), sddw_kind, sddw_uri, sddw_driveitemid, sddw_review (lookup) | files themselves in SharePoint (Dataverse–SharePoint integration) |
| `sddw_deliverypack` | sddw_specification, sddw_version, sddw_generatedon, sddw_review, sddw_exportedto | |
| `sddw_deliveryitem` | sddw_deliverypack, sddw_type, sddw_key, sddw_title, sddw_body, sddw_parent (self lookup), sddw_tracesto (text) | |
| `sddw_auditevent` | sddw_specification, sddw_version, sddw_action, sddw_actor, sddw_on, sddw_summary, sddw_beforejson, sddw_afterjson | org-owned, create-only |

## 7.2 Relationships

```
sddw_specification 1:N sddw_specificationversion 1:N sddw_section
sddw_specification 1:N sddw_review 1:N sddw_finding
sddw_specification 1:N sddw_approval 1:N sddw_evidence
sddw_specification 1:N sddw_deliverypack 1:N sddw_deliveryitem (self N:1 parent)
sddw_specification 1:N sddw_auditevent
sddw_specification N:N systemuser (sddw_contributor)
```

Cascade: version/review/approval/pack → **Restrict** delete of the parent specification (specifications are retired, never deleted). Audit → no cascade, delete disabled by role.

## 7.3 Security model

| Role | Specification | Version | Review/Finding | Approval | Audit |
|---|---|---|---|---|---|
| SDDW Reader | Read (org) | Read | Read | Read | Read |
| SDDW Contributor | Create; Write (user/team-owned or contributor) | Create/Write | Create/Write | Read | Create |
| SDDW Architecture Approver | Read | Read | Read | Write where type = architecture (enforced by plug-in) | Create |
| SDDW Privacy / Security / Product Approver | as above per type | | | | |
| SDDW Admin | Full | Full | Full | Full | Read |

Roles are assigned to Entra groups via Dataverse team mapping (group teams). Business rule / plug-in `sddw.ApprovalGuard` rejects an approval when approver = specification owner, or when approver lacks the group for that type.

Column-level security: `sddw_beforejson/afterjson` on audit (read by Admin/Reader), `sddw_waiverreason` (Approvers, Admin).

Auditing: Dataverse auditing enabled on all `sddw_*` tables for a second, tamper-evident trail; retention policy 7 years.

## 7.4 Access from the app

- Web API via Graph is **not** available; use the Dataverse Web API directly (`https://{org}.crm11.dynamics.com/api/data/v9.2/`) with an MSAL token for scope `https://{org}.crm11.dynamics.com/user_impersonation`.
- OData `$filter`, `$expand`, `$count`, server-side paging (`Prefer: odata.maxpagesize=50`).
- Optimistic concurrency via `If-Match: <rowversion etag>`.
- Files: Dataverse file columns for `spec.md`/`manifest.yaml` (≤128 MB) **or** the SharePoint document location integration; recommendation is SharePoint document locations so the same library serves both options.

## 7.5 Strengths and limits

| Strengths | Limits |
|---|---|
| Real relational model, alternate keys, referential restrict | Requires Dataverse capacity and environment governance |
| Row-level security, group teams, column security, native audit | Second token audience alongside Graph |
| Server-side business rules and plug-ins (approval guard, immutable audit) | Solution ALM (managed solutions, pipelines) is extra process |
| Scales to hundreds of thousands of rows; Power BI direct query | Higher initial setup effort (1–2 weeks) |

## 7.6 Comparison and recommendation

| Criterion | SharePoint-first | Dataverse-first |
|---|---|---|
| Time to first working MVP | **Days** | 1–2 weeks |
| Cost | Included in M365 | Dataverse capacity / per-app licences |
| Data integrity | Client-enforced | Server-enforced |
| Security granularity | Site/list/item | Table/row/column + plug-ins |
| Scale (specs) | comfortable to ~5k, workable to 20k with indexes | 100k+ |
| Reporting | Power BI over lists (limited) | Power BI / Fabric direct |
| Documents (MD/YAML) | Native | Via SharePoint integration anyway |
| Audit immutability | Retention label + flow | Native audit + role denial |

**Recommendation**

- **Rapid MVP:** SharePoint-first. One site, four lists, one library; the repository adapter in `src/services/storage/sharepoint` is complete enough to ship in weeks and the documents live where reviewers already look.
- **Enterprise scale (system of record):** Dataverse-first for structured entities, **keeping the SharePoint library for `spec.md`, `manifest.yaml` and evidence** via Dataverse document locations. Migrate by replaying `model.json` per version into `sddw_specificationversion`; the storage interface (`SpecificationRepository`) is unchanged so the UI does not change.

The codebase ships both adapters behind one interface and a `STORAGE_PROVIDER` runtime flag.
