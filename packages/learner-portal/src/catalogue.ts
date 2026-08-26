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
 * A learner has no concept of a repository — it is a publishing boundary, not a shelf they browse —
 * so the catalogue asks for the whole catalogue and the scoping question stops being asked at all.
 * Which objects a caller may see is the Runtime API's to decide, and a client-side filter over a
 * list the API already chose to serve was never enforcing anything.
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
