// STUB — NOT PRODUCTION — BLOCKED BY BLK-02.
export const launch=(url:string,token:string,body:unknown,idempotencyKey:string)=>fetch(url,{method:"POST",headers:{authorization:`Bearer ${token}`,"idempotency-key":idempotencyKey,"content-type":"application/json"},body:JSON.stringify(body)});
