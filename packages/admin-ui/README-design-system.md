# Design system

Radix UI primitives as the component layer, matching the Operations Console. Radix is used
specifically for the things that are easy to get wrong by hand and hard to notice when you have:
dialog focus trapping, focus restoration, and Escape handling.

The workspace can be re-skinned to a corporate design system without changing its information
structure, keyboard behaviour or accessibility semantics — the colour tokens are the seam, and they
are deliberately the only thing not shared with the other surfaces.

## Shared structural foundation

`src/styles.css` imports `packages/design-system/src/foundation.css`, the same structural layer the
Ops Console uses: spacing scale, radius scale, focus ring, skip link, overlay/drawer/dialog shapes,
card grid, badge, tooltip, and — because this workspace shares the Ops Console's console-shell
shape (fixed environment notice, fixed header, fixed sidebar) — the same layout scaffold, scoped to
this surface's `<div class="app">` root.

**What is intentionally not shared: colour.** This surface defines its own `--lorb-*` colour tokens
(indigo/purple accent, its own ink/paper/line values) instead of the Ops Console's navy/blue —
so that an operator who has both open in adjacent tabs can tell at a glance which one they are
typing into. Enforced by `tests/anti-requirements/admin-ui-enforcement.spec.ts`; changing it to
match the Operations Console means updating that test, deliberately, rather than by accident.
