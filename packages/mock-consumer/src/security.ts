const blocked=/(email|(^|_)name$|dob|date_of_birth|address)/i;
export function sanitise<T>(value:T,onLeak=()=>{}):T{if(Array.isArray(value))return value.map(v=>sanitise(v,onLeak)) as T;if(value&&typeof value==='object'){const output:Record<string,unknown>={};for(const [key,item] of Object.entries(value)){if(blocked.test(key)){onLeak();continue}output[key]=sanitise(item,onLeak)}return output as T}return value}
export const tokenStore={get:()=>sessionStorage.getItem('lorb_mock_token'),set:(token:string)=>sessionStorage.setItem('lorb_mock_token',token),clear:()=>sessionStorage.removeItem('lorb_mock_token')};
export function installTabCloseClear(){const clear=()=>tokenStore.clear();window.addEventListener('beforeunload',clear);return()=>window.removeEventListener('beforeunload',clear)}
