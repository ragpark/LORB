# ADR-0003: Markdown and YAML are generated from one structured model

**Status:** Accepted

**Context.** Users need a readable document; tooling needs a machine-readable manifest. Editing either directly would let them drift.

**Decision.** The structured section model (`model.json`) is canonical. `spec.md` and `manifest.yaml` are deterministic renderings produced in `src/domain/manifest.ts` on every save and stored alongside the model.

**Consequences.** No free-form document editing; rendering changes are versioned with the app; diffs are section-level.
