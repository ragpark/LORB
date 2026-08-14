import { SignJWT, type KeyLike } from "jose";
export const issueIesToken=(key:KeyLike,subject:string,audience="lorb-runtime",issuer="http://localhost:4000")=>new SignJWT({sub:subject}).setProtectedHeader({alg:"ES256",kid:"synthetic-ies-001",typ:"lorb-runtime+jwt"}).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("10m").sign(key);
