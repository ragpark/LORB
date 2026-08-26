// How a teacher gets into the administration area.
//
// The property under test is the one a deployed portal depends on: the teacher path decides where to
// sign in exactly as the learner path does, on the presence of a provider. A teacher path that
// reaches for the development login endpoint in a deployed environment cannot get a token at all —
// that endpoint is not built into the image — so the workspace opens and every request in it is 401.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {session as providerSession} from '@lorb/web-auth';
import {adminSignIn,adminSignInAgain,adminSignInIntent,adoptProviderAdminSession,completeAdminSignIn} from '../../src/admin-auth.js';
import {ApiProblem} from '../../src/api.js';
import type {Config} from '../../src/config.js';
import {adminTokenStore} from '../../src/security.js';

const base:Omit<Config,'oidc'|'environment'>={
 runtimeApiBase:'https://api.example/api/v1/runtime',
 adminApiBase:'https://api.example/api/v1/admin',
 runtimeIssuer:'https://api.example',
 jwksUrl:'https://api.example/api/v1/runtime/jwks',
 playerShellOrigin:'https://player.example',
 developmentLoginUrl:'https://identity.example/dev-login',
 identityIssuer:'https://provider.example',
 allowedShellOrigins:new Set(['https://player.example']),
};
const withProvider:Config={...base,environment:'PRODUCTION',oidc:{issuer:'https://provider.example',clientId:'portal',redirectUri:'https://portal.example',audience:'lorb-runtime'}};
const development:Config={...base,environment:'DEVELOPMENT'};
const deployedWithoutProvider:Config={...base,environment:'STAGING'};

const store=new Map<string,string>();
const assign=vi.fn();

beforeEach(()=>{
 store.clear();
 assign.mockReset();
 providerSession.clear();
 Object.assign(globalThis,{
  sessionStorage:{
   getItem:(key:string)=>store.get(key)??null,
   setItem:(key:string,value:string)=>void store.set(key,value),
   removeItem:(key:string)=>void store.delete(key),
  },
  location:{pathname:'/',search:'',origin:'https://portal.example',assign},
 });
});
afterEach(()=>{vi.unstubAllGlobals()});

describe('teacher sign-in',()=>{
 it('goes to the provider wherever one is configured, never to the development login',async()=>{
  const fetchStub=vi.fn();
  vi.stubGlobal('fetch',fetchStub);
  await adminSignIn(withProvider);
  expect(fetchStub).not.toHaveBeenCalled();
  const url=new URL(assign.mock.calls[0][0] as string);
  expect(url.origin+url.pathname).toBe('https://provider.example/authorize');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('audience')).toBe('lorb-runtime');
 });

 it('uses the development login only where there is no provider',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({access_token:'development-token'})})));
  await adminSignIn(development);
  expect(assign).not.toHaveBeenCalled();
  expect(adminTokenStore.get()).toBe('development-token');
 });

 // Unreachable through readConfig, which refuses to build a deployed portal without a provider. The
 // guard is what keeps it unreachable if that ever stops being true.
 it('refuses to sign a teacher in at all when a deployed environment has no provider',async()=>{
  const fetchStub=vi.fn();
  vi.stubGlobal('fetch',fetchStub);
  await expect(adminSignIn(deployedWithoutProvider)).rejects.toMatchObject({code:'ADMIN_SIGN_IN_UNAVAILABLE'});
  expect(fetchStub).not.toHaveBeenCalled();
  expect(adminTokenStore.get()).toBeNull();
 });
});

describe('the provider callback',()=>{
 it('claims the token only for the sign-in this tab started',()=>{
  // A learner's callback: no administration intent, so the token is left for the learner path.
  expect(completeAdminSignIn('learner-token')).toBe(false);
  expect(adminTokenStore.get()).toBeNull();

  adminSignInIntent.mark();
  expect(completeAdminSignIn('teacher-token')).toBe(true);
  expect(adminTokenStore.get()).toBe('teacher-token');
 });

 it('completes one sign-in, not the next one too',()=>{
  adminSignInIntent.mark();
  expect(completeAdminSignIn('teacher-token')).toBe(true);
  adminTokenStore.clear();
  expect(completeAdminSignIn('a-later-token')).toBe(false);
  expect(adminTokenStore.get()).toBeNull();
 });
});

describe('re-authentication after the session expires',()=>{
 // The whole point of renewing rather than redirecting: the page survives, so the action that hit
 // the expiry can be replayed and what the teacher typed into the link form is still there.
 it('renews in place, without leaving the page, when the provider issued a refresh token',async()=>{
  adoptProviderAdminSession('expired-token');
  providerSession.set({accessToken:'expired-token',expiresAt:Date.now()-1000,refreshToken:'refresh-1'});
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({access_token:'renewed-token',expires_in:3600})})));

  await adminSignInAgain(withProvider);

  expect(assign).not.toHaveBeenCalled();
  expect(adminTokenStore.get()).toBe('renewed-token');
 });

 it('falls back to a fresh sign-in when there is nothing to renew with',async()=>{
  adoptProviderAdminSession('expired-token');
  vi.stubGlobal('fetch',vi.fn());
  await adminSignInAgain(withProvider);
  expect(assign).toHaveBeenCalledTimes(1);
 });

 it('reports a rejected development sign-in as an expired session, not as success',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,json:async()=>({})})));
  await expect(adminSignInAgain(development)).rejects.toBeInstanceOf(ApiProblem);
  expect(adminTokenStore.get()).toBeNull();
 });
});
