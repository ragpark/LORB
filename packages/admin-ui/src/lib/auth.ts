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

// Never store or surface the raw synthetic subject beyond the moment of sign-in — the UI
// identifies the signed-in administrator by their pseudonym (via GET /admin/whoami), not the
// subject they typed in, so no raw IES subject is ever rendered (Section 13, anti-requirement 17).
export async function signInAdmin(loginUrl: string, subject: string): Promise<void> {
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, role: 'admin' }),
  });
  if (!response.ok) throw new Error('Synthetic administrator sign-in failed.');
  const body = (await response.json()) as { access_token: string };
  session.setToken(body.access_token);
}
