/**
 * Which sign-in a deployment has configured, read from the same `VITE_*` names whether they were
 * baked in at build time or written into the page by the process serving the application.
 *
 * A gateway session, where one is named, takes precedence: it means the deployment is behind an
 * authenticating proxy, and an application that started its own provider round-trip there would
 * be signing in twice against two different clients.
 */
import type { AuthClient } from "./client.js";
import { OidcClient, type OidcClientConfig } from "./oidc.js";
import { PlatformSessionClient, type PlatformSessionConfig } from "./platform-session.js";

export interface AuthEnvironment {
  readonly VITE_PLATFORM_SESSION_URL?: string;
  readonly VITE_PLATFORM_SIGN_OUT_URL?: string;
  readonly VITE_OIDC_ISSUER?: string;
  readonly VITE_OIDC_CLIENT_ID?: string;
  readonly VITE_OIDC_REDIRECT_URI?: string;
  readonly VITE_OIDC_AUDIENCE?: string;
  readonly VITE_OIDC_SCOPE?: string;
}

export type AuthClientConfig =
  | ({ kind: "platform-session" } & PlatformSessionConfig)
  | ({ kind: "oidc" } & OidcClientConfig);

const present = (value: string | undefined): string | undefined => (value && value.trim() !== "" ? value.trim() : undefined);

/**
 * The configured sign-in, or undefined where the deployment has none — the development case.
 *
 * The default redirect URI is taken lazily: it is usually the document's origin, which only exists
 * in a browser, and configuration is also read where there is no document at all.
 */
export function readAuthConfig(env: AuthEnvironment, defaultRedirectUri: string | (() => string)): AuthClientConfig | undefined {
  const sessionUrl = present(env.VITE_PLATFORM_SESSION_URL);
  if (sessionUrl) {
    const signOutUrl = present(env.VITE_PLATFORM_SIGN_OUT_URL);
    return { kind: "platform-session", sessionUrl, ...(signOutUrl ? { signOutUrl } : {}) };
  }
  const issuer = present(env.VITE_OIDC_ISSUER);
  const clientId = present(env.VITE_OIDC_CLIENT_ID);
  if (!issuer || !clientId) return undefined;
  return {
    kind: "oidc",
    issuer,
    clientId,
    redirectUri: present(env.VITE_OIDC_REDIRECT_URI) ?? (typeof defaultRedirectUri === "function" ? defaultRedirectUri() : defaultRedirectUri),
    audience: present(env.VITE_OIDC_AUDIENCE),
    scope: present(env.VITE_OIDC_SCOPE),
  };
}

export function createAuthClient(config: AuthClientConfig): AuthClient;
export function createAuthClient(config: AuthClientConfig | undefined): AuthClient | undefined;
export function createAuthClient(config: AuthClientConfig | undefined): AuthClient | undefined {
  if (!config) return undefined;
  if (config.kind === "platform-session") {
    const { kind: _kind, ...options } = config;
    return new PlatformSessionClient(options);
  }
  const { kind: _kind, ...options } = config;
  return new OidcClient(options);
}
