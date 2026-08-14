import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type KeyLike } from "jose";
import { launchRequestSchema } from "../../contracts/src/index.js";
import { computePseudonym } from "./services/pseudonym-service.js";
import { issueDescriptor, signingKeys, store, transition, verifyDescriptor } from "./core.js";

const problem=(code:string,status:number,correlation_id:string)=>({type:`https://lorb.example/errors/${code}`,title:code==="AUTHENTICATION_EXPIRED"?"Your session has expired":"We could not complete that request",status,code,detail:code==="AUTHENTICATION_EXPIRED"?"Sign in again to continue":"Please check the request and try again",correlation_id,retryable:status>=500,field_errors:[]});
const defaultConsumerOrigins=["http://localhost:3300","https://lorb-production-consumer.up.railway.app"];
function allowedConsumerOrigins(){
 const configured=process.env.ALLOWED_CONSUMER_ORIGINS;
 return new Set([...defaultConsumerOrigins,...(configured?.split(",")??[])].map(origin=>origin.trim()).filter(Boolean));
}
export interface RuntimeOptions {iesKey?:KeyLike;secret?:Buffer;iesIssuer?:string;iesJwksUrl?:string;publicIssuer?:string;playerOrigin?:string;evidenceEndpoint?:string;packageUrl?:string}
export async function buildRuntime(options:RuntimeOptions={}){
 const app=Fastify({logger:false,bodyLimit:65536}); const keys=await signingKeys();
 const iesIssuer=options.iesIssuer??process.env.IES_ISSUER??"http://localhost:4000";
 const publicIssuer=(options.publicIssuer??process.env.RUNTIME_PUBLIC_ISSUER??"http://localhost:3000").replace(/\/$/,"");
 const playerOrigin=(options.playerOrigin??process.env.PLAYER_SHELL_ORIGIN??"http://localhost:3200").replace(/\/$/,"");
 const evidenceEndpoint=options.evidenceEndpoint??process.env.EVIDENCE_API_ENDPOINT??"http://localhost:3100/api/v1/evidence/statements";
 const packageUrl=options.packageUrl??process.env.PACKAGE_PUBLIC_URL??`${playerOrigin}/module/index.html`;
 const iesKey:any=options.iesKey??createRemoteJWKSet(new URL(options.iesJwksUrl??process.env.IES_JWKS_URL??`${iesIssuer.replace(/\/$/,"")}/.well-known/jwks.json`)); const secret=options.secret??Buffer.alloc(32,1);
 const consumerOrigins=allowedConsumerOrigins();
 const browserOrigins=new Set([...consumerOrigins,playerOrigin]);
 await app.register(helmet); await app.register(cors,{origin:(origin,cb)=>cb(null,!origin||browserOrigins.has(origin))});
 app.get("/api/v1/runtime/jwks",async()=>({keys:[keys.publicJwk]}));
 // STUB — NOT PRODUCTION — BLOCKED BY BLK-03. These synthetic projections stand in for the unresolved Postgres repository layer.
 const repository={repository_id:"repo-mvp",slug:"maths-foundations",display_name:"Maths foundations",status:"ACTIVE",created_at:"2026-08-12T09:14:00.000Z"};
 const learningObject={object_id:"object-mvp",repository_id:repository.repository_id,status:"PUBLISHED",active_object_version_id:"object-version-mvp",active_package_version_id:"package-version-mvp",created_at:"2026-08-12T09:22:00.000Z"};
 const packageVersion={package_version_id:"package-version-mvp",object_id:learningObject.object_id,semver:"1.4.0",sha256:"4f3c9a182fd1b953",delivery_profile:"native-web-package",status:"PUBLISHED",published_at:"2026-08-12T10:04:00.000Z"};
 const envelope=(items:unknown[],req:any)=>({items,next_cursor:null,correlation_id:typeof req.headers["x-correlation-id"]==="string"?req.headers["x-correlation-id"]:randomUUID()});
 app.get("/api/v1/runtime/repositories",async req=>envelope([repository],req));
 app.get("/api/v1/runtime/repositories/:repositoryId",async(req:any,reply)=>req.params.repositoryId===repository.repository_id?repository:reply.code(404).send(problem("OBJECT_NOT_FOUND",404,randomUUID())));
 app.get("/api/v1/runtime/learning-objects",async(req:any)=>envelope(!req.query.repository_id||req.query.repository_id===repository.repository_id?[learningObject]:[],req));
 app.get("/api/v1/runtime/learning-objects/:objectId",async(req:any,reply)=>req.params.objectId===learningObject.object_id?learningObject:reply.code(404).send(problem("OBJECT_NOT_FOUND",404,randomUUID())));
 app.get("/api/v1/runtime/package-versions",async(req:any)=>envelope(!req.query.object_id||req.query.object_id===learningObject.object_id?[packageVersion]:[],req));
 app.get("/api/v1/runtime/package-versions/:packageVersionId",async(req:any,reply)=>req.params.packageVersionId===packageVersion.package_version_id?packageVersion:reply.code(404).send(problem("OBJECT_NOT_FOUND",404,randomUUID())));
 app.get("/api/v1/runtime/attempts",async(req:any)=>envelope([...store.attempts.values()].filter(a=>!req.query.repository_id||a.repository_id===req.query.repository_id).map(a=>({...a,pseudonymous_subject_id:a.pseudonym,correlation_id:null})),req));
 app.get("/api/v1/runtime/attempts/:attemptId",async(req:any,reply)=>store.attempts.get(req.params.attemptId)??reply.code(404).send(problem("OBJECT_NOT_FOUND",404,randomUUID())));
 app.post("/api/v1/runtime/launches",async(req,reply)=>{const correlation=typeof req.headers["x-correlation-id"]==="string"?req.headers["x-correlation-id"]:randomUUID();const idem=req.headers["idempotency-key"];if(typeof idem!=="string")return reply.code(400).type("application/problem+json").send(problem("LAUNCH_CONTEXT_INVALID",400,correlation));if(store.idempotency.has(idem))return reply.code(201).send(store.idempotency.get(idem));let body;try{body=launchRequestSchema.parse(req.body);}catch{return reply.code(400).type("application/problem+json").send(problem("LAUNCH_CONTEXT_INVALID",400,correlation));}let claims;try{const token=req.headers.authorization?.replace(/^Bearer /,"");if(!token)throw 0;claims=(await jwtVerify(token,iesKey,{issuer:iesIssuer,audience:"lorb-runtime",algorithms:["ES256"]})).payload;if(!claims.sub)throw 0;}catch{return reply.code(401).type("application/problem+json").send(problem("AUTHENTICATION_EXPIRED",401,correlation));}const attempt_id=randomUUID(),launch_id=randomUUID(),object_version_id=randomUUID(),package_version_id=randomUUID();const pseudonym=computePseudonym(secret,iesIssuer,claims.sub as string,"launch");store.attempts.set(attempt_id,{attempt_id,repository_id:body.repository_id,object_version_id,package_version_id,pseudonym,status:"CREATED",revision:1});const expires=new Date(Date.now()+600000).toISOString();const descriptor=await issueDescriptor(keys.privateKey,{sub:pseudonym,repository_id:body.repository_id,consumer_id:body.consumer_id,object_id:body.object_id,object_version_id,package_version_id,correlation_id:correlation,locale:body.locale,attempt_id,state_endpoint:`${publicIssuer}/api/v1/runtime/attempts/${attempt_id}/state`,package_url:packageUrl,session_config:{expires_at:expires}},{issuer:publicIssuer,evidenceEndpoint});const response={launch_id,attempt_id,signed_descriptor:descriptor,player_url:`${playerOrigin}/#descriptor=${encodeURIComponent(descriptor)}`,expires_at:expires,correlation_id:correlation};store.launches.set(launch_id,response);store.idempotency.set(idem,response);return reply.code(201).send(response)});
 async function auth(req:any,reply:any){try{const token=req.headers.authorization?.replace(/^Bearer /,"");if(!token)throw 0;return await verifyDescriptor(token,keys.privateKey as KeyLike,publicIssuer);}catch{reply.code(401).type("application/problem+json").send(problem("SESSION_EXPIRED",401,randomUUID()));}}
 app.put("/api/v1/runtime/attempts/:attemptId/state",async(req:any,reply)=>{if(!req.headers["idempotency-key"])return reply.code(400).send(problem("LAUNCH_CONTEXT_INVALID",400,randomUUID()));const d=await auth(req,reply);if(!d)return;const attempt=store.attempts.get(req.params.attemptId);const body=req.body as any;if(!attempt||d.attempt_id!==attempt.attempt_id||body?.revision!==attempt.revision)return reply.code(409).send(problem("ATTEMPT_CONFLICT",409,d.correlation_id));if(JSON.stringify(body.state_payload).length>65536||/(email|name|dob|date_of_birth|address)/i.test(JSON.stringify(Object.keys(body.state_payload??{}))))return reply.code(400).send(problem("LAUNCH_CONTEXT_INVALID",400,d.correlation_id));attempt.state=body.state_payload;attempt.revision++;if(attempt.status==="CREATED")transition(attempt,"STARTED");return reply.send({revision:attempt.revision,correlation_id:d.correlation_id});});
 app.post("/api/v1/runtime/attempts/:attemptId/complete",async(req:any,reply)=>{if(!req.headers["idempotency-key"])return reply.code(400).send(problem("LAUNCH_CONTEXT_INVALID",400,randomUUID()));const d=await auth(req,reply);if(!d)return;const attempt=store.attempts.get(req.params.attemptId);try{if(!attempt)throw 0;transition(attempt,"COMPLETED");return reply.send({attempt_id:attempt.attempt_id,status:attempt.status,correlation_id:d.correlation_id});}catch{return reply.code(409).send(problem("ATTEMPT_CONFLICT",409,d.correlation_id));}});
 return {app,keys};
}
