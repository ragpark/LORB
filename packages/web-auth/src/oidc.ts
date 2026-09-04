/**
 * Browser sign-in: OAuth 2.1 authorization code with PKCE.
 *
 * The three LORB front ends previously obtained an access token by POSTing a subject string to a
 * development login endpoint — no password, no consent, no provider. That is fine for a local
 * demonstration and is not a way anybody signs in to a real system, so it is now confined to
 * development and every deployed environment goes through the institution's own provider.
 *
 * Choices worth stating, because each has a cheaper alternative that is worse:
 *
 *   - Authorization code with PKCE, never the implicit flow. A token in a URL fragment ends up in
 *     history, in referrers, and in whatever reads the address bar.
 *   - No client secret. A public client in a browser cannot keep one, and pretending otherwise
 *     just puts a shared secret in a JavaScript bundle.
 *   - The access token lives in memory, with only the PKCE verifier and state briefly in session
 *     storage. Tokens in localStorage survive the tab, are readable by any script on the origin,
 *     and are the standard way a single XSS becomes a persistent session compromise.
 *   - `state` is compared, and the verifier is deleted the moment it is used, so a replayed or
 *     injected callback cannot complete a sign-in.
 */

import { appBaseUrl } from "./app-base.js";

export interface OidcClientConfig {
  /** Authorization server issuer, exactly as it appears in its discovery document. */
  issuer: string;
  clientId: string;
  /** Where the provider sends the browser back. Must be registered with the provider. */
  redirectUri: string;
  /** The API this token is for. Without it a provider may mint a token for the wrong resource. */
  audience?: string;
  scope?: string;
  /** Overrides for a provider that does not use the standard endpoint paths. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  endSessionEndpoint?: string;
}

export interface Session {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

const VERIFIER_KEY = "lorb_pkce_verifier";
const STATE_KEY = "lorb_oauth_state";
const RETURN_KEY = "lorb_oauth_return_to";

const base = (issuer: string) => issuer.replace(/\/$/, "");

function randomString(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The in-memory session.
 *
 * Deliberately not persisted: a reload re-authenticates against the provider, which is usually
 * silent because the provider's own session cookie is still valid, and costs nothing but a redirect.
 */
class SessionHolder {
  private current: Session | undefined;
  /**
   * The refresh token of a session whose access token has expired.
   *
   * An expired access token is exactly the moment a refresh token is for, so dropping the refresh
   * token along with it would leave `renew()` able to run only while it had nothing to do. Signing
   * out clears this too — it is the expiry of the access token that keeps it, never the end of the
   * session.
   */
  private expiredRefreshToken: string | undefined;
  private readonly listeners = new Set<(session: Session | undefined) => void>();

  get(): Session | undefined {
    if (this.current && this.current.expiresAt <= Date.now()) {
      const refreshToken = this.current.refreshToken;
      this.clear();
      this.expiredRefreshToken = refreshToken;
    }
    return this.current;
  }

  get token(): string | undefined {
    return this.get()?.accessToken;
  }

  /** The refresh token to renew with, whether or not the access token it came with has expired. */
  get renewalToken(): string | undefined {
    return this.get()?.refreshToken ?? this.expiredRefreshToken;
  }

  set(session: Session): void {
    this.current = session;
    this.expiredRefreshToken = undefined;
    for (const listener of this.listeners) listener(session);
  }

  clear(): void {
    this.current = undefined;
    this.expiredRefreshToken = undefined;
    for (const listener of this.listeners) listener(undefined);
  }

  subscribe(listener: (session: Session | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const session = new SessionHolder();

export class OidcClient {
  constructor(private readonly config: OidcClientConfig) {}

  private endpoint(name: "authorize" | "token" | "logout"): string {
    const { authorizationEndpoint, tokenEndpoint, endSessionEndpoint, issuer } = this.config;
    if (name === "authorize") return authorizationEndpoint ?? `${base(issuer)}/authorize`;
    if (name === "token") return tokenEndpoint ?? `${base(issuer)}/oauth/token`;
    return endSessionEndpoint ?? `${base(issuer)}/v2/logout`;
  }

  /** Starts a sign-in. Navigates away, so nothing after the call runs. */
  async signIn(returnTo: string = location.pathname + location.search): Promise<void> {
    const verifier = randomString();
    const state = randomString(16);
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(RETURN_KEY, returnTo);

    const url = new URL(this.endpoint("authorize"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    // A blank scope falls back exactly like an absent one: the Dockerfiles materialise an unset
    // VITE_OIDC_SCOPE build arg as an empty string, and `scope=` turns the request into plain
    // OAuth2, which Auth0 refuses for a resource server the client holds no explicit grant on.
    url.searchParams.set("scope", this.config.scope?.trim() || "openid profile email offline_access");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await challengeFor(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (this.config.audience) url.searchParams.set("audience", this.config.audience);
    location.assign(url.toString());
  }

  /**
   * Completes a sign-in if the current URL is a provider callback. Returns false when it is not, so
   * an application can call it unconditionally on start-up.
   *
   * The query string is cleared afterwards: an authorization code is single-use, but leaving it in
   * the address bar puts it in history and in any link the user copies from there.
   */
  async completeSignIn(): Promise<boolean> {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const error = params.get("error");

    if (error) {
      this.clearHandshake();
      throw new Error(`Sign-in was refused by the identity provider (${error}).`);
    }
    if (!code) return false;

    const expectedState = sessionStorage.getItem(STATE_KEY);
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    const returnTo = sessionStorage.getItem(RETURN_KEY) ?? "/";
    this.clearHandshake();

    // A callback that does not match the handshake this tab started is not ours to complete.
    if (!expectedState || !verifier || returnedState !== expectedState) {
      throw new Error("Sign-in could not be completed: the response did not match this browser's request.");
    }

    const response = await fetch(this.endpoint("token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) throw new Error("Sign-in could not be completed: the identity provider rejected the code exchange.");
    const body = (await response.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
    session.set({
      accessToken: body.access_token,
      // Renew a little early rather than discovering expiry mid-request.
      expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
      refreshToken: body.refresh_token,
    });
    history.replaceState({}, "", returnTo);
    return true;
  }

  /** Exchanges a refresh token, when the provider issued one. Returns false if renewal is not possible. */
  async renew(): Promise<boolean> {
    const refreshToken = session.renewalToken;
    if (!refreshToken) return false;
    const response = await fetch(this.endpoint("token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.config.clientId, refresh_token: refreshToken }),
    });
    if (!response.ok) {
      session.clear();
      return false;
    }
    const body = (await response.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
    session.set({
      accessToken: body.access_token,
      expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
      refreshToken: body.refresh_token ?? refreshToken,
    });
    return true;
  }

  /** Drops the local session and, where the provider supports it, ends the provider's session too. */
  signOut(returnTo: string = appBaseUrl()): void {
    session.clear();
    this.clearHandshake();
    const url = new URL(this.endpoint("logout"));
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("returnTo", returnTo);
    location.assign(url.toString());
  }

  private clearHandshake(): void {
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(RETURN_KEY);
  }
}
