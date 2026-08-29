/**
 * What a learner sees on the catalogue screen.
 *
 * The portal used to read `repositories` first and list only `items[0]`'s objects — the *oldest*
 * repository, whatever its status. Nothing else in the platform picks that way: registration files
 * new content into the default repository (the canonical one where it exists, otherwise the oldest
 * ACTIVE one), and the administration surfaces list every object without a filter. So the two
 * agreed only in the seeded happy path, and diverged the moment a repository predated the canonical
 * default or the oldest one stopped being active. A quiz registered through the agent connector was
 * then present, published and launchable, visible in the ops and administration consoles, and
 * absent from the one screen a learner can reach.
 *
 * The catalogue therefore asks for the whole catalogue, and which objects a caller may see stays
 * the Runtime API's decision: a client-side filter over a list the API already chose to serve was
 * never enforcing anything. The course layer below presents repositories as navigation, but it is
 * grouping over that same full response — see fetchCourses.
 */
import {apiRequest} from './api.js';
import type {Config} from './config.js';

export interface CatalogueObject {
 object_id:string;repository_id:string;title?:string;status:string;
 active_package_version_id:string;active_object_version_id:string;
 description?:string;duration?:string;kind?:string;
}

/** Every published object the Runtime API serves this learner, across every repository. */
export async function fetchCatalogue(config:Config,onLeak=()=>{}):Promise<CatalogueObject[]>{
 const data=await apiRequest<{items:CatalogueObject[]}>(config,'learning-objects',{},onLeak);
 return data.items;
}

/**
 * A course, as the portal presents one: a repository worn as a navigation grouping.
 *
 * This does not reintroduce the filter the module comment above warns about. The catalogue is still
 * fetched whole and unfiltered; courses are grouped *client-side over that full response*, every
 * repository is listed, and an object whose repository the list does not name lands in a catch-all
 * course rather than nowhere. Nothing the API serves can be unreachable — the grouping adds a level
 * of navigation, never a hole.
 */
export interface Course{repository_id:string;name:string;objects:CatalogueObject[]}
export async function fetchCourses(config:Config,onLeak=()=>{}):Promise<Course[]>{
 const [repositories,objects]=await Promise.all([
  // The one endpoint-scoped allowance: a repository's display_name is a course label, not a person.
  apiRequest<{items:{repository_id:string;display_name?:string;slug?:string}[]}>(config,'repositories',{},onLeak,new Set(['display_name'])),
  fetchCatalogue(config,onLeak),
 ]);
 const grouped=new Map<string,CatalogueObject[]>();
 for(const object of objects){
  const key=object.repository_id.toLowerCase();
  grouped.set(key,[...(grouped.get(key)??[]),object]);
 }
 const courses:Course[]=repositories.items.map(repository=>({
  repository_id:repository.repository_id,
  name:repository.display_name||repository.slug||'Course',
  objects:grouped.get(repository.repository_id.toLowerCase())??[],
 }));
 const listed=new Set(repositories.items.map(repository=>repository.repository_id.toLowerCase()));
 const orphaned=objects.filter(object=>!listed.has(object.repository_id.toLowerCase()));
 if(orphaned.length>0)courses.push({repository_id:'',name:'More activities',objects:orphaned});
 return courses;
}
