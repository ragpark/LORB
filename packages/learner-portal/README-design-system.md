# Interim component layer

This is a mock and does not use PDS. PDS commitment for LORB surfaces is OPEN in the specification (UX F.3). The visual identity remains deliberately generic to avoid brand association with any consuming platform.

## Shared structural foundation

`src/styles.css` imports `packages/design-system/src/foundation.css` for the pieces that are
genuinely generic UI mechanics rather than LORB house style: spacing/radius scale, the shared focus
ring, skip-link behaviour, and shared component shapes (card grid, drawer, overlay). This keeps the
mock visually consistent with the rest of LORB's tooling at the level of "how big is a card's
padding" without adopting either console's colour palette or fixed-shell layout — this surface
stays a simple flowing page with its own warm, brand-neutral colours, because it is meant to read
as a third-party consuming platform, not a LORB-owned surface.
