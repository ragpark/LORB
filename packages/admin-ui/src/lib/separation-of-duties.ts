// Layer 1 of the three-layer separation-of-duties rule (Section 12): the UI disables the direct
// action for the same principal. Layers 2 (API) and 3 (Postgres CHECK constraint) live in runtime-api.
export function isSelfApproval(currentPrincipalPseudonym: string | undefined, requestedByPseudonym: string): boolean {
  return !!currentPrincipalPseudonym && currentPrincipalPseudonym === requestedByPseudonym;
}
