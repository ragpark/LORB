// @vitest-environment node
//
// This suite reads its subjects off disk as text rather than rendering them, so it must run in the
// node environment: under the package's default jsdom environment `import.meta.url` is an http: URL
// and readFileSync(new URL(...)) throws ERR_INVALID_URL_SCHEME. The package default stays jsdom for
// component tests.
import {describe,expect,it} from 'vitest';
import {containsSensitiveField,redactHeaders,sanitise} from '../../src/security.js';
import {apiUrl} from '../../src/api.js';
import {readFileSync} from 'node:fs';
import {allowsDevelopmentSignIn,environmentNotice} from '@lorb/web-auth';
const app=readFileSync(new URL('../../src/App.tsx',import.meta.url),'utf8');
const api=readFileSync(new URL('../../src/api.ts',import.meta.url),'utf8');
const oidcSource=readFileSync(new URL('../../../web-auth/src/oidc.ts',import.meta.url),'utf8');
describe('Operations Console enforcement controls',()=>{
 // A non-production console says so before anything a keyboard user can reach, so an operator knows
 // whether the records in front of them are real before they act on them. Production shows nothing:
 // a banner that is always on stops being read.
 it('1 places the environment notice before the first interactive skip link',()=>expect(app.indexOf('className="environment-notice"')).toBeLessThan(app.indexOf('className="skip"')));
 it('2 allows only the known environment labels and visibly fails otherwise',()=>{expect(app).toContain('ENVIRONMENT_LABELS.includes');expect(app).toContain('Environment configuration error')});
 // A deployed build with no identity provider must refuse to open, not render a console whose
 // every request fails with a 401 the operator cannot act on.
 it('2e refuses a non-development build without an identity provider',()=>{expect(app).toContain('!oidc&&!allowsDevelopmentSignIn(env as never)');expect(app).toContain('requires an identity provider')});
 it('2a shows no notice in production and names the environment otherwise',()=>{expect(environmentNotice('PRODUCTION')).toBeUndefined();expect(environmentNotice('STAGING')).toMatch(/Staging/);expect(environmentNotice('DEVELOPMENT')).toMatch(/Development/)});
 // The development login must be reachable only from a development build. A deployed console that
 // could POST a subject string to a login endpoint would have no authentication worth the name.
 it('2b confines the development sign-in to a development environment',()=>{expect(app).toContain('allowsDevelopmentSignIn(env');expect(allowsDevelopmentSignIn('PRODUCTION')).toBe(false);expect(allowsDevelopmentSignIn('STAGING')).toBe(false);expect(allowsDevelopmentSignIn('DEVELOPMENT')).toBe(true)});
 it('2c signs in with authorization code and PKCE, never the implicit flow',()=>{expect(oidcSource).toContain("response_type\", \"code");expect(oidcSource).toContain('code_challenge_method');expect(oidcSource).not.toContain('response_type=token')});
 it('2d never renders a fabricated operator identity',()=>{expect(app).not.toContain('SYNTHETIC OPERATOR');expect(app).toContain("<small>OPERATOR</small>")});
 it('3 detects identifying fields rather than rendering their values',()=>expect(containsSensitiveField({email:'synthetic@example.test'})).toBe(true));
 it('4 removes raw subject and tenant secret fields',()=>expect(sanitise({subject:'raw',tenant_secret:'secret',safe:'ok'})).toEqual({safe:'ok'}));
 it('5 attaches X-Correlation-ID to every API request',()=>expect(api).toContain("'X-Correlation-ID':correlationId"));
 it('6 attaches an Idempotency-Key to state-changing requests',()=>expect(api).toContain("method!=='GET'&&!headers['Idempotency-Key']"));
 it('7 fixes launch mode and en-GB locale',()=>{expect(app).toContain('disabled value="embedded-iframe"');expect(app).toContain('value="en-GB" readOnly')});
 it('8 preserves statement provenance in replay contracts',()=>{const evidence=readFileSync(new URL('../../../evidence-api/src/app.ts',import.meta.url),'utf8');expect(evidence).toContain('store.requeueStatement(request.params.outboxId, statementId)')});
 // An expired session restarts sign-in where the console is actually served — never at a route this
 // application does not serve — and bounces at most once, so an unauthorised operator sees the
 // error instead of a reload loop. The console is served either at the root of its own origin or
 // under a path prefix by the API process, and the origin is only the right place to return to in
 // the first of those, so the destination is derived from the served document rather than assumed.
 it('9 restarts sign-in on an expired session, at most once',()=>{expect(api).toContain("['AUTHENTICATION_EXPIRED','SESSION_EXPIRED']");expect(api).toContain('expireSession');expect(api).toContain("sessionStorage.getItem('lorb_auth_bounced')");expect(api).toContain('window.location.assign(appBaseUrl())');expect(api).not.toContain('window.location.assign(window.location.origin)');expect(api).not.toContain('VITE_DEVELOPMENT_IDENTITY_LOGIN_URL')});
 // The provider client's in-memory session must be copied into the token every request reads, or a
 // deployed console completes sign-in and then sends every request unauthenticated.
 it('9a adopts the provider session after a completed sign-in',()=>{expect(app).toContain('providerSession');expect(app).toMatch(/await callbackCompletion\)\{const token=providerSession\.token;if\(token\)session\.set\(token\)/)});
 // StrictMode mounts the application twice and the PKCE handshake can be used once, so the two
 // mounts must share one completion rather than the second redirecting away from the first's
 // exchange. Queries wait for a session so pre-sign-in 401s cannot masquerade as expiry.
 it('9b completes the provider callback once per document load and gates queries on a session',()=>{expect(app).toContain('callbackCompletion??=oidc.completeSignIn()');expect(app).toMatch(/let callbackCompletion:Promise<boolean>\|undefined/);expect(app).toContain('retry:false,enabled');expect(api).toContain('hadToken&&')});
 it('10 does not use unsafe HTML rendering',()=>expect(app).not.toContain(['dangerously','SetInnerHTML'].join('')));
 it('11 has no wildcard messaging or CORS patterns',()=>{expect(app).not.toMatch(/window\.open\(['"]\*/);expect(app).not.toContain("postMessage('*'");expect(app).not.toContain('Access-Control-Allow-Origin: *')});
 it('12 stores tokens only for the session',()=>{expect(api).toContain('sessionStorage');expect(api).not.toContain(['local','Storage'].join(''))});
 it('13 redacts authorisation in diagnostics',()=>expect(redactHeaders({Authorization:'Bearer secret'}).Authorization).toBe('Bearer …redacted…'));
 it('14 exposes skip-to-content as the first tabbable element',()=>expect(app.indexOf('className="skip"')).toBeLessThan(app.indexOf('<header>')));
 it('15 delegates focus trapping, restoration and Escape to Radix Dialog',()=>{expect(app).toContain('<Dialog.Content');expect(app).toContain('<Dialog.Close>')});
 it('joins resource paths without dropping the runtime path segment',()=>expect(apiUrl('https://runtime.example/api/v1/runtime','repositories').href).toBe('https://runtime.example/api/v1/runtime/repositories'));
 it('permits approved display and pseudonym projections but blocks identifying fields',()=>{expect(containsSensitiveField({display_name:'Synthetic repository',pseudonymous_subject_id:'psn_123'})).toBe(false);expect(containsSensitiveField({name:'Person',subject:'raw'})).toBe(true)});
 it('loads live projections rather than bundled seed records',()=>{expect(app).toContain("useProjection('repositories','repositories',authed)");expect(app).not.toContain('repo_01HZX6T8N9')});
});
