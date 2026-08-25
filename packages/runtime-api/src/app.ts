import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type KeyLike } from "jose";
import { launchRequestSchema } from "../../contracts/src/index.js";
import { computePseudonym } from "./services/pseudonym-service.js";
import { issueDescriptor, signingKeys, store, transition, verifyDescriptor } from "./core.js";
import { resolveLaunchPolicy } from "./services/launch-policy-resolver.js";
import { registerAdminRepositoryRoutes } from "./routes/admin/repositories.js";
import { registerAdminMembershipRoutes } from "./routes/admin/memberships.js";
import { registerAdminPlayerRoutes } from "./routes/admin/players.js";
import { registerAdminLaunchPolicyRoutes } from "./routes/admin/launch-policies.js";
import { registerAdminApprovalRoutes } from "./routes/admin/approvals.js";
import { registerAdminAuditRoutes } from "./routes/admin/audit.js";
import { registerAdminClassRoutes } from "./routes/admin/classes.js";
import { correlationOf, requireAdmin, requireIdempotencyKey, sendAdminError } from "./routes/admin/shared.js";
import { learningObjectById, learningObjects, packageVersionById, packageVersions, quizContentByObjectId, REPOSITORY } from "./services/catalogue.js";
import { checkServiceCredential, sendInternalError } from "./routes/internal/service-auth.js";
import { registerInternalQuizRoutes } from "./routes/internal/quizzes.js";
import { registerInternalLaunchBatchRoutes } from "./routes/internal/launch-batch.js";
import { registerInternalRosterRoutes } from "./routes/internal/roster.js";

const problem=(code:string,status:number,correlation_id:string)=>({type:`https://lorb.example/errors/${code}`,title:code==="AUTHENTICATION_EXPIRED"?"Your session has expired":"We could not complete that request",status,code,detail:code==="AUTHENTICATION_EXPIRED"?"Sign in again to continue":"Please check the request and try again",correlation_id,retryable:status>=500,field_errors:[]});
const defaultConsumerOrigins=["http://localhost:3300","http://localhost:5176","https://lorb-production-consumer.up.railway.app","https://lorb-production-console.up.railway.app","https://lorb-production-beda.up.railway.app"];
function allowedConsumerOrigins(){
 const configured=process.env.ALLOWED_CONSUMER_ORIGINS;
 return new Set([...defaultConsumerOrigins,...(configured?.split(",")??[])].map(origin=>origin.trim()).filter(Boolean));
}
export interface RuntimeOptions {iesKey?:KeyLike;secret?:Buffer;iesIssuer?:string;iesJwksUrl?:string;publicIssuer?:string;playerOrigin?:string;evidenceEndpoint?:string;packageUrl?:string;internalServiceToken?:string}
export async function buildRuntime(options:RuntimeOptions={}){
 const app=Fastify({logger:false,bodyLimit:65536}); const keys=await signingKeys();
 app.addContentTypeParser("application/json",{parseAs:"string"},(_req,body,done)=>{if(typeof body!=="string"||body.length===0)return done(null,undefined);try{done(null,JSON.parse(body));}catch(error){done(error as Error,undefined);}});
 const iesIssuer=options.iesIssuer??process.env.IES_ISSUER??"http://localhost:4000";
 const publicIssuer=(options.publicIssuer??process.env.RUNTIME_PUBLIC_ISSUER??"http://localhost:3000").replace(/\/$/,"");
 const playerOrigin=(options.playerOrigin??process.env.PLAYER_SHELL_ORIGIN??"http://localhost:3200").replace(/\/$/,"");
 const evidenceEndpoint=options.evidenceEndpoint??process.env.EVIDENCE_API_ENDPOINT??"http://localhost:3100/api/v1/evidence/statements";
 const packageUrl=options.packageUrl??process.env.PACKAGE_PUBLIC_URL??`${playerOrigin}/module/index.html`;
 const iesKey:any=options.iesKey??createRemoteJWKSet(new URL(options.iesJwksUrl??process.env.IES_JWKS_URL??`${iesIssuer.replace(/\/$/,"")}/.well-known/jwks.json`)); const secret=options.secret??Buffer.alloc(32,1);
 const consumerOrigins=allowedConsumerOrigins();
 const browserOrigins=new Set([...consumerOrigins,playerOrigin]);
 // The Player Shell iframe is sandboxed without allow-same-origin (see anti-requirements), so its own
 // fetches to these routes (JWKS verification, state, completion) arrive with an opaque "null" Origin.
 // The quiz player is JSON-content-driven: it fetches its own question payload from the route below.
 // Like the JWKS/state/complete routes it is therefore reached from the sandboxed iframe's opaque
 // "null" origin. This widens the null-origin CORS exception by one read-only route; it does not
 // introduce a wildcard, and it is a change to CORS enforcement that needs human LORB-001 re-review.
 const playerShellRoute=(url:string)=>{const path=url.split("?")[0]??url;return path==="/api/v1/runtime/jwks"||/^\/api\/v1\/runtime\/attempts\/[^/]+\/(state|complete)$/.test(path)||/^\/api\/v1\/runtime\/learning-objects\/[^/]+\/content$/.test(path)};
 await app.register(helmet);
 await app.register(cors,{delegator:(req,cb)=>{const allowOpaqueShellOrigin=playerShellRoute(req.url);cb(null,{origin:(origin,originCb)=>originCb(null,!origin||browserOrigins.has(origin)||(allowOpaqueShellOrigin&&origin==="null"))});}});
 app.get("/api/v1/runtime/jwks",async()=>({keys:[keys.publicJwk]}));
 // STUB — NOT PRODUCTION — BLOCKED BY BLK-03. Synthetic catalogue projections live in
 // services/catalogue.ts so the internal quiz-authoring surface can extend them; see that file.
 const repository=REPOSITORY;
 // Smart links: a durable, revocable, pseudonymous deep link into the Player Shell for one PUBLISHED
 // learning object, so it can be shared outside the consumer + IES login flow. Redemption below reuses
 // issueDescriptor/computePseudonym unchanged — it does not stand up a new identity provider — but it
 // does let a learner reach the Player Shell without an IES-issued token, which is a material change to
 // the launch surface and needs the human LORB-001 re-review the README calls for.
 type SmartLink={smart_link_id:string;object_id:string;token:string;created_at:string;revoked_at:string|null};
 const smartLinksByToken=new Map<string,SmartLink>();
 const smartLinksByObject=new Map<string,SmartLink>();
 const smartLinkUrl=(token:string)=>`${publicIssuer}/api/v1/runtime/smart-links/${token}`;
 const smartLinkResponse=(link:SmartLink,correlation:string)=>({smart_link_id:link.smart_link_id,object_id:link.object_id,token:link.token,url:smartLinkUrl(link.token),created_at:link.created_at,revoked_at:link.revoked_at,correlation_id:correlation});
 function readCookie(req:any,name:string):string|undefined{const header=req.headers.cookie;if(typeof header!=="string")return undefined;const match=header.split(";").map((s:string)=>s.trim()).find((s:string)=>s.startsWith(`${name}=`));return match?decodeURIComponent(match.slice(name.length+1)):undefined;}
 const envelope=(items:unknown[],req:any)=>({items,next_cursor:null,correlation_id:typeof req.headers["x-correlation-id"]==="string"?req.headers["x-correlation-id"]:randomUUID()});
 app.get("/api/v1/runtime/repositories",async req=>envelope([repository],req));
 app.get("/api/v1/runtime/repositories/:repositoryId",async(req:any,reply)=>req.params.repositoryId===repository.repository_id?repository:reply.code(404).send(problem("OBJECT_NOT_FOUND",404,randomUUID())));
 app.get("/api/v1/runtime/learning-objects",async(req:any)=>envelope(!req.query.repository_id||req.query.repository_id===repository.repository_id?learningObjects():[],req));
 app.get("/api/v1/runtime/learning-objects/:objectId",async(req:any,reply)=>learningObjectById.get(req.params.objectId)??reply.code(404).send(problem("OBJECT_NOT_FOUND",404,randomUUID())));
 // Learner-facing quiz content. Read-only, and the *only* place the marking key is served: the quiz
 // player marks client-side (a stated PoC limitation), so the payload carries correct_option_id.
 // Nothing on the agent-facing MCP surface ever returns this route's body.
 app.get("/api/v1/runtime/learning-objects/:objectId/content",async(req:any,reply)=>{
  const object=learningObjectById.get(req.params.objectId);
  const content=quizContentByObjectId.get(req.params.objectId);
  if(!object||object.status!=="PUBLISHED"||!content)return reply.code(404).type("application/problem+json").send(problem("OBJECT_NOT_FOUND",404,randomUUID()));
  return reply.header("cache-control","no-store").send({...content,package_version_id:object.active_package_version_id});
 });
 app.get("/api/v1/runtime/package-versions",async(req:any)=>envelope(!req.query.object_id?packageVersions():packageVersions().filter(p=>p.object_id===req.query.object_id),req));
 app.get("/api/v1/runtime/package-versions/:packageVersionId",async(req:any,reply)=>packageVersionById.get(req.params.packageVersionId)??reply.code(404).send(problem("OBJECT_NOT_FOUND",404,randomUUID())));
 app.get("/api/v1/runtime/attempts",async(req:any)=>envelope([...store.attempts.values()].filter(a=>!req.query.repository_id||a.repository_id===req.query.repository_id).map(a=>({...a,pseudonymous_subject_id:a.pseudonym,correlation_id:null})),req));
 app.get("/api/v1/runtime/attempts/:attemptId",async(req:any,reply)=>store.attempts.get(req.params.attemptId)??reply.code(404).send(problem("OBJECT_NOT_FOUND",404,randomUUID())));
 // Public redemption: mints a fresh attempt + descriptor per visit (never the same attempt twice) and
 // 302s to the same "${playerOrigin}/#descriptor=..." shape /launches already produces, so the Player
 // Shell needs no changes. A top-level browser navigation avoids CORS entirely — see the 15 enforced
 // anti-requirements' "no wildcard CORS" rule, which this route sidesteps rather than relaxes.
 app.get("/api/v1/runtime/smart-links/:token",async(req:any,reply:any)=>{
  const correlation=typeof req.headers["x-correlation-id"]==="string"?req.headers["x-correlation-id"]:randomUUID();
  const link=smartLinksByToken.get(req.params.token);
  if(!link||link.revoked_at)return reply.code(404).type("application/problem+json").send(problem("SMART_LINK_NOT_FOUND",404,correlation));
  const object=learningObjectById.get(link.object_id);
  if(!object||object.status!=="PUBLISHED")return reply.code(410).type("application/problem+json").send(problem("LEARNING_OBJECT_NOT_AVAILABLE",410,correlation));
  let subject=readCookie(req,"lorb_smart_link_subject");
  if(!subject||!/^[a-f0-9-]{36}$/i.test(subject))subject=randomUUID();
  const isHttps=req.protocol==="https"||req.headers["x-forwarded-proto"]==="https";
  reply.header("set-cookie",`lorb_smart_link_subject=${subject}; Max-Age=31536000; Path=/; SameSite=Lax${isHttps?"; Secure":""}`);
  const attempt_id=randomUUID(),object_version_id=randomUUID(),package_version_id=randomUUID();
  // Namespaced by a fixed "smart-link" issuer (distinct from any real IES issuer string) so these
  // pseudonyms can never collide with a pseudonym derived from a genuine IES login.
  const pseudonym=computePseudonym(secret,"smart-link",subject,"launch");
  store.attempts.set(attempt_id,{attempt_id,repository_id:object.repository_id,object_version_id,package_version_id,pseudonym,status:"CREATED",revision:1});
  const expires=new Date(Date.now()+600000).toISOString();
  const descriptor=await issueDescriptor(keys.privateKey,{sub:pseudonym,repository_id:object.repository_id,consumer_id:"smart-link",object_id:object.object_id,object_version_id,package_version_id,correlation_id:randomUUID(),locale:"en-GB",attempt_id,state_endpoint:`${publicIssuer}/api/v1/runtime/attempts/${attempt_id}/state`,package_url:`${playerOrigin}${object.module_path}`,session_config:{expires_at:expires}},{issuer:publicIssuer,evidenceEndpoint});
  return reply.redirect(`${playerOrigin}/#descriptor=${encodeURIComponent(descriptor)}`,302);
 });
 app.post("/api/v1/runtime/launches",async(req,reply)=>{const correlation=typeof req.headers["x-correlation-id"]==="string"?req.headers["x-correlation-id"]:randomUUID();const idem=req.headers["idempotency-key"];if(typeof idem!=="string")return reply.code(400).type("application/problem+json").send(problem("LAUNCH_CONTEXT_INVALID",400,correlation));if(store.idempotency.has(idem))return reply.code(201).send(store.idempotency.get(idem));let body;try{body=launchRequestSchema.parse(req.body);}catch{return reply.code(400).type("application/problem+json").send(problem("LAUNCH_CONTEXT_INVALID",400,correlation));}let claims;try{const token=req.headers.authorization?.replace(/^Bearer /,"");if(!token)throw 0;claims=(await jwtVerify(token,iesKey,{issuer:iesIssuer,audience:"lorb-runtime",algorithms:["ES256"]})).payload;if(!claims.sub)throw 0;}catch{return reply.code(401).type("application/problem+json").send(problem("AUTHENTICATION_EXPIRED",401,correlation));}const attempt_id=randomUUID(),launch_id=randomUUID(),object_version_id=randomUUID(),package_version_id=randomUUID();const pseudonym=computePseudonym(secret,iesIssuer,claims.sub as string,"launch");const policyResolution=await resolveLaunchPolicy({consumerId:body.consumer_id,repositoryId:body.repository_id,deliveryProfile:"native-web-package",launchMode:body.requested_launch_mode});const requestedObject=learningObjectById.get(body.object_id);const requestedPackageUrl=requestedObject?`${playerOrigin}${requestedObject.module_path}`:packageUrl;
  // A launch policy routes a *player* — the renderer — for content that does not care which one it
  // gets. Some content does care: a quiz is a JSON payload that only the quiz player can present and
  // mark, and create_quiz tells the teacher it is "rendered by the fixed, already-reviewed
  // quiz-player package version". Such an object points its active_package_version_id at a
  // shared_player row, and that pin wins over the policy. Letting the policy override it silently
  // substituted the renderer: the quiz launched into a generic shell that had nothing to display,
  // which is why smart links worked and Consumer launches did not.
  //
  // The policy still governs everything else and is still recorded on the attempt, so the
  // administration workspace continues to show that it applied.
  // The pin is only honoured when the object actually belongs to the repository being launched.
  // Without that condition, naming any known shared-player object alongside any repository would
  // bypass that repository's policy — the request carries both identifiers and nothing else forces
  // them to agree.
  const pinnedPlayer=requestedObject?.repository_id===body.repository_id&&packageVersionById.get(requestedObject.active_package_version_id)?.shared_player===true;const resolvedPackageUrl=pinnedPlayer?requestedPackageUrl:(policyResolution?.packageUrl??requestedPackageUrl);store.attempts.set(attempt_id,{attempt_id,repository_id:body.repository_id,object_version_id,package_version_id,pseudonym,status:"CREATED",revision:1,...(policyResolution?{governed_by_launch_policy:{launch_policy_id:policyResolution.governedBy.launchPolicyId,launch_policy_version_id:policyResolution.governedBy.launchPolicyVersionId,display_name:policyResolution.governedBy.displayName,semver:policyResolution.governedBy.semver}}:{}),...(pinnedPlayer?{package_pinned_by_object:true}:{})});const expires=new Date(Date.now()+600000).toISOString();const descriptor=await issueDescriptor(keys.privateKey,{sub:pseudonym,repository_id:body.repository_id,consumer_id:body.consumer_id,object_id:body.object_id,object_version_id,package_version_id,correlation_id:randomUUID(),locale:body.locale,attempt_id,state_endpoint:`${publicIssuer}/api/v1/runtime/attempts/${attempt_id}/state`,package_url:resolvedPackageUrl,session_config:{expires_at:expires}},{issuer:publicIssuer,evidenceEndpoint});const response={launch_id,attempt_id,signed_descriptor:descriptor,player_url:`${playerOrigin}/#descriptor=${encodeURIComponent(descriptor)}`,expires_at:expires,correlation_id:correlation};store.launches.set(launch_id,response);store.idempotency.set(idem,response);return reply.code(201).send(response)});
 async function auth(req:any,reply:any){try{const token=req.headers.authorization?.replace(/^Bearer /,"");if(!token)throw 0;return await verifyDescriptor(token,keys.privateKey as KeyLike,publicIssuer);}catch{reply.code(401).type("application/problem+json").send(problem("SESSION_EXPIRED",401,randomUUID()));}}
 app.put("/api/v1/runtime/attempts/:attemptId/state",async(req:any,reply)=>{if(!req.headers["idempotency-key"])return reply.code(400).send(problem("LAUNCH_CONTEXT_INVALID",400,randomUUID()));const d=await auth(req,reply);if(!d)return;const attempt=store.attempts.get(req.params.attemptId);const body=req.body as any;if(!attempt||d.attempt_id!==attempt.attempt_id||body?.revision!==attempt.revision)return reply.code(409).send(problem("ATTEMPT_CONFLICT",409,d.correlation_id));if(JSON.stringify(body.state_payload).length>65536||/(email|name|dob|date_of_birth|address)/i.test(JSON.stringify(Object.keys(body.state_payload??{}))))return reply.code(400).send(problem("LAUNCH_CONTEXT_INVALID",400,d.correlation_id));attempt.state=body.state_payload;attempt.revision++;if(attempt.status==="CREATED")transition(attempt,"STARTED");return reply.send({revision:attempt.revision,correlation_id:d.correlation_id});});
 app.post("/api/v1/runtime/attempts/:attemptId/complete",async(req:any,reply)=>{if(!req.headers["idempotency-key"])return reply.code(400).send(problem("LAUNCH_CONTEXT_INVALID",400,randomUUID()));const d=await auth(req,reply);if(!d)return;const attempt=store.attempts.get(req.params.attemptId);try{if(!attempt)throw 0;transition(attempt,"COMPLETED");return reply.send({attempt_id:attempt.attempt_id,status:attempt.status,correlation_id:d.correlation_id});}catch{return reply.code(409).send(problem("ATTEMPT_CONFLICT",409,d.correlation_id));}});
 const adminCtx={iesKey,iesIssuer,tenantSecret:secret,playerModuleOriginAllowlist:[playerOrigin,"http://localhost:3200"]};
 // Not one of Section 8's listed endpoints, but structurally required: the Admin UI must know its own pseudonym
 // to implement Section 12's UI-layer self-approval disablement without guessing at another principal's identity.
 app.get("/api/v1/admin/whoami",async(req:any,reply:any)=>{const principal=await requireAdmin(req,reply,adminCtx,"admin.whoami","admin_principal");if(!principal)return;return {pseudonym:principal.pseudonym,role:principal.role,platform_admin:principal.platformAdmin,correlation_id:correlationOf(req)};});
 // STUB — NOT PRODUCTION — BLOCKED BY BLK-03. Read-only administration projection of the same non-production
 // catalogue exposed at /api/v1/runtime/learning-objects, so learning content examples are discoverable from
 // the Administration workspace without requiring the unresolved Postgres content-authoring flow.
 app.get("/api/v1/admin/learning-objects",async(req:any,reply:any)=>{const principal=await requireAdmin(req,reply,adminCtx,"learning_object.list","learning_object");if(!principal)return;return {items:learningObjects().map(o=>({...o,package_version:packageVersionById.get(o.active_package_version_id)})),next_cursor:null,correlation_id:correlationOf(req)};});
 // Smart link management. Kept in-memory alongside the learning-object catalogue above (also a stub
 // blocked by BLK-03) rather than the Postgres-backed admin tables, since it governs that same
 // non-production catalogue and has no repository to bind a membership check to.
 app.post("/api/v1/admin/learning-objects/:objectId/smart-link",async(req:any,reply:any)=>{
  const principal=await requireAdmin(req,reply,adminCtx,"smart_link.create","smart_link");if(!principal)return;
  const correlation=correlationOf(req);
  if(!requireIdempotencyKey(req,reply))return;
  const object=learningObjectById.get(req.params.objectId);
  if(!object)return sendAdminError(reply,"LEARNING_OBJECT_NOT_FOUND",correlation);
  if(object.status!=="PUBLISHED")return sendAdminError(reply,"LEARNING_OBJECT_NOT_PUBLISHED",correlation);
  const existing=smartLinksByObject.get(object.object_id);
  if(existing&&!existing.revoked_at)return reply.code(200).send(smartLinkResponse(existing,correlation));
  const link:SmartLink={smart_link_id:randomUUID(),object_id:object.object_id,token:randomBytes(24).toString("base64url"),created_at:new Date().toISOString(),revoked_at:null};
  smartLinksByObject.set(object.object_id,link);smartLinksByToken.set(link.token,link);
  return reply.code(201).send(smartLinkResponse(link,correlation));
 });
 app.get("/api/v1/admin/learning-objects/:objectId/smart-link",async(req:any,reply:any)=>{
  const principal=await requireAdmin(req,reply,adminCtx,"smart_link.get","smart_link");if(!principal)return;
  const correlation=correlationOf(req);
  const link=smartLinksByObject.get(req.params.objectId);
  if(!link||link.revoked_at)return sendAdminError(reply,"SMART_LINK_NOT_FOUND",correlation);
  return smartLinkResponse(link,correlation);
 });
 app.post("/api/v1/admin/learning-objects/:objectId/smart-link/revoke",async(req:any,reply:any)=>{
  const principal=await requireAdmin(req,reply,adminCtx,"smart_link.revoke","smart_link");if(!principal)return;
  const correlation=correlationOf(req);
  if(!requireIdempotencyKey(req,reply))return;
  const link=smartLinksByObject.get(req.params.objectId);
  if(!link||link.revoked_at)return sendAdminError(reply,"SMART_LINK_NOT_FOUND",correlation);
  link.revoked_at=new Date().toISOString();
  smartLinksByToken.delete(link.token);
  return smartLinkResponse(link,correlation);
 });
 // Internal service-to-service surface. Separate credential, separate path prefix, browser-origin
 // requests refused. See routes/internal/service-auth.ts for why this needs human LORB-001 re-review.
 const internalServiceToken=options.internalServiceToken??process.env.RUNTIME_INTERNAL_SERVICE_TOKEN;
 const internalGuard=(req:any,reply:any,correlation:string)=>{const failure=checkServiceCredential(req,internalServiceToken);if(!failure)return true;void sendInternalError(reply,failure,correlation);return false;};
 registerInternalQuizRoutes(app,internalGuard);
 registerInternalLaunchBatchRoutes(app,{serviceToken:internalServiceToken,privateKey:keys.privateKey,secret,iesIssuer,publicIssuer,playerOrigin,evidenceEndpoint},internalGuard);
 registerInternalRosterRoutes(app,internalGuard);
 registerAdminRepositoryRoutes(app,adminCtx);
 registerAdminMembershipRoutes(app,adminCtx);
 registerAdminPlayerRoutes(app,adminCtx);
 registerAdminLaunchPolicyRoutes(app,adminCtx);
 registerAdminApprovalRoutes(app,adminCtx);
 registerAdminAuditRoutes(app,adminCtx);
 registerAdminClassRoutes(app,adminCtx);
 return {app,keys};
}
