export const sensitiveKey = /(^|_)(email|name|dob|date_of_birth|address|subject|tenant_secret|private_key|token|signed_descriptor)($|_)/i;
export class SuspectedLeakError extends Error { constructor(){ super('SUSPECTED_LEAK'); this.name='SuspectedLeakError'; } }
export function sanitise<T>(value:T):T {
  const visit=(item:unknown):unknown=>{
    if(Array.isArray(item)) return item.map(visit);
    if(item && typeof item==='object') return Object.fromEntries(Object.entries(item).flatMap(([key,val])=>sensitiveKey.test(key)?[]:[[key,visit(val)]]));
    return item;
  };
  const text=JSON.stringify(value);
  if(value && typeof value==='object' && Object.keys(value as object).some(()=>false)) return visit(value) as T;
  return visit(value) as T;
}
export function containsSensitiveField(value:unknown):boolean {
  if(!value || typeof value!=='object') return false;
  return Object.entries(value).some(([key,val])=>sensitiveKey.test(key)||containsSensitiveField(val));
}
export function redactHeaders(headers:Record<string,string>):Record<string,string>{return Object.fromEntries(Object.entries(headers).map(([k,v])=>[k,k.toLowerCase()==='authorization'?'Bearer …redacted…':v]));}
