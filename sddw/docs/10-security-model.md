# 10. Security Model

## 10.1 Identity

| Layer | Mechanism |
|---|---|
| Reaching the app | Cookie platform SSO (Envoy OIDC → Keycloak → Entra ID). Unauthenticated users never reach the SPA. Sign-out is `/oauth2/sign_out`. |
| Calling Microsoft Graph / SharePoint | MSAL.js (PKCE, `@azure/msal-browser`) with **delegated** scopes; tokens cached in session storage; the user's own permissions apply. |
| Calling Dataverse | Same MSAL instance, scope `https://{org}.crm11.dynamics.com/user_impersonation`. |
| Calling the Companion Gateway | MSAL scope for the gateway app registration; the gateway validates audience and enforces spec-level read access. |

The app never holds client secrets. The Node host only serves static files and `/app-config.json` (public, non-secret values: tenant ID, SPA client ID, gateway URL, site ID, provider flag).

## 10.2 Roles

| Role | Derived from | Can |
|---|---|---|
| Reader | Any SSO user in `cookie-app-sdd-workbench` | View dashboard, catalogue, specs, reviews, approvals |
| Contributor | Listed as owner/contributor on a specification | Edit sections, run AI actions, request review, promote Draft→Review, demote |
| Reviewer | Assigned on a review round | Record verdicts, resolve findings |
| Architecture / Privacy / Security / Product Approver | Entra groups `sddw-approvers-architecture` etc. (read via `/me/memberOf`) | Set the matching approval type; add evidence |
| Admin | Entra group `sddw-admins` | Manage product areas, tags, retire specs, view all audit |

Rules enforced in the UI (`src/domain/authorization.ts`) **and** in storage (SharePoint list permissions / Dataverse roles + plug-in):

- A specification owner cannot approve their own specification (any type).
- Waiver requires a second approver from the same group.
- Audit events are append-only for every role.

## 10.3 Data protection

- Data classification default `internal`; the app shows the classification banner and blocks export when `restricted` unless the user is Admin.
- Specifications, reviews and packs stay inside the Pearson M365 tenant; the Companion Gateway runs in the Pearson Azure tenant. No third-party storage.
- Transport TLS 1.2+ everywhere; Content Security Policy restricts `connect-src` to Graph, the Dataverse org, login.microsoftonline.com and the gateway.
- Local storage holds only UI preferences; drafts autosave to storage, never to the browser.

## 10.4 Responsible AI controls

- AI outputs are proposals; acceptance is a human action logged with `source = ai` and the run ID.
- The gateway returns `agentVersion`; the app records it so any regression can be traced.
- Prompt and system instructions are not exposed to, or configurable from, the UI.
- Constitution review checks the specification against Pearson's engineering constitution; results are findings, not silent edits.

## 10.5 Threats and mitigations (summary)

| Threat | Mitigation |
|---|---|
| Token theft via XSS | Strict CSP, React escaping, no `dangerouslySetInnerHTML` for user content (Markdown rendered through a sanitising renderer), MSAL session storage |
| Privilege escalation via UI tampering | Storage-side permissions and plug-ins are authoritative |
| Prompt injection through spec content | Gateway treats spec content as data; results are schema-validated (`zod`) before display |
| Audit tampering | Append-only lists / roles; Dataverse native audit as second trail |
| Supply chain | Snyk SCA gate in Cookie CI; lockfile committed; SIF base image |
