/**
 * The learner catalogue is not scoped to one repository.
 *
 * The bug these cover: the portal read `repositories` and listed only `items[0]`'s objects, while
 * registration files new content into the *default* repository and the administration surfaces list
 * every object unfiltered. A quiz registered through the agent connector was published, launchable
 * and visible to staff, and invisible to every learner — with nothing failing anywhere to say so.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchCatalogue} from '../../src/catalogue.js';
import type {Config} from '../../src/config.js';

const packageRoot=fileURLToPath(new URL('../..',import.meta.url));
const source=(file:string)=>readFileSync(resolve(packageRoot,file),'utf8');

const config={runtimeApiBase:'https://runtime.test/api/v1/runtime'} as Config;

const object=(id:string,repository_id:string,title:string)=>({
 object_id:id,repository_id,title,status:'PUBLISHED',
 active_package_version_id:`pkg-${id}`,active_object_version_id:`ver-${id}`,kind:'quiz-json-v1',
});

/** The two repositories the divergence produces: the older one the portal used to show, and the default one a quiz lands in. */
const OLDER='11111111-1111-4111-8111-111111111111';
const DEFAULT_REPO='b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d';

/**
 * A faithful stand-in for the Runtime API's catalogue routes: `repositories` lists both, oldest
 * first, and `learning-objects` honours a `repository_id` filter exactly as the real route does.
 * Without the filter being real, a client that scopes wrongly still looks correct here.
 */
function stubApi(items:ReturnType<typeof object>[]){
 const calls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  const target=new URL(String(url));
  calls.push(String(url));
  const body=target.pathname.endsWith('/repositories')
   ? {items:[{repository_id:OLDER},{repository_id:DEFAULT_REPO}]}
   : {items:items.filter((row)=>{
      const wanted=target.searchParams.get('repository_id');
      return !wanted||row.repository_id===wanted;
     })};
  return {ok:true,status:200,json:async()=>body} as unknown as Response;
 }));
 return calls;
}

/** The token store reads session storage, which the node test environment does not provide. */
function stubSessionStorage(){
 const values=new Map<string,string>();
 vi.stubGlobal('sessionStorage',{
  getItem:(key:string)=>values.get(key)??null,
  setItem:(key:string,value:string)=>{values.set(key,value)},
  removeItem:(key:string)=>{values.delete(key)},
 });
}

describe('learner catalogue scope',()=>{
 beforeEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();stubSessionStorage()});

 // The regression itself: a quiz in the default repository, alongside content in an older one.
 it('returns objects from every repository, not only the first',async()=>{
  stubApi([object('a',OLDER,'Ratios and proportion'),object('b',DEFAULT_REPO,'Photosynthesis quiz')]);
  const objects=await fetchCatalogue(config);
  expect(objects.map((row)=>row.title)).toEqual(['Ratios and proportion','Photosynthesis quiz']);
  expect(objects.map((row)=>row.repository_id)).toContain(DEFAULT_REPO);
 });

 // A repository_id in the query is what hid the quiz. Its absence is the fix, so it is asserted.
 it('asks for the whole catalogue, with no repository filter',async()=>{
  const calls=stubApi([object('b',DEFAULT_REPO,'Photosynthesis quiz')]);
  await fetchCatalogue(config);
  expect(calls).toEqual(['https://runtime.test/api/v1/runtime/learning-objects']);
  expect(calls[0]).not.toContain('repository_id');
 });

 // Choosing a repository client-side was never a control: the API decides what a learner may see.
 it('does not read the repository list at all',async()=>{
  const calls=stubApi([]);
  await fetchCatalogue(config);
  expect(calls.some((url)=>url.includes('repositories'))).toBe(false);
  expect(source('src/App.tsx')).not.toContain("apiRequest<{items:{repository_id:string}[]}>");
 });

 it('reports a leaked identity field through the same guard as every other learner-facing read',async()=>{
  stubApi([{...object('a',DEFAULT_REPO,'Quiz'),email:'leaked@example.test'} as never]);
  const leak=vi.fn();
  const objects=await fetchCatalogue(config,leak);
  expect(leak).toHaveBeenCalled();
  expect(JSON.stringify(objects)).not.toContain('leaked@example.test');
 });
});
