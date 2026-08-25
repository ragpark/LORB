import {nanoid} from 'nanoid';
import type {Config} from './config.js';
import {logDiagnostic,redactedHeaders} from './diagnostics.js';
import {ApiProblem} from './api.js';
import {adminTokenStore} from './security.js';

/**
 * Roster administration calls, deliberately separate from `apiRequest`.
 *
 * Two differences, both of which need to stay visible rather than folded into the learner-facing
 * client:
 *
 * 1. It does not run responses through `sanitise`. That guard strips any key matching
 *    /(email|(^|_)name$|dob|date_of_birth|address)/i, which is correct for every learner-facing
 *    runtime response and fatal here — a roster is made of class `name` and learner `display_name`.
 *    Suppressing the guard for this one surface deliberately narrows a rail the portal otherwise
 *    relies on everywhere, so the narrowing is confined to the one client that needs it: everything
 *    the learner-facing UI fetches still goes through `apiRequest` and is still checked. A display
 *    name reaches a teacher's screen and stops there — it never enters a launch descriptor or an
 *    xAPI statement, and the descriptor schema would reject it if it tried.
 *
 * 2. It carries the administrator token, not the learner token. The two are kept in separate
 *    session storage keys so signing in as a teacher never widens what a learner session can reach.
 */
export async function adminRequest<T>(config:Config,path:string,init:RequestInit={}):Promise<T>{
 const correlationId=nanoid();
 const headers=new Headers(init.headers);
 headers.set('Authorization',`Bearer ${adminTokenStore.get()??''}`);
 headers.set('X-Correlation-ID',correlationId);
 headers.set('Content-Type','application/json');
 if((init.method??'GET')!=='GET')headers.set('Idempotency-Key',crypto.randomUUID());
 const started=performance.now();
 const response=await fetch(`${config.adminApiBase}/${path}`,{...init,headers});
 if(response.status===204){logDiagnostic({kind:'http',correlationId,status:204,durationMs:performance.now()-started,headers:redactedHeaders(headers)});return undefined as T}
 const body=await response.json() as Record<string,unknown>;
 logDiagnostic({kind:'http',correlationId,status:response.status,durationMs:performance.now()-started,errorCode:typeof body.code==='string'?body.code:undefined,headers:redactedHeaders(headers)});
 if(!response.ok)throw new ApiProblem(typeof body.code==='string'?body.code:'UNKNOWN_ERROR',typeof body.correlation_id==='string'?body.correlation_id:correlationId);
 return body as T;
}
