# Interim design system

This slice uses Radix UI primitives as its interim component layer, matching the Ops Console's
precedent. The specification-level Pearson Design System commitment cannot yet be resolved because
the ActiveHub-approved layer remains open (BLK-07). This is not represented as the Pearson Design
System, and the palette deliberately avoids the Pearson blue-and-white scheme (see anti-requirement
22 in [`tests/anti-requirements/README-anti-requirements.md`](tests/anti-requirements/README-anti-requirements.md)).

A later slice is expected to re-skin the workspace to the approved PDS layer without changing its
information structure, keyboard behaviour, or accessibility semantics.

## Shared structural foundation

`src/styles.css` imports `packages/design-system/src/foundation.css`, the same structural layer the
Ops Console uses: spacing scale, radius scale, focus ring, skip link, overlay/drawer/dialog shapes,
card grid, badge, tooltip, and — because this workspace shares the Ops Console's console-shell
shape (fixed draft banner, fixed header, fixed sidebar) — the same layout scaffold, scoped to this
surface's `<div class="app">` root.

**What is intentionally not shared: colour.** This surface defines its own `--lorb-*` colour tokens
(indigo/purple accent, its own ink/paper/line values) instead of the Ops Console's navy/blue —
this is anti-requirement 22, enforced by `tests/anti-requirements/admin-ui-enforcement.spec.ts`
("22 does not use blue-and-white Pearson-style palettes"), and must not be changed to match Ops
Console's palette without first resolving that anti-requirement with the accountable owner (BLK-03)
and updating the corresponding spec/test.
