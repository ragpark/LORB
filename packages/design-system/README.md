# LORB shared UI foundation

`src/foundation.css` is the structural design-system layer shared by LORB's own management
surfaces (Ops Console, Admin workspace) and, for common component shapes only, the Learner Portal.
It is not a component library and not the Pearson Design System — the specification-level PDS
commitment remains OPEN (BLK-07). This is an interim, hand-rolled CSS foundation, imported by each
surface's own `src/styles.css` via a relative `@import`.

**What it owns:** spacing scale, radius scale, shadow scale, type stack, motion/reduced-motion
behaviour, the shared focus ring, and the shape (not colour) of common components — skip link,
overlay, drawer/dialog, card, badge, tooltip, form-field and button chrome. For Ops Console and the
Admin workspace specifically, it also owns the console shell: a fixed draft banner, fixed header
and fixed sidebar, scoped to a `<div class="app">` root so it never leaks into surfaces that don't
use that shell shape (e.g. the Learner Portal, which is a simple flowing page by design).

**What it deliberately does not own:** colour. Each surface defines its own palette as
`--lorb-*` custom properties (ink, paper, surface, line, accent, on-accent, overlay, env-*,
sidebar-*) and the foundation consumes them. This is not an oversight — the Admin workspace's
palette is a tested anti-requirement (no blue-and-white Pearson-style palette; see
`packages/admin-ui/tests/anti-requirements/README-anti-requirements.md` #22) and the Mock
Consumer's palette is deliberately generic because it simulates a third-party platform, not LORB.
Unifying colour across surfaces is explicitly out of scope.

See each surface's own `README-design-system.md` for how it uses this foundation.
