import { allowsDevelopmentSignIn, OidcClient, type EnvironmentLabel } from '@lorb/web-auth';
import { webEnv } from '../runtime-env.js';

const TOKEN_KEY = 'lorb_admin_token';

export const session = {
  getToken: () => sessionStorage.getItem(TOKEN_KEY),
  setToken: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => {
    sessionStorage.removeItem(TOKEN_KEY);
  },
};

export function installTabCloseClear() {
  const clear = () => session.clear();
  window.addEventListener('beforeunload', clear);
  return () => window.removeEventListener('beforeunload', clear);
}

/**
 * Development sign-in.
 *
 * Deployed environments sign in through the institution's identity provider (see the OidcClient
 * below); this exists so `pnpm dev` needs no provider at all. It is gated on the environment label
 * rather than on a build flag, because a build flag is the kind of thing that gets flipped once for
 * a debugging session and never flipped back.
 *
 * The subject is never stored or rendered beyond the moment of sign-in: the workspace identifies the
 * signed-in administrator by their pseudonym, from GET /admin/whoami.
 */
export async function signInForDevelopment(loginUrl: string, subject: string, environment: string): Promise<void> {
  if (!allowsDevelopmentSignIn(environment as EnvironmentLabel)) {
    throw new Error('The development sign-in is not available in this environment.');
  }
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, role: 'admin' }),
  });
  if (!response.ok) throw new Error('Development sign-in failed.');
  const body = (await response.json()) as { access_token: string };
  session.setToken(body.access_token);
}

/**
 * The identity provider client, when one is configured. Undefined in a development build with no
 * provider, which is the only case the development sign-in above covers.
 */
export function adminOidcClient(): OidcClient | undefined {
  const issuer = webEnv.VITE_OIDC_ISSUER;
  const clientId = webEnv.VITE_OIDC_CLIENT_ID;
  if (!issuer || !clientId) return undefined;
  return new OidcClient({
    issuer,
    clientId,
    redirectUri: webEnv.VITE_OIDC_REDIRECT_URI ?? location.origin,
    audience: webEnv.VITE_OIDC_AUDIENCE,
    scope: webEnv.VITE_OIDC_SCOPE,
  });
}

/** Copies the provider session into the workspace's own token slot after a completed sign-in. */
export function adoptProviderSession(accessToken: string): void {
  session.setToken(accessToken);
}
