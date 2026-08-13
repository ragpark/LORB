// STUB — NOT PRODUCTION — BLOCKED BY BLK-11.
import { store } from "../../runtime-api/src/core.js";
export async function forwardPending(send:(payload:unknown)=>Promise<{statusCode:number}>){for(const row of store.outbox.values() as Iterable<any>){if(row.status!=="PENDING")continue;const result=await send(row.payload);row.status=result.statusCode===200?"FORWARDED":"FAILED";}}
