// STUB — NOT PRODUCTION — BLOCKED BY BLK-08.
import { SignJWT, type KeyLike } from "jose";
export const issueIesToken=(key:KeyLike,subject:string,audience="lorb-runtime")=>new SignJWT({sub:subject}).setProtectedHeader({alg:"ES256"}).setIssuer("http://localhost:4000").setAudience(audience).setIssuedAt().setExpirationTime("10m").sign(key);
