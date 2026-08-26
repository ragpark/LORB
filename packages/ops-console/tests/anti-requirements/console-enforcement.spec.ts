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
 it('9 redirects expired sessions to stub sign-in',()=>expect(api).toContain("['AUTHENTICATION_EXPIRED','SESSION_EXPIRED']"));
 it('10 does not use unsafe HTML rendering',()=>expect(app).not.toContain(['dangerously','SetInnerHTML'].join('')));
 it('11 has no wildcard messaging or CORS patterns',()=>{expect(app).not.toMatch(/window\.open\(['"]\*/);expect(app).not.toContain("postMessage('*'");expect(app).not.toContain('Access-Control-Allow-Origin: *')});
 it('12 stores tokens only for the session',()=>{expect(api).toContain('sessionStorage');expect(api).not.toContain(['local','Storage'].join(''))});
 it('13 redacts authorisation in diagnostics',()=>expect(redactHeaders({Authorization:'Bearer secret'}).Authorization).toBe('Bearer …redacted…'));
 it('14 exposes skip-to-content as the first tabbable element',()=>expect(app.indexOf('className="skip"')).toBeLessThan(app.indexOf('<header>')));
 it('15 delegates focus trapping, restoration and Escape to Radix Dialog',()=>{expect(app).toContain('<Dialog.Content');expect(app).toContain('<Dialog.Close>')});
 it('joins resource paths without dropping the runtime path segment',()=>expect(apiUrl('https://runtime.example/api/v1/runtime','repositories').href).toBe('https://runtime.example/api/v1/runtime/repositories'));
 it('permits approved display and pseudonym projections but blocks identifying fields',()=>{expect(containsSensitiveField({display_name:'Synthetic repository',pseudonymous_subject_id:'psn_123'})).toBe(false);expect(containsSensitiveField({name:'Person',subject:'raw'})).toBe(true)});
 it('loads live projections rather than bundled seed records',()=>{expect(app).toContain("useProjection('repositories','repositories')");expect(app).not.toContain('repo_01HZX6T8N9')});
});

/**
 * The learner-facing catalogue route now serves published objects only, so an operations console
 * reading it would go blind exactly when somebody asks why an activity vanished.
 */
describe('operational projection breadth',()=>{
 it('reads learning objects from the administration route, not the learner-facing one',()=>{
  expect(app).toContain("useProjection('objects','learning-objects',adminBase)");
 });
 it('derives the administration prefix from the runtime one rather than configuring it twice',()=>{
  expect(app).toContain("const adminBase=runtimeBase.replace(");
  expect(app).not.toContain('VITE_ADMIN_API_BASE');
 });
});
