// Roster administration controls on the consumer side.
//
// The load-bearing one: adding an administration surface that deliberately handles learner names
// must not weaken the leak guard on the learner-facing path. These check the exception stayed narrow.
import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sanitise} from '../../src/security.js';
import {LEARNER_REF,adminErrorMessage} from '../../src/admin.js';
import {readConfig} from '../../src/config.js';

const root=resolve(fileURLToPath(new URL('../../src',import.meta.url)));
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');

describe('roster administration',()=>{
 it('keeps the learner-facing client sanitising, name fields included',()=>{
  const leak=vi.fn();
  expect(sanitise({title:'Safe',name:'hidden',display_name:'hidden'},leak)).toEqual({title:'Safe'});
  expect(leak).toHaveBeenCalledTimes(2);
 });

 // apiRequest is what every learner-facing screen uses. If sanitise were ever dropped from it, the
 // guard would be gone everywhere rather than only on the roster surface.
 it('still routes learner-facing responses through sanitise',()=>{
  expect(read('api.ts')).toContain('sanitise(body,onLeak)');
 });

 it('confines the unsanitised path to the administration client',()=>{
  const admin=read('admin-api.ts');
  // The call, not the word: the file explains at length why it does not sanitise, and that prose
  // must not be what makes this test pass.
  expect(admin).not.toContain('sanitise(');
  // ...and it must say why, so the next reader does not treat it as an oversight to "fix".
  expect(admin).toContain('deliberately narrows a rail');
 });

 it('holds the administrator session under its own key',()=>{
  const security=read('security.ts');
  expect(security).toContain('lorb_mock_admin_token');
  expect(security).toContain('lorb_mock_token');
  expect(security).not.toContain('localStorage');
 });

 it('clears both sessions when the tab closes',()=>{
  expect(read('security.ts')).toContain('tokenStore.clear();adminTokenStore.clear()');
 });

 it('accepts only identifiers the synthetic identity service could issue',()=>{
  expect(LEARNER_REF.test('synthetic-9b-01')).toBe(true);
  for(const bad of ['has spaces','<script>','',"quote'd",'a'.repeat(129)])expect(LEARNER_REF.test(bad)).toBe(false);
 });

 it('sends administration calls to the admin prefix, not the learner runtime prefix',()=>{
  const config=readConfig({VITE_ENVIRONMENT_LABEL:'DEVELOPMENT'} as never);
  expect(config.adminApiBase).toMatch(/\/api\/v1\/admin$/);
  expect(config.adminApiBase).not.toBe(config.runtimeApiBase);
 });

 // An expired administration token is what a teacher hits when they spend a few minutes fetching an
 // assistant's issuer and subject before pressing "Link assistant". Reported as a bare code it reads
 // as though the assistant itself was rejected.
 it('says what an expired administration session means and how to recover',()=>{
  const copy=adminErrorMessage('AUTHENTICATION_EXPIRED');
  expect(copy).toMatch(/expired/i);
  expect(copy).toMatch(/sign in again/i);
  expect(copy).not.toContain('AUTHENTICATION_EXPIRED');
 });

 it('still names an unrecognised code rather than swallowing it',()=>{
  expect(adminErrorMessage('SOME_NEW_CODE')).toContain('SOME_NEW_CODE');
 });

 it('offers re-authentication, and drops the spent token, instead of dead-ending on the 401',()=>{
  const admin=read('admin.tsx');
  expect(admin).toContain('Sign in again');
  expect(admin).toContain('adminTokenStore.clear()');
  // The action that hit the expiry is replayed, so nothing typed into the link form is lost.
  expect(admin).toContain('pending.current=work');
 });

 it('renders learner names as text, never as markup',()=>{
  expect(read('admin.tsx')).not.toContain('dangerouslySetInnerHTML');
 });
});
