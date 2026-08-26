/**
 * How a teacher signs in to the administration area.
 *
 * The learner path has gone through the institution's provider since the portal stopped inventing
 * identities; the teacher path had not, and posted a chosen subject to the development login
 * endpoint whatever the environment was. In a deployed portal that endpoint is not built into the
 * image at all, so the teacher area could not obtain a token by any route — the classes screen would
 * open and every request in it would come back 401.
 *
 * So both paths now decide the same way, on the same signal: a configured provider is the only way
 * in wherever one exists, and the development login covers the one environment that has no provider.
 *
 * Two things the provider path has to carry that the learner path does not:
 *
 *   1. The callback lands on the portal's single redirect URI, and the token it produces belongs to
 *      one session slot or the other. The intent below is what a returning browser reads to tell
 *      which sign-in it started; without it a teacher's token would be adopted as a learner's.
 *   2. The token has to be renewable in place. An administration session that expires mid-form is
 *      the ordinary case, not the exception — reading an assistant's issuer and subject off another
 *      screen takes longer than the token lives — and a redirect at that moment loses whatever has
 *      been typed. `renew()` exchanges the refresh token without leaving the page, and the redirect
 *      stays as the fallback for when the provider issued none or refused it.
 *
 * What this cannot do is grant the teacher role: that claim comes from the provider, and a signed-in
 * account without it is refused by the API as ADMIN_AUDIT_DENIED rather than quietly admitted here.
 */
import {allowsDevelopmentSignIn,OidcClient,session as providerSession} from '@lorb/web-auth';
import {ApiProblem} from './api.js';
import type {Config} from './config.js';
import {adminTokenStore} from './security.js';

/**
 * Marks a provider round trip as the administration area's.
 *
 * Session storage rather than a state parameter: `state` is the client's defence against a callback
 * it did not start, and OidcClient owns it. Carrying an application's own meaning in there means
 * parsing it back out on the way in, which is one more way for a callback to say something about
 * itself. This says nothing about the callback — it records what this tab asked for.
 */
const INTENT_KEY='lorb_admin_signin_intent';
/** Set while the administration token came from the provider, so renewal is only tried on one. */
const PROVIDER_KEY='lorb_admin_provider_session';

export const adminSignInIntent={
 mark:()=>sessionStorage.setItem(INTENT_KEY,'1'),
 /** Reads the intent and clears it: a callback completes one sign-in, never the next one too. */
 take:()=>{const held=sessionStorage.getItem(INTENT_KEY)==='1';sessionStorage.removeItem(INTENT_KEY);return held},
 clear:()=>{sessionStorage.removeItem(INTENT_KEY);sessionStorage.removeItem(PROVIDER_KEY)},
};

/** The provider client for the administration area, where a provider is configured. */
export function adminOidcClient(config:Config):OidcClient|undefined{
 return config.oidc?new OidcClient(config.oidc):undefined;
}

/** Adopts a completed provider sign-in into the administration session, which is held separately. */
export function adoptProviderAdminSession(accessToken:string):void{
 adminTokenStore.set(accessToken);
 sessionStorage.setItem(PROVIDER_KEY,'1');
}

/**
 * Starts a teacher sign-in.
 *
 * With a provider this navigates away and nothing after the call runs; the sign-in finishes in
 * `completeAdminSignIn` when the browser comes back. Without one it returns having filled the
 * administration session, and the caller can open the workspace immediately.
 */
export async function adminSignIn(config:Config,subject='teacher-a'):Promise<void>{
 const client=adminOidcClient(config);
 if(client){
  adminSignInIntent.mark();
  await client.signIn(location.pathname+location.search);
  return;
 }
 // Unreachable in a deployed portal: configuration refuses to build one without a provider. It is
 // still checked here, because "unreachable" is a property of today's configuration code.
 if(!allowsDevelopmentSignIn(config.environment))throw new ApiProblem('ADMIN_SIGN_IN_UNAVAILABLE',crypto.randomUUID());
 const response=await fetch(config.developmentLoginUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subject,role:'admin'})});
 if(!response.ok)throw new ApiProblem('AUTHENTICATION_EXPIRED',crypto.randomUUID());
 adminTokenStore.set((await response.json() as {access_token:string}).access_token);
 sessionStorage.removeItem(PROVIDER_KEY);
}

/**
 * Completes a provider callback that this tab started for the administration area.
 *
 * Returns false for a callback the learner path started, or for no callback at all, so the portal
 * can ask both paths in turn without either having to know how the other decides.
 */
export function completeAdminSignIn(accessToken:string):boolean{
 if(!adminSignInIntent.take())return false;
 adoptProviderAdminSession(accessToken);
 return true;
}

/**
 * Re-authenticates a teacher whose administration session has expired.
 *
 * Renewal first, and only on a session the provider issued: it keeps the page, so the action that
 * hit the expiry can be replayed and nothing typed is lost. Everything else falls back to a fresh
 * sign-in, which with a provider is a redirect — usually silent, because the provider's own session
 * cookie is still valid, but it does cost the contents of an unsubmitted form.
 */
export async function adminSignInAgain(config:Config):Promise<void>{
 const client=adminOidcClient(config);
 if(client&&sessionStorage.getItem(PROVIDER_KEY)==='1'&&await client.renew()){
  const token=providerSession.token;
  if(token){adoptProviderAdminSession(token);return}
 }
 await adminSignIn(config);
}
