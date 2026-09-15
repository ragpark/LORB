import { useEffect, useState } from 'react';
import type { PublicClientApplication } from '@azure/msal-browser';
import type { Principal } from '@/domain/authorization';
import type { GraphClient } from '@/services/graph/graphClient';

export const DEMO_PRINCIPAL: Principal = {
  user: { id: 'u-jane', displayName: 'Jane Doe', email: 'jane.doe@pearson.com' },
  groups: ['sddw-approvers-architecture', 'sddw-approvers-security', 'sddw-approvers-product', 'sddw-approvers-privacy'],
};

/** Resolves the signed-in principal from MSAL + Graph group membership; falls back to a demo principal in mock mode. */
export function useCurrentUser(msal: PublicClientApplication | null, graph: GraphClient | null) {
  const [principal, setPrincipal] = useState<Principal | null>(msal ? null : DEMO_PRINCIPAL);
  useEffect(() => {
    if (!msal) return;
    let live = true;
    (async () => {
      await msal.initialize();
      const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
      const groups = graph ? await graph.myGroups().catch(() => []) : [];
      if (live && account) setPrincipal({ user: { id: account.localAccountId, displayName: account.name ?? account.username, email: account.username }, groups });
    })();
    return () => { live = false; };
  }, [msal, graph]);
  return principal;
}
