import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK, type KeyLike } from "jose";
import { descriptorSchema } from "../../contracts/src/index.js";

export type Attempt={attempt_id:string;repository_id:string;object_version_id:string;package_version_id:string;pseudonym:string;status:"CREATED"|"STARTED"|"COMPLETED";revision:number;state?:unknown};
export const store={attempts:new Map<string,Attempt>(),launches:new Map<string,unknown>(),idempotency:new Map<string,unknown>(),outbox:new Map<string,unknown>()};
export async function signingKeys(){const {privateKey,publicKey}=await generateKeyPair("ES256",{extractable:true});const jwk=await exportJWK(publicKey);return {privateKey,publicJwk:{...jwk,kid:"mvp-key-001",alg:"ES256",use:"sig"} as JWK};}
export async function issueDescriptor(privateKey:KeyLike, claims:Record<string,unknown>,config={issuer:"http://localhost:3000",evidenceEndpoint:"http://localhost:3100/api/v1/evidence/statements"}){
 const now=Math.floor(Date.now()/1000); const payload={...claims,iss:config.issuer,aud:"lorb-player",iat:now,nbf:now,exp:now+600,jti:randomUUID(),tenant_id:"mvp-tenant",delivery_profile:"native-web-package",launch_mode:"embedded-iframe",player_ref:"mvp-shell-v1",evidence_endpoint:config.evidenceEndpoint,telemetry_config:{correlation_header:"X-Correlation-ID"},contract_version:"1.0"}; descriptorSchema.parse(payload);
 return new SignJWT(payload).setProtectedHeader({alg:"ES256",kid:"mvp-key-001",typ:"lorb-launch+jwt",cty:"application/lorb-launch+json",lorb_schema:"1.0"}).sign(privateKey);
}
export async function verifyDescriptor(token:string,key:KeyLike,issuer="http://localhost:3000"){const {payload}=await jwtVerify(token,key,{issuer,audience:"lorb-player",algorithms:["ES256"]});return descriptorSchema.parse(payload);}
export function transition(attempt:Attempt,next:"STARTED"|"COMPLETED") {if((attempt.status==="CREATED"&&next==="STARTED")||(attempt.status==="STARTED"&&next==="COMPLETED")){attempt.status=next;return;}throw new Error("ATTEMPT_CONFLICT");}
export function originAllowed(origin:string,configured:string,moduleOrigin:string,source:unknown,iframeWindow:unknown){return origin!=="*"&&configured.split(",").includes(origin)&&origin===moduleOrigin&&source===iframeWindow;}
