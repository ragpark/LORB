# Contributing to LORB

## Before implementation

1. Create a kebab-case directory at `docs/specs/<feature-name>/`.
2. Add the supplied YAML contract as `spec.yaml` and the supplied Markdown
   design as `design.md`.
3. Confirm the two sources agree. Resolve contradictions in the source
   documents rather than silently choosing one during implementation.
4. Copy the planning templates into the feature directory and complete them.
5. Obtain approval for the acceptance criteria and implementation plan.

## During implementation

- Work from `tasks.md`, keeping requirement identifiers intact in code, tests,
  and verification notes where practical.
- Record decisions that change or clarify the approved design in
  `decisions.md` before depending on them.
- Treat a scope change as a specification change: update the source documents,
  review the effect on the plan and tests, and then resume implementation.
- Keep commits focused and include the relevant feature or requirement ID in
  the commit message when one exists.

## Before review

1. Complete every applicable acceptance criterion.
2. Run the checks described by the feature's test plan.
3. Fill in `verification.md`, including commands, results, and any known gaps.
4. Ensure the pull request links the feature directory and explains any
   departures from the approved specification.

See [`docs/specs/README.md`](docs/specs/README.md) for file responsibilities and
the change lifecycle.
