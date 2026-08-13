# Specification workspace

This directory holds the durable record for every feature. Use one directory
per independently reviewable feature:

```text
docs/specs/<feature-name>/
├── spec.yaml       # Machine-readable requirements supplied by the owner
├── design.md       # Human-readable design supplied by the owner
├── plan.md         # Implementation and rollout plan
├── tasks.md        # Traceable implementation checklist
├── decisions.md    # Clarifications and design decisions
└── verification.md # Evidence that acceptance criteria were met
```

Do not create empty feature directories. When the source YAML and Markdown are
available, add them together and copy the four Markdown templates from
`docs/templates/`.

## Source-of-truth rules

- `spec.yaml` defines the structured requirements, requirement identifiers,
  constraints, and acceptance criteria.
- `design.md` explains intent, user experience, architecture, and behavior that
  are awkward to express as structured data.
- Neither document silently overrides the other. Contradictions are blocking
  questions and must be resolved in both documents.
- Derived files (`plan.md`, `tasks.md`, `decisions.md`, and `verification.md`)
  must link back to stable requirement IDs from `spec.yaml`.
- Approved source documents are changed before implementation when scope or
  behavior changes. The derived files are then updated in the same change.

## Lifecycle

1. **Define:** add the YAML contract and design document; check that every
   requirement has a stable ID and a verifiable outcome.
2. **Review:** resolve open questions, risks, dependencies, and contradictions;
   record approval in the design document according to the team's review
   process.
3. **Plan:** create `plan.md` and turn each acceptance criterion into one or
   more entries in `tasks.md`.
4. **Build:** implement in task order, recording material clarifications in
   `decisions.md`.
5. **Verify:** run automated and manual checks and capture evidence in
   `verification.md`.
6. **Close:** confirm each requirement is implemented, verified, deferred with
   an owner, or explicitly removed from the approved specification.

## Definition of ready

A feature is ready to build when its goal and non-goals are clear, requirements
have stable IDs, acceptance criteria are testable, dependencies and data or API
changes are described, unresolved questions have owners, and the plan has been
reviewed.

## Definition of done

A feature is done when implementation and documentation match the approved
sources, required checks pass, every requirement maps to verification evidence,
operational or migration work is complete, and remaining limitations are
explicitly documented.
