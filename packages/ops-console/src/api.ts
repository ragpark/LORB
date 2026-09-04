import { nanoid } from 'nanoid';
import { containsSensitiveField,redactHeaders,SuspectedLeakError } from './security.js';
import { appBaseUrl } from '@lorb/web-auth';
import { webEnv } from './runtime-env.js';
export type Diagnostic={direction:'outbound'|'inbound';method:string;url:string;correlationId:string;status?:number;duration?:number;headers?:Record<string,string>;errorCode?:string};
const log:Diagnostic[]=[]; export const diagnostics=()=>[...log];
export const session={get:()=>sessionStorage.getItem('lorb_stub_token'),set:(token:string)=>{sessionStorage.setItem('lorb_stub_token',token);sessionStorage.removeItem('lorb_auth_bounced')},clear:()=>sessionStorage.removeItem('lorb_stub_token')};
// An expired session restarts sign-in by reloading the console where it is actually served, which
// is the origin root on its own origin and a path prefix when the API process serves it. The sign-in
// effect then goes back to the configured provider — or the development login — rather than to a
// route this application does not serve. The one-shot flag stops a console that comes back still
// unauthorised from reloading itself forever; a successful sign-in clears it.
function expireSession(){session.clear();if(sessionStorage.getItem('lorb_auth_bounced'))return;sessionStorage.setItem('lorb_auth_bounced','1');window.location.assign(appBaseUrl())}
export type ApiProblem={code:string;title:string;detail:string;retryable:boolean;correlation_id:string;field_errors:unknown[]};
export function apiUrl(base:string,path:string){return new URL(path.replace(/^\/+/,''),`${base.replace(/\/+$/,'')}/`)}
type ApiRequestOptions=RequestInit&{discardResponseFields?:string[]};
function discardFields(value:unknown,fields:Set<string>):unknown{if(Array.isArray(value))return value.map(item=>discardFields(item,fields));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>fields.has(key)?[]:[[key,discardFields(item,fields)]]));return value}
export async function apiRequest<T>(base:string,path:string,options:ApiRequestOptions={}):Promise<T>{
 const {discardResponseFields=[],...requestOptions}=options;
 const correlationId=nanoid(); const method=requestOptions.method??'GET';
 // Whether this request carried a token decides how its 401 is read below: with one, the session
 // has expired; without one, the request simply ran before sign-in finished — a callback load fires
 // the projection queries while the code exchange is still in flight — and treating that as expiry
 // would clear the token the exchange has just stored and reload out of the callback.
 const hadToken=!!session.get();
 const headers:Record<string,string>={'X-Correlation-ID':correlationId,'Accept':'application/json',...(requestOptions.body?{'Content-Type':'application/json'}:{}),...(hadToken?{'Authorization':`Bearer ${session.get()}`}:{})};
 Object.assign(headers,requestOptions.headers); if(method!=='GET'&&!headers['Idempotency-Key']) headers['Idempotency-Key']=nanoid();
 const allowed=(webEnv.VITE_ALLOWED_API_ORIGINS??'http://localhost:3000,http://localhost:3100').split(',').map(origin=>origin.trim()).filter(Boolean); const url=apiUrl(base,path); if(!allowed.includes(url.origin)) throw new Error('ACCESS_DENIED');
 const start=performance.now(); log.push({direction:'outbound',method,url:url.toString(),correlationId,headers:redactHeaders(headers)});
 const response=await fetch(url,{...requestOptions,headers}); const contentType=response.headers.get('content-type')??'';let data:unknown=contentType.includes('json')?await response.json():{code:'UNEXPECTED_RESPONSE',title:'Unexpected API response',detail:await response.text(),retryable:false,correlation_id:correlationId,field_errors:[]};
 data=discardFields(data,new Set(discardResponseFields));
 log.push({direction:'inbound',method,url:url.toString(),correlationId,status:response.status,duration:performance.now()-start,errorCode:response.ok?undefined:(data as ApiProblem).code}); if(log.length>100)log.splice(0,log.length-100);
 if(containsSensitiveField(data)) throw new SuspectedLeakError();
 if(!response.ok){const problem=data as ApiProblem;if(hadToken&&['AUTHENTICATION_EXPIRED','SESSION_EXPIRED'].includes(problem.code)) expireSession();throw problem;}
 return data as T;
}
