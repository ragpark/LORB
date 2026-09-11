/**
 * What an application needs from a sign-in, whichever way the deployment provides one.
 *
 * Two shapes exist. `OidcClient` signs the browser in itself, with authorization code and PKCE
 * against the institution's provider. `PlatformSessionClient` does not sign anyone in: it runs
 * behind a gateway that already has, and collects the token that gateway attached to the request.
 * The three front ends are written against this interface so that the choice is configuration.
 */
export interface AuthClient {
  /** Obtains a session. May navigate away, in which case nothing after the call runs. */
  signIn(returnTo?: string): Promise<void>;
  /**
   * Finishes a sign-in the current document load completes, if it does, and reports whether a
   * session is now held. Safe to call unconditionally at start-up.
   */
  completeSignIn(): Promise<boolean>;
  /** Renews the session in place, without leaving the page. False when that is not possible. */
  renew(): Promise<boolean>;
  /** Ends the session, and the provider's or gateway's session with it where that is supported. */
  signOut(returnTo?: string): void;
}
