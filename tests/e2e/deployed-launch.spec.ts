import {randomUUID} from "node:crypto";
import {decodeJwt,generateKeyPair,jwtVerify} from "jose";
import {expect,it} from "vitest";
import {buildRuntime} from "../../packages/runtime-api/src/app.js";
import {issueIesToken} from "../../packages/stub-ies/src/issuer.js";
import {store} from "../../packages/runtime-api/src/core.js";

it("runs the deployed-equivalent IES to player completion flow with public origins",async()=>{
 store.attempts.clear();store.launches.clear();store.idempotency.clear();
 const ies=await generateKeyPair("ES256");
 const urls={ies:"https://ies.example.test",runtime:"https://runtime.example.test",player:"https://player.example.test",evidence:"https://evidence.example.test/api/v1/evidence/statements",package:"https://packages.example.test/activity/index.html"};
 const runtime=await buildRuntime({iesKey:ies.publicKey,iesIssuer:urls.ies,publicIssuer:urls.runtime,playerOrigin:urls.player,evidenceEndpoint:urls.evidence,packageUrl:urls.package,secret:Buffer.alloc(32,9)});
 const accessToken=await issueIesToken(ies.privateKey,"synthetic-deployed-learner","lorb-runtime",urls.ies);
 const launch=await runtime.app.inject({method:"POST",url:"/api/v1/runtime/launches",headers:{authorization:`Bearer ${accessToken}`,"idempotency-key":randomUUID()},payload:{contract_version:"1.0",consumer_id:"deployed-consumer",repository_id:randomUUID(),object_id:randomUUID(),requested_launch_mode:"embedded-iframe",locale:"en-GB"}});
 expect(launch.statusCode).toBe(201);
 const response=launch.json();
 expect(response.player_url).toMatch(/^https:\/\/player\.example\.test\/#descriptor=/);
 const verified=await jwtVerify(response.signed_descriptor,runtime.keys.privateKey,{issuer:urls.runtime,audience:"lorb-player",algorithms:["ES256"]});
 const descriptor=decodeJwt(response.signed_descriptor);
 expect(descriptor).toMatchObject({iss:urls.runtime,evidence_endpoint:urls.evidence,package_url:urls.package});
 expect(descriptor.state_endpoint).toBe(`${urls.runtime}/api/v1/runtime/attempts/${response.attempt_id}/state`);
 const state=await runtime.app.inject({method:"PUT",url:`/api/v1/runtime/attempts/${response.attempt_id}/state`,headers:{authorization:`Bearer ${response.signed_descriptor}`,"idempotency-key":randomUUID()},payload:{revision:1,state_payload:{page:2}}});
 expect(state.statusCode).toBe(200);
 const complete=await runtime.app.inject({method:"POST",url:`/api/v1/runtime/attempts/${response.attempt_id}/complete`,headers:{authorization:`Bearer ${response.signed_descriptor}`,"idempotency-key":randomUUID()}});
 expect(complete.statusCode).toBe(200);expect(verified.payload.iss).toBe(urls.runtime);expect(store.attempts.get(response.attempt_id)?.status).toBe("COMPLETED");
 await runtime.app.close();
});
