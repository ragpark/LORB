# 3. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-SEC-1 | Security | All access via Pearson SSO. Cookie's Envoy OIDC sidecar gates the app; Microsoft Graph calls use MSAL with delegated scopes so storage permissions are the user's own. |
| NFR-SEC-2 | Security | No secrets in the browser bundle. Runtime configuration (tenant, client ID, Companion base URL) is served by the Node host from environment variables. |
| NFR-SEC-3 | Security | Role-based authorisation enforced in the UI **and** by the storage layer (SharePoint permissions / Dataverse security roles). |
| NFR-SEC-4 | Security | Approver groups are Entra ID groups; the app never stores group membership. |
| NFR-PRIV-1 | Privacy | Specifications may contain personal data about personas only in aggregate. The app displays a data classification banner (`internal` by default). |
| NFR-PRIV-2 | Privacy | Audit events store user principal name and display name only. |
| NFR-RAI-1 | Responsible AI | Every AI-generated artefact is labelled, attributable to a run ID, and requires human acceptance before it becomes part of the specification. |
| NFR-RAI-2 | Responsible AI | AI actions are logged with model/agent version returned by the Companion. |
| NFR-PERF-1 | Performance | Dashboard first meaningful paint < 2 s on the Pearson network; catalogue page of 50 rows < 1 s. |
| NFR-PERF-2 | Performance | Editor section save round-trip < 800 ms p95. |
| NFR-PERF-3 | Performance | AI actions are asynchronous; UI remains interactive and results are polled every 2 s with back-off. |
| NFR-SCALE-1 | Scalability | 5,000 specifications, 250,000 versions, 500 concurrent users without redesign (Dataverse path). SharePoint path is bounded to 5,000-item list views via indexed columns and paging. |
| NFR-AVAIL-1 | Availability | 99.5% during UK/US business hours. The app is stateless; availability is that of Cookie + Microsoft 365. |
| NFR-A11Y-1 | Accessibility | WCAG 2.2 AA. Full keyboard navigation, visible focus, ARIA landmarks, 4.5:1 contrast, reduced-motion respected. |
| NFR-A11Y-2 | Accessibility | Automated axe checks in CI; manual screen reader pass (NVDA, VoiceOver) before Released. |
| NFR-I18N-1 | Localisation | UI strings externalised; en-GB default. |
| NFR-OBS-1 | Observability | Client errors and AI run outcomes sent to Application Insights; correlation ID passed to the Companion on every call. |
| NFR-OPS-1 | Operability | Container listens on 8080, `/health` returns 200 without dependencies, `/ready` checks runtime config is loaded. Non-root image from the Secure Image Factory. |
| NFR-MAINT-1 | Maintainability | TypeScript strict mode; domain logic (lifecycle, completion, manifest generation) is pure and unit-tested. |
| NFR-PORT-1 | Portability | Storage adapter swap (SharePoint ↔ Dataverse) requires no change outside `src/services/storage`. |
| NFR-COMP-1 | Compliance | Audit trail immutable and retained for 7 years (Dataverse audit / SharePoint retention label). |
