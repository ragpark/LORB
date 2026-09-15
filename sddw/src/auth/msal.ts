import { PublicClientApplication, InteractionRequiredAuthError, type AccountInfo } from '@azure/msal-browser';
import type { RuntimeConfig } from '@/app/runtimeConfig';
import type { TokenProvider } from '@/services/http';

/**
 * MSAL is used only to obtain delegated tokens for Microsoft Graph, Dataverse and the Companion gateway.
 * Reaching the app itself is gated by Cookie's SSO sidecar; the SPA never implements login pages.
 */
export function createMsal(cfg: RuntimeConfig): PublicClientApplication | null {
  if (!cfg.entraClientId || !cfg.entraTenantId) return null;
  return new PublicClientApplication({
    auth: { clientId: cfg.entraClientId, authority: `https://login.microsoftonline.com/${cfg.entraTenantId}`, redirectUri: window.location.origin, postLogoutRedirectUri: window.location.origin },
    cache: { cacheLocation: 'sessionStorage' },
  });
}

export function createTokenProvider(msal: PublicClientApplication | null): TokenProvider {
  return async (scope: string) => {
    if (!msal) return 'mock-token';
    await msal.initialize();
    let account: AccountInfo | undefined = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
    if (!account) { const r = await msal.loginPopup({ scopes: [scope] }); account = r.account; msal.setActiveAccount(account); }
    try {
      return (await msal.acquireTokenSilent({ scopes: [scope], account })).accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) return (await msal.acquireTokenPopup({ scopes: [scope], account })).accessToken;
      throw e;
    }
  };
}
