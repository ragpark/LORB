import {describe,expect,it,beforeEach,vi} from 'vitest';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {readConfig} from '../../src/config.js';import {errorCopy} from '../../src/errors.js';import {acceptPlayerMessage} from '../../src/messages.js';import {sanitise} from '../../src/security.js';import {allowsDevelopmentSignIn,environmentNotice} from '@lorb/web-auth';
const packageRoot=fileURLToPath(new URL('../..',import.meta.url));const source=(file:string)=>readFileSync(resolve(packageRoot,file),'utf8');
const envelope={protocol:'lorb-player',version:'1.0',type:'experience.complete',message_id:'1b4e28ba-2fa1-11d2-883f-0016d3cca427',correlation_id:'1b4e28ba-2fa1-11d2-883f-0016d3cca428',reply_to:null,sent_at:'2026-08-14T00:00:00.000Z',payload:{}};
describe('learner portal enforcement',()=>{beforeEach(()=>{vi.restoreAllMocks()});
 it('puts the skip link before the chrome',()=>{const app=source('src/App.tsx');expect(app.indexOf('<a className="skip"')).toBeLessThan(app.indexOf('<Header'))});
 // A non-production portal says so; production shows nothing, so a banner that is present is
 // always telling the reader something.
 it('shows an environment notice outside production and none inside it',()=>{const app=source('src/App.tsx');expect(app).toContain('environmentNoticeFor(config.environment)');expect(environmentNotice('PRODUCTION')).toBeUndefined();expect(environmentNotice('STAGING')).toBeTruthy()});
 it('names the environment in the header only when it is not production',()=>{const app=source('src/App.tsx');expect(app).toContain("environment!=='PRODUCTION'&&<span className=\"environment\">{environment}</span>")});
 // A deployed portal must not be able to obtain a learner session by naming a subject.
 it('confines the local sign-in to a development environment',()=>{const app=source('src/App.tsx');expect(app).toContain('allowsDevelopmentSignIn(config.environment)');expect(allowsDevelopmentSignIn('PRODUCTION')).toBe(false)});
 it('refuses to build a portal outside development without an identity provider',()=>{expect(()=>readConfig({VITE_ENVIRONMENT_LABEL:'STAGING'} as never)).toThrow(/VITE_OIDC_ISSUER/)});
 it('rejects unsupported environment labels and wildcard origins',()=>{expect(()=>readConfig({VITE_ENVIRONMENT_LABEL:'PRODUCTION'} as ImportMetaEnv)).toThrow();expect(()=>readConfig({VITE_ALLOWED_SHELL_ORIGINS:'*'} as ImportMetaEnv)).toThrow()});
 it('derives the Runtime descriptor issuer when the optional override is blank',()=>{const config=readConfig({VITE_RUNTIME_API_BASE:'https://runtime.example/api/v1/runtime',VITE_RUNTIME_ISSUER:'',VITE_ALLOWED_SHELL_ORIGINS:'https://shell.example'} as ImportMetaEnv);expect(config.runtimeIssuer).toBe('https://runtime.example')});
 it('removes suspected identity fields recursively',()=>{const leak=vi.fn();expect(sanitise({title:'Safe',email:'hidden',nested:{date_of_birth:'hidden'}},leak)).toEqual({title:'Safe',nested:{}});expect(leak).toHaveBeenCalledTimes(2)});
 it('withholds display_name by default and honours only a caller-supplied allowance',()=>{const leak=vi.fn();
  // The default guard withholds every name-shaped field, repository rows included.
  expect(sanitise({repository_id:'r1',display_name:'Default repository'},leak)).toEqual({repository_id:'r1'});
  // Only a caller that names the key for its one call gets it through — the repositories fetch does.
  expect(sanitise({repository_id:'r1',display_name:'Default repository',name:'hidden'},leak,new Set(['display_name']))).toEqual({repository_id:'r1',display_name:'Default repository'});
  expect(source('src/catalogue.ts')).toContain("new Set(['display_name'])");
 });
 // Every kind but lti-tool and external-embed gets the fully restrictive sandbox. Those two are the
 // deliberate, narrowly-scoped exceptions — real third-party content needs cookies and same-origin
 // fetches to function at all, which allow-same-origin grants only inside that one ternary branch —
 // never as the default, and never allow-top-navigation.
 it('uses the restrictive iframe sandbox by default, widened only for an lti-tool or external-embed launch',()=>{const app=source('src/App.tsx');
  expect(app).toContain('sandbox={(selected?.kind===\'lti-tool\'||selected?.kind===\'external-embed\')?\'allow-scripts allow-forms allow-same-origin\':\'allow-scripts\'}');
  expect(app).not.toContain('allow-top-navigation');
 });
 it('rejects an origin outside the allow-list',()=>{vi.spyOn(console,'warn').mockImplementation(()=>{});expect(acceptPlayerMessage({origin:'https://wrong.test',source:{},data:envelope} as unknown as MessageEvent,new Set(['https://shell.test']),{} as Window)).toBeNull()});
 it('rejects a mismatched frame source',()=>{vi.spyOn(console,'warn').mockImplementation(()=>{});expect(acceptPlayerMessage({origin:'https://shell.test',source:{},data:envelope} as unknown as MessageEvent,new Set(['https://shell.test']),{} as Window)).toBeNull()});
 it('rejects missing and additional envelope fields',()=>{vi.spyOn(console,'warn').mockImplementation(()=>{});const frame={} as Window;expect(acceptPlayerMessage({origin:'https://shell.test',source:frame,data:{...envelope,protocol:undefined}} as unknown as MessageEvent,new Set(['https://shell.test']),frame)).toBeNull();expect(acceptPlayerMessage({origin:'https://shell.test',source:frame,data:{...envelope,extra:true}} as unknown as MessageEvent,new Set(['https://shell.test']),frame)).toBeNull()});
 it('accepts the exact envelope',()=>{const frame={} as Window;expect(acceptPlayerMessage({origin:'https://shell.test',source:frame,data:envelope} as unknown as MessageEvent,new Set(['https://shell.test']),frame)?.type).toBe('experience.complete')});
 // The shell runs under sandbox="allow-scripts" without allow-same-origin, so its messages arrive
 // with the opaque origin "null". They are accepted only from the launch iframe's own window.
 it('accepts the opaque origin from the launch frame itself',()=>{const frame={} as Window;expect(acceptPlayerMessage({origin:'null',source:frame,data:envelope} as unknown as MessageEvent,new Set(['https://shell.test']),frame)?.type).toBe('experience.complete')});
 it('rejects the opaque origin from any other window',()=>{vi.spyOn(console,'warn').mockImplementation(()=>{});expect(acceptPlayerMessage({origin:'null',source:{},data:envelope} as unknown as MessageEvent,new Set(['https://shell.test']),{} as Window)).toBeNull()});
 it('rejects every message while no launch frame is mounted',()=>{vi.spyOn(console,'warn').mockImplementation(()=>{});expect(acceptPlayerMessage({origin:'null',source:null,data:envelope} as unknown as MessageEvent,new Set(['https://shell.test']),null)).toBeNull()});
 it('attaches correlation and idempotency headers',()=>{const api=source('src/api.ts');expect(api).toContain("headers.set('X-Correlation-ID',correlationId)");expect(api).toContain("headers.set('Idempotency-Key',crypto.randomUUID())")});
 it('uses session storage only for tokens',()=>{const security=source('src/security.ts');expect(security).toContain('sessionStorage');expect(security).not.toContain('local'+'Storage')});
 it('does not inject markup',()=>expect(source('src/App.tsx')).not.toContain('dangerouslySet'+'InnerHTML'));
 it('keeps prohibited technical language out of error copy',()=>expect(JSON.stringify(errorCopy)).not.toMatch(/JWT|403|401|500|resolver|LRS|provider adapter|stack|null|undefined/i));
 it('clears tokens on sign-out and tab close',()=>{const app=source('src/App.tsx'),security=source('src/security.ts');expect(app).toContain('tokenStore.clear()');expect(security).toContain("addEventListener('beforeunload',clear)")});
 it('verifies a descriptor before mounting launch state',()=>{const app=source('src/App.tsx');expect(app.indexOf('await verifyLaunchDescriptor')).toBeLessThan(app.indexOf('setLaunch(data)'))});
 it('has no prohibited palette',()=>expect(source('src/styles.css')+source('src/App.tsx')).not.toMatch(/#0d47a1|#1565c0|#1976d2|#2196f3|#003057|blue-/i));
 it('keeps the required banner copy out of the product-name contradiction',()=>expect(source('src/App.tsx')).not.toContain('Active'+'Hub'));
 it('does not include the prohibited organisation name in runtime source',()=>expect(source('src/App.tsx')+source('src/styles.css')).not.toContain('Pear'+'son'));
});
