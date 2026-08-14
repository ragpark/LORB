import Fastify from "fastify";
import cors from "@fastify/cors";
import { exportJWK, generateKeyPair } from "jose";
import { issueIesToken } from "./issuer.js";

const issuer=(process.env.IES_PUBLIC_ISSUER??"http://localhost:4000").replace(/\/$/,"");
const {privateKey,publicKey}=await generateKeyPair("ES256",{extractable:true});
const publicJwk={...(await exportJWK(publicKey)),kid:"synthetic-ies-001",alg:"ES256",use:"sig"};
const app=Fastify({logger:true});
await app.register(cors,{origin:true,methods:["GET","POST"]});
app.get("/health",async()=>({status:"ok"}));
app.get("/.well-known/jwks.json",async()=>({keys:[publicJwk]}));
app.post("/dev-login",async(req:any,reply)=>{const subject=req.body?.subject;if(typeof subject!=="string"||!/^synthetic-[a-z0-9-]+$/.test(subject))return reply.code(400).send({code:"SYNTHETIC_IDENTITY_REQUIRED"});const role=req.body?.role??req.query?.role;if(role!==undefined&&role!=="admin")return reply.code(400).send({code:"UNSUPPORTED_ROLE"});const platformAdmin=req.body?.platform_admin===true||req.query?.platform_admin==="true";const claims=role==="admin"?{role:"admin",...(platformAdmin?{platform_admin:true}:{})}:{};return {access_token:await issueIesToken(privateKey,subject,"lorb-runtime",issuer,claims),token_type:"Bearer",expires_in:600}});
await app.listen({host:"0.0.0.0",port:Number(process.env.PORT??4000)});
