# ADR-0001: The web application is the primary UI; the Copilot agent is a service layer

**Status:** Accepted

**Context.** The SDD Companion exists as a Copilot Studio chat agent. Specifications are large, multi-author, long-lived artefacts that need lifecycle, certification and reporting.

**Decision.** Build SDDW as a React SPA that owns the user experience and persistence. The Companion is exposed through a gateway of typed, asynchronous operations; the SPA never constructs prompts.

**Consequences.** Prompt engineering can evolve independently; results must be structured; the agent team owns the gateway contract (`docs/09-api-layer-design.md`).
