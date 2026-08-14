# Interim design system

This slice uses Radix UI primitives and Tailwind CSS as its interim component layer. The specification-level Pearson Design System commitment cannot yet be resolved because the ActiveHub-approved layer remains open. This is not represented as the Pearson Design System.

A later slice is expected to re-skin the console to the approved PDS layer without changing its information structure, keyboard behaviour, or accessibility semantics.

## Shared structural foundation

Ops Console is the reference implementation for `packages/design-system/src/foundation.css`, the
structural layer (spacing, radius, type, motion, focus ring, console shell, and shared component
shapes such as the card grid, drawer/dialog and status badge) shared with the Admin workspace and,
for common component shapes only, the Mock Consumer. `src/styles.css` imports the foundation and
then defines only this surface's own colour tokens (`--lorb-*` custom properties) and the handful
of components — search bar, stat panel, launcher form, table — that are specific to this console.

This surface's palette (navy/blue) is its own; other surfaces are not required to match it, and the
Admin workspace is specifically required not to (see its README-design-system.md).
