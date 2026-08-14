export interface Diagnostic {at:string;kind:string;correlationId:string;status?:number;durationMs?:number;errorCode?:string;headers?:Record<string,string>}
let events:Diagnostic[]=[];const listeners=new Set<()=>void>();
export function logDiagnostic(event:Omit<Diagnostic,'at'>){events=[...events,{...event,at:new Date().toISOString()}].slice(-100);listeners.forEach(fn=>fn())}
export const diagnostics={snapshot:()=>events,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)},clear:()=>{events=[]}};
export const redactedHeaders=(headers:HeadersInit)=>{const h=new Headers(headers);if(h.has('Authorization'))h.set('Authorization','Bearer …redacted…');return Object.fromEntries(h.entries())};
