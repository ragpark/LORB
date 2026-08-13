import { nanoid } from 'nanoid';
import { containsSensitiveField,redactHeaders,SuspectedLeakError } from './security.js';
export type Diagnostic={direction:'outbound'|'inbound';method:string;url:string;correlationId:string;status?:number;duration?:number;headers?:Record<string,string>;errorCode?:string};
const log:Diagnostic[]=[]; export const diagnostics=()=>[...log];
export const session={get:()=>sessionStorage.getItem('lorb_stub_token'),set:(token:string)=>sessionStorage.setItem('lorb_stub_token',token),clear:()=>sessionStorage.removeItem('lorb_stub_token')};
export type ApiProblem={code:string;title:string;detail:string;retryable:boolean;correlation_id:string;field_errors:unknown[]};
export async function apiRequest<T>(base:string,path:string,options:RequestInit={}):Promise<T>{
 const correlationId=nanoid(); const method=options.method??'GET'; const headers:Record<string,string>={'X-Correlation-ID':correlationId,'Accept':'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(session.get()?{'Authorization':`Bearer ${session.get()}`}:{})};
 Object.assign(headers,options.headers); if(method!=='GET'&&!headers['Idempotency-Key']) headers['Idempotency-Key']=nanoid();
 const allowed=(import.meta.env.VITE_ALLOWED_API_ORIGINS??'http://localhost:3000,http://localhost:3100').split(','); const url=new URL(path,base); if(!allowed.includes(url.origin)) throw new Error('ACCESS_DENIED');
 const start=performance.now(); log.push({direction:'outbound',method,url:url.toString(),correlationId,headers:redactHeaders(headers)});
 const response=await fetch(url,{...options,headers}); let data:unknown=await response.json();
 log.push({direction:'inbound',method,url:url.toString(),correlationId,status:response.status,duration:performance.now()-start,errorCode:response.ok?undefined:(data as ApiProblem).code}); if(log.length>100)log.splice(0,log.length-100);
 if(containsSensitiveField(data)) throw new SuspectedLeakError();
 if(!response.ok){const problem=data as ApiProblem;if(['AUTHENTICATION_EXPIRED','SESSION_EXPIRED'].includes(problem.code)) window.location.assign(import.meta.env.VITE_STUB_IES_LOGIN_URL??'/sign-in');throw problem;}
 return data as T;
}
