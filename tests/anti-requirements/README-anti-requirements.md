# LORB-001 MVP anti-requirements

The 15 automated controls from Sections 6.2, 6.3, and 8 are: prohibited descriptor PII; pinned player reference; immutable package version UUID; launch idempotency required; launch replay; runtime audience; evidence actor binding; evidence UUID; evidence deduplication; wildcard postMessage rejection; allow-listed postMessage origins; sandbox without same-origin; sensitive log exclusion; non-wildcard CORS; and legal attempt transitions.

Approximately 75 controls outside this slice—including provider adapters, PRIZM coexistence, SCORM, LTI, xAPI batching, external callbacks, multi-tenant administration, production hosting, real identity, entitlement, monitoring, accessibility certification, privacy certification, and threat modelling—are **out of MVP scope and not yet enforced**. They must be added in later reviewed slices.
