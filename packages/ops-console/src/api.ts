import { nanoid } from 'nanoid';
import { containsSensitiveField,redactHeaders,SuspectedLeakError } from './security.js';
export type Diagnostic={direction:'outbound'|'inbound';method:string;url:string;correlationId:string;status?:number;duration?:number;headers?:Record<string,string>;errorCode?:string};
const log:Diagnostic[]=[]; export const diagnostics=()=>[...log];
export const session={get:()=>sessionStorage.getItem('lorb_stub_token'),set:(token:string)=>sessionStorage.setItem('lorb_stub_token',token),clear:()=>sessionStorage.removeItem('lorb_stub_token')};
export type ApiProblem={code:string;title:string;detail:string;retryable:boolean;correlation_id:string;field_errors:unknown[]};
export function apiUrl(base:string,path:string){return new URL(path.replace(/^\/+/,''),`${base.replace(/\/+$/,'')}/`)}
type ApiRequestOptions=RequestInit&{discardResponseFields?:string[]};
function discardFields(value:unknown,fields:Set<string>):unknown{if(Array.isArray(value))return value.map(item=>discardFields(item,fields));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>fields.has(key)?[]:[[key,discardFields(item,fields)]]));return value}
export async function apiRequest<T>(base:string,path:string,options:ApiRequestOptions={}):Promise<T>{
 const {discardResponseFields=[],...requestOptions}=options;
 const correlationId=nanoid(); const method=requestOptions.method??'GET'; const headers:Record<string,string>={'X-Correlation-ID':correlationId,'Accept':'application/json',...(requestOptions.body?{'Content-Type':'application/json'}:{}),...(session.get()?{'Authorization':`Bearer ${session.get()}`}:{})};
 Object.assign(headers,requestOptions.headers); if(method!=='GET'&&!headers['Idempotency-Key']) headers['Idempotency-Key']=nanoid();
 const allowed=(import.meta.env.VITE_ALLOWED_API_ORIGINS??'http://localhost:3000,http://localhost:3100').split(',').map(origin=>origin.trim()).filter(Boolean); const url=apiUrl(base,path); if(!allowed.includes(url.origin)) throw new Error('ACCESS_DENIED');
 const start=performance.now(); log.push({direction:'outbound',method,url:url.toString(),correlationId,headers:redactHeaders(headers)});
 const response=await fetch(url,{...requestOptions,headers}); const contentType=response.headers.get('content-type')??'';let data:unknown=contentType.includes('json')?await response.json():{code:'UNEXPECTED_RESPONSE',title:'Unexpected API response',detail:await response.text(),retryable:false,correlation_id:correlationId,field_errors:[]};
 data=discardFields(data,new Set(discardResponseFields));
 log.push({direction:'inbound',method,url:url.toString(),correlationId,status:response.status,duration:performance.now()-start,errorCode:response.ok?undefined:(data as ApiProblem).code}); if(log.length>100)log.splice(0,log.length-100);
 if(containsSensitiveField(data)) throw new SuspectedLeakError();
 if(!response.ok){const problem=data as ApiProblem;if(['AUTHENTICATION_EXPIRED','SESSION_EXPIRED'].includes(problem.code)) window.location.assign(import.meta.env.VITE_STUB_IES_LOGIN_URL??'/sign-in');throw problem;}
 return data as T;
}
