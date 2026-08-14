# Design system: out of scope by design

Player Shell is learner-facing runtime chrome — a minimal, sandboxed iframe host for a launched
learning activity — not a LORB management surface. It intentionally does not share
`packages/design-system/src/foundation.css` or either console's palette: its only UI is a one-line
status bar above the sandboxed content frame, and its chrome is covered by the specification's
separate "Player chrome" contract (`docs/specs/design.md`, UX section), not the console design
system this repository's `README-design-system.md` files otherwise describe.
