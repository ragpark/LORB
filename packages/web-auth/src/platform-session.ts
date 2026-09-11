/**
 * Sign-in behind an authenticating gateway.
 *
 * Some hosting platforms put an OpenID Connect proxy in front of every application: an
 * unauthenticated browser is sent to the identity provider before any request reaches the
 * application, and once it is back the proxy keeps a cookie session and attaches
 * `Authorization: Bearer <token>` to every request it forwards on a protected path. The
 * application never sees a login page, never exchanges a code and never holds a refresh token.
 *
 * What it does not get for free is the token itself. The browser holds the proxy's cookie, not the
 * bearer token, and the API paths this platform's front ends call are exactly the ones such a
 * gateway leaves unauthenticated so that callers with their own credentials — a sandboxed module
 * holding a descriptor, another service holding a service token — can reach them. So the API
 * serves one small route on a protected path that returns the token the gateway attached. This
 * client fetches it, and from then on the application behaves exactly as it does with a token it
 * obtained from a provider itself: in memory, presented on every API request, renewed by asking
 * again.
 *
 * The fetch carries the gateway's cookie because it is same-origin. A gateway session that has
 * lapsed answers with a redirect to the provider; that is followed by navigating the whole page,
 * never by the fetch, because the provider's sign-in page cannot be completed inside a fetch.
 */
import { session } from "./oidc.js";
import type { AuthClient } from "./client.js";

export interface PlatformSessionConfig {
  /** The protected route that returns the gateway's token. Same-origin, or the cookie is not sent. */
  sessionUrl: string;
  /** Where the gateway ends its session. A plain navigation; the gateway clears its cookies. */
  signOutUrl?: string;
}

interface SessionResponse {
  access_token: string;
  expires_at?: string | null;
}

export const DEFAULT_PLATFORM_SIGN_OUT_PATH = "/oauth2/sign_out";

export class PlatformSessionClient implements AuthClient {
  constructor(private readonly config: PlatformSessionConfig) {}

  /**
   * Collects the token. Reports false, rather than throwing, when the gateway session is missing:
   * that is the ordinary "not signed in" state an application shows its sign-in screen for, and
   * `signIn` is how it is left.
   */
  async completeSignIn(): Promise<boolean> {
    let response: Response;
    try {
      // A lapsed gateway session answers with a redirect to the provider. Following it inside a
      // fetch cannot succeed, so it is not followed: an opaque redirect reads as "not signed in".
      response = await fetch(this.config.sessionUrl, { credentials: "same-origin", redirect: "manual", headers: { accept: "application/json" } });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    let body: SessionResponse;
    try {
      body = (await response.json()) as SessionResponse;
    } catch {
      return false;
    }
    if (typeof body.access_token !== "string" || body.access_token.length === 0) return false;
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Number.NaN;
    session.set({
      accessToken: body.access_token,
      // Renew a little early rather than discovering expiry mid-request. A token that carries no
      // expiry is asked for again after a few minutes, which is what a gateway typically issues.
      expiresAt: (Number.isNaN(expiresAt) ? Date.now() + 5 * 60 * 1000 : expiresAt) - 30 * 1000,
    });
    return true;
  }

  /**
   * Obtains a session. Usually that is the fetch above succeeding, because the gateway only serves
   * this document to a signed-in browser. When it fails the gateway session has lapsed, and a full
   * navigation is what sends the browser back through the provider and back here.
   */
  async signIn(returnTo: string = location.pathname + location.search): Promise<void> {
    if (await this.completeSignIn()) return;
    location.assign(returnTo || location.href);
  }

  async renew(): Promise<boolean> {
    return this.completeSignIn();
  }

  signOut(_returnTo?: string): void {
    session.clear();
    location.assign(this.config.signOutUrl ?? DEFAULT_PLATFORM_SIGN_OUT_PATH);
  }
}
