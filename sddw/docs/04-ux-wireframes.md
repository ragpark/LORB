# 4. UX Wireframes (ASCII)

Layout uses the Nebula Design System application shell: a persistent left navigation rail, a top bar with global search and the user menu, and a content region. The AI Assistant is a right-hand docked panel available on the editor, review and delivery screens.

## 4.1 Application shell

```
+------+---------------------------------------------------------------------+
| SDDW | [Search specs, IDs, owners...............]   Product Area v  (JD) v |
+------+---------------------------------------------------------------------+
| Dash |                                                                     |
| Cat  |                         < content region >                          |
| Rev  |                                                                     |
| Cert |                                                                     |
| Deliv|                                                                     |
|      |                                                                     |
| ---- |                                                                     |
| Help |                                                                     |
+------+---------------------------------------------------------------------+
```

## 4.2 Dashboard

```
 Dashboard                                                  Product Area: All v
 +-----------+-----------+-----------+-----------+-----------+-----------+
 | Draft     | Review    | Certified | In Deliv. | Released  | Retired   |
 |   14      |    6      |    9      |    11     |    23     |    4      |
 +-----------+-----------+-----------+-----------+-----------+-----------+

 +-- Open blockers (5) --------------------+ +-- Pending reviews (6) ----------+
 | ! SPEC-LRN-0042 Privacy: no DPIA ref    | | SPEC-ASM-0017  Adaptive Marking |
 | ! SPEC-ASM-0017 Arch: unbounded queue   | |   2 findings open   Round 2     |
 | ! SPEC-PLT-0003 Security: PII in logs   | | SPEC-LRN-0042  Offline Reader   |
 |   ...                            view > | |   ...                    view > |
 +-----------------------------------------+ +---------------------------------+

 +-- Certification queue --------------------------------------------------+
 | Spec            | Arch | Priv | Sec | Prod |  Waiting on                  |
 | SPEC-LRN-0042   |  ok  |  ..  | ok  |  ok  |  Privacy (3d)                |
 | SPEC-PLT-0003   |  ok  |  ok  | ..  |  ..  |  Security, Product           |
 +-------------------------------------------------------------------------+

 +-- Recently modified ----------------------------------------------------+
 | SPEC-ASM-0017  Adaptive Marking Engine   v3.2  Draft   A. Khan  12m ago |
 | SPEC-LRN-0042  Offline Reader            v1.4  Review  J. Doe   1h ago  |
 +-------------------------------------------------------------------------+
```

## 4.3 Specification Catalogue

```
 Specification Catalogue                                    [+ New specification]
 Filters: [Product Area v] [Owner v] [Status v] [Stage v] [Tag v]  [Clear]
 +----------------+--------------------------+---------+-------+----------+------+------+
 | Spec ID        | Title                    | Area    | Owner | Stage    | Ver  | Done |
 +----------------+--------------------------+---------+-------+----------+------+------+
 | SPEC-ASM-0017  | Adaptive Marking Engine  | Assess. | AK    | Draft    | 3.2  | 64%  |
 | SPEC-LRN-0042  | Offline Reader           | Learn.  | JD    | Review   | 1.4  | 92%  |
 | SPEC-PLT-0003  | Identity Broker          | Platf.  | MS    | Certif.  | 2.0  | 100% |
 +----------------+--------------------------+---------+-------+----------+------+------+
                                                     < 1 2 3 ... 12 >   50 per page v
```

## 4.4 Specification Editor (with AI panel)

```
 < Catalogue   SPEC-LRN-0042  Offline Reader                 v1.4  [Review]  [Promote v]
 Owner: J. Doe   Contributors: AK, MS, +2   Area: Learning   Status: Active   Updated 1h ago
 Tabs: [ Sections ] [ Markdown ] [ Manifest ] [ History ] [ Audit ]
+---------------------+----------------------------------------------+------------------+
| Sections     92%    | UX > Accessibility Requirements   * Partial  | AI Assistant     |
|                     |                                              |                  |
| v Product   100%    | Standard                                     | Section actions  |
|   Product Intent  * | [WCAG 2.2 AA                       v]        | [Generate]       |
|   Personas        * |                                              | [Critique]       |
|   User Journeys   * | Assistive tech supported                     | [Contradictions] |
| v UX         67%    | [x] Screen reader  [x] Switch  [ ] Voice     |                  |
|   UX Requirements * |                                              | Spec actions     |
|   Accessibility   o | Requirements                                 | [Constitution]   |
| > Architecture 80%  | +------+------------------------+---------+  | [Reuse review]   |
| > Data        50%   | | ID   | Requirement            | Level   |  | [Generate ADRs]  |
| > Engineering 40%   | | A11Y1| All controls keyboard..| Must    |  | [Delivery pack]  |
| > QA          0%    | | A11Y2| Offline mode announces.| Must    |  |                  |
| > Operations  30%   | +------+------------------------+---------+  | ---------------- |
|                     | [+ add requirement]                          | Last run         |
|                     |                                              | Critique - 2 min |
|                     | Notes (rich text)                            | 3 suggestions    |
|                     | [ ..................................... ]    | [Accept][Edit]   |
|                     |                                              | [Reject]         |
|                     |                        Saved 12s ago  (auto) |                  |
+---------------------+----------------------------------------------+------------------+
```

Legend: `*` complete, `o` partial, blank empty.

## 4.5 AI proposal card (inside the panel)

```
+-- Proposal: Accessibility Requirements -------------------- run 8f3a ---+
| Source: SDD Companion  |  Confidence: medium  |  Sections read: 4       |
| ---------------------------------------------------------------------- |
| + A11Y3  Offline sync status must be exposed via aria-live (Must)       |
| ~ A11Y1  "All controls keyboard operable" -> add focus order note       |
| - (none removed)                                                        |
| ---------------------------------------------------------------------- |
| Rationale: Journey J3 (offline commute) has no non-visual feedback...   |
|                                        [Reject] [Edit...] [Accept all]  |
+-------------------------------------------------------------------------+
```

## 4.6 Review Workspace

```
 Review  SPEC-LRN-0042 v1.4        Round 2      Reviewers: MS (pending), AK (approved)
 [ Warnings 4 ] [ Risks 2 ] [ Open questions 3 ] [ Suggested changes 5 ]     [Run review]
 +--------+----------------------------------+--------------+----------+-----------------+
 | Sev    | Finding                          | Section      | Status   | Actions         |
 +--------+----------------------------------+--------------+----------+-----------------+
 | BLOCK  | No DPIA reference for offline    | Privacy      | Open     | [Resolve][Dismiss]|
 |        | cache of learner progress        |              |          |                 |
 | HIGH   | Sync conflict strategy undefined | Data Design  | Accepted | [Open section]  |
 | MED    | Persona P2 has no journey        | User Journeys| Resolved |                 |
 +--------+----------------------------------+--------------+----------+-----------------+
 Promotion to Certified blocked: 1 blocker open.
```

## 4.7 Certification Workspace

```
 Certification  SPEC-LRN-0042 v1.4                           Certified when 4/4 approved
 +---------------+-----------+---------------+------------+---------------------------+
 | Approval      | Status    | Approver      | Date       | Evidence                  |
 +---------------+-----------+---------------+------------+---------------------------+
 | Architecture  | Approved  | M. Singh      | 12 Sep     | ADR-004, review run 7c1e  |
 | Privacy       | Pending   | -             | -          | [+ add evidence] [Approve]|
 | Security      | Approved  | R. Osei       | 13 Sep     | Threat model link         |
 | Product       | Approved  | J. Doe*       | 11 Sep     | * owner cannot approve -> |
 |               |           |               |            |   reassigned to P. Lee    |
 +---------------+-----------+---------------+------------+---------------------------+
```

## 4.8 Delivery Pack Generator

```
 Delivery Pack  SPEC-LRN-0042 v1.4 (Certified)                [Generate] [Export v] [Push to Jira]
 [ Epics 3 ] [ Stories 18 ] [ Acceptance 41 ] [ ADRs 4 ] [ Tasks 27 ] [ QA matrix ] [ BDD 22 ] [ DevOps ]
 +------+--------------------------------+--------------+-------------------+
 | Key  | Story                          | Epic         | Traces to         |
 +------+--------------------------------+--------------+-------------------+
 | S-01 | As a commuter I can open a     | E-1 Offline  | J3, UXR-4, A11Y3  |
 |      | downloaded chapter with no...  |              |                   |
 +------+--------------------------------+--------------+-------------------+
```

## 4.9 Promotion dialog

```
+-- Promote to Certified -------------------------------------------+
| Guard checks                                                      |
|  [ok] Completion >= 90%              (92%)                        |
|  [ok] No open blocker findings                                    |
|  [ok] Architecture approved   [ok] Security approved              |
|  [!!] Privacy approval pending                                    |
|                                                                   |
| Promotion is not available until all checks pass.      [Close]    |
+-------------------------------------------------------------------+
```
