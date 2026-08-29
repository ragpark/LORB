const blocked=/(email|(^|_)name$|dob|date_of_birth|address)/i;
// A repository's display_name is a course label, not a person — but a roster row's display_name is
// exactly the identity this guard exists to withhold. The same field name means both, so the
// allowance is scoped to the repository shape (a sibling repository_id or slug); name-shaped fields
// on anything else are still withheld.
const approvedFor=(key:string,parent:Record<string,unknown>)=>key.toLowerCase()==='display_name'&&(typeof parent.slug==='string'||typeof parent.repository_id==='string');
export function sanitise<T>(value:T,onLeak=()=>{}):T{if(Array.isArray(value))return value.map(v=>sanitise(v,onLeak)) as T;if(value&&typeof value==='object'){const output:Record<string,unknown>={};for(const [key,item] of Object.entries(value)){if(!approvedFor(key,value as Record<string,unknown>)&&blocked.test(key)){onLeak();continue}output[key]=sanitise(item,onLeak)}return output as T}return value}
// The teacher/administrator session is held under its own key. A learner session must never be
// usable against the roster admin routes, and signing out of one must not silently keep the other.
export const adminTokenStore={get:()=>sessionStorage.getItem('lorb_mock_admin_token'),set:(token:string)=>sessionStorage.setItem('lorb_mock_admin_token',token),clear:()=>sessionStorage.removeItem('lorb_mock_admin_token')};
export const tokenStore={get:()=>sessionStorage.getItem('lorb_mock_token'),set:(token:string)=>sessionStorage.setItem('lorb_mock_token',token),clear:()=>sessionStorage.removeItem('lorb_mock_token')};
export function installTabCloseClear(){const clear=()=>{tokenStore.clear();adminTokenStore.clear()};window.addEventListener('beforeunload',clear);return()=>window.removeEventListener('beforeunload',clear)}
