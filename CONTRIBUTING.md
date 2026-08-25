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

## Invariants

Some properties are not negotiable in a change, because breaking one is not a bug
in a feature — it is a platform that no longer holds a promise it made. Each has a
test that fails if the control is removed, listed in
[`tests/anti-requirements/README-anti-requirements.md`](tests/anti-requirements/README-anti-requirements.md)
and recorded in [`docs/specs/spec.yaml`](docs/specs/spec.yaml).

Before changing one, understand what it protects. Several exist because the
obvious implementation was tried and turned out to be wrong.

Two that are easy to break by accident:

- **Do not weaken pseudonymisation to simplify a test.** If a test needs the
  identifier-to-pseudonym mapping, it is asking the wrong question — no such
  mapping is stored, and that is the design rather than an omission.
- **Do not add a second way in.** Every credential path is one somebody has to
  reason about, and a development shortcut left reachable in a deployed
  environment is how a platform with good authentication ends up with none.

## Contract changes

These need a review that considers every consumer, not only the caller that
prompted the change: the launch descriptor schema, the pseudonymisation function
and its inputs, the error taxonomy, the postMessage protocol, and the xAPI
statement contract.

## Running the checks

```sh
pnpm typecheck
pnpm test              # needs DATABASE_URL for the persistence and roster suites
pnpm test:browser      # needs the player bundles built first
```

The persistence suite skips itself without a database, so a green local run
without one is not the same gate continuous integration applies.
