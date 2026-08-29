const blocked=/(email|(^|_)name$|dob|date_of_birth|address)/i;
// By default everything name-shaped is withheld. A caller that knows one specific response carries
// a name-shaped field that is not a person — the repositories listing, whose display_name is a
// course label — approves that key for that call and no other; the guard itself never guesses from
// the response's shape, because a shape is exactly what a server-side mistake gets wrong.
export function sanitise<T>(value:T,onLeak=()=>{},approved:ReadonlySet<string>=new Set()):T{if(Array.isArray(value))return value.map(v=>sanitise(v,onLeak,approved)) as T;if(value&&typeof value==='object'){const output:Record<string,unknown>={};for(const [key,item] of Object.entries(value)){if(!approved.has(key.toLowerCase())&&blocked.test(key)){onLeak();continue}output[key]=sanitise(item,onLeak,approved)}return output as T}return value}
// The teacher/administrator session is held under its own key. A learner session must never be
// usable against the roster admin routes, and signing out of one must not silently keep the other.
export const adminTokenStore={get:()=>sessionStorage.getItem('lorb_mock_admin_token'),set:(token:string)=>sessionStorage.setItem('lorb_mock_admin_token',token),clear:()=>sessionStorage.removeItem('lorb_mock_admin_token')};
export const tokenStore={get:()=>sessionStorage.getItem('lorb_mock_token'),set:(token:string)=>sessionStorage.setItem('lorb_mock_token',token),clear:()=>sessionStorage.removeItem('lorb_mock_token')};
export function installTabCloseClear(){const clear=()=>{tokenStore.clear();adminTokenStore.clear()};window.addEventListener('beforeunload',clear);return()=>window.removeEventListener('beforeunload',clear)}
