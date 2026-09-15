# ADR-0002: Pluggable storage behind one repository interface, SharePoint first

**Status:** Accepted

**Context.** Two viable stores: SharePoint (fast, cheap, document-native) and Dataverse (relational, governed, scalable).

**Decision.** Define `SpecificationRepository` and ship SharePoint, Dataverse and in-memory adapters selected by `STORAGE_PROVIDER`. MVP defaults to SharePoint. Markdown, YAML and evidence files always live in the SharePoint library, in both options.

**Consequences.** UI code has no storage knowledge; migration to Dataverse replays `model.json` per version; some rules (no self-approval) must be enforced in both the app and the store.
