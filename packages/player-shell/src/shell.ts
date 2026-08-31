import {createRemoteJWKSet,jwtVerify} from "jose";
import {postMessageSchema} from "../../contracts/src/index.js";
import {HANDSHAKE_FRAGMENT_KEY,handshakeAllowed} from "./postmessage.js";

type Descriptor={iss:string;aud:string;attempt_id:string;correlation_id:string;state_endpoint:string;evidence_endpoint:string;package_url:string;sub:string;object_id:string;object_version_id:string;repository_id:string;package_version_id:string;session_config:{expires_at:string};content_profile?:string};
const frame=document.querySelector<HTMLIFrameElement>("#module")!;
const status=document.querySelector<HTMLElement>("#status")!;
const parentOrigin=document.referrer?new URL(document.referrer).origin:"";
const emit=(type:string,payload:Record<string,unknown>)=>parent.postMessage({protocol:"lorb-player",version:"1.0",type,message_id:crypto.randomUUID(),correlation_id:descriptor?.correlation_id??crypto.randomUUID(),reply_to:null,sent_at:new Date().toISOString(),payload},parentOrigin||location.origin);
let descriptor:Descriptor|undefined;
let revision=1;
// Module handshake. A module that needs launch context posts `module.hello` to the shell and
// transfers one end of a MessageChannel with it; the shell replies `shell.context` down that port and
// listens on it for everything the module sends afterwards.
//
// The shell cannot simply postMessage into the iframe: a module sandboxed without allow-same-origin
// has an *opaque* origin, so a `postMessage` targeted at the package origin is silently dropped by the
// browser, and the only targetOrigin that would reach it is "*". A MessagePort avoids that choice
// entirely — it is a capability held by exactly two endpoints, so it needs no target origin at all and
// cannot be listened to by any other document.
//
// `content_url` is derived here from the descriptor's own issuer, object id and object version rather
// than carried as a new descriptor claim, so content-driven packages (e.g. quiz-player) can fetch
// their JSON payload without changing the launch descriptor contract. Modules that never handshake
// are unaffected. The object version is on the URL because content can be edited: it pins the fetch
// to what this launch was issued against, so a learner mid-attempt keeps the questions they started.
// Per-launch handshake secret. Placed in the iframe URL fragment, so only the document the shell
// itself navigates to ever sees it.
const handshakeNonce=crypto.randomUUID();
let modulePort:MessagePort|undefined;
let handshakeClosed=false;
function endSession(code:string,detail:string){handshakeClosed=true;modulePort?.close();modulePort=undefined;status.textContent="This activity was closed.";emit("experience.error",{code,recoverable:false,detail});}
// A module that navigates its own browsing context keeps the same WindowProxy and the same opaque
// origin, so neither can distinguish the new document from the one we loaded. Rather than try, end the
// session the moment the document under an established channel changes.
// The first load after we assign frame.src is the document we navigated to. A module whose script
// runs during parsing can complete the handshake *before* that load event fires, so the port existing
// is not by itself evidence of a navigation — the flag is.
let awaitingInitialLoad=false;
frame.addEventListener("load",()=>{
 if(awaitingInitialLoad){awaitingInitialLoad=false;return;}
 if(!modulePort)return;
 endSession("MODULE_NAVIGATED","The learning activity left its packaged document.");
});
const envelope=(type:string,payload:Record<string,unknown>)=>({protocol:"lorb-player",version:"1.0",type,message_id:crypto.randomUUID(),correlation_id:descriptor?.correlation_id??crypto.randomUUID(),reply_to:null,sent_at:new Date().toISOString(),payload});
function shellContextPayload(d:Descriptor){return {repository_id:d.repository_id,object_id:d.object_id,object_version_id:d.object_version_id,package_version_id:d.package_version_id,attempt_id:d.attempt_id,correlation_id:d.correlation_id,pseudonym:d.sub,content_url:`${d.iss.replace(/\/$/,"")}/api/v1/runtime/learning-objects/${d.object_id}/content?object_version_id=${encodeURIComponent(d.object_version_id)}`}}
async function request(url:string,method:string,body?:unknown){const response=await fetch(url,{method,headers:{authorization:`Bearer ${token()}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`Runtime request failed (${response.status})`);return response.json()}
function token(){return decodeURIComponent(location.hash.match(/(?:^#|&)descriptor=([^&]+)/)?.[1]??"")}
// Set only for an lti-tool launch (see signLtiLoginHint in runtime-api/core.ts) — never the launch
// descriptor itself. The descriptor is a live bearer credential the shell uses for state/evidence
// calls; handing it to a third-party tool via a URL parameter would leak a working credential through
// the tool's Referer header, its own logs, and browser history. This token carries nothing but who is
// launching, which object, and which attempt, and is single-purpose and short-lived.
function ltiLoginHint(){return decodeURIComponent(location.hash.match(/(?:^#|&)lti_login_hint=([^&]+)/)?.[1]??"")}
interface LtiToolContent{title:string;description?:string;tool_name:string;oidc_login_url:string;target_link_uri:string;client_id:string;deployment_id:string}
/**
 * An lti-tool launch never creates the sandboxed module iframe every other kind uses — the module
 * protocol requires `allow-forms` for form-post navigation, which the shell cannot grant a nested
 * iframe without also granting it to arbitrary packaged module content. Instead the shell itself
 * renders a minimal launch panel and, on click, navigates its own document through the LTI 1.3
 * OIDC third-party-initiated login flow to the tool's origin — the consuming app's own iframe around
 * the whole shell is what needs `allow-forms` widened for this one content kind, never the module
 * sandbox.
 */
async function startLtiLaunch(d:Descriptor){
 frame.remove();
 const panel=document.querySelector<HTMLElement>("#lti-panel")!;
 const titleEl=document.querySelector<HTMLElement>("#lti-title")!;
 const descriptionEl=document.querySelector<HTMLElement>("#lti-description")!;
 const launchBtn=document.querySelector<HTMLButtonElement>("#lti-launch")!;
 const completeBtn=document.querySelector<HTMLButtonElement>("#lti-complete")!;
 try{
  const contentUrl=`${d.iss.replace(/\/$/,"")}/api/v1/runtime/learning-objects/${d.object_id}/content?object_version_id=${encodeURIComponent(d.object_version_id)}`;
  const response=await fetch(contentUrl);
  if(!response.ok)throw new Error(`Could not load tool details (${response.status})`);
  const content=await response.json() as LtiToolContent;
  titleEl.textContent=content.tool_name;
  descriptionEl.textContent=content.description??"";
  panel.hidden=false;
  status.textContent="Ready to launch";
  const hint=ltiLoginHint();
  launchBtn.addEventListener("click",()=>{
   if(!hint){status.textContent="This activity could not be opened.";return}
   const params=new URLSearchParams({iss:d.iss,login_hint:hint,target_link_uri:content.target_link_uri,client_id:content.client_id,lti_deployment_id:content.deployment_id,lti_message_hint:d.object_id});
   location.href=`${content.oidc_login_url}${content.oidc_login_url.includes("?")?"&":"?"}${params.toString()}`;
  });
  completeBtn.addEventListener("click",async()=>{
   completeBtn.disabled=true;
   try{await request(d.state_endpoint.replace(/\/state$/,"/complete"),"POST");emit("experience.complete",{});status.textContent="Marked as complete"}
   catch{completeBtn.disabled=false;status.textContent="Could not mark as complete"}
  });
 }catch(error){status.textContent="This activity could not be opened.";emit("experience.error",{code:"LAUNCH_INVALID",recoverable:false,detail:error instanceof Error?error.message:"Unknown error"})}
}
interface ExternalEmbedContent{title:string;description?:string;embed_url:string}
/**
 * An external-embed launch, like lti-tool, never speaks the module postMessage protocol — the
 * embedded page is somebody else's, unmodified, and cannot be expected to send `module.hello`. Unlike
 * an lti-tool launch there is no signed handshake to drive first: the page loads straight into the
 * existing module iframe, just with its sandbox widened to allow-same-origin/allow-forms, since
 * arbitrary external content generally needs cookies and same-origin storage to function at all —
 * the same reasoning startLtiLaunch's widening documents. No HANDSHAKE_FRAGMENT_KEY is appended, so
 * the existing module.hello origin/nonce check above still refuses anything the embedded page tries
 * to send as if it were a real module.
 */
async function startExternalEmbed(d:Descriptor){
 try{
  const contentUrl=`${d.iss.replace(/\/$/,"")}/api/v1/runtime/learning-objects/${d.object_id}/content?object_version_id=${encodeURIComponent(d.object_version_id)}`;
  const response=await fetch(contentUrl);
  if(!response.ok)throw new Error(`Could not load embed details (${response.status})`);
  const content=await response.json() as ExternalEmbedContent;
  frame.setAttribute("sandbox","allow-scripts allow-forms allow-same-origin");
  awaitingInitialLoad=true;
  frame.src=content.embed_url;
  status.textContent="Learning activity loaded";
  const completeBtn=document.querySelector<HTMLButtonElement>("#mark-complete")!;
  completeBtn.hidden=false;
  completeBtn.addEventListener("click",async()=>{
   completeBtn.disabled=true;
   try{await request(d.state_endpoint.replace(/\/state$/,"/complete"),"POST");emit("experience.complete",{});completeBtn.textContent="Completed"}
   catch{completeBtn.disabled=false}
  });
 }catch(error){status.textContent="This activity could not be opened.";emit("experience.error",{code:"LAUNCH_INVALID",recoverable:false,detail:error instanceof Error?error.message:"Unknown error"})}
}
async function start(){try{const signed=token();if(!signed)throw new Error("Launch descriptor is missing");const unverified=JSON.parse(atob(signed.split('.')[1]!.replace(/-/g,'+').replace(/_/g,'/'))) as Descriptor;const jwks=createRemoteJWKSet(new URL(`${unverified.iss.replace(/\/$/,'')}/api/v1/runtime/jwks`));descriptor=(await jwtVerify(signed,jwks,{issuer:unverified.iss,audience:"lorb-player",algorithms:["ES256"]})).payload as unknown as Descriptor;if(descriptor.content_profile==="lti-tool-v1"){await startLtiLaunch(descriptor);return}if(descriptor.content_profile==="external-embed-v1"){await startExternalEmbed(descriptor);return}awaitingInitialLoad=true;frame.src=`${descriptor.package_url}${descriptor.package_url.includes("#")?"&":"#"}${HANDSHAKE_FRAGMENT_KEY}=${handshakeNonce}`;status.textContent="Learning activity loaded"}catch(error){status.textContent="This activity could not be opened.";emit("experience.error",{code:"LAUNCH_INVALID",recoverable:false,detail:error instanceof Error?error.message:"Unknown error"})}}
// Module messages are handled strictly in order. Each handler is async (it makes a Runtime call), so
// firing them concurrently would let a completion overtake the `state.put` that legally moves the
// attempt CREATED -> STARTED, or reorder an evidence chain. Serialising costs nothing here and makes
// the sequence the module sent the sequence the Runtime sees.
let queue:Promise<void>=Promise.resolve();
const enqueue=(data:unknown)=>{queue=queue.then(()=>handleModuleMessage(data));};
async function handleModuleMessage(data:unknown){
 if(!descriptor)return;
 const parsed=postMessageSchema.safeParse(data);
 if(!parsed.success)return;
 const message=parsed.data;
 try{
  if(message.type==="state.put"){const result=await request(descriptor.state_endpoint,"PUT",{revision,state_payload:message.payload.state??{}}) as {revision:number};revision=result.revision}
  else if(message.type==="evidence.emit"){await request(descriptor.evidence_endpoint,"POST",message.payload.statement)}
  // The module asks; the shell — which holds the descriptor — calls the relay and answers on the
  // port. A failed turn is answered as a failed turn, never escalated to experience.error: losing
  // one reply must not read as the activity breaking.
  else if(message.type==="relay.request"){
   const relayUrl=`${descriptor.iss.replace(/\/$/,"")}/api/v1/relay/coach/messages`;
   let payload:Record<string,unknown>;
   try{const result=await request(relayUrl,"POST",message.payload) as {endpoint:string;reply:string};payload={endpoint:result.endpoint,reply:result.reply}}
   catch{payload={error:"RELAY_FAILED"}}
   modulePort?.postMessage({...envelope("relay.reply",payload),reply_to:message.message_id});
   return;
  }
  else if(message.type==="experience.complete"){await request(descriptor.state_endpoint.replace(/\/state$/,"/complete"),"POST");emit("experience.complete",{})}
  else if(message.type==="experience.exit"){emit("experience.exit",message.payload)}
  else if(message.type==="experience.error"){emit("experience.error",message.payload)}
 }catch(error){emit("experience.error",{code:"PLAYER_ROUTE_FAILED",recoverable:true,detail:error instanceof Error?error.message:"Unknown error"})}
}
// The window is used for exactly one message: the nonce-authenticated handshake that hands the shell
// a MessagePort. Everything else — state, evidence, completion — arrives on that port, which is a
// capability held by two endpoints and needs no origin check at all.
// A module may open its channel more than once, and refusing the second attempt used to strand it.
// A framework that mounts, tears down and remounts its root — React's StrictMode does exactly this,
// and so does any transient unmount — closes the first port and sends a fresh `module.hello`. While
// the shell ignored a hello whenever it already held a port, it went on replying down a channel whose
// other end was closed, and the module waited for a context that could never arrive: no error, no
// console output, an activity that simply never starts.
//
// Accepting the later hello is no weaker than accepting the first. Every check still applies, and the
// launch nonce is what authenticates it: only the document the shell itself navigated to ever saw the
// fragment, and a document that replaced it in the same browsing context has already ended the
// session through `handshakeClosed`. The previous port is closed rather than abandoned.
window.addEventListener("message",event=>{
 if(!descriptor||handshakeClosed)return;
 const parsed=postMessageSchema.safeParse(event.data);
 if(!parsed.success||parsed.data.type!=="module.hello")return;
 if(!handshakeAllowed(event.origin,new URL(descriptor.package_url).origin,event.source,frame.contentWindow,parsed.data.payload[HANDSHAKE_FRAGMENT_KEY],handshakeNonce))return;
 const port=event.ports[0];
 if(!port)return;
 modulePort?.close();
 modulePort=port;
 port.onmessage=(portEvent:MessageEvent)=>enqueue(portEvent.data);
 port.start();
 port.postMessage(envelope("shell.context",shellContextPayload(descriptor)));
});
void start();
