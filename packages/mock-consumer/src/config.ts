import {z} from 'zod';
const environmentSchema=z.enum(['LOCAL-DEV','RAILWAY-NON-PROD']);
export type Environment=z.infer<typeof environmentSchema>;
export interface Config {runtimeApiBase:string;adminApiBase:string;runtimeIssuer:string;jwksUrl:string;playerShellOrigin:string;stubLoginUrl:string;stubIssuer:string;environment:Environment;allowedShellOrigins:ReadonlySet<string>}
export function readConfig(env:ImportMetaEnv=import.meta.env):Config{
 const environment=environmentSchema.parse(env.VITE_ENVIRONMENT_LABEL??'LOCAL-DEV');
 const runtimeApiBase=env.VITE_RUNTIME_API_BASE?.trim()||'http://localhost:3000/api/v1/runtime';
 const runtimeIssuer=env.VITE_RUNTIME_ISSUER?.trim()||new URL(runtimeApiBase).origin;
 // Roster administration lives under a different path prefix from the learner-facing runtime routes.
 const adminApiBase=env.VITE_ADMIN_API_BASE?.trim()||`${new URL(runtimeApiBase).origin}/api/v1/admin`;
 const playerShellOrigin=env.VITE_PLAYER_SHELL_ORIGIN??'http://localhost:3200';
 const origins=(env.VITE_ALLOWED_SHELL_ORIGINS??playerShellOrigin).split(',').map(x=>x.trim()).filter(Boolean);
 if(!origins.length||origins.includes('*'))throw new Error('Shell origins must be an explicit allow-list.');
 return {runtimeApiBase,adminApiBase,runtimeIssuer,jwksUrl:env.VITE_JWKS_URL??'http://localhost:3000/api/v1/runtime/jwks',playerShellOrigin,stubLoginUrl:env.VITE_STUB_IES_LOGIN_URL??'http://localhost:4000/dev-login',stubIssuer:env.VITE_STUB_IES_ISSUER??'http://localhost:4000',environment,allowedShellOrigins:new Set(origins)};
}
